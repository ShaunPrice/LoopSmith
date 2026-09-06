# USB serial protocol

The pedal speaks a line-based protocol over USB CDC serial (any baud rate; 115200 suggested).
It is designed to be pleasant for humans *and* trivially parseable by the Studio editor.

- **Commands** are single ASCII lines terminated by `\n` (CR ignored).
- **Machine responses** are lines that start with `#`. Everything else is human-readable log
  output and may be ignored by tools.
- JSON payloads are single-line JSON objects.

## Commands

| Command | Response | Notes |
|---|---|---|
| `ping` | `#PONG {"fw":"2.2.0","proto":1,"psram_mb":16,"sd":true,"flash":true}` | identify device |
| `status` | `#STATUS {…}` | see payload below |
| `monitor on` / `monitor off` | `#OK monitor` then periodic `#STATUS {…}` at 4 Hz | live meters / loop position for UIs |
| `list` | `#PRESETS {"current":1,"presets":["01_clean.txt","02_ambient.txt"]}` | filename order |
| `load <index|name>` | `#OK load 02_ambient.txt rev=4 fp=9f2c1a3b-1234` or `#ERR …` | loads + applies preset (`rev=`/`fp=` since firmware 2.2.2 — see Diagnostics) |
| `get <name>` | `#FILE <name> <len>\n` + exactly `<len>` raw bytes + `\n#END\n` | read a preset file |
| `put <name> <len>` | `#SEND` → send exactly `<len>` bytes → `#OK put` or `#ERR …` | write preset to SD + flash mirror. `<len>` ≤ 16384 |
| `apply <len>` | `#SEND` → send exactly `<len>` bytes → `#OK apply rev=5 fp=9f2c1a3b-1234` or `#ERR line <n>: …` | parse + apply live **without saving** — used by the editor for live tweaking. On failure the previous patch normally keeps running; a rare mid-apply failure falls back to dry bypass, which clears `fp` and bumps `rev` so clients notice. |
| `rm <name>` | `#OK rm` or `#ERR …` | delete preset from SD + mirror |
| `next` / `prev` | `#OK load <name> rev=… fp=…` or `#ERR …` | cycle presets (same as footswitches); presets that fail to load are skipped |
| `bypass on|off|toggle` | `#OK bypass on` | FX bypass |
| `vol <0.0–1.0>` | `#OK vol 0.70` | codec headphone/line volume |
| `source line` / `source usb` | `#OK source usb` | instrument source: the line input, or the USB audio stream from the computer (a DI recording or backing track then runs through the effects and the looper; the processed result returns over USB). Also `input(USB)` in `settings.txt`. |
| `looper tap` | `#OK looper` | same as LOOP footswitch (rec → play → overdub…) |
| `looper stop` | `#OK looper` | tap STOP behaviour |
| `looper undo` | `#OK looper` | undo/redo last overdub |
| `looper clear` | `#OK looper` | erase the loop |
| `note on <num> <vel> [ch]` / `note off <num> [ch]` | `#OK note` | play a MIDI-bound instrument voice from the dashboard (same path as USB MIDI); `ch` defaults to 1 |
| `switches` | `#SWITCHES {…}` | footswitch configuration — see below |
| `switch <n> <tap> <hold> [note]` | `#OK switch` or `#ERR …` | assign switch *n* (1–6) a tap action and a hold action; persists in EEPROM |
| `loops` | `#LOOPS {"sd":true,"loops":["riff.wav"],"seconds_max":95.0}` | loop files in `/loops` on the SD card (loops need the card — the flash mirror is too small) |
| `loop save <name>` | `#OK loop save <name> <seconds>` or `#ERR …` | write the current loop to `/loops/<name>.wav` (16-bit mono 44.1 kHz); not while recording/overdubbing |
| `loop load <name>` | `#OK loop load <name> <seconds>` or `#ERR …` | replace the loop with a WAV from the card (stopped, undo cleared); 16-bit PCM, mono or stereo (summed), 44.1 kHz, up to the loop capacity |
| `loop rm <name>` | `#OK loop rm` | delete a loop file |
| `loop get <name>` | `#FILE <name> <len>\n` + bytes + `\n#END\n` | download a loop WAV (streamed from the card) |
| `loop put <name> <len>` | `#SEND` → send `<len>` bytes → `#OK loop put` | upload a WAV to `/loops` (streamed to the card, ≤ 8 MB, 10 s idle timeout; a failed upload leaves the previous file intact); follow with `loop load` to hear it. Names may omit `.wav`. |
| `tone [ms] [freq] [level]` | `#OK tone 1000` | **firmware 2.2.2+** — a quiet diagnostic sine, mixed in *after* the preset graph and the USB tap: the running patch, the loop and USB recordings are untouched, and the tone reaches the **analogue headphone/line out only**. Stops by itself (expiry is polled from the main loop *and* inside the blocking counted-transfer loops, so a long `put`/`get` cannot delay it); clamps: 100–5000 ms (default 1000), 40–5000 Hz (default 440), level ≤ 0.05 (default 0.02 — a diagnostic beep, not a reference tone). It shows on `peak_out`, which proves **digital** signal reaches the output stage — the analogue path (codec, jack, cable, speaker) still cannot be verified in software. |
| `tone off` | `#OK tone off` | stop the test tone early |
| `sync` | `#SYNC {…}` | current musical-sync settings and state — see below and docs/LOOPER_SYNC.md |
| `sync mode off\|beat\|bar` | `#SYNC {…}` | quantise recording to nothing (legacy, the default), the next beat, or the next bar |
| `sync source internal\|midi` | `#SYNC {…}` | tempo source: the configured BPM, or incoming USB MIDI clock (24 PPQN). With `midi` and no clock running, a record tap is refused (nothing happens) rather than recording unsynchronised — `clk` in the payload says why |
| `sync bpm <30–300>` | `#SYNC {…}` | internal tempo |
| `sync countin <0–8>` | `#SYNC {…}` | metronome count-in bars before recording starts (0 = off) |
| `sync bars <0–64>` | `#SYNC {…}` | fixed recording length in bars — the loop closes itself (0 = free, tap to close) |
| `sync met off\|rec\|on` | `#SYNC {…}` | metronome click: never / while recording / whenever the grid runs (count-ins always click) |
| `sync metvol <0–1>` | `#SYNC {…}` | click level |
| `help` | human text | command summary |

