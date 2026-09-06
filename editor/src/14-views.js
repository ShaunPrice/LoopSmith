/* ============================================================================
   10. UI state + rendering
   ========================================================================== */
const ui = {
  selectedCard: -1,
  selectedInst: -1,            // selected instrument card (computer keys play it)
  patchValid: true,            // last validation of the generated patch (gates Apply / Push)
  editingText: false,
  autoApply: false,
  dragIdx: null,
  volDragging: false,
};
let $ = null;  // assigned in init (document may not exist when unit-testing in Node)

/* ---------------- library panel ---------------- */
function renderLibrary() {
  const list = $('#presetList');
  list.textContent = '';
  for (const p of store.state.presets) {
    const row = document.createElement('div');
    row.className = 'pitem' + (p.id === store.state.currentId ? ' active' : '');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    const t = document.createElement('div'); t.className = 'pt'; t.textContent = p.title;
    const f = document.createElement('div'); f.className = 'pf';
    f.textContent = (p.fileName || sanitizeFileName(p.title)) + (p.mode === 'custom' ? ' · custom routing' : '');
    row.append(t, f);
    row.addEventListener('click', () => selectPreset(p.id));
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPreset(p.id); } });
    list.appendChild(row);
  }
}

function selectPreset(id) {
  if (id === store.state.currentId) return;
  commitTextEditIfNeeded();
  store.state.currentId = id;
  ui.selectedCard = -1; ui.selectedInst = -1;
  store.saveSoon();
  renderAll();
}

function addPreset(p) {
  store.state.presets.push(p);
  store.state.currentId = p.id;
  ui.selectedCard = -1; ui.selectedInst = -1;
  store.saveSoon();
  renderAll();
}

function uniqueTitle(base) {
  let t = base, n = 2;
  while (store.state.presets.some(p => p.title === t)) t = `${base} ${n++}`;
  return t;
}

function addImportedPreset(fileName, text, suffix) {
  const r = resolvePresetFromText(text, fileName.replace(/\.txt$/i, ''), true);
  const existing = store.state.presets.find(p => p.fileName === fileName);
  if (existing && normalizeText(generateText(existing)) === normalizeText(text)) {
    selectPreset(existing.id);   // identical copy already in the workspace
    return;
  }
  addPreset({
    id: uid(),
    title: uniqueTitle(r.title + (existing ? (suffix || ' (imported)') : '')),
    fileName, fileNameCustom: true,
    mode: r.mode, chain: r.chain, instruments: r.instruments || [], customText: r.customText, updated: Date.now()
  });
  consoleLog('info', `Imported ${fileName} (${r.mode === 'chain' ? 'chain' : 'custom routing'})`);
}

/* ---------------- chain editor ---------------- */
function renderChainBar() {
  const p = current();
  $('#presetTitle').textContent = p.title;
  $('#presetFile').textContent = p.fileName || sanitizeFileName(p.title);
  $('#addFxBtn').style.display = (p.mode === 'custom') ? 'none' : '';
}

function renderChain() {
  const p = current();
  renderChainBar();
  renderInstLane(p);
  chanPaint();
  const board = $('#board');
  board.textContent = '';

  if (p.mode === 'custom') {
    const n = document.createElement('div');
    n.id = 'customNotice';
    const h = document.createElement('h2'); h.textContent = 'Custom routing — edit as text';
    const d = document.createElement('p');
    d.textContent = 'This preset uses routing the pedalboard view cannot represent (parallel paths, extra mixers or sources). Use the PatchScript pane below to edit it directly — validation runs as you type.';
    const b = document.createElement('button'); b.className = 'btn accent'; b.textContent = 'Open text editor';
    b.addEventListener('click', () => { openCodePane(); startTextEdit(); });
    n.append(h, d, b);
    board.appendChild(n);
    return;
  }

  const mkNode = lbl => {
    const io = document.createElement('div'); io.className = 'io-node';
    const j = document.createElement('div'); j.className = 'jack';
    const l = document.createElement('div'); l.className = 'jl'; l.textContent = lbl;
    io.append(j, l);
    return io;
  };
  const mkCable = () => { const c = document.createElement('div'); c.className = 'cable'; return c; };

  board.appendChild(mkNode('IN'));
  p.chain.forEach((item, idx) => {
    board.appendChild(mkCable());
    board.appendChild(buildCard(item, idx));
  });
  board.appendChild(mkCable());

  const add = document.createElement('button');
  add.className = 'add-tile';
  add.type = 'button';
  if (p.chain.length === 0) {
    const t1 = document.createElement('span'); t1.className = 'plus'; t1.textContent = '+';
    const t2 = document.createElement('span'); t2.textContent = 'No effects yet — build your board';
    add.append(t1, t2);
  } else {
    const t1 = document.createElement('span'); t1.className = 'plus'; t1.textContent = '+';
    const t2 = document.createElement('span'); t2.textContent = 'Add effect';
    add.append(t1, t2);
  }
  add.addEventListener('click', openPalette);
  board.appendChild(add);
  board.appendChild(mkCable());
  board.appendChild(mkNode('OUT'));
}

