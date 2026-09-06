/* ============================================================================
   System — the companion Pi's own controls: version, self-update, restart and
   shut down. Only meaningful over the bridge (a USB link has no Pi behind it).
   ========================================================================== */
const sys = { poll: null, status: null, update: null, busy: false };

/** Any API call may come back 401 once a session expires (the bridge asks browsers that are
 *  not the pedal's own screen to sign in) — send the user to the login page, once. */
let signInSent = false;
function needSignIn() {
  if (signInSent) return;
  signInSent = true;
  location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
}
async function apiFetch(path, post) {
  const r = await fetch(path, post === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post) });
  if (r.status === 401) { needSignIn(); throw new Error('not signed in'); }
  return r.json();
}
async function sysApi(path, post) { return apiFetch(path, post); }
function sysBuildSection() {
  const sec = document.createElement('div'); sec.className = 'dev-sec coll closed'; sec.id = 'sysSec';
  sec.innerHTML = `<h3 role="button" tabindex="0"><span class="caret">▼</span> PEDAL COMPUTER</h3>
  <div class="sec-body" id="sysBody">
    <div class="midi-line"><span>Software</span><span class="mono" id="sysVer">—</span></div>
    <div class="midi-line" id="sysUpdRow"><span class="mono" id="sysUpd">—</span></div>
    <div class="actions-row">
      <button class="btn sm" id="sysCheckBtn" title="Ask the Pi to look for a new version">Check for updates</button>
      <button class="btn sm accent" id="sysApplyBtn" hidden>Install</button>
    </div>
    <div class="actions-row">
      <button class="btn sm" id="sysReloadBtn" title="Reload Studio in this browser — use it on the pedal’s own screen after an update">Reload this screen</button>
      <button class="btn sm" id="sysRebootBtn" title="Restart the pedal computer — the pedal itself keeps playing">Restart</button>
      <button class="btn sm danger" id="sysOffBtn" title="Shut the pedal computer down before pulling its power">Shut down</button>
    </div>
    <div class="actions-row">
      <a class="btn sm" id="sysSetupLink" href="/setup" target="_blank" rel="noopener"
         title="Network, Wi-Fi hotspot, Bluetooth devices, login and storage">Network &amp; setup ↗</a>
    </div>
    <div class="play-hint" id="sysHint"></div>
  </div>`;
  ($('#midiSec') || $('#device').lastElementChild).insertAdjacentElement('afterend', sec);
  sec.querySelector('h3').addEventListener('click', () => { sec.classList.toggle('closed'); if (!sec.classList.contains('closed')) sysRefresh(); });
  $('#sysCheckBtn').addEventListener('click', async () => {
    const b = $('#sysCheckBtn'); b.disabled = true; $('#sysUpd').textContent = 'checking…';
    try { sys.update = await sysApi('/api/update/check', {}); } catch (e) { sys.update = { detail: 'check failed' }; }
    b.disabled = false; sysPaint();
  });
  $('#sysApplyBtn').addEventListener('click', async () => {
    const v = (sys.update && sys.update.latest) || 'the new version';
    if (!confirm(`Install ${v} on the pedal computer?\n\nStudio will reconnect by itself when it restarts. The pedal keeps playing throughout.`)) return;
    $('#sysApplyBtn').disabled = true;
    const r = await sysApi('/api/update/apply', {});
    consoleLog(r.ok ? 'ok' : 'err', r.ok ? `Installing ${v}…` : `Update refused: ${r.message}`);
    sysPaint();
  });
  $('#sysReloadBtn').addEventListener('click', () => location.reload());
  $('#sysRebootBtn').addEventListener('click', () => sysPower('reboot'));
  $('#sysOffBtn').addEventListener('click', () => sysPower('poweroff'));
  sysPaint();
}
async function sysPower(what) {
  const reboot = what === 'reboot';
  const msg = reboot
    ? 'Restart the pedal computer?\n\nStudio goes offline for about a minute and reconnects by itself. The pedal keeps playing — only the screen and the editor pause.'
    : 'Shut the pedal computer down?\n\nWait for its lights to stop before pulling the power. It only comes back when you power-cycle it. The pedal itself keeps playing.';
  if (!confirm(msg)) return;
  try {
    const r = await sysApi('/api/system/' + what, {});
    consoleLog(r.ok ? 'ok' : 'err', r.ok ? (reboot ? 'Restarting the pedal computer…' : 'Shutting the pedal computer down — wait for its lights to stop.')
                                         : `Refused: ${r.message}`);
    if (r.ok) { sys.busy = true; $('#sysHint').textContent = reboot ? 'Restarting… Studio reconnects on its own.' : 'Shutting down. Power-cycle the Pi to start it again.'; }
  } catch (e) { consoleLog('err', 'The pedal computer did not answer — it may already be going down.'); }
}
async function sysRefresh() {
  if (!midi.netHost) return;                       // bridge-only
  try { sys.status = await sysApi('/api/update/status'); } catch (e) { sys.status = null; }
  sysPaint();
}
function sysPaint() {
  const sec = $('#sysSec'); if (!sec) return;
  const onPi = !!midi.netHost;
  sec.hidden = !onPi;
  if (!onPi) return;
  const st = sys.status || {}, up = sys.update || (st.available !== undefined ? st : null);
  $('#sysVer').textContent = st.version ? 'v' + st.version : '—';
  // The kiosk has no address bar: when the Pi comes back from an update running a
  // different version, this page is stale and reloads itself. Only ever forward,
  // and only when a version was known first, so a flaky link cannot loop it.
  if (!st.busy && st.version) { if (sys.seenVersion && st.version !== sys.seenVersion) { consoleLog('ok', `Studio ${st.version} installed — reloading`); setTimeout(() => location.reload(), 800); return; } sys.seenVersion = st.version; }
  const busy = st.busy;
  let txt = '';
  if (busy) txt = st.transaction ? st.transaction.message : 'installing… Studio will reconnect';
  else if (st.message) txt = st.message;
  else if (up && up.available) txt = `v${up.latest} available (${up.source})`;
  else if (up) txt = up.detail || 'up to date';
  if (st.os_reboot_required) txt += (txt ? ' · ' : '') + 'system updates need a restart';
  $('#sysUpd').textContent = txt;
  const canApply = !!(up && up.available) && !busy;
  $('#sysApplyBtn').hidden = !canApply;
  $('#sysApplyBtn').disabled = !canApply;
  $('#sysApplyBtn').textContent = up && up.latest ? `Install v${up.latest}` : 'Install';
  $('#sysCheckBtn').disabled = busy;
  $('#sysHint').textContent = busy ? '' : 'Updates come from a bundle on the USB drive, or from the address set in looper.conf. Restart and shut down affect the Pi only — never the pedal.';
}
function sysPollStart() { sysPollStop(); sysRefresh(); sys.poll = setInterval(sysRefresh, 5000); }
function sysPollStop() { clearInterval(sys.poll); sys.poll = null; }