Unknown commands answer `#ERR unknown command`.

## Footswitches

```json
#SWITCHES {"switches":[
  {"tap":"loop","hold":"none","note":0},   {"tap":"stop","hold":"clear","note":0},
  {"tap":"undo","hold":"none","note":0},   {"tap":"next","hold":"reload","note":0},
  {"tap":"prev","hold":"none","note":0},   {"tap":"bypass","hold":"none","note":0}],
 "actions":["none","loop","stop","undo","clear","next","prev","reload","bypass","source","note"]}
```

Actions: `loop` (rec → play → overdub), `stop` (tap stop / restart), `undo`, `clear`, `next`,
`prev`, `reload` (reload current preset), `bypass` (toggle), `source` (line ↔ USB), `note`
(play MIDI note `note` on channel 10 while held — drum triggers), `none`. Time-critical tap actions
(`loop`, `undo`, `bypass`, `note`) fire on the press; the rest (including the destructive `clear`)
fire on release so a hold action can be told apart. `stop` fires on the press when the switch has
no hold action; with a hold action it stops on the press while running and restarts on the release
when stopped (so hold-to-clear never restarts the loop first). Switches are numbered 1–6 in pin
order (pins 0–5).

## Instruments (MIDI voices)

A preset object bound with `obj.midi(channel, group[, note])` becomes a voice (see
PATCHSCRIPT.md). USB MIDI Note On/Off and the `note` command both drive the same allocator:
`channel` 0 = omni; objects sharing a `group` are one voice (e.g. an oscillator and its
envelope); voices on a channel are allocated round-robin per note, so several groups = polyphony;
a `note` argument makes the group respond to that note only (drum pads).

## `#STATUS` payload