function buildCard(item, idx) {
  const p = current();
  const card = document.createElement('div');
  card.className = 'card' + (item.on ? '' : ' bypassed') + (ui.selectedCard === idx ? ' sel' : '');
  card.dataset.idx = idx;

  const stripe = document.createElement('div');
  stripe.className = 'stripe';
  stripe.dataset.cat = itemCategory(item);
  card.appendChild(stripe);

  /* header: LED enable · name · move/remove */
  const head = document.createElement('div');
  head.className = 'card-head';
  head.draggable = true;
  const led = document.createElement('button');
  led.className = 'led' + (item.on ? ' on' : '');
  led.title = item.on ? 'Enabled — click to bypass' : 'Bypassed — click to enable';
  led.setAttribute('aria-label', 'Enable ' + itemLabel(item));
  led.addEventListener('click', e => { e.stopPropagation(); item.on = !item.on; structuralChange(); });
  const nameEl = document.createElement('span');
  nameEl.className = 'fx-name';
  nameEl.textContent = itemLabel(item);
  nameEl.title = item.kind === 'macro' ? MACRO_BY_ID[item.id].note : item.type;
  const btns = document.createElement('span');
  btns.className = 'head-btns';
  const mkMini = (txt, title, fn, cls) => {
    const b = document.createElement('button');
    b.className = 'mini' + (cls ? ' ' + cls : '');
    b.innerHTML = txt; b.title = title;
    b.addEventListener('click', e => { e.stopPropagation(); fn(); });
    return b;
  };
  btns.appendChild(mkMini('&#9664;', 'Move left', () => moveItem(idx, idx - 1)));
  btns.appendChild(mkMini('&#9654;', 'Move right', () => moveItem(idx, idx + 2)));
  btns.appendChild(mkMini('&#10005;', 'Remove', () => removeItem(idx), 'rm'));
  head.append(led, nameEl, btns);
  card.appendChild(head);

  /* drag to reorder (HTML5 DnD on the header) */
  head.addEventListener('dragstart', e => {
    ui.dragIdx = idx;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(idx)); } catch (err) {}
  });
  head.addEventListener('dragend', () => { ui.dragIdx = null; card.classList.remove('dragging'); });
  card.addEventListener('dragover', e => {
    if (ui.dragIdx === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  card.addEventListener('drop', e => {
    if (ui.dragIdx === null) return;
    e.preventDefault();
    const rect = card.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    moveItem(ui.dragIdx, idx + (after ? 1 : 0));
    ui.dragIdx = null;
  });

  card.addEventListener('click', () => { ui.selectedCard = idx; ui.selectedInst = -1; markSelection(); });

  /* body: parameter controls */
  const body = document.createElement('div');
  body.className = 'card-body';
  if (item.kind === 'macro') buildMacroBody(body, item);
  else buildFxBody(body, item);
  card.appendChild(body);
  return card;
}

function markSelection() {
  document.querySelectorAll('#board .card').forEach(c =>
    c.classList.toggle('sel', +c.dataset.idx === ui.selectedCard));
  document.querySelectorAll('#instLane .card').forEach(c =>
    c.classList.toggle('sel', +c.dataset.inst === ui.selectedInst));
}

function buildFxBody(body, item) {
  const def = SCHEMA_BY_TYPE[item.type];
  for (const prm of def.params) {
    const row = document.createElement('div');
    row.className = 'prow' + (item.inc[prm.method] ? '' : ' off');

    const lab = document.createElement('label');
    lab.className = 'inc';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!item.inc[prm.method];
    cb.addEventListener('change', () => {
      item.inc[prm.method] = cb.checked;
      // biquad filter modes are mutually exclusive (they all program stage 0)
      if (def.type === 'AudioFilterBiquad' && cb.checked && /^set/.test(prm.method)) {
        for (const o of def.params) {
          if (o.method !== prm.method && /^set/.test(o.method)) item.inc[o.method] = false;
        }
        valueChange();
        renderAll();
        return;
      }
      row.classList.toggle('off', !cb.checked);
      valueChange();
    });
    const dot = document.createElement('span'); dot.className = 'incled';
    const pl = document.createElement('span'); pl.className = 'plabel'; pl.textContent = prm.label;
    lab.append(cb, dot, pl);
    if (prm.note) lab.title = prm.note;
    if (!prm.args.length) {
      const n = document.createElement('span'); n.className = 'pnote'; n.textContent = '(call on load)';
      lab.appendChild(n);
    }
    row.appendChild(lab);

    if (prm.args.length) {
      const argsBox = document.createElement('div');
      argsBox.className = 'args';
      prm.args.forEach((a, ai) => {
        argsBox.appendChild(buildArgControl(a, prm.args.length > 1,
          () => item.params[prm.method][ai],
          v => { item.params[prm.method][ai] = v; valueChange(); }));
      });
      row.appendChild(argsBox);
    }
    body.appendChild(row);
  }

  /* Mix (wet/dry) 0-100% — always for wet effects, optional for the rest */
  if (item.showMix) {
    const row = document.createElement('div');
    row.className = 'prow mixrow';
    const arg = document.createElement('div'); arg.className = 'arg';
    const an = document.createElement('span'); an.className = 'argname'; an.textContent = 'Mix';
    const sl = document.createElement('input');
    sl.type = 'range'; sl.min = 0; sl.max = 100; sl.step = 1;
    sl.value = Math.round((item.mix !== undefined ? item.mix : 1) * 100);
    sl.setAttribute('aria-label', 'Wet/dry mix');
    const ro = document.createElement('span'); ro.className = 'ro';
    ro.textContent = sl.value + '%';
    sl.addEventListener('input', () => {
      item.mix = (+sl.value) / 100;
      ro.textContent = sl.value + '%';
      valueChange();
    });
    arg.append(an, sl, ro);
    row.appendChild(arg);
    body.appendChild(row);
  } else if (!SCHEMA_BY_TYPE[item.type].wet) {
    const b = document.createElement('button');
    b.className = 'addmix'; b.textContent = '+ Mix (wet/dry)';
    b.title = 'Blend this pedal with the dry signal through an AudioMixer4';
    b.addEventListener('click', e => {
      e.stopPropagation();
      item.showMix = true;
      if (item.mix === undefined) item.mix = 1;
      structuralChange();
    });
    body.appendChild(b);
  }
}

function buildMacroBody(body, item) {
  const m = MACRO_BY_ID[item.id];
  for (const prm of m.params) {
    const row = document.createElement('div');
    row.className = 'prow';
    const arg = document.createElement('div'); arg.className = 'arg';
    const an = document.createElement('span'); an.className = 'argname';
    an.textContent = prm.name.charAt(0).toUpperCase() + prm.name.slice(1);
    const sl = document.createElement('input');
    sl.type = 'range'; sl.min = prm.min; sl.max = prm.max; sl.step = prm.step;
    sl.value = item.p[prm.name];
    sl.setAttribute('aria-label', prm.name);
    const ro = document.createElement('span'); ro.className = 'ro';
    const show = v => prm.name === 'mix' ? Math.round(v * 100) + '%' : fmtNum(v) + (prm.unit ? ' ' + prm.unit : '');
    ro.textContent = show(+sl.value);
    sl.addEventListener('input', () => {
      item.p[prm.name] = +sl.value;
      ro.textContent = show(+sl.value);
      valueChange();
    });
    arg.append(an, sl, ro);
    row.appendChild(arg);
    body.appendChild(row);
  }
}

/** One arg control: log/linear slider + readout, or token select. */
function buildArgControl(a, showName, getVal, setVal) {
  const wrap = document.createElement('div');
  wrap.className = 'arg';
  if (showName) {
    const an = document.createElement('span'); an.className = 'argname'; an.textContent = a.name;
    wrap.appendChild(an);
  }
  if (a.type === 'token') {
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', a.name);
    for (const t of a.tokens) {
      const o = document.createElement('option');
      o.value = t; o.textContent = t.replace(/^WAVEFORM_/, '');
      sel.appendChild(o);
    }
    sel.value = String(getVal());
    sel.addEventListener('change', () => setVal(sel.value));
    wrap.appendChild(sel);
    return wrap;
  }
  const sl = document.createElement('input');
  sl.type = 'range';
  sl.setAttribute('aria-label', a.name);
  const ro = document.createElement('span'); ro.className = 'ro';
  const unit = a.unit ? ' ' + a.unit : '';
  const isLog = a.scale === 'log' && a.min > 0;
  const snap = v => {
    const st = a.step || 1;
    return clamp(+(Math.round((v - a.min) / st) * st + a.min).toFixed(4), a.min, a.max);
  };
  if (isLog) {
    // Map slider position 0..1000 exponentially between min..max.
    sl.min = 0; sl.max = 1000; sl.step = 1;
    const toPos = v => Math.round(1000 * Math.log(clamp(v, a.min, a.max) / a.min) / Math.log(a.max / a.min));
    const toVal = pos => snap(a.min * Math.pow(a.max / a.min, pos / 1000));
    sl.value = toPos(Number(getVal()));
    ro.textContent = fmtNum(getVal()) + unit;
    sl.addEventListener('input', () => {
      const v = toVal(+sl.value);
      ro.textContent = fmtNum(v) + unit;
      setVal(v);
    });
  } else {
    sl.min = a.min; sl.max = a.max; sl.step = a.step || 1;
    sl.value = Number(getVal());
    ro.textContent = fmtNum(getVal()) + unit;
    sl.addEventListener('input', () => {
      const v = (a.type === 'int') ? Math.round(+sl.value) : +sl.value;
      ro.textContent = fmtNum(v) + unit;
      setVal(v);
    });
  }
  wrap.append(sl, ro);
  return wrap;
}

/* ---------------- instruments lane ---------------- */
function renderInstLane(p) {
  const lane = $('#instLane');
  lane.textContent = '';
  lane.hidden = (p.mode === 'custom');
  if (lane.hidden) return;
  const insts = instruments(p);
  const budget = patchBudget(p);
  const over = budget.objects > MAX_OBJECTS || budget.conns > MAX_CONNECTIONS;
  const lbl = document.createElement('div'); lbl.className = 'lane-label';
  const b = document.createElement('b'); b.textContent = 'INSTRUMENTS';
  const s = document.createElement('small');
  s.textContent = insts.length ? 'Summed with the guitar before the first effect'
                               : 'Synth voices on the pedal — play them from here or over USB MIDI';
  const bd = document.createElement('small'); bd.className = 'budget' + (over ? ' over' : '');
  bd.textContent = `${budget.objects}/${MAX_OBJECTS} obj · ${budget.conns}/${MAX_CONNECTIONS} conn`;
  bd.title = over ? 'Over the pedal’s limit — Apply and Push are disabled until this fits'
                  : 'Objects / connections the generated patch declares (pedal limits 24 / 48)';
  lbl.append(b, s, bd);
  lane.appendChild(lbl);
  insts.forEach((it, idx) => lane.appendChild(buildInstCard(it, idx)));
  const add = document.createElement('button');
  add.className = 'add-tile'; add.type = 'button';
  const t1 = document.createElement('span'); t1.className = 'plus'; t1.textContent = '+';
  const t2 = document.createElement('span'); t2.textContent = 'Add instrument';
  add.append(t1, t2);
  const smallest = { id: 'pluck', on: true, p: { voices: 1 } };            // cheapest possible card
  const full = insts.length >= MAX_INSTRUMENTS, noRoom = !full && !instFits(p, smallest);
  add.disabled = full || noRoom;
  add.title = full ? `Up to ${MAX_INSTRUMENTS} instruments — beyond that the pedal runs out of mixer inputs`
           : noRoom ? `No room: the patch already uses ${budget.objects}/${MAX_OBJECTS} objects and ${budget.conns}/${MAX_CONNECTIONS} connections`
           : `Add a synth voice (${budget.objects}/${MAX_OBJECTS} objects used)`;
  add.addEventListener('click', openInstPalette);
  lane.appendChild(add);
}

function buildInstCard(item, idx) {
  const m = MACRO_BY_ID[item.id];
  const card = document.createElement('div');
  card.className = 'card' + (item.on ? '' : ' bypassed') + (ui.selectedInst === idx ? ' sel' : '');
  card.dataset.inst = idx;
  const stripe = document.createElement('div'); stripe.className = 'stripe'; stripe.dataset.cat = 'instrument';
  card.appendChild(stripe);

  const head = document.createElement('div'); head.className = 'card-head'; head.style.cursor = 'default';
  const led = document.createElement('button');
  led.className = 'led' + (item.on ? ' on' : '');
  led.title = item.on ? 'Enabled — click to mute (left out of the patch)' : 'Muted — click to enable';
  led.setAttribute('aria-label', 'Enable ' + m.label);
  led.addEventListener('click', e => { e.stopPropagation(); item.on = !item.on; releaseAllNotes(); structuralChange(); });
  const nameEl = document.createElement('span'); nameEl.className = 'fx-name';
  nameEl.textContent = m.label; nameEl.title = m.note;
  const rm = document.createElement('button'); rm.className = 'mini rm'; rm.innerHTML = '&#10005;'; rm.title = 'Remove';
  rm.addEventListener('click', e => { e.stopPropagation(); removeInstrument(idx); });
  head.append(led, nameEl);
  if (item.on && !isPads(item)) {                          // channel clash badge (see instrumentIssues)
    const ch = Math.round(item.p.channel || 0);
    const issues = instrumentIssues(current()).filter(w => w.ch === ch);
    if (issues.length) {
      const w = document.createElement('span'); w.className = 'warn'; w.textContent = '⚠';
      w.title = issues.map(i => i.msg).join('\n');
      w.setAttribute('aria-label', 'MIDI channel conflict');
      head.appendChild(w);
    }
  }
  head.appendChild(rm);
  card.appendChild(head);
  card.addEventListener('click', () => selectInst(idx));

  const body = document.createElement('div'); body.className = 'card-body';
  buildInstBody(body, item);
  buildPlayStrip(body, item);
  card.appendChild(body);
  return card;
}

function selectInst(idx) { ui.selectedInst = idx; ui.selectedCard = -1; markSelection(); }

/** Macro params (min/max/step or tokens) rendered with the same widgets as effect args. */
function macroArg(prm) {
  const name = prm.label || (prm.name.charAt(0).toUpperCase() + prm.name.slice(1));
  if (prm.tokens) return { name, type: 'token', tokens: prm.tokens, default: prm.default };
  return { name, type: (prm.step || 1) >= 1 ? 'int' : 'float', min: prm.min, max: prm.max,
           step: prm.step, unit: prm.unit, default: prm.default };
}
function buildInstBody(body, item) {
  for (const prm of MACRO_BY_ID[item.id].params) {
    const row = document.createElement('div'); row.className = 'prow';
    const a = macroArg(prm);
    if (prm.name === 'voices') {
      // Clamp the slider to what the pedal's 24-object / 48-connection budget still allows.
      const p = current(), b = patchBudget(p), cur = clamp(Math.round(item.p.voices) || 1, 1, prm.max);
      const t = instTemplate(item);
      const perO = t.objects.length, perC = (t.conns || []).length + 1;   // objects / connections per extra voice
      let free;
      if (item.on) free = Math.min((MAX_OBJECTS - b.objects) / perO, (MAX_CONNECTIONS - b.conns) / perC);
      else {
        const c = instCost(item), on = instruments(p).filter(x => x.on).length;
        const extraMix = (on % 3 === 0) ? 1 : 0;
        free = Math.min((MAX_OBJECTS - b.objects - c.objs - extraMix) / perO, (MAX_CONNECTIONS - b.conns - c.conns - extraMix) / perC);
      }
      a.max = clamp(cur + Math.floor(free), cur, prm.max);         // never below the current value
      if (a.max < prm.max) row.title = `Voices limited to ${a.max} by the pedal’s object budget (${b.objects}/${MAX_OBJECTS} used)`;
    }
    if (prm.text) {                                             // a file name (sample pads)
      const lab = document.createElement('span'); lab.className = 'pname'; lab.textContent = prm.label || a.name;
      const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'ptext';
      inp.value = item.p[prm.name] || ''; inp.placeholder = 'name of /samples/<name>.wav'; inp.spellcheck = false;
      inp.title = 'A WAV in the SD card\'s /samples folder (16-bit 44.1 kHz), without the .wav';
      inp.addEventListener('click', ev => ev.stopPropagation());
      inp.addEventListener('change', () => { item.p[prm.name] = inp.value.trim().replace(/\.wav$/i, '').replace(/[^A-Za-z0-9_\-]/g, ''); inp.value = item.p[prm.name]; structuralChange(); });
      row.append(lab, inp);
      body.appendChild(row);
      continue;
    }
    row.appendChild(buildArgControl(a, true,
      () => item.p[prm.name],
      v => { item.p[prm.name] = v; if (prm.name === 'channel') structuralChange(); else valueChange(); }));
    body.appendChild(row);
  }
}

/* ---- play strip: on-screen keys / pads -> "note on|off" over the link ---- */
const KEY_LOW = 48, KEY_HIGH = 72;                       // C3..C5, two octaves
const PC_KEYS = { a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71, k: 72 };
const DRUM_PADS = [['KICK', 36], ['SNARE', 38], ['HAT', 42]];
const held = new Map();                                   // "note/ch" -> element (or null)

/** The MIDI channel a card answers: its own setting, else the template's default.
 *  Kits used to be pinned to the template (channel 10); they are assignable now. */
function instChannel(item) {
  const set = Math.round(item.p.channel || 0);
  if (set >= 1 && set <= 16) return set;
  return isPads(item) ? (instTemplate(item).channel || 10) : Math.max(1, set);
}
function noteOn(note, ch, el) {
  const key = note + '/' + ch;
  if (held.has(key)) return;
  held.set(key, el || null);
  if (el) el.classList.add('down');
  if (link.connected) sendCmd(`note on ${note} 100 ${ch}`, { timeout: 3000 }).catch(() => {});
}
function noteOff(note, ch) {
  const key = note + '/' + ch;
  if (!held.has(key)) return;
  const el = held.get(key);
  held.delete(key);
  if (el) el.classList.remove('down');
  if (link.connected) sendCmd(`note off ${note} ${ch}`, { timeout: 3000 }).catch(() => {});
}
function releaseAllNotes() {
  for (const k of [...held.keys()]) { const [n, c] = k.split('/'); noteOff(+n, +c); }
}
/** Note-offs written straight to the transport, bypassing the queue — for link loss and
 *  page hide, when queued commands would never go out. Skipped while a counted upload
 *  is in flight (the bytes would land inside the payload). */
function flushHeldNotes() {
  if (!held.size) return;
  const lines = [...held.keys()].map(k => { const [n, c] = k.split('/'); return `note off ${n} ${c}\n`; }).join('');
  for (const el of held.values()) if (el) el.classList.remove('down');
  held.clear();
  const uploading = link.active && link.active.kind === 'send' && link.active.sendStarted;
  if (link.connected && link.transport && !uploading) { try { linkWrite(enc.encode(lines)).catch(() => {}); } catch (e) {} }
}
function bindPlayable(el, note, chFn) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;                            // right / middle clicks never start a note
    e.preventDefault();
    noteOn(note, chFn(), el);
  });
  const up = () => noteOff(note, chFn());
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener('pointercancel', up);
}
function isBlackKey(n) { return [1, 3, 6, 8, 10].includes(n % 12); }
function noteName(n) { return ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][n % 12] + (Math.floor(n / 12) - 1); }

