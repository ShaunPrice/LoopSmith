// End-to-end smoke of the GLS-DIAG feature: the real editor page served by the
// real bridge (pi/looper_bridge.py), talking to the fake pedal (pi/fake_pedal.py)
// on a pty — i.e. the whole wire, minus hardware. Asserts the confirmed-running-
// preset lifecycle, the diagnostics panel, device-truth coverage and the test
// tone against the firmware 2.2.2 semantics the fake pedal mirrors.
//
// Needs: python3, and `playwright-core` resolvable (npm i playwright-core) with
// a Playwright Chromium in its usual cache (or set GLS_CHROMIUM=/path/to/chrome).
//
//     node editor/tests/smoke.e2e.mjs
//
import { spawn } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// playwright-core from wherever it is installed: next to this repo, or a
// directory named by GLS_PW_CORE (e.g. GLS_PW_CORE=/tmp/e2e/node_modules).
const { chromium } = await (async () => {
  try { return await import('playwright-core'); }
  catch (e) {
    const base = process.env.GLS_PW_CORE;
    if (!base) throw new Error('playwright-core not found — npm i playwright-core, or set GLS_PW_CORE=/path/to/node_modules');
    return import(pathToFileURL(path.join(base, 'playwright-core', 'index.mjs')).href);
  }
})();

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8973;

function chromePath() {
  if (process.env.GLS_CHROMIUM) return process.env.GLS_CHROMIUM;
  try { const p = chromium.executablePath(); if (p && existsSync(p)) return p; } catch (e) {}
  const cache = path.join(process.env.HOME || '', 'Library', 'Caches', 'ms-playwright');
  for (const d of readdirSync(cache).filter(n => n.startsWith('chromium')).sort().reverse()) {
    for (const sub of ['chrome-headless-shell-mac-arm64/chrome-headless-shell',
                       'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
                       'chrome-linux/chrome']) {
      const p = path.join(cache, d, sub);
      if (existsSync(p)) return p;
    }
  }
  throw new Error('no Chromium found — set GLS_CHROMIUM');
}