const netReconnect = {
  stopped: false, timer: null, delay: 2000,
  schedule(h) { clearTimeout(this.timer); this.timer = setTimeout(() => { if (!link.connected) netConnect(h); }, this.delay); this.delay = Math.min(this.delay * 1.6, 15000); },
  reset() { clearTimeout(this.timer); this.delay = 2000; this.stopped = false; },
  stop() { clearTimeout(this.timer); this.stopped = true; }
};
/** Connect through the companion-Pi bridge (pi/looper_bridge.py) at ws://host/ws.
 *  The bridge is byte-transparent, so the same RX state machine runs unchanged;
 *  TEXT frames are bridge control messages, BINARY frames are pedal bytes. */
function netConnect(host) {
  if (link.connected || link.pendingWs || link.pendingSerial) { consoleLog('info', 'Already connected / connecting'); return; }
  host = (host || '').trim() || 'loopsmith.local';
  if (location.protocol === 'https:') {
    // The bridge is plain http/ws; browsers block ws:// from an https page and
    // wss:// would need a certificate the Pi doesn't have.
    consoleLog('err', `This page was opened over https, so it cannot reach the plain-http bridge. Open http://${host}/ (the bridge serves the editor) or the local index.html instead.`);
    return;
  }
  const url = `ws://${host}/ws`;
  consoleLog('info', `Connecting to bridge ${url} …`);
  let ws;
  try { ws = new WebSocket(url); }
  catch (e) { consoleLog('err', 'Bad bridge address: ' + e.message); return; }
  ws.binaryType = 'arraybuffer';
  link.pendingWs = ws;
  $('#netGo').disabled = true;
  $('#netGo').textContent = 'Connecting…';
  const settlePending = () => {
    if (link.pendingWs === ws) link.pendingWs = null;
    $('#netGo').disabled = false;
    $('#netGo').textContent = 'Connect';
  };
  ws.onopen = () => {
    settlePending();
    if (link.connected) { try { ws.close(); } catch (e) {} return; }   // another transport won
    link.ws = ws;
    link.transport = {
      kind: 'ws',
      // send() only buffers; resolve once the socket has drained below 64 KB so
      // writePayload's 16 KB slices see real back-pressure on multi-MB loop uploads.
      write: bytes => {
        ws.send(bytes);
        return new Promise(res => {
          const chk = () => (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount < 65536) ? res() : setTimeout(chk, 5);
          chk();
        });
      },
      close: async () => { try { ws.close(); } catch (e) {} link.ws = null; },
    };
    try { localStorage.setItem('gls.bridgeHost', host); } catch (e) {}
    netReconnect.reset();
    midiBridgeConnect(host);
    link.connected = true;
    link.pedalPresent = true;
    updateConnUi();
    consoleLog('info', `Bridge connected (${host})`);
    // the handshake runs when the bridge's hello reports the pedal
  };
  ws.onmessage = ev => {
    if (typeof ev.data === 'string') {
      let m = null;
      try { m = JSON.parse(ev.data); } catch (e) {}
      if (!m) return;
      if (m.bridge === 'hello' || m.bridge === 'pedal') {
        const present = (m.bridge === 'hello') ? !!m.pedal : !!m.connected;
        if (present) {
          link.pedalPresent = true;
          failAllPending('pedal (re)connected');
          linkUp(m.bridge === 'hello' ? `Bridge has the pedal on ${m.port}` : `Pedal plugged in (${m.port})`);
        } else {
          link.pedalPresent = false;
          failAllPending('pedal not connected');
          diagOnLinkDown('pedal unplugged');    // GLS-DIAG
          link.binMode = null;
          link.rxCarry = new Uint8Array(0);
          dev.info = null;
          updateConnUi();
          consoleLog('info', m.bridge === 'hello' ? 'Bridge is up — plug the pedal in' : 'Pedal unplugged');
        }
      }
      else if (m.bridge === 'replaced') consoleLog('err', 'Another editor took over the pedal');
      else if (m.bridge === 'error') consoleLog('err', 'Bridge: ' + m.message);
      return;
    }
    feedBytes(new Uint8Array(ev.data));
  };
  ws.onerror = () => { if (!link.connected) consoleLog('err', `Could not reach the bridge at ${host}`); };
  ws.onclose = () => {
    settlePending();
    // a 401 on the socket means the session has gone; check before reconnecting in a loop
    if (/^https?:$/.test(location.protocol)) fetch('/api/status').then(r => { if (r.status === 401) needSignIn(); }).catch(() => {});
    if (link.connected && link.ws === ws) {
      linkDisconnect();
      // the bridge serves many browsers at once, so a dropped socket is the bridge or the
      // network, not another editor: come back by ourselves (the kiosk relies on this)
      if (!netReconnect.stopped) netReconnect.schedule(host);
    }
  };
}

