#!/usr/bin/env python3
"""
LoopSmith bridge — runs on the companion Raspberry Pi (or any Linux/macOS box).

    USB serial (the pedal)  <->  WebSocket /ws  (the Studio editor in any browser)

It is byte-transparent: the editor's protocol state machine (docs/PROTOCOL.md,
including the counted-byte #FILE / #SEND framing) runs unchanged — this program
only moves bytes and serves the editor, so http://loopsmith.local/ is the whole UI.

    python3 looper_bridge.py [--port /dev/teensy-looper] [--http 0.0.0.0:8080]
                             [--editor ../editor] [--www ./www] [--storage /media/usb]

Standard library only — no aiohttp, no pyserial — so it runs on a stock
Raspberry Pi OS Lite image with nothing installed (the bootable-image kit in
pi/image/ relies on that). The serial port is a raw termios file descriptor and
the WebSocket server is a small RFC 6455 implementation below.

Control messages from the bridge to the browser are WebSocket TEXT frames of
JSON ({"bridge": ...}); pedal bytes are BINARY frames. Any number of browsers
may be connected at once (the HDMI kiosk, a phone, a laptop): everything the
pedal says is broadcast to all of them, and their commands are serialised so a
counted-byte transfer (get/put/apply/loop get/loop put) started by one browser
runs to completion before anyone else's line reaches the pedal.

Besides the editor it serves, when present:
    /setup                 network + storage page (join the home Wi-Fi from a phone)
    /api/network[...]      NetworkManager status / scan / connect (Pi image)
    /api/storage           the USB drive, /library/ lists + serves its recordings
    /manifest.webmanifest  PWA bits so phones can "Add to Home Screen"
    /midi                  WebSocket: raw MIDI bytes to/from the pedal's USB MIDI port (many clients)
    /midi-files/, /api/midi/play|stop|status   MIDI files on the USB drive, played into the pedal
    /api/system/reboot|poweroff, /api/update/status|check|apply   power and self-update
    /api/admin/…           password, hotspot, ssh and bluetooth changes (done by a root helper)
    /login, /api/login     a session login for browsers that are not the pedal's own screen
    /claim, /api/claim     first-run: choose the login (no password ships with the image)
"""
import argparse
import asyncio
import base64
import glob
import hashlib
import hmac
import json
import os
import shutil
import struct
import subprocess
import sys
import termios
import time
import urllib.parse
import uuid

WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_WS_MSG = 4 * 1024 * 1024          # a full 8 MB loop is sent in 4 KB chunks; 4 MB is ample
MAX_HTTP_BODY = 8 * 1024 * 1024
HEARTBEAT_S = 20

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json",
    ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
    ".ico": "image/x-icon", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".txt": "text/plain; charset=utf-8",
}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def find_pedal(explicit=None):
    """First existing candidate: explicit path, udev symlink, by-id, then any ACM port."""
    cands = []
    if explicit:
        cands.append(explicit)
    cands.append("/dev/teensy-looper")
    cands += sorted(glob.glob("/dev/serial/by-id/*Teensy*"))
    cands += sorted(glob.glob("/dev/ttyACM*"))
    cands += sorted(glob.glob("/dev/cu.usbmodem*"))      # macOS, for development
    for c in cands:
        if os.path.exists(c):
            return c
    return None


# ------------------------------------------------------------------ serial port
class SerialPort:
    """A raw, non-blocking tty. USB CDC ignores the baud rate; it is set for real UARTs."""

    def __init__(self, path, baud=115200):
        self.fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            iflag, oflag, cflag, lflag, ispeed, ospeed, cc = termios.tcgetattr(self.fd)
            iflag &= ~(termios.IGNBRK | termios.BRKINT | termios.PARMRK | termios.ISTRIP |
                       termios.INLCR | termios.IGNCR | termios.ICRNL | termios.IXON |
                       termios.IXOFF | termios.IXANY)
            oflag &= ~termios.OPOST
            lflag &= ~(termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG | termios.IEXTEN)
            cflag &= ~(termios.CSIZE | termios.PARENB | termios.CSTOPB)
            cflag |= termios.CS8 | termios.CREAD | termios.CLOCAL
            if hasattr(termios, "CRTSCTS"):
                cflag &= ~termios.CRTSCTS
            cc = list(cc)
            cc[termios.VMIN] = 0
            cc[termios.VTIME] = 0
            speed = getattr(termios, "B%d" % baud, termios.B115200)
            termios.tcsetattr(self.fd, termios.TCSANOW, [iflag, oflag, cflag, lflag, speed, speed, cc])
        except termios.error as e:          # not a tty (a FIFO/pipe in tests): leave it alone
            log(f"termios setup skipped for {path}: {e}")

    def read(self):
        return os.read(self.fd, 65536)      # BlockingIOError when nothing is pending

    def write(self, data):
        return os.write(self.fd, data)

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass


# ------------------------------------------------------------------- websocket
class WebSocket:
    """Server side of RFC 6455 over asyncio streams. Messages are (opcode, bytes)."""

    def __init__(self, reader, writer):
        self.r = reader
        self.w = writer
        self.closed = False
        self.last_pong = time.time()
        self._send_lock = asyncio.Lock()

    async def recv(self):
        """Next data message as (opcode, payload); None once the socket is closed."""
        frags = []
        frag_op = None
        while True:
            try:
                head = await self.r.readexactly(2)
            except (asyncio.IncompleteReadError, ConnectionError, OSError):
                self.closed = True
                return None
            fin = head[0] & 0x80
            op = head[0] & 0x0F
            masked = head[1] & 0x80
            ln = head[1] & 0x7F
            try:
                if ln == 126:
                    ln = struct.unpack("!H", await self.r.readexactly(2))[0]
                elif ln == 127:
                    ln = struct.unpack("!Q", await self.r.readexactly(8))[0]
                if ln > MAX_WS_MSG:
                    await self.close(1009)
                    return None
                mask = await self.r.readexactly(4) if masked else None
                data = await self.r.readexactly(ln) if ln else b""
            except (asyncio.IncompleteReadError, ConnectionError, OSError):
                self.closed = True
                return None
            if mask and ln:
                reps = ln // 4 + 1
                key = int.from_bytes(mask * reps, "big") >> (8 * (4 * reps - ln))
                data = (int.from_bytes(data, "big") ^ key).to_bytes(ln, "big")
            if op == 0x8:                              # close
                if not self.closed:
                    try:
                        await self._send_frame(0x8, data[:2])
                    except Exception:
                        pass
                self.closed = True
                return None
            if op == 0x9:                              # ping -> pong
                await self._send_frame(0xA, data)
                continue
            if op == 0xA:                              # pong
                self.last_pong = time.time()
                continue
            if op in (0x1, 0x2):
                if fin:
                    return op, data
                frag_op, frags = op, [data]
                continue
            if op == 0x0 and frag_op is not None:      # continuation
                frags.append(data)
                if sum(len(f) for f in frags) > MAX_WS_MSG:
                    await self.close(1009)
                    return None
                if fin:
                    out = b"".join(frags)
                    first_op = frag_op
                    frag_op, frags = None, []
                    return first_op, out
                continue
            await self.close(1002)                     # protocol error
            return None

    async def _send_frame(self, op, data):
        ln = len(data)
        if ln < 126:
            head = bytes([0x80 | op, ln])
        elif ln < 65536:
            head = bytes([0x80 | op, 126]) + struct.pack("!H", ln)
        else:
            head = bytes([0x80 | op, 127]) + struct.pack("!Q", ln)
        async with self._send_lock:
            self.w.write(head + data)
            await self.w.drain()

    async def send_bytes(self, data):
        await self._send_frame(0x2, data)

    async def send_str(self, text):
        await self._send_frame(0x1, text.encode("utf-8"))

    async def ping(self):
        await self._send_frame(0x9, b"hb")

    async def close(self, code=1000):
        if self.closed:
            return
        self.closed = True
        try:
            await self._send_frame(0x8, struct.pack("!H", code))
        except Exception:
            pass
        try:
            self.w.close()
        except Exception:
            pass


