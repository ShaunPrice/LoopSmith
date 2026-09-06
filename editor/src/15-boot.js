/* ============================================================================
   11. Wiring & boot
   ========================================================================== */
/* Persistent transport: commands are pending until acknowledged, never optimistic. */
function createTransportGate(changed) {
  return { busy: false, message: '', async run(label, action) {
    if (this.busy) return false;
    this.busy = true; this.message = label + '…'; changed();
    try { await action(); this.message = ''; return true; }
    catch (e) { this.message = (e && e.name === 'AbortError') ? 'Request timed out; playback state is unconfirmed. Check the connection.' : (e.message || String(e)); return false; }
    finally { this.busy = false; changed(); }
  }};
}
const performanceTransport = createTransportGate(() => { midi.listSig = ''; midiPaint(); transportPaint(); });
async function transportRequest(path, body) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(path, { signal: controller.signal, ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    if (res.status === 401) { needSignIn(); throw new Error('Sign in to control playback'); }
    const value = await res.json();
    if (!res.ok || value.ok === false) throw new Error(value.message || 'Playback request failed');
    return value;
  } finally { clearTimeout(timer); }
}
async function transportStopMidi() {
  if (midi.netHost) {
    await transportRequest('/api/midi/stop', {});
    midi.status = await transportRequest('/api/midi/status');
    if (midi.status.playing) throw new Error('The Pi still reports MIDI playing');
  }
  midiLocalStop();
}
function transportMidiFile(file) {
  return performanceTransport.run('Changing playback', async () => {
    const playing = midi.netHost ? (midi.status || {}).playing && midi.status.file === file.name : midi.player && midi.player.name === file.name;
    if (playing) { await transportStopMidi(); return; }
    if (midi.netHost) {
      await transportRequest('/api/midi/play', Object.assign({ file: file.name, loop: midi.loop }, file.name === score.file ? scoreCtlParams() : {}));
      midi.status = await transportRequest('/api/midi/status');
    } else {
      if (!midi.out) throw new Error('Enable Web MIDI and connect a MIDI output first');
      midiLocalPlay(file, midi.loop);
    }
  });
}
function transportInit() {
  const bar = document.createElement('div'); bar.id = 'performanceTransport';
  bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Performance transport');
  bar.innerHTML = `<button class="btn sm" id="performPlay">▶ Play MIDI</button>
    <button class="btn sm" id="performStop">■ Stop all</button>
    <button class="btn sm danger" id="performPanic">Panic / mute output</button>
    <button class="btn sm" id="performResume" hidden>Resume audio</button>
    <span id="performPosition" class="mono"></span><span id="performMessage" role="status" aria-live="polite"></span>`;
  $('#topbar').appendChild(bar);
  $('#performPlay').onclick = () => {
    const files = midi.netHost ? midi.files : midi.local;
    const name = score.file || (midi.status || {}).file;
    const file = files.find(f => f.name === name) || files[0];
    if (file) transportMidiFile(file);
    else { performanceTransport.message = 'Upload or select a MIDI file first'; transportPaint(); }
  };
  $('#performStop').onclick = () => performanceTransport.run('Stopping', async () => {
    const errors = [];
    try { await transportStopMidi(); } catch (e) { errors.push(e.message); }
    if (link.connected && link.pedalPresent !== false) {
      try { await sendCmd('looper halt'); await sendCmd('status'); }
      catch (e) { errors.push('Looper stop unconfirmed: ' + e.message); }
    }
    if (errors.length) throw new Error(errors.join(' · '));
  });
  $('#performPanic').onclick = () => performanceTransport.run('Muting output', async () => {
    // Mute first, before any network player stop latency. No loop data is erased.
    const errors = [];
    try { await sendCmd('panic'); await sendCmd('status'); }
    catch (e) { errors.push('Output mute unconfirmed (requires updated firmware): ' + e.message); }
    try { await transportStopMidi(); } catch (e) { errors.push(e.message); }
    flushHeldNotes();
    for (let ch = 0; ch < 16; ch++) midiSend([0xB0 | ch, 123, 0]);
    if (errors.length) throw new Error(errors.join(' · '));
  });
  $('#performResume').onclick = () => performanceTransport.run('Resuming output', async () => {
    await sendCmd('resume'); await sendCmd('status');
  });
  transportPaint();
}
function transportPaint() {
  if (!$('#performPlay')) return;
  const state = midi.netHost ? midi.status || {} : { playing: !!midi.player, file: midi.player && midi.player.name, position_s: midi.player && midi.player.pos };
  const busy = performanceTransport.busy;
  $('#performPlay').textContent = state.playing ? '■ Stop MIDI' : '▶ Play MIDI';
  // While a different file is selected, Stop MIDI must still stop the actual player.
  $('#performPlay').onclick = state.playing
    ? () => performanceTransport.run('Stopping MIDI', transportStopMidi)
    : () => { const files = midi.netHost ? midi.files : midi.local; const f = files.find(x => x.name === score.file) || files[0];
        if (f) transportMidiFile(f); else { performanceTransport.message = 'Upload or select a MIDI file first'; transportPaint(); } };
  $('#performPlay').disabled = busy || !(midi.netHost || midi.out);
  $('#performStop').disabled = busy || !(midi.netHost || midi.out || link.connected);
  $('#performPanic').disabled = busy || !link.connected;
  $('#performResume').disabled = busy || !link.connected;
  $('#performResume').hidden = !(link.connected && dev.status && dev.status.output_muted === true);
  $('#performPanic').classList.toggle('active', !$('#performResume').hidden);
  $('#performPosition').textContent = state.playing ? `${state.file || 'MIDI'} · ${(state.position_s || 0).toFixed(1)} s` : 'MIDI stopped';
  $('#performMessage').textContent = performanceTransport.message;
}