function buildPlayStrip(body, item) {
  const wrap = document.createElement('div'); wrap.className = 'play';
  const hint = document.createElement('div'); hint.className = 'play-hint';
  if (isPads(item)) {
    const pads = document.createElement('div'); pads.className = 'pads';
    const ch = instChannel(item);
    for (const pd of activePads(item)) {
      const lbl = pd.label || pd.n.toUpperCase(), note = pd.note;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'pad';
      b.textContent = lbl;
      const sm = document.createElement('small'); sm.textContent = `ch ${ch} · ${note}`;
      b.appendChild(sm);
      b.setAttribute('aria-label', `${lbl} pad (note ${note})`);
      bindPlayable(b, note, () => ch);
      pads.appendChild(b);
    }
    wrap.appendChild(pads);
    hint.textContent = `Pads send note on/off on channel ${instChannel(item)} (${activePads(item).map(pd => (pd.label || pd.n) + ' ' + pd.note).join(' · ')}).`;
  } else {
    const keys = document.createElement('div'); keys.className = 'keys';
    const whites = [];
    for (let n = KEY_LOW; n <= KEY_HIGH; n++) if (!isBlackKey(n)) whites.push(n);
    const w = 100 / whites.length;
    const mkKey = (n, black) => {
      const k = document.createElement('button'); k.type = 'button';
      k.className = 'key' + (black ? ' black' : '');
      k.dataset.note = n; k.title = noteName(n); k.setAttribute('aria-label', noteName(n));
      bindPlayable(k, n, () => instChannel(item));
      return k;
    };
    for (const n of whites) keys.appendChild(mkKey(n, false));
    for (let n = KEY_LOW; n <= KEY_HIGH; n++) {
      if (!isBlackKey(n)) continue;
      const k = mkKey(n, true);
      const wi = whites.filter(x => x < n).length;          // white keys to the left
      k.style.left = `calc(${(wi * w).toFixed(3)}% - 3.7%)`; // centred on the boundary
      keys.appendChild(k);
    }
    wrap.appendChild(keys);
    const ch = Math.round(item.p.channel || 0);
    hint.textContent = `C3–C5 on MIDI channel ${instChannel(item)}${ch === 0 ? ' (omni)' : ''}. With this card selected, keys A W S E D F T G Y H U J K play C4–C5.`;
  }
  wrap.appendChild(hint);
  body.appendChild(wrap);
}

/** Computer keyboard -> selected pluck/synth card. Returns true when the key was consumed. */
function playKeyDown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return false;
  const note = PC_KEYS[(e.key || '').toLowerCase()];
  if (note === undefined || ui.selectedInst < 0) return false;
  const p = current();
  const it = instruments(p)[ui.selectedInst];
  if (!it || it.id === 'drumkit' || p.mode !== 'chain') return false;
  e.preventDefault();
  const el = document.querySelector(`#instLane .card[data-inst="${ui.selectedInst}"] .key[data-note="${note}"]`);
  noteOn(note, instChannel(it), el);
  return true;
}
function playKeyUp(e) {
  const note = PC_KEYS[(e.key || '').toLowerCase()];
  if (note === undefined) return;
  for (const k of [...held.keys()]) { const [n, c] = k.split('/'); if (+n === note) noteOff(+n, +c); }
}

