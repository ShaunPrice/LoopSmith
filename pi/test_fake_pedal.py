#!/usr/bin/env python3
"""Unit tests for fake_pedal.py — the protocol double the Studio editor and the
bridge are developed against. Focus: the 2.2.2 diagnostics extensions (patch
rev, test tone with auto-stop, MIDI evidence counters) plus regressions on the
framed transfers they ride along with.

    python3 pi/test_fake_pedal.py -v
"""
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_pedal import FW, FakePedal, TONE_MS_MIN  # noqa: E402

PRESET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sdcard", "presets")


class Out:
    """Collects everything the pedal writes; splits machine lines on demand."""

    def __init__(self):
        self.data = bytearray()

    def __call__(self, b):
        self.data += b

    def lines(self):
        return self.data.decode(errors="replace").splitlines()

    def clear(self):
        self.data = bytearray()


def mk():
    return FakePedal(PRESET_DIR), Out()


def status(pedal):
    return json.loads(pedal.status_json())


def send(pedal, out, line):
    pedal.feed((line + "\n").encode(), out)


class TestIdentity(unittest.TestCase):
    def test_ping_reports_new_firmware(self):
        pedal, out = mk()
        send(pedal, out, "ping")
        self.assertEqual(FW, "2.2.2")
        pong = json.loads(out.lines()[0].split(" ", 1)[1])
        self.assertEqual(pong["fw"], FW)
        self.assertEqual(pong["proto"], 1)

    def test_status_carries_diagnostics_fields(self):
        pedal, _ = mk()
        st = status(pedal)
        self.assertIsInstance(st["rev"], int)
        self.assertIsInstance(st["tone"], bool)
        self.assertEqual(sorted(st["midi"].keys()), ["rx", "trig", "voices"])
        self.assertEqual(st["source"], "line")
        # the boot-time preset load counts as revision 1, like the firmware
        self.assertEqual(st["rev"], 1)


class TestRevision(unittest.TestCase):
    def test_load_bumps_rev_and_acks_it(self):
        pedal, out = mk()
        send(pedal, out, "load 02_ambient.txt")
        line = out.lines()[0]
        self.assertTrue(line.startswith("#OK load 02_ambient.txt rev="), line)
        self.assertEqual(int(line.rsplit("rev=", 1)[1]), status(pedal)["rev"])
        self.assertEqual(status(pedal)["rev"], 2)

    def test_next_prev_bump_rev(self):
        pedal, out = mk()
        send(pedal, out, "next")
        send(pedal, out, "prev")
        self.assertEqual(status(pedal)["rev"], 3)
        for line in out.lines():
            self.assertIn("rev=", line)

    def test_load_failure_keeps_rev(self):
        pedal, out = mk()
        send(pedal, out, "load no_such.txt")
        self.assertEqual(out.lines()[0], "#ERR no such preset")
        self.assertEqual(status(pedal)["rev"], 1)

    def test_apply_success_bumps_rev(self):
        pedal, out = mk()
        payload = b"// name: Live\nosc.midi(1, lead)\nAudioConnection c1(fxin, 0, fxout, 0);\n"
        send(pedal, out, "apply %d" % len(payload))
        self.assertEqual(out.lines()[0], "#SEND")
        out.clear()
        pedal.feed(payload, out)
        self.assertEqual(out.lines()[0], "#OK apply rev=2")
        st = status(pedal)
        self.assertEqual(st["rev"], 2)
        self.assertEqual(st["preset"]["index"], -1)      # live patch, not a stored preset
        self.assertEqual(st["midi"]["voices"], 1)        # .midi() binding in the applied text

    def test_apply_bad_length_is_refused_without_rev_bump(self):
        pedal, out = mk()
        send(pedal, out, "apply 0")
        self.assertEqual(out.lines()[0], "#ERR bad length")
        send(pedal, out, "apply notanumber")
        self.assertEqual(status(pedal)["rev"], 1)

    def test_external_change_after_apply_clears_live_patch(self):
        pedal, out = mk()
        payload = b"osc.midi(1, lead)\n"
        send(pedal, out, "apply %d" % len(payload))
        pedal.feed(payload, out)
        self.assertEqual(status(pedal)["midi"]["voices"], 1)
        out.clear()
        send(pedal, out, "next")                          # like a footswitch press
        st = status(pedal)
        self.assertEqual(st["rev"], 3)
        self.assertGreaterEqual(st["preset"]["index"], 0)