/** Shared post-connect handshake for both transports. */
async function linkUp(msg) {
  link.rxCarry = new Uint8Array(0);
  link.binMode = null;
  updateConnUi();
  consoleLog('info', msg);
  // Identify (retry once — a fresh link can carry a stray byte), enumerate,
  // then start the 4 Hz status stream. Each step is independent.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const pong = await sendCmd('ping', { timeout: 2500 });
      if (pong && pong.json) { dev.info = pong.json; renderDevInfo(); break; }
    } catch (e) {
      if (attempt) consoleLog('err', 'Identify: ' + e.message);
    }
  }
  try { await refreshDeviceList(); } catch (e) { consoleLog('err', 'List presets: ' + e.message); }
  try { await sendCmd('monitor on'); } catch (e) { consoleLog('err', 'Monitor: ' + e.message); }
  // Footswitch map + loop files + sync (older firmware answers #ERR — settle() logs it).
  try { await sendCmd('switches'); } catch (e) {}
  try { await sendCmd('loops'); } catch (e) {}
  diagOnConnect();                                  // GLS-DIAG: confirm what is running
  try { await sendCmd('sync'); } catch (e) {}
}

async function linkDisconnect(silent) {
  midiBridgeDisconnect();
  const wasConnected = link.connected;
  flushHeldNotes();                          // best effort: note-offs straight to the transport
  if (wasConnected) diagOnLinkDown('disconnected');   // GLS-DIAG
  link.connected = false;
  failAllPending('disconnected');
  link.rxCarry = new Uint8Array(0);
  const t = link.transport;
  link.transport = null;
  link.pedalPresent = true;
  if (t) { try { await t.close(); } catch (e) {} }
  link.binMode = null;
  updateConnUi();
  if (wasConnected && !silent) consoleLog('info', 'Disconnected');
}
const serialDisconnect = linkDisconnect;   // legacy name used by the serial paths