/* ---- instrument mutations + picker ---- */
function addInstrument(item) {
  const p = current();
  if (!Array.isArray(p.instruments)) p.instruments = [];
  if (p.instruments.length >= MAX_INSTRUMENTS) return;
  if (item.id !== 'drumkit') item.p.channel = nextFreeChannel(p);   // one MIDI channel per melodic card
  while (item.p.voices > 1 && !instFits(p, item)) item.p.voices--;  // trim voices to the object budget
  if (!instFits(p, item)) {
    const b = patchBudget(p);
    consoleLog('err', `No room for a ${MACRO_BY_ID[item.id].label}: the patch already uses ${b.objects}/${MAX_OBJECTS} objects and ${b.conns}/${MAX_CONNECTIONS} connections`);
    closeInstPalette();
    return;
  }
  p.instruments.push(item);
  ui.selectedInst = p.instruments.length - 1; ui.selectedCard = -1;
  closeInstPalette();
  structuralChange();
}
function removeInstrument(idx) {
  const p = current();
  releaseAllNotes();
  instruments(p).splice(idx, 1);
  if (ui.selectedInst >= instruments(p).length) ui.selectedInst = instruments(p).length - 1;
  structuralChange();
}
function openInstPalette() {
  const box = $('#instGroups');
  box.textContent = '';
  const p = current();
  const groups = [['Keys', id => MACRO_BY_ID[id].template.family === 'keys', 'instrument'],
                  ['Kits & percussion', id => MACRO_BY_ID[id].template.family === 'pads' && id !== 'samples', 'drive'],
                  ['Your own samples', id => id === 'samples', 'source']];
  for (const [title, pick, color] of groups) {
    const ids = INSTRUMENT_IDS.filter(pick);
    if (!ids.length) continue;
    const sec = document.createElement('div'); sec.className = 'pal-cat';
    const hd = document.createElement('h4');
    const sw = document.createElement('i'); sw.style.background = `var(--cat-${color})`;
    hd.append(sw, document.createTextNode(title));
    const grid = document.createElement('div'); grid.className = 'pal-grid';
    for (const id of ids) {
      const m = MACRO_BY_ID[id];
      const b = document.createElement('button'); b.className = 'pal-item';
      const t = document.createElement('b'); t.textContent = m.label;
      const s = document.createElement('small'); s.textContent = m.note.replace(/^Editor instrument:\s*/, '');
      b.append(t, s);
      const probe = newInstItem(id); if (probe.p.voices) probe.p.voices = 1;
      if (!instFits(p, probe)) { b.disabled = true; b.title = `No room left in the pedal’s ${MAX_OBJECTS}-object budget`; }
      b.addEventListener('click', () => addInstrument(newInstItem(id)));
      grid.appendChild(b);
    }
    sec.append(hd, grid);
    box.appendChild(sec);
  }
  $('#instModal').hidden = false;
}
function closeInstPalette() { $('#instModal').hidden = true; }

/* ---- chain mutations ---- */
function moveItem(from, to) {
  const p = current();
  if (from === null || from === undefined) return;
  if (to > from) to--;
  to = clamp(to, 0, p.chain.length - 1);
  if (to === from) return;
  const [it] = p.chain.splice(from, 1);
  p.chain.splice(to, 0, it);
  ui.selectedCard = to;
  structuralChange();
}
function removeItem(idx) {
  const p = current();
  p.chain.splice(idx, 1);
  if (ui.selectedCard >= p.chain.length) ui.selectedCard = p.chain.length - 1;
  structuralChange();
}
function structuralChange() {
  midi.presetRev = (midi.presetRev || 0) + 1;      // the MIDI panel's coverage marks depend on the preset
  const p = current();
  p.updated = Date.now();
  store.saveSoon();
  renderChain();
  renderCode();
  maybeAutoApply();
}
function valueChange() {
  const p = current();
  p.updated = Date.now();
  store.saveSoon();
  renderCode();
  maybeAutoApply();
}

/* ---------------- palette modal ---------------- */
function openPalette() {
  const groups = $('#paletteGroups');
  groups.textContent = '';
  const cats = [];
  const byCat = {};
  for (const e of EFFECTS_SCHEMA.effects) {
    if (!e.chain) continue;                       // palette shows chain-capable effects only
    if (!byCat[e.category]) { byCat[e.category] = []; cats.push(e.category); }
    byCat[e.category].push(e);
  }
  const catColor = c => getComputedStyle(document.documentElement).getPropertyValue('--cat-' + c) || '#888';
  for (const c of cats) {
    const sec = document.createElement('div'); sec.className = 'pal-cat';
    const h = document.createElement('h4');
    const sw = document.createElement('i'); sw.style.background = catColor(c);
    h.append(sw, document.createTextNode(c));
    const grid = document.createElement('div'); grid.className = 'pal-grid';
    for (const e of byCat[c]) {
      const b = document.createElement('button'); b.className = 'pal-item';
      const t = document.createElement('b'); t.textContent = e.label;
      const s = document.createElement('small'); s.textContent = e.type;
      b.append(t, s);
      b.addEventListener('click', () => { addChainItem(newFxItem(e.type)); });
      grid.appendChild(b);
    }
    sec.append(h, grid);
    groups.appendChild(sec);
  }
  // Macros (echo, tremolo) — expand to their documented multi-object patterns.
  // Instrument macros have their own lane and picker (openInstPalette).
  const sec = document.createElement('div'); sec.className = 'pal-cat';
  const h = document.createElement('h4');
  const sw = document.createElement('i'); sw.style.background = catColor('macro');
  h.append(sw, document.createTextNode('macros'));
  const grid = document.createElement('div'); grid.className = 'pal-grid';
  for (const m of EFFECTS_SCHEMA.macros) {
    if (INSTRUMENT_IDS.includes(m.id)) continue;
    const b = document.createElement('button'); b.className = 'pal-item';
    const t = document.createElement('b'); t.textContent = m.label;
    const s = document.createElement('small'); s.textContent = m.note.replace(/^Editor macro:\s*/, '');
    b.append(t, s);
    b.addEventListener('click', () => { addChainItem(newMacroItem(m.id)); });
    grid.appendChild(b);
  }
  sec.append(h, grid);
  groups.appendChild(sec);
  $('#paletteModal').hidden = false;
}
function closePalette() { $('#paletteModal').hidden = true; }
function addChainItem(item) {
  const p = current();
  p.chain.push(item);
  ui.selectedCard = p.chain.length - 1;
  closePalette();
  structuralChange();
}

/* ---------------- code pane ---------------- */
function openCodePane() {
  $('#codePane').classList.remove('closed');
  $('#codeToggle').setAttribute('aria-expanded', 'true');
}
function renderCode() {
  const p = current();
  if (ui.editingText) return;                     // don't clobber the textarea
  const text = generateText(p);
  $('#codePre').textContent = text;
  const bytes = enc.encode(text).length;
  $('#codeStats').textContent = `${text.split('\n').length - 1} lines · ${bytes} B` + (bytes > MAX_FILE_BYTES ? ' — OVER 16 KB LIMIT' : '');
  const v = validatePatch(parsePatch(text), text);
  v.warnings.push(...instrumentIssues(p));
  ui.patchValid = !v.errors.length;
  syncApplyButtons();
  renderIssues(v);
  diagPaintSoon();                              // GLS-DIAG: Editing-vs-Running line follows the draft
}
/** Apply / Push stay disabled while the pedal would reject the generated patch. */
function syncApplyButtons() {
  const ok = link.connected && ui.patchValid;
  for (const id of ['applyBtn', 'dpPush']) {
    $('#' + id).disabled = !ok;
    $('#' + id).title = (link.connected && !ui.patchValid) ? 'Fix the validation errors in the PatchScript pane first' : '';
  }
}
function renderIssues(v) {
  const box = $('#codeIssues');
  box.textContent = '';
  if (!v.errors.length && !v.warnings.length) {
    const d = document.createElement('div');
    d.className = 'issue ok';
    d.textContent = 'No issues — valid PatchScript.';
    box.appendChild(d);
    return;
  }
  const put = (list, cls, tag) => {
    for (const it of list) {
      const d = document.createElement('div');
      d.className = 'issue ' + cls;
      d.textContent = (it.line ? `line ${it.line}: ` : '') + tag + it.msg;
      box.appendChild(d);
    }
  };
  put(v.errors, 'err', 'error: ');
  put(v.warnings, 'warn', 'warning: ');
}

let textEditTimer = null;
function startTextEdit() {
  const p = current();
  ui.editingText = true;
  const ta = $('#codeTa');
  ta.value = generateText(p);
  $('#codePre').hidden = true;
  ta.hidden = false;
  ta.focus();
  $('#codeEditBtn').textContent = 'Done';
  openCodePane();
  validateTextSoon();
}
function validateTextSoon() {
  clearTimeout(textEditTimer);
  textEditTimer = setTimeout(() => {
    const text = $('#codeTa').value;
    renderIssues(validatePatch(parsePatch(text), text));
    const bytes = enc.encode(text).length;
    $('#codeStats').textContent = `${text.split('\n').length} lines · ${bytes} B (editing)`;
  }, 300);
}
function commitTextEditIfNeeded() {
  if (!ui.editingText) return;
  finishTextEdit();
}
function finishTextEdit() {
  const p = current();
  const text = $('#codeTa').value;
  ui.editingText = false;
  $('#codeTa').hidden = true;
  $('#codePre').hidden = false;
  $('#codeEditBtn').textContent = 'Edit as text';
  // Re-derive the model: trust chain-meta only if the text still matches its
  // regeneration; else recognize a pure series chain; else keep custom routing.
  const r = resolvePresetFromText(text, p.title, false);
  p.title = r.title;
  p.mode = r.mode;
  p.chain = r.chain;
  p.instruments = r.instruments || [];
  p.customText = r.customText;
  p.updated = Date.now();
  ui.selectedCard = -1; ui.selectedInst = -1;
  store.saveSoon();
  renderAll();
  maybeAutoApply();
}