function init() {
  $ = s => document.querySelector(s);
  store.load();

  /* feature detection */
  if (!('serial' in navigator)) {
    $('#serialBanner').hidden = false;
    $('#connectBtn').style.display = 'none';
  } else {
    navigator.serial.addEventListener('disconnect', e => {
      if (link.port && e.target === link.port) serialDisconnect();
    });
  }
  if (!('showDirectoryPicker' in window)) {
    $('#sdOpenBtn').style.display = 'none';
    $('#sdUnsupported').hidden = false;
  }

  /* library actions */
  $('#newBtn').addEventListener('click', () => {
    commitTextEditIfNeeded();
    addPreset({ id: uid(), title: uniqueTitle('New preset'), fileName: null, fileNameCustom: false,
                mode: 'chain', chain: [], instruments: [], customText: null, updated: Date.now() });
  });
  $('#dupBtn').addEventListener('click', () => {
    commitTextEditIfNeeded();
    const p = current();
    const copy = JSON.parse(JSON.stringify(p));
    copy.id = uid();
    copy.title = uniqueTitle(p.title + ' copy');
    copy.fileName = null; copy.fileNameCustom = false;
    addPreset(copy);
  });
  $('#renameBtn').addEventListener('click', () => {
    const p = current();
    if (transferActive()) { consoleLog('err', 'Wait for the current transfer to finish (a dialog would stall it)'); return; }
    const t = prompt('Preset name:', p.title);
    if (t === null) return;
    p.title = t.trim() || p.title;
    if (!p.fileNameCustom) p.fileName = sanitizeFileName(p.title);
    p.updated = Date.now();
    store.saveSoon();
    renderAll();
  });
  $('#deleteBtn').addEventListener('click', () => {
    const p = current();
    if (transferActive()) { consoleLog('err', 'Wait for the current transfer to finish (a dialog would stall it)'); return; }
    if (!confirm(`Delete preset "${p.title}" from the workspace?`)) return;
    const i = store.state.presets.findIndex(x => x.id === p.id);
    store.state.presets.splice(i, 1);
    if (!store.state.presets.length)
      store.state.presets.push({ id: uid(), title: 'New preset', fileName: null, fileNameCustom: false,
                                 mode: 'chain', chain: [], instruments: [], customText: null, updated: Date.now() });
    store.state.currentId = store.state.presets[Math.max(0, i - 1)].id;
    ui.selectedCard = -1; ui.selectedInst = -1;
    store.saveSoon();
    renderAll();
  });
  $('#exportBtn').addEventListener('click', () => {
    commitTextEditIfNeeded();
    const p = current();
    const blob = new Blob([generateText(p)], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ensureFileName(p);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('#importBtn').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', async e => {
    for (const f of e.target.files) {
      try { addImportedPreset(f.name, await f.text()); }
      catch (err) { consoleLog('err', 'Import ' + f.name + ': ' + err.message); }
    }
    e.target.value = '';
  });

  /* SD card */
  $('#sdOpenBtn').addEventListener('click', sdOpen);
  $('#sdRefreshBtn').addEventListener('click', sdRefresh);
  $('#sdSaveBtn').addEventListener('click', sdSaveCurrent);

  /* chain / palette */
  $('#addFxBtn').addEventListener('click', openPalette);
  $('#paletteClose').addEventListener('click', closePalette);
  $('#paletteModal').addEventListener('click', e => { if (e.target === $('#paletteModal')) closePalette(); });
  $('#board').addEventListener('dragover', e => { if (ui.dragIdx !== null) e.preventDefault(); });
  $('#board').addEventListener('drop', e => {
    if (ui.dragIdx === null) return;
    e.preventDefault();
    moveItem(ui.dragIdx, current().chain.length + 1);   // drop on empty board space -> end
    ui.dragIdx = null;
  });

  /* code pane */
  $('#codeToggle').addEventListener('click', () => {
    const pane = $('#codePane');
    pane.classList.toggle('closed');
    $('#codeToggle').setAttribute('aria-expanded', String(!pane.classList.contains('closed')));
  });
  $('#codeEditBtn').addEventListener('click', () => {
    if (ui.editingText) finishTextEdit();
    else startTextEdit();
  });
  $('#codeTa').addEventListener('input', validateTextSoon);
  $('#codeCopyBtn').addEventListener('click', async () => {
    const text = ui.editingText ? $('#codeTa').value : $('#codePre').textContent;
    try { await navigator.clipboard.writeText(text); consoleLog('info', 'PatchScript copied to clipboard'); }
    catch (e) { consoleLog('err', 'Clipboard: ' + e.message); }
  });

  /* keyboard (when not typing): Escape closes modals, A W S E D … play the selected
     instrument, Delete removes the selected card */
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey) releaseAllNotes();       // a chord (Cmd-Tab, Ctrl-W…) may eat the keyup
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'Escape') { closePalette(); closeInstPalette(); closeLoopEditor(); return; }
    if (playKeyDown(e)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && current().mode === 'chain') {
      if (ui.selectedInst >= 0) { e.preventDefault(); removeInstrument(ui.selectedInst); }
      else if (ui.selectedCard >= 0) { e.preventDefault(); removeItem(ui.selectedCard); }
    }
  });
  document.addEventListener('keyup', playKeyUp);
  window.addEventListener('blur', releaseAllNotes);

  /* instruments picker */
  $('#instClose').addEventListener('click', closeInstPalette);
  midiBuildSection();
  chanBuildSection();
  scoreBuildSection();
  songBuildSection();                            // song sessions (NEW)
  sysBuildSection();
  diagBuildSection();                           // GLS-DIAG: the "no sound?" panel
  transportInit();
  // Served by the companion Pi: a plain link to its setup page, right next to the connection pill
  if (/^https?:$/.test(location.protocol)) {
    const a = document.createElement('a');
    a.id = 'setupLink'; a.href = '/setup'; a.className = 'btn sm'; a.textContent = 'Setup';
    a.title = 'Network, hotspot, Wi-Fi, SSH, Bluetooth, updates, login, restart and shut down';
    const pill = $('#connPill');
    (pill && pill.parentNode ? pill : $('#topbar')).insertAdjacentElement(pill ? 'afterend' : 'beforeend', a);
  }
  $('#instModal').addEventListener('click', e => { if (e.target === $('#instModal')) closeInstPalette(); });

  /* collapsible device sections */
  for (const id of ['swSec', 'loopSec']) {
    const sec = $('#' + id), h = sec.querySelector('h3');
    const toggle = () => { sec.classList.toggle('closed'); h.setAttribute('aria-expanded', String(!sec.classList.contains('closed'))); };
    h.addEventListener('click', toggle);
    h.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  }
  panelify();                                   // panels, regions, views (restores the last arrangement)

  /* loops */
  $('#loopSaveBtn').addEventListener('click', loopSaveCurrent);
  $('#loopSaveName').addEventListener('keydown', e => { if (e.key === 'Enter') loopSaveCurrent(); });
  $('#loopsRefresh').addEventListener('click', refreshLoops);
  $('#loopUploadBtn').addEventListener('click', () => $('#loopUploadInput').click());
  $('#loopUploadInput').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await loopUploadFile(f);
  });

  /* loop editor */
  $('#edClose').addEventListener('click', closeLoopEditor);
  $('#loopEdModal').addEventListener('click', e => { if (e.target === $('#loopEdModal')) closeLoopEditor(); });
  const wave = $('#waveCanvas');
  wave.addEventListener('pointerdown', edPointerDown);
  wave.addEventListener('pointermove', edPointerMove);
  wave.addEventListener('pointerup', edPointerUp);
  wave.addEventListener('pointercancel', edPointerUp);
  window.addEventListener('resize', () => { if (!$('#loopEdModal').hidden) drawWave(); });
  $('#edStart').addEventListener('change', () => setTrim(+$('#edStart').value, ed.end));
  $('#edEnd').addEventListener('change', () => setTrim(ed.start, +$('#edEnd').value));
  $('#edFadeIn').addEventListener('change', () => { ed.fadeIn = Math.max(0, +$('#edFadeIn').value || 0); });
  $('#edFadeOut').addEventListener('change', () => { ed.fadeOut = Math.max(0, +$('#edFadeOut').value || 0); });
  $('#edGain').addEventListener('input', () => {
    ed.gainDb = +$('#edGain').value;
    $('#edGainRo').textContent = (ed.gainDb > 0 ? '+' : '') + fmtNum(ed.gainDb) + ' dB';
    drawWave();
  });
  $('#edNormalize').addEventListener('click', () => { ed.normalize = !ed.normalize; $('#edNormalize').classList.toggle('active', ed.normalize); });
  $('#edReverse').addEventListener('click', () => { ed.reverse = !ed.reverse; $('#edReverse').classList.toggle('active', ed.reverse); });
  $('#edPreview').addEventListener('click', () => ed.src ? stopPreview() : startPreview());
  $('#edDownload').addEventListener('click', () => {
    if (!ed.buf) return;
    saveBlob(new Blob([editedWav()], { type: 'audio/wav' }), loopFileName($('#edSaveName').value) || ed.name);
  });
  $('#edSend').addEventListener('click', edSendToPedal);

  /* device: connect + transport */
  $('#connectBtn').addEventListener('click', () => { if (link.connected) { netReconnect.stop(); linkDisconnect(); } else serialConnect(); });
  // network (Pi bridge) connection
  let savedHost = '';
  try { savedHost = localStorage.getItem('gls.bridgeHost') || ''; } catch (e) {}
  if (!savedHost && /^https?:$/.test(location.protocol)) savedHost = location.host;
  $('#netHost').value = savedHost || 'loopsmith.local';
  if (location.protocol === 'https:') $('#netBtn').title = 'Not available from an https page — open the editor from the bridge (http://loopsmith.local/) or from the local file';
  $('#netBtn').addEventListener('click', () => {
    if (link.connected) { netReconnect.stop(); linkDisconnect(); return; }
    const row = $('#netRow');
    row.style.display = row.style.display === 'none' ? 'flex' : 'none';
    if (row.style.display === 'flex') $('#netHost').focus();
  });
  $('#netGo').addEventListener('click', () => netConnect($('#netHost').value));
  $('#netHost').addEventListener('keydown', e => { if (e.key === 'Enter') netConnect($('#netHost').value); });
  // Served by the bridge itself (http://loopsmith.local/)? Connect to it automatically.
  if (/^https?:$/.test(location.protocol)) {
    fetch('/api/status').then(r => (r.ok ? r.json() : null)).then(st => {
      if (st && st.bridge === 'looper' && !link.connected) netConnect(location.host);
    }).catch(() => {});
  }
  // Musical sync panel — each control maps to one `sync …` command; the pedal
  // answers with #SYNC, which renderSync() mirrors back.
  const syncSend = (args) => sendCmd('sync ' + args).catch(() => {});
  $('#syMode').addEventListener('change', e => syncSend('mode ' + e.target.value));
  $('#sySrc').addEventListener('change', e => syncSend('source ' + e.target.value));
  $('#syBpm').addEventListener('change', e => {
    const v = Math.max(30, Math.min(300, Math.round(+e.target.value) || 120));
    e.target.value = v;
    syncSend('bpm ' + v);
  });
  $('#syCi').addEventListener('change', e => syncSend('countin ' + e.target.value));
  $('#syBars').addEventListener('change', e => syncSend('bars ' + e.target.value));
  $('#syMet').addEventListener('change', e => syncSend('met ' + e.target.value));
  $('#tLoop').addEventListener('click', () => sendCmd('looper tap').catch(() => {}));
  $('#tStop').addEventListener('click', () => sendCmd('looper stop').catch(() => {}));
  $('#tUndo').addEventListener('click', () => sendCmd('looper undo').catch(() => {}));
  $('#tClear').addEventListener('click', () => sendCmd('looper clear').catch(() => {}));
  $('#tBypass').addEventListener('click', () => sendCmd('bypass ' + (dev.bypass ? 'off' : 'on')).catch(() => {}));

  /* volume */
  let volTimer = null;
  const vol = $('#volSlider');
  vol.addEventListener('pointerdown', () => { ui.volDragging = true; });
  vol.addEventListener('pointerup', () => { ui.volDragging = false; });
  vol.addEventListener('input', () => {
    $('#volText').textContent = vol.value + '%';
    clearTimeout(volTimer);
    volTimer = setTimeout(() => {
      dev.volume = (+vol.value) / 100;
      sendCmd('vol ' + fmtNum(dev.volume)).catch(() => {});
    }, 200);
  });

  /* live edit */
  $('#applyBtn').addEventListener('click', () => { commitTextEditIfNeeded(); applyLive(); });
  $('#autoApplyChk').addEventListener('change', e => { ui.autoApply = e.target.checked; if (ui.autoApply) maybeAutoApply(); });

  /* device preset list */
  $('#dpPrev').addEventListener('click', () => sendCmd('prev').catch(() => {}));
  $('#dpNext').addEventListener('click', () => sendCmd('next').catch(() => {}));
  $('#dpRefresh').addEventListener('click', refreshDeviceList);
  $('#dpPush').addEventListener('click', () => { commitTextEditIfNeeded(); pushCurrent(); });

  /* console drawer */
  $('#consoleToggle').addEventListener('click', () => {
    consoleState.open = !consoleState.open;
    $('#consoleBody').hidden = !consoleState.open;
    $('#consoleToggle').setAttribute('aria-expanded', String(consoleState.open));
    $('#consoleToggle').querySelector('.caret').innerHTML = consoleState.open ? '&#9660;' : '&#9654;';
    if (consoleState.open) $('#consoleLog').scrollTop = $('#consoleLog').scrollHeight;
  });
  const sendManual = () => {
    const inp = $('#consoleInput');
    const cmd = inp.value.trim();
    if (!cmd) return;
    inp.value = '';
    if (!link.connected) { consoleLog('err', 'Not connected'); return; }
    if (/^(put|apply|loop\s+put)\b/.test(cmd)) {
      // Sending these without a payload would make the device read the NEXT
      // commands as file content (and could overwrite a stored preset).
      consoleLog('err', 'put/apply need a byte payload — use the Push / Apply buttons.');
      return;
    }
    sendCmd(cmd, { timeout: 3000 }).catch(() => {});
  };
  $('#consoleSend').addEventListener('click', sendManual);
  $('#consoleInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendManual(); });

  window.addEventListener('beforeunload', () => { flushHeldNotes(); commitTextEditIfNeeded(); store.save(); });
  window.addEventListener('pagehide', flushHeldNotes);

  renderAll();
  renderDevPresets();
  updateConnUi();
  requestAnimationFrame(vuFrame);
  consoleLog('info', 'LoopSmith Studio ready');
}

/* Boot in the browser. The guard keeps the pure engine (schema, generator,
   parser, validator) importable in Node for unit testing. */
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
