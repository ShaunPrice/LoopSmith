/* ==========================================================================
   Layout — panels, regions and views.

   Every block of the interface is a panel: the sections of the device column,
   the preset library, the chain editor and the PatchScript pane. Panels live
   in one of three regions (left column, centre, right column) or are hidden,
   and can be moved between them from the menu on their header or by dragging
   the header. An arrangement can be kept as a named view; the current
   arrangement is remembered between visits either way. A region with nothing
   in it collapses so the centre gets the room.
   ========================================================================== */
const LAYOUT_KEY = 'gls.layout.v1';
const LAYOUT_REGIONS = ['library', 'center', 'device'];
const layout = { def: null, views: {}, current: null, name: 'Build', drag: null };

function panelEls() { return [...document.querySelectorAll('.panel')]; }
function panelHead(p) { return p.querySelector(':scope > h3, :scope > .side-head, :scope > #chainBar, :scope > .pane-head'); }
function panelTitle(p) {
  if (p.dataset.title) return p.dataset.title;
  const h = panelHead(p);
  return (h ? h.textContent : p.id).replace(/[▼▶]/g, '').trim().split('\n')[0].slice(0, 24);
}
function regionOf(p) { const r = p.parentElement; return r && LAYOUT_REGIONS.includes(r.id) ? r.id : 'hidden'; }

/** The arrangement as data: which panels sit where, and which are folded. */
function layoutSnapshot() {
  const regions = {};
  for (const r of LAYOUT_REGIONS) regions[r] = [...$('#' + r).children].filter(e => e.classList.contains('panel')).map(e => e.id);
  regions.hidden = [...$('#panelHidden').children].map(e => e.id);
  return { regions, closed: panelEls().filter(p => p.classList.contains('closed')).map(p => p.id) };
}
function layoutHome(id) {
  return (layout.def && Object.keys(layout.def.regions).find(r => layout.def.regions[r].includes(id))) || 'device';
}
function layoutApply(lay) {
  const seen = new Set();
  for (const r of [...LAYOUT_REGIONS, 'hidden']) {
    const host = r === 'hidden' ? $('#panelHidden') : $('#' + r);
    for (const id of (lay.regions[r] || [])) {
      const p = $('#' + id);
      if (p && p.classList.contains('panel') && !seen.has(id)) { host.appendChild(p); seen.add(id); }
    }
  }
  // anything the view does not mention (a panel added since it was saved) goes home
  for (const p of panelEls()) if (!seen.has(p.id)) {
    const home = layoutHome(p.id);
    (home === 'hidden' ? $('#panelHidden') : $('#' + home)).appendChild(p);
  }
  const closed = new Set(lay.closed || []);
  for (const p of panelEls()) if (p.classList.contains('coll')) p.classList.toggle('closed', closed.has(p.id));
  layoutAfter();
}
function layoutAfter() {
  for (const r of LAYOUT_REGIONS) $('#' + r).classList.toggle('empty', ![...$('#' + r).children].some(e => e.classList.contains('panel')));
  if (typeof scorePaint === 'function' && score.model) scorePaint();     // the score draws larger in the centre
  layoutSave();
  layoutPaintSelect();
}
function layoutSave() {
  layout.current = layoutSnapshot();
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ views: layout.views, current: layout.current, name: layout.name })); } catch (e) {}
}
function layoutBuiltins() {
  const d = layout.def, all = [...d.regions.library, ...d.regions.center, ...d.regions.device, ...d.regions.hidden];
  const without = (arr, ...ids) => arr.filter(x => !ids.includes(x));
  const playRight = ['devSec', 'looperSec', 'outputSec', 'midiSec', 'chanSec'];
  const scoreRight = ['devSec', 'midiSec', 'chanSec', 'looperSec', 'outputSec'];
  return {
    Build: d,
    Play: { regions: { library: ['libSec'], center: ['scoreSec', 'chainWrap'],
                       device: [...playRight, ...without(d.regions.device, ...playRight, 'scoreSec')],
                       hidden: ['codePane'] },
            closed: ['meterSec', 'liveSec', 'swSec', 'sysSec'] },
    Score: { regions: { library: [], center: ['scoreSec'], device: scoreRight,
                        hidden: without(all, 'scoreSec', ...scoreRight) },
             closed: [] },
  };
}
function layoutViewNames() { return [...Object.keys(layoutBuiltins()), ...Object.keys(layout.views)]; }
function layoutUse(name) {
  const lay = layoutBuiltins()[name] || layout.views[name];
  if (!lay) return;
  layout.name = name;
  layoutApply(lay);
}
function layoutPaintSelect() {
  const sel = $('#viewSel'); if (!sel) return;
  const names = layoutViewNames();
  sel.innerHTML = names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')
    + '<option disabled>&#8212;&#8212;&#8212;&#8212;&#8212;&#8212;</option>'
    + '<option value=" save">Save layout as view&#8230;</option>'
    + (layout.views[layout.name] ? '<option value=" delete">Delete this view</option>' : '')
    + '<option value=" unhide">Show hidden panels</option>'
    + '<option value=" reset">Reset to Build</option>';
  sel.value = names.includes(layout.name) ? layout.name : 'Build';
  // an edited arrangement is flagged, so the name is not a lie
  const base = layoutBuiltins()[layout.name] || layout.views[layout.name];
  const dirty = base && JSON.stringify(base.regions) !== JSON.stringify(layoutSnapshot().regions);
  sel.classList.toggle('dirty', !!dirty);
  sel.title = dirty ? `Panels have moved since "${layout.name}" - save the arrangement as a view to keep it` : 'Choose how the panels are arranged';
}
function layoutSelectChanged(ev) {
  const v = ev.target.value;
  if (v === ' save') {
    const name = (prompt('Name for this view:', layout.views[layout.name] ? layout.name : '') || '').trim();
    if (name && !layoutBuiltins()[name]) { layout.views[name] = layoutSnapshot(); layout.name = name; layoutSave(); consoleLog('ok', `Saved view "${name}"`); }
    else if (name) consoleLog('err', `"${name}" is a built-in view - pick another name`);
  } else if (v === ' delete') {
    if (layout.views[layout.name] && confirm(`Delete the view "${layout.name}"?`)) { delete layout.views[layout.name]; layout.name = 'Build'; layoutSave(); }
  } else if (v === ' unhide') {
    for (const p of [...$('#panelHidden').children]) { const home = layoutHome(p.id); $('#' + (home === 'hidden' ? 'device' : home)).appendChild(p); }
    layoutAfter();
  } else if (v === ' reset') { layoutUse('Build'); }
  else if (v && !v.startsWith(' ')) layoutUse(v);
  layoutPaintSelect();
}