/* ---------------- SD card folder (File System Access API) ---------------- */
const sd = { dir: null, presetsDir: null };
async function sdOpen() {
  try {
    sd.dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    sd.presetsDir = await sd.dir.getDirectoryHandle('presets', { create: true });
    $('#sdBox').hidden = false;
    $('#sdPath').textContent = sd.dir.name + '/presets';
    await sdRefresh();
  } catch (e) {
    if (e && e.name !== 'AbortError') consoleLog('err', 'SD folder: ' + e.message);
  }
}
async function sdRefresh() {
  if (!sd.presetsDir) return;
  const files = [];
  try {
    for await (const [name, handle] of sd.presetsDir.entries())
      if (handle.kind === 'file' && /\.txt$/i.test(name)) files.push(name);
  } catch (e) { consoleLog('err', 'SD list: ' + e.message); return; }
  files.sort();
  const box = $('#sdFiles');
  box.textContent = '';
  if (!files.length) {
    const d = document.createElement('div'); d.className = 'hint'; d.style.marginTop = '6px';
    d.textContent = 'No presets on the card yet.';
    box.appendChild(d);
  }
  for (const name of files) {
    const row = document.createElement('div'); row.className = 'sdrow';
    const s = document.createElement('span'); s.textContent = name; s.title = name;
    const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = 'Load';
    b.addEventListener('click', async () => {
      try {
        const fh = await sd.presetsDir.getFileHandle(name);
        const f = await fh.getFile();
        addImportedPreset(name, await f.text(), ' (SD)');
      } catch (e) { consoleLog('err', 'SD read: ' + e.message); }
    });
    row.append(s, b);
    box.appendChild(row);
  }
}
async function sdSaveCurrent() {
  if (!sd.presetsDir) return;
  const p = current();
  commitTextEditIfNeeded();
  const name = ensureFileName(p);
  try {
    const fh = await sd.presetsDir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(generateText(p));
    await w.close();
    consoleLog('info', `Saved ${name} to SD card`);
    await sdRefresh();
  } catch (e) { consoleLog('err', 'SD write: ' + e.message); }
}

/* ---------------- device panel rendering ---------------- */
function updateConnUi() {
  const pill = $('#connPill');
  if (link.connected) {
    pill.className = 'pill on';
    const via = (link.transport && link.transport.kind === 'ws') ? 'network' : 'USB';
    pill.textContent = link.pedalPresent
      ? (dev.info ? `Connected · fw ${dev.info.fw}` : 'Connected') + ` · ${via}`
      : 'Bridge only · pedal unplugged';
  } else {
    pill.className = 'pill off';
    pill.textContent = 'Disconnected';
    $('#devBadges').hidden = true;
  }
  const kind = link.transport ? link.transport.kind : null;
  $('#connectBtn').textContent = (link.connected && kind === 'serial') ? 'Disconnect' : 'Connect USB';
  $('#connectBtn').disabled = link.connected && kind !== 'serial';
  $('#netBtn').textContent = (link.connected && kind === 'ws') ? 'Disconnect' : 'Network\u2026';
  $('#netBtn').disabled = link.connected && kind !== 'ws';
  if (link.connected) $('#netRow').style.display = 'none';
  const en = link.connected;
  for (const id of ['tLoop', 'tStop', 'tUndo', 'tClear', 'tBypass', 'applyBtn', 'autoApplyChk',
                    'dpPrev', 'dpNext', 'dpRefresh', 'dpPush', 'volSlider',
                    'syMode', 'sySrc', 'syBpm', 'syCi', 'syBars', 'syMet'])
    $('#' + id).disabled = !en;
  if (!en) {
    $('#loopLamp').className = 'lamp';
    $('#loopState').textContent = '-';
    $('#devPresetName').textContent = '-';
    dev.switches = null; dev.loops = null;
    dev.sync = null; renderSync();
    releaseAllNotes();
    progressDone();
  }
  syncApplyButtons();
  syncEdSend();
  renderSwitches();
  renderLoops();
}
function renderDevInfo() {
  if (!dev.info) return;
  updateConnUi();                      // pill text (incl. USB/network) lives in one place
  $('#devBadges').hidden = false;
  $('#bFw').textContent = 'FW ' + dev.info.fw + ' · p' + dev.info.proto;
  $('#bPsram').textContent = 'PSRAM ' + dev.info.psram_mb + ' MB';
  $('#bSd').classList.toggle('on', !!dev.info.sd);
  $('#bFlash').classList.toggle('on', !!dev.info.flash);
}
function renderMetersStatic() {
  $('#cpuText').textContent = dev.cpu.toFixed(1) + '% / ' + dev.cpuMax.toFixed(1);
  $('#memText').textContent = dev.mem + ' / ' + dev.memMax + ' blk';
  $('#cpuVu').querySelector('.vu-cover').style.width = (100 - clamp(dev.cpu, 0, 100)) + '%';
  const memPct = clamp(dev.memMax > 0 ? 100 * dev.mem / Math.max(dev.memMax, 24) : 0, 0, 100);
  $('#memVu').querySelector('.vu-cover').style.width = (100 - memPct) + '%';
}
function renderLooper() {
  const L = dev.loop || {};
  const lamp = $('#loopLamp');
  lamp.className = 'lamp ' + (L.state && L.state !== 'empty' ? L.state : '');
  $('#loopState').textContent = L.state === 'countin' ? 'count-in' : (L.state || '-');
  $('#loopTime').textContent = (L.pos_s || 0).toFixed(1) + ' / ' + (L.len_s || 0).toFixed(1) + ' s';
  const C = 163.36;
  const frac = (L.len_s > 0) ? clamp((L.pos_s || 0) / L.len_s, 0, 1) : 0;
  const ring = $('#loopRing');
  ring.style.strokeDashoffset = String(C * (1 - frac));
  ring.style.stroke = L.state === 'recording' ? 'var(--red)' : (L.state === 'overdubbing' ? 'var(--accent)' : 'var(--teal)');
  $('#tUndo').disabled = !link.connected || !L.can_undo;
  syncEdSend();
}
/** Musical sync panel: mirror the pedal's settings (without fighting a control
 *  the user is holding) and narrate what the timing engine is doing. */
