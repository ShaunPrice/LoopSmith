#!/usr/bin/env bash
# Play a WAV (backing track, click, drone) INTO the pedal's output mix over USB audio.
# Usage: play.sh track.wav
set -euo pipefail
[[ $# -ge 1 ]] || { echo "usage: play.sh file.wav"; exit 1; }
# PLAY_CARD=x300 sends the file to the X300's line out (USB PnP Sound Device) instead of the pedal
if [[ "${PLAY_CARD:-}" == "x300" ]]; then exec aplay -D plughw:Device "$1"; fi
CARD="$(aplay -l 2>/dev/null | grep -i -m1 'teensy' | sed -E 's/^card ([0-9]+).*/\1/' || true)"
if [[ -z "$CARD" ]]; then echo "no Teensy USB audio device found (aplay -l)"; exit 1; fi
exec aplay -D "plughw:${CARD},0" "$1"
