// Unit tests for the GLS-DIAG section of editor/index.html — the diagnostics
// + confirmed-running-preset module. The section is written to be extractable:
// this file lifts it out of the HTML verbatim and drives the pure logic with
// fake time, a fake device and a scripted preset store.
//
//     node --test editor/tests/
//
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- extract the marked section from index.html and load it as a module ----
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const beginAt = html.indexOf('GLS-DIAG BEGIN');
const endAt = html.indexOf('GLS-DIAG END');
assert.ok(beginAt > 0 && endAt > beginAt, 'GLS-DIAG markers present in editor/index.html');
const src = html.slice(html.lastIndexOf('/*', beginAt), html.indexOf('*/', endAt) + 2);
const mod = { exports: {} };
new Function('module', src)(mod);
const { createDiagnostics, diagFingerprint, diagBindingsFromText,
        diagCoverageGaps, diagTitleFromText, diagRevFromAck, diagFpFromAck } = mod.exports;

// ---- a controllable environment: fake clock, timers, device, preset store ----
function makeEnv(opts = {}) {
  let now = 1_000_000;
  const timers = new Set();
  const sends = [];
  const gets = [];
  const presets = opts.presets || {
    '01_a.txt': '// name: Preset A\nosc.midi(1, lead)\nAudioConnection c1(fxin, 0, fxout, 0);\n',
  };
  const deps = {
    now: () => now,
    setTimeout: (fn, ms) => { const t = { fn, at: now + ms }; timers.add(t); return t; },
    clearTimeout: t => { timers.delete(t); },
    send: (line, o) => { sends.push(line); return opts.send ? opts.send(line) : Promise.resolve({ ok: 'ok' }); },
    getPresetText: name => {
      gets.push(name);
      if (opts.get) return opts.get(name);
      return name in presets ? Promise.resolve(presets[name]) : Promise.reject(new Error('not found'));
    },
    onChange: () => {},
  };
  const flush = () => new Promise(r => setImmediate(r));
  return {
    deps, sends, gets, presets,
    fpOf: name => diagFingerprint(presets[name]),
    advance: ms => { now += ms; },
    // run every timer that is due, then let promise chains settle
    async run() {
      for (const t of [...timers]) if (t.at <= now) { timers.delete(t); t.fn(); }
      await flush(); await flush(); await flush();
    },
  };
}
const USES_CH1 = new Map([[1, new Set([60, 64])]]);

// ---------------------------------- pure helpers ----------------------------
test('fingerprint is FNV-1a over UTF-8 bytes plus length, matching the firmware', () => {
  assert.equal(diagFingerprint('abc\n'), diagFingerprint('abc\n'));
  assert.notEqual(diagFingerprint('abc\n'), diagFingerprint('abd\n'));
  // standard FNV-1a 32-bit vectors — pinned so editor, firmware
  // (PatchManager::patchFp) and pi/fake_pedal.py (patch_fp) agree literally
  assert.equal(diagFingerprint(''), '811c9dc5-0');
  assert.equal(diagFingerprint('a'), 'e40c292c-1');
  assert.equal(diagFingerprint('foobar'), 'bf9cf968-6');
  // multi-byte characters hash as UTF-8 bytes, not UTF-16 code units
  assert.match(diagFingerprint('é'), /-2$/);
});

test('fp ack parser', () => {
  assert.equal(diagFpFromAck('apply rev=5 fp=9f2c1a3b-1234'), '9f2c1a3b-1234');
  assert.equal(diagFpFromAck('load 02_x.txt rev=7 fp=00ff00ff-9 (warnings: x)'), '00ff00ff-9');
  assert.equal(diagFpFromAck('apply rev=5'), null);
  assert.equal(diagFpFromAck(''), null);
});

test('bindings parse melodic, drum-pad and hand-written custom .midi() calls', () => {
  const b = diagBindingsFromText([
    'osc.midi(1, lead)',            // melodic: any note on ch 1
    'bass.midi(3)',                 // channel only
    'kick.midi(10, kit, 36)',       // drum pad: one note
    'snare.midi ( 10 , kit , 38 )', // custom text with odd spacing survives
  ].join('\n'));
  assert.ok(b.any.has(1) && b.any.has(3));
  assert.deepEqual([...b.notes.get(10)].sort(), [36, 38]);
});

