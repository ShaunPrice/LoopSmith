#!/usr/bin/env python3
"""Tests for the Pi bridge's MIDI player: SMF parsing, the pure scheduling
core (MidiPlayerLogic), parameter validation, and the asyncio player end to
end with a stubbed MIDI port.

    python3 tests/test_bridge_player.py -v          (standard library only)
"""
import asyncio
import importlib.util
import os
import struct
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "..", "pi", "looper_bridge.py")
spec = importlib.util.spec_from_file_location("looper_bridge", BRIDGE)
lb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lb)


# ---------------------------------------------------------------- SMF builder
def vlq(n):
    out = [n & 0x7F]
    while True:
        n >>= 7
        if not n:
            return bytes(out)
        out.insert(0, (n & 0x7F) | 0x80)


def build_smf(events, ppq=480):
    """events: (delta_ticks, *message_bytes); one format-0 track."""
    trk = b"".join(vlq(d) + bytes(m) for d, *m in [(e[0], *e[1:]) for e in events])
    trk += b"\x00\xff\x2f\x00"
    head = b"MThd" + struct.pack(">IHHH", 6, 0, 1, ppq)
    return head + b"MTrk" + struct.pack(">I", len(trk)) + trk


SIMPLE = build_smf([
    (0, 0xC0, 5),               # program 5, ch1
    (0, 0xB0, 7, 100),          # CC7
    (0, 0x90, 60, 90),          # C4 on
    (480, 0x80, 60, 0),         # C4 off (0.5 s at default tempo)
    (0, 0x99, 36, 100),         # kick, ch10
    (240, 0x89, 36, 0),
    (240, 0x90, 64, 80),
    (480, 0x80, 64, 0),
])


class TestSmfFile(unittest.TestCase):
    def test_parse_and_timing(self):
        smf = lb.SmfFile(SIMPLE)
        self.assertEqual(len(smf.events), 8)
        self.assertAlmostEqual(smf.events[3][0], 0.5, places=6)   # C4 off after a quarter
        self.assertAlmostEqual(smf.length, 1.5, places=6)

    def test_tempo_map(self):
        smf = lb.SmfFile(build_smf([
            (0, 0xFF, 0x51, 3, 0x07, 0xA1, 0x20),   # 120 bpm
            (0, 0x90, 60, 90),
            (480, 0xFF, 0x51, 3, 0x0F, 0x42, 0x40), # 60 bpm after one quarter
            (480, 0x80, 60, 0),
        ]))
        self.assertAlmostEqual(smf.events[-1][0], 0.5 + 1.0, places=6)

    def test_rejects_garbage(self):
        with self.assertRaises(ValueError):
            lb.SmfFile(b"not a midi file at all")


class TestValidateParams(unittest.TestCase):
    def ok(self, req, **kw):
        params, err = lb.validate_midi_params(req, **kw)
        self.assertIsNone(err, err)
        return params

    def bad(self, req, **kw):
        params, err = lb.validate_midi_params(req, **kw)
        self.assertIsNone(params)
        self.assertTrue(err)
        return err

    def test_good(self):
        p = self.ok({"speed": 1.5, "transpose": -12, "mute": [3, 3, 1], "solo": [], "a": 0.5, "b": 2.0})
        self.assertEqual(p["mute"], [1, 3])
        self.assertEqual(p["speed"], 1.5)

    def test_partial_returns_only_given_keys(self):
        self.assertEqual(set(self.ok({"speed": 2.0})), {"speed"})

    def test_bounds(self):
        self.bad({"speed": 0.1})
        self.bad({"speed": 8})
        self.bad({"speed": "fast"})
        self.bad({"transpose": 25})
        self.bad({"transpose": "up"})
        self.bad({"mute": [0]})
        self.bad({"mute": [17]})
        self.bad({"mute": "1,2"})
        self.bad({"solo": [1.5]})

    def test_nonfinite_bool_and_fractional_refused(self):
        nan, inf = float("nan"), float("inf")
        self.bad({"speed": nan})
        self.bad({"speed": inf})
        self.bad({"speed": True})                          # bool is an int in Python; not a speed
        self.bad({"transpose": 1.5})                       # fractional semitones
        self.bad({"transpose": nan})
        self.bad({"transpose": True})
        self.bad({"mute": [True]})                         # True == 1, but it is not a channel
        self.bad({"a": nan, "b": 2.0})
        self.bad({"a": 0.0, "b": inf})
        self.bad({"a": 0.0, "b": -inf})
        self.bad({"position_s": nan})
        self.bad({"position_s": inf})
        self.bad({"position_s": True})
        # integral floats are fine (JSON often carries 2.0) — matching the editor
        self.assertEqual(self.ok({"transpose": 2.0})["transpose"], 2)

    def test_ab_pairing_and_range(self):
        self.bad({"a": 1.0})                              # A without B
        self.bad({"b": 1.0})
        self.bad({"a": 1.0, "b": 1.02})                   # too short
        self.bad({"a": -1, "b": 2})
        self.bad({"a": 0.0, "b": 99.0}, length=10.0)      # beyond the file
        p = self.ok({"a": None, "b": None})               # explicit clear
        self.assertEqual((p["a"], p["b"]), (None, None))

    def test_position(self):
        self.bad({"position_s": "x"})
        self.bad({"position_s": 11.0}, length=10.0)
        self.assertEqual(self.ok({"position_s": 2.5}, length=10.0)["position_s"], 2.5)