# ---------------------------------------------------------------- the bridge
class Bridge:
    def __init__(self, port_hint, baud=115200):
        self.port_hint = port_hint
        self.baud = baud
        self.ser = None
        self.port_name = None
        self._port_dead = None        # future resolved when the serial port dies
        self._txbuf = bytearray()     # unsent serial bytes (port would block)
        self._writer_on = False
        self.clients = {}             # ws -> outbound queue (pedal bytes are broadcast)
        self.started = time.monotonic()
        # command serialisation: one browser at a time may be mid-transfer with the pedal
        self.lock = asyncio.Lock()
        self._rx_line = bytearray()   # pedal output, reassembled into lines for transfer tracking
        self._rx_skip = 0             # raw bytes still to come inside a #FILE payload
        self._reply = None            # future: the pedal's terminating line for the active transfer
        self.rx_bytes = 0
        self.tx_bytes = 0
        self.connects = 0

    # ------------------------------------------------------------ serial side
    async def serial_manager(self):
        loop = asyncio.get_running_loop()
        while True:
            port = find_pedal(self.port_hint)
            if port is None:
                await asyncio.sleep(1.0)
                continue
            try:
                ser = SerialPort(port, self.baud)
            except OSError as e:
                log(f"open {port} failed: {e}")
                await asyncio.sleep(1.0)
                continue

            self.ser = ser
            self.port_name = port
            self.connects += 1
            self._txbuf = bytearray()
            self._port_dead = loop.create_future()
            loop.add_reader(ser.fd, self._on_readable)
            log(f"pedal connected on {port}")
            await self._control({"bridge": "pedal", "connected": True, "port": port})
            try:
                await self._port_dead
            finally:
                for fn in (loop.remove_reader, loop.remove_writer):
                    try:
                        fn(ser.fd)
                    except Exception:
                        pass
                self._writer_on = False
                ser.close()
                self.ser = None
                self.port_name = None
                log("pedal disconnected")
                await self._control({"bridge": "pedal", "connected": False})
            await asyncio.sleep(1.0)

    def _kill_port(self):
        if self._port_dead is not None and not self._port_dead.done():
            self._port_dead.set_result(None)

    def _on_readable(self):
        ser = self.ser
        if ser is None:
            return
        try:
            data = ser.read()
        except BlockingIOError:
            return
        except OSError:
            self._kill_port()
            return
        if not data:                  # readable with nothing to read = EOF (unplugged)
            self._kill_port()
            return
        self.rx_bytes += len(data)
        for q in list(self.clients.values()):
            q.put_nowait(data)
        self._track(data)

    # Follow the pedal's output well enough to know when a transfer has finished:
    # "#FILE <name> <len>\n" is followed by exactly <len> raw bytes and "\n#END\n";
    # "#SEND" means the pedal now wants the client's bytes; "#OK"/"#ERR" end a command.
    def _track(self, data):
        i = 0
        while i < len(data):
            if self._rx_skip:
                n = min(self._rx_skip, len(data) - i)
                self._rx_skip -= n
                i += n
                continue
            j = data.find(b"\n", i)
            if j < 0:
                self._rx_line += data[i:]
                if len(self._rx_line) > 4096:
                    del self._rx_line[:-1024]
                return
            self._rx_line += data[i:j]
            line = bytes(self._rx_line)
            self._rx_line = bytearray()
            i = j + 1
            if line.startswith(b"#FILE "):
                parts = line.split()
                try:
                    self._rx_skip = int(parts[2]) + len(b"\n#END\n")   # payload + trailer
                except (IndexError, ValueError):
                    pass
                self._settle(b"#FILE")
            elif line.startswith(b"#"):
                # every command is answered by exactly one #-line (#OK, #ERR, #PONG, #STATUS,
                # #PRESETS, #SWITCHES, #LOOPS, #SEND ...); that line closes the command
                self._settle(line[:5])

    def _settle(self, what):
        f = self._reply
        if f is not None and not f.done():
            f.set_result(what)

    def _on_writable(self):
        ser = self.ser
        if ser is None:
            return
        try:
            while self._txbuf:
                n = ser.write(bytes(self._txbuf[:4096]))
                del self._txbuf[:n]
                self.tx_bytes += n
        except BlockingIOError:
            return
        except OSError as e:
            log(f"serial write failed: {e}")
            self._kill_port()
            return
        if not self._txbuf and self._writer_on:
            asyncio.get_running_loop().remove_writer(ser.fd)
            self._writer_on = False

    def write_serial(self, data):
        ser = self.ser
        if ser is None:
            return False
        self._txbuf += data
        if not self._writer_on:
            self._on_writable()
            if self._txbuf and self.ser is not None and not self._writer_on:
                asyncio.get_running_loop().add_writer(ser.fd, self._on_writable)
                self._writer_on = True
        return True

    # --------------------------------------------------------- websocket side
    async def _control(self, obj):
        text = json.dumps(obj)
        for ws in list(self.clients):
            if not ws.closed:
                try:
                    await ws.send_str(text)
                except Exception:
                    pass

    async def _sender(self, ws, q):
        try:
            while True:
                data = await q.get()
                await ws.send_bytes(data)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            log(f"ws send failed: {e}")

    async def _heartbeat(self, ws):
        try:
            while not ws.closed:
                await asyncio.sleep(HEARTBEAT_S)
                if time.time() - ws.last_pong > 2 * HEARTBEAT_S + 5:
                    log("editor heartbeat lost")
                    await ws.close(1001)
                    return
                await ws.ping()
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    # Commands that open a counted-byte exchange, and how the exchange ends.
    #   get / loop get:  pedal answers #FILE <len> ... #END      (or #ERR)
    #   put / apply / loop put:  pedal says #SEND, the browser streams <len> bytes, pedal says #OK/#ERR
    @staticmethod
    def _transfer_kind(line):
        w = line.split()
        if not w:
            return None
        if w[0] == b"get" or (w[0] == b"loop" and len(w) > 1 and w[1] == b"get"):
            return "down"
        if w[0] in (b"put", b"apply"):
            return "up"
        if w[0] == b"loop" and len(w) > 1 and w[1] == b"put":
            return "up"
        return None

    async def _await_reply(self, timeout):
        loop = asyncio.get_running_loop()
        self._reply = loop.create_future()
        try:
            return await asyncio.wait_for(self._reply, timeout)
        except asyncio.TimeoutError:
            return None
        finally:
            self._reply = None

    async def ws_session(self, ws, peer):
        q = asyncio.Queue()
        self.clients[ws] = q
        sender = asyncio.ensure_future(self._sender(ws, q))
        beat = asyncio.ensure_future(self._heartbeat(ws))
        log(f"editor connected from {peer} ({len(self.clients)} connected)")
        try:
            await ws.send_str(json.dumps({
                "bridge": "hello", "pedal": self.ser is not None, "port": self.port_name,
                "clients": len(self.clients)}))
            pending = bytearray()          # a command line arriving in pieces
            upload_left = 0                # raw bytes this browser still owes the pedal
            while True:
                msg = await ws.recv()
                if msg is None:
                    break
                op, data = msg
                if self.ser is None:
                    await ws.send_str(json.dumps({"bridge": "error", "message": "pedal not connected"}))
                    continue
                if upload_left:            # mid-upload: pass bytes straight through under the lock we hold
                    n = min(upload_left, len(data))
                    self.write_serial(bytes(data[:n]))
                    upload_left -= n
                    data = data[n:]
                    if upload_left == 0:
                        await self._await_reply(30)      # #OK / #ERR closes the exchange
                        self.lock.release()
                    if not data:
                        continue
                pending += data
                while True:
                    nl = pending.find(b"\n")
                    if nl < 0:
                        break
                    line = bytes(pending[:nl + 1])
                    del pending[:nl + 1]
                    kind = self._transfer_kind(line.strip())
                    await self.lock.acquire()
                    self.write_serial(line)
                    if kind == "down":
                        # hold the pedal until the file (and its #END) has streamed out
                        got = await self._await_reply(30)
                        if got == b"#FILE":
                            while self._rx_skip and self.ser is not None:
                                await asyncio.sleep(0.02)
                        self.lock.release()
                    elif kind == "up":
                        got = await self._await_reply(15)
                        if got == b"#SEND":
                            try:
                                upload_left = int(line.split()[-1])
                            except ValueError:
                                upload_left = 0
                        if not upload_left:
                            self.lock.release()
                        else:
                            break              # keep the lock; raw bytes follow on this socket
                    else:
                        # plain command: let its one-line reply come back before the next
                        # browser's line (a monitor #STATUS may settle it early - harmless)
                        await self._await_reply(1.5)
                        self.lock.release()
        finally:
            if self.lock.locked() and upload_left:
                self.lock.release()
            sender.cancel()
            beat.cancel()
            self.clients.pop(ws, None)
            log(f"editor disconnected ({peer}, {len(self.clients)} left)")

    def status(self):
        return {
            "bridge": "looper",
            "pedal": self.ser is not None,
            "port": self.port_name,
            "editor_connected": any(not w.closed for w in self.clients),
            "editors": sum(1 for w in self.clients if not w.closed),
            "uptime_s": int(time.monotonic() - self.started),
            "rx_bytes": self.rx_bytes,
            "tx_bytes": self.tx_bytes,
            "pedal_connects": self.connects,
        }


# ------------------------------------------------------------------ web login
BOOTDIR = "/boot/firmware" if os.path.isdir("/boot/firmware") else "/boot"

def conf_value(key, default=""):
    """Read one setting from looper.conf (boot partition first, then /etc/looper)."""
    for path in (os.path.join(BOOTDIR, "looper.conf"), "/etc/looper/looper.conf"):
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith(key + "="):
                        return line.split("=", 1)[1].strip().strip('"').strip("'")
        except OSError:
            continue
    return default