function renderSync() {
  const s = dev.sync;
  if (!s) {
    $('#syncStat').textContent = link.connected
      ? 'No sync info — firmware 2.2.x or older on the pedal.'
      : 'Connect to configure musical sync.';
    return;
  }
  const put = (id, v) => { const el = $('#' + id); if (document.activeElement !== el) el.value = String(v); };
  put('syMode', s.mode || 'off');
  put('sySrc', s.src || 'internal');
  if (typeof s.bpm === 'number' && document.activeElement !== $('#syBpm')) $('#syBpm').value = Math.round(s.bpm);
  if (s.countin != null) put('syCi', s.countin);
  if (s.bars != null) put('syBars', s.bars);
  put('syMet', s.met || 'rec');
  let txt, warn = false;
  if (!s.mode || s.mode === 'off') {
    txt = 'Sync off — taps record immediately.';
  } else if (s.src === 'midi' && s.clk !== 'running') {
    // The pedal REFUSES to arm without a clock (it never records an
    // unsynchronised take when sync was asked for) — say so loudly.
    warn = true;
    txt = `⚠ MIDI clock ${s.clk || 'idle'} — LOOP won't arm until the DAW sends clock (Start + ticks), or switch CLOCK to Internal.`;
  } else {
    txt = `Quantise to ${s.mode} · ${Math.round(s.bpm || 0)} BPM`;
    if (s.src === 'midi') txt += ' · MIDI clock running';
    if (s.phase === 'countin') txt += ` · count-in, beat ${s.beat}`;
    else if (s.phase === 'armed') txt += ` · armed — starts on the next ${s.mode}`;
    else if (s.phase === 'recording' && s.bars > 0) txt += ` · recording ${s.bars} bar${s.bars > 1 ? 's' : ''}`;
    else if (s.phase === 'closing') txt += ` · closing on the next ${s.mode}`;
  }
  const el = $('#syncStat');
  el.textContent = txt;
  el.classList.toggle('warn', warn);
}
function renderDevPresetName() { $('#devPresetName').textContent = dev.presetName || '-'; }
function renderBypass() {
  const b = $('#tBypass');
  b.classList.toggle('active', dev.bypass);
  b.title = dev.bypass ? 'FX bypassed — click to re-enable' : 'FX active — click to bypass';
}
function renderVolume(force) {
  if (ui.volDragging && !force) return;   // don't fight the user's drag
  $('#volSlider').value = Math.round(dev.volume * 100);
  $('#volText').textContent = Math.round(dev.volume * 100) + '%';
}
function renderDevPresets() {
  const box = $('#devPresets');
  box.textContent = '';
  if (!dev.presets.length) {
    const d = document.createElement('div'); d.className = 'hint'; d.style.marginTop = '6px';
    d.textContent = link.connected ? 'No presets on the pedal.' : 'Connect to browse the pedal’s presets.';
    box.appendChild(d);
    return;
  }
  dev.presets.forEach((name, i) => {
    const row = document.createElement('div');
    row.className = 'dprow' + (i === dev.currentIndex ? ' cur' : '');
    const s = document.createElement('span'); s.textContent = name; s.title = name;
    const mk = (txt, title, fn, cls) => {
      const b = document.createElement('button');
      b.className = 'btn sm' + (cls ? ' ' + cls : '');
      b.textContent = txt; b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    row.append(s,
      mk('Load', 'Load and apply on the pedal', () => sendCmd('load ' + name).catch(() => {})),
      mk('Pull', 'Copy from the pedal into the workspace', () => pullPreset(name)),
      mk('✕', 'Delete from SD + flash mirror', async () => {
        if (transferActive()) { consoleLog('err', 'Wait for the current transfer to finish before deleting (a dialog would stall it)'); return; }
        if (!confirm(`Delete ${name} from the pedal?`)) return;
        try { await sendCmd('rm ' + name); await refreshDeviceList(); } catch (e) {}
      }, 'danger'));
    box.appendChild(row);
  });
}

/* ---------------- footswitches (PROTOCOL.md "Footswitches") ---------------- */
function renderSwitches() {
  const box = $('#swBox');
  box.textContent = '';
  const sw = dev.switches;
  const hint = txt => { const d = document.createElement('div'); d.className = 'hint'; d.textContent = txt; box.appendChild(d); };
  if (!link.connected) { hint('Connect to configure the six footswitches.'); return; }
  if (!sw) { hint('Reading the footswitch configuration…'); return; }
  const head = document.createElement('div'); head.className = 'sw-head';
  for (const t of ['SW', 'TAP', 'HOLD', 'NOTE']) { const s = document.createElement('span'); s.textContent = t; head.appendChild(s); }
  box.appendChild(head);
  const actions = (Array.isArray(sw.actions) && sw.actions.length) ? sw.actions : ['none'];
  sw.switches.slice(0, 6).forEach((s, i) => {
    const n = i + 1;                                     // switch n = pin n-1
    const row = document.createElement('div'); row.className = 'sw-row';
    const lbl = document.createElement('span'); lbl.className = 'swn';
    const nb = document.createElement('b'); nb.textContent = String(n);
    lbl.append(nb, document.createTextNode('pin ' + (n - 1)));
    const mkSel = (val, what) => {
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', `Switch ${n} ${what} action`);
      for (const a of actions) { const o = document.createElement('option'); o.value = a; o.textContent = a; sel.appendChild(o); }
      if (!actions.includes(val)) { const o = document.createElement('option'); o.value = val; o.textContent = val; sel.appendChild(o); }
      sel.value = val;
      return sel;
    };
    const tap = mkSel(s.tap || 'none', 'tap'), hold = mkSel(s.hold || 'none', 'hold');
    const note = document.createElement('input');
    note.type = 'number'; note.min = 0; note.max = 127; note.step = 1; note.value = s.note || 0;
    note.setAttribute('aria-label', `Switch ${n} MIDI note`);
    note.title = 'MIDI note played on channel 10 while held';
    const needNote = () => tap.value === 'note' || hold.value === 'note';
    note.hidden = !needNote();
    const apply = async () => {
      note.hidden = !needNote();
      const args = ['switch', n, tap.value, hold.value];
      if (needNote()) args.push(clamp(Math.round(+note.value) || 0, 0, 127));
      row.style.opacity = '.5';
      try {
        await sendCmd(args.join(' '));
        await sendCmd('switches');                       // re-read: the pedal's view wins
      } catch (e) {
        consoleLog('err', `Footswitch ${n} not changed — reverting the row`);
        renderSwitches();                                // back to the last known configuration
      }
    };
    tap.addEventListener('change', apply);
    hold.addEventListener('change', apply);
    note.addEventListener('change', apply);
    row.append(lbl, tap, hold, note);
    box.appendChild(row);
  });
}

/* ---------------- loops — /loops on the SD card (PROTOCOL.md "loop …") ---------------- */
async function refreshLoops() { try { await sendCmd('loops'); } catch (e) {} }

function renderLoops() {
  const box = $('#loopsBox');
  box.textContent = '';
  const L = dev.loops;
  const ready = !!(link.connected && L && L.sd);
  for (const id of ['loopSaveName', 'loopSaveBtn', 'loopUploadBtn']) $('#' + id).disabled = !ready;
  $('#loopsRefresh').disabled = !link.connected;
  const hint = txt => { const d = document.createElement('div'); d.className = 'hint'; d.textContent = txt; box.appendChild(d); };
  if (!link.connected) { $('#loopOffer').hidden = true; hint('Connect to browse the loops on the SD card.'); return; }
  if (!L) { hint('Reading loops…'); return; }
  if (!L.sd) { hint('Insert an SD card to save loops.'); return; }
  const names = Array.isArray(L.loops) ? L.loops : [];
  if (!names.length) hint('No loops on the card yet — save the current loop or upload a WAV.');
  for (const name of names) {
    const row = document.createElement('div'); row.className = 'looprow';
    const s = document.createElement('span'); s.textContent = name; s.title = name;
    const mk = (txt, title, fn, cls) => {
      const b = document.createElement('button');
      b.className = 'btn sm' + (cls ? ' ' + cls : '');
      b.textContent = txt; b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    row.append(s,
      mk('Load', 'Replace the looper contents with this file', () => loopLoad(name)),
      mk('Edit', 'Open in the loop editor (trim, gain, fades, reverse)', () => loopEdit(name)),
      mk('⤓', 'Download the WAV to this computer', () => loopDownload(name)),
      mk('✕', 'Delete from the SD card', () => loopDelete(name), 'danger'));
    box.appendChild(row);
  }
  if (typeof L.seconds_max === 'number') {
    const d = document.createElement('div'); d.className = 'hint'; d.style.marginTop = '4px';
    d.textContent = `Loop capacity ${L.seconds_max.toFixed(0)} s · 16-bit 44.1 kHz WAV up to ${Math.round(MAX_LOOP_BYTES / 1048576)} MB`;
    box.appendChild(d);
  }
}

/** "*.wav", no spaces (the protocol tokenizes on spaces). Returns null + logs when unusable. */
/** Names the pedal lists back unchanged: [A-Za-z0-9._-] only, ".wav" lower-case, at most
 *  64 characters (the firmware rejects longer names and quotes; #LOOPS escapes others). */
function loopFileName(raw) {
  const orig = String(raw || '').trim().replace(/^.*[\\/]/, '');
  if (!orig) return null;
  let base = orig.replace(/\.wav$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
  if (!base) { consoleLog('err', `"${orig}" leaves no usable characters for a loop name`); return null; }
  base = base.slice(0, LOOP_NAME_MAX - 4).replace(/[._-]+$/, '');
  const name = base + '.wav';
  if (name !== orig && name !== orig + '.wav') consoleLog('info', `Loop name normalised for the pedal: "${orig}" -> ${name}`);
  return name;
}
/** Does a loop of this length fit the looper (seconds_max from #LOOPS)? */
function loopFits(secs, name) {
  const max = (dev.loops && typeof dev.loops.seconds_max === 'number') ? dev.loops.seconds_max : null;
  if (max !== null && secs > max) { consoleLog('err', `${name} is ${secs.toFixed(1)} s — the looper holds up to ${max} s`); return false; }
  return true;
}
/** loop load <name>; resolves true when the pedal took it. */
async function loopLoad(name) {
  try { const r = await sendCmd(`loop load ${name}`, { timeout: 60000 }); consoleLog('info', 'Looper: ' + r.ok); return true; }
  catch (e) { return false; }
}
async function loopDelete(name) {
  if (transferActive()) { consoleLog('err', 'Wait for the current transfer to finish before deleting (a dialog would stall it)'); return; }
  if (!confirm(`Delete ${name} from the SD card?`)) return;
  try { await sendCmd(`loop rm ${name}`); await refreshLoops(); } catch (e) {}
}
async function loopSaveCurrent() {
  const name = loopFileName($('#loopSaveName').value);
  if (!name) return;
  try {
    const r = await sendCmd(`loop save ${name}`, { timeout: 60000 });
    consoleLog('info', 'Saved loop: ' + r.ok);
    $('#loopSaveName').value = '';
    await refreshLoops();
  } catch (e) {}
}
/** loop get <name> -> Uint8Array (progress shown in the Loops section). */
async function loopFetch(name) {
  const prog = progressUi('Downloading ' + name);
  try {
    const r = await sendCmd(`loop get ${name}`, { kind: 'getbin', onProgress: prog });
    return r.bytes;
  } finally { progressDone(prog); }
}
/** loop put <name> <len> + payload, sliced with back-pressure by writePayload. */
async function loopPut(name, bytes) {
  if (bytes.length > MAX_LOOP_BYTES)
    throw new Error(`${name} is ${fmtBytes(bytes.length)} — the limit is ${Math.round(MAX_LOOP_BYTES / 1048576)} MB`);
  const prog = progressUi('Uploading ' + name);
  try { await sendCmd(`loop put ${name} ${bytes.length}`, { payload: bytes, kind: 'send', onProgress: prog }); }
  finally { progressDone(prog); }
}
async function loopDownload(name) {
  try {
    const bytes = await loopFetch(name);
    saveBlob(new Blob([bytes], { type: 'audio/wav' }), name);
    consoleLog('info', `Downloaded ${name} (${fmtBytes(bytes.length)})`);
  } catch (e) {}
}
async function loopEdit(name) {
  try { openLoopEditor(name, await loopFetch(name)); } catch (e) {}
}
async function loopUploadFile(file) {
  const name = loopFileName(file.name);
  if (!name) return;
  if (transferActive()) { consoleLog('err', 'Wait for the current transfer to finish before uploading'); return; }
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch (e) { consoleLog('err', 'Read file: ' + e.message); return; }
  const info = isWav(bytes) ? wavInfo(bytes) : null;
  if (!info) { consoleLog('err', `${file.name} is not a RIFF/WAVE file`); return; }
  // The pedal only loads 16-bit PCM, mono/stereo, 44.1 kHz — anything else (a typical
  // 48 kHz / 24-bit / float DAW export) would be stored as a dead loop, so convert first.
  const conforming = info.format === 1 && info.bits === 16 && (info.channels === 1 || info.channels === 2) && info.rate === LOOP_RATE;
  let secs = info.dataBytes / Math.max(1, info.rate * info.channels * (info.bits / 8));
  if (!conforming) {
    const desc = `${info.format === 3 ? 'float' : info.format === 1 ? 'PCM' : 'format ' + info.format} ${info.bits}-bit, ${info.channels} ch, ${info.rate} Hz`;
    if (!confirm(`${file.name} is ${desc} — the pedal needs 16-bit PCM, mono or stereo, 44.1 kHz.\n\nConvert to 16-bit 44.1 kHz mono and upload it as ${name}?`)) {
      consoleLog('info', `Upload cancelled: ${file.name} (${desc})`);
      return;
    }
    try {
      const buf = await edCtx().decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      let mono = toMono(buf);
      if (buf.sampleRate !== LOOP_RATE) mono = resampleLinear(mono, buf.sampleRate, LOOP_RATE);
      bytes = encodeWav16Mono(mono, LOOP_RATE);
      secs = mono.length / LOOP_RATE;
      consoleLog('info', `Converted ${file.name} (${desc}) -> 16-bit 44.1 kHz mono, ${fmtBytes(bytes.length)}`);
    } catch (e) { consoleLog('err', `Cannot convert ${file.name}: ${(e && e.message) || e}`); return; }
  }
  if (!loopFits(secs, name)) return;
  try {
    await loopPut(name, bytes);
    consoleLog('info', `Uploaded ${name} (${fmtBytes(bytes.length)})`);
    await refreshLoops();
    offerLoad(name);
  } catch (e) { consoleLog('err', 'Upload: ' + e.message); }
}
function offerLoad(name) {
  const box = $('#loopOffer');
  box.textContent = '';
  const s = document.createElement('span'); s.textContent = `Uploaded ${name}.`;
  const b = document.createElement('button'); b.className = 'btn sm accent'; b.textContent = 'Load it';
  b.addEventListener('click', () => { box.hidden = true; loopLoad(name); });
  const x = document.createElement('button'); x.className = 'mini'; x.innerHTML = '&#10005;'; x.title = 'Dismiss';
  x.addEventListener('click', () => { box.hidden = true; });
  box.append(s, b, x);
  box.hidden = false;
}
function isWav(b) {
  return b.length > 44 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
         b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45;      // "RIFF" … "WAVE"
}
function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'; }
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
/* Transfer progress bar in the Loops section (throttled to ~16 fps). Transfers are
   queued, so the box is claimed by whichever transfer is actually running (first
   callback) and only hidden once no further transfer is active or queued. */
let progCur = null;                                      // token of the transfer showing in the box
function progressUi(label) {
  const token = { t: 0 };
  const cb = (done, total) => {
    const box = $('#loopProg');
    if (progCur !== token) {                             // take the box over
      progCur = token; token.t = 0;
      box.hidden = false;
      box.querySelector('i').style.width = '0%';
    }
    const now = performance.now();
    if (total && done < total && now - token.t < 60) return;
    token.t = now;
    const pct = total ? Math.round(100 * done / total) : 0;
    box.querySelector('i').style.width = pct + '%';
    box.querySelector('.prog-lbl').textContent = total
      ? `${label} · ${fmtBytes(done)} / ${fmtBytes(total)} (${pct}%)`
      : `${label} — waiting for the pedal …`;
  };
  cb.token = token;
  return cb;
}
function progressDone(cb) {
  const box = $('#loopProg');
  if (!box) return;
  if (cb && progCur && cb.token !== progCur) return;     // a later transfer owns the box now
  if ([link.active, ...link.queue].some(c => c && c.onProgress)) return;   // more transfers pending
  progCur = null;
  box.hidden = true;
}

/* ---------------- loop editor (Web Audio) ---------------- */
const ed = { name: '', buf: null, mono: null, sr: LOOP_RATE, start: 0, end: 0, gainDb: 0,
             normalize: false, reverse: false, fadeIn: 0, fadeOut: 0,
             ctx: null, src: null, drag: null, peaks: null };

/** A 44.1 kHz context: decodeAudioData resamples to the context rate, so the pedal's
 *  own rate comes out directly (the browser's resampler handles 48 k sources; the
 *  linear fallback in renderEdited only runs if the rate could not be requested). */
function edCtx() {
  if (!ed.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    try { ed.ctx = new AC({ sampleRate: LOOP_RATE }); } catch (e) { ed.ctx = new AC(); }
  }
  if (ed.ctx.state === 'suspended') ed.ctx.resume().catch(() => {});
  return ed.ctx;
}
/** Source format straight from the RIFF header (before Web Audio resamples it). */
function wavInfo(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let fmt = null, dataBytes = 0;
  for (let pos = 12; pos + 8 <= b.length;) {
    const id = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]), size = dv.getUint32(pos + 4, true);
    if (id === 'fmt ' && size >= 16 && pos + 24 <= b.length) {
      let format = dv.getUint16(pos + 8, true);
      if (format === 0xFFFE && size >= 40 && pos + 34 <= b.length) format = dv.getUint16(pos + 32, true);   // WAVE_FORMAT_EXTENSIBLE: sub-format
      fmt = { format, channels: dv.getUint16(pos + 10, true), rate: dv.getUint32(pos + 12, true), bits: dv.getUint16(pos + 22, true) };
    } else if (id === 'data') dataBytes = Math.min(size, b.length - pos - 8);
    pos += 8 + size + (size & 1);
  }
  return fmt ? Object.assign(fmt, { dataBytes }) : null;
}
async function openLoopEditor(name, bytes) {
  let buf;
  try {
    // decodeAudioData detaches the buffer it is given, so hand it a private copy
    buf = await edCtx().decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } catch (e) { consoleLog('err', `Cannot decode ${name}: ${(e && e.message) || e}`); return; }
  stopPreview();
  ed.name = name; ed.buf = buf; ed.sr = buf.sampleRate; ed.mono = toMono(buf); ed.peaks = null;
  ed.start = 0; ed.end = buf.duration; ed.gainDb = 0; ed.normalize = false; ed.reverse = false; ed.fadeIn = 0; ed.fadeOut = 0;
  const src = (isWav(bytes) && wavInfo(bytes)) || { format: 1, channels: buf.numberOfChannels, rate: buf.sampleRate, bits: 0 };
  $('#edName').textContent = name;
  $('#edInfo').textContent = `${src.channels === 1 ? 'mono' : src.channels + ' ch'} · ${src.bits ? src.bits + '-bit · ' : ''}${src.rate} Hz · ${buf.duration.toFixed(2)} s`
    + (src.rate !== LOOP_RATE ? ` · resampled to ${LOOP_RATE} Hz` : '')
    + (src.channels > 1 ? ' · summed to mono' : '');
  $('#edSaveName').value = name;
  $('#edGain').value = 0; $('#edGainRo').textContent = '0 dB';
  $('#edFadeIn').value = 0; $('#edFadeOut').value = 0;
  $('#edNormalize').classList.remove('active'); $('#edReverse').classList.remove('active');
  syncEdSend();                                          // disabled while the looper records
  $('#loopEdModal').hidden = false;
  syncEdInputs();
  drawWave();
}
function closeLoopEditor() {
  if ($('#loopEdModal').hidden) return;
  stopPreview();
  $('#loopEdModal').hidden = true;
}
function toMono(buf) {
  const n = buf.length, out = new Float32Array(n), chans = buf.numberOfChannels;
  for (let c = 0; c < chans; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / chans;
  }
  return out;
}
function syncEdInputs() {
  const dur = ed.buf ? ed.buf.duration : 0;
  $('#edStart').max = $('#edEnd').max = dur.toFixed(2);
  $('#edStart').value = ed.start.toFixed(2);
  $('#edEnd').value = ed.end.toFixed(2);
}
function setTrim(start, end) {
  const dur = ed.buf ? ed.buf.duration : 0;
  start = clamp(isFinite(start) ? start : 0, 0, dur);
  end = clamp(isFinite(end) ? end : dur, 0, dur);
  if (end - start < 0.01) {                                // keep at least 10 ms selected
    if (ed.drag === 'start') start = Math.max(0, end - 0.01); else end = Math.min(dur, start + 0.01);
  }
  ed.start = start; ed.end = end;
  syncEdInputs();
  drawWave();
}
function drawWave() {
  const cv = $('#waveCanvas');
  if (!ed.mono || !ed.buf || $('#loopEdModal').hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.floor(cv.clientWidth)), H = 180;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) {
    cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr); ed.peaks = null;
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const teal = css.getPropertyValue('--teal').trim() || '#2dd4bf';
  const accent = css.getPropertyValue('--accent').trim() || '#ffb454';
  const mono = css.getPropertyValue('--mono').trim() || 'monospace';
  g.fillStyle = '#12151b'; g.fillRect(0, 0, W, H);
  if (!ed.peaks || ed.peaks.length !== W * 2) {            // min/max per column, cached per width
    const pk = new Float32Array(W * 2), d = ed.mono, n = d.length;
    for (let x = 0; x < W; x++) {
      const a = Math.floor(x * n / W), b = Math.max(a + 1, Math.floor((x + 1) * n / W));
      let lo = 1, hi = -1;
      for (let i = a; i < b && i < n; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      pk[x * 2] = Math.min(lo, hi); pk[x * 2 + 1] = Math.max(lo, hi);
    }
    ed.peaks = pk;
  }
  const dur = ed.buf.duration, xs = ed.start / dur * W, xe = ed.end / dur * W;
  g.fillStyle = 'rgba(45,212,191,.08)'; g.fillRect(xs, 0, xe - xs, H);
  g.strokeStyle = '#262b36'; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  const gain = Math.pow(10, ed.gainDb / 20), half = H / 2 - 4;
  for (let x = 0; x < W; x++) {
    const inside = x >= xs && x <= xe, k = inside ? gain : 1;
    g.fillStyle = inside ? teal : 'rgba(138,144,160,.35)';
    const lo = clamp(ed.peaks[x * 2] * k, -1, 1), hi = clamp(ed.peaks[x * 2 + 1] * k, -1, 1);
    const y1 = H / 2 - hi * half, y2 = H / 2 - lo * half;
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  for (const x of [xs, xe]) {                              // trim handles: copper line + grips
    const px = Math.round(x);
    g.fillStyle = accent;
    g.fillRect(px - 1, 0, 2, H);
    g.fillRect(px - 5, 0, 10, 12);
    g.fillRect(px - 5, H - 12, 10, 12);
  }
  g.font = '10px ' + mono; g.textBaseline = 'top'; g.fillStyle = accent;
  g.textAlign = xs > 48 ? 'right' : 'left';
  g.fillText(ed.start.toFixed(2) + ' s', xs + (xs > 48 ? -8 : 8), 16);
  g.textAlign = xe < W - 48 ? 'left' : 'right';
  g.fillText(ed.end.toFixed(2) + ' s', xe + (xe < W - 48 ? 8 : -8), 16);
  g.textAlign = 'right'; g.fillStyle = '#8a90a0';
  g.fillText(`${(ed.end - ed.start).toFixed(2)} s selected`, W - 8, H - 26);
}
function edPointerTime(e) {
  const r = $('#waveCanvas').getBoundingClientRect();
  return clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1) * ed.buf.duration;
}
function edPointerDown(e) {
  if (!ed.buf) return;
  const t = edPointerTime(e);
  ed.drag = Math.abs(t - ed.start) <= Math.abs(t - ed.end) ? 'start' : 'end';   // nearest handle
  try { $('#waveCanvas').setPointerCapture(e.pointerId); } catch (err) {}
  edPointerMove(e);
}
function edPointerMove(e) {
  if (!ed.drag || !ed.buf) return;
  const t = edPointerTime(e);
  if (ed.drag === 'start') setTrim(Math.min(t, ed.end), ed.end);
  else setTrim(ed.start, Math.max(t, ed.start));
}
function edPointerUp() { ed.drag = null; }

/** Trim -> reverse -> normalize/gain -> fades -> resample to 44.1 k: what Send / Download write. */
function renderEdited() {
  const sr = ed.sr, d = ed.mono;
  let s = clamp(Math.floor(ed.start * sr), 0, d.length), e = clamp(Math.ceil(ed.end * sr), 0, d.length);
  if (e <= s) e = Math.min(d.length, s + 1);
  let out = d.slice(s, e);
  if (ed.reverse) out.reverse();
  let g = Math.pow(10, ed.gainDb / 20);
  if (ed.normalize) {
    let pk = 0;
    for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > pk) pk = a; }
    if (pk > 0) g /= pk;
  }
  if (g !== 1) for (let i = 0; i < out.length; i++) out[i] *= g;
  const fi = Math.min(out.length, Math.round(ed.fadeIn / 1000 * sr));
  const fo = Math.min(out.length, Math.round(ed.fadeOut / 1000 * sr));
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo;
  if (sr !== LOOP_RATE) out = resampleLinear(out, sr, LOOP_RATE);
  return out;
}
function resampleLinear(src, from, to) {
  const n = Math.max(1, Math.round(src.length * to / from)), out = new Float32Array(n), ratio = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * ratio, k = Math.floor(p), f = p - k;
    const a = src[Math.min(k, src.length - 1)], b = src[Math.min(k + 1, src.length - 1)];
    out[i] = a + (b - a) * f;
  }
  return out;
}
/** Standalone encoder: Float32 samples (-1..1) -> 16-bit PCM mono RIFF/WAVE bytes. */
function encodeWav16Mono(samples, sampleRate) {
  const n = samples.length, bytes = new Uint8Array(44 + n * 2), dv = new DataView(bytes.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) bytes[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  tag(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0, o = 44; i < n; i++, o += 2) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(o, Math.round(v < 0 ? v * 32768 : v * 32767), true);
  }
  return bytes;
}
function editedWav() { return encodeWav16Mono(renderEdited(), LOOP_RATE); }

