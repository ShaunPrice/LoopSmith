# Example MIDI files

Ten short files for testing the pedal and for building loops with. They are made to be
**looped**: each is a whole number of bars and ends with an all-notes-off exactly on the bar
line, so the player's *loop* option repeats them seamlessly.

They address the channels the band presets bind — **1** rhythm, **2** lead, **3** bass,
**10** drums — so `10_song.txt` plays all four parts and `09_band.txt` plays the strings and kit.

| File | Length | Plays | Good for |
|---|---|---|---|
| `01-click-100bpm.mid` | 4 bars | drums | a click to set a loop length by ear |
| `02-rock-100bpm.mid` | 4 bars | drums | a straight beat with a fill into the loop point |
| `03-funk-96bpm.mid` | 2 bars | drums | a tight syncopated pattern to play over |
| `04-shuffle-88bpm.mid` | 4 bars | drums | a lazy shuffle under a slow lead |
| `05-percussion-104bpm.mid` | 4 bars | drums | congas, rim and shaker — for the **Percussion** kit |
| `06-bass-Em-C-G-D.mid` | 4 bars | bass | a root bass line through the progression |
| `07-chords-Em-C-G-D.mid` | 4 bars | rhythm | strummed chords to solo over |
| `08-lead-Em-pentatonic.mid` | 4 bars | lead | a pentatonic line to accompany |
| `09-band-8bars.mid` | 8 bars | all four | the end-to-end test: the whole band |
| `10-drum-map.mid` | 13 beats | drums | every note the three kits answer, one per beat |

## Using them

**On the pedal computer.** Studio's **MIDI** panel lists what is on the Pi; press ▶ to play a
file into the pedal, and tick *loop* to have it repeat. The Pi plays it, so it keeps going if
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
