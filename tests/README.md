# Tests

Three suites, no dependencies beyond Node ≥ 22 and Python 3.9+.

## Editor engine — `node --test tests/editor_core.test.mjs`

Loads the whole of `editor/index.html`'s script in a Node `vm` (its DOM work
is behind `typeof window !== 'undefined'`) and exercises it at two levels:

- **Player core** (`createPlayerCore`): event order, mute (with immediate
  release of held notes), solo, transpose with channel-10 exclusion, notes
  transposed off the keyboard dropped on *and* off, note-offs matching the
  pitch that actually sounded across a live transpose change, `release()`
  lifting sustain (CC64) on every channel *before* the note-offs and the
  all-notes-off sweep, sustained notes silenced by stops and mutes, seeks
  that release then chase program/CC/pitch-bend state (sustain restored and
  tracked; channel-mode CCs excluded).
- **Click-to-seek maths**: `scoreSecAt` is the inverse of `scoreTickAt`
  through a tempo change.
- **Song session validation** (`sessionValidate` et al.): a good package
  decodes fully; custom PatchScript survives verbatim and chain presets
  regenerate with `chain-meta:`; refusals for wrong format, newer version,
  corrupt base64, non-SMF bytes, torn WAVs, bad preset modes, out-of-range /
  NaN / Infinity / boolean playback values, A-without-B, bad playback file
  names, hostile switch-action names, unknown layout regions and
  path-escaping names; per-file and per-category size limits; the
  missing-asset warning; validation never mutates its input; base64
  round-trip; `dedupeName` renames instead of overwriting.
- **`sessionApply` itself** (real store/midi/score state, DOM renderers
  stubbed): a clashing MIDI import is renamed AND playback selects the
  renamed imported copy — never the unrelated existing bytes; an unticked
  carried file is reported, not satisfied by an old same-named file, and A/B
  is not restored onto some other file; the documented missing-asset fallback
  still works; presets are added under fresh names; the pedal-preset option
  reports honestly when disconnected, applies live via `apply` without
  touching the SD card, and writes the card only with its explicit tick using
  the renamed workspace identity; `scoreCtlParams()` (the transport-bar hook)
  mirrors the control state.

## Bridge player — `python3 tests/test_bridge_player.py`

Imports `pi/looper_bridge.py` directly:

- `SmfFile` parsing and tempo-map timing; garbage refused.
- `validate_midi_params`: bounds for speed/transpose/mute/solo, A/B pairing
  and range, `position_s`, partial requests — plus NaN/Infinity, booleans
  (Python's `bool` is an `int`; `True` is not a channel or a speed) and
  fractional transposes refused, integral floats (`2.0`) accepted, matching
  the editor.
- `MidiPlayerLogic`: the same battery as the JS core, sustain included (the
  two are mirrored).
- The real asyncio player with a stubbed port (never a device: the tests
  override `midi_dir` per instance and `send` records into a list): plays a
  file to the end and releases everything; refuses traversal names and
  non-SMF files; **play validates its parameters against the actual file's
  length and a refused play leaves the current playback running**; A/B repeat
  wraps with note-offs at every boundary; live seek and parameter changes
  through the methods the HTTP routes call; `position_s` stays continuous in
  source time across speed changes.

## UI smoke — `node tests/ui_smoke.mjs` (optional, needs Chrome)

Drives the real editor in headless Chrome against a real pedal-less bridge
over the Chrome DevTools protocol. Run the bridge ONLY via
`python3 tests/dev_bridge.py`: it pins the MIDI folder to a fresh temp
directory and overrides `find_pedal`/`find_midi_device` to return `None`, so
it can never attach a real Teensy or touch `~/looper/midi` (passing a
nonexistent `--port`/`--midi` alone would NOT stop auto-detection). Checks in
the live DOM: the new Score controls exist; per-part M/S buttons render and
clicking M mutes on the bridge; the speed select flows through
`/api/midi/params`; click-to-seek starts bridge playback at the clicked spot
with the current controls; live transpose lands while playing; the piano-roll
toggle redraws; the Song panel's export modal lists content; a built session
validates, opens, and applying adds the preset and uploads the clashing MIDI
file under a deduped name; a corrupt session is refused whole with nothing
changed.

## Evidence (2026-09-06, macOS, Node 25.8, Python 3.9, Chrome 152 headless)

- `node --test tests/editor_core.test.mjs` — **31/31 pass**.
- `python3 tests/test_bridge_player.py` — **26/26 pass**.
- `node tests/ui_smoke.mjs` — **20/20 checks pass** (first landing of this
  work), including live `/api/midi/play` with parameters, `/api/midi/seek`
  (position confirmed at 3.0 s), `/api/midi/params` (speed 1.5, mute [10],
  transpose 5 all echoed in status), and a full export → validate → import →
  apply round trip. The smoke caught two real bugs that were then fixed and
  covered by unit tests (the byte-count/bytes confusion in `sessionBuild`,
  and A/B being cleared by the post-hoc file selection).
- Manual curl against a running bridge: play with
  `{speed:1.5, transpose:2, mute:[2], a:1, b:4}` accepted; `speed:9` refused
  with a message; live change to 0.5× then `position_s` advanced ~0.5 s of
  source time per wall second.

## Not tested here (hardware)

- Real Teensy USB-MIDI output: ALSA rawmidi write timing/backpressure on the
  Pi, and how the pedal's synth reacts to the chase messages (program/CC/
  sustain replay) and the all-notes-off sweeps.
- Pi 3 CPU headroom with the kiosk browser rendering the score while the
  bridge plays at 2× or higher speed (the player sleeps in ≤50 ms slices; the
  logic is O(events) per wake, but only hardware shows the real margins).
- Web MIDI against a physical pedal from Chrome/Edge (the local player is
  exercised only through its pure core here).
- `loop put` of session loops over a real serial link, and the session's
  pedal-preset `apply`/`put` on real firmware (the commands are sent through
  the same paths the Apply/Push buttons use; the pedal's own validation is
  the authority).
- Very large scores' piano-roll rendering performance on the Pi's browser.
