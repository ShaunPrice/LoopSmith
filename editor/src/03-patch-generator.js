/* ============================================================================
   4. PatchScript generation (chain model -> text)
   ========================================================================== */
function generateText(preset) {
  if (preset.mode === 'custom') return preset.customText || '';
  const decl = [], conns = [], sets = [];
  const counters = {};
  let ci = 0;
  const nm = b => { counters[b] = (counters[b] || 0) + 1; return b + counters[b]; };
  const nmd = b => { counters[b] = (counters[b] || 0) + 1; return counters[b] === 1 ? b : b + counters[b]; }; // "kick", then "kick2"
  const conn = (s, sp, d, dp) => { ci++; conns.push(`AudioConnection c${ci}(${s}, ${sp}, ${d}, ${dp});`); };

  /** Wet/dry mixer pattern per PATCHSCRIPT.md:
   *  dry (prev) -> mixN:1, wet -> mixN:0, gains = mix / 1-mix. Returns the mixer name. */
  const wetDry = (dry, wet, mix) => {
    const mx = nm('mix');
    decl.push(`AudioMixer4 ${mx};`);
    conn(dry, 0, mx, 1);
    conn(wet, 0, mx, 0);
    sets.push(`${mx}.gain(0, ${fmtNum(mix)});`);
    sets.push(`${mx}.gain(1, ${fmtNum(1 - mix)});`);
    return mx;
  };

  /* Instruments lane: sources summed with the guitar before the first effect.
   * fxin -> srcmix1:0 and each instrument's own mixer -> srcmix1:1..3. A mixer has four
   * inputs, so past three instruments another one is chained on (srcmix2:0 carries srcmix1,
   * leaving three more inputs) — the chain then starts from the last mixer. With no
   * (enabled) instrument nothing is emitted, so instrument-free presets are unchanged. */
  let prev = 'fxin';
  const insts = instruments(preset).filter(it => it.on).slice(0, MAX_INSTRUMENTS);
  if (insts.length) {
    const gains = [];
    let srcmix = null, slot = 0;
    for (const it of insts) {
      if (!srcmix || slot > 3) {                       // first mixer, or this one is full
        const next = nm('srcmix');
        decl.push(`AudioMixer4 ${next};`);
        conn(srcmix || 'fxin', 0, next, 0);            // channel 0 carries the guitar / the mixer before
        gains.push(`${next}.gain(0, 1);`);
        srcmix = next; slot = 1;
      }
      conn(emitInstrument(it, { decl, conn, sets, nm, nmd }), 0, srcmix, slot);
      gains.push(`${srcmix}.gain(${slot}, 1);`);
      slot++;
    }
    sets.push(...gains);
    prev = srcmix;
  }
  for (const item of preset.chain) {
    if (!item.on) continue;

    if (item.kind === 'macro' && item.id === 'echo') {
      // Feedback echo: prev -> emixN:0, delayN out0 -> emixN:1 (gain = feedback),
      // emixN -> delayN; delayN feeds onward (through the wet/dry mixer for mix < 100%).
      const emix = nm('emix'), dl = nm('delay');
      decl.push(`AudioMixer4 ${emix};`, `AudioEffectDelay ${dl};`);
      conn(prev, 0, emix, 0);
      conn(dl, 0, emix, 1);
      conn(emix, 0, dl, 0);
      sets.push(`${dl}.delay(0, ${fmtNum(item.p.time)});`);
      sets.push(`${emix}.gain(0, 1);`);
      sets.push(`${emix}.gain(1, ${fmtNum(item.p.feedback)});`);
      prev = (item.p.mix < 1) ? wetDry(prev, dl, item.p.mix) : dl;

    } else if (item.kind === 'macro' && item.id === 'tremolo') {
      // Sine LFO (amplitude = depth/2) + DC (1 - depth/2) -> mixer (both gain 1)
      // -> Multiply input 1; signal into Multiply input 0.
      const lfo = nm('lfo'), dc = nm('dc'), tmix = nm('tmix'), mult = nm('mult');
      decl.push(`AudioSynthWaveformSine ${lfo};`, `AudioSynthWaveformDc ${dc};`,
                `AudioMixer4 ${tmix};`, `AudioEffectMultiply ${mult};`);
      conn(prev, 0, mult, 0);
      conn(lfo, 0, tmix, 0);
      conn(dc, 0, tmix, 1);
      conn(tmix, 0, mult, 1);
      sets.push(`${lfo}.frequency(${fmtNum(item.p.rate)});`);
      sets.push(`${lfo}.amplitude(${fmtNum(item.p.depth / 2)});`);
      sets.push(`${dc}.amplitude(${fmtNum(1 - item.p.depth / 2)});`);
      sets.push(`${tmix}.gain(0, 1);`);
      sets.push(`${tmix}.gain(1, 1);`);
      prev = mult;

    } else {
      const def = SCHEMA_BY_TYPE[item.type];
      const name = nm(baseOf(item.type));
      decl.push(`${item.type} ${name};`);
      conn(prev, 0, name, 0);
      for (const p of def.params) {
        if (!item.inc[p.method]) continue;
        const vals = item.params[p.method] || [];
        const argStr = p.args.map((a, i) => {
          const v = vals[i] !== undefined ? vals[i] : a.default;
          return a.type === 'token' ? String(v) : fmtNum(v);
        }).join(', ');
        sets.push(`${name}.${p.method}(${argStr});`);
      }
      const mix = item.mix !== undefined ? item.mix : 1;
      prev = (item.showMix && mix < 1) ? wetDry(prev, name, mix) : name;
    }
  }
  conn(prev, 0, 'fxout', 0);

  const meta = { v: 1, chain: preset.chain };
  if (instruments(preset).length) meta.instruments = preset.instruments;   // absent = unchanged legacy output
  const out = [`// name: ${String(preset.title || 'Untitled').replace(/[\r\n]+/g, ' ')}`,
               `// chain-meta: ${JSON.stringify(meta)}`, ''];
  if (decl.length) out.push(...decl, '');
  out.push(...conns);
  if (sets.length) out.push('', ...sets);
  return out.join('\n') + '\n';
}