class TestPlayerLogic(unittest.TestCase):
    def logic(self, data=SIMPLE):
        smf = lb.SmfFile(data)
        return lb.MidiPlayerLogic(smf.events, smf.length)

    def test_advance_in_order(self):
        lg = self.logic()
        out = lg.advance(10)
        self.assertEqual(len(out), 8)
        self.assertEqual(out[2], bytes((0x90, 60, 90)))

    def test_transpose_skips_drums(self):
        lg = self.logic()
        lg.set_filters(transpose=3)
        out = lg.advance(10)
        ons = [m for m in out if (m[0] & 0xF0) == 0x90 and m[2]]
        self.assertEqual([(m[0], m[1]) for m in ons], [(0x90, 63), (0x99, 36), (0x90, 67)])
        offs = [m for m in out if (m[0] & 0xF0) == 0x80]
        self.assertEqual([(m[0], m[1]) for m in offs], [(0x80, 63), (0x89, 36), (0x80, 67)])

    def test_transpose_off_keyboard_drops_on_and_off(self):
        lg = self.logic(build_smf([(0, 0x90, 120, 90), (480, 0x80, 120, 0)]))
        lg.set_filters(transpose=20)
        out = lg.advance(10)
        self.assertEqual([m for m in out if (m[0] & 0xE0) == 0x80], [])
        self.assertEqual(lg.held, {})

    def test_live_transpose_off_matches_what_sounded(self):
        lg = self.logic(build_smf([(0, 0x90, 60, 90), (480, 0x80, 60, 0)]))
        lg.advance(0.1)
        lg.set_filters(transpose=7)
        self.assertEqual(lg.advance(10), [bytes((0x80, 60, 0))])

    def test_mute_releases_held_and_silences(self):
        lg = self.logic()
        lg.advance(0.1)                                    # C4 sounding
        offs = lg.set_filters(mute=[1])
        self.assertEqual(offs, [bytes((0x80, 60, 0))])
        rest = lg.advance(10)
        self.assertFalse(any(m[0] == 0x90 and m[2] for m in rest))
        self.assertTrue(any(m[0] == 0x99 for m in rest))   # drums unaffected

    def test_solo(self):
        lg = self.logic()
        lg.set_filters(solo=[10])
        out = lg.advance(10)
        self.assertTrue(any(m[0] == 0x99 for m in out))
        self.assertFalse(any(m[0] == 0x90 and len(m) > 2 and m[2] for m in out))
        self.assertTrue(any((m[0] & 0xF0) == 0xB0 for m in out))   # CCs still pass

    def test_release_covers_everything(self):
        lg = self.logic()
        lg.advance(0.1)
        out = lg.release()
        # sustain (CC64) comes up on every channel BEFORE any note-off —
        # a note-off under a down damper keeps sounding
        for i in range(16):
            self.assertEqual((out[i][0] & 0xF0, out[i][1], out[i][2]), (0xB0, 64, 0))
        self.assertEqual(out[16], bytes((0x80, 60, 0)))
        self.assertEqual(sum(1 for m in out if (m[0] & 0xF0) == 0xB0 and m[1] == 123), 16)
        self.assertEqual(lg.held, {})

    def test_sustained_notes_cannot_survive_stop_or_mute(self):
        lg = self.logic(build_smf([
            (0, 0xB0, 64, 127),                            # damper down on ch1
            (0, 0x90, 60, 90), (240, 0x80, 60, 0),         # struck and "released" under sustain
            (240, 0x90, 62, 90), (960, 0x80, 62, 0),
        ]))
        lg.advance(0.6)                                    # damper down, D4 (0.5 s) held
        self.assertIn(0, lg.sustain)
        offs = lg.set_filters(mute=[1])                    # muting lifts the damper first
        self.assertEqual(offs[0], bytes((0xB0, 64, 0)))
        self.assertEqual(offs[1], bytes((0x80, 62, 0)))
        self.assertNotIn(0, lg.sustain)

    def test_mute_releases_sustain_with_no_held_keys(self):
        lg = self.logic(build_smf([
            (0, 0xB0, 64, 127), (0, 0x90, 60, 90),
            (240, 0x80, 60, 0), (960, 0xB0, 64, 0),
        ]))
        lg.advance(0.3)
        self.assertEqual(lg.held, {})
        self.assertEqual(lg.set_filters(mute=[1]), [bytes((0xB0, 64, 0))])

    def test_seek_restores_sustain_state(self):
        lg = self.logic(build_smf([
            (0, 0xB0, 64, 127),
            (0, 0x90, 60, 90), (480, 0x80, 60, 0),
            (480, 0xB0, 64, 0),                            # damper up at 1.0 s
            (0, 0x90, 62, 90), (480, 0x80, 62, 0),
        ]))
        into = lg.seek(0.7)                                # damper still down there
        self.assertTrue(any((m[0] & 0xF0) == 0xB0 and m[1] == 64 and m[2] == 127 for m in into))
        self.assertIn(0, lg.sustain)
        past = lg.seek(1.2)                                # damper is up there
        self.assertNotIn(0, lg.sustain)
        self.assertFalse(any((m[0] & 0xF0) == 0xB0 and m[1] == 64 and m[2] >= 64 for m in past))

    def test_seek_releases_and_chases(self):
        lg = self.logic(build_smf([
            (0, 0xC0, 12), (0, 0xB0, 7, 55), (0, 0xB0, 123, 0), (0, 0xE0, 0, 96),
            (0, 0x90, 60, 90), (480, 0xB0, 7, 99), (0, 0x80, 60, 0),
            (480, 0x90, 62, 90), (480, 0x80, 62, 0),
        ]))
        lg.advance(0.1)                                    # C4 sounding
        out = lg.seek(0.7)
        self.assertEqual(out[16], bytes((0x80, 60, 0)))    # held released (after the CC64 sweep)
        self.assertIn(bytes((0xC0, 12)), out)              # program restored
        self.assertIn(bytes((0xB0, 7, 99)), out)           # latest CC7 wins
        self.assertIn(bytes((0xE0, 0, 96)), out)           # bend restored
        # the file's own CC123 is channel-mode: not chased (only release's sweep)
        self.assertEqual(sum(1 for m in out if (m[0] & 0xF0) == 0xB0 and m[1] == 123), 16)
        ons = [m for m in lg.advance(10) if (m[0] & 0xF0) == 0x90 and m[2]]
        self.assertEqual([m[1] for m in ons], [62])        # resumes after the seek point

    def test_seek_back_replays_from_the_top(self):
        lg = self.logic()
        lg.advance(10)
        lg.seek(0.0)
        out = lg.advance(10)
        self.assertEqual(sum(1 for m in out if (m[0] & 0xF0) == 0x90 and len(m) > 2 and m[2]), 3)