async function readLoop() {
  try {
    for (;;) {
      const { value, done } = await link.reader.read();
      if (done) break;
      if (value && value.length) feedBytes(value);
    }
  } catch (e) {
    if (link.connected) consoleLog('err', 'Serial read error: ' + e.message);
  } finally {
    if (link.connected) serialDisconnect();
  }
}

/** Byte-level RX state machine: line mode <-> counted-byte (#FILE) mode. */
function feedBytes(bytes) {
  let buf = link.rxCarry.length ? concatBytes(link.rxCarry, bytes) : bytes;
  link.rxCarry = new Uint8Array(0);
  let i = 0;
  while (i < buf.length) {
    if (link.binMode) {
      const bm = link.binMode;
      const take = Math.min(bm.need, buf.length - i);
      bm.chunks.push(buf.slice(i, i + take));      // kept as chunks, joined once at the end (linear)
      bm.need -= take; bm.received += take;
      i += take;
      if (link.active) {
        bumpTimer(link.active);                    // a multi-MB loop file is judged by activity
        if (link.active.onProgress) link.active.onProgress(bm.received, bm.total);
      }
      if (bm.need === 0) {
        const total = new Uint8Array(bm.total);
        let off = 0;
        for (const c of bm.chunks) { total.set(c, off); off += c.length; }
        finishFile(total);
        link.binMode = null;   // "\n#END\n" follows and is parsed as lines
      }
    } else {
      const nl = buf.indexOf(10, i);
      if (nl === -1) { link.rxCarry = buf.slice(i); return; }
      const line = dec.decode(buf.slice(i, nl)).replace(/\r$/, '');
      i = nl + 1;
      handleLine(line);
    }
  }
}

/** A counted-byte payload is complete: text for a preset "get", raw bytes for "loop get". */
function finishFile(total) {
  consoleLog('rx', `[file payload: ${total.length} bytes]`);
  const a = link.active;
  if (!a) return;
  if (a.kind === 'get') a.fileContent = dec.decode(total);
  else if (a.kind === 'getbin') a.fileBytes = total;
  a.awaitEnd = true;                         // the next non-empty line must be "#END"
}

/** Hard wall-clock deadline for a counted transfer — unlike bumpTimer it is never
 *  restarted by activity: 30 s + 1 s per 50 KB (an 8 MB loop gets ~3.3 min). */
function armDeadline(a, bytes) {
  clearTimeout(a.hardTimer);
  const ms = 30000 + Math.ceil(bytes / 51200) * 1000;
  a.hardTimer = setTimeout(() => {
    if (link.active === a) settle(new Error(`transfer deadline (${Math.round(ms / 1000)} s) exceeded for "${a.line}"`));
  }, ms);
}

/** (Re)start the in-flight command's timeout — called on every chunk of a big transfer. */
function bumpTimer(a) {
  clearTimeout(a.timer);
  a.timer = setTimeout(() => {
    if (link.active === a) settle(new Error(`timeout waiting for response to "${a.line}"`));
  }, a.timeout);
}

/** Stream a #SEND payload in 16 KB slices, awaiting each write so the transport's
 *  back-pressure (serial writer / WebSocket buffer) throttles multi-MB loop uploads. */
async function writePayload(a) {
  const bytes = a.payload, SLICE = 16384;
  a.sendStarted = true;
  try {
    for (let off = 0; off < bytes.length; off += SLICE) {
      if (link.active !== a) return;                     // cancelled / disconnected meanwhile
      const end = Math.min(off + SLICE, bytes.length);
      await linkWrite(bytes.subarray(off, end));
      a.sent = end;
      if (link.active !== a) {                           // aborted while this slice was in flight
        if (link.putAbortAt) link.putAbortAt = Date.now();   // hold counts from the last byte written
        return;
      }
      bumpTimer(a);
      if (a.onProgress) a.onProgress(end, bytes.length);
    }
    consoleLog('tx', `[payload: ${bytes.length} bytes]`);
  } catch (e) {
    consoleLog('err', 'Payload write failed: ' + e.message);
    if (link.active === a) settle(new Error('write failed'));
  }
}