class WebAuth:
    """A login for browsers that are not on the Pi itself.

    The kiosk (127.0.0.1) is always let through — it is the pedal's own screen. Everything
    else needs a session cookie, obtained by posting the appliance's user name and password
    to /api/login. Credentials live in /etc/looper/web-auth as
    `user:pbkdf2_sha256$rounds$salt$hash`; the root helper rewrites it when the password
    changes, so the console, SSH and the web share one password.
    """
    FILE = "/etc/looper/web-auth"
    COOKIE = "gls_session"
    ROUNDS = 100_000
    LIFETIME = 12 * 3600

    def __init__(self):
        self.sessions = {}          # token -> expiry
        self.fails = {}             # peer ip -> (count, when)

    @staticmethod
    def hash(password, salt=None, rounds=None):
        salt = salt or os.urandom(16)
        rounds = rounds or WebAuth.ROUNDS
        h = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
        return f"pbkdf2_sha256${rounds}${salt.hex()}${h.hex()}"

    CODE_FILE = "/run/looper/setup-code"

    def claimed(self):
        """Has anyone set a login yet? Until they have, the pedal is unconfigured."""
        return self.creds() is not None

    def setup_code(self):
        try:
            return open(self.CODE_FILE).read().strip()
        except OSError:
            return ""

    def creds(self):
        try:
            with open(self.FILE) as f:
                user, _, rest = f.read().strip().partition(":")
            return (user, rest) if user and rest else None
        except OSError:
            return None

    def enabled(self):
        return conf_value("WEB_AUTH", "1") != "0"

    def check(self, user, password):
        c = self.creds()
        if not c or not user or user != c[0]:
            return False
        try:
            algo, rounds, salt, want = c[1].split("$")
            if algo != "pbkdf2_sha256":
                return False
            got = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), int(rounds))
            return hmac.compare_digest(got.hex(), want)
        except (ValueError, TypeError):
            return False

    # -- sessions
    def start(self):
        self._sweep()
        token = base64.urlsafe_b64encode(os.urandom(24)).decode().rstrip("=")
        self.sessions[token] = time.time() + self.LIFETIME
        return token

    def valid(self, token):
        self._sweep()
        return bool(token) and token in self.sessions

    def drop(self, token):
        self.sessions.pop(token, None)

    def _sweep(self):
        now = time.time()
        for t, exp in list(self.sessions.items()):
            if exp < now:
                del self.sessions[t]

    # -- throttle: five bad tries buys a minute
    def blocked(self, ip):
        n, when = self.fails.get(ip, (0, 0))
        return n >= 5 and time.time() - when < 60

    def failed(self, ip):
        n, when = self.fails.get(ip, (0, 0))
        n = 1 if time.time() - when > 300 else n + 1
        self.fails[ip] = (n, time.time())

    def passed(self, ip):
        self.fails.pop(ip, None)

    @staticmethod
    def cookie_of(headers):
        for part in (headers.get("cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == WebAuth.COOKIE:
                return v
        return ""

    @staticmethod
    def is_local(peer):
        return peer.rsplit(":", 1)[0] in ("127.0.0.1", "::1", "localhost")


CLAIM_PAGE = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Set up LoopSmith</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;
 color:#e6e8ee;font:15px/1.45 -apple-system,"Segoe UI",Inter,Roboto,sans-serif}
form{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:26px 24px;width:min(420px,92vw);
 box-shadow:0 10px 40px rgba(0,0,0,.45)}
h1{font-size:18px;margin:0 0 4px;display:flex;align-items:center;gap:9px}
h1 i{width:22px;height:22px;border-radius:6px;background:#ffb454;display:block;position:relative}
h1 i:after{content:"";position:absolute;inset:6px;border-radius:50%;border:2px solid #171a21;border-right-color:transparent}
p.sub{color:#8a90a0;font-size:13px;margin:0 0 16px;line-height:1.5}
label{display:block;font-size:12px;color:#8a90a0;margin:12px 0 4px}
input{width:100%;background:#0f1115;border:1px solid #262b36;color:#e6e8ee;border-radius:8px;padding:10px;font:inherit}
input:focus{outline:none;border-color:#ffb454}
button{width:100%;margin-top:18px;background:#ffb454;color:#1a1200;border:0;border-radius:8px;padding:11px;
 font:inherit;font-weight:640;cursor:pointer}
.err{color:#ff453a;font-size:13px;min-height:1.2em;margin-top:10px}
.hint{color:#6b7280;font-size:12px;margin-top:6px}
.bar{height:4px;border-radius:2px;background:#262b36;margin-top:6px;overflow:hidden}
.bar i{display:block;height:100%;width:0;background:#ff453a;transition:width .2s,background .2s}
</style></head><body>
<form id="f"><h1><i></i>Set up your LoopSmith</h1>
<p class="sub" id="intro">Choose the login for this pedal. It is used for the web app, the console and
SSH — there is no default password, so nothing is left open.</p>
<div id="codewrap"><label for="c">Setup code</label><input id="c" autocomplete="off" autocapitalize="characters" placeholder="shown on the pedal's screen">
<div class="hint">On the HDMI screen, on the console, or in <b>setup-code.txt</b> on the card's boot partition.</div></div>
<label for="u">User name</label><input id="u" value="looper" autocomplete="username" autocapitalize="none">
<label for="p">Password</label><input id="p" type="password" autocomplete="new-password">
<div class="bar"><i id="strength"></i></div>
<label for="p2">Repeat the password</label><input id="p2" type="password" autocomplete="new-password">
<button type="submit">Create the login</button><div class="err" id="e"></div></form>
<script>
const $=i=>document.getElementById(i);
fetch('/api/claim/state').then(r=>r.json()).then(j=>{ if(j.local){ $('codewrap').remove();
  $('intro').textContent="You are at the pedal itself, so no setup code is needed. Choose the login for the web app, the console and SSH."; } });
$('p').addEventListener('input',()=>{ const v=$('p').value;
  let sc=Math.min(100,v.length*8+(/[A-Z]/.test(v)?12:0)+(/[0-9]/.test(v)?12:0)+(/[^A-Za-z0-9]/.test(v)?16:0));
  const b=$('strength'); b.style.width=sc+'%'; b.style.background=sc<45?'#ff453a':sc<75?'#ffb454':'#2dd4bf'; });
$('f').onsubmit=async ev=>{ev.preventDefault();$('e').textContent='';
  if($('p').value!==$('p2').value){$('e').textContent='The two passwords are different.';return;}
  if($('p').value.length<8){$('e').textContent='Use at least 8 characters.';return;}
  const body={user:$('u').value.trim(),password:$('p').value};
  if($('c'))body.code=$('c').value.trim();
  const r=await fetch('/api/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));
  if(j.ok){$('e').style.color='#2dd4bf';$('e').textContent='Done — signing you in…';setTimeout(()=>location.href='/',1200);}
  else $('e').textContent=j.message||'That did not work';};
</script></body></html>"""

LOGIN_PAGE = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>LoopSmith</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;
 color:#e6e8ee;font:15px/1.45 -apple-system,"Segoe UI",Inter,Roboto,sans-serif}
form{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:26px 24px;width:min(360px,92vw);
 box-shadow:0 10px 40px rgba(0,0,0,.45)}
h1{font-size:17px;margin:0 0 4px;display:flex;align-items:center;gap:9px}
h1 i{width:22px;height:22px;border-radius:6px;background:#ffb454;display:block;position:relative}
h1 i:after{content:"";position:absolute;inset:6px;border-radius:50%;border:2px solid #171a21;border-right-color:transparent}
p.sub{color:#8a90a0;font-size:13px;margin:0 0 18px}
label{display:block;font-size:12px;color:#8a90a0;margin:12px 0 4px}
input{width:100%;background:#0f1115;border:1px solid #262b36;color:#e6e8ee;border-radius:8px;padding:10px;font:inherit}
input:focus{outline:none;border-color:#ffb454}
button{width:100%;margin-top:18px;background:#ffb454;color:#1a1200;border:0;border-radius:8px;padding:11px;
 font:inherit;font-weight:640;cursor:pointer}
.err{color:#ff453a;font-size:13px;min-height:1.2em;margin-top:10px}
</style></head><body>
<form id="f"><h1><i></i>LoopSmith</h1>
<p class="sub">Sign in to reach the pedal from this device.</p>
<label for="u">User name</label><input id="u" autocomplete="username" autocapitalize="none" autofocus>
<label for="p">Password</label><input id="p" type="password" autocomplete="current-password">
<button type="submit">Sign in</button><div class="err" id="e"></div></form>
<script>
const f=document.getElementById('f'),e=document.getElementById('e');
f.onsubmit=async ev=>{ev.preventDefault();e.textContent='';
 const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({user:document.getElementById('u').value,password:document.getElementById('p').value})});
 const j=await r.json().catch(()=>({}));
 if(j.ok){const n=new URLSearchParams(location.search).get('next')||'/';location.href=n.startsWith('/')?n:'/';}
 else e.textContent=j.message||'Wrong user name or password';};
</script></body></html>"""


# ------------------------------------------------------------------ MIDI
def find_midi_device(explicit=None):
    """The pedal's USB MIDI port as an ALSA rawmidi device (/dev/snd/midiC<n>D0)."""
    if explicit and os.path.exists(explicit):
        return explicit
    try:
        for card in sorted(glob.glob("/proc/asound/card*")):
            try:
                cid = open(os.path.join(card, "id")).read().strip()
            except OSError:
                continue
            if cid in ("MIDIAudio", "Teensy") or "teensy" in cid.lower():
                n = card.rsplit("card", 1)[1]
                dev = f"/dev/snd/midiC{n}D0"
                if os.path.exists(dev):
                    return dev
    except OSError:
        pass
    return None


class SmfFile:
    """A Standard MIDI File, flattened into (seconds, bytes) events. Formats 0 and 1."""

    def __init__(self, data):
        if data[:4] != b"MThd":
            raise ValueError("not a MIDI file")
        hlen = struct.unpack(">I", data[4:8])[0]
        fmt, ntracks, division = struct.unpack(">HHH", data[8:14])
        if division & 0x8000:
            raise ValueError("SMPTE-timed MIDI files are not supported")
        pos = 8 + hlen
        raw = []                                   # (tick, order, bytes) for every channel/meta event
        tempo = [(0, 500000)]                      # (tick, microseconds per quarter)
        order = 0
        for _ in range(ntracks):
            if data[pos:pos + 4] != b"MTrk":
                break
            tlen = struct.unpack(">I", data[pos + 4:pos + 8])[0]
            trk = data[pos + 8:pos + 8 + tlen]
            pos += 8 + tlen
            i, tick, status = 0, 0, 0
            while i < len(trk):
                delta, i = self._vlq(trk, i)
                tick += delta
                b = trk[i]
                if b == 0xFF:                      # meta
                    typ = trk[i + 1]
                    ln, j = self._vlq(trk, i + 2)
                    body = trk[j:j + ln]
                    i = j + ln
                    if typ == 0x51 and ln == 3:
                        tempo.append((tick, (body[0] << 16) | (body[1] << 8) | body[2]))
                    elif typ == 0x2F:
                        break
                    continue
                if b in (0xF0, 0xF7):              # sysex: skip
                    ln, j = self._vlq(trk, i + 1)
                    i = j + ln
                    continue
                if b & 0x80:
                    status = b
                    i += 1
                if status < 0x80:
                    raise ValueError("running status without a status byte")
                kind = status & 0xF0
                n = 1 if kind in (0xC0, 0xD0) else 2
                msg = bytes([status]) + trk[i:i + n]
                i += n
                raw.append((tick, order, msg))
                order += 1
        tempo.sort()
        raw.sort(key=lambda e: (e[0], e[1]))
        # ticks -> seconds through the tempo map
        events, t_acc, last_tick, ti, cur = [], 0.0, 0, 0, tempo[0][1]
        for tick, _, msg in raw:
            while ti + 1 < len(tempo) and tempo[ti + 1][0] <= tick:
                nt, ntempo = tempo[ti + 1]
                t_acc += (nt - last_tick) * cur / division / 1e6
                last_tick, cur, ti = nt, ntempo, ti + 1
            t = t_acc + (tick - last_tick) * cur / division / 1e6
            events.append((t, msg))
        self.events = events
        self.length = events[-1][0] if events else 0.0
        self.tracks = ntracks

    @staticmethod
    def _vlq(b, i):
        v = 0
        while True:
            c = b[i]
            i += 1
            v = (v << 7) | (c & 0x7F)
            if not c & 0x80:
                return v, i


# ---------------------------------------------------------------------------
# Score playback controls (NEW): the pure scheduling core behind the player.
# Mirrored in the editor's createPlayerCore() so the browser player and the
# Pi player behave identically. Kept free of asyncio/IO so it unit-tests.
# ---------------------------------------------------------------------------
DRUM_CH = 9                     # 0-based MIDI channel 10: never transposed

PLAY_SPEED_MIN, PLAY_SPEED_MAX = 0.25, 4.0
PLAY_TRANSPOSE_MAX = 24         # semitones either way


def validate_midi_params(req, length=None):
    """Validate the playback-parameter fields of /api/midi/play and
    /api/midi/params. Returns (params, None) with only the keys that were
    present, or (None, message). Nothing is applied unless everything is
    valid — a bad request changes no state."""
    if not isinstance(req, dict):
        return None, "parameters must be an object"
    out = {}
    if "speed" in req:
        try:
            v = float(req["speed"])
        except (TypeError, ValueError):
            return None, "speed must be a number"
        if not (PLAY_SPEED_MIN <= v <= PLAY_SPEED_MAX):
            return None, "speed must be between %s and %s" % (PLAY_SPEED_MIN, PLAY_SPEED_MAX)
        out["speed"] = v
    if "transpose" in req:
        try:
            v = int(req["transpose"])
        except (TypeError, ValueError):
            return None, "transpose must be an integer"
        if abs(v) > PLAY_TRANSPOSE_MAX:
            return None, "transpose must be within +/-%d semitones" % PLAY_TRANSPOSE_MAX
        out["transpose"] = v
    for key in ("mute", "solo"):
        if key in req:
            v = req[key]
            if not isinstance(v, list) or not all(isinstance(c, int) and 1 <= c <= 16 for c in v):
                return None, key + " must be a list of channel numbers 1-16"
            out[key] = sorted(set(v))
    a = req.get("a") if "a" in req else None
    b = req.get("b") if "b" in req else None
    if "a" in req or "b" in req:
        for name, v in (("a", a), ("b", b)):
            if v is not None and not isinstance(v, (int, float)):
                return None, name + " must be a number of seconds or null"
            if v is not None and (v < 0 or (length is not None and v > length + 0.001)):
                return None, name + " is outside the file"
        if (a is None) != (b is None):
            return None, "a and b must be set (or cleared) together"
        if a is not None and b - a < 0.05:
            return None, "the repeat passage must be at least 0.05 s long"
        out["a"], out["b"] = a, b
    if "position_s" in req:
        try:
            v = float(req["position_s"])
        except (TypeError, ValueError):
            return None, "position_s must be a number"
        if v < 0 or (length is not None and v > length + 0.001):
            return None, "position_s is outside the file"
        out["position_s"] = v
    return out, None


class MidiPlayerLogic:
    """Event scheduling for one loaded file: which bytes go out as source time
    advances, with mute/solo, melodic transpose (channel 10 excluded), seeks
    that release held notes and chase controller state, and boundary releases.
    Times are source seconds — playback speed is the caller's clock concern."""

    def __init__(self, events, length):
        self.events = events            # [(seconds, bytes)] sorted
        self.length = length
        self.i = 0
        self.held = {}                  # (ch, source note) -> note actually sent
        self.mute = set()               # 1-based channels
        self.solo = set()
        self.transpose = 0

    def _audible(self, ch):
        c = ch + 1
        return (c in self.solo) if self.solo else (c not in self.mute)

    def _xform(self, msg):
        """The bytes to send for one file event, or None to drop it."""
        st = msg[0] & 0xF0
        ch = msg[0] & 0x0F
        if st == 0x90 and len(msg) > 2 and msg[2]:                 # note on
            if not self._audible(ch):
                return None
            n = msg[1]
            if self.transpose and ch != DRUM_CH:
                n += self.transpose
                if not 0 <= n <= 127:
                    return None                                    # transposed off the keyboard
            self.held[(ch, msg[1])] = n
            return bytes((msg[0], n, msg[2]))
        if st in (0x80, 0x90) and len(msg) > 1:                    # note off
            sent = self.held.pop((ch, msg[1]), None)
            if sent is None:
                return None                                        # its note-on never sounded
            return bytes((msg[0], sent, msg[2] if len(msg) > 2 else 0))
        return bytes(msg)               # CC / program / bend / aftertouch pass through

    def advance(self, to):
        """Everything due up to source time `to`, transformed. Moves the cursor."""
        out = []
        while self.i < len(self.events) and self.events[self.i][0] <= to:
            m = self._xform(self.events[self.i][1])
            if m:
                out.append(m)
            self.i += 1
        return out

    def release(self):
        """Note-offs for whatever is sounding, plus all-notes-off as a backstop.
        Sent at every stop, seek and loop boundary so nothing hangs."""
        out = [bytes((0x80 | ch, sent, 0)) for (ch, _src), sent in self.held.items()]
        self.held.clear()
        out.extend(bytes((0xB0 | ch, 123, 0)) for ch in range(16))
        return out

    def set_filters(self, mute=None, solo=None, transpose=None):
        """Change mute/solo/transpose live. Returns note-offs for held notes the
        new filters silence; already-sounding notes keep their pitch (their offs
        use the note that was actually sent)."""
        if mute is not None:
            self.mute = set(mute)
        if solo is not None:
            self.solo = set(solo)
        if transpose is not None:
            self.transpose = int(transpose)
        out = []
        for (ch, src), sent in list(self.held.items()):
            if not self._audible(ch):
                out.append(bytes((0x80 | ch, sent, 0)))
                del self.held[(ch, src)]
        return out

    def seek(self, t):
        """Move the cursor to source time t. Releases held notes, then replays
        the latest program change, controller values and pitch bend per channel
        from the top of the file so the instruments sound right mid-file."""
        out = self.release()
        prog, ccs, bend = {}, {}, {}
        j = 0
        while j < len(self.events) and self.events[j][0] < t:
            m = self.events[j][1]
            st, ch = m[0] & 0xF0, m[0] & 0x0F
            if st == 0xC0:
                prog[ch] = m[1]
            elif st == 0xB0 and len(m) > 2 and m[1] < 120:         # data CCs, not channel-mode
                ccs[(ch, m[1])] = m[2]
            elif st == 0xE0 and len(m) > 2:
                bend[ch] = (m[1], m[2])
            j += 1
        out.extend(bytes((0xC0 | ch, p)) for ch, p in sorted(prog.items()))
        out.extend(bytes((0xB0 | ch, cc, v)) for (ch, cc), v in sorted(ccs.items()))
        out.extend(bytes((0xE0 | ch, lo, hi)) for ch, (lo, hi) in sorted(bend.items()))
        self.i = j
        return out


class MidiLink:
    """The pedal's MIDI port shared by every /midi browser and the file player."""

    def __init__(self, hint, storage_dir):
        self.hint = hint
        self.storage_dir = storage_dir
        self.fd = None
        self.dev = None
        self.clients = {}            # ws -> queue
        self.in_events = 0
        self.out_events = 0
        self.player = None           # asyncio task
        self.play_file = None
        self.play_loop = False
        self.play_length = 0.0
        # score playback controls (NEW): speed, A/B repeat, and the pure
        # scheduling core (mute/solo/transpose/held notes) live in self.logic
        self.play_speed = 1.0
        self.play_a = None           # A/B repeat passage, source seconds (both or neither)
        self.play_b = None
        self.logic = None            # MidiPlayerLogic while a file is loaded
        self._src = 0.0              # source-time position at the anchor…
        self._anchor = 0.0           # …which is this monotonic instant
        self._wake = None            # asyncio.Event: params/seek changed, recompute now

    def midi_dir(self):
        d = os.path.join(self.storage_dir, "midi") if self.storage_dir and os.path.ismount(self.storage_dir) \
            else os.path.join(os.path.expanduser("~"), "looper", "midi")
        try:
            os.makedirs(d, exist_ok=True)
        except OSError:
            pass
        return d

    # -- device
    async def manager(self):
        loop = asyncio.get_running_loop()
        while True:
            if self.fd is None:
                dev = find_midi_device(self.hint)
                if dev:
                    try:
                        self.fd = os.open(dev, os.O_RDWR | os.O_NONBLOCK)
                        self.dev = dev
                        loop.add_reader(self.fd, self._on_readable)
                        log(f"MIDI port {dev}")
                        await self._control({"midi": "port", "connected": True, "port": dev})
                    except OSError as e:
                        log(f"MIDI open {dev} failed: {e}")
                        self.fd = None
            elif not os.path.exists(self.dev):
                self._close()
                await self._control({"midi": "port", "connected": False})
            await asyncio.sleep(2.0)

    def _close(self):
        if self.fd is not None:
            try:
                asyncio.get_running_loop().remove_reader(self.fd)
            except Exception:
                pass
            try:
                os.close(self.fd)
            except OSError:
                pass
            log("MIDI port gone")
        self.fd = None
        self.dev = None

    def _on_readable(self):
        try:
            data = os.read(self.fd, 4096)
        except BlockingIOError:
            return
        except OSError:
            self._close()
            return
        if not data:
            self._close()
            return
        self.in_events += sum(1 for b in data if b & 0x80)
        for q in list(self.clients.values()):
            q.put_nowait(data)

    def send(self, data):
        if self.fd is None or not data:
            return False
        try:
            os.write(self.fd, data)
            self.out_events += sum(1 for b in data if b & 0x80)
            return True
        except BlockingIOError:
            return False
        except OSError as e:
            log(f"MIDI write failed: {e}")
            self._close()
            return False

    async def _control(self, obj):
        text = json.dumps(obj)
        for ws in list(self.clients):
            if not ws.closed:
                try:
                    await ws.send_str(text)
                except Exception:
                    pass

    # -- browsers on /midi
    async def session(self, ws, peer):
        q = asyncio.Queue()
        self.clients[ws] = q

        async def sender():
            try:
                while True:
                    await ws.send_bytes(await q.get())
            except (asyncio.CancelledError, Exception):
                pass
        task = asyncio.ensure_future(sender())
        log(f"MIDI client {peer} ({len(self.clients)})")
        try:
            await ws.send_str(json.dumps({"midi": "hello", "connected": self.fd is not None, "port": self.dev}))
            while True:
                msg = await ws.recv()
                if msg is None:
                    break
                op, data = msg
                if op == 0x2 and data:
                    if not self.send(bytes(data)):
                        await ws.send_str(json.dumps({"midi": "error", "message": "MIDI port not connected"}))
        finally:
            task.cancel()
            self.clients.pop(ws, None)
            log(f"MIDI client gone ({peer}, {len(self.clients)} left)")

    # -- file player
    def _pos(self):
        """Where playback is, in SOURCE seconds (the score's clock): the anchor
        plus wall time elapsed scaled by the playback speed."""
        if not (self.player and not self.player.done()):
            return 0.0
        return min(self.play_length, self._src + (time.monotonic() - self._anchor) * self.play_speed)

    def status(self):
        lg = self.logic
        return {"connected": self.fd is not None, "port": self.dev, "playing": bool(self.player and not self.player.done()),
                "file": self.play_file, "loop": self.play_loop, "position_s": round(self._pos(), 2), "length_s": round(self.play_length, 2),
                "speed": self.play_speed, "transpose": lg.transpose if lg else 0,
                "mute": sorted(lg.mute) if lg else [], "solo": sorted(lg.solo) if lg else [],
                "a": self.play_a, "b": self.play_b,
                "in_events": self.in_events, "out_events": self.out_events, "dir": self.midi_dir()}

    def files(self):
        d = self.midi_dir()
        out = []
        try:
            for n in sorted(os.listdir(d)):
                p = os.path.join(d, n)
                if n.startswith(".") or not os.path.isfile(p) or os.path.splitext(n)[1].lower() not in (".mid", ".midi", ".smf"):
                    continue
                st = os.stat(p)
                out.append({"name": n, "bytes": st.st_size, "mtime": int(st.st_mtime)})
        except OSError:
            pass
        return out

    async def play(self, name, loop=False, params=None):
        await self.stop()
        if not name or "/" in name or name.startswith("."):
            return False, "bad file name"
        path = os.path.join(self.midi_dir(), name)
        try:
            smf = SmfFile(open(path, "rb").read())
        except (OSError, ValueError, struct.error, IndexError) as e:
            return False, f"cannot read {name}: {e}"
        if not smf.events:
            return False, "the file has no notes"
        self.play_file, self.play_loop, self.play_length = name, bool(loop), max(smf.length, 0.05)
        self.logic = MidiPlayerLogic(smf.events, self.play_length)
        self.play_speed, self.play_a, self.play_b = 1.0, None, None
        self._src, self._anchor = 0.0, time.monotonic()
        self._wake = asyncio.Event()
        start = 0.0
        if params:                                             # pre-validated by the route
            start = params.pop("position_s", 0.0)
            self._apply_params(params)
        self.player = asyncio.ensure_future(self._run(start))
        return True, f"{name}: {smf.length:.1f} s, {len(smf.events)} events"

    def _emit(self, msg):
        self.send(msg)
        for q in list(self.clients.values()):                  # browsers see what the player sends
            q.put_nowait(msg)

    def _seek_to(self, t):
        t = max(0.0, min(self.play_length, float(t)))
        for m in self.logic.seek(t):
            self._emit(m)
        self._src, self._anchor = t, time.monotonic()

    async def _run(self, start=0.0):
        """Position-based scheduler: sleeps in <=50 ms slices towards the next
        event so live speed/seek/filter changes (and _wake) land promptly, then
        emits everything due. Loop and A/B boundaries release held notes."""
        lg = self.logic
        try:
            if start > 0:
                self._seek_to(start)
            while True:
                end = self.play_b if self.play_b is not None else self.play_length
                pos = self._src + (time.monotonic() - self._anchor) * self.play_speed
                if pos >= end - 1e-9:
                    for m in lg.advance(end):                  # anything due right at the boundary
                        self._emit(m)
                    for m in lg.release():
                        self._emit(m)
                    if self.play_b is not None:                # A/B repeat wraps regardless of loop
                        self._seek_to(self.play_a or 0.0)
                        continue
                    if not self.play_loop:
                        break
                    self._seek_to(0.0)
                    continue
                nxt = lg.events[lg.i][0] if lg.i < len(lg.events) and lg.events[lg.i][0] <= end else end
                wait = (nxt - pos) / self.play_speed
                if wait > 0.001:
                    self._wake.clear()
                    try:
                        await asyncio.wait_for(self._wake.wait(), timeout=min(wait, 0.05))
                    except asyncio.TimeoutError:
                        pass
                    continue                                   # recompute: params may have moved
                for m in lg.advance(min(pos, end)):
                    self._emit(m)
        except asyncio.CancelledError:
            for m in lg.release():
                self._emit(m)
            raise

    def _apply_params(self, params):
        """Apply pre-validated playback parameters to a loaded player."""
        lg = self.logic
        if lg is None:
            return
        if "speed" in params:
            # re-anchor first so the elapsed wall time so far keeps its old scale
            self._src = self._pos() if (self.player and not self.player.done()) else self._src
            self._anchor = time.monotonic()
            self.play_speed = params["speed"]
        if "a" in params:                                      # validated as a pair
            self.play_a, self.play_b = params["a"], params["b"]
        filters = {k: params[k] for k in ("mute", "solo", "transpose") if k in params}
        if filters:
            for m in lg.set_filters(**filters):
                self._emit(m)
        if self._wake:
            self._wake.set()

    def set_params(self, params):
        """Live parameter change on the playing (or loaded) file."""
        self._apply_params(params)

    def seek(self, t):
        if not (self.player and not self.player.done()):
            return False, "nothing is playing"
        self._seek_to(t)
        if self._wake:
            self._wake.set()
        return True, "at %.2f s" % max(0.0, min(self.play_length, float(t)))

    def _all_off(self):
        """Panic: silence everything, held notes first when a file is loaded."""
        msgs = self.logic.release() if self.logic else [bytes((0xB0 | ch, 123, 0)) for ch in range(16)]
        for m in msgs:
            self.send(m)

    async def stop(self):
        if self.player and not self.player.done():
            self.player.cancel()
            try:
                await self.player
            except (asyncio.CancelledError, Exception):
                pass
        self.player = None


# ------------------------------------------------------- Pi: network + storage
class PiSystem:
    """NetworkManager (nmcli), USB storage, power and updates. Everything degrades to
    'not available' on a machine without those tools (development on a laptop)."""

    UPDATER = "/opt/looper/pi/looper-update.sh"

    def __init__(self, storage_dir, state_file="/run/looper/net.json"):
        self.storage_dir = storage_dir
        self.state_file = state_file
        self.nmcli = shutil.which("nmcli")
        self.update_last = None          # last check result (parsed JSON)
        self.update_msg = ""             # last apply message

    def app_version(self):
        for p in ("/opt/looper/VERSION", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "VERSION")):
            try:
                v = open(p).read().strip()
                if v:
                    return v
            except OSError:
                continue
        return "dev"

    def update_available(self):
        return bool(self.update_last and self.update_last.get("available"))

    async def update_check(self):
        if not os.path.exists(self.UPDATER):
            return {"available": False, "detail": "no updater installed (development bridge)", "version": self.app_version()}
        rc, out = await self._run(self.UPDATER, "check", timeout=200)     # check needs no privileges
        try:
            self.update_last = json.loads(out.strip().split("\n")[-1])
        except (ValueError, IndexError):
            self.update_last = {"available": False, "version": self.app_version(), "detail": out[-200:] or "check failed"}
        return self.update_last

    async def update_apply(self, rollback=False):
        """Install an update in the background. The bridge restarts itself as part of it, so the
        browser reconnects and checks transaction status; reconnect alone is not success."""
        if not os.path.exists(self.UPDATER):
            return False, "no updater installed"
        if await self.update_busy():
            return False, "an update is already running"
        # systemd runs looper-update.service as root; polkit lets the bridge start that one unit,
        # so the bridge never needs privileges itself (it keeps NoNewPrivileges)
        try:
            os.remove("/run/looper/update-result")
        except OSError:
            pass
        rc, out = await self._run("systemctl", "start", "--no-block", "looper-rollback.service" if rollback else "looper-update.service", timeout=20)
        if rc != 0:
            return False, (out or "systemctl refused").strip().split("\n")[-1][:200]
        self.update_msg = ""
        self.update_last = None
        return True, "installing"

    async def update_busy(self):
        rc, out = await self._run("systemctl", "is-active", "looper-update.service", timeout=8)
        if out.strip() in ("activating", "active"):
            return True
        rc, out = await self._run("systemctl", "is-active", "looper-rollback.service", timeout=8)
        return out.strip() in ("activating", "active")

    # ---- privileged setup actions (looper-admin.service, started through polkit) ----
    ADMIN = "/opt/looper/pi/looper-admin.sh"
    REQ = "/run/looper/admin-request.json"
    RES = "/run/looper/admin-result.json"

    async def admin(self, action, params, wait=25.0):
        """Hand one action to the root helper and wait (briefly) for its answer."""
        if not os.path.exists(self.ADMIN):
            return {"ok": False, "message": "not available on this machine (development bridge)"}
        rc, out = await self._run("systemctl", "is-active", "looper-admin.service", timeout=8)
        if out.strip() in ("activating", "active"):
            return {"ok": False, "message": "another setup action is still running"}
        for p in (self.REQ, self.RES):
            try:
                os.remove(p)
            except OSError:
                pass
        body = dict(params or {})
        body["action"] = action
        try:
            os.makedirs("/run/looper", exist_ok=True)
        except OSError:
            pass
        try:
            fd = os.open(self.REQ, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)   # may hold a password
            with os.fdopen(fd, "w") as f:
                json.dump(body, f)
        except OSError as e:
            return {"ok": False, "message": f"cannot write the request: {e}"}
        rc, out = await self._run("systemctl", "start", "--no-block", "looper-admin.service", timeout=20)
        if rc != 0:
            return {"ok": False, "message": (out or "systemctl refused").strip().split("\n")[-1][:200]}
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            await asyncio.sleep(0.25)
            try:
                with open(self.RES) as f:
                    res = json.load(f)
                try:
                    os.remove(self.REQ)
                except OSError:
                    pass
                return res
            except (OSError, ValueError):
                continue
        return {"ok": True, "message": "still working…", "pending": True}

    def update_status(self, busy=False):
        try:
            msg = open("/run/looper/update-result").read().strip()[:200]
            # an "updated to X" from an earlier run is stale once X is no longer what is installed
            if not (msg.startswith("updated to ") and msg.split()[-1] != self.app_version()):
                self.update_msg = msg or self.update_msg
        except OSError:
            pass
        st = {"version": self.app_version(), "updater": os.path.exists(self.UPDATER),
              "busy": busy, "message": self.update_msg,
              "rollback_available": os.path.isfile("/var/lib/looper/update-backup/manifest.json"),
              "os_reboot_required": os.path.exists("/var/run/reboot-required")}
        try:
            with open("/var/lib/looper/update-progress.json") as progress:
                st["transaction"] = json.load(progress)
        except (OSError, ValueError):
            pass
        if self.update_last:
            st.update({k: self.update_last.get(k) for k in ("available", "latest", "source", "detail", "checked")})
        return st

    def net_state(self):
        try:
            with open(self.state_file) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    async def _run(self, *cmd, timeout=25):
        p = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            out, _ = await asyncio.wait_for(p.communicate(), timeout)
        except asyncio.TimeoutError:
            p.kill()
            return 124, "timed out"
        return p.returncode, out.decode("utf-8", "replace").strip()

    @staticmethod
    def _unescape(s):
        return s.replace("\\:", ":").replace("\\\\", "\\")

    async def _iface_ip(self, iface):
        if not iface:
            return None
        rc, out = await self._run(self.nmcli, "-t", "-g", "IP4.ADDRESS", "device", "show", iface, timeout=8)
        if rc != 0 or not out:
            return None
        return out.split("\n")[0].split("/")[0] or None

    async def network_status(self):
        st = self.net_state()
        try:
            import pwd
            login = pwd.getpwuid(1000).pw_name
        except Exception:
            login = "looper"
        info = {"available": bool(self.nmcli), "login": login, "hotspot": {"iface": st.get("hotspot_if"),
                "ssid": st.get("hotspot_ssid"), "password": st.get("hotspot_pass"),
                "ip": st.get("hotspot_ip", "10.42.0.1"), "up": False,
                "enabled": conf_value("HOTSPOT_ENABLED", "1") != "0"},     # the switch, as saved
                "home": {"iface": st.get("home_if"), "ssid": None, "ip": None, "up": False},
                "hostname": os.uname().nodename, "internet": False, "devices": []}
        if not self.nmcli:
            return info
        rc, out = await self._run(self.nmcli, "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status", timeout=8)
        if rc == 0:
            for line in out.split("\n"):
                parts = line.split(":")
                if len(parts) < 4:
                    continue
                dev, typ, state, con = parts[0], parts[1], parts[2], self._unescape(":".join(parts[3:]))
                if typ not in ("wifi", "ethernet"):
                    continue
                d = {"iface": dev, "type": typ, "state": state, "connection": con or None,
                     "ip": await self._iface_ip(dev) if state.startswith("connected") else None}
                info["devices"].append(d)
                if dev == info["hotspot"]["iface"]:
                    info["hotspot"]["up"] = state.startswith("connected")
                elif state.startswith("connected"):
                    info["home"].update({"iface": dev, "up": True, "ip": d["ip"]})
                    if typ == "wifi":
                        rc2, ssid = await self._run(self.nmcli, "-t", "-g", "802-11-wireless.ssid",
                                                    "connection", "show", con, timeout=8)
                        info["home"]["ssid"] = ssid if rc2 == 0 else con
                    else:
                        info["home"]["ssid"] = "Ethernet"
        try:                                   # which virtual terminal the HDMI screen shows
            info["vt"] = open("/sys/class/tty/tty0/active").read().strip()
        except OSError:
            info["vt"] = None
        rc, out = await self._run("systemctl", "is-enabled", "ssh", timeout=6)
        en = out.strip() == "enabled"
        rc, out2 = await self._run("systemctl", "is-active", "ssh", timeout=6)
        info["ssh"] = {"enabled": en, "active": out2.strip() == "active"}
        rc, out = await self._run("ip", "-4", "route", "show", "default", timeout=5)
        if rc == 0 and out:
            hs = info["hotspot"]["iface"]
            info["internet"] = any(hs is None or f" dev {hs} " not in (l + " ") for l in out.split("\n"))
        return info

    async def network_scan(self):
        if not self.nmcli:
            return []
        iface = self.net_state().get("home_if")
        cmd = [self.nmcli, "-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "yes"]
        if iface:
            cmd += ["ifname", iface]
        rc, out = await self._run(*cmd, timeout=40)
        nets = {}
        if rc == 0:
            for line in out.split("\n"):
                # nmcli escapes ':' inside fields as '\:' — split on unescaped colons only
                fields, cur, i = [], "", 0
                while i < len(line):
                    c = line[i]
                    if c == "\\" and i + 1 < len(line):
                        cur += line[i + 1]
                        i += 2
                        continue
                    if c == ":":
                        fields.append(cur)
                        cur = ""
                    else:
                        cur += c
                    i += 1
                fields.append(cur)
                if len(fields) < 3 or not fields[0]:
                    continue
                ssid, sig, sec = fields[0], fields[1], fields[2]
                try:
                    sig = int(sig)
                except ValueError:
                    sig = 0
                if ssid not in nets or nets[ssid]["signal"] < sig:
                    nets[ssid] = {"ssid": ssid, "signal": sig, "security": sec or "open"}
        return sorted(nets.values(), key=lambda n: -n["signal"])

    async def network_connect(self, ssid, password, hidden=False):
        if not self.nmcli:
            return False, "NetworkManager is not available on this machine"
        if not ssid or len(ssid) > 32:
            return False, "SSID missing or too long"
        if password and not (8 <= len(password) <= 63):
            return False, "Wi-Fi passwords are 8-63 characters"
        iface = self.net_state().get("home_if")
        await self._run(self.nmcli, "connection", "delete", "looper-home", timeout=10)
        cmd = [self.nmcli, "device", "wifi", "connect", ssid, "name", "looper-home"]
        if password:
            cmd += ["password", password]
        if iface:
            cmd += ["ifname", iface]
        if hidden:
            cmd += ["hidden", "yes"]
        rc, out = await self._run(*cmd, timeout=60)
        if rc != 0:
            await self._run(self.nmcli, "connection", "delete", "looper-home", timeout=10)
            return False, out.split("\n")[-1] if out else "connection failed"
        # keep it pinned to the client radio and coming back after reboots
        mods = ["connection.autoconnect", "yes", "connection.autoconnect-priority", "5"]
        if iface:
            mods += ["connection.interface-name", iface]
        await self._run(self.nmcli, "connection", "modify", "looper-home", *mods, timeout=10)
        return True, await self._iface_ip(iface) or "connected"

    async def network_forget(self):
        if not self.nmcli:
            return False, "NetworkManager is not available"
        rc, out = await self._run(self.nmcli, "connection", "delete", "looper-home", timeout=10)
        return rc == 0, out

    async def power(self, action):
        if action not in ("reboot", "poweroff"):
            return False, "unknown action"
        rc, out = await self._run("systemctl", action, timeout=10)
        return rc == 0, out

    def mounted(self):
        d = self.storage_dir
        if not d or not os.path.isdir(d):
            return False
        return os.path.ismount(d) or bool(os.environ.get("LOOPER_DEV_STORAGE"))

    def storage(self):
        d = self.storage_dir
        info = {"path": d, "mounted": False, "free_mb": None, "total_mb": None, "files": 0}
        if not self.mounted():
            return info
        try:
            st = os.statvfs(d)
            info.update({"mounted": True, "free_mb": st.f_bavail * st.f_frsize // (1024 * 1024),
                         "total_mb": st.f_blocks * st.f_frsize // (1024 * 1024),
                         "files": len(self.library_files())})
        except OSError:
            pass
        return info

    def library_dir(self):
        d = self.storage_dir
        if not self.mounted():
            return None
        lib = os.path.join(d, "loops")
        try:
            os.makedirs(lib, exist_ok=True)
        except OSError:
            return d
        return lib

    def library_files(self):
        lib = self.library_dir()
        if not lib:
            return []
        out = []
        for n in sorted(os.listdir(lib)):
            p = os.path.join(lib, n)
            if n.startswith(".") or not os.path.isfile(p):
                continue
            if os.path.splitext(n)[1].lower() not in (".wav", ".mp3", ".txt"):
                continue
            st = os.stat(p)
            out.append({"name": n, "bytes": st.st_size, "mtime": int(st.st_mtime)})
        return out


# ------------------------------------------------------------- HTTP server
class Server:
    def __init__(self, bridge, editor_dir, www_dir, system, midi):
        self.auth = WebAuth()
        self.bridge = bridge
        self.editor_dir = editor_dir
        self.www_dir = www_dir
        self.system = system
        self.midi = midi

    # -- response helpers
    @staticmethod
    async def _respond(w, status, body=b"", ctype="text/plain; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        hdr = [f"HTTP/1.1 {status}", f"Content-Type: {ctype}", f"Content-Length: {len(body)}",
               "Connection: close", "Cache-Control: no-store", "Access-Control-Allow-Origin: *"]
        if extra:
            hdr += extra
        w.write(("\r\n".join(hdr) + "\r\n\r\n").encode("latin-1") + body)
        try:
            await w.drain()
        except (ConnectionError, OSError):
            pass

    async def _json(self, w, obj, status="200 OK", extra=None):
        await self._respond(w, status, json.dumps(obj), "application/json", extra)

    async def _file(self, w, path, download=False):
        if not os.path.isfile(path):
            await self._respond(w, "404 Not Found", "not found")
            return
        ext = os.path.splitext(path)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        size = os.path.getsize(path)
        hdr = [f"HTTP/1.1 200 OK", f"Content-Type: {ctype}", f"Content-Length: {size}",
               "Connection: close", "Cache-Control: no-store"]
        if download:
            hdr.append(f'Content-Disposition: attachment; filename="{os.path.basename(path)}"')
        w.write(("\r\n".join(hdr) + "\r\n\r\n").encode("latin-1"))
        try:
            with open(path, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    w.write(chunk)
                    await w.drain()
        except (ConnectionError, OSError):
            pass

    # -- request handling
    async def handle(self, r, w):
        peer = w.get_extra_info("peername")
        peer = f"{peer[0]}:{peer[1]}" if peer else "?"
        try:
            try:
                head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 15)
            except (asyncio.TimeoutError, asyncio.LimitOverrunError, asyncio.IncompleteReadError,
                    ConnectionError, OSError):
                return
            lines = head.decode("latin-1").split("\r\n")
            parts = lines[0].split(" ")
            if len(parts) < 2:
                await self._respond(w, "400 Bad Request", "bad request")
                return
            method, target = parts[0].upper(), parts[1]
            headers = {}
            for ln in lines[1:]:
                if ":" in ln:
                    k, v = ln.split(":", 1)
                    headers[k.strip().lower()] = v.strip()
            path = urllib.parse.unquote(urllib.parse.urlsplit(target).path)
            body = b""
            clen = int(headers.get("content-length", "0") or 0)
            if clen:
                if clen > MAX_HTTP_BODY:
                    await self._respond(w, "413 Payload Too Large", "too large")
                    return
                body = await asyncio.wait_for(r.readexactly(clen), 30)
            await self.route(r, w, method, path, headers, body, peer)
        except (ConnectionError, OSError, asyncio.IncompleteReadError, asyncio.TimeoutError):
            pass
        except Exception as e:   # never let one request kill the server
            log(f"request error ({peer}): {e!r}")
            try:
                await self._respond(w, "500 Internal Server Error", "error")
            except Exception:
                pass
        finally:
            try:
                w.close()
            except Exception:
                pass

    OPEN_PATHS = ("/login", "/api/login", "/api/logout")
    CLAIM_PATHS = ("/claim", "/api/claim", "/api/claim/state")

    async def route(self, r, w, method, path, headers, body, peer):
        if path == "/api/health" and WebAuth.is_local(peer):
            await self._json(w, {"ok": True})
            return
        # Until someone has set a login, the pedal serves nothing but the claim page.
        if not self.auth.claimed():
            if path == "/claim":
                await self._respond(w, "200 OK", CLAIM_PAGE, "text/html; charset=utf-8")
                return
            if path == "/api/claim/state":
                await self._json(w, {"claimed": False, "local": WebAuth.is_local(peer),
                                     "code_required": not WebAuth.is_local(peer)})
                return
            if path == "/api/claim" and method == "POST":
                ip = peer.rsplit(":", 1)[0]
                if self.auth.blocked(ip):
                    await self._json(w, {"ok": False, "message": "too many attempts — wait a minute"}, "429 Too Many Requests")
                    return
                try:
                    req = json.loads(body.decode("utf-8") or "{}")
                except ValueError:
                    req = {}
                if not WebAuth.is_local(peer):
                    want = self.auth.setup_code()
                    if not want or str(req.get("code", "")).strip().upper() != want.upper():
                        self.auth.failed(ip)
                        await asyncio.sleep(0.6)
                        await self._json(w, {"ok": False, "message": "wrong setup code"}, "401 Unauthorized")
                        return
                res = await self.system.admin("claim-account", {"username": str(req.get("user", "")),
                                                                "password": str(req.get("password", ""))}, 30.0)
                if res.get("ok"):
                    self.auth.passed(ip)
                    token = self.auth.start()
                    log(f"pedal claimed from {peer}")
                    await self._json(w, res, extra=[
                        f"Set-Cookie: {WebAuth.COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={WebAuth.LIFETIME}"])
                else:
                    await self._json(w, res, "400 Bad Request")
                return
            if path.startswith(("/api/", "/ws", "/midi", "/library")):
                await self._json(w, {"ok": False, "message": "this pedal has not been set up yet", "claim": True}, "409 Conflict")
                return
            await self._respond(w, "302 Found", "", "text/plain", ["Location: /claim"])
            return


        # Browsers that are not the pedal's own screen must be signed in.
        if self.auth.enabled() and not WebAuth.is_local(peer) and path not in self.OPEN_PATHS:
            if not self.auth.valid(WebAuth.cookie_of(headers)):
                if path in ("/ws", "/midi"):
                    await self._respond(w, "401 Unauthorized", "sign in first")
                elif path.startswith(("/api/", "/library", "/midi-files")):
                    await self._json(w, {"ok": False, "message": "not signed in", "login": True}, "401 Unauthorized")
                else:
                    nxt = urllib.parse.quote(path, safe="/")
                    await self._respond(w, "302 Found", "", "text/plain", [f"Location: /login?next={nxt}"])
                return

        if path == "/login":
            await self._respond(w, "200 OK", LOGIN_PAGE, "text/html; charset=utf-8")
            return
        if path == "/api/login" and method == "POST":
            ip = peer.rsplit(":", 1)[0]
            if self.auth.blocked(ip):
                await self._json(w, {"ok": False, "message": "too many attempts — wait a minute"}, "429 Too Many Requests")
                return
            try:
                req = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                req = {}
            if self.auth.check(str(req.get("user", "")), str(req.get("password", ""))):
                self.auth.passed(ip)
                token = self.auth.start()
                log(f"signed in from {peer}")
                await self._json(w, {"ok": True}, extra=[
                    f"Set-Cookie: {WebAuth.COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={WebAuth.LIFETIME}"])
            else:
                self.auth.failed(ip)
                await asyncio.sleep(0.6)
                await self._json(w, {"ok": False, "message": "wrong user name or password"}, "401 Unauthorized")
            return
        if path == "/api/logout" and method == "POST":
            self.auth.drop(WebAuth.cookie_of(headers))
            await self._json(w, {"ok": True}, extra=[f"Set-Cookie: {WebAuth.COOKIE}=; Path=/; Max-Age=0"])
            return

        if path == "/ws":
            if headers.get("upgrade", "").lower() != "websocket" or "sec-websocket-key" not in headers:
                await self._respond(w, "400 Bad Request", "websocket endpoint")
                return
            accept = base64.b64encode(hashlib.sha1(headers["sec-websocket-key"].encode("latin-1") + WS_GUID).digest())
            w.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n")
            await w.drain()
            ws = WebSocket(r, w)
            await self.bridge.ws_session(ws, peer)
            return

        if path in ("/", "/index.html"):
            index = os.path.join(self.editor_dir, "index.html")
            if not os.path.exists(index):
                await self._respond(w, "404 Not Found", "editor/index.html not found next to the bridge")
                return
            await self._file(w, index)
            return

        if path == "/midi":
            if headers.get("upgrade", "").lower() != "websocket" or "sec-websocket-key" not in headers:
                await self._respond(w, "400 Bad Request", "websocket endpoint")
                return
            accept = base64.b64encode(hashlib.sha1(headers["sec-websocket-key"].encode("latin-1") + WS_GUID).digest())
            w.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n")
            await w.drain()
            await self.midi.session(WebSocket(r, w), peer)
            return

        if path == "/api/status":
            st = self.bridge.status()
            st["storage"] = self.system.storage()
            st["hostname"] = os.uname().nodename
            m = self.midi.status()
            st["midi"] = {"connected": m["connected"], "playing": m["playing"], "file": m["file"]}
            st["app_version"] = self.system.app_version()
            st["web_auth"] = self.auth.enabled()
            st["local"] = WebAuth.is_local(peer)
            st["claimed"] = self.auth.claimed()
            st["update_available"] = self.system.update_available()
            await self._json(w, st)
            return

        # ---- MIDI files + player ----
        if path == "/api/midi/status":
            await self._json(w, self.midi.status())
            return
        if path == "/api/midi/play" and method == "POST":
            try:
                req = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                await self._json(w, {"ok": False, "message": "bad JSON"}, "400 Bad Request")
                return
            # Score playback controls (NEW): the play request may carry initial
            # speed / transpose / mute / solo / A-B / start position. Validated
            # before anything starts; a bad field refuses the whole request.
            params, err = validate_midi_params(req)
            if err:
                await self._json(w, {"ok": False, "message": err}, "400 Bad Request")
                return
            ok, msg = await self.midi.play(str(req.get("file", "")), bool(req.get("loop")), params)
            await self._json(w, {"ok": ok, "message": msg})
            return
        # ---- score playback controls (NEW): live seek + parameter changes ----
        if path == "/api/midi/seek" and method == "POST":
            try:
                req = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                await self._json(w, {"ok": False, "message": "bad JSON"}, "400 Bad Request")
                return
            params, err = validate_midi_params({"position_s": req.get("position_s")}, self.midi.play_length)
            if err:
                await self._json(w, {"ok": False, "message": err}, "400 Bad Request")
                return
            ok, msg = self.midi.seek(params["position_s"])
            await self._json(w, {"ok": ok, "message": msg})
            return
        if path == "/api/midi/params" and method == "POST":
            try:
                req = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                await self._json(w, {"ok": False, "message": "bad JSON"}, "400 Bad Request")
                return
            params, err = validate_midi_params(req, self.midi.play_length or None)
            if err:
                await self._json(w, {"ok": False, "message": err}, "400 Bad Request")
                return
            self.midi.set_params(params)
            await self._json(w, {"ok": True, "status": self.midi.status()})
            return
        if path == "/api/midi/stop" and method == "POST":
            await self.midi.stop()
            await self._json(w, {"ok": True})
            return
        if path == "/api/midi/panic" and method == "POST":
            await self.midi.stop()
            self.midi._all_off()
            await self._json(w, {"ok": True})
            return
        if path in ("/midi-files", "/midi-files/"):
            await self._json(w, {"dir": self.midi.midi_dir(), "files": self.midi.files()})
            return
        if path.startswith("/midi-files/"):
            name = path[len("/midi-files/"):]
            if "/" in name or name.startswith(".") or not name or os.path.splitext(name)[1].lower() not in (".mid", ".midi", ".smf"):
                await self._respond(w, "404 Not Found", "MIDI files are .mid")
                return
            full = os.path.join(self.midi.midi_dir(), name)
            if method == "PUT":
                if not body:
                    await self._json(w, {"ok": False, "message": "empty upload"}, "400 Bad Request")
                    return
                try:
                    smf = SmfFile(body)
                except (ValueError, struct.error, IndexError) as e:
                    await self._json(w, {"ok": False, "message": f"not a usable MIDI file: {e}"}, "400 Bad Request")
                    return
                tmp = full + ".part"
                try:
                    with open(tmp, "wb") as f:
                        f.write(body)
                    os.replace(tmp, full)
                except OSError as e:
                    await self._json(w, {"ok": False, "message": str(e)}, "500 Internal Server Error")
                    return
                await self._json(w, {"ok": True, "name": name, "length_s": round(smf.length, 2), "events": len(smf.events)})
                return
            if method == "DELETE":
                try:
                    os.remove(full)
                    await self._json(w, {"ok": True})
                except OSError as e:
                    await self._json(w, {"ok": False, "message": str(e)}, "404 Not Found")
                return
            await self._file(w, full, download=True)
            return

        if path == "/setup":
            await self._file(w, os.path.join(self.www_dir, "setup.html"))
            return

        if path == "/api/network":
            await self._json(w, await self.system.network_status())
            return
        if path == "/api/network/scan":
            await self._json(w, {"networks": await self.system.network_scan()})
            return
        if path == "/api/network/connect" and method == "POST":
            try:
                req = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                await self._json(w, {"ok": False, "message": "bad JSON"}, "400 Bad Request")
                return
            ok, msg = await self.system.network_connect(
                str(req.get("ssid", "")).strip(), str(req.get("password", "")), bool(req.get("hidden")))
            await self._json(w, {"ok": ok, "message": msg})
            return
        if path == "/api/network/forget" and method == "POST":
            ok, msg = await self.system.network_forget()
            await self._json(w, {"ok": ok, "message": msg})
            return
        if path in ("/api/system/reboot", "/api/system/poweroff") and method == "POST":
            ok, msg = await self.system.power(path.rsplit("/", 1)[1])
            await self._json(w, {"ok": ok, "message": msg})
            return

        # ---- updates ----
        if path == "/api/update/status":
            await self._json(w, self.system.update_status(await self.system.update_busy()))
            return
        if path == "/api/update/check" and method == "POST":
            await self._json(w, await self.system.update_check())
            return
        # ---- setup actions: login, hotspot, bluetooth ----
        if path.startswith("/api/admin/") and method == "POST":
            action = path[len("/api/admin/"):]
            if action not in ("set-password", "set-username", "set-hotspot", "hotspot-enable", "ssh-enable",
                              "stage-bundle", "console", "kiosk-reload", "claim-account", "reset-login", "bt-scan", "bt-pair", "bt-connect", "bt-disconnect",
                              "bt-remove", "bt-power"):
                await self._json(w, {"ok": False, "message": "unknown action"}, "404 Not Found")
                return
            try:
                req = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                await self._json(w, {"ok": False, "message": "bad JSON"}, "400 Bad Request")
                return
            # From anywhere but the pedal's own screen, changing the login means proving you
            # know the current one. At the pedal itself you can always recover the account.
            if action == "reset-login" and not WebAuth.is_local(peer):
                await self._json(w, {"ok": False, "message": "only from the pedal's own screen"}, "403 Forbidden")
                return
            if action in ("set-password", "set-username") and not WebAuth.is_local(peer):
                if not self.auth.check(self.auth.creds()[0], str(req.get("current", ""))):
                    await self._json(w, {"ok": False, "message": "the current password is required"}, "401 Unauthorized")
                    return
            req.pop("current", None)
            wait = 40.0 if action in ("bt-scan", "bt-pair") else 25.0
            await self._json(w, await self.system.admin(action, req, wait))
            return
        if path == "/api/admin/result":
            try:
                with open(self.system.RES) as f:
                    await self._json(w, json.load(f))
            except (OSError, ValueError):
                await self._json(w, {"ok": False, "message": "nothing yet"})
            return

        if path == "/api/update/upload" and method in ("POST", "PUT"):
            # an update bundle straight from the browser: the last resort when the Pi is
            # unreachable any other way. Written where the bridge can write, then checked
            # and staged by the root helper.
            if not body:
                await self._json(w, {"ok": False, "message": "empty upload"}, "400 Bad Request")
                return
            try:
                os.makedirs("/run/looper", exist_ok=True)
                with open("/run/looper/upload.tar.gz", "wb") as f:
                    f.write(body)
            except OSError as e:
                await self._json(w, {"ok": False, "message": f"cannot store the upload: {e}"}, "500 Internal Server Error")
                return
            await self._json(w, await self.system.admin("stage-bundle", {}, 30.0))
            return

        if path in ("/api/update/apply", "/api/update/rollback") and method == "POST":
            ok, msg = await self.system.update_apply(rollback=path.endswith("/rollback"))
            await self._json(w, {"ok": ok, "message": msg})
            return

        if path == "/api/storage":
            await self._json(w, self.system.storage())
            return
        if path == "/library/" or path == "/library":
            await self._json(w, {"storage": self.system.storage(), "files": self.system.library_files()})
            return
        if path.startswith("/library/"):
            name = path[len("/library/"):]
            lib = self.system.library_dir()
            if not lib or "/" in name or name.startswith(".") or not name:
                await self._respond(w, "404 Not Found", "no such file")
                return
            if method == "DELETE":
                try:
                    os.remove(os.path.join(lib, name))
                    await self._json(w, {"ok": True})
                except OSError as e:
                    await self._json(w, {"ok": False, "message": str(e)}, "404 Not Found")
                return
            await self._file(w, os.path.join(lib, name), download=True)
            return

        # PWA + static bits from www/
        if method == "GET" and "/" not in path[1:] and not path[1:].startswith("."):
            cand = os.path.join(self.www_dir, path[1:])
            if os.path.isfile(cand):
                await self._file(w, cand)
                return
        await self._respond(w, "404 Not Found", "not found")


def parse_http(spec, default_port="8080"):
    spec = spec.strip()
    if spec.startswith("["):                      # [::1]:8080
        host, _, port = spec[1:].partition("]")
        port = port.lstrip(":")
    elif spec.count(":") == 1:                    # host:port
        host, _, port = spec.partition(":")
    elif spec.count(":") > 1:                     # bare IPv6 literal, default port
        host, port = spec, ""
    else:                                         # bare host or bare port
        host, port = (("", spec) if spec.isdigit() else (spec, ""))
    if not port:
        port = default_port
    if not port.isdigit():
        raise ValueError(f"--http expects host:port, got {spec!r}")
    return host or "0.0.0.0", int(port)


async def amain(args):
    host, port = parse_http(args.http)
    bridge = Bridge(args.port)
    system = PiSystem(args.storage)
    midi = MidiLink(args.midi, args.storage)
    server = Server(bridge, os.path.abspath(args.editor), os.path.abspath(args.www), system, midi)
    srv = await asyncio.start_server(server.handle, host, port, limit=65536, reuse_address=True)
    serial_task = asyncio.ensure_future(bridge.serial_manager())
    midi_task = asyncio.ensure_future(midi.manager())
    log(f"serving editor from {server.editor_dir} on http://{host}:{port}/  (www: {server.www_dir}, storage: {args.storage})")
    try:
        async with srv:
            await srv.serve_forever()
    finally:
        serial_task.cancel()
        midi_task.cancel()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="LoopSmith serial <-> WebSocket bridge")
    ap.add_argument("--port", default=None, help="serial device (default: auto-detect the Teensy)")
    ap.add_argument("--http", default="0.0.0.0:8080", help="listen address host:port")
    ap.add_argument("--editor", default=os.path.join(here, "..", "editor"),
                    help="directory containing the Studio editor index.html")
    ap.add_argument("--www", default=os.path.join(here, "www"),
                    help="directory with setup.html, the PWA manifest and icons")
    ap.add_argument("--storage", default="/media/usb", help="USB drive mount point for the loop library")
    ap.add_argument("--midi", default=None, help="the pedal's ALSA rawmidi device (default: auto-detect /dev/snd/midiC*D0)")
    args = ap.parse_args()
    try:
        parse_http(args.http)
    except ValueError as e:
        ap.error(str(e))
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