/** Substitute {param} references in a template string: {name}, {name:*k}, {name:/k}
 *  (scaled), {name:cents} (a frequency ratio for a detune in cents). */
function tplValue(expr, p) {
  return String(expr).replace(/\{([a-zA-Z0-9_]+)(?::([^}]+))?\}/g, (_, name, mod) => {
    let v = p[name]; if (v === undefined || v === null) v = 0;
    if (mod === undefined) return typeof v === 'number' ? fmtNum(v) : String(v);
    if (mod === 'cents') return fmtNum(Math.pow(2, (+v) / 1200));
    const k = +mod.slice(1);
    if (mod[0] === '*') return fmtNum(+v * k);
    if (mod[0] === '/') return fmtNum(+v / k);
    return fmtNum(+v);
  });
}
function instTemplate(it) { return MACRO_BY_ID[it.id].template; }
function isPads(it) { return instTemplate(it).family === 'pads'; }
function activePads(it) {
  const t = instTemplate(it);
  return (t.pads || []).filter(pd => !pd.if || String(it.p[pd.if] || '').trim());
}
function instVoices(it) {
  const prm = MACRO_BY_ID[it.id].params.find(x => x.name === 'voices');
  return prm ? clamp(Math.round(it.p.voices) || 1, prm.min || 1, prm.max || 4) : 1;
}

/** Expand one instrument card from its schema template into declarations,
 *  connections and setters. Voices (keys family) are replicated with one shared
 *  "v" group counter so two instruments never share a group; pads (kits) get one
 *  group each, pinned to their note. Every voice member is bound with the midi()
 *  extension; midiRatio() / midiVelocity() come from the template's ratio /
 *  velocity maps (docs/PATCHSCRIPT.md "Instruments").
 *  Returns the AudioMixer4 that carries the instrument's summed output. */
