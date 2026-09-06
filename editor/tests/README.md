# Editor tests

Tests for the GLS-DIAG section of `editor/index.html` — the diagnostics +
confirmed-running-preset module. The section is written to be extractable
(pure logic behind `createDiagnostics(deps)`, browser wiring guarded by
`typeof document`), and these tests lift it out of the HTML verbatim.

## Unit tests (no dependencies)

```sh
node --test editor/tests/diagnostics.test.mjs
```

Covers: fingerprint/bindings/coverage parsing (including hand-written custom
`.midi(ch, group, note)` routing; the FNV-1a-over-UTF-8-bytes fingerprint is
pinned to the standard test vectors so editor, firmware and fake pedal agree
literally), apply success and failure (legacy invalidates, fp firmware
self-invalidates on the dry-bypass fallback via `#STATUS fp`), external preset
changes (`#EVT`, `rev` and `fp` drift), read-back confirmation that is only
believed when its fingerprint matches the device's (a file overwritten under
the same name after loading is never claimed), disconnect/reconnect
invalidation with stale in-flight responses dropped, Editing-vs-Running-vs-
differs, test-tone start / auto-expiry / old-firmware "unsupported", and the
honesty rules of the findings (MIDI transmission is never presented as a
confirmed trigger; a digital output peak is never oversold as proof of the
analogue path).

## End-to-end smoke (real bridge + fake pedal + headless Chromium)

```sh
npm i playwright-core        # once, anywhere; or set GLS_PW_CORE=/path/to/node_modules
node editor/tests/smoke.e2e.mjs
```

Spawns `pi/fake_pedal.py` on a pty and `pi/looper_bridge.py` serving the real
editor, then drives the page in headless Chromium: connect, confirm-on-connect,
load / apply / rev tracking, the diagnostics panel, the test tone (start,
measured in status, self-stop), coverage states, disconnect/reconnect honesty.
Set `GLS_CHROMIUM=/path/to/chrome` if no Playwright Chromium is cached.

The fake pedal's own protocol behaviour (rev, tone, MIDI counters, framing) is
tested separately: `python3 pi/test_fake_pedal.py -v`.
