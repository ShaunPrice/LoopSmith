function createDiagnostics(deps) {
  const d = {
    connected: false,
    running: null,             // { name, title, fingerprint, bindings, source, rev, at } — CONFIRMED only
    runningUnknownWhy: 'not connected',
    lastApply: null,           // { ok, at, error }
    tone: { supported: null, active: false, until: 0, timer: null, lastError: null },
    status: null,              // last raw #STATUS payload
    counters: null,            // { rx, trig, voices } when the firmware reports them
    lastRxAt: 0, lastTrigAt: 0,
    hasRev: false,             // firmware reports a patch revision
    hasFp: false,              // firmware reports the running patch fingerprint
    _confirmSeq: 0, _confirmTimer: null,
    _retryName: null,          // read-back waiting for the first fingerprinting #STATUS
  };
  const changed = () => { if (deps.onChange) deps.onChange(); };
  const invalidate = why => { d.running = null; d.runningUnknownWhy = why; changed(); };

  d.onConnect = () => {
    d.connected = true;
    d.tone.supported = null; d.tone.active = false; d.tone.lastError = null;
    d.status = null; d.counters = null; d.hasRev = false; d.hasFp = false;
    d.lastApply = null; d._retryName = null;
    d._confirmSeq++;                       // a confirm from a previous link must not land
    invalidate('nothing confirmed since connecting');
  };

  d.onDisconnect = why => {
    d.connected = false;
    d._confirmSeq++;                       // a confirm still in flight must not land
    d._retryName = null;
    if (d._confirmTimer) { deps.clearTimeout(d._confirmTimer); d._confirmTimer = null; }
    if (d.tone.timer) { deps.clearTimeout(d.tone.timer); d.tone.timer = null; }
    d.tone.active = false;                 // the firmware stops its own tone
    invalidate(why || 'disconnected');
  };

  d.onStatus = st => {
    d.status = st;
    if (typeof st.rev === 'number') {
      d.hasRev = true;
      if (d.running) {
        if (d.running.rev == null) d.running.rev = st.rev;         // adopt the first rev seen after confirming
        else if (st.rev !== d.running.rev) invalidate('the patch changed on the pedal');
      }
    }
    if (typeof st.fp === 'string') {
      d.hasFp = true;
      // the strongest check: the device's fingerprint of the RUNNING bytes must
      // literally equal the fingerprint of what we confirmed ("" = no patch —
      // e.g. the dry-bypass fallback after a rare mid-apply failure)
      if (d.running && st.fp !== d.running.fingerprint)
        invalidate('the patch changed on the pedal');
      // a read-back that arrived before any fingerprinting status: retry now
      if (!d.running && d._retryName) {
        const n = d._retryName;
        d._retryName = null;
        d.confirmByName(n);
      }
    }
    if (st.midi && typeof st.midi.rx === 'number') {
      const prev = d.counters;
      if (prev) {
        if (st.midi.rx > prev.rx) d.lastRxAt = deps.now();
        if (st.midi.trig > prev.trig) d.lastTrigAt = deps.now();
      }
      d.counters = st.midi;
    }
    if (typeof st.tone === 'boolean') {
      if (d.tone.supported === null) d.tone.supported = true;
      if (st.tone) d.tone.active = true;
      // a "false" only clears the tone once its own deadline has passed — a
      // status emitted just before our tone started also says false
      else if (d.tone.active && deps.now() >= d.tone.until) d.tone.active = false;
    }
    changed();
  };

  d.onEvent = ev => {
    if (typeof ev.tone === 'boolean') {
      d.tone.supported = true;
      d.tone.active = ev.tone;
      if (!ev.tone && d.tone.timer) { deps.clearTimeout(d.tone.timer); d.tone.timer = null; }
      changed();
    }
    // an external preset change (footswitch, MIDI program change): the new
    // identity is known, the content is not — re-confirm by reading it back.
    // (an empty name is the firmware noting a live-applied patch — not a change)
    if (typeof ev.preset === 'string' && ev.preset) {
      if (!d.running || d.running.name !== ev.preset || d.running.source === 'apply') {
        invalidate('the pedal switched presets');
        d.confirmByName(ev.preset);
      }
    }
  };

  /** A live `apply` settled. On success the running patch is exactly the text
   *  we sent (cross-checked against the device's own fingerprint when the ack
   *  carries one). On failure the firmware usually keeps the previous graph,
   *  but a rare mid-apply failure falls back to dry bypass: with a
   *  fingerprinting firmware that case invalidates itself via #STATUS (the fp
   *  goes empty); without one Studio cannot tell which happened, so it stops
   *  claiming anything rather than promise the prior patch is unchanged. */
  d.onApplyResult = (ok, text, ackOrErr) => {
    d.lastApply = { ok, at: deps.now(), error: ok ? null : String(ackOrErr || 'apply failed') };
    if (ok) {
      const fp = diagFingerprint(text);
      const ackFp = diagFpFromAck(ackOrErr);
      if (ackFp) d.hasFp = true;
      d._confirmSeq++;                     // outrank any confirm-by-name in flight
      d._retryName = null;
      if (ackFp && ackFp !== fp) {
        // the device hashed different bytes than Studio thinks it sent
        d.running = null;
        d.runningUnknownWhy = 'the pedal reports a different fingerprint than the bytes Studio sent';
      } else {
        d.running = {
          name: null, title: diagTitleFromText(text), fingerprint: fp,
          bindings: diagBindingsFromText(text), source: 'apply',
          rev: diagRevFromAck(ackOrErr), at: deps.now(),
        };
        d.runningUnknownWhy = null;
      }
    } else if (!d.hasFp && d.running) {
      d._confirmSeq++;
      d.running = null;
      d.runningUnknownWhy = 'the apply failed — the pedal kept its previous patch or fell back to bypass; this firmware cannot say which';
    }
    changed();
  };

  /** The device acknowledged loading a stored preset (our command or the ack
   *  of next/prev). Content still has to be read back — and its fingerprint
   *  verified against the device's — to be confirmed. */
  d.onDeviceLoad = (name, ackText) => {
    invalidate('confirming ' + name + '…');
    d.confirmByName(name, diagRevFromAck(ackText), diagFpFromAck(ackText));
  };

  /** Read `name` back from the device and, if nothing newer superseded the
   *  request AND its fingerprint matches the device's fingerprint of the
   *  running patch, record it as confirmed. A matching NAME is not evidence:
   *  another client may have overwritten that file after it was loaded, so
   *  without a device fingerprint (ack `fp=` or #STATUS `fp`) the read-back
   *  stays unknown — honestly so on legacy firmware.
   *  Debounced so rapid next/next/next fetches once, for the final preset;
   *  the fetch itself goes through the ordinary one-at-a-time command queue,
   *  so it waits behind (and never interleaves with) counted transfers. */
  d.confirmByName = (name, rev, ackFp) => {
    if (!name || !d.connected) return;
    if (ackFp) d.hasFp = true;
    const seq = ++d._confirmSeq;
    if (d._confirmTimer) deps.clearTimeout(d._confirmTimer);
    d._confirmTimer = deps.setTimeout(() => {
      d._confirmTimer = null;
      Promise.resolve(deps.getPresetText(name)).then(text => {
        if (seq !== d._confirmSeq || typeof text !== 'string') return;
        const fp = diagFingerprint(text);
        const expected = ackFp || (d.status && typeof d.status.fp === 'string' ? d.status.fp : null);
        if (expected == null) {
          // no device fingerprint yet: retry when a fingerprinting #STATUS
          // arrives (new firmware), or stay honestly unknown (legacy)
          d._retryName = name;
          d.runningUnknownWhy = d.hasFp
            ? 'waiting for the pedal to report its running fingerprint'
            : 'this firmware cannot prove the stored file matches the running patch — Apply from Studio to confirm';
          changed();
          return;
        }
        if (fp !== expected) {
          // the stored file is not what is running (overwritten since it was
          // loaded, or the pedal moved on). If an earlier confirmation is
          // still standing (its fp still matches #STATUS), keep it — it is
          // still true; otherwise say why we cannot confirm.
          if (!d.running) {
            d.runningUnknownWhy = 'the stored file ' + name + ' no longer matches the running patch (overwritten since it was loaded?)';
            changed();
          }
          return;
        }
        d.running = {
          name, title: diagTitleFromText(text) || name, fingerprint: fp,
          bindings: diagBindingsFromText(text), source: 'load',
          rev: rev != null ? rev : null, at: deps.now(),
        };
        d.runningUnknownWhy = null;
        changed();
      }).catch(e => {
        if (seq !== d._confirmSeq) return;
        d.runningUnknownWhy = 'could not read ' + name + ' back (' + (e && e.message) + ')';
        changed();
      });
    }, 250);
  };

  /** Device-truth coverage of a MIDI file's usage map. Unknown when nothing is
   *  confirmed — never judged against the Studio draft. */
  d.coverageForUses = uses => {
    if (!uses) return null;
    if (!d.connected) return { state: 'unknown', why: 'not connected' };
    if (!d.running) return { state: 'unknown', why: d.runningUnknownWhy || 'nothing confirmed yet' };
    const gaps = diagCoverageGaps(uses, d.running.bindings);
    return { state: gaps.length ? 'warn' : 'ok', gaps, running: d.running };
  };

  /** Editing vs Running vs Unsaved-to-device, from the draft's current text. */
  d.editorState = draftText => {
    if (!d.connected) return { state: 'offline' };
    if (!d.running) return { state: 'unknown', why: d.runningUnknownWhy };
    const df = typeof draftText === 'string' ? diagFingerprint(draftText) : null;
    return { state: df && df === d.running.fingerprint ? 'in-sync' : 'differs', running: d.running };
  };

  /** Short label for the confirmed running patch. */
  d.runningLabel = () => {
    if (!d.running) return null;
    const what = d.running.title || d.running.name || 'live patch';
    const how = d.running.source === 'apply' ? 'confirmed via apply' : 'read back after load';
    return what + ' · ' + how + (d.running.rev != null ? ' · rev ' + d.running.rev : '');
  };

  /** Start the pedal's own quiet test tone (it stops itself on the device;
   *  the timer here only tidies the UI). */
  d.toneStart = opts => {
    opts = opts || {};
    const ms = Math.max(100, Math.min(5000, opts.ms || 1000));
    if (!d.connected) return Promise.resolve({ ok: false, reason: 'not connected' });
    if (d.tone.supported === false) return Promise.resolve({ ok: false, reason: 'unsupported' });
    let line = 'tone ' + ms;
    if (opts.freq) line += ' ' + opts.freq;
    if (opts.level) line += ' ' + opts.level;
    return Promise.resolve(deps.send(line, { timeout: 3000 })).then(() => {
      d.tone.supported = true; d.tone.active = true; d.tone.lastError = null;
      d.tone.until = deps.now() + ms;
      if (d.tone.timer) deps.clearTimeout(d.tone.timer);
      d.tone.timer = deps.setTimeout(() => { d.tone.timer = null; d.tone.active = false; changed(); }, ms + 500);
      changed();
      return { ok: true, ms };
    }).catch(e => {
      const msg = (e && e.message) || 'failed';
      if (/unknown command/i.test(msg)) d.tone.supported = false;   // old firmware: no generator
      d.tone.lastError = msg;
      changed();
      return { ok: false, reason: d.tone.supported === false ? 'unsupported' : msg };
    });
  };

  d.toneStop = () => {
    if (d.tone.timer) { deps.clearTimeout(d.tone.timer); d.tone.timer = null; }
    d.tone.active = false;
    changed();
    if (d.connected && d.tone.supported)
      return Promise.resolve(deps.send('tone off', { timeout: 3000 })).catch(() => {});
    return Promise.resolve();
  };

  /** The "no sound?" findings, from measured state only. `midiSent` is how
   *  many MIDI events this browser/bridge transmitted (evidence of sending,
   *  never of sounding). */
  d.findings = midiSent => {
    const out = [];
    if (!d.connected) {
      out.push({ level: 'warn', text: 'Not connected — connect over USB or the network first.' });
      return out;
    }
    const st = d.status;
    if (!st) {
      out.push({ level: 'note', text: 'Waiting for the first status report from the pedal…' });
      return out;
    }
    if (st.output_muted === true)
      out.push({ level: 'warn', text: 'Panic has muted all outputs. Use Resume audio in the top transport to hear the pedal again.' });
    const vol = typeof st.volume === 'number' ? st.volume : null;
    if (vol !== null && vol <= 0.02)
      out.push({ level: 'warn', text: 'Pedal volume is ' + Math.round(vol * 100) + '% — turn it up (VOL in the OUTPUT section).' });
    else if (vol !== null && vol < 0.2)
      out.push({ level: 'note', text: 'Pedal volume is only ' + Math.round(vol * 100) + '%.' });
    if (st.source === 'usb')
      out.push({ level: 'warn', text: 'The instrument source is USB audio, not the input jack — a guitar plugged into line-in stays silent until you switch back (source line).' });
    if (st.bypass === true)
      out.push({ level: 'note', text: 'FX bypass is ON: the guitar passes through dry, but effects and synth instruments are muted.' });
    const pin = st.peak_in, pout = st.peak_out;
    if (typeof pin === 'number' && typeof pout === 'number') {
      if (pin < 0.01 && pout < 0.01)
        out.push({ level: 'note', text: 'No input or output signal is being measured right now — play something (or run the test tone) while watching the IN/OUT meters.' });
      else if (pin >= 0.05 && pout < 0.01)
        out.push({ level: 'warn', text: 'Input arrives (peak ' + pin.toFixed(2) + ') but the output is silent — the running patch may be muting it. Try bypass, reload the preset, or apply a known-good one.' });
      if (pout >= 0.05)
        out.push({ level: 'ok', text: 'Digital audio is reaching the output stage (peak ' + pout.toFixed(2) + '). That is measured before the codec, so Studio cannot verify the analogue path — if you still hear nothing, check the codec volume, output selection, the lead in the OUT jack, and the speaker (hardware checklist below).' });
    }
    // MIDI: reception/trigger evidence, never inferred from transmission
    if (d.counters) {
      const c = d.counters;
      let t = 'The pedal reports ' + c.rx + ' MIDI note events received and ' + c.trig + ' voice triggers'
            + ' (' + c.voices + (c.voices === 1 ? ' voice' : ' voices') + ' bound in the running patch).';
      if (midiSent > 0 && c.voices === 0)
        out.push({ level: 'warn', text: t + ' Notes are being sent, but the running patch has no MIDI-bound instrument to play them.' });
      else if (midiSent > 0 && c.trig === 0)
        out.push({ level: 'warn', text: t + ' Notes are being sent but no voice has fired — check the channels the file uses against the running patch (coverage marks in the MIDI panel).' });
      else
        out.push({ level: 'note', text: t });
    } else if (midiSent > 0) {
      out.push({ level: 'note', text: midiSent + ' MIDI events were transmitted to the pedal, but this firmware does not report reception or voice triggers — Studio cannot confirm they arrived or made a sound (firmware 2.2.2+ reports both).' });
    }
    return out;
  };

  return d;
}

