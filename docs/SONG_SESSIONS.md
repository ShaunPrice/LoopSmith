# Song sessions

A **song session** is one shareable file that carries everything a song needs
to travel between workspaces, computers and pedals:

- the **MIDI files** themselves (bytes, base64 — no zip, plain JSON),
- the **preset(s)** exactly as they sit in the workspace — a custom-routing
  preset keeps its hand-written PatchScript verbatim, a chain preset keeps its
  chain and instruments (and regenerates with its `chain-meta:` line intact),
- optionally the **saved loops** from the pedal's SD card,
- the **playback preferences** of the Score panel — speed, transpose,
  mute/solo, the A/B repeat passage, loop on/off, piano-roll choice and which
  file is on show,
- the **footswitch assignments** (six rows of tap/hold/note),
- optionally the **panel layout**.

The front end is the **SONG SESSION** panel in Studio (`editor/index.html`):
**Export song…** and **Open song…**.

## Exporting

Export shows a checklist of what the file will carry. Everything is explicit:

- **Presets** — any of the workspace presets (the open one is pre-ticked).
- **MIDI files** — whatever the MIDI panel lists, on the Pi or in this browser.
  (A file uploaded to this browser before this feature existed has no stored
  bytes; re-upload it once to include it.)
- **Loops** — listed only while the pedal is connected with its SD card, and
  **unticked by default**: ticking one reads it off the pedal at export time,
  which takes a moment per loop.
- **Playback preferences / footswitches / layout** — one checkbox each.

The result is `<title>.glsong.json` — readable JSON with base64 payloads.

## Opening

Opening a session **validates the entire package before anything changes**.
A corrupt byte, an oversized file, a malformed preset, an out-of-range
playback value — any one of them refuses the whole file with a list of what is
wrong, and nothing is touched. A session written by a newer Studio (a higher
`version`) is refused with a message to update first.

A valid session shows a summary with per-item checkboxes. Applying is additive
and explicit — nothing on the device or in the workspace is silently replaced:

- **Presets** are *added* under a fresh name if the title clashes. Existing
  workspace presets are never modified.
- **Pedal** — while the pedal is connected, one imported preset can be chosen
  to be **applied live** right after import (the song's sound, ready to play).
  This uses the live `apply` path and touches nothing on the SD card; a
  separate checkbox writes it to the card too (`put`). If the pedal is not
  connected or refuses the preset, that is reported as a failure — never
  pretended.
- **MIDI files** go to the Pi when connected (otherwise they play from the
  browser). A name that already exists is imported under `name-2.mid` unless
  you tick **Replace files that already exist**.
- **Loops** are unticked by default and need the pedal connected with an SD
  card; they upload through the normal `loop put` path with the same rename-on
  -clash rule, and a loop longer than the looper holds is skipped with a
  message.
- **Playback preferences** apply to the Score panel. When the session carried
  the referenced MIDI file, only the copy that was actually imported is
  selected — under whatever name it landed after a rename — never an
  unrelated existing file that happens to share the name (its bytes are
  different). If the file was not imported (unticked, or its upload failed)
  you get a clear message and the A/B passage is not restored onto some other
  file. A file the session never carried falls back to one already present
  under that name, as the missing-asset warning explains.
- **Footswitch assignments** are only written to the pedal if ticked, and only
  while connected.
- **Panel layout** rearranges Studio only if ticked.

## Format (v1)

```json
{
  "format": "gls-song-session",
  "version": 1,
  "app": "GuitarLoopSynth Studio",
  "created": "2026-09-06T03:00:00.000Z",
  "title": "My song",
  "presets":   [{ "title", "fileName", "fileNameCustom", "mode", "chain", "instruments", "customText" }],
  "midiFiles": [{ "name": "groove.mid", "data": "<base64>" }],
  "loops":     [{ "name": "verse.wav",  "data": "<base64>" }],
  "playback":  { "file", "loop", "speed", "transpose", "mute", "solo", "a", "b", "roll" },
  "switches":  [{ "tap", "hold", "note" }],
  "layout":    { "regions": { "library": [], "center": [], "device": [], "hidden": [] }, "closed": [] }
}
```

Bounds: MIDI files ≤ 2 MB each, ≤ 64 of them; loops ≤ 8 MB each (the pedal's
own limit), ≤ 32 of them; ≤ 64 presets of ≤ 64 KB PatchScript; ≤ **64 MB of
decoded payload** in total. Base64 inflates bytes by 4/3, so the **file
itself** may reach ~85 MB — the raw-file cap is **96 MB**. Both caps are
enforced on export as well as on open, so a file the exporter writes is never
refused by size when opened. Names are `[A-Za-z0-9._-]` with the right
extension and no leading dot (the playback `file` follows the same rule).
Playback values follow the player APIs exactly: speed 0.25–4, transpose ±24
whole semitones, channels 1–16, A before B by at least 0.05 s — and NaN,
Infinity, booleans and fractional transposes are refused on both sides.

`version` is bumped only when a change would mislead an older reader; older
sessions always open in newer Studios.

## Tests

`tests/editor_core.test.mjs` covers the validator (atomicity, limits, name
rules, compatibility refusals, missing-asset warnings), the base64 round-trip,
the rename-not-overwrite helper, and `sessionApply` itself — collision
renames, playback selecting the imported copy, the pedal-preset option and
its failure reporting. `tests/test_bridge_player.py` covers the
playback-parameter validation shared with the bridge. See `tests/README.md`.