function handleLine(line) {
  if (line === '') return;
  const cur = link.active;
  if (cur && cur.awaitEnd && line !== '#END') {
    // The counted bytes arrived but the trailer did not: the payload came up short
    // (host stall, pedal TX timeout) and this line was swallowed as data — reject it
    // rather than hand back a truncated file. The line itself is then handled normally.
    cur.awaitEnd = false;
    settle(new Error(`transfer corrupt — expected #END after the payload, got "${line.slice(0, 40)}"`));
  }
  if (line[0] !== '#') {                       // human-readable log output
    consoleLog('rx', line);
    return;
  }
  consoleLog('mach', line);
  const sp = line.indexOf(' ');
  const head = sp === -1 ? line : line.slice(0, sp);
  const rest = sp === -1 ? '' : line.slice(sp + 1);

  switch (head) {
    case '#STATUS': {
      const st = tryJson(rest);
      if (st) applyStatus(st);
      if (link.active && /^status\b/.test(link.active.line)) settle(null, { json: st });
      break;
    }
    case '#EVT': {
      const ev = tryJson(rest);
      if (ev) applyEvent(ev);
      break;
    }
    case '#PONG':
      settle(null, { json: tryJson(rest) });
      break;
    case '#PRESETS': {
      const j = tryJson(rest);
      if (j) { dev.presets = j.presets || []; dev.currentIndex = (typeof j.current === 'number') ? j.current : -1; renderDevPresets(); }
      settle(null, { json: j });
      break;
    }
    case '#FILE': {
      const m = rest.match(/^(\S+)\s+(\d+)$/);
      if (m) {
        const len = parseInt(m[2], 10);
        if (link.active) armDeadline(link.active, len);
        if (len > 0) link.binMode = { need: len, total: len, received: 0, chunks: [], name: m[1] };
        else finishFile(new Uint8Array(0));
      }
      break;                                    // resolved later by #END
    }
    case '#END': {
      const a = link.active;
      if (!a || !a.awaitEnd) break;             // stray trailer of an aborted transfer
      a.awaitEnd = false;
      if (a.kind === 'get') settle(null, { content: a.fileContent !== undefined ? a.fileContent : '' });
      else if (a.kind === 'getbin') settle(null, { bytes: a.fileBytes || new Uint8Array(0), name: a.line.split(/\s+/).pop() });
      break;
    }
    case '#SEND':
      if (link.active && link.active.payload) writePayload(link.active);
      break;                                    // resolved later by #OK / #ERR
    case '#SWITCHES': {
      const j = tryJson(rest);
      if (j && Array.isArray(j.switches)) { dev.switches = j; renderSwitches(); }
      if (link.active && /^switches\b/.test(link.active.line)) settle(null, { json: j });
      break;
    }
    case '#LOOPS': {
      const j = tryJson(rest);
      if (j) { dev.loops = j; renderLoops(); }
      if (link.active && /^loops\b/.test(link.active.line)) settle(null, { json: j });
      break;
    }
    case '#SYNC': {
      const j = tryJson(rest);
      if (j) { dev.sync = Object.assign(dev.sync || {}, j); renderSync(); }
      if (link.active && /^sync\b/.test(link.active.line)) settle(null, { json: j });
      break;
    }
    case '#OK': {
      // Piggy-back state off the acknowledgement text (e.g. "#OK load 02_x.txt",
      // "#OK bypass on", "#OK vol 0.70").
      const mLoad = rest.match(/^load\s+(\S+)/);
      if (mLoad) { dev.presetName = mLoad[1]; renderDevPresetName(); markDeviceCurrent(mLoad[1]); diagOnDeviceLoad(mLoad[1], rest); /* GLS-DIAG */ }
      const mByp = rest.match(/^bypass\s+(on|off)/);
      if (mByp) { dev.bypass = mByp[1] === 'on'; renderBypass(); }
      settle(null, { ok: rest });
      break;
    }
    case '#ERR':
      if (/^timeout\b/.test(rest) && link.putAbortAt && !(link.active && link.active.kind === 'send')) {
        consoleLog('info', 'Pedal abandoned the interrupted upload');   // unsolicited: not for the active command
        link.putAbortAt = 0;
        clearTimeout(link.holdTimer); link.holdTimer = null;
        pumpQueue();                                                    // release held commands right away
        break;
      }
      settle(new Error(rest || 'device error'), null, { fromDevice: true });
      break;
    default:
      break;                                     // unknown machine line: already logged
  }
}