/* ---- Node export so editor/tests/ can unit-test the pure logic ---- */
if (typeof module !== 'undefined' && module.exports)
  module.exports = { createDiagnostics, diagFingerprint, diagBindingsFromText,
                     diagCoverageGaps, diagTitleFromText, diagRevFromAck, diagFpFromAck };

/* ---- browser wiring (hooks called from the device link / MIDI panel) ---- */
let diag = null;

function diagOnStatus(st) { if (diag) diag.onStatus(st); }
function diagOnEvent(ev) { if (diag) diag.onEvent(ev); }
function diagOnDeviceLoad(name, ack) { if (diag) diag.onDeviceLoad(name, ack); }
function diagOnApplyResult(ok, text, ack) { if (diag) diag.onApplyResult(ok, text, ack); }
function diagOnLinkDown(why) { if (diag) diag.onDisconnect(why); }
function diagOnConnect() {
  if (!diag) return;
  diag.onConnect();
  // the pedal told us which stored preset it is running — read it back so the
  // session starts with confirmed content (a live-applied patch stays unknown)
  const name = dev.currentIndex >= 0 ? dev.presets[dev.currentIndex] : '';
  if (name) diag.confirmByName(name);
  diagPaintSoon();
}

/** Coverage of a MIDI file against the CONFIRMED running patch (not the draft). */
function deviceMidiCoverage(file) {
  if (!file || !file.uses || !diag) return null;
  return diag.coverageForUses(file.uses);
}
function deviceMidiCoverageNote(cov, file) {
  if (!cov) return '';
  if (cov.state === 'unknown') {
    const dc = midiCoverage(file);
    let t = 'Studio has not confirmed what the pedal is running (' + (cov.why || 'unknown') + '), '
          + 'so it cannot say whether these notes will sound. Apply the current preset or load one '
          + 'from DEVICE PRESETS to confirm.';
    if (dc) t += dc.ok ? ' The draft open in Studio does cover this file.'
                       : ' The draft open in Studio would also miss some of its notes.';
    return t;
  }
  if (cov.state === 'ok') return '';
  const subject = 'the patch running on the pedal ('
    + ((cov.running && (cov.running.title || cov.running.name)) || 'live patch') + ')';
  let t = midiCoverageNote({ ok: false, gaps: cov.gaps }, subject);
  const dc = midiCoverage(file);
  if (dc && dc.ok) t += ' The draft open in Studio does cover it — Apply it, or Push and Load it.';
  return t;
}
/** Repaint key for the MIDI rows: coverage marks depend on the running patch. */
function diagCoverageSig() {
  if (!diag) return 'off';
  return diag.running ? diag.running.fingerprint + ':' + (diag.running.rev == null ? '' : diag.running.rev)
                      : 'none:' + (diag.runningUnknownWhy || '') + ':' + (diag.connected ? 1 : 0);
}

