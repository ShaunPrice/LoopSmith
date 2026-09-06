# Musical (synchronised) looping

By default the looper is a classic manual pedal: tap LOOP and it records *right
now*, tap again and the loop closes *right there*. That behaviour is unchanged
and remains the default. Musical sync is an **opt-in** layer on top: a beat
grid, a metronome, count-in, quantised start/stop and fixed-length recording —
so a loop comes out exactly one, two or four bars long instead of "however
accurately you tapped".

All timing runs on the Teensy inside the audio engine — never in the browser or
over the network. The editor and serial protocol only *configure* it.

## Settings

Configure from the Studio editor (LOOPER panel → SYNC) or the serial console
(`sync …`, see [PROTOCOL.md](PROTOCOL.md)). Settings are session-only — they
reset to defaults at power-up.

| Setting | Values | What it does |
|---|---|---|
| `mode` | `off` (default) / `beat` / `bar` | Master switch. `off` = legacy manual looping. `beat`/`bar` = recording starts and stops on the next beat or bar boundary. |
| `source` | `internal` (default) / `midi` | Where the beat comes from: the configured BPM, or incoming USB MIDI clock (24 PPQN). |
| `bpm` | 30–300 | The internal tempo. |
| `countin` | 0–8 bars (default 1) | Metronome count-in before recording starts. 0 = start on the boundary with no count-in. |
| `bars` | 0–64 (default 0) | Fixed recording length. With e.g. `4`, the loop closes itself after exactly 4 bars. `0` = free: tap LOOP to close on the next boundary. |
| `met` | `off` / `rec` (default) / `on` | Metronome click: never, while recording, or whenever the grid is running. Count-ins always click — that is their job. |
| `metvol` | 0–1 (default ~0.6) | Click level. |

The meter is **4/4 only** in this first version (the engine underneath is
parameterised for other x/4 meters; they are not yet exposed).

## How a synced take works

1. Tap **LOOP** on an empty looper.
   - *Internal tempo:* your tap defines the downbeat. With a count-in, the
     metronome counts `countin` bars and recording starts dead on the following
     downbeat — the count-in duration is sample-exact. Without one, recording
     starts immediately (still grid-aligned, since the grid starts at your tap).
   - *MIDI clock:* the pedal waits for the next beat (`mode beat`) or bar line
     (`mode bar`) of the incoming clock. With a count-in it first aligns to a
     bar line, then counts `countin` bars.
   - The panel LEDs show it: slow red blink = armed and waiting, fast red
     blink = count-in running. The editor shows `armed` / `count-in`.
2. Recording runs. With `bars > 0` the loop closes itself after exactly that
   many bars. With `bars 0`, tap **LOOP** and it closes on the next beat/bar —
   the length always comes out a whole number of beats or bars.
3. The loop drops straight into playback, with its downbeat placed on the grid.

**Cancelling is always tap STOP** — while armed or counting in, STOP abandons
the take and the looper returns to empty. Nothing is recorded, nothing is
cleared. (STOP during recording keeps its legacy meaning: close immediately and
stop.) Overdubs are *not* quantised in this version — once a loop exists, the
loop itself is the timing reference, and overdub punch in/out stays manual.

Nothing about sync is ever destructive: arming never clears an existing loop
(the LOOP tap on a non-empty looper keeps its play/overdub meaning), a lost
clock never erases anything, and `clear` remains the only way to delete audio.

## MIDI clock (the pedal is a follower)

With `source midi` the pedal follows USB MIDI real-time messages from the
connected computer/DAW:

- **Start** resets the bar phase — the first clock tick after it is beat 1.
- **Continue** resumes the tick count where it stopped.
- **Stop** — and equally a clock that just vanishes (no tick for 0.5 s) —
  cancels an armed or counting-in take. A recording already in progress is
  *never* left hanging: it finishes its scheduled length on a flywheel at the
  last measured tempo, so a dying DAW can't make the pedal record forever.
- Tempo is measured from the tick spacing (smoothed over a few beats, clamped
  to 10–1000 BPM so one garbled tick can't fling it).
- If you tap LOOP with `source midi` but no clock running, the tap simply
  behaves manually (legacy) — it never waits forever for a clock that isn't
  there. The status line shows the clock state (`idle/running/stopped/lost`).

The pedal does **not send** MIDI clock. If you want the DAW and pedal in sync,
make the DAW the master and the pedal follows. Outgoing master clock was left
out deliberately: incoming sync covers the recording use case, and a
follower-only design avoids two half-good clocks fighting each other.

## Timing accuracy — honest numbers

- **Internal tempo:** count-in duration and fixed-bar loop lengths are
  **sample-exact** (a 4-bar loop at 120 BPM is exactly 352 800 samples).
  Recording starts and stops mid-audio-block at the precise sample, and the
  first playback pass begins in the same block the recording closes, so the
  loop's downbeat sits exactly on the grid.
- **MIDI clock:** beat boundaries are quantised to the start of the audio block
  in which they are processed, so external sync is accurate to about **one
  audio block (128 samples ≈ 2.9 ms) plus USB MIDI polling latency** (the main
  loop usually polls well under 1 ms, but SD/flash activity can stretch a
  poll). Expect roughly ±3 ms against the DAW's grid — tight enough to feel
  locked; not sample-locked. Tempo wobble from the DAW is smoothed over a few
  beats.
- MIDI **Song Position Pointer is not handled** — bar phase comes from Start
  and counted beats.

## The metronome's audio route

The click is synthesised inside the looper audio object (a short decaying
square burst: ~1.57 kHz on bar starts, ~1.05 kHz on other beats) and mixed into
the **looper's output** — it reaches the line out, headphones and USB audio
output through the normal output mixer, at the master volume, but:

- it does **not** pass through the effects chain, and
- it is **never recorded into the loop** (the loop records the input side).

The click only sounds while no loop audio is playing (empty/armed/count-in/
recording/stopped): once a loop plays, the loop itself carries the time, and a
competing click would fight it. `met on` is therefore mainly useful for playing
along before you arm, and while recording.

## Testing

The whole timing engine (`firmware/src/LooperTiming.h`) and the MIDI clock
follower (`firmware/src/MidiClockIn.h`) are portable C++ with no Arduino
dependencies. `firmware/test/host/run.sh` compiles the exact code the audio ISR
runs and drives it with a deterministic fake clock: boundary arming, exact
count-in and fixed-bar lengths, quantised stops, clock loss/Stop cancellation,
capacity clamping, legacy manual behaviour, and clock-follower tempo/timeout
handling.