/* ---- moving a panel: the header menu, and dragging the header ---- */
function panelMove(p, region, before) {
  const host = region === 'hidden' ? $('#panelHidden') : $('#' + region);
  if (before && before.parentElement === host) host.insertBefore(p, before); else host.appendChild(p);
  layoutAfter();
}
function panelMenuOpen(p, anchor) {
  const menu = $('#panelMenu');
  const r = regionOf(p), sib = [...p.parentElement.children].filter(e => e.classList.contains('panel'));
  const i = sib.indexOf(p);
  const items = [
    ['Move to left column', () => panelMove(p, 'library'), r !== 'library'],
    ['Move to centre', () => panelMove(p, 'center'), r !== 'center'],
    ['Move to right column', () => panelMove(p, 'device'), r !== 'device'],
    ['Move up', () => panelMove(p, r, sib[i - 1]), r !== 'hidden' && i > 0],
    ['Move down', () => panelMove(p, r, sib[i + 2] || null), r !== 'hidden' && i < sib.length - 1],
    ['Hide panel', () => panelMove(p, 'hidden'), r !== 'hidden'],
  ].filter(x => x[2]);
  menu.textContent = '';
  const t = document.createElement('div'); t.className = 'pm-title'; t.textContent = panelTitle(p); menu.appendChild(t);
  for (const [label, fn] of items) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('click', () => { panelMenuClose(); fn(); });
    menu.appendChild(b);
  }
  const box = anchor.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = Math.max(4, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.min(box.bottom + 4, window.innerHeight - menu.offsetHeight - 8) + 'px';
  setTimeout(() => document.addEventListener('click', panelMenuClose, { once: true }), 0);
}
function panelMenuClose() { $('#panelMenu').hidden = true; }

