#!/usr/bin/env python3
"""
fake_pedal — a software stand-in for the pedal so you can develop or demo the
Studio editor and the bridge with no hardware attached.

It opens a pseudo-terminal, prints the device path, and speaks docs/PROTOCOL.md:
ping / status / monitor / list / load / next / prev / get / put / apply / rm /
bypass / vol / looper / note / switches / switch / loops / loop / tone / help,
with the real counted-byte framing (loop files up to 8 MB) and the 2.2.2
diagnostics extensions (patch rev, test tone, MIDI counters).

    python3 fake_pedal.py            # prints e.g. /dev/pts/3 (Linux) or /dev/ttys004 (macOS)
    python3 looper_bridge.py --port /dev/pts/3

Presets are seeded from ../sdcard/presets and kept in memory. Loops live in an
in-memory store; `loop save` writes a 2 s sine so the round trip can be exercised
without a real looper.
"""
import glob
import json
import math
import os
import re
import select
import struct
import sys
import time
import tty

FW = "2.2.2"
MAX_BYTES = 16384
TONE_MS_MIN, TONE_MS_MAX, TONE_MS_DEFAULT = 100, 5000, 1000
MAX_LOOP_BYTES = 8 * 1024 * 1024
LOOP_SECONDS_MAX = 95.0
LOOP_RATE = 44100
SWITCH_ACTIONS = ["none", "loop", "stop", "undo", "clear", "next", "prev",
                  "reload", "bypass", "source", "note"]
DEFAULT_SWITCHES = [("loop", "none"), ("stop", "clear"), ("undo", "none"),
                    ("next", "reload"), ("prev", "none"), ("bypass", "none")]


def make_sine_wav(seconds=2.0, freq=220.0, rate=LOOP_RATE, amp=0.5):
    """A 16-bit mono PCM WAV of a decaying sine — stands in for the looper's audio."""
    n = int(seconds * rate)
    frames = bytearray()
    for i in range(n):
        env = 1.0 - 0.6 * (i / n)
        frames += struct.pack("<h", int(32767 * amp * env * math.sin(2 * math.pi * freq * i / rate)))
    header = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(frames), b"WAVE",
                         b"fmt ", 16, 1, 1, rate, rate * 2, 2, 16, b"data", len(frames))
    return bytes(header + frames)


def patch_fp(data):
    """Exact running-patch identity, like the firmware: 32-bit FNV-1a over the
    raw bytes plus their length ("hhhhhhhh-len"). Empty string = no patch."""
    if not data:
        return ""
    h = 2166136261
    for b in data:
        h = ((h ^ b) * 16777619) & 0xFFFFFFFF
    return "%08x-%d" % (h, len(data))


