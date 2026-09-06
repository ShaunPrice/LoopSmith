/* Tests for the editor's pure engine (song sessions + score playback controls).
 *
 * The whole <script> of editor/index.html evaluates in Node (its DOM work is
 * behind `typeof window !== 'undefined'`), so these tests load it in a vm and
 * exercise the pure pieces: the local-player scheduling core, the session
 * validator/plan helpers, and the tempo-map maths behind click-to-seek.
 *
 *     node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert';   // non-strict: vm-realm arrays have foreign prototypes
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'editor', 'index.html'), 'utf8');
const src = html.split('<script>')[1].split('</script>')[0];

const ctx = {
  console, performance, TextEncoder, TextDecoder,
  atob: s => {
    const buf = Buffer.from(s, 'base64');
    // browsers throw on non-base64 input; Buffer silently drops it — restore the throw
    if (buf.toString('base64').replace(/=+$/, '') !== String(s).replace(/[\s=]+/g, ''))
      throw new Error('invalid base64');
    return buf.toString('binary');
  },
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  navigator: {},
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
};
vm.createContext(ctx);
vm.runInContext(src + `
;globalThis.E = { createPlayerCore, sessionValidate, validatePlaybackPrefs, dedupeName,
                  b64FromBytes, bytesFromB64, parseSmf, scoreSecAt, scoreTickAt,
                  scoreParts, scoreQuantise, newFxItem, generateText,
                  SONG_FORMAT, SONG_VERSION, SONG_LIMITS };`, ctx, { filename: 'editor-engine.js' });
const E = ctx.E;

/* ---------- helpers: build tiny SMFs and WAVs in memory ---------- */
function vlq(n) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}
/** events: [deltaTicks, ...messageBytes]; one format-0 track, given PPQ. */
function buildSmf(events, ppq = 480) {
  const track = [];
  for (const [delta, ...m] of events) track.push(...vlq(delta), ...m);
  track.push(0, 0xff, 0x2f, 0);                                   // end of track
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, ppq >> 8, ppq & 0xff];
  const th = [0x4d, 0x54, 0x72, 0x6b,
              (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff, (track.length >>> 8) & 0xff, track.length & 0xff];
  return Uint8Array.from([...head, ...th, ...track]);
}
function buildWav(samples = 441, rate = 44100) {
  const dataBytes = samples * 2;
  const b = new Uint8Array(44 + dataBytes);
  const dv = new DataView(b.buffer);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); put(8, 'WAVE');
  put(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  put(36, 'data'); dv.setUint32(40, dataBytes, true);
  return b;
}
const toB64 = u8 => E.b64FromBytes(u8);
const smfSimple = buildSmf([
  [0, 0xc0, 5],                    // program 5 on ch1
  [0, 0xb0, 7, 100],               // CC7 (volume) on ch1
  [0, 0x90, 60, 90],               // C4 on
  [480, 0x80, 60, 0],              // C4 off after one quarter (0.5 s at default tempo)
  [0, 0x99, 36, 100],              // kick on ch10
  [240, 0x89, 36, 0],
  [240, 0x90, 64, 80],
  [480, 0x80, 64, 0],
]);

/* ================= player core: filtering, transpose, boundaries ========= */
const evAt = parsed => parsed.events;   // [{t, m}]

test('core: events come out in order and untouched at defaults', () => {
  const parsed = E.parseSmf(smfSimple.buffer);
  const core = E.createPlayerCore(evAt(parsed), {});
  const out = core.advance(10);
  assert.equal(out.length, 8);
  assert.deepEqual(out[2], [0x90, 60, 90]);
  assert.deepEqual(out[3], [0x80, 60, 0]);
});

test('core: transpose moves melodic notes, never channel 10', () => {
  const parsed = E.parseSmf(smfSimple.buffer);
  const core = E.createPlayerCore(evAt(parsed), { transpose: 3 });
  const out = core.advance(10);
  const ons = out.filter(m => (m[0] & 0xf0) === 0x90 && m[2]);
  assert.deepEqual(ons.map(m => [m[0], m[1]]), [[0x90, 63], [0x99, 36], [0x90, 67]]);
  // the matching note-offs are transposed too, so nothing hangs
  const offs = out.filter(m => (m[0] & 0xf0) === 0x80);
  assert.deepEqual(offs.map(m => [m[0], m[1]]), [[0x80, 63], [0x89, 36], [0x80, 67]]);
});