test('coverage gaps: wholesale channel covers all notes, pads only theirs', () => {
  const b = diagBindingsFromText('osc.midi(1, lead)\nkick.midi(10, kit, 36)');
  const uses = new Map([[1, new Set([60, 72])], [10, new Set([36, 38, 42])]]);
  const gaps = diagCoverageGaps(uses, b);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0], { ch: 10, missing: [38, 42], partial: true });
  assert.equal(diagCoverageGaps(new Map([[1, new Set([99])]]), b).length, 0);
});

test('title and rev parsers', () => {
  assert.equal(diagTitleFromText('// name: My Patch \nfoo'), 'My Patch');
  assert.equal(diagTitleFromText('nothing here'), '');
  assert.equal(diagRevFromAck('apply rev=12'), 12);
  assert.equal(diagRevFromAck('load 02_x.txt rev=7'), 7);
  assert.equal(diagRevFromAck('apply rev=3 (warnings: x)'), 3);
  assert.equal(diagRevFromAck('apply'), null);
});

// ------------------------------ apply confirmation --------------------------
test('a successful apply confirms the exact text as running', () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  const text = '// name: Live\nosc.midi(1, lead)\n';
  d.onApplyResult(true, text, 'apply rev=5');
  assert.equal(d.running.source, 'apply');
  assert.equal(d.running.rev, 5);
  assert.equal(d.running.title, 'Live');
  assert.equal(d.running.fingerprint, diagFingerprint(text));
  assert.equal(d.coverageForUses(USES_CH1).state, 'ok');
  assert.equal(d.coverageForUses(new Map([[2, new Set([60])]])).state, 'warn');
});

test('failed apply on LEGACY firmware invalidates — dry fallback cannot be ruled out', () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onApplyResult(true, 'osc.midi(1, a)\n', 'apply');       // no fp: legacy
  assert.ok(d.running);
  d.onApplyResult(false, 'broken text', 'line 3: unknown object');
  assert.equal(d.running, null, 'without a fingerprint Studio cannot promise the prior patch survived');
  assert.match(d.runningUnknownWhy, /cannot say which/);
  assert.equal(d.lastApply.ok, false);
  assert.match(d.lastApply.error, /line 3/);
});

test('failed apply on fp firmware: kept while #STATUS fp matches, invalidated when fp goes empty (dry fallback)', () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  const text = 'osc.midi(1, a)\n';
  const fp = diagFingerprint(text);
  d.onApplyResult(true, text, 'apply rev=5 fp=' + fp);
  d.onApplyResult(false, 'broken text', 'line 3: unknown object');
  assert.ok(d.running, 'the firmware will tell us via fp if the graph was swapped');
  d.onStatus({ rev: 5, fp });                                // ordinary parse failure: graph kept
  assert.ok(d.running);
  d.onStatus({ rev: 6, fp: '' });                            // rare mid-apply hard failure: dry bypass
  assert.equal(d.running, null);
  assert.match(d.runningUnknownWhy, /changed on the pedal/);
});

test('an apply whose ack fingerprint disagrees with the sent bytes is not claimed', () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onApplyResult(true, 'osc.midi(1, a)\n', 'apply rev=2 fp=deadbeef-999');
  assert.equal(d.running, null);
  assert.match(d.runningUnknownWhy, /different fingerprint/);
});

// ------------------------------ external changes ----------------------------
test('a status rev mismatch invalidates the confirmation', () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onApplyResult(true, 'osc.midi(1, a)\n', 'apply rev=5');
  d.onStatus({ rev: 5 });
  assert.ok(d.running, 'matching rev keeps the confirmation');
  d.onStatus({ rev: 6 });
  assert.equal(d.running, null);
  assert.match(d.runningUnknownWhy, /changed on the pedal/);
  assert.equal(d.coverageForUses(USES_CH1).state, 'unknown');
});

