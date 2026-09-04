#!/usr/bin/env python3
"""Write the example MIDI files in this folder.

They are made to be *looped*: every file is a whole number of bars, ends with an
all-notes-off exactly on the bar line, and uses the channels the pedal's band presets
bind — 1 rhythm, 2 lead, 3 bass, 10 drums (see docs/PATCHSCRIPT.md "Instruments").

    python3 midi/make_examples.py
"""
import os, struct

PPQ = 480
HERE = os.path.dirname(os.path.abspath(__file__))
KICK, SNARE, CLAP, HAT, OHAT, LTOM, HTOM, BELL = 36, 38, 39, 42, 46, 45, 50, 56
RIM, CONGA_H, CONGA_L, SHAKER = 37, 63, 64, 70


def vlq(n):
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append(0x80 | (n & 0x7F))
        n >>= 7
    return bytes(reversed(out))


class Track:
    """Absolute-time events, sorted and delta-encoded on write."""

    def __init__(self, name=None):
        self.ev = []                      # (tick, order, bytes)
        self.n = 0
        if name:
            b = name.encode()
            self.meta(0, 0x03, b)

    def meta(self, tick, typ, data):
        self.ev.append((tick, self.n, b"\xff" + bytes([typ]) + vlq(len(data)) + data)); self.n += 1

    def tempo(self, bpm):
        us = int(60_000_000 / bpm)
        self.meta(0, 0x51, us.to_bytes(3, "big"))

    def note(self, ch, tick, note, vel, length):
        self.ev.append((tick, self.n, bytes([0x90 | ch, note, vel]))); self.n += 1
        self.ev.append((tick + length, self.n, bytes([0x80 | ch, note, 0]))); self.n += 1

    def chord(self, ch, tick, notes, vel, length, spread=0):
        for i, nte in enumerate(notes):
            self.note(ch, tick + i * spread, nte, max(1, vel - i), length - i * spread)

    def all_off(self, tick, channels):
        for ch in channels:
            self.ev.append((tick, self.n, bytes([0xB0 | ch, 123, 0]))); self.n += 1

    def bytes(self):
        self.ev.sort(key=lambda e: (e[0], e[1]))
        out, last = bytearray(), 0
        for tick, _, msg in self.ev:
            out += vlq(tick - last) + msg
            last = tick
        out += vlq(0) + b"\xff\x2f\x00"
        return b"MTrk" + struct.pack(">I", len(out)) + bytes(out)


def write(name, tracks, title):
    data = b"MThd" + struct.pack(">IHHH", 6, 1, len(tracks), PPQ) + b"".join(t.bytes() for t in tracks)
    path = os.path.join(HERE, name)
    open(path, "wb").write(data)
    print(f"  {name:28s} {len(data):6d} B  {title}")


B = PPQ * 4                                   # one 4/4 bar
def beats(x): return int(PPQ * x)


# ---------------------------------------------------------------- drums
def drum_track(bars, bpm, style):
    t = Track("drums"); t.tempo(bpm)
    for bar in range(bars):
        o = bar * B
        last = bar == bars - 1
        if style == "click":
            for b in range(4):
                t.note(9, o + b * PPQ, RIM if b else BELL, 110 if b == 0 else 70, beats(0.1))
        elif style == "rock":
            for b in range(4):
                t.note(9, o + b * PPQ, HAT, 70 if b % 2 else 88, beats(0.1))
                t.note(9, o + b * PPQ + beats(0.5), HAT, 58, beats(0.1))
            t.note(9, o, KICK, 112, beats(0.1))
            t.note(9, o + beats(1.5), KICK, 96, beats(0.1))
            t.note(9, o + beats(2), SNARE, 108, beats(0.1))
            t.note(9, o + beats(3), KICK, 90, beats(0.1))
            if last:                                  # a fill into the loop point
                for i in range(4):
                    t.note(9, o + beats(3.0 + i * 0.25), SNARE if i % 2 else LTOM, 80 + 10 * i, beats(0.1))
        elif style == "funk":
            for b in range(8):
                t.note(9, o + b * beats(0.5), HAT, 84 if b % 2 == 0 else 56, beats(0.08))
            for at, vel in ((0, 115), (0.75, 88), (2.5, 100), (3.25, 84)):
                t.note(9, o + beats(at), KICK, vel, beats(0.1))
            t.note(9, o + beats(1), SNARE, 110, beats(0.1))
            t.note(9, o + beats(3), SNARE, 106, beats(0.1))
            t.note(9, o + beats(1.75), CLAP, 70, beats(0.1))
            t.note(9, o + beats(2), OHAT, 66, beats(0.2))
        elif style == "shuffle":
            for b in range(4):
                t.note(9, o + b * PPQ, HAT, 86, beats(0.1))
                t.note(9, o + b * PPQ + beats(0.66), HAT, 60, beats(0.1))
            t.note(9, o, KICK, 110, beats(0.1))
            t.note(9, o + beats(2), SNARE, 104, beats(0.1))
            t.note(9, o + beats(2.66), KICK, 84, beats(0.1))
        elif style == "perc":
            for b in range(4):
                t.note(9, o + b * PPQ, SHAKER, 70, beats(0.1))
                t.note(9, o + b * PPQ + beats(0.5), SHAKER, 48, beats(0.1))
            t.note(9, o, CONGA_L, 100, beats(0.15))
            t.note(9, o + beats(1.5), CONGA_H, 92, beats(0.15))
            t.note(9, o + beats(2.5), CONGA_H, 80, beats(0.15))
            t.note(9, o + beats(3), RIM, 88, beats(0.1))
    t.all_off(bars * B, [9])
    return t