```json
{
  "cpu": 12.4, "cpu_max": 19.8,
  "mem": 14, "mem_max": 22,
  "peak_in": 0.42, "peak_out": 0.61,
  "loop": {"state": "playing", "len_s": 12.4, "pos_s": 3.1, "can_undo": true, "seconds_max": 95.0},
  "sync": {"mode": "bar", "src": "internal", "bpm": 120.0, "clk": "idle",
           "phase": "idle", "beat": 1, "countin": 1, "bars": 4, "met": "rec"},
  "preset": {"index": 1, "count": 5, "name": "02_ambient.txt", "title": "Ambient Swell"},
  "bypass": false, "volume": 0.70, "source": "line",
  "psram_mb": 16, "sd": true, "flash": true,
  "rev": 4, "fp": "9f2c1a3b-1234", "tone": false, "midi": {"rx": 128, "trig": 96, "voices": 3}
}
```

`loop.state` ∈ `empty | recording | playing | overdubbing | stopped | armed | countin`
(`armed` = a synced recording is waiting for its beat/bar; `countin` = the metronome
count-in is running; STOP cancels either without touching anything).

## `#SYNC` payload

`sync` and every `sync …` setter answer with the full state:

```json
#SYNC {"mode": "bar", "src": "internal", "bpm": 120.0, "countin": 1, "bars": 4,
       "met": "rec", "metvol": 0.60, "sig": "4/4", "clk": "idle", "phase": "idle", "beat": 1}
```

`bpm` is the effective tempo (the measured one when following MIDI clock).
`clk` ∈ `idle | running | stopped | lost` — the MIDI clock follower's state.
`phase` ∈ `idle | countin | armed | recording | closing` — what the timing engine is doing;
`beat` is the 1-based beat inside the current bar. The meter is fixed at 4/4 for now, and the
settings are session-only (not persisted). Musical behaviour, timing accuracy and limits are
documented in [LOOPER_SYNC.md](LOOPER_SYNC.md).

The last line (`rev`, `fp`, `tone`, `midi`) is **firmware 2.2.2+**; older firmware simply
omits it and clients must treat those facts as unknown rather than guessing.

## Diagnostics (firmware 2.2.2+)

- `rev` counts successful patch loads/applies (boot load included). A UI that
  remembers the `rev` it confirmed can tell "the running patch changed under me"
  (footswitch, MIDI program change, another editor) apart from "still running
  what I confirmed" — even when the preset *name* did not change. `#OK load`/
  `#OK apply` echo the new value as `rev=N`.
- `fp` is a change-detection fingerprint of the running patch: 32-bit FNV-1a over the raw
  bytes that were successfully applied, plus their length, as `hhhhhhhh-len`
  (lower-case hex). Empty when no patch is running (boot before the first load,
  or the dry-bypass fallback after a rare mid-apply failure — both of which
  also bump `rev`). This is what makes a read-back trustworthy: a client that
  does `get <name>` after `#OK load <name> …` may still be reading a file that
  another client overwrote *after* it was loaded — a revision counter cannot
  catch that, but hashing the fetched bytes and comparing against `fp` can.
  `#OK load`/`#OK apply` echo it as `fp=…`. Capability detection is by field
  presence (a client should key on `fp`/`rev`/`tone` existing in `#STATUS`),
  not by parsing the firmware version string. FNV is a change detector, not
  a cryptographic integrity or authentication check.
- `tone` reports whether the diagnostic test tone is sounding; its start and
  auto-stop also push `#EVT {"tone":true|false}`. Media/transfer commands stop
  the tone before blocking work. Expiry is serviced by the main loop, not a
  hardware watchdog; a stalled main loop can delay it.
- `midi.rx` counts USB MIDI note on/off events the pedal received; `midi.trig`
  counts voices that actually fired (the serial `note` command drives the same
  allocator and counts in `trig` too); `midi.voices` is how many voice units the
  running patch binds. The distinction is deliberate: bytes *sent to* the pedal
  are not evidence anything arrived (`rx`), and arrival is not evidence anything
  sounded (`trig`). On older firmware none of this is reported, and a client can
  only honestly say "transmitted, delivery unconfirmed".

## Transfer framing

`get`/`put`/`apply` use **exact byte counts** — no escaping, no base64. After `#SEND`, the
device reads exactly `<len>` bytes (5 s timeout → `#ERR timeout`). After `#FILE … <len>`,
the client reads exactly `<len>` bytes before resuming line parsing.