test('old firmware without rev in the ack: first status rev is adopted, later drift invalidates', () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onApplyResult(true, 'osc.midi(1, a)\n', 'apply');   // no rev in the ack
  assert.equal(d.running.rev, null);
  d.onStatus({ rev: 7 });
  assert.equal(d.running.rev, 7);
  d.onStatus({ rev: 8 });
  assert.equal(d.running, null);
});

test('an external preset change (#EVT) invalidates and re-confirms by reading the file back', async () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onApplyResult(true, 'other text\n', 'apply rev=2');
  d.onEvent({ preset: '01_a.txt' });                     // footswitch / program change
  assert.equal(d.running, null, 'invalidated until the content is read back');
  d.onStatus({ rev: 3, fp: env.fpOf('01_a.txt') });      // the device says what runs now
  env.advance(300); await env.run();
  assert.equal(d.running.name, '01_a.txt');
  assert.equal(d.running.source, 'load');
  assert.equal(d.running.title, 'Preset A');
  assert.ok(d.running.bindings.any.has(1), 'bindings come from the device content');
  assert.deepEqual(env.gets, ['01_a.txt']);
});

test('an empty #EVT preset (live-applied patch) does not invalidate an apply', () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onApplyResult(true, 'osc.midi(1, a)\n', 'apply rev=2');
  d.onEvent({ preset: '' });
  assert.ok(d.running);
  assert.equal(d.running.source, 'apply');
});

test('a device load ack carries rev and fp into the confirmation', async () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onDeviceLoad('01_a.txt', 'load 01_a.txt rev=9 fp=' + env.fpOf('01_a.txt'));
  env.advance(300); await env.run();
  assert.equal(d.running.rev, 9);
  assert.equal(d.running.name, '01_a.txt');
  assert.equal(d.running.fingerprint, env.fpOf('01_a.txt'));
});

test('rapid next/next/next debounces to one read-back of the final preset', async () => {
  const env = makeEnv({ presets: {
    '01_a.txt': 'osc.midi(1, a)\n', '02_b.txt': 'osc.midi(2, b)\n', '03_c.txt': 'osc.midi(3, c)\n',
  } });
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onDeviceLoad('01_a.txt', 'load 01_a.txt rev=2 fp=' + env.fpOf('01_a.txt'));
  env.advance(50);
  d.onDeviceLoad('02_b.txt', 'load 02_b.txt rev=3 fp=' + env.fpOf('02_b.txt'));
  env.advance(50);
  d.onDeviceLoad('03_c.txt', 'load 03_c.txt rev=4 fp=' + env.fpOf('03_c.txt'));
  env.advance(300); await env.run();
  assert.deepEqual(env.gets, ['03_c.txt']);
  assert.equal(d.running.name, '03_c.txt');
  assert.equal(d.running.rev, 4);
});

test('a failed read-back reports why instead of guessing', async () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onDeviceLoad('missing.txt', 'load missing.txt rev=2');
  env.advance(300); await env.run();
  assert.equal(d.running, null);
  assert.match(d.runningUnknownWhy, /could not read missing\.txt back/);
  assert.equal(d.coverageForUses(USES_CH1).state, 'unknown');
});

// ------------------------------ disconnect / reconnect ----------------------
test('disconnect invalidates and a confirm still in flight cannot land', async () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onDeviceLoad('01_a.txt', 'load 01_a.txt rev=2 fp=' + env.fpOf('01_a.txt'));
  d.onDisconnect('disconnected');                       // before the debounce fires
  env.advance(300); await env.run();
  assert.equal(d.running, null);
  assert.equal(d.runningUnknownWhy, 'disconnected');
  assert.equal(d.connected, false);
});

test('reconnect starts honestly unknown and re-confirms from the device list', async () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onApplyResult(true, 'x\n', 'apply rev=2');
  d.onDisconnect('pedal unplugged');
  d.onConnect();
  assert.equal(d.running, null);
  assert.match(d.runningUnknownWhy, /nothing confirmed since connecting/);
  d.confirmByName('01_a.txt');                          // what diagOnConnect does
  d.onStatus({ rev: 3, fp: env.fpOf('01_a.txt') });     // the 4 Hz stream provides the identity
  env.advance(300); await env.run();
  assert.equal(d.running.name, '01_a.txt');
});

