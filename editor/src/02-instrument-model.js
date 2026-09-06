/* ============================================================================
   3. Chain model — the UI-side representation of a preset
   ----------------------------------------------------------------------------
   Preset: { id, title, fileName, fileNameCustom, mode:'chain'|'custom',
             chain:[Item], instruments:[Item], customText, updated }
   Item (effect): { kind:'fx', type, on, mix (0..1), showMix, params:{method:[vals]},
                    inc:{method:bool} }
   Item (macro):  { kind:'macro', id:'echo'|'tremolo', on, p:{name:val} }
   Item (inst):   { kind:'inst', id:'pluck'|'synth'|'drumkit', on, p:{name:val} }
                  — lives in preset.instruments (sources summed with the guitar)
   ========================================================================== */

/** A param is emitted by default unless it is an action (0 args) or a non-"once"
 *  begin* mode selector (e.g. Granular beginPitchShift / beginFreeze). */
function defaultInclude(p) {
  if (p.once) return true;
  if (!p.args.length) return false;
  if (/^begin/.test(p.method)) return false;
  return true;
}

function newFxItem(type) {
  const def = SCHEMA_BY_TYPE[type];
  const params = {}, inc = {};
  for (const p of def.params) {
    params[p.method] = p.args.map(a =>
      a.default !== undefined ? a.default : (a.type === 'token' ? a.tokens[0] : 0));
    inc[p.method] = defaultInclude(p);
  }
  // The biquad's six filter modes all program stage 0 — they are mutually
  // exclusive, so a fresh card enables only the low-pass.
  if (type === 'AudioFilterBiquad') {
    for (const k of Object.keys(inc)) inc[k] = false;
    inc.setLowpass = true;
  }
  // Wet effects default to a musical 50% mix; everything else runs 100% series.
  return { kind: 'fx', type, on: true, mix: def.wet ? 0.5 : 1, showMix: !!def.wet, params, inc };
}

function newMacroItem(id) {
  const m = MACRO_BY_ID[id];
  const p = {};
  for (const prm of m.params) p[prm.name] = prm.default;
  return { kind: 'macro', id, on: true, p };
}

function newInstItem(id) {
  const m = MACRO_BY_ID[id];
  const p = {};
  for (const prm of m.params) p[prm.name] = prm.default;
  return { kind: 'inst', id, on: true, p };
}
/** The instrument list of a preset (older workspaces / imports may lack the field). */
function instruments(preset) { return Array.isArray(preset.instruments) ? preset.instruments : []; }

function itemLabel(item) {
  return item.kind === 'fx' ? SCHEMA_BY_TYPE[item.type].label : MACRO_BY_ID[item.id].label;
}
function itemCategory(item) {
  return item.kind === 'fx' ? SCHEMA_BY_TYPE[item.type].category : (item.kind === 'inst' ? 'instrument' : 'macro');
}