class TestTone(unittest.TestCase):
    def test_tone_starts_and_expires_by_itself(self):
        pedal, out = mk()
        send(pedal, out, "tone 100")
        self.assertEqual(out.lines()[0], "#OK tone 100")
        self.assertTrue(status(pedal)["tone"])
        out.clear()
        pedal.tick(out)                                   # announces the start
        self.assertIn('#EVT {"tone":true}', out.lines())
        time.sleep(0.15)
        out.clear()
        pedal.tick(out)                                   # auto-stop announced
        self.assertIn('#EVT {"tone":false}', out.lines())
        self.assertFalse(status(pedal)["tone"])

    def test_tone_off_stops_early(self):
        pedal, out = mk()
        send(pedal, out, "tone 5000")
        self.assertTrue(status(pedal)["tone"])
        out.clear()
        send(pedal, out, "tone off")
        self.assertEqual(out.lines()[0], "#OK tone off")
        self.assertFalse(status(pedal)["tone"])

    def test_tone_clamps_and_rejects_garbage(self):
        pedal, out = mk()
        send(pedal, out, "tone 1")                        # below the minimum
        self.assertEqual(out.lines()[0], "#OK tone %d" % TONE_MS_MIN)
        out.clear()
        send(pedal, out, "tone banana")
        self.assertTrue(out.lines()[0].startswith("#ERR"))
        out.clear()
        send(pedal, out, "tone")                          # bare = default duration
        self.assertEqual(out.lines()[0], "#OK tone 1000")

    def test_old_editor_sees_unknown_command_shape(self):
        # what an editor talking to OLD firmware sees — the honest-unsupported path
        pedal, out = mk()
        send(pedal, out, "definitely_not_a_command")
        self.assertEqual(out.lines()[0], "#ERR unknown command")


class TestMidiEvidence(unittest.TestCase):
    def test_note_counts_rx_and_triggers_only_with_voices(self):
        pedal, out = mk()
        send(pedal, out, "load 08_drumkit.txt")           # has .midi() bindings
        self.assertGreater(status(pedal)["midi"]["voices"], 0)
        base = status(pedal)["midi"]
        send(pedal, out, "note on 36 100")
        send(pedal, out, "note off 36")
        st = status(pedal)["midi"]
        self.assertEqual(st["rx"], base["rx"] + 2)
        self.assertEqual(st["trig"], base["trig"] + 1)    # only the note-on fires a voice

    def test_no_voices_means_no_trigger_claim(self):
        pedal, out = mk()
        send(pedal, out, "load 01_clean.txt")             # no instruments at all
        self.assertEqual(status(pedal)["midi"]["voices"], 0)
        send(pedal, out, "note on 60 100")
        st = status(pedal)["midi"]
        self.assertEqual(st["rx"], 1)
        self.assertEqual(st["trig"], 0)                   # received, but nothing sounded

    def test_bad_note_counts_nothing(self):
        pedal, out = mk()
        send(pedal, out, "note sideways")
        self.assertTrue(out.lines()[0].startswith("#ERR"))
        self.assertEqual(status(pedal)["midi"]["rx"], 0)


class TestFramingRegression(unittest.TestCase):
    def test_put_then_get_roundtrip(self):
        pedal, out = mk()
        body = b"// name: RT\nAudioConnection c1(fxin, 0, fxout, 0);\n"
        send(pedal, out, "put zz_rt.txt %d" % len(body))
        pedal.feed(body, out)
        self.assertIn("#OK put", out.lines())
        out.clear()
        send(pedal, out, "get zz_rt.txt")
        raw = bytes(out.data)
        head, rest = raw.split(b"\n", 1)
        self.assertEqual(head.decode(), "#FILE zz_rt.txt %d" % len(body))
        self.assertEqual(rest[: len(body)], body)
        self.assertTrue(rest[len(body):].startswith(b"\n#END\n"))

    def test_transfer_timeout_recovers(self):
        pedal, out = mk()
        send(pedal, out, "put zz_x.txt 100")
        self.assertEqual(out.lines()[0], "#SEND")
        pedal.last_rx = time.time() - 6                   # pretend the host went quiet
        out.clear()
        pedal.tick(out)
        self.assertIn("#ERR timeout", out.lines())
        out.clear()
        send(pedal, out, "ping")                          # back in line mode
        self.assertTrue(out.lines()[0].startswith("#PONG"))


if __name__ == "__main__":
    unittest.main()