test('core: a note transposed off the keyboard is dropped, on AND off', () => {
  const smf = buildSmf([[0, 0x90, 120, 90], [480, 0x80, 120, 0]]);
  const core = E.createPlayerCore(evAt(E.parseSmf(smf.buffer)), { transpose: 20 });
  assert.deepEqual(core.advance(10).filter(m => (m[0] & 0xe0) === 0x80), []);
  assert.equal(core.held.size, 0);
});

test('core: live transpose change — the off matches the note that sounded', () => {
  const parsed = E.parseSmf(buildSmf([[0, 0x90, 60, 90], [480, 0x80, 60, 0]]).buffer);
  const core = E.createPlayerCore(evAt(parsed), {});
  core.advance(0.1);                              // C4 sounding, untransposed
  core.setFilters({ transpose: 7 });
  const out = core.advance(10);
  assert.deepEqual(out, [[0x80, 60, 0]]);         // off for the 60 that sounded, not 67
});

test('core: mute drops the channel; its held notes are released on the change', () => {
  const parsed = E.parseSmf(smfSimple.buffer);
  const core = E.createPlayerCore(evAt(parsed), {});
  core.advance(0.1);                              // C4 (ch1) + CC/program emitted
  const offs = core.setFilters({ mute: [1] });
  assert.deepEqual(offs, [[0x80, 60, 0]]);        // the sounding C4 is silenced at once
  const rest = core.advance(10);
  assert.ok(!rest.some(m => (m[0] & 0xff) === 0x90 && m[2]));   // no more ch1 note-ons
  assert.ok(rest.some(m => m[0] === 0x99));                     // drums still play
});

test('core: solo keeps only the soloed channels audible', () => {
  const parsed = E.parseSmf(smfSimple.buffer);
  const core = E.createPlayerCore(evAt(parsed), { solo: [10] });
  const out = core.advance(10);
  assert.ok(out.some(m => m[0] === 0x99));
  assert.ok(!out.some(m => m[0] === 0x90 && m[2]));
  assert.ok(out.some(m => m[0] === 0xb0));        // non-note messages still pass
});

test('core: release() sends offs for everything held plus all-notes-off', () => {
  const parsed = E.parseSmf(smfSimple.buffer);
  const core = E.createPlayerCore(evAt(parsed), {});
  core.advance(0.1);                              // C4 held
  const out = core.release();
  assert.deepEqual(out[0], [0x80, 60, 0]);
  assert.equal(out.filter(m => (m[0] & 0xf0) === 0xb0 && m[1] === 123).length, 16);
  assert.equal(core.held.size, 0);
});

test('core: seek releases, chases program/CC/bend, and skips channel-mode CCs', () => {
  const smf = buildSmf([
    [0, 0xc0, 12], [0, 0xb0, 7, 55], [0, 0xb0, 123, 0], [0, 0xe0, 0, 96],
    [0, 0x90, 60, 90], [480, 0xb0, 7, 99], [0, 0x80, 60, 0], [480, 0x90, 62, 90], [480, 0x80, 62, 0],
  ]);
  const core = E.createPlayerCore(evAt(E.parseSmf(smf.buffer)), {});
  core.advance(0.1);                              // C4 sounding
  const out = core.seek(0.7);                     // past the CC7=99 change, before the D4
  assert.deepEqual(out[0], [0x80, 60, 0]);        // held note released first
  assert.ok(out.some(m => m[0] === 0xc0 && m[1] === 12));
  assert.ok(out.some(m => m[0] === 0xb0 && m[1] === 7 && m[2] === 99));  // latest CC7 wins
  assert.ok(out.some(m => m[0] === 0xe0 && m[2] === 96));
  // CC123 appears only from release (value 0 sweep), not replayed from the file chase
  const cc123 = out.filter(m => (m[0] & 0xf0) === 0xb0 && m[1] === 123);
  assert.equal(cc123.length, 16);
  // playback resumes with the note after the seek point only
  const rest = core.advance(10).filter(m => (m[0] & 0xf0) === 0x90 && m[2]);
  assert.deepEqual(rest.map(m => m[1]), [62]);
});

