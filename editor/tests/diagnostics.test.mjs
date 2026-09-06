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
        diagCoverageGaps, diagTitleFromText, diagRevFromAck } = mod.exports;

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
test('fingerprint is stable for equal text and differs otherwise', () => {
  assert.equal(diagFingerprint('abc\n'), diagFingerprint('abc\n'));
  assert.notEqual(diagFingerprint('abc\n'), diagFingerprint('abd\n'));
  assert.match(diagFingerprint(''), /^[0-9a-f]{8}$/);
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

test('a failed apply keeps the previous confirmation (firmware keeps its graph)', () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onApplyResult(true, 'osc.midi(1, a)\n', 'apply rev=5');
  const before = d.running.fingerprint;
  d.onApplyResult(false, 'broken text', 'line 3: unknown object');
  assert.equal(d.running.fingerprint, before);
  assert.equal(d.lastApply.ok, false);
  assert.match(d.lastApply.error, /line 3/);
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

test('a device load ack carries the rev into the confirmation', async () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onDeviceLoad('01_a.txt', 'load 01_a.txt rev=9');
  env.advance(300); await env.run();
  assert.equal(d.running.rev, 9);
  assert.equal(d.running.name, '01_a.txt');
});

test('rapid next/next/next debounces to one read-back of the final preset', async () => {
  const env = makeEnv({ presets: {
    '01_a.txt': 'osc.midi(1, a)\n', '02_b.txt': 'osc.midi(2, b)\n', '03_c.txt': 'osc.midi(3, c)\n',
  } });
  const d = createDiagnostics(env.deps);
  d.onConnect();
  d.onDeviceLoad('01_a.txt', 'load 01_a.txt rev=2');
  env.advance(50);
  d.onDeviceLoad('02_b.txt', 'load 02_b.txt rev=3');
  env.advance(50);
  d.onDeviceLoad('03_c.txt', 'load 03_c.txt rev=4');
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
  d.onDeviceLoad('01_a.txt', 'load 01_a.txt rev=2');
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
  env.advance(300); await env.run();
  assert.equal(d.running.name, '01_a.txt');
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
  assert.match(ok.text, /downstream of the OUT jack/);
});

test('findings: disconnected says connect first, and nothing else', () => {
  const env = makeEnv();
  const d = createDiagnostics(env.deps);
  const f = d.findings(0);
  assert.equal(f.length, 1);
  assert.match(f[0].text, /Not connected/);
});
