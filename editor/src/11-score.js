const score = { file: null, model: null, anchor: null, raf: null, notes: [], follow: true, zoom: 1 };

/** File names and instrument labels go into SVG/option markup, so escape them. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Diatonic position: 7 letters per octave, so staff steps are just subtraction. */
function scoreDiatonic(n) { return 7 * Math.floor(n / 12) + SCORE_STEP[n % 12]; }

/* ---- 1. the notes, paired off and grouped by channel ---- */
function scoreParts(parsed) {
  if (!parsed || !parsed.ppq || !parsed.raw) return null;
  const open = new Map(), byCh = new Map();
  let end = 0;
  const close = (ch, note, tick, o) => {
    if (!byCh.has(ch)) byCh.set(ch, []);
    byCh.get(ch).push({ tick: o.tick, dur: Math.max(1, tick - o.tick), note, vel: o.vel });
    end = Math.max(end, tick);
  };
  for (const { tick, m } of parsed.raw) {
    const st = m[0] & 0xF0, ch = (m[0] & 0x0F) + 1, key = ch + '/' + m[1];
    if (st === 0x90 && m[2]) { if (!open.has(key)) open.set(key, { tick, vel: m[2] }); }
    else if (st === 0x80 || st === 0x90) {
      const o = open.get(key); if (!o) continue;
      open.delete(key); close(ch, m[1], tick, o);
    }
  }
  for (const [key, o] of open) {                       // still held when the file ends
    const [ch, note] = key.split('/').map(Number);
    close(ch, note, o.tick + parsed.ppq, o);
  }
  const parts = [...byCh.entries()].map(([ch, notes]) => {
    notes.sort((a, b) => a.tick - b.tick || a.note - b.note);
    const perc = ch === 10;
    const med = notes.map(n => n.note).sort((a, b) => a - b)[notes.length >> 1];
    // Pick the clef by how far the part sits outside each staff, not by median
    // pitch: a guitar voicing straddling middle C reads badly in bass clef, and
    // a bass line an octave down needs eleven ledger lines in treble.
    const cost = (loNote, hiNote) => {
      const lo = scoreDiatonic(loNote), hi = scoreDiatonic(hiNote);
      return notes.reduce((a, n) => { const d = scoreDiatonic(n.note); return a + (d < lo ? lo - d : d > hi ? d - hi : 0); }, 0);
    };
    const clef = perc ? 'perc' : (cost(64, 77) <= cost(43, 57) ? 'treble' : 'bass');
    // A bass guitar an octave below the staff is written up an octave and
    // marked 8vb, the way a real part is — otherwise every note wears ledger
    // lines. Same in reverse for anything sitting well above its staff.
    let oct = 0;
    if (!perc) {
      const lo = clef === 'treble' ? 64 : 43, hi = clef === 'treble' ? 77 : 57;
      while (med + oct * 12 < lo - 3 && oct < 3) oct++;
      while (med + oct * 12 > hi + 3 && oct > -3) oct--;
    }
    return { ch, notes, perc, clef, oct, name: scorePartName(ch, perc) };
  });
  parts.sort((a, b) => (a.ch === 10) - (b.ch === 10) || a.ch - b.ch);   // drums last
  return { ppq: parsed.ppq, tsig: parsed.tsig, parts, end, length: parsed.length, tempos: parsed.tempos };
}
/** Name the staff after whatever the open preset binds to that channel. */
function scorePartName(ch, perc) {
  const p = current();
  if (p && Array.isArray(p.instruments)) {
    for (const it of p.instruments) {
      const def = MACRO_BY_ID[it.id]; if (!def) continue;
      if (instChannel(it) === ch) return def.label;
    }
  }
  return perc ? 'Drums' : 'Channel ' + ch;
}

/* ---- 2. onto the grid ---- */
function scoreQuantise(model) {
  const g = model.ppq / SCORE_GRID;
  let off = 0, n = 0;
  for (const p of model.parts) for (const note of p.notes) {
    off += Math.abs(note.tick - Math.round(note.tick / g) * g) > g / 4 ? 1 : 0; n++;
  }
  const tg = model.ppq / 3;                     // eighth-note triplets
  let toff = 0;
  for (const p of model.parts) for (const note of p.notes)
    toff += Math.abs(note.tick - Math.round(note.tick / tg) * tg) > tg / 4 ? 1 : 0;
  model.grid = g;
  model.loose = n ? off / n > 0.2 : false;      // too far off the grid to notate honestly
  model.swing = model.loose && n > 0 && toff / n < off / n / 2;   // ...because it swings
  for (const p of model.parts) for (const note of p.notes) {
    note.q = Math.round(note.tick / g) * g;
    note.qd = Math.max(g, Math.round(note.dur / g) * g);
  }
  return model;
}

