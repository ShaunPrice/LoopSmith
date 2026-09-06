#!/bin/sh
# Build and run the host-side timing tests. LooperTiming and MidiClockIn are
# portable C++, so the exact code the audio ISR runs is tested here with a
# deterministic fake clock — no hardware, no PlatformIO needed.
set -e
cd "$(dirname "$0")"
CXX="${CXX:-c++}"
"$CXX" -std=c++17 -Wall -Wextra -O1 -o test_timing test_timing.cpp
./test_timing
