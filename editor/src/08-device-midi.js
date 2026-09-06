/* ============================================================================
   9. Device link — PROTOCOL.md over Web Serial (USB) or the Pi bridge (WebSocket)
   ----------------------------------------------------------------------------
   Line-based commands; machine lines start with '#'. get/put/apply use exact
   byte counts: after "#FILE <name> <len>" we read exactly <len> raw bytes before
   resuming line parsing; after "#SEND" we write exactly <len> raw bytes.
   ========================================================================== */
const link = {
  port: null, reader: null, writer: null, connected: false,
  transport: null,             // { kind:'serial'|'ws', write(bytes), close() }
  ws: null,                    // the WebSocket when kind === 'ws'
  pendingWs: null,             // a WebSocket still connecting (guards double connects)
  pendingSerial: false,        // the Web Serial chooser / open() is in progress
  putAbortAt: 0,               // when an upload was abandoned mid-payload (pedal still draining)
  holdTimer: null,
  pedalPresent: true,          // false while the bridge reports the pedal unplugged
  rxCarry: new Uint8Array(0),
  binMode: null,               // { need, total, received, chunks[], name } while consuming #FILE payload
  queue: [], active: null,     // one in-flight command at a time
};
const dev = {
  info: null, status: null, presets: [], currentIndex: -1,
  bypass: false, volume: 0.7, presetName: '-',
  vu: { in: { val: 0, tgt: 0, peak: 0, peakTs: 0 }, out: { val: 0, tgt: 0, peak: 0, peakTs: 0 } },
  cpu: 0, cpuMax: 0, mem: 0, memMax: 0,
  loop: { state: 'empty', len_s: 0, pos_s: 0, can_undo: false },
  switches: null,              // last #SWITCHES payload { switches:[…], actions:[…] }
  loops: null,                 // last #LOOPS payload { sd, loops:[…], seconds_max }
  sync: null,                  // last sync state { mode, src, bpm, clk, phase, beat, countin, bars, met }
};