/* ---- diagnostics panel (device column) ---- */
let diagPaintTimer = null;
function diagPaintSoon() {
  if (typeof document === 'undefined' || diagPaintTimer) return;
  diagPaintTimer = setTimeout(() => { diagPaintTimer = null; diagPaint(); }, 100);
}

function diagBuildSection() {
  const sec = document.createElement('div');
  sec.className = 'dev-sec coll closed'; sec.id = 'diagSec';
  sec.innerHTML = `<h3 role="button" tabindex="0" aria-expanded="false" aria-controls="diagBody"><span class="caret">▼</span> NO SOUND? · DIAGNOSTICS</h3>
  <div class="sec-body" id="diagBody">
    <div class="midi-line"><span>Editing</span><span class="mono" id="diagEditing">—</span></div>
    <div class="midi-line"><span>Running on pedal</span><span class="mono" id="diagRunning">—</span></div>
    <div class="diag-sync" id="diagSync"></div>
    <div class="midi-line"><span>Signal</span><span class="mono" id="diagSignal">—</span></div>
    <div class="actions-row">
      <button class="btn sm" id="diagToneBtn" title="A quiet 1-second tone from the pedal itself, analogue out only — it stops on its own and the running preset, loop and USB audio are untouched">Play test tone</button>
      <button class="btn sm" id="diagRecheckBtn" title="Read the running preset back from the pedal">Re-check</button>
    </div>
    <div class="play-hint" id="diagToneHint"></div>
    <div id="diagFindings"></div>
    <div class="hint" style="margin-top:6px" id="diagHw">Things Studio cannot measure — worth checking by hand:
      the powered speaker is on and its battery is not flat (a flat speaker is perfectly silent),
      the lead is seated all the way into the OUT jack and the speaker’s input,
      the speaker/amp volume is up, and the pedal’s power light is on.</div>
  </div>`;
  $('#outputSec').insertAdjacentElement('afterend', sec);
  const h = sec.querySelector('h3');
  const toggle = () => {
    sec.classList.toggle('closed');
    h.setAttribute('aria-expanded', String(!sec.classList.contains('closed')));
    if (!sec.classList.contains('closed')) diagPaint();
  };
  h.addEventListener('click', toggle);
  h.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  $('#diagToneBtn').addEventListener('click', async () => {
    if (!diag) return;
    if (diag.tone.active) { await diag.toneStop(); return; }
    const r = await diag.toneStart({ ms: 1000 });
    if (!r.ok && r.reason === 'unsupported')
      consoleLog('err', 'This firmware has no test-tone generator — it needs firmware 2.2.2 or newer.');
    diagPaint();
  });
  $('#diagRecheckBtn').addEventListener('click', () => {
    if (!diag || !link.connected) return;
    refreshDeviceList().then(() => {
      const name = dev.currentIndex >= 0 ? dev.presets[dev.currentIndex] : '';
      if (name) diag.confirmByName(name);
      else if (!diag.running) { diag.runningUnknownWhy = 'the pedal is running a live-applied patch — Apply from Studio to confirm it'; diagPaint(); }
    });
  });
  diagPaint();
}