class TestAsyncPlayer(unittest.TestCase):
    """The real asyncio player against a stub port: files play, boundaries
    release notes, live seek/params work through the public methods the HTTP
    routes call."""

    def run_async(self, coro):
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()

    def make_link(self, tmp, data):
        link = lb.MidiLink(None, None)
        link.midi_dir = lambda: tmp                       # keep the test inside tmp
        sent = []
        link.send = lambda m: (sent.append(bytes(m)), True)[1]
        with open(os.path.join(tmp, "t.mid"), "wb") as f:
            f.write(data)
        return link, sent

    def test_plays_to_the_end_and_releases(self):
        async def go():
            with tempfile.TemporaryDirectory() as tmp:
                link, sent = self.make_link(tmp, SIMPLE)
                ok, msg = await link.play("t.mid", loop=False, params={"speed": 4.0})
                self.assertTrue(ok, msg)
                self.assertTrue(link.status()["playing"])
                self.assertEqual(link.status()["speed"], 4.0)
                await asyncio.wait_for(link.player, timeout=5)
                self.assertFalse(link.status()["playing"])
                ons = [m for m in sent if (m[0] & 0xF0) == 0x90 and len(m) > 2 and m[2]]
                self.assertEqual(len(ons), 3)
                # every note ends: explicit offs plus the all-notes-off sweep
                self.assertTrue(any((m[0] & 0xF0) == 0xB0 and m[1] == 123 for m in sent))
        self.run_async(go())

    def test_play_validates_against_the_real_length_without_stopping(self):
        async def go():
            with tempfile.TemporaryDirectory() as tmp:
                link, _ = self.make_link(tmp, SIMPLE)          # SIMPLE is 1.5 s long
                ok, msg = await link.play("t.mid", loop=True, params={"speed": 0.5})
                self.assertTrue(ok, msg)
                # a refused play — b beyond the file — must leave the current
                # playback running (no silent stop, no empty A/B cycles later)
                for bad in ({"a": 0.0, "b": 99.0},             # beyond the file
                            {"position_s": 99.0},
                            {"speed": float("inf")},
                            {"transpose": 1.5}):
                    ok, msg = await link.play("t.mid", loop=False, params=bad)
                    self.assertFalse(ok, str(bad))
                    st = link.status()
                    self.assertTrue(st["playing"], "still playing after refusing %s" % (bad,))
                    self.assertTrue(st["loop"])
                    self.assertEqual(st["speed"], 0.5, "old parameters untouched")
                # a good in-range A/B on the same call works
                ok, msg = await link.play("t.mid", loop=False, params={"a": 0.2, "b": 1.0})
                self.assertTrue(ok, msg)
                self.assertEqual((link.status()["a"], link.status()["b"]), (0.2, 1.0))
                await link.stop()
        self.run_async(go())

    def test_bad_names_and_files_refused(self):
        async def go():
            with tempfile.TemporaryDirectory() as tmp:
                link, _ = self.make_link(tmp, SIMPLE)
                for name in ("", "../t.mid", ".hidden.mid", "sub/t.mid"):
                    ok, _msg = await link.play(name)
                    self.assertFalse(ok, name)
                with open(os.path.join(tmp, "bad.mid"), "wb") as f:
                    f.write(b"garbage")
                ok, msg = await link.play("bad.mid")
                self.assertFalse(ok)
                self.assertIn("bad.mid", msg)
        self.run_async(go())

    def test_ab_repeat_wraps_with_note_offs(self):
        async def go():
            with tempfile.TemporaryDirectory() as tmp:
                # a single long note: only the A/B boundary can end it
                link, sent = self.make_link(tmp, build_smf([(0, 0x90, 60, 90), (1920, 0x80, 60, 0)]))
                ok, msg = await link.play("t.mid", loop=False,
                                          params={"speed": 4.0, "a": 0.0, "b": 0.3})
                self.assertTrue(ok, msg)
                await asyncio.sleep(0.5)                  # ≥ several wraps at 4x
                await link.stop()
                ons = [m for m in sent if m[:1] == b"\x90" and m[2]]
                offs = [m for m in sent if m[:1] == b"\x80"]
                self.assertGreaterEqual(len(ons), 2)      # it wrapped and re-struck
                self.assertGreaterEqual(len(offs), len(ons) - 1)   # each wrap released first
                st = link.status()
                self.assertEqual((st["a"], st["b"]), (0.0, 0.3))
        self.run_async(go())

    def test_seek_and_live_params(self):
        async def go():
            with tempfile.TemporaryDirectory() as tmp:
                link, sent = self.make_link(tmp, SIMPLE)
                ok, msg = await link.play("t.mid", loop=True, params={"speed": 0.5})
                self.assertTrue(ok, msg)
                await asyncio.sleep(0.05)
                ok, msg = link.seek(1.0)                  # jump over the C4 entirely
                self.assertTrue(ok, msg)
                self.assertAlmostEqual(link.status()["position_s"], 1.0, delta=0.2)
                link.set_params({"speed": 4.0, "mute": [1], "transpose": 5})
                st = link.status()
                self.assertEqual(st["speed"], 4.0)
                self.assertEqual(st["mute"], [1])
                self.assertEqual(st["transpose"], 5)
                await asyncio.sleep(0.3)
                await link.stop()
                self.assertFalse(link.status()["playing"])
                ok, msg = link.seek(0.5)                  # seeking a stopped player refuses
                self.assertFalse(ok)
        self.run_async(go())

    def test_position_tracks_source_time_across_speed_changes(self):
        async def go():
            with tempfile.TemporaryDirectory() as tmp:
                link, _ = self.make_link(tmp, build_smf([(0, 0x90, 60, 90), (4 * 480, 0x80, 60, 0)]))
                ok, msg = await link.play("t.mid", loop=False, params={"speed": 2.0})
                self.assertTrue(ok, msg)
                await asyncio.sleep(0.2)                  # ~0.4 s of source time at 2x
                p1 = link.status()["position_s"]
                self.assertAlmostEqual(p1, 0.4, delta=0.15)
                link.set_params({"speed": 0.5})
                await asyncio.sleep(0.2)                  # ~0.1 s more
                p2 = link.status()["position_s"]
                self.assertAlmostEqual(p2 - p1, 0.1, delta=0.1)
                self.assertGreater(p2, p1)                # never jumps backwards on a change
                await link.stop()
        self.run_async(go())


if __name__ == "__main__":
    unittest.main()