/** Bar length in ticks at a given tick, from the file's time signature. */
function scoreBarAt(model, tick) {
  let num = 4, den = 4;
  for (const t of (model.tsig || [])) if (t[0] <= tick) { num = t[1]; den = t[2]; }
  return { ticks: num * (4 / den) * model.ppq, num, den };
}
function scoreBars(model) {
  const out = []; let t = 0, i = 0;
  const end = Math.max(model.end, model.ppq);
  while (t < end && i < 512) { const b = scoreBarAt(model, t); out.push({ tick: t, ticks: b.ticks, num: ++i }); t += b.ticks; }
  return out;
}

/* ---- 3. durations into notatable values ---- */
function scoreDecompose(ticks, ppq) {
  const out = []; let left = ticks;
  for (const v of SCORE_VALUES) {
    const t = v.q * ppq;
    while (left >= t - 1) { out.push({ v, ticks: t }); left -= t; if (out.length > 8) return out; }
  }
  if (!out.length) out.push({ v: SCORE_VALUES[SCORE_VALUES.length - 1], ticks: Math.max(1, ticks) });
  return out;
}

/* ---- 4. a part becomes noteheads, rests and ties ---- */
function scoreLayout(part, model) {
  const ppq = model.ppq, bars = model.bars;
  const barEndOf = (t) => { for (const b of bars) if (t < b.tick + b.ticks) return b.tick + b.ticks; return model.end; };

  /* chords: everything struck at the same instant shares a stem */
  const slotsOf = (notes) => {
    const out = [];
    for (const n of notes) {
      const last = out[out.length - 1];
      if (last && last.tick === n.q) { last.notes.push(n); last.dur = Math.min(last.dur, n.qd); }
      else out.push({ tick: n.q, dur: n.qd, notes: [n] });
    }
    // Nothing is drawn longer than the gap to the next attack. A drum hit is a
    // different case: it is unsustained and its note-off says nothing about the
    // rhythm, so it takes its value from the gap — otherwise a run of eighth
    // hats prints as sixteenth-plus-rest and never beams.
    for (let i = 0; i < out.length; i++) {
      const gap = (i + 1 < out.length ? out[i + 1].tick : model.end) - out[i].tick;
      out[i].dur = part.perc
        ? Math.min(Math.max(model.grid, gap || ppq), 4 * ppq)
        : Math.max(model.grid, Math.min(out[i].dur, gap > 0 ? gap : out[i].dur));
    }
    return out;
  };

  const items = [];
  const emit = (slots, voice, rests) => {
    let cursor = 0;
    const emitRest = (from, to) => {
      let t = from;
      while (t < to - 1) {
        const stop = Math.min(to, barEndOf(t));
        for (const piece of scoreDecompose(stop - t, ppq)) { items.push({ kind: 'rest', voice, tick: t, ticks: piece.ticks, v: piece.v }); t += piece.ticks; }
        t = stop;
      }
    };
    for (const s of slots) {
      if (rests && s.tick > cursor) emitRest(cursor, s.tick);
      let t = s.tick;
      while (t < s.tick + s.dur) {
        const stop = Math.min(s.tick + s.dur, barEndOf(t));
        const pieces = scoreDecompose(stop - t, ppq);
        for (let i = 0; i < pieces.length; i++) {
          const more = (i < pieces.length - 1) || (stop < s.tick + s.dur);
          items.push({ kind: 'note', voice, tick: t, ticks: pieces[i].ticks, v: pieces[i].v,
                       notes: s.notes, tie: more, sounds: t === s.tick });
          t += pieces[i].ticks;
        }
        t = Math.max(t, stop);
      }
      cursor = Math.max(cursor, s.tick + s.dur);
    }
  };

  if (part.perc) {
    // Drum charts are written in two voices: hands (hats, snare, cymbals) stem
    // up, feet (kick, low toms) stem down. Rests come from the hands only —
    // doubling them in both voices just clutters the staff.
    const hands = part.notes.filter(n => scoreStaffStep(part, n.note) >= 6);
    const feet = part.notes.filter(n => scoreStaffStep(part, n.note) < 6);
    emit(slotsOf(hands), 0, true);
    emit(slotsOf(feet), 1, false);
  } else emit(slotsOf(part.notes), 0, true);

  /* beams: runs of flagged notes inside one beat, per voice */
  for (const voice of [0, 1]) {
    let run = [];
    const flush = () => { if (run.length > 1) for (const it of run) it.beam = run; run = []; };
    for (const it of items.filter(i => i.voice === voice)) {
      const flagged = it.kind === 'note' && it.v.flags > 0;
      const sameBeat = run.length && Math.floor(it.tick / ppq) === Math.floor(run[0].tick / ppq);
      if (flagged && (!run.length || sameBeat)) run.push(it);
      else { flush(); if (flagged) run = [it]; }
    }
    flush();
  }
  return items;
}

