# PatchScript — the LoopSmith preset format

PatchScript is the text format for effect presets, read from `/presets/*.txt` on the SD card
(mirrored to the audio shield's W25Q32 flash so the pedal works without a card).

It is deliberately a **subset of the code exported by the
[Teensy Audio System Design Tool](https://www.pjrc.com/teensy/gui/)** plus plain C++-style
setter calls — so you can design a patch in the design tool, export it, paste it into a
preset file, add parameter lines, and it just works. No compiler involved: the firmware
parses these files at runtime and builds the audio graph dynamically.

## Example

```cpp
// name: Ambient Swell
AudioEffectChorus    chorus1;
AudioEffectFreeverb  verb1;
AudioMixer4          mix1;

AudioConnection c1(fxin, 0, chorus1, 0);
AudioConnection c2(chorus1, 0, mix1, 1);     // dry tap
AudioConnection c3(chorus1, 0, verb1, 0);
AudioConnection c4(verb1, 0, mix1, 0);       // wet tap
AudioConnection c5(mix1, 0, fxout, 0);

chorus1.begin(3);          // 3 voices (delay line is allocated for you)
verb1.roomsize(0.78);
verb1.damping(0.35);
mix1.gain(0, 0.6);         // wet level
mix1.gain(1, 0.8);         // dry level
```

## Grammar

One statement per line. `//` starts a comment (trailing `//xy=...` from the design tool is
ignored). Lines starting with `#` (the `#include` preamble of a raw design-tool export) are
ignored too. Blank lines are ignored. CRLF and LF both accepted. Files are limited to 16 KB,
and preset filenames must not contain spaces.

| Statement | Form |
|---|---|
| Metadata | `// name: <display name>` (optional, anywhere; first wins) |
| Editor metadata | `// chain-meta: <json>` (optional; written by the Studio editor for perfect round-tripping — ignored by the firmware) |
| Declaration | `<TypeName> <identifier>;` |
| Connection | `AudioConnection <id>(<src>, <srcPort>, <dst>, <dstPort>);` or `AudioConnection <id>(<src>, <dst>);` (ports 0,0) |
| Setter | `<identifier>.<method>(<args...>);` — args are numbers or named tokens |

## Reserved endpoints

The firmware owns the I/O skeleton (codec, looper, mixers). A preset only defines the
**effect insert** between two reserved nodes:

- **`fxin`** — chain input (mono guitar signal, post input gain). Source port 0, fan-out allowed.
- **`fxout`** — chain output. It is a 4-input mixer: feed inputs `0..3`, they are summed.

**Design-tool compatibility:** if a preset declares any `AudioInput*` object its name becomes
an alias for `fxin`, and any `AudioOutput*` name becomes an alias for `fxout` (destination
port is kept, clamped to 0–3). `AudioControl*` declarations (e.g. `AudioControlSGTL5000`)
are ignored with a warning — the firmware owns the codec. This means a raw design-tool
export usually loads unmodified.

## Rules

- Declarations may appear in any order; connections and setters may reference any declared name.
- Setters are applied **in file order**, after all connections are made.
- Feedback loops are allowed (the audio library gives them one block of inherent delay) —
  this is how you build echo/feedback delays.
- Only one connection may drive a given input port. Use an `AudioMixer4` to sum.
- Unknown **type** → the preset is rejected with an error naming the line.
- Unknown **method** or bad argument count → warning (the line is skipped, the preset still loads).
- Limits: 48 dynamic objects, 96 connections per preset (firmware 2.2.0; earlier builds allowed 24/48).

## Supported types and methods

The full machine-readable registry (types, methods, argument ranges, defaults) is in
[`effects-schema.json`](effects-schema.json) — it is the single source of truth shared by the
firmware and the Studio editor. Highlights:

- **Convenience allocation:** `AudioEffectChorus::begin(voices)`,
  `AudioEffectFlange::begin(offset, depth, rate)` and `AudioEffectGranular::begin(ms)`
  take care of delay-line memory — you never pass buffers.
- **`AudioEffectWaveshaper::drive(x)`** (1–10) builds a smooth tanh drive curve for you.
- Named tokens are accepted where the Audio library uses constants:
  `WAVEFORM_SINE`, `WAVEFORM_TRIANGLE`, … and `OR`, `XOR`, `AND`, `MODULO` for
  `AudioEffectDigitalCombine::setCombineMode`.

## Instruments: `midi()` voice binding

Any sound source can become a playable instrument — from a MIDI controller, from the
Studio dashboard's keyboard/pads, or from a footswitch — by binding it:

```cpp
// name: Pluck + Guitar
AudioSynthKarplusStrong pluck1;
AudioSynthKarplusStrong pluck2;            // two objects = two-voice polyphony
AudioMixer4             src1;
AudioConnection c1(fxin, 0, src1, 0);      // guitar
AudioConnection c2(pluck1, 0, src1, 1);
AudioConnection c3(pluck2, 0, src1, 2);
AudioConnection c4(src1, 0, fxout, 0);
pluck1.midi(1, v1);                        // channel 1, voice group v1
pluck2.midi(1, v2);
```

`obj.midi(channel, group[, note])` — `channel` 1–16 or 0 for omni; `group` is an identifier;
every object in the same group is triggered together (an `AudioSynthWaveform` plus its
`AudioEffectEnvelope`, say); `note` restricts the group to one MIDI note (drum pads on
channel 10). What a Note On does depends on the object:

| type | Note On | Note Off |
|---|---|---|
| `AudioSynthKarplusStrong` | `noteOn(freq, velocity)` | — (rings out) |
| `AudioSynthSimpleDrum` | `noteOn()` | — |
| `AudioSynthWaveform*` / `AudioSynthWaveformPWM` | `frequency(freq)` (level untouched) | — |
| `AudioEffectEnvelope` | `noteOn()` | `noteOff()` |

Instruments mix with the guitar however the preset wires them — through the effects, straight
to `fxout`, or both. The looper records whatever reaches it, so instrument loops layer with
guitar loops.

## Where presets live

- SD card: `/presets/*.txt` — loaded in filename order (name them `01_clean.txt`, `02_...`).
- On boot, presets are mirrored to the audio shield's 4 MB W25Q32 flash (LittleFS). If no SD
  card is present the mirror is used instead.
- `/settings.txt` (SD root) holds global audio settings — see the README.


### Voice extensions

Alongside `obj.midi(channel, group[, note])`, four more editor-friendly setters shape how a
bound object answers a note. They are handled by the pedal, not by the audio object:

| Line | On | Effect |
|---|---|---|
| `obj.midiRatio(x)` | any voice member | the note's frequency is multiplied by *x* for this object: FM modulators (`3.5`), sub-octaves (`0.5`), organ harmonics (`2`, `3`), detune (`1.0052` ≈ 9 cents) |
| `obj.midiVelocity(s)` | oscillators | velocity sensitivity 0–1: `amplitude = base × (1 − s + s × velocity)`, where *base* is what the preset's own `amplitude()`/`begin()` set |
| `obj.sweep(amp, fromHz, toHz, ms)` | `AudioSynthToneSweep` | what every trigger plays; a note-allocated voice starts the sweep at the note's pitch instead of *fromHz* |
| `obj.file(name)` | `AudioPlaySdWav` | plays `/samples/<name>.wav` from the SD card on every trigger (16-bit 44.1 kHz WAV; a bare name, no path or extension) |

Two more types can be bound with `midi()`: an `AudioFilterStateVariable` whose cutoff then
tracks the note (`bp.midi(1, v1)`), and the two above. The pedal builds up to **48 objects and
96 connections** per preset.
