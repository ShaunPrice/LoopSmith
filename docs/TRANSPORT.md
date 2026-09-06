# Performance transport

The header remains visible in every view. Play MIDI uses the selected score file
(or the first file if none is selected). During playback it becomes Stop MIDI,
which always stops the actual player even if another score file is selected.

Stop all stops MIDI and halts the recorded loop. Repeating it never restarts the
loop. The original looper Stop/restart switch retains its toggle behavior.

Panic / mute output mutes the Teensy's final output (USB and analogue), releases
bound envelopes and halts the looper without clearing its audio. Resume audio
restores output; any remaining effect tails or live input may be audible. Panic
requires the firmware in this PR and a serial/network pedal link; it does not
claim to mute hardware using Web MIDI alone. The mute is not saved across boots.

A pending request disables repeated clicks. Stop is confirmed with player status.
Errors and timeouts remain visible; a timeout does not claim the music stopped.
If disconnected, a local player can still stop, but device actions need reconnection.

New serial commands: `panic`, `resume`, and idempotent `looper halt`.
Status includes `output_muted`. Older firmware reports unsupported commands rather
than silently substituting the old stop/restart toggle.

Validation: Node transport command-gate tests; a host C++ test of the actual looper
engine (record/stop/repeat halt/overdub/queued tap); USB audio/MIDI and serial-only
PlatformIO builds. Browser view checks use a simulator, not real analogue audio.