test('core: advancing to a loop-boundary time then releasing leaves nothing held', () => {
  const parsed = E.parseSmf(buildSmf([[0, 0x90, 60, 90], [960, 0x80, 60, 0]]).buffer);
  const core = E.createPlayerCore(evAt(parsed), {});
  core.advance(0.3);                              // note held across the pretend boundary at 0.3 s
  const offs = core.release();                    // what the player sends at every boundary
  assert.deepEqual(offs[0], [0x80, 60, 0]);
  const again = core.seek(0);                     // wrap back to the top
  assert.equal(core.held.size, 0);
  assert.ok(again.every(m => (m[0] & 0xf0) !== 0x90));
});

/* ================= tempo-map maths behind click-to-seek ================= */
test('scoreSecAt is the inverse of scoreTickAt through a tempo change', () => {
  // 120 bpm for one bar, then 60 bpm
  const smf = buildSmf([
    [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20],         // 500000 us/q
    [0, 0x90, 60, 90], [1920, 0x80, 60, 0],
    [0, 0xff, 0x51, 3, 0x0f, 0x42, 0x40],         // 1000000 us/q
    [0, 0x90, 62, 90], [960, 0x80, 62, 0],
  ]);
  const parsed = E.parseSmf(smf.buffer);
  const model = { ppq: parsed.ppq, tempos: parsed.tempos };
  for (const tick of [0, 100, 1920, 2000, 2880]) {
    const sec = E.scoreSecAt(model, tick);
    assert.ok(Math.abs(E.scoreTickAt(model, sec) - tick) < 1e-6, `tick ${tick} round-trips`);
  }
  assert.ok(Math.abs(E.scoreSecAt(model, 1920) - 2.0) < 1e-9);    // 4 quarters at 120 bpm
  assert.ok(Math.abs(E.scoreSecAt(model, 2880) - 4.0) < 1e-9);    // + 2 quarters at 60 bpm
});

/* ================= session validation: atomic, bounded ================= */
function goodSession() {
  return {
    format: E.SONG_FORMAT, version: 1, title: 'Test song', created: '2026-09-06T00:00:00Z',
    presets: [
      { title: 'Chain one', mode: 'chain', chain: [ctx.newFxItem('AudioEffectChorus')], instruments: [], customText: null },
      { title: 'Custom one', mode: 'custom', chain: [], instruments: [],
        customText: '// my hand-tuned patch\nmixer = new AudioMixer4();\n' },
    ],
    midiFiles: [{ name: 'groove.mid', data: toB64(smfSimple) }],
    loops: [{ name: 'verse.wav', data: toB64(buildWav()) }],
    playback: { file: 'groove.mid', loop: true, speed: 0.75, transpose: -2, mute: [3], solo: [], a: 0.5, b: 1.5, roll: false },
    switches: [{ tap: 'looper_tap', hold: 'none', note: 0 }, { tap: 'note', hold: 'none', note: 38 }],
    layout: { regions: { library: ['libSec'], center: ['scoreSec'], device: [], hidden: [] }, closed: ['sysSec'] },
  };
}

test('session: a well-formed package validates and decodes everything', () => {
  const v = E.sessionValidate(goodSession());
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  assert.equal(v.data.presets.length, 2);
  assert.match(v.data.presets[1].customText, /hand-tuned/);      // custom text survives verbatim
  assert.equal(v.data.midi.length, 1);
  assert.equal(v.data.midi[0].parsed.events.length, 8);
  assert.equal(v.data.loops.length, 1);
  assert.ok(Math.abs(v.data.loops[0].seconds - 0.01) < 1e-6);
  assert.equal(v.data.switches.length, 2);
  assert.equal(v.warnings.length, 0);
});

test('session: chain presets keep enough to regenerate their PatchScript', () => {
  const v = E.sessionValidate(goodSession());
  const text = ctx.generateText(v.data.presets[0]);
  assert.match(text, /AudioEffectChorus/);
  assert.match(text, /chain-meta:/);                              // the chain survives as metadata too
});

