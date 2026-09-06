/* ============================================================================
   6. Chain recovery — chain-meta rebuild & pure-series recognition
   ========================================================================== */
function chainFromMeta(meta) {
  if (!meta || meta.v !== 1 || !Array.isArray(meta.chain)) return null;
  const out = [];
  for (const it of meta.chain) {
    if (it && it.kind === 'fx' && SCHEMA_BY_TYPE[it.type]) {
      const base = newFxItem(it.type);
      base.on = it.on !== false;
      base.mix = clamp(Number(it.mix !== undefined ? it.mix : 1) || 0, 0, 1);
      base.showMix = !!it.showMix || !!SCHEMA_BY_TYPE[it.type].wet;
      if (it.params) for (const k in it.params)
        if (Array.isArray(it.params[k]) && base.params[k]) base.params[k] = it.params[k].slice(0, base.params[k].length);
      if (it.inc) for (const k in it.inc)
        if (k in base.inc) base.inc[k] = !!it.inc[k];
      out.push(base);
    } else if (it && it.kind === 'macro' && MACRO_BY_ID[it.id] && !INSTRUMENT_IDS.includes(it.id)) {
      const m = newMacroItem(it.id);
      m.on = it.on !== false;
      if (it.p) for (const prm of MACRO_BY_ID[it.id].params)
        if (it.p[prm.name] !== undefined) m.p[prm.name] = clamp(Number(it.p[prm.name]) || 0, prm.min, prm.max);
      out.push(m);
    } else return null;
  }
  return out;
}

/** Instruments from chain-meta: [] when the key is absent, null when malformed. */
function instrumentsFromMeta(meta) {
  if (!meta || meta.instruments === undefined) return [];
  if (!Array.isArray(meta.instruments)) return null;
  const out = [];
  for (const it of meta.instruments) {
    if (!it || it.kind !== 'inst' || !INSTRUMENT_IDS.includes(it.id)) return null;
    const m = newInstItem(it.id);
    m.on = it.on !== false;
    if (it.p) for (const prm of MACRO_BY_ID[it.id].params) {
      const v = it.p[prm.name];
      if (v === undefined) continue;
      if (prm.tokens) { if (prm.tokens.includes(v)) m.p[prm.name] = v; }
      else m.p[prm.name] = clamp(Number(v) || 0, prm.min, prm.max);
    }
    out.push(m);
  }
  return out.slice(0, MAX_INSTRUMENTS);
}

/** Recognize a plain series chain: fxin -> e1 -> ... -> en -> fxout, all ports 0,
 *  every setter a clean schema match. Returns chain items or null. */
function recognizeSeries(p) {
  if (p.errors.length) return null;
  const objs = {};
  for (const d of p.decls) {
    const def = SCHEMA_BY_TYPE[d.type];
    if (!def || def.inputs < 1 || def.outputs < 1 || objs[d.name]) return null;
    objs[d.name] = def;
  }
  const nextOf = {}, hasIn = {};
  for (const c of p.conns) {
    if (c.sp !== 0 || c.dp !== 0) return null;
    if (c.src !== 'fxin' && !objs[c.src]) return null;
    if (c.dst !== 'fxout' && !objs[c.dst]) return null;
    if (nextOf[c.src] !== undefined || hasIn[c.dst]) return null;   // fan-out / fan-in
    nextOf[c.src] = c.dst; hasIn[c.dst] = true;
  }
  const order = [];
  let cur = 'fxin';
  const seen = new Set();
  for (;;) {
    const nxt = nextOf[cur];
    if (!nxt || seen.has(nxt)) return null;
    if (nxt === 'fxout') break;
    seen.add(nxt); order.push(nxt); cur = nxt;
  }
  if (order.length !== Object.keys(objs).length) return null;

  const itemsByName = {};
  const items = order.map(n => {
    const it = newFxItem(objs[n].type);
    for (const k in it.inc) it.inc[k] = false;    // only setters present in the file
    it.mix = 1;                                    // no mixers in a pure series chain
    itemsByName[n] = it;
    return it;
  });
  for (const s of p.sets) {
    const it = itemsByName[s.name];
    if (!it) return null;
    const def = SCHEMA_BY_TYPE[it.type];
    const pd = def.params.find(pp => pp.method === s.method);
    if (!pd || pd.args.length !== s.args.length) return null;
    const vals = [];
    for (let i = 0; i < pd.args.length; i++) {
      const a = pd.args[i], raw = s.args[i];
      if (a.type === 'token') {
        if (!(a.tokens ? a.tokens.includes(raw) : KNOWN_TOKENS.has(raw))) return null;
        vals.push(raw);
      } else {
        const n = Number(raw);
        if (!isFinite(n)) return null;
        vals.push(n);
      }
    }
    it.params[s.method] = vals;
    it.inc[s.method] = true;
  }
  return items;
}

/**
 * Turn PatchScript text into preset fields.
 * preferMeta=true (imports, pulls): a valid chain-meta always wins, per PATCHSCRIPT.md.
 * preferMeta=false (edit-as-text resync): the meta is only trusted when the text still
 * matches its regeneration — otherwise hand edits would be silently reverted.
 */
/** Normalised text without the chain-meta line — what actually reaches the pedal. */
function stripMeta(t) {
  return normalizeText(String(t).split('\n').filter(l => !/^\s*\/\/\s*chain-meta:/.test(l)).join('\n'));
}
function resolvePresetFromText(text, fallbackTitle /* , preferMeta: retired */) {
  const p = parsePatch(text);
  const title = (p.title && p.title.length) ? p.title : (fallbackTitle || 'Untitled');
  if (p.meta) {
    const chain = chainFromMeta(p.meta);
    const insts = instrumentsFromMeta(p.meta);
    if (chain && insts) {
      // chain-meta is only trusted when the file body still matches its
      // regeneration — otherwise hand edits (on the SD card, in any text
      // editor) would be silently reverted on import/pull. The comparison
      // ignores the chain-meta line itself: that line is our own bookkeeping,
      // and holding it to the byte would mean every preset ever written became
      // custom routing the moment a macro gained a parameter.
      const candidate = { title, mode: 'chain', chain, instruments: insts, customText: null };
      if (stripMeta(generateText(candidate)) === stripMeta(text))
        return candidate;
    }
  }
  const series = recognizeSeries(p);
  if (series) return { title, mode: 'chain', chain: series, instruments: [], customText: null };
  // custom routing keeps the text verbatim, minus any stale chain-meta line.
  // (Hand-written instruments — midi() lines without chain-meta — land here too.)
  const stripped = String(text).split('\n')
    .filter(l => !/^\s*\/\/\s*chain-meta:/.test(l)).join('\n');
  return { title, mode: 'custom', chain: [], instruments: [], customText: stripped };
}