function tryJson(s) {
  try { return JSON.parse(s); } catch (e) { consoleLog('err', 'Bad JSON payload: ' + s.slice(0, 80)); return null; }
}

/** Queue a command line. opts: { payload:Uint8Array, timeout:ms, kind:'get'|... } */
function sendCmd(lineStr, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const kind = opts.kind || (/^get\s/.test(lineStr) ? 'get' : /^loop\s+get\s/.test(lineStr) ? 'getbin'
                 : /^(put|apply|loop\s+put)\b/.test(lineStr) ? 'send' : 'cmd');
    const payload = opts.payload || null;
    // Transfers are judged by activity (bumpTimer restarts this on every chunk);
    // the window scales with size: an 8 MB loop upload gets 10 s + 80 s.
    const timeout = opts.timeout || (kind === 'cmd' ? 5000 : kind === 'getbin' ? 90000
                    : (payload ? 10000 + Math.ceil(payload.length / 1024) * 10 : 10000));
    link.queue.push({
      line: lineStr, payload, kind, timeout, onProgress: opts.onProgress || null,
      resolve, reject, timer: null, hardTimer: null, sent: 0, sendStarted: false, awaitEnd: false
    });
    pumpQueue();
  });
}

function pumpQueue() {
  if (link.active || !link.queue.length) return;
  if (!link.connected || !link.transport) { failAllPending('not connected'); return; }
  // After an abandoned upload the pedal keeps reading our lines as payload until its
  // 10 s idle timeout fires — hold everything (incl. the reconnect handshake) until then.
  const hold = link.putAbortAt ? link.putAbortAt + PUT_ABORT_HOLD_MS - Date.now() : 0;
  if (hold > 0) {
    if (!link.holdTimer) {
      consoleLog('info', `Holding commands ${(hold / 1000).toFixed(1)} s until the pedal abandons the interrupted upload`);
      link.holdTimer = setTimeout(() => { link.holdTimer = null; pumpQueue(); }, hold + 50);
    }
    return;
  }
  link.putAbortAt = 0;
  const a = link.queue.shift();
  link.active = a;
  if (a.payload) armDeadline(a, a.payload.length);
  if (a.onProgress) a.onProgress(0, 0);        // show the transfer box while waiting for the pedal
  consoleLog('tx', a.line);
  linkWrite(enc.encode(a.line + '\n')).catch(e => {
    consoleLog('err', 'Write failed: ' + e.message);
    settle(new Error('write failed'));
  });
  bumpTimer(a);
}

function settle(err, val, opts) {
  const a = link.active;
  if (!a) return;
  clearTimeout(a.timer); clearTimeout(a.hardTimer);
  link.active = null;
  if (err) {
    abortTransfer(a, opts);
    consoleLog('err', a.line + ' -> ' + err.message);
    a.reject(err);
  } else a.resolve(val);
  pumpQueue();
}

/** A transfer died mid-way: drop the half-read counted payload so the parser is back in
 *  line mode, and remember an interrupted upload so pumpQueue waits the pedal out
 *  (a device-side #ERR means the pedal already stopped reading — no wait needed). */
function abortTransfer(a, opts) {
  if (a.kind !== 'get' && a.kind !== 'getbin' && a.kind !== 'send') return;
  link.binMode = null;
  link.rxCarry = new Uint8Array(0);
  a.awaitEnd = false;
  if (a.kind === 'send' && a.sendStarted && a.payload && a.sent < a.payload.length && !(opts && opts.fromDevice))
    link.putAbortAt = Date.now();
}

function failAllPending(reason) {
  const err = new Error(reason);
  const a = link.active;
  if (a) {
    clearTimeout(a.timer); clearTimeout(a.hardTimer);
    link.active = null;
    abortTransfer(a);
    a.reject(err);
  }
  while (link.queue.length) link.queue.shift().reject(err);
}

/** True while a counted-byte transfer owns the link — blocking dialogs must wait. */
function transferActive() {
  return !!link.binMode || !!(link.active && link.active.kind !== 'cmd');
}