function diagPaint() {
  const sec = $('#diagSec');
  if (!sec || !diag) return;
  midiPaint();                                    // coverage marks share this state
  if (sec.classList.contains('closed')) return;   // panel body hidden — skip the work
  const p = current();
  const draftText = p ? generateText(p) : '';
  $('#diagEditing').textContent = p ? (p.title || ensureFileName(p)) : '—';
  const es = diag.editorState(draftText);
  const run = $('#diagRunning'), sync = $('#diagSync');
  if (es.state === 'offline') {
    run.textContent = 'not connected';
    sync.textContent = ''; sync.className = 'diag-sync';
  } else if (es.state === 'unknown') {
    run.textContent = 'unknown — ' + (es.why || 'nothing confirmed');
    sync.textContent = 'Studio will not guess: apply or load a preset to confirm what the pedal is running.';
    sync.className = 'diag-sync';
  } else {
    run.textContent = diag.runningLabel();
    const same = es.state === 'in-sync';
    sync.textContent = same ? 'The draft in Studio matches what is confirmed running.'
                            : 'The draft in Studio differs from what is running — unapplied changes (Apply live, or Push + Load).';
    sync.className = 'diag-sync ' + (same ? 'insync' : 'differs');
  }
  const st = diag.status;
  $('#diagSignal').textContent = st
    ? 'in ' + (st.peak_in != null ? st.peak_in.toFixed(2) : '?')
      + ' · out ' + (st.peak_out != null ? st.peak_out.toFixed(2) : '?')
      + ' · vol ' + (st.volume != null ? Math.round(st.volume * 100) + '%' : '?')
      + ' · ' + (st.source || 'line') + (st.bypass ? ' · BYPASS' : '')
    : '—';
  const toneBtn = $('#diagToneBtn'), toneHint = $('#diagToneHint');
  toneBtn.disabled = !link.connected || diag.tone.supported === false;
  toneBtn.textContent = diag.tone.active ? '■ Stop tone' : 'Play test tone';
  toneHint.textContent =
      diag.tone.supported === false ? 'Not available: this firmware (before 2.2.2) has no test-tone generator, so Studio cannot make the pedal beep. Everything else here still works.'
    : diag.tone.active ? 'Playing a quiet tone from the pedal — it stops by itself and goes to the analogue headphone/line out only (never USB audio). If the OUT meter moves and you hear nothing, digital audio is being generated but the analogue side (codec volume, cable, speaker) still cannot be verified in software — check those by hand.'
    : diag.tone.lastError ? 'Test tone: ' + diag.tone.lastError
    : '';
  const box = $('#diagFindings');
  box.textContent = '';
  const sent = midi.outCount + ((midi.status && midi.status.out_events) || 0);
  for (const f of diag.findings(sent)) {
    const div = document.createElement('div');
    div.className = 'diag-item ' + f.level;
    div.textContent = f.text;
    box.appendChild(div);
  }
}

if (typeof document !== 'undefined') {
  diag = createDiagnostics({
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    send: (line, opts) => sendCmd(line, opts),
    getPresetText: name => sendCmd('get ' + name, { kind: 'get' }).then(r => r && r.content),
    onChange: () => diagPaintSoon(),
  });
}
/* ==========================================================================
   GLS-DIAG END
   ========================================================================== */