/* ---- 5. draw ---- */
function scoreStaffStep(part, n) {
  if (part.perc) return (SCORE_PERC[n] || [6, 'n'])[0];
  const bottom = part.clef === 'treble' ? scoreDiatonic(64) : scoreDiatonic(43);   // E4 / G2
  return scoreDiatonic(n + (part.oct || 0) * 12) - bottom;
}
/** How the octave transposition is written on the staff. */
function scoreOctLabel(part) {
  return !part.oct ? '' : ' · ' + (part.oct > 0 ? (part.oct > 1 ? '15mb' : '8vb') : (part.oct < -1 ? '15ma' : '8va'));
}
function scoreHead(part, n) { return part.perc ? (SCORE_PERC[n] || [6, 'n'])[1] : 'n'; }

function scoreSvg(model) {
  const ppq = model.ppq, bars = model.bars, px = t => SCORE_GUTTER + (t / ppq) * SCORE_PPQ_PX * score.zoom;
  const W = px(bars.length ? bars[bars.length - 1].tick + bars[bars.length - 1].ticks : ppq * 4) + 24;
  const H = model.parts.length * SCORE_ROW + 26;
  const el = [];
  const line = (x1, y1, x2, y2, cls) => el.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"${cls ? ` class="${cls}"` : ''}/>`);
  score.notes = [];

  bars.forEach(b => {                                    // bar numbers along the top
    el.push(`<text class="sc-barno" x="${(px(b.tick) + 3).toFixed(1)}" y="14">${b.num}</text>`);
  });

  model.parts.forEach((part, pi) => {
    const top = 26 + pi * SCORE_ROW + 12, mid = top + 2 * SCORE_GAP, bot = top + 4 * SCORE_GAP;
    const yOf = step => bot - step * (SCORE_GAP / 2);
    el.push(`<text class="sc-name" x="8" y="${(mid - 4).toFixed(1)}">${escapeHtml(part.name)}</text>`);
    el.push(`<text class="sc-sub" x="8" y="${(mid + 9).toFixed(1)}">ch ${part.ch} · ${part.clef}${scoreOctLabel(part)}</text>`);
    el.push(scoreMsButtons(part.ch, mid + 15));
    for (let i = 0; i < 5; i++) line(SCORE_GUTTER - 8, top + i * SCORE_GAP, W - 12, top + i * SCORE_GAP, 'sc-staff');
    for (const b of bars) line(px(b.tick), top, px(b.tick), bot, 'sc-bar');
    line(W - 12, top, W - 12, bot, 'sc-bar');

    const items = scoreLayout(part, model);
    const acc = new Map(); let accBar = -1;
    for (const it of items) {
      const x = px(it.tick) + 10, bar = bars.findIndex(b => it.tick < b.tick + b.ticks);
      if (bar !== accBar) { acc.clear(); accBar = bar; }
      if (it.kind === 'rest') { el.push(scoreRest(x, mid, it.v)); continue; }

      const steps = it.notes.map(n => scoreStaffStep(part, n.note));
      const up = part.perc ? it.voice === 0 : (steps.reduce((a, s) => a + s, 0) / steps.length) < 4;
      const tipY = up ? yOf(Math.max(...steps)) - 3.2 * SCORE_GAP : yOf(Math.min(...steps)) + 3.2 * SCORE_GAP;
      it.x = x; it.up = up; it.tipY = tipY;
      it.notes.forEach((n, k) => {
        const step = steps[k], y = yOf(step);
        for (let s = 10; s <= Math.min(step, 18); s += 2) line(x - 8, yOf(s), x + 8, yOf(s), 'sc-ledger');   // above
        for (let s = -2; s >= Math.max(step, -10); s -= 2) line(x - 8, yOf(s), x + 8, yOf(s), 'sc-ledger');   // below
        if (!part.perc && SCORE_SHARP[n.note % 12] && acc.get(step) !== '#') {
          acc.set(step, '#');
          el.push(`<text class="sc-acc" x="${(x - 15).toFixed(1)}" y="${(y + 3.5).toFixed(1)}">&#9839;</text>`);
        }
        const head = scoreHead(part, n.note), id = 'n' + score.notes.length;
        if (head === 'x')
          el.push(`<path id="${id}" class="sc-note" d="M${(x - 4).toFixed(1)},${(y - 4).toFixed(1)}l8,8M${(x + 4).toFixed(1)},${(y - 4).toFixed(1)}l-8,8" fill="none" stroke-width="1.6"/>`);
        else
          el.push(`<ellipse id="${id}" class="sc-note${it.v.open || head === 'o' ? ' open' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="5" ry="3.7" transform="rotate(-18 ${x.toFixed(1)} ${y.toFixed(1)})"/>`);
        for (let d = 0; d < it.v.dots; d++) el.push(`<circle class="sc-dot" cx="${(x + 9 + d * 4).toFixed(1)}" cy="${(y - 2).toFixed(1)}" r="1.5"/>`);
        if (it.sounds) score.notes.push({ id, from: it.tick, to: it.tick + Math.max(it.ticks, model.grid) });
      });
      if (it.v.stem) {
        const anchorY = up ? yOf(Math.min(...steps)) : yOf(Math.max(...steps));
        line(x + (up ? 4.6 : -4.6), anchorY, x + (up ? 4.6 : -4.6), tipY, 'sc-stem');
        if (it.v.flags && !it.beam) el.push(scoreFlag(x + (up ? 4.6 : -4.6), tipY, up, it.v.flags));
      }
      if (it.tie) el.push(`<path class="sc-tie" d="M${(x + 6).toFixed(1)},${(yOf(steps[0]) + (up ? 7 : -7)).toFixed(1)} q ${(SCORE_PPQ_PX * score.zoom * it.ticks / ppq / 2).toFixed(1)},${up ? 7 : -7} ${(SCORE_PPQ_PX * score.zoom * it.ticks / ppq - 4).toFixed(1)},0" fill="none"/>`);
    }
    for (const it of items) {                       // beams, once the stems exist
      if (!it.beam || it.beam[0] !== it) continue;
      const g = it.beam, a = g[0], b = g[g.length - 1];
      const dir = a.up ? 1 : -1;
      line(a.x + (a.up ? 4.6 : -4.6), a.tipY, b.x + (b.up ? 4.6 : -4.6), b.tipY, 'sc-beam');
      const second = g.filter(n => n.v.flags >= 2);
      if (second.length > 1)
        line(second[0].x + (a.up ? 4.6 : -4.6), second[0].tipY + dir * 4,
             second[second.length - 1].x + (a.up ? 4.6 : -4.6), second[second.length - 1].tipY + dir * 4, 'sc-beam');
    }
  });
  el.push(scoreAbRegion(model, px, H));
  el.push(`<line id="scPlay" class="sc-play" x1="${SCORE_GUTTER}" y1="20" x2="${SCORE_GUTTER}" y2="${H - 4}"/>`);
  const k = score.scale || 1;      // vector: scaling the box scales everything, playhead included
  return `<svg id="scSvg" width="${(W * k).toFixed(0)}" height="${(H * k).toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${H}">${el.join('')}</svg>`;
}

