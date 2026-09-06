/* UI smoke test: drives the real editor in headless Chrome against a real
 * (pedal-less) bridge, over the Chrome DevTools protocol. No dependencies —
 * Node ≥ 22 has fetch and a WebSocket client built in.
 *
 * Setup (two terminals, or backgrounded):
 *   HOME=/tmp/gls-home python3 pi/looper_bridge.py --http 127.0.0.1:8093 --storage /tmp/nowhere
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *       --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/gls-cdp about:blank
 *   node tests/ui_smoke.mjs
 *
 * It checks, in the real DOM: the Score panel's new controls exist; a file
 * renders as SVG with per-part M/S buttons; clicking M mutes on the bridge;
 * speed changes flow to /api/midi/params; click-to-seek starts bridge
 * playback at the clicked spot; the piano-roll toggle redraws; the Song
 * panel's export builds a session that validates; and opening that session
 * applies it (preset added, MIDI file uploaded under a deduped name).
 */
const CDP = process.env.GLS_CDP || 'http://127.0.0.1:9222';
const APP = process.env.GLS_APP || 'http://127.0.0.1:8093/';

const targets = await fetch(CDP + '/json/list').then(r => r.json());
let page = targets.find(t => t.type === 'page');
if (!page) throw new Error('no page target — is Chrome running with --remote-debugging-port=9222?');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
async function js(expression) {
  const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (m.result.exceptionDetails || (m.result.result && m.result.result.subtype === 'error'))
    throw new Error('page threw: ' + JSON.stringify(m.result.exceptionDetails || m.result.result));
  return m.result.result ? m.result.result.value : undefined;
}
async function until(expr, what, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await js(expr)) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('timed out waiting for ' + what);
}
let passed = 0;
const ok = (cond, name) => {
  if (!cond) throw new Error('FAIL: ' + name);
  passed++;
  console.log('  ok', name);
};

try {
  await send('Page.enable');
  await send('Page.navigate', { url: APP });
  await until('typeof scoreCtl === "object" && !!document.querySelector("#scoreCtlRow")', 'the editor to boot');
  ok(true, 'editor boots with the score-control row present');

  await until('midi.files.length > 0', 'the bridge file list');
  await until('!!score.model && !!document.querySelector("#scSvg")', 'the score to render');
  ok(await js('document.querySelectorAll("[data-mskind=mute]").length > 0'), 'per-part mute buttons are in the SVG');
  ok(await js('!!document.querySelector("#songSec") && !!document.querySelector("#songExportBtn")'), 'the Song session panel exists');

  // select the multi-part band file so mute/solo have something to bite on
  await js('scoreSelect("09-band-8bars.mid")');
  await until('score.model && score.model.parts.length > 1', 'the band file to parse');

  // mute channel 10 by clicking its M button in the gutter
  await js(`document.querySelector('[data-mskind="mute"][data-ch="10"]').dispatchEvent(new MouseEvent('click', {bubbles: true}))`);
  ok(await js('scoreCtl.mute.has(10)'), 'clicking M mutes the channel in scoreCtl');
  ok(await js(`document.querySelector('[data-mskind="mute"][data-ch="10"]').classList.contains('on')`), 'the M button lights up');

  // speed through the UI control
  await js(`{ const s = document.querySelector('#scoreSpeed'); s.value = '1.5'; s.dispatchEvent(new Event('change')); }`);
  ok(await js('scoreCtl.speed === 1.5'), 'the speed select updates scoreCtl');

  // click-to-seek: nothing is playing, so the click starts the bridge player
  // at the clicked spot with the current controls
  await js('scoreSeek(3.0)');
  await until('midi.status && midi.status.playing', 'bridge playback after the seek');
  const st = await js('midi.status');
  ok(st.file === '09-band-8bars.mid', 'the bridge plays the score file');
  ok(Math.abs(st.position_s - 3.0) < 1.5, 'playback starts near the clicked spot (got ' + st.position_s + ')');
  ok(st.speed === 1.5, 'the speed reached the bridge');
  ok(Array.isArray(st.mute) && st.mute.includes(10), 'the mute reached the bridge');

  // a live parameter change while playing
  await js(`{ const t = document.querySelector('#scoreTrans'); t.value = '5'; t.dispatchEvent(new Event('change')); }`);
  await new Promise(r => setTimeout(r, 400));
  ok((await js('midi.status.transpose')) === 5 || (await js('midiApi("/api/midi/status").then(s => s.transpose)')) === 5,
     'a transpose change lands on the playing bridge');
  await js('midiApi("/api/midi/stop", {})');

  // piano roll redraw
  await js(`{ const r = document.querySelector('#scoreRoll'); r.checked = true; r.dispatchEvent(new Event('change')); }`);
  ok(await js('document.querySelectorAll(".sc-rollnote").length > 0'), 'the piano-roll view draws note bars');
  await js(`{ const r = document.querySelector('#scoreRoll'); r.checked = false; r.dispatchEvent(new Event('change')); }`);

  // song session: export modal opens and lists things to tick
  await js('songExportOpen()');
  ok(await js('!document.querySelector("#songModal").hidden'), 'the export modal opens');
  ok(await js('document.querySelectorAll("#songModal input[data-kind=midi]").length >= 2'), 'the export modal lists the MIDI files');
  await js('songModalClose()');

  // build a real session, validate it, then open it and apply
  const before = await js('({ presets: store.state.presets.length, files: midi.files.length })');
  await js(`sessionBuild({ title: 'Smoke', presets: [store.state.presets[0].id],
              midi: ['01-click-100bpm.mid'], loops: [], playback: true, switches: false, layout: false })
              .then(p => { window.__pkg = p; return true; })`);
  ok(await js('sessionValidate(__pkg).ok'), 'an exported session validates');
  await js('songImportOpen(JSON.stringify(__pkg), "smoke.glsong.json")');
  ok(await js('!document.querySelector("#songModal").hidden'), 'the import modal opens');
  await js(`[...document.querySelectorAll('#songModal button')].find(b => b.textContent.includes('Apply')).click()`);
  await until(`store.state.presets.length === ${before.presets + 1}`, 'the preset to be added');
  ok(true, 'applying adds the preset (never replacing one)');
  await until(`midi.files.some(f => f.name === '01-click-100bpm-2.mid')`, 'the deduped MIDI upload');
  ok(true, 'the clashing MIDI file was renamed, not overwritten');

  // corrupt session: refused whole, nothing changes
  const counts = await js('({ p: store.state.presets.length, f: midi.files.length })');
  await js(`window.__bad = JSON.parse(JSON.stringify(__pkg)); __bad.midiFiles[0].data = 'corrupt!!'`);
  await js('songImportOpen(JSON.stringify(__bad), "bad.glsong.json")');
  ok(await js(`document.querySelector('#songModal').textContent.includes('Nothing was changed')`), 'a corrupt session is refused with a clear message');
  ok(await js(`store.state.presets.length === ${counts.p}`), 'a refused session changes nothing');
  await js('songModalClose()');

  console.log(`\nUI smoke: all ${passed} checks passed`);
  process.exit(0);
} catch (e) {
  console.error('\nUI smoke FAILED:', e.message);
  process.exit(1);
}
