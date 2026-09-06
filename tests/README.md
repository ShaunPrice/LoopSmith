# Tests

Three suites, no dependencies beyond Node ≥ 22 and Python 3.9+.

## Editor engine — `node --test tests/editor_core.test.mjs`

Loads the whole of `editor/index.html`'s script in a Node `vm` (its DOM work
is behind `typeof window !== 'undefined'`) and exercises the pure pieces:

- **Player core** (`createPlayerCore`): event order, mute (with immediate
  release of held notes), solo, transpose with channel-10 exclusion, notes
  transposed off the keyboard dropped on *and* off, note-offs matching the
  pitch that actually sounded across a live transpose change, `release()`
  covering held notes plus the all-notes-off sweep, and seeks that release
  then chase program/CC/pitch-bend state (channel-mode CCs excluded).
- **Click-to-seek maths**: `scoreSecAt` is the inverse of `scoreTickAt`
  through a tempo change.
- **Song sessions** (`sessionValidate` et al.): a good package decodes fully;
  custom PatchScript survives verbatim and chain presets regenerate with
  `chain-meta:`; refusals for wrong format, newer version, corrupt base64,
  non-SMF bytes, torn WAVs, bad preset modes, out-of-range playback values,
  A-without-B, hostile switch-action names, unknown layout regions and
  path-escaping names; per-file and per-category size limits; the
  missing-asset warning; validation never mutates its input; base64
  round-trip; `dedupeName` renames instead of overwriting.

## Bridge player — `python3 tests/test_bridge_player.py`

Imports `pi/looper_bridge.py` directly:

- `SmfFile` parsing and tempo-map timing; garbage refused.
- `validate_midi_params`: bounds for speed/transpose/mute/solo, A/B pairing
  and range, `position_s`, partial requests, refusal messages.
- `MidiPlayerLogic`: the same battery as the JS core (the two are mirrored).
- The real asyncio player with a stubbed port: plays a file to the end and
  releases everything; refuses traversal names and non-SMF files; A/B repeat
  wraps with note-offs at every boundary; live seek and parameter changes
  through the methods the HTTP routes call; `position_s` stays continuous in
  source time across speed changes.

## UI smoke — `node tests/ui_smoke.mjs` (optional, needs Chrome)

Drives the real editor in headless Chrome against a real (pedal-less) bridge
over the Chrome DevTools protocol. Setup is in the file's header comment.
Checks in the live DOM: the new Score controls exist; per-part M/S buttons
render and clicking M mutes on the bridge; the speed select flows through
`/api/midi/params`; click-to-seek starts bridge playback at the clicked spot
with the current controls; live transpose lands while playing; the piano-roll
toggle redraws; the Song panel's export modal lists content; a built session
validates, opens, and applying adds the preset and uploads the clashing MIDI
file under a deduped name; a corrupt session is refused whole with nothing
changed.

## Evidence (2026-09-06, macOS, Node 25.8, Python 3.9, Chrome 152 headless)

- `node --test tests/editor_core.test.mjs` — **21/21 pass**.
- `python3 tests/test_bridge_player.py` — **22/22 pass**.
- `node tests/ui_smoke.mjs` — **20/20 checks pass**, including live
  `/api/midi/play` with parameters, `/api/midi/seek` (position confirmed at
  3.0 s), `/api/midi/params` (speed 1.5, mute [10], transpose 5 all echoed in
  status), and a full export → validate → import → apply round trip.
- Manual curl against the running bridge: play with
  `{speed:1.5, transpose:2, mute:[2], a:1, b:4}` accepted; `speed:9` refused
  with a message; live change to 0.5× then `position_s` advanced ~0.5 s of
  source time per wall second.

## Not tested here (hardware)

- Real Teensy USB-MIDI output: ALSA rawmidi write timing/backpressure on the
  Pi, and how the pedal's synth reacts to the chase messages (program/CC
  replay) and the all-notes-off sweeps.
- Pi 3 CPU headroom with the kiosk browser rendering the score while the
  bridge plays at 2× or higher speed (the player sleeps in ≤50 ms slices; the
  logic is O(events) per wake, but only hardware shows the real margins).
- Web MIDI against a physical pedal from Chrome/Edge (the local player is
  exercised only through its pure core here).
- `loop put` of session loops over a real serial link, and footswitch rows
  applied to real firmware (`switch …` commands are sent verbatim; the
  pedal's own validation is the authority).
- Very large scores' piano-roll rendering performance on the Pi's browser.
