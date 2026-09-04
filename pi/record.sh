#!/usr/bin/env bash
# Record the pedal's output (Teensy USB audio) to the USB drive (/media/usb/loops) or ~/loops/<timestamp>.wav until Ctrl-C.
# Needs the firmware built with USB audio (the default env in firmware/platformio.ini).
set -euo pipefail
CARD="$(arecord -l 2>/dev/null | grep -i -m1 'teensy' | sed -E 's/^card ([0-9]+).*/\1/' || true)"
if [[ -z "$CARD" ]]; then echo "no Teensy USB audio device found (arecord -l)"; exit 1; fi
# recordings go to the USB drive's loop library when one is mounted, else ~/loops
LIB="$HOME/loops"; mountpoint -q /media/usb 2>/dev/null && LIB=/media/usb/loops
OUT="${1:-$LIB/$(date +%Y%m%d-%H%M%S).wav}"
mkdir -p "$(dirname "$OUT")"
echo "recording card $CARD -> $OUT  (Ctrl-C to stop)"
exec arecord -D "plughw:${CARD},0" -f S16_LE -r 44100 -c 2 "$OUT"