/* ---- score playback controls (NEW): shared bits of both score views ---- */
/** The per-part mute/solo buttons drawn in the gutter (click handled by the box). */
function scoreMsButtons(ch, y) {
  const on = k => (k === 'mute' ? scoreCtl.mute : scoreCtl.solo).has(ch);
  const btn = (k, x, label) =>
    `<g class="sc-ms${on(k) ? ' on' : ''}" data-mskind="${k}" data-ch="${ch}" role="button">` +
    `<rect x="${x}" y="${(y - 9).toFixed(1)}" width="16" height="13" rx="2"/>` +
    `<text x="${x + 8}" y="${(y + 1).toFixed(1)}">${label}</text><title>${k === 'mute' ? 'Mute' : 'Solo'} channel ${ch}</title></g>`;
  return btn('mute', 8, 'M') + btn('solo', 28, 'S');
}
/** The shaded A→B repeat passage, when one is set for the file on show. */
function scoreAbRegion(model, px, H) {
  if (scoreCtl.a === null || scoreCtl.b === null) return '';
  const x1 = px(scoreTickAt(model, scoreCtl.a)), x2 = px(scoreTickAt(model, scoreCtl.b));
  return `<rect class="sc-ab" x="${x1.toFixed(1)}" y="18" width="${Math.max(1, x2 - x1).toFixed(1)}" height="${H - 22}"/>`
       + `<text class="sc-ab-lbl" x="${(x1 + 3).toFixed(1)}" y="26">A</text>`
       + `<text class="sc-ab-lbl" x="${(x2 + 3).toFixed(1)}" y="26">B</text>`;
}

/* ---- score playback controls (NEW): piano roll, for files that do not
   notate honestly (played-in material, swing) or whenever it is preferred.
   Same coordinate system as the staff view, so seeking, the playhead, the
   A/B shading and the gutter mute/solo buttons all carry over. ---- */