// -------------------- read-back is verified by fingerprint ------------------
test('CODEX #1: load A, put different B under the SAME name — recheck must not claim B is running', async () => {
  const A = '// name: A\nosc.midi(1, lead)\n';
  const B = '// name: B\nkick.midi(10, kit, 36)\n';
  const env = makeEnv({ presets: { 'x.txt': A } });
  const d = createDiagnostics(env.deps);
  d.onConnect();
  const fpA = diagFingerprint(A);
  d.onDeviceLoad('x.txt', 'load x.txt rev=2 fp=' + fpA);
  env.advance(300); await env.run();
  assert.equal(d.running.fingerprint, fpA, 'A is confirmed running');

  env.presets['x.txt'] = B;                    // another client overwrites the file, no load
  d.onStatus({ rev: 2, fp: fpA });             // the device still runs A
  d.confirmByName('x.txt');                    // the Re-check button
  env.advance(300); await env.run();
  assert.ok(d.running, 'the earlier confirmation is still true and must survive');
  assert.equal(d.running.fingerprint, fpA, 'still A — never B');
  assert.ok(!d.running.bindings.notes.has(10), 'B’s drum binding must not be claimed');
});

test('CODEX #1: the same overwrite when nothing is confirmed yields unknown, not B', async () => {
  const A = '// name: A\nosc.midi(1, lead)\n';
  const B = '// name: B\nkick.midi(10, kit, 36)\n';
  const env = makeEnv({ presets: { 'x.txt': B } });   // the file already reads back as B
  const d = createDiagnostics(env.deps);
  d.onConnect();
  const fpA = diagFingerprint(A);
  d.onStatus({ rev: 2, fp: fpA });                    // ...but the device runs A
  d.onDeviceLoad('x.txt', 'load x.txt rev=2 fp=' + fpA);
  env.advance(300); await env.run();
  assert.equal(d.running, null);
  assert.match(d.runningUnknownWhy, /no longer matches the running patch/);
  assert.equal(d.coverageForUses(new Map([[10, new Set([36])]])).state, 'unknown');
});

test('CODEX #1: legacy firmware — a read-back by name alone is never confirmed', async () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onDeviceLoad('01_a.txt', 'load 01_a.txt');        // no rev, no fp: old firmware
  env.advance(300); await env.run();
  assert.equal(d.running, null);
  assert.match(d.runningUnknownWhy, /cannot prove the stored file matches/);
  // an apply still confirms on legacy (exact bytes + device ack)
  d.onApplyResult(true, 'osc.midi(1, a)\n', 'apply');
  assert.ok(d.running);
});

test('a read-back that beat the first fingerprinting status retries and then confirms', async () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.confirmByName('01_a.txt');                        // connect-time confirm, no status yet
  env.advance(300); await env.run();
  assert.equal(d.running, null);
  assert.match(d.runningUnknownWhy, /cannot prove|waiting for the pedal/);
  d.onStatus({ rev: 1, fp: env.fpOf('01_a.txt') });   // first fingerprinting status arrives
  env.advance(300); await env.run();
  assert.equal(d.running.name, '01_a.txt');
});

test('CODEX #5: an in-flight read-back superseded by a newer load never lands', async () => {
  const A = 'osc.midi(1, a)\n', C = 'osc.midi(3, c)\n';
  const pending = {};
  const env = makeEnv({ get: name => new Promise(res => { pending[name] = res; }) });
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onDeviceLoad('a.txt', 'load a.txt rev=2 fp=' + diagFingerprint(A));
  env.advance(300); await env.run();                  // a.txt fetch is now in flight
  d.onDeviceLoad('c.txt', 'load c.txt rev=3 fp=' + diagFingerprint(C));
  pending['a.txt'](A);                                // the OLD response arrives late
  await env.run();
  assert.equal(d.running, null, 'the stale a.txt response must not be claimed');
  env.advance(300); await env.run();                  // c.txt fetch goes out
  pending['c.txt'](C);
  await env.run();
  assert.equal(d.running.fingerprint, diagFingerprint(C));
  assert.ok(d.running.bindings.any.has(3));
});