function startPreview() {
  if (!ed.buf) return;
  stopPreview();
  const ctx = edCtx();
  const data = renderEdited();
  const ab = ctx.createBuffer(1, data.length, LOOP_RATE);
  ab.copyToChannel(data, 0);
  const src = ctx.createBufferSource();
  src.buffer = ab;
  src.connect(ctx.destination);
  src.onended = () => { if (ed.src === src) { ed.src = null; $('#edPreview').innerHTML = '&#9654; Preview'; } };
  src.start();
  ed.src = src;
  $('#edPreview').innerHTML = '&#9632; Stop';
}
function stopPreview() {
  if (ed.src) { try { ed.src.stop(); } catch (e) {} ed.src = null; }
  const b = $('#edPreview'); if (b) b.innerHTML = '&#9654; Preview';
}
function looperBusy() { const st = (dev.loop && dev.loop.state) || 'empty'; return st === 'recording' || st === 'overdubbing'; }
/** "Send to pedal" is disabled while the looper records (loading would cut the take). */
function syncEdSend() {
  const b = $('#edSend');
  if (!b) return;
  b.disabled = !link.connected || looperBusy();
  b.title = !link.connected ? 'Connect to the pedal first'
          : looperBusy() ? 'Stop the looper first — loading a file replaces the loop being recorded'
          : 'Upload the edited file, then load it into the looper';
}
async function edSendToPedal() {
  const name = loopFileName($('#edSaveName').value);
  if (!name || !link.connected) return;
  if (looperBusy()) { consoleLog('err', 'The looper is recording — stop it before sending a loop'); return; }
  const wav = editedWav();
  const secs = (wav.length - 44) / (2 * LOOP_RATE);
  if (!loopFits(secs, name)) return;
  $('#edSend').disabled = true;
  try {
    await loopPut(name, wav);
    consoleLog('info', `Sent ${name} (${fmtBytes(wav.length)}, ${secs.toFixed(2)} s)`);
    await refreshLoops();
    // Loading replaces the live loop and clears its undo layer — ask when there is one.
    const L = dev.loop || {};
    if (looperBusy()) { consoleLog('info', `${name} is on the card — the looper is recording, so it was not loaded`); offerLoad(name); closeLoopEditor(); return; }
    if (L.state && L.state !== 'empty' &&
        !confirm(`Load ${name} into the looper now?\n\nThis replaces the current ${(L.len_s || 0).toFixed(1)} s loop and clears undo.`)) {
      offerLoad(name);
      closeLoopEditor();
      return;
    }
    if (await loopLoad(name)) closeLoopEditor();
    else offerLoad(name);                                // the pedal refused — keep the editor open
  } catch (e) { consoleLog('err', 'Send: ' + e.message); }
  finally { syncEdSend(); }
}