function scoreRollSvg(model) {
  const ppq = model.ppq, bars = model.bars, px = t => SCORE_GUTTER + (t / ppq) * SCORE_PPQ_PX * score.zoom;
  const W = px(bars.length ? bars[bars.length - 1].tick + bars[bars.length - 1].ticks : ppq * 4) + 24;
  const ROW = SCORE_ROW;
  const H = model.parts.length * ROW + 26;
  const el = [];
  score.notes = [];
  bars.forEach(b => el.push(`<text class="sc-barno" x="${(px(b.tick) + 3).toFixed(1)}" y="14">${b.num}</text>`));
  model.parts.forEach((part, pi) => {
    const top = 26 + pi * ROW + 6, bot = top + ROW - 18;
    let lo = 127, hi = 0;
    for (const n of part.notes) { lo = Math.min(lo, n.note); hi = Math.max(hi, n.note); }
    if (hi < lo) { lo = 60; hi = 72; }
    if (hi - lo < 7) { const pad = Math.ceil((7 - (hi - lo)) / 2); lo = Math.max(0, lo - pad); hi = Math.min(127, hi + pad); }
    const yOf = n => bot - (n - lo) / (hi - lo) * (bot - top - 4);
    el.push(`<text class="sc-name" x="8" y="${(top + 8).toFixed(1)}">${escapeHtml(part.name)}</text>`);
    el.push(`<text class="sc-sub" x="8" y="${(top + 21).toFixed(1)}">ch ${part.ch}${part.perc ? ' · drums' : ''}</text>`);
    el.push(scoreMsButtons(part.ch, top + 33));
    el.push(`<rect class="sc-lane" x="${SCORE_GUTTER - 8}" y="${top}" width="${W - SCORE_GUTTER - 4}" height="${bot - top}"/>`);
    for (const b of bars) el.push(`<line class="sc-bar" x1="${px(b.tick).toFixed(1)}" y1="${top}" x2="${px(b.tick).toFixed(1)}" y2="${bot}"/>`);
    for (const n of part.notes) {
      const x = px(n.tick), w = Math.max(2.5, px(n.tick + n.dur) - x - 1), y = yOf(n.note), id = 'n' + score.notes.length;
      el.push(`<rect id="${id}" class="sc-note sc-rollnote" x="${x.toFixed(1)}" y="${(y - 2).toFixed(1)}" width="${w.toFixed(1)}" height="4" rx="1.4"/>`);
      score.notes.push({ id, from: n.tick, to: n.tick + Math.max(n.dur, model.grid || 1) });
    }
  });
  el.push(scoreAbRegion(model, px, H));
  el.push(`<line id="scPlay" class="sc-play" x1="${SCORE_GUTTER}" y1="20" x2="${SCORE_GUTTER}" y2="${H - 4}"/>`);
  const k = score.scale || 1;
  return `<svg id="scSvg" width="${(W * k).toFixed(0)}" height="${(H * k).toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${H}">${el.join('')}</svg>`;
}
function scoreFlag(x, y, up, n) {
  let d = '';
  for (let i = 0; i < n; i++) { const yy = y + (up ? i * 5 : -i * 5); d += `M${x.toFixed(1)},${yy.toFixed(1)} q 7,${up ? 4 : -4} 6,${up ? 11 : -11}`; }
  return `<path class="sc-flag" d="${d}" fill="none"/>`;
}
function scoreRest(x, mid, v) {
  if (v.q >= 4) return `<rect class="sc-rest" x="${(x - 5).toFixed(1)}" y="${(mid - SCORE_GAP).toFixed(1)}" width="10" height="3.5"/>`;
  if (v.q >= 2) return `<rect class="sc-rest" x="${(x - 5).toFixed(1)}" y="${(mid - 3.5).toFixed(1)}" width="10" height="3.5"/>`;
  if (v.q >= 1) return `<path class="sc-rest" d="M${x},${(mid - 9).toFixed(1)} l4,6 l-4,4 l4,5" fill="none" stroke-width="1.7"/>`;
  const beads = v.q >= 0.5 ? 1 : 2;
  let out = `<path class="sc-rest" d="M${(x + 3.5).toFixed(1)},${(mid - 7).toFixed(1)} l-5,${(9 + beads * 3).toFixed(1)}" fill="none" stroke-width="1.5"/>`;
  for (let i = 0; i < beads; i++)
    out += `<circle class="sc-bead" cx="${(x + 2 - i * 1.7).toFixed(1)}" cy="${(mid - 6.5 + i * 4.4).toFixed(1)}" r="1.9"/>`;
  return out;
}

