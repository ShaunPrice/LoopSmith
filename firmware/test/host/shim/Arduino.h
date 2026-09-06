// Host-test shim standing in for the Teensy core's Arduino.h — just enough
// for AudioEffectLooper to compile unchanged on the host (see run.sh).
#pragma once

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define constrain(v, lo, hi) ((v) < (lo) ? (lo) : ((v) > (hi) ? (hi) : (v)))