def wav_seconds(data):
    """Duration of a PCM WAV (walks the chunk list; falls back to 16-bit mono 44.1k)."""
    try:
        if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
            raise ValueError("not a WAV")
        pos, rate, channels, bits = 12, LOOP_RATE, 1, 16
        while pos + 8 <= len(data):
            cid, size = data[pos:pos + 4], struct.unpack("<I", data[pos + 4:pos + 8])[0]
            if cid == b"fmt ":
                _, channels, rate, _, _, bits = struct.unpack("<HHIIHH", data[pos + 8:pos + 24])
            elif cid == b"data":
                return size / float(rate * channels * max(1, bits // 8))
            pos += 8 + size + (size & 1)
        raise ValueError("no data chunk")
    except (ValueError, struct.error):
        return max(0, len(data) - 44) / (2.0 * LOOP_RATE)


class FakePedal:
    def __init__(self, preset_dir):
        self.presets = {}
        for p in sorted(glob.glob(os.path.join(preset_dir, "*.txt"))):
            with open(p, "rb") as f:
                self.presets[os.path.basename(p)] = f.read()
        self.index = 0 if self.presets else -1
        self.bypass = False
        self.volume = 0.7
        self.monitor = False
        self.loop_state = "empty"
        self.loop_len = 0.0
        self.loop_t0 = time.time()
        self.can_undo = False
        self.title = ""
        self.buf = bytearray()        # bytearray: appends stay linear for 8 MB loop uploads
        self.pending = None           # ("put"|"apply"|"loopput", name, n) while receiving bytes
        self.last_rx = time.time()    # idle timer for a pending transfer (5 s put/apply, 10 s loop put)
        self.switches = [{"tap": t, "hold": h, "note": 0} for t, h in DEFAULT_SWITCHES]
        self.loops = {}               # name -> WAV bytes (the /loops folder of the SD card)
        self.last_status = 0.0
        self.peak = 0.0
        # diagnostics (firmware 2.2.2): patch revision, test tone, MIDI evidence
        self.rev = 1 if self.presets else 0   # the boot-time preset load counts
        self.applied = None                   # live-applied patch text (index -1)
        # fp is a SNAPSHOT of the bytes that were loaded/applied — a later `put`
        # under the same name must not change it (the file changed, not the
        # running patch); only load/apply do.
        self.fp = patch_fp(self.presets.get(self.name(), b"")) if self.presets else ""
        self.tone_until = 0.0                 # time.time() deadline, 0 = off
        self.midi_rx = 0                      # note on/off received
        self.midi_trig = 0                    # voices actually triggered

    # ----------------------------------------------------------- helpers
    def names(self):
        return sorted(self.presets.keys(), key=str.lower)

    def name(self):
        n = self.names()
        return n[self.index] if 0 <= self.index < len(n) else ""

    def title_of(self, name):
        m = re.search(rb"//\s*name:\s*(.*)", self.presets.get(name, b""))
        return m.group(1).decode(errors="replace").strip() if m else ""

    def tone_active(self):
        return self.tone_until > time.time()

    def voices(self):
        """MIDI-bound voices in the running patch — obj.midi(...) calls."""
        text = self.applied if self.applied is not None else self.presets.get(self.name(), b"")
        return len(re.findall(rb"\.midi\s*\(", text))

    def status_json(self):
        pos = 0.0
        if self.loop_state in ("playing", "overdubbing") and self.loop_len > 0:
            pos = (time.time() - self.loop_t0) % self.loop_len
        self.peak = 0.15 + 0.6 * abs(((time.time() * 1.7) % 2.0) - 1.0)
        return json.dumps({
            "cpu": round(6.0 + 3.0 * self.peak, 1), "cpu_max": 19.8, "mem": 14, "mem_max": 22,
            "peak_in": round(self.peak, 3), "peak_out": round(self.peak * 0.9, 3),
            "loop": {"state": self.loop_state, "len_s": round(self.loop_len, 2),
                     "pos_s": round(pos, 2), "can_undo": self.can_undo, "seconds_max": 95.0},
            "preset": {"index": self.index, "count": len(self.presets),
                       "name": self.name(), "title": self.title_of(self.name())},
            "bypass": self.bypass, "volume": round(self.volume, 2), "source": "line",
            "psram_mb": 16, "sd": True, "flash": True,
            "rev": self.rev, "fp": self.fp, "tone": self.tone_active(),
            "midi": {"rx": self.midi_rx, "trig": self.midi_trig, "voices": self.voices()},
        }, separators=(",", ":"))

    # ------------------------------------------------------------ looper
    def looper(self, cmd):
        s = self.loop_state
        if cmd == "tap":
            if s == "empty":
                self.loop_state, self.loop_t0 = "recording", time.time()
            elif s == "recording":
                self.loop_len = max(0.1, time.time() - self.loop_t0)
                self.loop_state, self.loop_t0 = "playing", time.time()
            elif s == "playing":
                self.loop_state = "overdubbing"
            elif s == "overdubbing":
                self.loop_state, self.can_undo = "playing", True
            elif s == "stopped":
                self.loop_state, self.loop_t0 = "playing", time.time()
        elif cmd == "stop":
            if s == "recording":
                self.loop_len = max(0.1, time.time() - self.loop_t0)
                self.loop_state = "stopped"
            elif s in ("playing", "overdubbing"):
                self.loop_state = "stopped"
            elif s == "stopped" and self.loop_len:
                self.loop_state, self.loop_t0 = "playing", time.time()
        elif cmd == "undo":
            pass
        elif cmd == "clear":
            self.loop_state, self.loop_len, self.can_undo = "empty", 0.0, False

    # ---------------------------------------------------------- protocol
    @staticmethod
    def bad_name(name):
        """The firmware rejects names longer than 64 characters or containing quotes."""
        return len(name) > 64 or '"' in name or "'" in name

    def feed(self, data, out):
        self.buf += data
        self.last_rx = time.time()
        while True:
            if self.pending:
                kind, name, n = self.pending
                if len(self.buf) < n:
                    return
                payload = bytes(self.buf[:n])
                del self.buf[:n]
                self.pending = None
                if kind == "put":
                    self.presets[name] = payload
                    out(b"#OK put\n")
                elif kind == "loopput":
                    self.loops[name] = payload
                    out(b"#OK loop put\n")
                else:
                    self.index = -1
                    self.applied = payload
                    self.rev += 1
                    self.fp = patch_fp(payload)
                    out(f"#OK apply rev={self.rev} fp={self.fp}\n".encode())
                continue
            nl = self.buf.find(b"\n")
            if nl < 0:
                return
            line = bytes(self.buf[:nl]).strip(b"\r")
            del self.buf[:nl + 1]
            self.handle(line.decode(errors="replace").strip(), out)

    def handle(self, line, out):
        if not line:
            return
        argv = line.split()
        cmd = argv[0]
        say = lambda s: out((s + "\n").encode())
        if cmd == "ping":
            say(f'#PONG {{"fw":"{FW}","proto":1,"psram_mb":16,"sd":true,"flash":true}}')
        elif cmd == "status":
            say("#STATUS " + self.status_json())
        elif cmd == "monitor":
            self.monitor = len(argv) > 1 and argv[1] == "on"
            say("#OK monitor")
        elif cmd == "list":
            say("#PRESETS " + json.dumps({"current": self.index, "presets": self.names()},
                                          separators=(",", ":")))
        elif cmd == "load" and len(argv) > 1:
            names = self.names()
            if argv[1].isdigit() and int(argv[1]) < len(names):
                self.index = int(argv[1])
            elif argv[1] in self.presets:
                self.index = names.index(argv[1])
            else:
                say("#ERR no such preset")
                return
            self.applied = None
            self.rev += 1
            self.fp = patch_fp(self.presets[self.name()])
            say(f"#OK load {self.name()} rev={self.rev} fp={self.fp}")
        elif cmd in ("next", "prev"):
            n = len(self.presets)
            if not n:
                say("#ERR no presets")
                return
            self.index = (self.index + (1 if cmd == "next" else -1)) % n
            self.applied = None
            self.rev += 1
            self.fp = patch_fp(self.presets[self.name()])
            say(f"#OK load {self.name()} rev={self.rev} fp={self.fp}")
        elif cmd == "get" and len(argv) > 1:
            data = self.presets.get(argv[1])
            if data is None:
                say("#ERR not found")
                return
            out(f"#FILE {argv[1]} {len(data)}\n".encode() + data + b"\n#END\n")
        elif cmd in ("put", "apply"):
            try:
                n = int(argv[2] if cmd == "put" else argv[1])
            except (IndexError, ValueError):
                say("#ERR missing arguments")
                return
            if cmd == "put" and self.bad_name(argv[1]):
                say("#ERR bad name")
                return
            if n <= 0 or n > MAX_BYTES:
                say("#ERR bad length")
                return
            self.pending = ("put", argv[1], n) if cmd == "put" else ("apply", None, n)
            say("#SEND")
        elif cmd == "rm" and len(argv) > 1:
            if self.presets.pop(argv[1], None) is None:
                say("#ERR not found")
            else:
                say("#OK rm")
        elif cmd == "bypass":
            a = argv[1] if len(argv) > 1 else "toggle"
            self.bypass = True if a == "on" else False if a == "off" else not self.bypass
            say(f"#OK bypass {'on' if self.bypass else 'off'}")
        elif cmd == "vol" and len(argv) > 1:
            self.volume = min(1.0, max(0.0, float(argv[1])))
            say(f"#OK vol {self.volume:.2f}")
        elif cmd == "looper" and len(argv) > 1:
            self.looper(argv[1])
            say("#OK looper")
        elif cmd == "note":
            # note on <num> <vel> [ch] / note off <num> [ch] — drives the MIDI voice allocator
            ok = len(argv) >= 3 and argv[1] in ("on", "off") and argv[2].isdigit() and (
                argv[1] == "off" or (len(argv) >= 4 and argv[3].isdigit()))
            if ok:
                self.midi_rx += 1
                # a voice fires only when the running patch has one bound (like triggerUnit)
                if argv[1] == "on" and int(argv[3]) > 0 and self.voices():
                    self.midi_trig += 1
            say("#OK note" if ok else "#ERR usage: note on <num> <vel> [ch] | note off <num> [ch]")
        elif cmd == "tone":
            # tone [ms] [freq] [level] | tone off — quiet self-stopping test tone
            a = argv[1] if len(argv) > 1 else ""
            if a in ("off", "stop"):
                self.tone_until = 0.0
                say("#OK tone off")
                return
            try:
                ms = int(a) if a else TONE_MS_DEFAULT
            except ValueError:
                say("#ERR tone [ms] [freq] [level] | tone off")
                return
            if ms <= 0:
                say("#ERR tone [ms] [freq] [level] | tone off")
                return
            ms = min(TONE_MS_MAX, max(TONE_MS_MIN, ms))
            self.tone_until = time.time() + ms / 1000.0
            say(f"#OK tone {ms}")
        elif cmd == "switches":
            say("#SWITCHES " + json.dumps({"switches": self.switches, "actions": SWITCH_ACTIONS},
                                           separators=(",", ":")))
        elif cmd == "switch":
            try:
                n, tap, hold = int(argv[1]), argv[2], argv[3]
                note = int(argv[4]) if len(argv) > 4 else 0
            except (IndexError, ValueError):
                say("#ERR usage: switch <n> <tap> <hold> [note]")
                return
            if not 1 <= n <= 6:
                say("#ERR switch must be 1-6")
            elif tap not in SWITCH_ACTIONS or hold not in SWITCH_ACTIONS:
                say("#ERR unknown action")
            elif not 0 <= note <= 127:
                say("#ERR note must be 0-127")
            else:
                self.switches[n - 1] = {"tap": tap, "hold": hold, "note": note}
                say("#OK switch")
        elif cmd == "loops":
            say("#LOOPS " + json.dumps({"sd": True, "loops": sorted(self.loops, key=str.lower),
                                        "seconds_max": LOOP_SECONDS_MAX}, separators=(",", ":")))
        elif cmd == "loop" and len(argv) > 1:
            self.loop_cmd(argv[1:], out, say)
        elif cmd == "help":
            say("fake pedal: ping status monitor list load next prev get put apply rm bypass vol "
                "looper note switches switch loops loop tone")
        else:
            say("#ERR unknown command")

    def loop_cmd(self, argv, out, say):
        sub = argv[0]
        name = argv[1] if len(argv) > 1 else None
        if name and self.bad_name(name):
            say("#ERR bad name")
            return
        if sub == "save" and name:
            if self.loop_state in ("recording", "overdubbing"):
                say("#ERR looper busy")
                return
            data = make_sine_wav()
            self.loops[name] = data
            say(f"#OK loop save {name} {wav_seconds(data):.2f}")
        elif sub == "load" and name:
            data = self.loops.get(name)
            if data is None:
                say("#ERR not found")
                return
            secs = wav_seconds(data)
            if secs > LOOP_SECONDS_MAX:
                say("#ERR loop too long")
                return
            self.loop_len, self.loop_state, self.can_undo = secs, "stopped", False
            say(f"#OK loop load {name} {secs:.2f}")
        elif sub == "rm" and name:
            say("#OK loop rm" if self.loops.pop(name, None) is not None else "#ERR not found")
        elif sub == "get" and name:
            data = self.loops.get(name)
            if data is None:
                say("#ERR not found")
                return
            out(f"#FILE {name} {len(data)}\n".encode() + data + b"\n#END\n")
        elif sub == "put" and name:
            try:
                n = int(argv[2])
            except (IndexError, ValueError):
                say("#ERR missing arguments")
                return
            if n <= 0 or n > MAX_LOOP_BYTES:
                say("#ERR bad length")
                return
            self.pending = ("loopput", name, n)
            say("#SEND")
        else:
            say("#ERR usage: loop save|load|rm|get <name> | loop put <name> <len>")

    def tick(self, out):
        if self.pending:
            # Like the firmware: give up on a transfer that goes quiet, keep the old file.
            limit = 10.0 if self.pending[0] == "loopput" else 5.0
            if time.time() - self.last_rx > limit:
                self.pending = None
                self.buf = bytearray()          # the partial payload is discarded
                out(b"#ERR timeout\n")
        if self.monitor and time.time() - self.last_status >= 0.25:
            self.last_status = time.time()
            out(("#STATUS " + self.status_json() + "\n").encode())
        st = self.loop_state
        if st != getattr(self, "_last_evt", None):
            self._last_evt = st
            out(f'#EVT {{"loop":"{st}"}}\n'.encode())
        tone = self.tone_active()
        if tone != getattr(self, "_last_tone", False):
            self._last_tone = tone
            out(f'#EVT {{"tone":{"true" if tone else "false"}}}\n'.encode())


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    preset_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "..", "sdcard", "presets")
    master, slave = os.openpty()
    tty.setraw(slave)          # raw: no echo, no line buffering, before anyone opens it
    tty.setraw(master)
    path = os.ttyname(slave)
    print(f"fake pedal listening on {path}", flush=True)
    print(f"   python3 looper_bridge.py --port {path}", flush=True)
    pedal = FakePedal(preset_dir)

    def out(b):
        mv = memoryview(b)            # a pty may take a multi-MB loop file in several writes
        while mv:
            mv = mv[os.write(master, mv):]

    while True:
        r, _, _ = select.select([master], [], [], 0.05)
        if r:
            try:
                data = os.read(master, 4096)
            except OSError:
                data = b""
            if data:
                pedal.feed(data, out)
        pedal.tick(out)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