const kids = [];
function run(args, cwd) {
  const k = spawn('python3', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  kids.push(k);
  return k;
}
const cleanup = () => { for (const k of kids) { try { k.kill(); } catch (e) {} } };
process.on('exit', cleanup);

// ---- fixtures: fake pedal on a pty, bridge serving the editor ----
const pedal = run([path.join(repo, 'pi', 'fake_pedal.py')], repo);
const pty = await new Promise((res, rej) => {
  let buf = '';
  pedal.stdout.on('data', d => {
    buf += d;
    const m = /listening on (\S+)/.exec(buf);
    if (m) res(m[1]);
  });
  setTimeout(() => rej(new Error('fake pedal did not start')), 5000);
});
run([path.join(repo, 'pi', 'looper_bridge.py'), '--port', pty,
     '--http', `127.0.0.1:${PORT}`, '--editor', path.join(repo, 'editor')], repo);
await new Promise(r => setTimeout(r, 1500));

let failures = 0;
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : ''));
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: chromePath() });
try {
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGE ERROR:', e.message); failures++; });
  await page.goto(`http://127.0.0.1:${PORT}/`);

  // the editor auto-connects to the bridge it was served from
  await page.waitForFunction(() => typeof diag !== 'undefined' && diag && diag.connected, null, { timeout: 10000 });
  await page.waitForFunction(() => !!diag.running, null, { timeout: 10000 });

  const pill = await page.textContent('#connPill');
  check('pill shows connected + fw 2.2.2', /Connected .*2\.2\.2/.test(pill), pill);

  let r = await page.evaluate(() => ({ name: diag.running.name, source: diag.running.source, rev: diag.running.rev, hasRev: diag.hasRev }));
  check('running confirmed from device list on connect', r.source === 'load' && !!r.name, r);
  check('firmware rev is being tracked', r.hasRev === true && typeof r.rev === 'number', r);

  await page.click('#diagSec h3');
  await page.waitForTimeout(300);
  const runningTxt = await page.textContent('#diagRunning');
  check('panel shows a confirmed running label', /read back after load/.test(runningTxt), runningTxt);
  const findings = await page.evaluate(() => document.querySelectorAll('#diagFindings .diag-item').length);
  check('findings list rendered', findings > 0, findings);

  // load another preset from the device list: confirmation follows the device
  const before = r.rev;
  await page.evaluate(() => sendCmd('load 08_drumkit.txt'));
  await page.waitForFunction(() => diag.running && diag.running.name === '08_drumkit.txt', null, { timeout: 5000 });
  r = await page.evaluate(() => ({ name: diag.running.name, rev: diag.running.rev, ch10: diag.running.bindings.notes.has(10) || diag.running.bindings.any.has(10) }));
  check('load re-confirms content read back from the pedal', r.name === '08_drumkit.txt', r);
  check('rev advanced with the load', r.rev > before, { before, after: r.rev });
  check('bindings parsed from device content (drumkit answers ch10)', r.ch10 === true, r);

  // overwrite the SAME filename without loading it: the running patch is still
  // the old bytes, and a re-check must keep saying so (never claim the new file).
  // Each smoke run spawns a fresh fake pedal, so the overwrite does not persist.
  const runningFp = await page.evaluate(() => diag.running.fingerprint);
  await page.evaluate(async () => {
    const bytes = new TextEncoder().encode('// name: Imposter\nAudioConnection c1(fxin, 0, fxout, 0);\n');
    await sendCmd('put 08_drumkit.txt ' + bytes.length, { payload: bytes, kind: 'send' });
    diag.confirmByName('08_drumkit.txt');               // the Re-check path
  });
  await page.waitForTimeout(1200);
  const afterPut = await page.evaluate(() => ({ fp: diag.running && diag.running.fingerprint, title: diag.running && diag.running.title }));
  check('overwriting the loaded file without a load does not move the confirmation', afterPut.fp === runningFp && afterPut.title !== 'Imposter', afterPut);

  // live apply: the exact draft text becomes the confirmed running patch
  await page.evaluate(() => applyLive());
  await page.waitForFunction(() => diag.running && diag.running.source === 'apply', null, { timeout: 5000 });
  const es = await page.evaluate(() => diag.editorState(generateText(current())).state);
  check('after apply the draft is in-sync with running', es === 'in-sync', es);
  const es2 = await page.evaluate(() => diag.editorState(generateText(current()) + '\n// tweak\n').state);
  check('a differing draft is reported as differs', es2 === 'differs', es2);

  // test tone: starts, is visible in measured status, expires by itself
  await page.evaluate(() => document.querySelector('#diagToneBtn').click());
  await page.waitForFunction(() => diag.tone.active === true, null, { timeout: 3000 });
  check('tone active after button press', true);
  const toneStatus = await page.evaluate(() => new Promise(res => setTimeout(() => res(diag.status && diag.status.tone), 400)));
  check('device status reports the tone sounding', toneStatus === true, toneStatus);
  await page.waitForFunction(() => diag.tone.active === false, null, { timeout: 4000 });
  check('tone auto-expired and stays supported', await page.evaluate(() => diag.tone.supported) === true);

  const cov = await page.evaluate(() => diag.coverageForUses(new Map([[10, new Set([36])]])).state);
  check('coverage against confirmed running patch computes', cov === 'ok' || cov === 'warn', cov);

  // disconnect: everything is honestly invalidated
  await page.evaluate(() => { netReconnect.stop(); linkDisconnect(); });
  await page.waitForFunction(() => diag.connected === false, null, { timeout: 3000 });
  const post = await page.evaluate(() => ({ run: diag.running, cov: diag.coverageForUses(new Map([[1, new Set([60])]])).state }));
  check('disconnect invalidates the confirmation', post.run === null && post.cov === 'unknown', post);

  // reconnect: the pedal is running the live-applied patch (list says current=-1),
  // so there is honestly NOTHING to confirm — Studio must say unknown, not guess
  await page.evaluate(port => netConnect('127.0.0.1:' + port), PORT);
  await page.waitForFunction(() => diag.connected, null, { timeout: 10000 });
  await page.waitForTimeout(800);
  const re = await page.evaluate(() => ({ run: diag.running, why: diag.runningUnknownWhy }));
  check('reconnect over a live patch stays honestly unknown', re.run === null && /confirmed/.test(re.why || ''), re);

  // ... until a stored preset is loaded, when confirmation returns
  await page.evaluate(() => sendCmd('load 01_clean.txt'));
  await page.waitForFunction(() => !!diag.running && diag.running.name === '01_clean.txt', null, { timeout: 5000 });
  const re2 = await page.evaluate(() => ({ name: diag.running.name, source: diag.running.source }));
  check('loading a stored preset re-confirms after reconnect', re2.source === 'load', re2);
} finally {
  await browser.close();
  cleanup();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL SMOKE CHECKS PASSED');
process.exit(failures ? 1 : 0);