/* ---- status / event application ---- */
function applyStatus(st) {
  dev.status = st;
  transportPaint();
  if (typeof st.cpu === 'number') dev.cpu = st.cpu;
  if (typeof st.cpu_max === 'number') dev.cpuMax = st.cpu_max;
  if (typeof st.mem === 'number') dev.mem = st.mem;
  if (typeof st.mem_max === 'number') dev.memMax = st.mem_max;
  if (typeof st.peak_in === 'number') dev.vu.in.tgt = clamp(st.peak_in, 0, 1);
  if (typeof st.peak_out === 'number') dev.vu.out.tgt = clamp(st.peak_out, 0, 1);
  if (st.loop) dev.loop = st.loop;
  if (st.sync) { dev.sync = Object.assign(dev.sync || {}, st.sync); renderSync(); }
  if (st.preset) { dev.presetName = st.preset.title || st.preset.name || '-'; renderDevPresetName(); }
  if (typeof st.bypass === 'boolean') { dev.bypass = st.bypass; renderBypass(); }
  if (typeof st.volume === 'number') { dev.volume = st.volume; renderVolume(false); }
  renderMetersStatic();
  renderLooper();
  diagOnStatus(st);                                 // GLS-DIAG
}
function applyEvent(ev) {
  if (ev.loop) { dev.loop.state = ev.loop; renderLooper(); }
  if (ev.preset) { dev.presetName = ev.preset; renderDevPresetName(); markDeviceCurrent(ev.preset); }
  if (typeof ev.bypass === 'boolean') { dev.bypass = ev.bypass; renderBypass(); }
  diagOnEvent(ev);                                  // GLS-DIAG
}
function markDeviceCurrent(name) {
  const i = dev.presets.indexOf(name);
  if (i >= 0) { dev.currentIndex = i; renderDevPresets(); }
}

/* ---- higher-level device operations ---- */
async function refreshDeviceList() { try { await sendCmd('list'); } catch (e) {} }

/** The pedal rejects a preset with validator errors (e.g. > 24 objects) and keeps the
 *  previous patch — refuse to send those rather than let the failure look random. */
function patchIsValid(text, what) {
  const v = validatePatch(parsePatch(text), text);
  if (!v.errors.length) return true;
  if (what) consoleLog('err', `Cannot ${what}: ${v.errors.length} validation error(s) — ${v.errors[0].msg}`);
  return false;
}

async function applyLive(quiet) {
  const p = current();
  if (!p || !link.connected) return;
  const text = generateText(p);
  const bytes = enc.encode(text);
  if (bytes.length > MAX_FILE_BYTES) { consoleLog('err', `Cannot apply: preset is ${bytes.length} bytes (> 16 KB)`); return; }
  if (!patchIsValid(text, quiet ? null : 'apply')) return;
  try {
    const r = await sendCmd(`apply ${bytes.length}`, { payload: bytes, kind: 'send' });
    diagOnApplyResult(true, text, r && r.ok);       // GLS-DIAG: these exact bytes are confirmed running
  } catch (e) {
    diagOnApplyResult(false, text, e.message);      // GLS-DIAG: the pedal kept its previous patch
  }
}

async function pushCurrent() {
  const p = current();
  if (!p || !link.connected) return;
  let name = ensureFileName(p);
  if (/\s/.test(name)) {   // the device protocol tokenizes on spaces
    name = name.replace(/\s+/g, '_');
    p.fileName = name;
    store.saveSoon();
    consoleLog('info', `Renamed to ${name} for the device (no spaces in preset names).`);
  }
  const text = generateText(p);
  const bytes = enc.encode(text);
  if (bytes.length > MAX_FILE_BYTES) { consoleLog('err', `Cannot push: preset is ${bytes.length} bytes (> 16 KB)`); return; }
  if (!patchIsValid(text, 'push')) return;
  try {
    await sendCmd(`put ${name} ${bytes.length}`, { payload: bytes, kind: 'send' });
    consoleLog('info', `Pushed ${name} (${bytes.length} bytes)`);
    await refreshDeviceList();
  } catch (e) {}
}

async function pullPreset(name) {
  try {
    const r = await sendCmd(`get ${name}`, { kind: 'get' });
    if (r && typeof r.content === 'string') addImportedPreset(name, r.content, ' (device)');
  } catch (e) {}
}

let autoApplyTimer = null;
function maybeAutoApply() {
  if (!link.connected || !ui.autoApply) return;
  clearTimeout(autoApplyTimer);
  autoApplyTimer = setTimeout(() => applyLive(true), 300);   // debounce for live knob tweaking
}