function emitInstrument(it, g) {
  const { decl, conn, sets, nm, nmd } = g;
  const m = MACRO_BY_ID[it.id], t = m.template, p = it.p;
  const mix = nm('imix');
  decl.push(`AudioMixer4 ${mix};`);
  const level = +p.level || 0;
  const sub = (s, names) => tplValue(s, p).replace(/^([A-Za-z_][A-Za-z0-9_]*)\./, (_, o) => (names[o] || o) + '.');

  const emitUnit = (unit, grp, ch, note, into, input, gain) => {
    const names = {};
    for (const o of unit.objects) { names[o.n] = nmd ? nmd(o.n) : nm(o.n); decl.push(`${o.type} ${names[o.n]};`); }
    for (const c of unit.conns || []) conn(names[c[0]], c[1], names[c[2]], c[3]);
    conn(names[unit.out], 0, into, input);
    for (const s of unit.set || []) sets.push(sub(s, names) + ';');
    for (const o of unit.midi || []) sets.push(note === undefined ? `${names[o]}.midi(${ch}, ${grp});` : `${names[o]}.midi(${ch}, ${grp}, ${note});`);
    for (const [o, r] of Object.entries(unit.ratio || {})) sets.push(`${names[o]}.midiRatio(${tplValue(r, p)});`);
    for (const [o, v] of Object.entries(unit.velocity || {})) sets.push(`${names[o]}.midiVelocity(${fmtNum(v)});`);
    sets.push(`${into}.gain(${input}, ${fmtNum(gain)});`);
  };

  if (t.family === 'pads') {
    const ch = Math.round(it.p.channel || t.channel || 10), pads = activePads(it);
    // up to four pads sit on the instrument mixer; bigger kits get two sub-mixers
    let targets;
    if (pads.length <= 4) targets = pads.map((_, k) => [mix, k]);
    else {
      const sa = nm('pmix'), sb = nm('pmix');
      decl.push(`AudioMixer4 ${sa};`, `AudioMixer4 ${sb};`);
      conn(sa, 0, mix, 0); conn(sb, 0, mix, 1);
      sets.push(`${mix}.gain(0, 1);`, `${mix}.gain(1, 1);`);
      targets = pads.map((_, k) => (k < 4 ? [sa, k] : [sb, k - 4]));
    }
    pads.forEach((pd, k) => {
      const grp = nmd(pd.n);                                  // the pad's own group name
      emitUnit(pd, grp, ch, pd.note, targets[k][0], targets[k][1], level * (pd.gain === undefined ? 0.5 : pd.gain));
    });
  } else {
    const ch = fmtNum(clamp(Math.round(p.channel || 0), 0, 16));
    const n = instVoices(it);
    for (let k = 0; k < n; k++) {
      const grp = nm('v');
      emitUnit(t, grp, ch, undefined, mix, k, t.levelDiv === 'voices' ? level / n : 1 / n);   // chord headroom
    }
  }
  return mix;
}

/** Objects / connections an instrument card expands to (see emitInstrument). */
function instCost(it) {
  const t = instTemplate(it);
  if (t.family === 'pads') {
    const pads = activePads(it), subs = pads.length > 4 ? 2 : 0;
    return { objs: 1 + subs + pads.reduce((a, pd) => a + pd.objects.length, 0),
             conns: subs + pads.reduce((a, pd) => a + (pd.conns || []).length + 1, 0) };
  }
  const n = instVoices(it);
  return { objs: 1 + n * t.objects.length, conns: n * ((t.conns || []).length + 1) };
}
/** What the generated patch currently declares — the pedal's 24 / 48 limits apply to this. */
function patchBudget(preset) {
  const pp = parsePatch(generateText(preset));
  return { objects: pp.decls.length, conns: pp.conns.length };
}
/** Can this (additional or re-enabled) instrument still fit the pedal's limits? */
function instFits(preset, it) {
  const b = patchBudget(preset), c = instCost(it);
  // a source mixer (+ its input connection) appears with the first instrument and again
  // whenever the previous one fills up (three instruments per mixer)
  const on = instruments(preset).filter(x => x.on && x !== it).length;
  const extraMix = (on % 3 === 0) ? 1 : 0;
  return b.objects + c.objs + extraMix <= MAX_OBJECTS && b.conns + c.conns + extraMix <= MAX_CONNECTIONS;
}
/** Lowest MIDI channel (1-9, 11-16; 10 is the drum channel) no other melodic card uses. */
function nextFreeChannel(preset) {
  const used = new Set(instruments(preset).filter(i => !isPads(i)).map(i => instChannel(i)));
  for (let ch = 1; ch <= 16; ch++) if (ch !== 10 && !used.has(ch)) return ch;
  return 1;
}
/** Lane-level checks the text validator cannot make (it does not know which card owns a
 *  voice group): the pedal allocates voices per channel, so two melodic cards on one
 *  channel play each other's voices. Each issue carries the channel for the card badge. */
function instrumentIssues(preset) {
  const out = [];
  if (preset.mode === 'custom') return out;
  const on = instruments(preset).filter(it => it.on);
  const kitCh = new Set(on.filter(it => isPads(it)).map(it => instChannel(it)));
  const byCh = {};
  for (const it of on) {
    if (isPads(it)) continue;
    const ch = Math.round(it.p.channel || 0);
    (byCh[ch] = byCh[ch] || []).push(MACRO_BY_ID[it.id].label);
  }
  for (const k in byCh) {
    const ch = +k, names = byCh[k];
    if (names.length > 1) out.push({ line: 0, ch, msg: `${names.join(' and ')} share MIDI channel ${ch} — the pedal allocates voices per channel, so each keyboard also plays the other's voices; give every instrument its own channel` });
    if (ch === 0) out.push({ line: 0, ch, msg: `${names.join(', ')} on channel 0 (omni) answers every channel, including the other instruments' notes` });
    if (kitCh.has(ch)) out.push({ line: 0, ch, msg: `${names.join(', ')} on channel ${ch} shares a kit's channel — pads and keys will trigger each other` });
  }
  return out;
}