function panelify() {
  const hidden = document.createElement('div'); hidden.id = 'panelHidden'; hidden.hidden = true; document.body.appendChild(hidden);
  const menu = document.createElement('div'); menu.id = 'panelMenu'; menu.hidden = true; document.body.appendChild(menu);
  const candidates = [...document.querySelectorAll('#library > .dev-sec, #center > .dev-sec, #device > .dev-sec, #chainWrap, #codePane')];
  for (const p of candidates) {
    if (!p.id) continue;
    p.classList.add('panel');
    const h = panelHead(p); if (!h) continue;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pmove'; b.innerHTML = '&#8942;'; b.title = 'Move this panel';
    b.setAttribute('aria-label', 'Move ' + panelTitle(p));
    b.addEventListener('click', e => { e.stopPropagation(); panelMenuOpen(p, b); });
    h.appendChild(b);
    // drag by the header; a placeholder shows where it will land
    h.draggable = true;
    h.addEventListener('dragstart', e => {
      layout.drag = p; p.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', p.id); } catch (_) {}
    });
    h.addEventListener('dragend', () => { p.classList.remove('dragging'); layout.drag = null; const ph = $('#dropPh'); if (ph) ph.remove(); });
  }
  for (const r of LAYOUT_REGIONS) {
    const host = $('#' + r);
    host.addEventListener('dragover', e => {
      if (!layout.drag) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      let ph = $('#dropPh'); if (!ph) { ph = document.createElement('div'); ph.id = 'dropPh'; }
      const sibs = [...host.children].filter(x => x.classList.contains('panel') && x !== layout.drag);
      const next = sibs.find(s => { const bb = s.getBoundingClientRect(); return e.clientY < bb.top + bb.height / 2; });
      if (next) host.insertBefore(ph, next); else host.appendChild(ph);
    });
    host.addEventListener('drop', e => {
      if (!layout.drag) return;
      e.preventDefault();
      const ph = $('#dropPh');
      if (ph) { host.insertBefore(layout.drag, ph); ph.remove(); } else host.appendChild(layout.drag);
      layoutAfter();
    });
  }
  // the pedal-computer section reads last whatever order the builders ran in
  if ($('#sysSec') && $('#sysSec').parentElement === $('#device')) $('#device').appendChild($('#sysSec'));
  layout.def = layoutSnapshot();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); } catch (e) {}
  if (saved && saved.views) layout.views = saved.views;
  if (saved && saved.name) layout.name = saved.name;
  if (saved && saved.current && saved.current.regions) layoutApply(saved.current); else layoutAfter();
  $('#viewSel').addEventListener('change', layoutSelectChanged);
}

/* ==========================================================================
   Channels — which instrument answers which MIDI channel, in one place.

   Every instrument card carries a channel (kits included, since a kit is only
   pinned to 10 by default), so this panel is a view onto those settings: set a
   channel here and the card follows, and vice versa. Underneath, the channels
   the selected MIDI file actually plays are listed against what answers them,
   which is the same test the MIDI panel's tick and warning use.
   ========================================================================== */
function chanRows() {
  const p = current();
  return (p && p.mode === 'chain') ? instruments(p) : [];
}
function chanPaint() {
  const box = $('#chanBox'); if (!box) return;
  const p = current(), rows = chanRows();
  box.textContent = '';
  if (!p || p.mode === 'custom') {
    const b = presetBindings(p), used = new Set([...b.any, ...b.notes.keys()]);
    const d = document.createElement('div'); d.className = 'play-hint';
    d.textContent = used.size
      ? 'Custom routing — its midi() lines answer ' + [...used].sort((x, y) => x - y).map(c => 'ch ' + c).join(', ')
        + '. Edit the text to change them.'
      : 'Custom routing with no midi() bindings, so nothing answers any channel.';
    box.appendChild(d); chanPaintFile(); return;
  }
  if (!rows.length) {
    const d = document.createElement('div'); d.className = 'play-hint';
    d.textContent = 'No instruments in this preset yet — add one in the Instruments lane and it will appear here.';
    box.appendChild(d); chanPaintFile(); return;
  }
  const clash = new Map();
  for (const it of rows) clash.set(instChannel(it), (clash.get(instChannel(it)) || 0) + 1);
  rows.forEach((it, idx) => {
    const row = document.createElement('div'); row.className = 'chan-row';
    const name = document.createElement('span'); name.className = 'chan-name';
    name.textContent = MACRO_BY_ID[it.id].label;
    name.title = MACRO_BY_ID[it.id].note || '';
    const sel = document.createElement('select'); sel.className = 'midi-sel';
    for (let c = 1; c <= 16; c++) {
      const o = document.createElement('option');
      o.value = c; o.textContent = 'ch ' + c + (c === 10 ? ' (drums)' : '');
      if (c === instChannel(it)) o.selected = true;
      sel.appendChild(o);
    }
    sel.title = isPads(it) ? 'Which channel this kit answers. Its pads keep their General MIDI notes.'
                           : 'Which channel this instrument answers.';
    sel.addEventListener('change', ev => {
      it.p.channel = clamp(Math.round(+ev.target.value) || 1, 1, 16);
      releaseAllNotes(); structuralChange();
    });
    row.append(name, sel);
    if (clash.get(instChannel(it)) > 1 && !isPads(it)) {
      const w = document.createElement('span'); w.className = 'chan-warn'; w.textContent = '⚠';
      w.title = 'Another instrument answers this channel too — they will both play every note sent to it.';
      row.appendChild(w);
    }
    box.appendChild(row);
  });
  chanPaintFile();
}
/** What the file in the Score panel needs, against what now answers it. */
function chanPaintFile() {
  const line = $('#chanFile'); if (!line) return;
  const f = scoreFiles().find(x => x.name === score.file);
  if (!f || !f.uses) { line.textContent = ''; return; }
  const cov = midiCoverage(f), gaps = new Map((cov ? cov.gaps : []).map(g => [g.ch, g]));
  const parts = [...f.uses.keys()].sort((a, b) => a - b).map(ch => (gaps.has(ch) ? '⚠ ' : '✓ ') + 'ch' + ch);
  line.textContent = f.name + ' plays ' + parts.join(' · ');
  line.className = 'midi-line mono' + (gaps.size ? ' chan-gap' : '');
}
function chanBuildSection() {
  const sec = document.createElement('div'); sec.className = 'dev-sec coll'; sec.id = 'chanSec';
  sec.innerHTML = `<h3 role="button" tabindex="0"><span class="caret">&#9660;</span> MIDI CHANNELS</h3>
  <div class="sec-body" id="chanBody">
    <div id="chanBox"></div>
    <div class="midi-line mono" id="chanFile"></div>
  </div>`;
  const after = $('#midiSec') || $('#device').lastElementChild;
  after.insertAdjacentElement('afterend', sec);
  sec.querySelector('h3').addEventListener('click', () => sec.classList.toggle('closed'));
  chanPaint();
}