test('session: not-a-session and newer versions are refused with clear messages', () => {
  assert.equal(E.sessionValidate(null).ok, false);
  assert.match(E.sessionValidate({ hello: 1 }).errors[0], /not a song session/);
  const v = E.sessionValidate(Object.assign(goodSession(), { version: 2 }));
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /newer Studio/);
});

test('session: one corrupt byte anywhere refuses the whole package', () => {
  for (const breakIt of [
    p => { p.midiFiles[0].data = 'no@t base64!!'; },
    p => { p.midiFiles[0].data = toB64(Uint8Array.from([1, 2, 3])); },      // not an SMF
    p => { p.loops[0].data = toB64(Uint8Array.from([82, 73, 70, 70, 0, 0])); },  // torn WAV
    p => { p.presets[0].mode = 'weird'; },
    p => { p.presets[1].customText = null; },                                // custom without text
    p => { p.playback.speed = 99; },
    p => { p.playback.a = 1.0; delete p.playback.b; },                       // A without B
    p => { p.switches = [{ tap: 'looper tap;rm -rf', hold: 'none' }]; },     // action name rules
    p => { p.layout.regions.attic = []; },
    p => { p.midiFiles[0].name = '../escape.mid'; },
    p => { p.loops[0].name = 'noext'; },
  ]) {
    const p = goodSession();
    breakIt(p);
    const v = E.sessionValidate(p);
    assert.equal(v.ok, false, 'expected refusal for ' + breakIt.toString());
    assert.ok(v.errors.length >= 1);
  }
});

test('session: size limits hold', () => {
  const p = goodSession();
  p.midiFiles[0].data = toB64(new Uint8Array(E.SONG_LIMITS.midiBytes + 1));
  const v = E.sessionValidate(p);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /limit/);
  const q = goodSession();
  q.midiFiles = Array.from({ length: E.SONG_LIMITS.midiCount + 1 }, (_, i) => ({ name: `f${i}.mid`, data: toB64(smfSimple) }));
  assert.equal(E.sessionValidate(q).ok, false);
});

test('session: a referenced-but-missing playback file is a warning, not silence', () => {
  const p = goodSession();
  p.playback.file = 'elsewhere.mid';
  const v = E.sessionValidate(p);
  assert.equal(v.ok, true);
  assert.match(v.warnings[0], /elsewhere\.mid/);
});

test('session: an empty package is refused', () => {
  const v = E.sessionValidate({ format: E.SONG_FORMAT, version: 1 });
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /empty/);
});

test('session: validation never mutates its input (atomicity groundwork)', () => {
  const p = goodSession();
  const before = JSON.stringify(p);
  E.sessionValidate(p);
  assert.equal(JSON.stringify(p), before);
});

test('base64 helpers round-trip binary exactly', () => {
  const u8 = Uint8Array.from({ length: 1024 }, (_, i) => (i * 37 + 11) & 0xff);
  assert.deepEqual(Array.from(E.bytesFromB64(E.b64FromBytes(u8))), Array.from(u8));
});

test('imports rename rather than overwrite: dedupeName', () => {
  assert.equal(E.dedupeName('a.mid', []), 'a.mid');
  assert.equal(E.dedupeName('a.mid', ['a.mid']), 'a-2.mid');
  assert.equal(E.dedupeName('a.mid', ['a.mid', 'a-2.mid']), 'a-3.mid');
  assert.equal(E.dedupeName('noext', ['noext']), 'noext-2');
});

test('playback preference rules match the player APIs', () => {
  const errs = [];
  E.validatePlaybackPrefs({ speed: 1.5, transpose: -12, mute: [1, 16], solo: [], a: 0, b: 2 }, errs, 'p');
  assert.deepEqual(errs, []);
  for (const bad of [{ speed: 0.1 }, { speed: 5 }, { transpose: 25 }, { transpose: 1.5 },
                     { mute: [0] }, { mute: [17] }, { solo: ['3'] }, { a: 2, b: 2.01 }, { b: 3 }]) {
    const e = [];
    E.validatePlaybackPrefs(bad, e, 'p');
    assert.ok(e.length >= 1, 'expected refusal for ' + JSON.stringify(bad));
  }
});
