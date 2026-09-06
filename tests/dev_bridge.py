#!/usr/bin/env python3
"""A development bridge for UI smoke tests that can NEVER touch real hardware
or the user's files:

- find_pedal / find_midi_device are overridden to return None, so
  auto-detection cannot attach a real Teensy even though --port/--midi are
  unset (passing a nonexistent path alone would NOT stop auto-detection).
- MidiLink.midi_dir is pinned to a fresh temp directory seeded with two of
  the repo's example files, so nothing reads or writes ~/looper/midi and
  HOME is left alone.

    python3 tests/dev_bridge.py            # serves on 127.0.0.1:8093
    GLS_HTTP=127.0.0.1:9000 python3 tests/dev_bridge.py
"""
import importlib.util
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("looper_bridge", os.path.join(HERE, "..", "pi", "looper_bridge.py"))
lb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lb)

tmp = tempfile.mkdtemp(prefix="gls-smoke-midi-")
for n in ("01-click-100bpm.mid", "09-band-8bars.mid"):
    shutil.copy(os.path.join(HERE, "..", "midi", n), tmp)

lb.find_pedal = lambda explicit=None: None
lb.find_midi_device = lambda explicit=None: None
lb.MidiLink.midi_dir = lambda self: tmp

sys.argv = [sys.argv[0], "--http", os.environ.get("GLS_HTTP", "127.0.0.1:8093"), "--storage", tmp]
print("dev bridge: MIDI dir", tmp, "(hardware detection disabled)", flush=True)
lb.main()
