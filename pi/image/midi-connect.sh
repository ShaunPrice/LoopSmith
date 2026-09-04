#!/bin/sh
# Route every MIDI controller plugged into the Pi to the pedal (ALSA sequencer). Run by udev
# when a MIDI device appears, and once at boot. Idempotent: aconnect refuses duplicates.
sleep 1
PEDAL=$(aconnect -l 2>/dev/null | awk '/^client [0-9]+: .*(Teensy|MIDI\/Audio|MIDIAudio)/ {sub(":","",$2); print $2; exit}')
[ -n "$PEDAL" ] || exit 0
aconnect -l 2>/dev/null | awk '/^client [0-9]+:/ {sub(":","",$2); print $2" "$0}' | while read -r id line; do
  case "$line" in *System*|*"Midi Through"*|*Teensy*|*"MIDI/Audio"*|*MIDIAudio*) continue;; esac
  aconnect "$id:0" "$PEDAL:0" 2>/dev/null && logger -t looper-midi "connected MIDI client $id to the pedal"
done
exit 0
