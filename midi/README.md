# Example MIDI files

Ten short files for testing the pedal and for building loops with. They are made to be
**looped**: each is a whole number of bars and ends with an all-notes-off exactly on the bar
line, so the player's *loop* option repeats them seamlessly.

They address the channels the band presets bind — **1** rhythm, **2** lead, **3** bass,
**10** drums — so `10_song.txt` plays all four parts and `09_band.txt` plays the strings and kit.

| File | Length | Plays on | Needs a preset with | Good for |
|---|---|---|---|---|
| `01-click-100bpm.mid` | 4 bars | ch 10 | any kit | a click to set a loop length by ear |
| `02-rock-100bpm.mid` | 4 bars | ch 10 | any kit | a straight beat with a fill into the loop point |
| `03-funk-96bpm.mid` | 2 bars | ch 10 | any kit | a tight syncopated pattern to play over |
| `04-shuffle-88bpm.mid` | 4 bars | ch 10 | any kit | a lazy shuffle under a slow lead |
| `05-percussion-104bpm-perckit.mid` | 4 bars | ch 10 | **Percussion kit** | congas, rim and shaker |
| `06-bass-Em-C-G-D.mid` | 4 bars | ch 3 | a bass on channel 3 | a root bass line through the progression |
| `07-chords-Em-C-G-D.mid` | 4 bars | ch 1 | a pitched instrument on channel 1 | strummed chords to solo over |
| `08-lead-Em-pentatonic.mid` | 4 bars | ch 2 | a pitched instrument on channel 2 | a pentatonic line to accompany |
| `09-band-8bars.mid` | 8 bars | ch 1, 2, 3, 10 | all four — use `10_song.txt` | the end-to-end test: the whole band |
| `10-drum-map-808kit.mid` | 13 beats | ch 10 | **808 kit** | every note the kits answer, one per beat |

### Which preset to load first

**This is the step everyone misses: MIDI only makes a sound if the loaded preset has an
instrument bound to that channel.** A chain of effects with no instruments is silent no matter
what you send it.

| Preset | Answers | Plays |
|---|---|---|
| `10_song.txt` | channels 1, 2, 3 and 10 | **everything except the two kit-specific files** |
| `09_band.txt` | channels 1 and 10 | the drum files, chords and the lead |
| `08_drumkit.txt` | channel 10 | the drum files |
| `07_pluck.txt` | channel 1 | the chord file |

The drum patterns use only the three notes every kit answers — **36 kick, 38 snare, 42 closed
hat** — so they play through any kit. The two files whose names say `perckit` and `808kit` use
the wider General MIDI map and need those instruments added in Studio.

## Using them

**On the pedal computer.** Load a preset with instruments first (see above), then use Studio's
**MIDI** panel: it lists what is on the Pi; press ▶ to play a file into the pedal, and tick *loop*
to have it repeat. The Pi plays it, so it keeps going if
your phone's screen sleeps.

**To build a loop.** Load a band preset, start the file looping, tap **LOOP** on the first beat
to record a pass, tap again on the bar line to close it — then play guitar over the top. The
capture in `demo/loop_from_midi.mp3` was made exactly this way (`09-band-8bars.mid` into
`10_song.txt`, recorded in the pedal's looper and downloaded with `loop get`).

**Over USB, with no Pi.** Press *Web MIDI* in the MIDI panel (Chrome or Edge), upload a file
there and press ▶ — the browser plays it straight into the pedal's USB MIDI port.

## Rebuilding them

`python3 midi/make_examples.py` rewrites every file in this folder. The generator has no
dependencies; edit the patterns at the bottom to make your own.