/* ---- VU meter animation (smooth bars + peak-hold ticks) ---- */
let lastVuT = 0;
function vuFrame(t) {
  const dt = Math.min(0.1, (t - lastVuT) / 1000 || 0.016);
  lastVuT = t;
  for (const ch of ['in', 'out']) {
    const v = dev.vu[ch];
    if (v.tgt >= v.val) v.val = v.tgt;                    // instant attack
    else v.val = Math.max(v.tgt, v.val - 1.6 * dt);       // smooth release
    if (v.tgt >= v.peak - 0.001) { v.peak = v.tgt; v.peakTs = t; }
    else if (t - v.peakTs > 1200) v.peak = Math.max(v.val, v.peak - 0.8 * dt);
    const el = $(ch === 'in' ? '#vuIn' : '#vuOut');
    el.querySelector('.vu-cover').style.width = (100 - v.val * 100).toFixed(1) + '%';
    el.querySelector('.vu-peak').style.left = 'calc(' + (v.peak * 100).toFixed(1) + '% - 1px)';
    $(ch === 'in' ? '#vuInText' : '#vuOutText').textContent = link.connected ? v.tgt.toFixed(2) : '-';
  }
  requestAnimationFrame(vuFrame);
}

/* ---------------- top-level render ---------------- */
function renderAll() {
  midi.presetRev = (midi.presetRev || 0) + 1;
  renderLibrary();
  renderChain();
  renderCode();
}