function linkWrite(bytes) {
  if (!link.transport) return Promise.reject(new Error('not connected'));
  return link.transport.write(bytes);
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

async function serialConnect() {
  if (!('serial' in navigator)) return;
  if (link.connected || link.pendingWs || link.pendingSerial) { consoleLog('info', 'Already connected / connecting'); return; }
  link.pendingSerial = true;
  let port;
  try { port = await navigator.serial.requestPort(); }
  catch (e) { link.pendingSerial = false; return; }   // user cancelled the chooser
  try {
    // 4 MB read buffer: a renderer stall (dialog, GC pause) must not starve the
    // Teensy's 120 ms USB TX timeout in the middle of a multi-MB counted transfer.
    await port.open({ baudRate: 115200, bufferSize: 4 * 1024 * 1024 });   // any rate works over USB CDC
  } catch (e) {
    link.pendingSerial = false;
    consoleLog('err', 'Could not open port: ' + e.message);
    return;
  }
  link.pendingSerial = false;
  if (link.connected) {                     // a bridge socket won while the chooser was open
    try { await port.close(); } catch (e) {}
    consoleLog('info', 'Already connected over the network — USB port released');
    return;
  }
  link.port = port;
  link.writer = port.writable.getWriter();
  link.reader = port.readable.getReader();
  link.transport = {
    kind: 'serial',
    write: bytes => link.writer.write(bytes),
    close: async () => {
      try { if (link.reader) await link.reader.cancel(); } catch (e) {}
      try { if (link.reader) link.reader.releaseLock(); } catch (e) {}
      try { if (link.writer) link.writer.releaseLock(); } catch (e) {}
      try { if (link.port) await link.port.close(); } catch (e) {}
      link.port = link.reader = link.writer = null;
    },
  };
  link.connected = true;
  readLoop();
  await linkUp('Serial port opened @115200');
}

/* ============================================================================
   MIDI — files into the pedal, live in/out. Two transports: the companion
   bridge's /midi WebSocket (the Pi owns the pedal's MIDI port and plays files
   itself) or Web MIDI straight to the pedal's USB port (Chrome/Edge over USB).
   ========================================================================== */
const midi = { netHost: null, ws: null, wsTimer: null, wsDelay: 1500, access: null, out: null, pedalIn: null,
               ctlIn: null, inCount: 0, outCount: 0, last: '', files: [], local: [], status: null, poll: null,
               player: null, loop: false };
const midiUseCache = new Map();          // name/bytes/mtime -> {uses, parsed}

function midiTransport() { return midi.netHost ? 'bridge' : (midi.out ? 'webmidi' : null); }
function midiSend(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (midi.netHost && midi.ws && midi.ws.readyState === 1) midi.ws.send(u8);
  else if (midi.out) { try { midi.out.send(u8); } catch (e) { return false; } }
  else return false;
  midi.outCount += [...u8].filter(b => b & 0x80).length;
  midiPaint();
  return true;
}
function midiNoteText(b) {
  if (!b.length) return '';
  const st = b[0] & 0xF0, ch = (b[0] & 0x0F) + 1;
  if (st === 0x90 && b[2]) return `ch${ch} note on ${noteName(b[1])} v${b[2]}`;
  if (st === 0x80 || st === 0x90) return `ch${ch} note off ${noteName(b[1])}`;
  if (st === 0xB0) return `ch${ch} CC${b[1]}=${b[2]}`;
  if (st === 0xC0) return `ch${ch} program ${b[1]}`;
  return `ch${ch} 0x${st.toString(16)}`;
}
function midiSawInput(u8) {
  midi.inCount += [...u8].filter(b => b & 0x80).length;
  midi.last = midiNoteText(u8);
  // The Pi relays every note a file plays, so this runs dozens of times a second:
  // coalesce to one repaint per frame rather than one per note.
  if (!midi.paintQueued) { midi.paintQueued = true; requestAnimationFrame(() => { midi.paintQueued = false; midiPaint(); }); }
}

/* ---- transport 1: the bridge's /midi socket ---- */
function midiBridgeConnect(host) {
  midi.netHost = host;
  clearTimeout(midi.wsTimer);
  if (midi.ws) { try { midi.ws.close(); } catch (e) {} }
  let ws;
  try { ws = new WebSocket(`ws://${host}/midi`); } catch (e) { return; }
  ws.binaryType = 'arraybuffer';
  midi.ws = ws;
  ws.onopen = () => { midi.wsDelay = 1500; midiPaint(); midiRefreshFiles(); midiPollStart(); sysPollStart(); };
  ws.onmessage = ev => {
    if (typeof ev.data === 'string') {
      try { const m = JSON.parse(ev.data); if (m.midi === 'port' || m.midi === 'hello') { midi.status = Object.assign(midi.status || {}, { connected: !!m.connected, port: m.port }); midiPaint(); } } catch (e) {}
      return;
    }
    midiSawInput(new Uint8Array(ev.data));
  };
  ws.onclose = () => {
    if (midi.ws !== ws) return;
    midi.ws = null; midiPaint();
    if (midi.netHost) { midi.wsTimer = setTimeout(() => midiBridgeConnect(midi.netHost), midi.wsDelay); midi.wsDelay = Math.min(midi.wsDelay * 1.6, 15000); }
  };
}
function midiBridgeDisconnect() {
  midi.netHost = null; clearTimeout(midi.wsTimer); midiPollStop();
  if (midi.ws) { try { midi.ws.close(); } catch (e) {} midi.ws = null; }
  midi.files = []; midi.status = null; midiPaint();
  sysPollStop(); sys.status = null; sys.update = null; sysPaint();
}
async function midiApi(path, body) { return apiFetch(path, body); }
async function midiRefreshFiles() {
  if (!midi.netHost) return;
  try { const j = await midiApi('/midi-files/'); midi.files = j.files || []; } catch (e) { midi.files = []; }
  midiPaint();
  // Read each file back once (they are a few kB) so the panel can say whether
  // the preset in Studio actually answers what the file plays. Cached by size.
  for (const f of midi.files) {
    const key = f.name + '/' + (f.bytes || 0) + '/' + (f.mtime || 0);
    const hit = midiUseCache.get(key);
    if (hit) { f.uses = hit.uses; f.parsed = hit.parsed; continue; }
    try {
      const r = await fetch('/midi-files/' + encodeURIComponent(f.name));
      const parsed = parseSmf(await r.arrayBuffer());
      f.parsed = parsed; f.uses = midiUsage(parsed.events);
      midiUseCache.set(key, { uses: f.uses, parsed });
    } catch (e) { /* unreadable or not an SMF: no claim either way */ }
  }
  midiPaint(); scoreSync();
}
function midiPollStart() { midiPollStop(); midi.poll = setInterval(async () => { if (!midi.netHost) return; try { midi.status = await midiApi('/api/midi/status'); } catch (e) {} midiPaint(); scoreSync(); }, 1000); }
function midiPollStop() { clearInterval(midi.poll); midi.poll = null; }

/* ---- transport 2: Web MIDI (USB) ---- */
async function midiWebEnable() {
  if (!navigator.requestMIDIAccess) { consoleLog('err', 'Web MIDI needs Chrome or Edge'); return; }
  try { midi.access = await navigator.requestMIDIAccess({ sysex: false }); }
  catch (e) { consoleLog('err', 'Web MIDI access refused'); return; }
  const pick = () => {
    midi.out = [...midi.access.outputs.values()].find(o => /teensy|loop/i.test(o.name)) || null;
    const pin = [...midi.access.inputs.values()].find(i => /teensy|loop/i.test(i.name)) || null;
    if (midi.pedalIn && midi.pedalIn !== pin) midi.pedalIn.onmidimessage = null;
    midi.pedalIn = pin;
    if (pin) pin.onmidimessage = ev => midiSawInput(ev.data);
    midiPaint();
  };
  midi.access.onstatechange = pick;
  pick();
  consoleLog('ok', midi.out ? `Web MIDI: ${midi.out.name}` : 'Web MIDI on, but no pedal port found (is the pedal on USB?)');
}
function midiForwardController(id) {
  if (midi.ctlIn) { midi.ctlIn.onmidimessage = null; midi.ctlIn = null; }
  if (!id || !midi.access) return;
  const inp = midi.access.inputs.get(id);
  if (!inp) return;
  midi.ctlIn = inp;
  inp.onmidimessage = ev => { midiSend(ev.data); };
  consoleLog('ok', `Forwarding ${inp.name} to the pedal`);
}

/* ---- Standard MIDI File: parse + play (used when there is no bridge to do it) ---- */
function parseSmf(buf) {
  const d = new DataView(buf), b = new Uint8Array(buf);
  if (String.fromCharCode(...b.slice(0, 4)) !== 'MThd') throw new Error('not a MIDI file');
  const hlen = d.getUint32(4), ntracks = d.getUint16(10), division = d.getUint16(12);
  if (division & 0x8000) throw new Error('SMPTE-timed files are not supported');
  let pos = 8 + hlen, order = 0;
  const raw = [], tempo = [[0, 500000]], tsig = [];
  const vlq = (i) => { let v = 0, c; do { c = b[i++]; v = (v << 7) | (c & 0x7F); } while (c & 0x80); return [v, i]; };
  for (let t = 0; t < ntracks; t++) {
    if (String.fromCharCode(...b.slice(pos, pos + 4)) !== 'MTrk') break;
    const tlen = d.getUint32(pos + 4), end = pos + 8 + tlen;
    let i = pos + 8, tick = 0, status = 0;
    while (i < end) {
      let delta; [delta, i] = vlq(i); tick += delta;
      const x = b[i];
      if (x === 0xFF) { const typ = b[i + 1]; let ln; [ln, i] = vlq(i + 2); if (typ === 0x51 && ln === 3) tempo.push([tick, (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]]);
      if (typ === 0x58 && ln >= 2) tsig.push([tick, b[i], 1 << b[i + 1]]); i += ln; if (typ === 0x2F) break; continue; }
      if (x === 0xF0 || x === 0xF7) { let ln; [ln, i] = vlq(i + 1); i += ln; continue; }
      if (x & 0x80) { status = x; i++; }
      const kind = status & 0xF0, n = (kind === 0xC0 || kind === 0xD0) ? 1 : 2;
      raw.push([tick, order++, [status, ...b.slice(i, i + n)]]); i += n;
    }
    pos = end;
  }
  tempo.sort((a, c) => a[0] - c[0]); raw.sort((a, c) => a[0] - c[0] || a[1] - c[1]);
  const ev = []; let acc = 0, last = 0, ti = 0, cur = tempo[0][1];
  for (const [tick, , m] of raw) {
    while (ti + 1 < tempo.length && tempo[ti + 1][0] <= tick) { acc += (tempo[ti + 1][0] - last) * cur / division / 1e6; last = tempo[ti + 1][0]; cur = tempo[ti + 1][1]; ti++; }
    ev.push({ t: acc + (tick - last) * cur / division / 1e6, m });
  }
  // Musical time is kept alongside the seconds: the score needs ticks, the
  // ticks-per-quarter and the tempo/time-signature maps to draw bars at all.
  return { events: ev, length: ev.length ? ev[ev.length - 1].t : 0,
           ppq: division, tempos: tempo, tsig, raw: raw.map(r => ({ tick: r[0], m: r[2] })) };
}
/* ---- does the preset in Studio answer what a file plays? ----------------
   A MIDI file only makes a sound if some voice in the loaded preset is bound
   to the channel (and, for drum voices, the note) it sends. We read the
   bindings straight out of the emitted PatchScript — `obj.midi(ch, group)` for
   a melodic voice, `obj.midi(ch, group, note)` for one drum pad — so this works
   for hand-written custom routing exactly as it does for a built chain. */
function midiUsage(events) {
  const use = new Map();                                  // channel (1-16) -> Set of notes
  for (const e of events) {
    if ((e.m[0] & 0xF0) !== 0x90 || !e.m[2]) continue;    // note-on only
    const ch = (e.m[0] & 0x0F) + 1;
    if (!use.has(ch)) use.set(ch, new Set());
    use.get(ch).add(e.m[1]);
  }
  return use;
}
function presetBindings(preset) {
  if (!preset) return { any: new Set(), notes: new Map() };
  let text; try { text = generateText(preset); } catch (e) { return { any: new Set(), notes: new Map() }; }
  return diagBindingsFromText(text);          // GLS-DIAG shares the .midi() parser
}
/** null when the file is unparsed; otherwise the notes the Studio draft cannot play. */
function midiCoverage(file) {
  if (!file || !file.uses) return null;
  const gaps = diagCoverageGaps(file.uses, presetBindings(current()));
  return { ok: !gaps.length, gaps };
}
function midiCoverageNote(cov, subject) {
  if (!cov || cov.ok) return '';
  const parts = cov.gaps.map(g => {
    const shown = g.missing.slice(0, 5).map(n => n + ' ' + noteName(n)).join(', ');
    return `ch${g.ch} ${shown}${g.missing.length > 5 ? ` +${g.missing.length - 5} more` : ''}`;
  });
  const drums = cov.gaps.some(g => g.ch === 10);
  const full = drums && dev.presets.some(n => /fullkit/i.test(n));
  return `Nothing in ${subject || 'this preset'} answers ${parts.join(' · ')} — those notes will be silent. `
       + (full ? 'Load 11_fullkit.txt for the whole drum map, or add'
               : 'Add')
       + ' an instrument that covers them, then push the preset.';
}

/* ==========================================================================
   Score playback controls (NEW) — the pure scheduling core behind the local
   (Web MIDI) player: mute/solo, melodic transpose (channel 10 never moves),
   seeks that release held notes and chase controller state, and boundary
   releases. Times are SOURCE seconds — playback speed is the caller's clock
   concern. Mirrored by MidiPlayerLogic in pi/looper_bridge.py so the browser
   player and the Pi player behave identically.
   ========================================================================== */
const DRUM_CH0 = 9;                              // 0-based MIDI channel 10
const PLAY_SPEED_MIN = 0.25, PLAY_SPEED_MAX = 4, PLAY_TRANSPOSE_MAX = 24;

/* What the user asked playback to do, whichever player ends up doing it.
   mute/solo hold 1-based channel numbers; a/b are source seconds (both or
   neither); roll switches the score to the piano-roll view. */
const scoreCtl = { speed: 1, transpose: 0, mute: new Set(), solo: new Set(), a: null, b: null, roll: null };

function createPlayerCore(events, opts) {
  const core = {
    i: 0, held: new Map(),                       // 'ch/srcNote' -> note actually sent
    sustain: new Set(),                          // 0-based channels with the damper (CC64) down
    mute: new Set((opts && opts.mute) || []), solo: new Set((opts && opts.solo) || []),
    transpose: (opts && opts.transpose) | 0,
    audible(ch0) { const c = ch0 + 1; return core.solo.size ? core.solo.has(c) : !core.mute.has(c); },
    xform(m) {                                   // bytes to send for one file event, or null
      const st = m[0] & 0xF0, ch = m[0] & 0x0F, key = ch + '/' + m[1];
      if (st === 0x90 && m[2]) {                 // note on
        if (!core.audible(ch)) return null;
        let n = m[1];
        if (core.transpose && ch !== DRUM_CH0) {
          n += core.transpose;
          if (n < 0 || n > 127) return null;     // transposed off the keyboard
        }
        core.held.set(key, n);
        return [m[0], n, m[2]];
      }
      if (st === 0x80 || st === 0x90) {          // note off
        const sent = core.held.get(key);
        if (sent === undefined) return null;     // its note-on never sounded
        core.held.delete(key);
        return [m[0], sent, m.length > 2 ? m[2] : 0];
      }
      if (st === 0xB0 && m.length > 2 && m[1] === 64) {   // damper pedal: note-offs alone
        if (m[2] >= 64) core.sustain.add(ch);             // cannot end a note while it is
        else core.sustain.delete(ch);                     // down — release() must lift it
      }
      return Array.from(m);                      // CC / program / bend pass through
    },
    advance(to) {                                // everything due up to source time `to`
      const out = [];
      while (core.i < events.length && events[core.i].t <= to) {
        const m = core.xform(events[core.i].m);
        if (m) out.push(m);
        core.i++;
      }
      return out;
    },
    release() {                                  // stop / seek / loop boundary: nothing may hang
      // sustain up FIRST — a note-off while the damper is down keeps sounding
      const out = [];
      for (let ch = 0; ch < 16; ch++) out.push([0xB0 | ch, 64, 0]);
      core.sustain.clear();
      for (const [key, sent] of core.held) out.push([0x80 | +key.split('/')[0], sent, 0]);
      core.held.clear();
      for (let ch = 0; ch < 16; ch++) out.push([0xB0 | ch, 123, 0]);
      return out;
    },
    setFilters(f) {                              // live mute/solo/transpose change
      if (f.mute) core.mute = new Set(f.mute);
      if (f.solo) core.solo = new Set(f.solo);
      if (f.transpose !== undefined) core.transpose = f.transpose | 0;
      const out = [];
      // Sustain can hold sound after every physical key has been released.
      for (const ch of core.sustain) {
        if (!core.audible(ch)) { out.push([0xB0 | ch, 64, 0]); core.sustain.delete(ch); }
      }
      for (const [key, sent] of core.held) {
        const ch = +key.split('/')[0];
        if (!core.audible(ch)) {
          if (core.sustain.has(ch)) { out.push([0xB0 | ch, 64, 0]); core.sustain.delete(ch); }
          out.push([0x80 | ch, sent, 0]);
          core.held.delete(key);
        }
      }
      return out;
    },
    seek(t) {                                    // release, then chase program/CC/bend state to t
      const out = core.release();
      const prog = new Map(), ccs = new Map(), bend = new Map();
      let j = 0;
      while (j < events.length && events[j].t < t) {
        const m = events[j].m, st = m[0] & 0xF0, ch = m[0] & 0x0F;
        if (st === 0xC0) prog.set(ch, m[1]);
        else if (st === 0xB0 && m.length > 2 && m[1] < 120) ccs.set(ch + '/' + m[1], [ch, m[1], m[2]]);
        else if (st === 0xE0 && m.length > 2) bend.set(ch, [m[1], m[2]]);
        j++;
      }
      for (const [ch, p] of prog) out.push([0xC0 | ch, p]);
      for (const [, [ch, cc, v]] of ccs) out.push([0xB0 | ch, cc, v]);
      for (const [ch, [lo, hi]] of bend) out.push([0xE0 | ch, lo, hi]);
      // the chase may have put the damper back down — keep tracking honest
      core.sustain = new Set([...ccs.values()].filter(([, cc, v]) => cc === 64 && v >= 64).map(([ch]) => ch));
      core.i = j;
      return out;
    },
  };
  return core;
}

function midiLocalPlay(file, loop) {
  midiLocalStop();
  const core = createPlayerCore(file.events, scoreCtl);
  let anchorPos = 0, anchorAt = performance.now(), speed = scoreCtl.speed || 1, timer = null;
  const pos = () => Math.min(file.length, anchorPos + (performance.now() - anchorAt) / 1000 * speed);
  const rebase = p => { anchorPos = p; anchorAt = performance.now(); };
  const emit = msgs => { for (const m of msgs) midiSend(m); };
  const seekTo = t => { t = Math.max(0, Math.min(file.length, t)); emit(core.seek(t)); rebase(t); };
  const tick = () => {
    // the A/B passage is a place in the score panel's file, so it only steers
    // playback of that file (matches what the bridge is sent)
    const ab = scoreCtl.b !== null && file.name === score.file;
    const end = ab ? Math.min(scoreCtl.b, file.length) : file.length;
    let now = pos();
    if (now >= end - 1e-6) {
      emit(core.advance(end));                    // anything due right at the boundary
      emit(core.release());
      if (ab) seekTo(scoreCtl.a || 0);            // A/B repeat wraps regardless of loop
      else if (loop) seekTo(0);
      else { midi.player = null; midiPaint(); return; }
      now = pos();
    }
    emit(core.advance(Math.min(now + 0.004 * speed, end)));
    midi.player.pos = now;
    timer = setTimeout(tick, 4);
  };
  midi.player = {
    name: file.name, length: file.length, pos: 0,
    stop() { clearTimeout(timer); emit(core.release()); },
    seek(t) { seekTo(t); midi.player.pos = pos(); },
    applyCtl() {                                  // scoreCtl changed: re-anchor, refilter
      rebase(pos());
      speed = scoreCtl.speed || 1;
      emit(core.setFilters({ mute: scoreCtl.mute, solo: scoreCtl.solo, transpose: scoreCtl.transpose }));
    },
  };
  tick();
  midiPaint();
}
function midiLocalStop() { if (midi.player) { midi.player.stop(); midi.player = null; midiPaint(); } }

/* ==========================================================================
   GLS-DIAG BEGIN — diagnostics + confirmed running preset (extractable module)
   ----------------------------------------------------------------------------
   Everything the "no sound?" panel and the device-truth MIDI coverage marks
   need, kept in one section so it can later be lifted into its own file.
   The pure logic lives in createDiagnostics(deps) and the diag* helpers below
   it, with no DOM or globals, so Node can unit-test it (editor/tests/); the
   browser wiring and the panel renderer sit at the end behind a
   `typeof document` guard.

   The honesty rules this module enforces:
   - "Running on pedal" is only ever CONFIRMED content: the exact bytes of a
     successful `apply`, or a preset file read back from the device whose
     fingerprint MATCHES the device-reported fingerprint of the running patch
     ("fp" in #STATUS / #OK, firmware 2.2.2+). A file read back by name alone
     proves nothing — another client may have overwritten that filename after
     it was loaded — so without a device fingerprint a read-back stays
     unknown. The Studio draft never stands in for hardware.
   - Confirmation is invalidated on disconnect/unplug, on an external preset
     change (#EVT), and — on firmware 2.2.2+ — whenever the reported patch
     revision ("rev") or fingerprint ("fp") no longer matches what we
     confirmed. The firmware clears its fingerprint (and bumps rev) when a
     rare mid-apply failure falls back to dry bypass, so that case
     invalidates itself too.
   - MIDI transmit counts are never presented as proof a note sounded; voice
     triggers are only claimed when the firmware reports its trigger counter.
   - The test tone is generated by the pedal itself and stops itself there;
     old firmware without the `tone` command is reported as such, honestly.
   ========================================================================== */

/** Exact patch identity: 32-bit FNV-1a over the raw UTF-8 bytes plus their
 *  length ("hhhhhhhh-len") — the same computation the firmware makes over the
 *  bytes it successfully applied (PatchManager::patchFp), so the two sides can
 *  be compared literally. */
const diagEnc = new TextEncoder();
function diagFingerprint(text) {
  const bytes = diagEnc.encode(text || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0') + '-' + bytes.length;
}

/** obj.midi(ch[, group[, note]]) bindings straight out of PatchScript text —
 *  works for generated chains and hand-written custom routing alike (the text
 *  is used verbatim; chain-meta and custom routing metadata are untouched). */
function diagBindingsFromText(text) {
  const any = new Set(), notes = new Map();               // channels bound wholesale / per note
  const re = /\.midi\s*\(\s*(\d+)\s*(?:,[^,)]*(?:,\s*(\d+)\s*)?)?\)/g;
  let m;
  while ((m = re.exec(text || ''))) {
    const ch = +m[1];
    if (m[2] === undefined) any.add(ch);
    else { if (!notes.has(ch)) notes.set(ch, new Set()); notes.get(ch).add(+m[2]); }
  }
  return { any, notes };
}

/** Which of a file's notes (Map channel -> Set of notes) the bindings miss. */
function diagCoverageGaps(uses, b) {
  const gaps = [];
  for (const [ch, notes] of uses) {
    if (b.any.has(ch)) continue;                          // melodic voice takes any note
    const have = b.notes.get(ch);
    const missing = [...notes].filter(n => !have || !have.has(n)).sort((x, y) => x - y);
    if (missing.length) gaps.push({ ch, missing, partial: !!have });
  }
  return gaps;
}

/** "// name: Title" out of a patch text (same convention the firmware uses). */
function diagTitleFromText(text) {
  const m = /\/\/\s*name:\s*(.+)/.exec(text || '');
  return m ? m[1].trim() : '';
}

/** "rev=N" out of an #OK acknowledgement (firmware 2.2.2+); null when absent. */
function diagRevFromAck(txt) {
  const m = /(?:^|\s)rev=(\d+)\b/.exec(txt || '');
  return m ? +m[1] : null;
}

/** "fp=hhhhhhhh-len" out of an #OK acknowledgement; null when absent. */
function diagFpFromAck(txt) {
  const m = /(?:^|\s)fp=([0-9a-f]{8}-\d+)\b/.exec(txt || '');
  return m ? m[1] : null;
}

/**
 * The diagnostics state machine. deps:
 *   now()                     — ms clock
 *   setTimeout(fn, ms) / clearTimeout(id)
 *   send(line, opts)          — device command, resolves like sendCmd
 *   getPresetText(name)       — read a preset file back from the device
 *   onChange()                — notify the UI (may be null)
 */