// ------------------------------ editor vs running ---------------------------
test('editorState distinguishes offline, unknown, in-sync and differs', () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  assert.equal(d.editorState('x').state, 'offline');
  d.onConnect();
  assert.equal(d.editorState('x').state, 'unknown');
  const text = 'osc.midi(1, a)\n';
  d.onApplyResult(true, text, 'apply rev=2');
  assert.equal(d.editorState(text).state, 'in-sync');
  assert.equal(d.editorState(text + 'tweak\n').state, 'differs');
});

// ------------------------------ test tone -----------------------------------
test('test tone: starts, then the expiry timer clears it even without device events', async () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  const r = await d.toneStart({ ms: 500 });
  assert.equal(r.ok, true);
  assert.equal(d.tone.active, true);
  assert.deepEqual(env.sends, ['tone 500']);
  env.advance(1001); await env.run();
  assert.equal(d.tone.active, false);
});

test('test tone: a status "tone:false" from before the tone does not cancel it; a late one does', async () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  await d.toneStart({ ms: 500 });
  d.onStatus({ tone: false });                          // emitted before our tone started
  assert.equal(d.tone.active, true);
  env.advance(600);
  d.onStatus({ tone: false });                          // after the deadline: really over
  assert.equal(d.tone.active, false);
});

test('test tone: the firmware #EVT tone:false ends it immediately', async () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  await d.toneStart({ ms: 5000 });
  d.onEvent({ tone: false });
  assert.equal(d.tone.active, false);
});

test('old firmware without `tone` is reported unsupported, honestly, once', async () => {
  const env = makeEnv({ send: () => Promise.reject(new Error('unknown command')) });
  const d = createDiagnostics(env.deps);
  d.onConnect();
  const r1 = await d.toneStart({ ms: 1000 });
  assert.deepEqual({ ok: r1.ok, reason: r1.reason }, { ok: false, reason: 'unsupported' });
  assert.equal(d.tone.supported, false);
  const r2 = await d.toneStart({ ms: 1000 });           // short-circuits, no second send
  assert.equal(r2.reason, 'unsupported');
  assert.equal(env.sends.length, 1);
});

test('disconnect stops the tone UI state (the firmware stops the sound itself)', async () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  await d.toneStart({ ms: 5000 });
  d.onDisconnect('disconnected');
  assert.equal(d.tone.active, false);
});

// ------------------------------ findings honesty ----------------------------
test('findings: transmission alone is never presented as a confirmed trigger', () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onStatus({ volume: 0.7, source: 'line', bypass: false, peak_in: 0.3, peak_out: 0.3 });
  const noCounters = d.findings(42).map(f => f.text).join(' ');
  assert.match(noCounters, /cannot confirm/i);
  assert.match(noCounters, /transmitted/);
  d.onStatus({ volume: 0.7, source: 'line', bypass: false, peak_in: 0.3, peak_out: 0.3,
               midi: { rx: 42, trig: 0, voices: 0 } });
  const withCounters = d.findings(42);
  const warn = withCounters.find(f => f.level === 'warn');
  assert.match(warn.text, /no MIDI-bound instrument/);
});

test('findings: volume, source and downstream-of-the-jack checks', () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onStatus({ volume: 0, source: 'usb', bypass: true, peak_in: 0.4, peak_out: 0.0 });
  const texts = d.findings(0).map(f => f.text).join('\n');
  assert.match(texts, /volume is 0%/);
  assert.match(texts, /USB audio/);
  assert.match(texts, /bypass is ON/);
  assert.match(texts, /output is silent/);
  d.onStatus({ volume: 0.7, source: 'line', bypass: false, peak_in: 0.4, peak_out: 0.5 });
  const ok = d.findings(0).find(f => f.level === 'ok');
  // CODEX #2: a digital peak may not be oversold as proof of the analogue path
  assert.match(ok.text, /Digital audio/);
  assert.match(ok.text, /cannot verify the analogue path/);
  assert.doesNotMatch(ok.text, /problem is downstream/);
});

test('findings: disconnected says connect first, and nothing else', () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  const f = d.findings(0);
  assert.equal(f.length, 1);
  assert.match(f[0].text, /Not connected/);
});
