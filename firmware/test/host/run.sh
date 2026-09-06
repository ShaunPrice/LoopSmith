#!/bin/sh
# Build and run the host-side looper tests — no hardware, no PlatformIO.
#
#   test_timing  — LooperTiming + MidiClockIn (portable, compiled as-is) driven
#                  with a deterministic fake clock.
#   test_looper  — the real AudioEffectLooper.cpp compiled against the shims in
#                  shim/ (fake AudioStream block plumbing, malloc as EXTMEM),
#                  verifying actual recorded sample lengths and state changes.
set -e
cd "$(dirname "$0")"
CXX="${CXX:-c++}"
"$CXX" -std=c++17 -Wall -Wextra -O1 -o test_timing test_timing.cpp
"$CXX" -std=c++17 -Wall -Wextra -O1 -Ishim -I../../src -o test_looper test_looper.cpp ../../src/AudioEffectLooper.cpp
./test_timing
./test_looper