/* ==========================================================================
   Score — the notes of a MIDI file on staves, one per instrument, with a
   playhead that follows whoever is playing: the Pi (position_s, polled once a
   second and interpolated) or this browser's own player.

   MIDI stores times, not note values, so the notation is inferred: onsets and
   durations are snapped to a sixteenth grid, each duration is decomposed into
   notatable values (tied across barlines), and gaps become rests. That is
   sound for quantised material — everything the pedal ships with — so when a
   file does not sit on the grid the panel says so and draws the bars instead
   of pretending otherwise.
   ========================================================================== */
const SCORE_GRID = 4;                         // sixteenths per quarter note
const SCORE_PPQ_PX = 58;                      // horizontal pixels per quarter
const SCORE_GAP = 8;                          // staff line spacing
const SCORE_ROW = 86;                         // vertical pitch of one part
const SCORE_GUTTER = 104;                     // width of the part-name column

/* value -> how it is drawn. Ordered large to small: the decomposition is greedy. */
const SCORE_VALUES = [
  { q: 4,     open: true,  stem: false, flags: 0, dots: 0 },
  { q: 3,     open: true,  stem: true,  flags: 0, dots: 1 },
  { q: 2,     open: true,  stem: true,  flags: 0, dots: 0 },
  { q: 1.5,   open: false, stem: true,  flags: 0, dots: 1 },
  { q: 1,     open: false, stem: true,  flags: 0, dots: 0 },
  { q: 0.75,  open: false, stem: true,  flags: 1, dots: 1 },
  { q: 0.5,   open: false, stem: true,  flags: 1, dots: 0 },
  { q: 0.375, open: false, stem: true,  flags: 2, dots: 1 },
  { q: 0.25,  open: false, stem: true,  flags: 2, dots: 0 },
];
/* General MIDI drums on a percussion staff: steps above the bottom line
   (2 steps = one line), and the notehead each one is written with. */
const SCORE_PERC = {
  35: [1, 'n'], 36: [1, 'n'], 41: [2, 'n'], 43: [2, 'n'], 45: [4, 'n'], 47: [5, 'n'],
  37: [6, 'x'], 38: [6, 'n'], 40: [6, 'n'], 39: [7, 'x'], 48: [8, 'n'], 50: [8, 'n'],
  44: [-1, 'x'], 42: [9, 'x'], 46: [9, 'o'], 49: [11, 'x'], 51: [11, 'x'], 57: [11, 'x'],
  59: [11, 'x'], 52: [11, 'x'], 53: [11, 'x'], 54: [10, 'x'], 56: [10, 'x'], 70: [9, 'x'],
  60: [9, 'n'], 61: [8, 'n'], 62: [7, 'n'], 63: [7, 'n'], 64: [5, 'n'], 65: [4, 'n'],
  66: [3, 'n'], 67: [9, 'x'], 68: [8, 'x'], 69: [10, 'x'], 71: [10, 'x'], 72: [10, 'x'],
};
const SCORE_STEP = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];      // pitch class -> letter
const SCORE_SHARP = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];     // ...needs a sharp

