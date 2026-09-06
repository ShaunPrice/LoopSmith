/* ============================================================================
   5. PatchScript parsing & validation (text -> statements -> issues)
   ========================================================================== */
const RE_CONN4 = /^AudioConnection\s+([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)\s*,\s*(\d+)\s*,\s*([A-Za-z_]\w*)\s*,\s*(\d+)\s*\)\s*;?$/;
const RE_CONN2 = /^AudioConnection\s+([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)\s*;?$/;
const RE_DECL  = /^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*;?$/;
const RE_SET   = /^([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(([^)]*)\)\s*;?$/;

function parsePatch(text) {
  const res = { title: null, metaRaw: null, meta: null,
                decls: [], conns: [], sets: [], errors: [], warnings: [] };
  const lines = String(text).split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const ln = idx + 1;
    let m = raw.match(/^\s*\/\/\s*name:\s*(.*)$/);
    if (m) { if (res.title === null) res.title = m[1].trim(); return; }
    m = raw.match(/^\s*\/\/\s*chain-meta:\s*(.*)$/);
    if (m) { if (res.metaRaw === null) res.metaRaw = m[1].trim(); return; }
    let line = raw;
    const ci2 = line.indexOf('//');
    if (ci2 >= 0) line = line.slice(0, ci2);          // trailing //xy=... comments ignored
    line = line.trim();
    if (!line) return;
    if ((m = line.match(RE_CONN4))) { res.conns.push({ id: m[1], src: m[2], sp: +m[3], dst: m[4], dp: +m[5], line: ln }); return; }
    if ((m = line.match(RE_CONN2))) { res.conns.push({ id: m[1], src: m[2], sp: 0, dst: m[3], dp: 0, line: ln }); return; }
    if ((m = line.match(RE_SET)))   {
      const ar = m[3].trim();
      res.sets.push({ name: m[1], method: m[2], args: ar === '' ? [] : ar.split(',').map(s => s.trim()), line: ln });
      return;
    }
    if ((m = line.match(RE_DECL))) {
      if (m[1] === 'AudioConnection') { res.errors.push({ line: ln, msg: 'Malformed AudioConnection' }); return; }
      res.decls.push({ type: m[1], name: m[2], line: ln });
      return;
    }
    res.errors.push({ line: ln, msg: `Unrecognized statement: "${line.slice(0, 60)}"` });
  });
  if (res.metaRaw) {
    try { res.meta = JSON.parse(res.metaRaw); }
    catch (e) { res.warnings.push({ line: 0, msg: 'chain-meta JSON is invalid; ignoring it' }); }
  }
  return res;
}