/* ---- 6. the panel ---- */
function scoreFiles() { return midi.netHost ? midi.files : midi.local; }
function scoreSelect(name) {
  const f = scoreFiles().find(x => x.name === name);
  if (name !== score.file) { scoreCtl.a = scoreCtl.b = null; scoreApplyCtl(); }   // A/B is a place in one file
  score.file = name;
  score.model = null;
  if (f && f.parsed) { score.model = scoreQuantise(scoreParts(f.parsed)); if (score.model) score.model.bars = scoreBars(score.model); }
  scorePaint();
}
function scorePaint() {
  const sel = $('#scoreSel'), box = $('#scoreBox'), note = $('#scoreNote');
  if (!sel || !box) return;
  const files = scoreFiles();
  sel.innerHTML = files.length ? files.map(f => `<option${f.name === score.file ? ' selected' : ''}>${escapeHtml(f.name)}</option>`).join('')
                              : '<option value="">No MIDI files</option>';
  if (!score.model) {
    box.innerHTML = `<div class="play-hint">${files.length ? 'Reading the file…' : 'Upload a .mid in the MIDI panel to see its notes.'}</div>`;
    note.textContent = ''; return;
  }
  score.scale = $('#scoreSec') && $('#scoreSec').parentElement && $('#scoreSec').parentElement.id === 'center' ? 1.5 : 1;
  // piano roll (NEW): explicit choice wins; a file too loose to notate honestly defaults to the roll
  const roll = scoreCtl.roll !== null ? scoreCtl.roll : !!score.model.loose;
  if ($('#scoreRoll')) $('#scoreRoll').checked = roll;
  box.innerHTML = roll ? scoreRollSvg(score.model) : scoreSvg(score.model);
  chanPaintFile();
  scoreCtlPaint();
  const m = score.model;
  note.textContent = m.swing
    ? 'Shuffle feel — written straight, so the note values are approximate' + (roll ? ' (piano roll shown).' : ' — try the piano roll.')
    : m.loose
    ? 'This file was played in rather than stepped, so the note values are approximate' + (roll ? ' (piano roll shown).' : ' — try the piano roll.')
    : `${m.parts.length} ${m.parts.length === 1 ? 'part' : 'parts'} · ${m.bars.length} bars · ${m.length.toFixed(1)} s`;
  scoreAnimate();
}
/** Seconds -> ticks, through the file's tempo map (so ritardandi still line up). */
function scoreTickAt(model, sec) {
  const tempos = model.tempos || [[0, 500000]];
  let t = 0, tick = 0, cur = tempos[0][1];
  for (let i = 1; i < tempos.length; i++) {
    const span = (tempos[i][0] - tick) * cur / model.ppq / 1e6;
    if (t + span > sec) break;
    t += span; tick = tempos[i][0]; cur = tempos[i][1];
  }
  return tick + (sec - t) * 1e6 * model.ppq / cur;
}
/** Ticks -> seconds: the inverse of scoreTickAt, for click-to-seek (NEW). */
function scoreSecAt(model, tick) {
  const tempos = model.tempos || [[0, 500000]];
  let t = 0, tk = 0, cur = tempos[0][1];
  for (let i = 1; i < tempos.length; i++) {
    if (tempos[i][0] >= tick) break;
    t += (tempos[i][0] - tk) * cur / model.ppq / 1e6;
    tk = tempos[i][0]; cur = tempos[i][1];
  }
  return t + (tick - tk) * cur / model.ppq / 1e6;
}
/** Where playback is right now, in SOURCE seconds, or null when nothing is
 *  playing. The bridge reports source-time and its speed, so interpolation
 *  between polls scales elapsed wall time by the speed and wraps an A/B
 *  passage the way the Pi does (NEW). */
function scorePos() {
  if (midi.player && midi.player.name === score.file) return midi.player.pos;
  const st = midi.status;
  if (st && st.playing && st.file === score.file) {
    if (!score.anchor || score.anchor.pos !== st.position_s) score.anchor = { pos: st.position_s, at: performance.now() };
    let p = score.anchor.pos + (performance.now() - score.anchor.at) / 1000 * (st.speed || 1);
    if (typeof st.a === 'number' && typeof st.b === 'number' && st.b > st.a && p >= st.b)
      p = st.a + (p - st.a) % (st.b - st.a);
    else if (st.length_s) p = st.loop ? p % st.length_s : Math.min(p, st.length_s);
    return p;
  }
  score.anchor = null;
  return null;
}
/* ---- score playback controls (NEW): pushing scoreCtl to whichever player is
   playing, and seeking. The bridge gets explicit validated API calls
   (/api/midi/params, /api/midi/seek); the local player is told directly. ---- */
/** STABLE integration point for the universal transport bar: pass this
 *  object with any /api/midi/play request (and after any control change,
 *  through /api/midi/params) so playback starts with the score's controls. */