## Over the network (companion Pi)

`pi/looper_bridge.py` relays this exact byte stream over a WebSocket at `ws://<pi>/ws`
(binary frames = pedal bytes, text frames = bridge JSON control messages such as
`{"bridge":"pedal","connected":true}`), and serves the editor at `http://<pi>/`. The
protocol is unchanged; one browser owns the pedal at a time (a newer connection replaces
the older). `GET /api/status` reports bridge and pedal state.

## USB MIDI (default firmware build)

Program Change *n* loads preset *n*. CC 7 volume; CC 80 LOOP tap, 81 STOP, 82 UNDO,
83 CLEAR, 84 bypass (≥ 64 on), 85 next preset, 86 previous — momentary CCs act on ≥ 64.

## Async events

State changes push `#EVT {"loop":"recording"}` / `#EVT {"preset":"03_crunch.txt"}` /
`#EVT {"bypass":true}` / `#EVT {"tone":false}` (2.2.2+) even when `monitor` is off, so UIs
can stay in sync with footswitch actions. An empty `#EVT {"preset":""}` means a live-applied
patch replaced the stored preset.


## The companion bridge's MIDI endpoints

The Pi bridge (`pi/looper_bridge.py`) also owns the pedal's USB **MIDI** port and exposes it:

| Endpoint | What |
|---|---|
| `ws://loopsmith.local/midi` | raw MIDI bytes both ways as binary WebSocket frames; every connected browser sees everything the pedal sends and everything the file player plays; a text frame `{"midi":"hello","connected":true,"port":"/dev/snd/midiC1D0"}` opens the session |
| `GET /midi-files/` | `{"dir": …, "files": [{name, bytes, mtime}]}` — the `midi/` folder on the USB drive (or `~/looper/midi`) |
| `PUT /midi-files/<name>.mid` | upload a Standard MIDI File (format 0 or 1, ≤ 8 MB; validated before it is kept) |
| `GET` / `DELETE /midi-files/<name>.mid` | download / delete |
| `POST /api/midi/play` `{"file": "song.mid", "loop": false}` | play it into the pedal from the Pi (tempo map honoured, all notes off at the end or on stop) |
| `POST /api/midi/stop`, `POST /api/midi/panic` | stop; stop and silence every channel |
| `GET /api/midi/status` | `{connected, port, playing, file, loop, position_s, length_s, in_events, out_events}` |

A MIDI controller plugged into the Pi is routed to the pedal automatically (`aconnect`, udev
rule `81-looper-midi.rules`). Notes the pedal plays by itself — footswitch notes and the serial
`note` command — are also sent out of its MIDI port, so a DAW or the Pi can record them.

### Setup, power and updates

All of these need a signed-in session unless the request comes from the Pi itself
(`POST /api/login` `{"user","password"}` sets the `gls_session` cookie; `POST /api/logout` ends it).

| Endpoint | What |
|---|---|
| `POST /api/system/reboot`, `POST /api/system/poweroff` | the Pi only — the pedal keeps playing |
| `GET /api/update/status`, `POST /api/update/check`, `POST /api/update/apply` | version, what is available (bundle / URL / GitHub), install with rollback |
| `POST /api/admin/set-password` `{"password"}` | console, SSH and web login together |
| `POST /api/admin/set-username` `{"username"}` | renames the account and restarts |
| `POST /api/admin/set-hotspot` `{"ssid","password"}`, `POST /api/admin/hotspot-enable` `{"on":"0"|"1"}` | the pedal's own Wi-Fi |
| `POST /api/admin/ssh-enable` `{"on":"0"|"1"}` | the SSH service |
| `POST /api/admin/console` `{"on":"0"|"1"}` | the HDMI screen: a login console, or the Studio kiosk (`vt` in `/api/network` says which) |
| `POST /api/update/upload` (raw body) | hand the Pi an update bundle from the browser |
| `POST /api/admin/bt-scan` · `bt-pair` · `bt-connect` · `bt-disconnect` · `bt-remove` `{"mac"}` | Bluetooth devices |

Privileged actions are carried out by `looper-admin.sh` under systemd; the bridge itself only
writes a request file and starts that one unit (a polkit rule allows exactly that), so it never
holds root itself.