/** Full semantic validation per PATCHSCRIPT.md rules. Returns {errors, warnings}. */
function validatePatch(p, text) {
  const errors = [...p.errors], warnings = [...p.warnings];
  const objs = new Map();      // name -> {kind:'fx'|'in'|'out'|'ctl', type, def}
  let dynCount = 0;

  for (const d of p.decls) {
    if (d.name === 'fxin' || d.name === 'fxout') { errors.push({ line: d.line, msg: `"${d.name}" is a reserved endpoint name` }); continue; }
    if (objs.has(d.name)) { errors.push({ line: d.line, msg: `Duplicate identifier "${d.name}"` }); continue; }
    if (/^AudioInput/.test(d.type))       objs.set(d.name, { kind: 'in', type: d.type });
    else if (/^AudioOutput/.test(d.type)) objs.set(d.name, { kind: 'out', type: d.type });
    else if (/^AudioControl/.test(d.type)) {
      objs.set(d.name, { kind: 'ctl', type: d.type });
      warnings.push({ line: d.line, msg: `${d.type} is ignored — the firmware owns the codec` });
    } else {
      const def = SCHEMA_BY_TYPE[d.type];
      if (!def) errors.push({ line: d.line, msg: `Unknown type "${d.type}" — the preset would be rejected` });
      else { objs.set(d.name, { kind: 'fx', type: d.type, def }); dynCount++; }
    }
  }
  if (dynCount > MAX_OBJECTS) errors.push({ line: 0, msg: `Too many objects (${dynCount} > ${MAX_OBJECTS})` });
  if (p.conns.length > MAX_CONNECTIONS) errors.push({ line: 0, msg: `Too many connections (${p.conns.length} > ${MAX_CONNECTIONS})` });

  // resolve an endpoint name for a connection role
  const resolve = (name, role, line) => {
    if (name === 'fxin')  return role === 'src' ? { canon: 'fxin', ports: 1 } :
      (errors.push({ line, msg: 'fxin has no inputs — it cannot be a destination' }), null);
    if (name === 'fxout') return role === 'dst' ? { canon: 'fxout', ports: 4, isFxout: true } :
      (errors.push({ line, msg: 'fxout has no outputs — it cannot be a source' }), null);
    const o = objs.get(name);
    if (!o) { errors.push({ line, msg: `Unknown ${role === 'src' ? 'source' : 'destination'} "${name}"` }); return null; }
    if (o.kind === 'in')  return role === 'src' ? { canon: 'fxin', ports: 2 } :
      (errors.push({ line, msg: `"${name}" aliases fxin and cannot be a destination` }), null);
    if (o.kind === 'out') return role === 'dst' ? { canon: 'fxout', ports: 4, isFxout: true } :
      (errors.push({ line, msg: `"${name}" aliases fxout and cannot be a source` }), null);
    if (o.kind === 'ctl') { errors.push({ line, msg: `Codec object "${name}" cannot be connected` }); return null; }
    return { canon: name, ports: role === 'src' ? o.def.outputs : o.def.inputs };
  };

  const drivers = new Map();   // "dst:port" -> line of first driver
  for (const c of p.conns) {
    const src = resolve(c.src, 'src', c.line);
    const dst = resolve(c.dst, 'dst', c.line);
    if (src && c.sp >= src.ports)
      errors.push({ line: c.line, msg: `"${c.src}" has no output port ${c.sp} (outputs: ${src.ports})` });
    if (dst) {
      if (c.dp >= dst.ports) {
        if (dst.isFxout) warnings.push({ line: c.line, msg: `fxout input ${c.dp} will be clamped to 0-3` });
        else errors.push({ line: c.line, msg: `"${c.dst}" has no input port ${c.dp} (inputs: ${dst.ports})` });
      }
      const key = dst.canon + ':' + c.dp;
      if (drivers.has(key))
        errors.push({ line: c.line, msg: `Input ${dst.canon}:${c.dp} already driven on line ${drivers.get(key)} — one driver per input port (use an AudioMixer4 to sum)` });
      else drivers.set(key, c.line);
    }
  }

  for (const s of p.sets) {
    if (s.name === 'fxin' || s.name === 'fxout') { warnings.push({ line: s.line, msg: `Setters on ${s.name} are ignored` }); continue; }
    const o = objs.get(s.name);
    if (!o) { errors.push({ line: s.line, msg: `Unknown identifier "${s.name}"` }); continue; }
    if (o.kind === 'ctl') { warnings.push({ line: s.line, msg: 'Codec setter ignored — the firmware owns the codec' }); continue; }
    if (o.kind !== 'fx') { warnings.push({ line: s.line, msg: `Setter on I/O alias "${s.name}" is ignored` }); continue; }
    if (s.method === MIDI_BINDING.method) {          // midi(channel, group[, note]) voice binding
      if (!MIDI_BINDABLE.has(o.type)) warnings.push({ line: s.line, msg: `${o.type} cannot be a MIDI voice — midi() is only valid on ${[...MIDI_BINDABLE].join(', ')}` });
      else validateMidiArgs(s, warnings);
      continue;
    }
    if (s.method === 'midiRatio' || s.method === 'midiVelocity') {   // voice extensions (PATCHSCRIPT.md)
      if (!MIDI_BINDABLE.has(o.type)) warnings.push({ line: s.line, msg: `${s.method}() only applies to MIDI voices (${o.type} cannot be one)` });
      else if (s.args.length !== 1 || !Number.isFinite(Number(s.args[0]))) warnings.push({ line: s.line, msg: `${s.method}(x) expects one number` });
      continue;
    }
    if (s.method === 'sweep' && o.type === 'AudioSynthToneSweep') {
      if (s.args.length !== 4 || s.args.some(a => !Number.isFinite(Number(a)))) warnings.push({ line: s.line, msg: 'sweep(amp, fromHz, toHz, ms) expects four numbers' });
      continue;
    }
    if (s.method === 'file' && o.type === 'AudioPlaySdWav') {
      if (s.args.length !== 1 || Number.isFinite(Number(s.args[0])) || /[\/.]/.test(String(s.args[0]))) warnings.push({ line: s.line, msg: 'file(name) takes a bare name: /samples/<name>.wav' });
      continue;
    }
    const pd = o.def.params.find(pp => pp.method === s.method);
    if (!pd) { warnings.push({ line: s.line, msg: `${o.type} has no method "${s.method}" — line will be skipped` }); continue; }
    if (pd.args.length !== s.args.length) {
      warnings.push({ line: s.line, msg: `${s.method}() expects ${pd.args.length} argument(s), got ${s.args.length} — line will be skipped` });
      continue;
    }
    pd.args.forEach((a, i) => {
      const raw = s.args[i];
      if (a.type === 'token') {
        const ok = a.tokens ? a.tokens.includes(raw) : KNOWN_TOKENS.has(raw);
        if (!ok) warnings.push({ line: s.line, msg: `"${raw}" is not a valid token for ${s.method}()` });
      } else {
        const n = Number(raw);
        if (!isFinite(n)) warnings.push({ line: s.line, msg: `Argument ${i + 1} of ${s.method}() is not a number` });
        else if (a.min !== undefined && (n < a.min || n > a.max))
          warnings.push({ line: s.line, msg: `${s.method}() ${a.name}=${raw} is outside ${a.min}-${a.max}` });
      }
    });
  }

  if (text !== undefined) {
    const bytes = enc.encode(text).length;
    if (bytes > MAX_FILE_BYTES) errors.push({ line: 0, msg: `File is ${bytes} bytes — limit is ${MAX_FILE_BYTES} (16 KB)` });
  }
  return { errors, warnings };
}

/** midi(channel, group[, note]) per effects-schema.json "midiBinding": int, identifier, optional int. */
function validateMidiArgs(s, warnings) {
  const spec = MIDI_BINDING.args || [];
  const req = spec.filter(a => !a.optional).length;
  if (s.args.length < req || s.args.length > spec.length) {
    warnings.push({ line: s.line, msg: `midi() expects ${req}–${spec.length} arguments (channel, group[, note]), got ${s.args.length} — line will be skipped` });
    return;
  }
  s.args.forEach((raw, i) => {
    const a = spec[i];
    if (a.type === 'ident') {
      if (!/^[A-Za-z_]\w*$/.test(raw)) warnings.push({ line: s.line, msg: `midi() ${a.name} "${raw}" must be an identifier` });
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n)) warnings.push({ line: s.line, msg: `midi() ${a.name} "${raw}" must be an integer` });
      else if (a.min !== undefined && (n < a.min || n > a.max)) warnings.push({ line: s.line, msg: `midi() ${a.name}=${raw} is outside ${a.min}-${a.max}` });
    }
  });
}