function scoreCtlParams() {
  const p = { speed: scoreCtl.speed, transpose: scoreCtl.transpose,
              mute: [...scoreCtl.mute].sort((a, b) => a - b), solo: [...scoreCtl.solo].sort((a, b) => a - b),
              a: scoreCtl.a, b: scoreCtl.b };
  return p;
}
async function scoreApplyCtl() {
  if (midi.player && midi.player.applyCtl) midi.player.applyCtl();
  if (midi.netHost && midi.status && midi.status.playing) {
    try {
      const j = await midiApi('/api/midi/params', scoreCtlParams());
      if (j && j.status) { midi.status = j.status; score.anchor = null; }
      else if (j && j.ok === false) consoleLog('err', 'Playback controls: ' + (j.message || 'refused'));
    } catch (e) {}
  }
  scoreCtlPaint();
}
async function scoreSeek(sec) {
  const f = scoreFiles().find(x => x.name === score.file);
  if (!f) return;
  sec = Math.max(0, sec);
  if (midi.player && midi.player.name === score.file) { midi.player.seek(sec); return; }
  if (midi.netHost) {
    if (midi.status && midi.status.playing && midi.status.file === score.file) {
      try { const j = await midiApi('/api/midi/seek', { position_s: sec });
            if (j && j.ok === false) consoleLog('err', 'Seek: ' + (j.message || 'refused')); } catch (e) {}
    } else {
      // not playing yet: start this file from the clicked spot, with the current controls
      try {
        const j = await midiApi('/api/midi/play', Object.assign({ file: score.file, loop: midi.loop, position_s: sec }, scoreCtlParams()));
        if (j && j.ok === false) { consoleLog('err', 'Play: ' + (j.message || 'refused')); return; }
      } catch (e) { return; }
    }
    try { midi.status = await midiApi('/api/midi/status'); } catch (e) {}
    score.anchor = null; midiPaint();
    return;
  }
  if (midiTransport() === 'webmidi') { midiLocalPlay(f, midi.loop); if (midi.player) midi.player.seek(sec); }
}
/** The A/B + speed + transpose row under the score reflects scoreCtl. */
function scoreCtlPaint() {
  const line = $('#scoreCtlNote'); if (!line) return;
  const bits = [];
  if (scoreCtl.a !== null && scoreCtl.b !== null) bits.push(`repeat ${scoreCtl.a.toFixed(1)}–${scoreCtl.b.toFixed(1)} s`);
  else if (scoreCtl.pendingA !== undefined) bits.push(`A at ${scoreCtl.pendingA.toFixed(1)} s — press B to close the passage`);
  if (scoreCtl.transpose) bits.push(`transpose ${scoreCtl.transpose > 0 ? '+' : ''}${scoreCtl.transpose} st (drums stay put)`);
  if (scoreCtl.mute.size) bits.push('muted ch ' + [...scoreCtl.mute].sort((a, b) => a - b).join(','));
  if (scoreCtl.solo.size) bits.push('solo ch ' + [...scoreCtl.solo].sort((a, b) => a - b).join(','));
  line.textContent = bits.join(' · ');
  const ab = $('#scoreLoopClr'); if (ab) ab.hidden = scoreCtl.a === null && scoreCtl.pendingA === undefined;
}
function scoreAnimate() {
  cancelAnimationFrame(score.raf);
  const svg = $('#scSvg'); if (!svg || !score.model) return;
  const play = svg.querySelector('#scPlay'), box = $('#scoreBox');
  let lit = [];
  const step = () => {
    const sec = scorePos();
    if (sec === null) { play.style.opacity = 0; for (const el of lit) el.classList.remove('on'); lit = []; score.raf = requestAnimationFrame(step); return; }
    const tick = scoreTickAt(score.model, sec);
    const x = SCORE_GUTTER + (tick / score.model.ppq) * SCORE_PPQ_PX * score.zoom;
    play.style.opacity = 1; play.setAttribute('x1', x); play.setAttribute('x2', x);
    const next = [];
    for (const n of score.notes) {
      if (tick >= n.from && tick < n.to) { const el = svg.querySelector('#' + n.id); if (el) { el.classList.add('on'); next.push(el); } }
    }
    for (const el of lit) if (!next.includes(el)) el.classList.remove('on');
    lit = next;
    if (score.follow && box) {                       // keep the playhead in view
      const want = x * (score.scale || 1) - box.clientWidth * 0.35;
      if (Math.abs(box.scrollLeft - want) > 24) box.scrollLeft = want;
    }
    score.raf = requestAnimationFrame(step);
  };
  step();
}
function scoreBuildSection() {
  const sec = document.createElement('div'); sec.className = 'dev-sec coll'; sec.id = 'scoreSec';
  sec.innerHTML = `<h3 role="button" tabindex="0"><span class="caret">&#9660;</span> SCORE</h3>
  <div class="sec-body" id="scoreBody">
    <div class="midi-line">
      <select id="scoreSel" class="midi-sel" title="Which file to show"></select>
      <button class="btn sm" id="scoreZoomOut" title="Narrower">&minus;</button>
      <button class="btn sm" id="scoreZoomIn" title="Wider">+</button>
      <label class="midi-loop" title="Scroll to keep the playhead in view"><input type="checkbox" id="scoreFollow" checked> follow</label>
    </div>
    <div id="scoreBox"><div class="play-hint">Upload a .mid in the MIDI panel to see its notes.</div></div>
    <!-- score playback controls (NEW): speed, transpose, A/B repeat, piano roll -->
    <div class="midi-line" id="scoreCtlRow">
      <select id="scoreSpeed" class="midi-sel" title="Playback speed — pitch is unchanged; the score keeps musical time">
        ${[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(v => `<option value="${v}"${v === 1 ? ' selected' : ''}>${v}&times;</option>`).join('')}
      </select>
      <input type="number" id="scoreTrans" class="midi-sel" min="-24" max="24" step="1" value="0"
             title="Transpose the melodic channels this many semitones — channel 10 (drums) is never moved" aria-label="Transpose (semitones)">
      <button class="btn sm" id="scoreLoopA" title="Start the repeat passage at the playhead (or the last clicked spot)">A</button>
      <button class="btn sm" id="scoreLoopB" title="Close the repeat passage at the playhead (or the last clicked spot)">B</button>
      <button class="btn sm" id="scoreLoopClr" title="Clear the repeat passage" hidden>&#10005;</button>
      <label class="midi-loop" title="Notes as time-and-pitch bars — honest for files that resist notation"><input type="checkbox" id="scoreRoll"> roll</label>
    </div>
    <div class="midi-line mono" id="scoreCtlNote"></div>
    <div class="midi-line mono" id="scoreNote"></div>
  </div>`;
  const after = $('#chanSec') || $('#midiSec') || $('#device').lastElementChild;
  after.insertAdjacentElement('afterend', sec);
  sec.querySelector('h3').addEventListener('click', () => sec.classList.toggle('closed'));
  $('#scoreSel').addEventListener('change', ev => scoreSelect(ev.target.value));
  $('#scoreFollow').addEventListener('change', ev => { score.follow = ev.target.checked; });
  $('#scoreZoomIn').addEventListener('click', () => { score.zoom = Math.min(3, score.zoom * 1.3); scorePaint(); });
  $('#scoreZoomOut').addEventListener('click', () => { score.zoom = Math.max(0.4, score.zoom / 1.3); scorePaint(); });
  /* ---- score playback controls (NEW) ---- */
  $('#scoreSpeed').addEventListener('change', ev => {
    scoreCtl.speed = Math.min(PLAY_SPEED_MAX, Math.max(PLAY_SPEED_MIN, +ev.target.value || 1));
    scoreApplyCtl();
  });
  $('#scoreTrans').addEventListener('change', ev => {
    scoreCtl.transpose = Math.min(PLAY_TRANSPOSE_MAX, Math.max(-PLAY_TRANSPOSE_MAX, Math.round(+ev.target.value) || 0));
    ev.target.value = scoreCtl.transpose;
    scoreApplyCtl();
  });
  $('#scoreRoll').addEventListener('change', ev => { scoreCtl.roll = ev.target.checked; scorePaint(); });
  const markSpot = () => { const p = scorePos(); return p !== null ? p : (score.lastSeek || 0); };
  $('#scoreLoopA').addEventListener('click', () => {
    scoreCtl.a = scoreCtl.b = null; scoreCtl.pendingA = markSpot();
    scoreApplyCtl(); scorePaint();
  });
  $('#scoreLoopB').addEventListener('click', () => {
    const b = markSpot(), a = scoreCtl.pendingA !== undefined ? scoreCtl.pendingA : (scoreCtl.a !== null ? scoreCtl.a : 0);
    if (b - a < 0.05) { consoleLog('err', 'The B point must come after A — press A first, let it play, then B'); return; }
    scoreCtl.a = a; scoreCtl.b = b; delete scoreCtl.pendingA;
    scoreApplyCtl(); scorePaint();
  });
  $('#scoreLoopClr').addEventListener('click', () => {
    scoreCtl.a = scoreCtl.b = null; delete scoreCtl.pendingA;
    scoreApplyCtl(); scorePaint();
  });
  /* click on the score: gutter buttons toggle mute/solo, anywhere else seeks */
  $('#scoreBox').addEventListener('click', ev => {
    const ms = ev.target.closest && ev.target.closest('[data-mskind]');
    if (ms) {
      const ch = +ms.dataset.ch, set = ms.dataset.mskind === 'mute' ? scoreCtl.mute : scoreCtl.solo;
      if (set.has(ch)) set.delete(ch); else set.add(ch);
      scoreApplyCtl(); scorePaint();
      return;
    }
    const svg = $('#scSvg'), m = score.model;
    if (!svg || !m) return;
    const box = $('#scoreBox'), rect = box.getBoundingClientRect();
    const x = (ev.clientX - rect.left + box.scrollLeft) / (score.scale || 1);
    if (x <= SCORE_GUTTER) return;
    const tick = (x - SCORE_GUTTER) / (SCORE_PPQ_PX * score.zoom) * m.ppq;
    const sec = Math.min(m.length || 0, scoreSecAt(m, Math.max(0, tick)));
    score.lastSeek = sec;
    scoreSeek(sec);
  });
}
/** Follow whatever starts playing, and pick a file up as soon as one is known. */
function scoreSync() {
  const files = scoreFiles();
  const playing = (midi.player && midi.player.name) || (midi.status && midi.status.playing && midi.status.file);
  if (playing && playing !== score.file && files.some(f => f.name === playing)) return scoreSelect(playing);
  if (!score.file && files.length) return scoreSelect(files[0].name);
  if (score.file && !score.model && files.some(f => f.name === score.file && f.parsed)) return scoreSelect(score.file);
}

/* ============================================================================
   Song sessions (NEW) — one shareable JSON file that carries everything a song
   needs: the chosen MIDI files (bytes, base64), the preset(s) exactly as they
   are in the workspace (custom text and chain-meta included), optionally the
   saved loops from the pedal's SD card, the playback preferences (speed,
   transpose, mute/solo, A/B, loop), the footswitch assignments and the panel
   layout. Plain JSON + base64 — no zip, so the file opens anywhere.

   Opening a session validates the ENTIRE package before anything is touched:
   a bad byte anywhere refuses the whole file. Applying is explicit and
   additive — presets are added under fresh names, files that already exist
   are renamed (or replaced only when asked), loops only move when ticked,
   and nothing is pushed to the pedal without its own checkbox.
   ========================================================================== */