# ---------------------------------------------------------------- pitched parts
PROG = [("Em", 40, [40, 47, 52, 55]), ("C", 36, [48, 52, 55, 60]),
        ("G", 43, [43, 47, 50, 55]), ("D", 38, [50, 54, 57, 62])]

def bass_track(bars, bpm, busy=False):
    t = Track("bass"); t.tempo(bpm)
    for bar in range(bars):
        root = PROG[bar % 4][1] - 12
        o = bar * B
        t.note(2, o, root, 104, beats(0.9))
        t.note(2, o + beats(1.5), root, 84, beats(0.4))
        t.note(2, o + beats(2), root, 98, beats(0.9))
        t.note(2, o + beats(3), root + (7 if busy else 0), 86, beats(0.4))
        t.note(2, o + beats(3.5), root + (5 if busy else 7), 80, beats(0.4))
    t.all_off(bars * B, [2])
    return t

def chord_track(bars, bpm):
    t = Track("rhythm"); t.tempo(bpm)
    for bar in range(bars):
        notes = PROG[bar % 4][2]
        o = bar * B
        for at, vel, ln in ((0, 82, 1.4), (1, 70, 0.45), (1.5, 62, 0.4), (2.5, 76, 0.45), (3, 64, 0.4), (3.5, 72, 0.45)):
            t.chord(0, o + beats(at), notes if at % 1 == 0 else notes[::-1], vel, beats(ln), spread=beats(0.02))
    t.all_off(bars * B, [0])
    return t

def lead_track(bars, bpm):
    t = Track("lead"); t.tempo(bpm)
    phrase = [(64, .5), (67, .5), (69, 1), (71, .5), (74, .5), (71, 1), (69, .5), (67, .5),
              (64, 1), (62, 1), (64, .5), (67, .5), (69, 1), (71, .5), (74, 1.5), (76, .5)]
    at = 0.0
    for note, ln in phrase:
        if at >= bars * 4: break
        t.note(1, beats(at), note, 96, beats(ln * 0.92))
        at += ln
    t.all_off(bars * B, [1])
    return t


os.makedirs(HERE, exist_ok=True)
print("writing example MIDI files:")
write("01-click-100bpm.mid",   [drum_track(4, 100, "click")],  "four bars of click — set a loop length by ear")
write("02-rock-100bpm.mid",    [drum_track(4, 100, "rock")],   "straight rock beat with a fill into the loop point")
write("03-funk-96bpm.mid",     [drum_track(2, 96, "funk")],    "two-bar funk pattern, syncopated kick")
write("04-shuffle-88bpm.mid",  [drum_track(4, 88, "shuffle")], "lazy shuffle, good under a slow lead")
write("05-percussion-104bpm.mid", [drum_track(4, 104, "perc")], "congas, rim and shaker — for the Percussion kit")
write("06-bass-Em-C-G-D.mid",  [bass_track(4, 100)],           "root bass line through the progression")
write("07-chords-Em-C-G-D.mid",[chord_track(4, 100)],          "strummed chords on the rhythm channel")
write("08-lead-Em-pentatonic.mid", [lead_track(4, 100)],       "a pentatonic line for the lead channel")
write("09-band-8bars.mid", [drum_track(8, 100, "rock"), bass_track(8, 100, True),
                            chord_track(8, 100), lead_track(8, 100)], "the whole band — the end-to-end test")
# a bare drum-map file: every note the three kits answer, one at a time
t = Track("drum map"); t.tempo(90)
for i, n in enumerate([KICK, RIM, SNARE, CLAP, LTOM, HAT, OHAT, HTOM, BELL, 60, CONGA_H, CONGA_L, SHAKER]):
    t.note(9, i * PPQ, n, 100, beats(0.4))
t.all_off(14 * PPQ, [9])
write("10-drum-map.mid", [t], "every drum note the kits use, one per beat")
print("\nchannels: 1 rhythm · 2 lead · 3 bass · 10 drums")
