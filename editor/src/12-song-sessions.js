const SONG_FORMAT = 'gls-song-session';
const SONG_VERSION = 1;
const SONG_LIMITS = {
  midiBytes: 2 * 1024 * 1024, midiCount: 64,
  loopBytes: MAX_LOOP_BYTES, loopCount: 32,
  presetCount: 64, presetText: 64 * 1024,
  total: 64 * 1024 * 1024,               // decoded payload cap (what validation sums)
  json: 96 * 1024 * 1024,                // raw file cap: total × 4/3 base64 overhead + headroom,
                                         // so nothing the exporter writes is refused by size on open
  name: 80, title: 120,
};

function b64FromBytes(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function bytesFromB64(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
/** "drums.mid" against ["drums.mid", …] -> "drums-2.mid": imports rename, never overwrite. */
function dedupeName(name, existing) {
  if (!existing.includes(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n < 1000; n++) {
    const cand = stem + '-' + n + ext;
    if (!existing.includes(cand)) return cand;
  }
  return stem + '-' + Date.now() + ext;
}

/** The playback-preference rules, shared by export, import and the player APIs. */
function validatePlaybackPrefs(p, errors, where) {
  const bad = m => { errors.push(where + ': ' + m); };
  if (typeof p !== 'object' || p === null) { bad('not an object'); return; }
  if (p.file !== undefined && typeof p.file !== 'string') bad('file must be a name');
  if (p.speed !== undefined && !(Number.isFinite(p.speed) && p.speed >= PLAY_SPEED_MIN && p.speed <= PLAY_SPEED_MAX))
    bad(`speed must be a number between ${PLAY_SPEED_MIN} and ${PLAY_SPEED_MAX}`);
  if (p.transpose !== undefined && !(Number.isInteger(p.transpose) && Math.abs(p.transpose) <= PLAY_TRANSPOSE_MAX))
    bad(`transpose must be a whole number within ±${PLAY_TRANSPOSE_MAX}`);
  for (const k of ['mute', 'solo'])
    if (p[k] !== undefined && !(Array.isArray(p[k]) && p[k].every(c => Number.isInteger(c) && c >= 1 && c <= 16)))
      bad(k + ' must be a list of channels 1-16');
  const hasA = p.a !== undefined && p.a !== null, hasB = p.b !== undefined && p.b !== null;
  if (hasA !== hasB) bad('the repeat passage needs both A and B');
  else if (hasA) {
    if (!(Number.isFinite(p.a) && Number.isFinite(p.b) && p.a >= 0 && p.b - p.a >= 0.05))
      bad('the repeat passage must be finite, at least 0.05 s, and A before B');
  }
}

/** The whole package checked before ANYTHING is applied. Returns
 *  { ok, errors, warnings, data } — data holds the decoded bytes so applying
 *  never re-parses (and cannot half-succeed on a corrupt file). */
function sessionValidate(pkg) {
  const errors = [], warnings = [];
  const data = { title: '', presets: [], midi: [], loops: [], playback: null, switches: null, layout: null };
  if (typeof pkg !== 'object' || pkg === null) return { ok: false, errors: ['This is not a song session file.'], warnings, data };
  if (pkg.format !== SONG_FORMAT) return { ok: false, errors: ['This is not a song session file (missing the gls-song-session marker).'], warnings, data };
  if (!Number.isInteger(pkg.version) || pkg.version < 1)
    return { ok: false, errors: ['The session has no usable version number.'], warnings, data };
  if (pkg.version > SONG_VERSION)
    return { ok: false, errors: [`This session was made by a newer Studio (format v${pkg.version}; this one reads up to v${SONG_VERSION}). Update, then open it again.`], warnings, data };
  data.title = typeof pkg.title === 'string' ? pkg.title.slice(0, SONG_LIMITS.title) : '';
  let total = 0;
  const nameOk = (n, exts) => typeof n === 'string' && n.length <= SONG_LIMITS.name && !n.startsWith('.') &&
    /^[A-Za-z0-9._-]+$/.test(n) && exts.some(e => n.toLowerCase().endsWith(e));

  const presets = pkg.presets === undefined ? [] : pkg.presets;
  if (!Array.isArray(presets)) errors.push('presets: not a list');
  else if (presets.length > SONG_LIMITS.presetCount) errors.push(`presets: more than ${SONG_LIMITS.presetCount}`);
  else presets.forEach((p, i) => {
    const where = `preset ${i + 1}${p && typeof p.title === 'string' ? ` (${p.title})` : ''}`;
    if (typeof p !== 'object' || p === null || typeof p.title !== 'string' || !p.title.trim()) { errors.push(where + ': missing a title'); return; }
    if (p.mode !== 'chain' && p.mode !== 'custom') { errors.push(where + ': mode must be chain or custom'); return; }
    const clean = { title: p.title.slice(0, SONG_LIMITS.title), mode: p.mode,
                    fileName: typeof p.fileName === 'string' ? p.fileName.slice(0, SONG_LIMITS.name) : null,
                    fileNameCustom: !!p.fileNameCustom,
                    chain: Array.isArray(p.chain) ? p.chain : [],
                    instruments: Array.isArray(p.instruments) ? p.instruments : [],
                    customText: typeof p.customText === 'string' ? p.customText : null };
    if (clean.mode === 'custom' && typeof clean.customText !== 'string') { errors.push(where + ': custom routing without its text'); return; }
    if (clean.customText && clean.customText.length > SONG_LIMITS.presetText) { errors.push(where + ': the PatchScript is longer than ' + (SONG_LIMITS.presetText / 1024) + ' KB'); return; }
    let text;
    try { text = generateText(clean); } catch (e) { errors.push(where + ': does not generate PatchScript (' + e.message + ')'); return; }
    if (typeof text !== 'string' || text.length > SONG_LIMITS.presetText) { errors.push(where + ': generates unusable PatchScript'); return; }
    total += text.length;
    data.presets.push(clean);
  });

  const midiFiles = pkg.midiFiles === undefined ? [] : pkg.midiFiles;
  if (!Array.isArray(midiFiles)) errors.push('midiFiles: not a list');
  else if (midiFiles.length > SONG_LIMITS.midiCount) errors.push(`midiFiles: more than ${SONG_LIMITS.midiCount}`);
  else midiFiles.forEach((f, i) => {
    const where = `MIDI file ${i + 1}${f && typeof f.name === 'string' ? ` (${f.name})` : ''}`;
    if (typeof f !== 'object' || f === null || !nameOk(f.name, ['.mid', '.midi', '.smf'])) { errors.push(where + ': bad name (letters, digits, . _ - and a .mid ending)'); return; }
    if (typeof f.data !== 'string') { errors.push(where + ': no data'); return; }
    let bytes;
    try { bytes = bytesFromB64(f.data); } catch (e) { errors.push(where + ': corrupt base64 data'); return; }
    if (bytes.length > SONG_LIMITS.midiBytes) { errors.push(where + `: ${fmtBytes(bytes.length)} — the limit is ${fmtBytes(SONG_LIMITS.midiBytes)}`); return; }
    let parsed;
    try { parsed = parseSmf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }
    catch (e) { errors.push(where + ': not a usable MIDI file (' + e.message + ')'); return; }
    total += bytes.length;
    data.midi.push({ name: f.name, bytes, parsed });
  });

  const loops = pkg.loops === undefined ? [] : pkg.loops;
  if (!Array.isArray(loops)) errors.push('loops: not a list');
  else if (loops.length > SONG_LIMITS.loopCount) errors.push(`loops: more than ${SONG_LIMITS.loopCount}`);
  else loops.forEach((f, i) => {
    const where = `loop ${i + 1}${f && typeof f.name === 'string' ? ` (${f.name})` : ''}`;
    if (typeof f !== 'object' || f === null || !nameOk(f.name, ['.wav'])) { errors.push(where + ': bad name (letters, digits, . _ - and a .wav ending)'); return; }
    if (typeof f.data !== 'string') { errors.push(where + ': no data'); return; }
    let bytes;
    try { bytes = bytesFromB64(f.data); } catch (e) { errors.push(where + ': corrupt base64 data'); return; }
    if (bytes.length > SONG_LIMITS.loopBytes) { errors.push(where + `: ${fmtBytes(bytes.length)} — the limit is ${fmtBytes(SONG_LIMITS.loopBytes)}`); return; }
    if (!isWav(bytes)) { errors.push(where + ': not a RIFF/WAVE file'); return; }
    const info = wavInfo(bytes);
    if (!info) { errors.push(where + ': WAV headers unreadable'); return; }
    total += bytes.length;
    data.loops.push({ name: f.name, bytes,
                      seconds: info.dataBytes / Math.max(1, info.rate * info.channels * (info.bits / 8)) });
  });

  if (pkg.playback !== undefined && pkg.playback !== null) {
    validatePlaybackPrefs(pkg.playback, errors, 'playback preferences');
    if (typeof pkg.playback.file === 'string' && !nameOk(pkg.playback.file, ['.mid', '.midi', '.smf']))
      errors.push('playback preferences: the file name is not a usable MIDI name');
    data.playback = pkg.playback;
    if (typeof pkg.playback.file === 'string' && !data.midi.some(m => m.name === pkg.playback.file))
      warnings.push(`The playback preferences point at "${pkg.playback.file}", which this session does not carry — they will apply once a file of that name exists.`);
  }
  if (pkg.switches !== undefined && pkg.switches !== null) {
    const sw = pkg.switches;
    const okAct = a => typeof a === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(a);
    if (!Array.isArray(sw) || sw.length > 6 ||
        !sw.every(s => s && okAct(s.tap || 'none') && okAct(s.hold || 'none') &&
                       (s.note === undefined || (Number.isInteger(s.note) && s.note >= 0 && s.note <= 127))))
      errors.push('footswitches: each of up to six rows needs tap/hold action names and an optional note 0-127');
    else data.switches = sw.map(s => ({ tap: s.tap || 'none', hold: s.hold || 'none', note: s.note }));
  }
  if (pkg.layout !== undefined && pkg.layout !== null) {
    const lay = pkg.layout;
    const strs = a => Array.isArray(a) && a.every(x => typeof x === 'string' && x.length <= 40);
    if (typeof lay !== 'object' || typeof lay.regions !== 'object' || lay.regions === null ||
        !Object.keys(lay.regions).every(r => ['library', 'center', 'device', 'hidden'].includes(r) && strs(lay.regions[r])) ||
        (lay.closed !== undefined && !strs(lay.closed)))
      errors.push('layout: regions must map library/center/device/hidden to lists of panel ids');
    else data.layout = { regions: lay.regions, closed: lay.closed || [] };
  }
  if (total > SONG_LIMITS.total) errors.push(`The session unpacks to ${fmtBytes(total)} — the limit is ${fmtBytes(SONG_LIMITS.total)}.`);
  if (!data.presets.length && !data.midi.length && !data.loops.length && !data.playback && !data.switches && !data.layout && !errors.length)
    errors.push('The session is empty.');
  return { ok: !errors.length, errors, warnings, data };
}

/* ---- building a session from the current state ---- */
async function sessionBuild(sel) {
  const pkg = { format: SONG_FORMAT, version: SONG_VERSION, app: 'GuitarLoopSynth Studio',
                created: new Date().toISOString(), title: sel.title || 'Song',
                presets: [], midiFiles: [], loops: [] };
  // the same decoded-payload bound the importer enforces, checked as we pack:
  // nothing this exporter writes may be refused on open
  let total = 0;
  const grow = (n, what) => {
    total += n;
    if (total > SONG_LIMITS.total)
      throw new Error(`adding ${what} takes the session past ${fmtBytes(SONG_LIMITS.total)} — untick something`);
  };
  for (const id of sel.presets) {
    const p = store.state.presets.find(x => x.id === id);
    if (!p) continue;
    // the workspace object verbatim (minus the workspace id): custom text and
    // chain-meta survive because nothing is regenerated on the way out
    pkg.presets.push({ title: p.title, fileName: p.fileName, fileNameCustom: !!p.fileNameCustom,
                       mode: p.mode, chain: p.chain, instruments: p.instruments || [], customText: p.customText });
    grow(generateText(p).length, `preset ${p.title}`);
  }
  for (const name of sel.midi) {
    const f = scoreFiles().find(x => x.name === name);
    if (!f) continue;
    // careful: on bridge listings f.bytes is the SIZE; only local uploads hold the data
    let bytes = f.bytes instanceof Uint8Array ? f.bytes : null;
    if (!bytes && midi.netHost) {
      const r = await fetch('/midi-files/' + encodeURIComponent(name));
      if (!r.ok) throw new Error(`could not read ${name} from the Pi`);
      bytes = new Uint8Array(await r.arrayBuffer());
    }
    if (!bytes) throw new Error(`${name} has no bytes to export — re-upload it first`);
    if (bytes.length > SONG_LIMITS.midiBytes) throw new Error(`${name} is ${fmtBytes(bytes.length)} — too big for a session`);
    grow(bytes.length, name);
    pkg.midiFiles.push({ name, data: b64FromBytes(bytes) });
  }
  for (const name of sel.loops) {
    const bytes = await loopFetch(name);                      // explicit: only ticked loops leave the pedal
    if (bytes.length > SONG_LIMITS.loopBytes) throw new Error(`${name} is ${fmtBytes(bytes.length)} — too big for a session`);
    grow(bytes.length, name);
    pkg.loops.push({ name, data: b64FromBytes(bytes) });
  }
  if (sel.playback) {
    pkg.playback = Object.assign({ file: score.file || undefined, loop: !!midi.loop, roll: scoreCtl.roll }, scoreCtlParams());
    if (pkg.playback.a === null) { delete pkg.playback.a; delete pkg.playback.b; }
  }
  if (sel.switches && dev.switches && Array.isArray(dev.switches.switches))
    pkg.switches = dev.switches.switches.slice(0, 6).map(s => ({ tap: s.tap || 'none', hold: s.hold || 'none', note: s.note }));
  if (sel.layout) pkg.layout = layoutSnapshot();
  return pkg;
}

/* ---- applying a validated session (only what was ticked; never silently
        overwriting a file, a loop or the pedal) ---- */
async function sessionApply(data, choose) {
  const done = [], failed = [];
  const addedPresets = new Map();              // session title -> the workspace preset object
  for (const p of data.presets) {
    if (!choose.presets.has(p.title)) continue;
    const wp = Object.assign({ id: uid(), updated: Date.now() }, p, { title: uniqueTitle(p.title) });
    addPreset(wp);
    addedPresets.set(p.title, wp);
    done.push('preset ' + p.title + (wp.title !== p.title ? ` (as "${wp.title}")` : ''));
  }
  // one imported preset may be loaded onto the pedal — explicit, and honest
  // about failing. `apply` is live-only; the SD card is written only when the
  // user also asked for that.
  if (choose.pedalPreset) {
    const wp = addedPresets.get(choose.pedalPreset);
    if (!wp) failed.push(`pedal preset: "${choose.pedalPreset}" was not imported`);
    else if (!link.connected) failed.push('pedal preset: the pedal is not connected — nothing was sent');
    else {
      try {
        const text = generateText(wp);
        const bytes = enc.encode(text);
        if (bytes.length > MAX_FILE_BYTES) throw new Error(`the preset is ${bytes.length} bytes (> 16 KB)`);
        if (!patchIsValid(text, null)) throw new Error('it fails PatchScript validation — open it in Studio to see why');
        if (choose.pedalSave) {
          let name = ensureFileName(wp).replace(/\s+/g, '_');
          await sendCmd(`put ${name} ${bytes.length}`, { payload: bytes, kind: 'send' });
          await refreshDeviceList();
          done.push(`pedal preset "${wp.title}" written to the SD card as ${name}`);
        }
        await sendCmd(`apply ${bytes.length}`, { payload: bytes, kind: 'send' });
        done.push(`pedal preset "${wp.title}" applied live`);
      } catch (e) { failed.push(`pedal preset "${wp.title}": ${e.message}`); }
    }
  }
  const existingMidi = scoreFiles().map(f => f.name);
  const importedAs = new Map();                // original name -> actual name, ONLY on success
  for (const f of data.midi) {
    if (!choose.midi.has(f.name)) continue;
    const name = choose.replace ? f.name : dedupeName(f.name, existingMidi);
    try {
      if (midi.netHost) {
        const r = await fetch('/midi-files/' + encodeURIComponent(name), { method: 'PUT', body: f.bytes });
        const j = await r.json().catch(() => ({}));
        if (!j.ok) throw new Error(j.message || ('HTTP ' + r.status));
      } else {
        midi.local = midi.local.filter(x => x.name !== name)
          .concat([{ name, length: f.parsed.length, events: f.parsed.events, uses: midiUsage(f.parsed.events), parsed: f.parsed, bytes: f.bytes }]);
      }
      existingMidi.push(name);
      importedAs.set(f.name, name);
      done.push('MIDI ' + name + (name !== f.name ? ` (renamed from ${f.name})` : ''));
    } catch (e) { failed.push(`MIDI ${f.name}: ${e.message}`); }
  }
  if (midi.netHost) await midiRefreshFiles(); else { scoreSync(); midiPaint(); }
  const existingLoops = (dev.loops && Array.isArray(dev.loops.loops)) ? [...dev.loops.loops] : [];
  for (const f of data.loops) {
    if (!choose.loops.has(f.name)) continue;
    const base = loopFileName(f.name);
    if (!base) { failed.push(`loop ${f.name}: unusable name`); continue; }
    const name = choose.replace ? base : dedupeName(base, existingLoops);
    if (!loopFits(f.seconds, name)) { failed.push(`loop ${name}: longer than the looper holds`); continue; }
    try { await loopPut(name, f.bytes); existingLoops.push(name); done.push('loop ' + name + (name !== f.name ? ` (renamed from ${f.name})` : '')); }
    catch (e) { failed.push(`loop ${f.name}: ${e.message}`); }
  }
  if (data.loops.some(f => choose.loops.has(f.name))) await refreshLoops();
  if (data.playback && choose.playback) {
    const p = data.playback;
    let fileMissed = false;
    // choose the file FIRST: scoreSelect clears the A/B passage on a change of
    // file. When the session carried the file, only the copy that was actually
    // imported (under whatever name it landed) may be selected — an unrelated
    // existing file with the same name holds different bytes.
    if (typeof p.file === 'string') {
      const carried = data.midi.some(m => m.name === p.file);
      let target = null;
      if (carried) {
        if (importedAs.has(p.file)) target = importedAs.get(p.file);
        else failed.push(`playback: ${p.file} came with the session but was not imported${choose.midi.has(p.file) ? '' : ' (unticked)'} — pick a file in the Score panel yourself`);
      } else if (scoreFiles().some(f => f.name === p.file)) {
        target = p.file;                       // the documented missing-asset case: a file of that name is already here
      } else {
        failed.push(`playback: "${p.file}" is not among the MIDI files here — pick it in the Score panel when it is`);
      }
      if (target) { score.file = null; scoreSelect(target); }
      else fileMissed = true;
    }
    if (p.speed !== undefined) scoreCtl.speed = p.speed;
    if (p.transpose !== undefined) scoreCtl.transpose = p.transpose;
    scoreCtl.mute = new Set(p.mute || []);
    scoreCtl.solo = new Set(p.solo || []);
    // A/B marks a passage in ONE file — restore it only when that file is on show
    scoreCtl.a = !fileMissed && typeof p.a === 'number' ? p.a : null;
    scoreCtl.b = !fileMissed && typeof p.b === 'number' ? p.b : null;
    if (p.roll === true || p.roll === false) scoreCtl.roll = p.roll;
    if (p.loop !== undefined) { midi.loop = !!p.loop; if ($('#midiLoopChk')) $('#midiLoopChk').checked = midi.loop; }
    if ($('#scoreSpeed')) $('#scoreSpeed').value = String(scoreCtl.speed);
    if ($('#scoreTrans')) $('#scoreTrans').value = String(scoreCtl.transpose);
    scoreApplyCtl(); scorePaint();
    done.push('playback preferences');
  }
  if (data.switches && choose.switches) {
    try {
      for (let i = 0; i < data.switches.length; i++) {
        const s = data.switches[i], args = ['switch', i + 1, s.tap, s.hold];
        if (s.tap === 'note' || s.hold === 'note') args.push(clamp(Math.round(+s.note) || 0, 0, 127));
        await sendCmd(args.join(' '));
      }
      await sendCmd('switches');
      done.push('footswitch assignments');
    } catch (e) { failed.push('footswitches: ' + e.message); }
  }
  if (data.layout && choose.layout) {
    try { layout.name = 'Song'; layoutApply(data.layout); done.push('panel layout'); }
    catch (e) { failed.push('layout: ' + e.message); }
  }
  return { done, failed };
}

/* ---- the Song panel + its two modal flows ---- */
function songModalEl() {
  let m = $('#songModal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'songModal'; m.className = 'modal'; m.hidden = true;
    m.innerHTML = '<div class="modal-card" role="dialog" aria-modal="true" aria-label="Song session"><div id="songModalBody"></div></div>';
    m.addEventListener('click', e => { if (e.target === m) m.hidden = true; });
    document.body.appendChild(m);
  }
  return m;
}
function songModalShow(body) { const m = songModalEl(); $('#songModalBody').replaceChildren(body); m.hidden = false; }
function songModalClose() { const m = $('#songModal'); if (m) m.hidden = true; }
function songRow(box, kind, name, note, checked, disabled, label) {
  const l = document.createElement('label');
  const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!checked && !disabled; c.disabled = !!disabled;
  c.dataset.kind = kind; c.dataset.name = name;
  const s = document.createElement('span'); s.textContent = label || name;
  l.append(c, s);
  if (note) { const n = document.createElement('span'); n.className = 'note'; n.textContent = note; l.appendChild(n); }
  box.appendChild(l);
  return c;
}
function songCat(host, text) { const d = document.createElement('div'); d.className = 'song-cat'; d.textContent = text; host.appendChild(d); }
function songMsg(host, kind, text) { const d = document.createElement('div'); d.className = 'song-msg ' + kind; d.textContent = text; host.appendChild(d); }

function songExportOpen() {
  const body = document.createElement('div');
  const h = document.createElement('h2'); h.textContent = 'Export a song session'; body.appendChild(h);
  const sub = document.createElement('div'); sub.className = 'sub';
  sub.textContent = 'One JSON file carrying whatever you tick. Loops are read from the pedal, so ticking them takes a moment.';
  body.appendChild(sub);
  const title = document.createElement('input'); title.type = 'text'; title.style.width = '100%';
  title.placeholder = 'Song title'; title.value = (current() && current().title) || 'Song';
  body.appendChild(title);
  songCat(body, 'Presets (workspace)');
  const presetBox = document.createElement('div'); presetBox.className = 'song-list'; body.appendChild(presetBox);
  for (const p of store.state.presets)
    songRow(presetBox, 'preset', p.id, p.mode === 'custom' ? 'custom routing' : 'chain', p.id === store.state.currentId, false, p.title);
  songCat(body, 'MIDI files');
  const midiBox = document.createElement('div'); midiBox.className = 'song-list'; body.appendChild(midiBox);
  const files = scoreFiles();
  if (!files.length) songMsg(midiBox, 'warn', 'No MIDI files here yet.');
  for (const f of files) {
    const missing = !f.bytes && !midi.netHost;
    songRow(midiBox, 'midi', f.name, missing ? 're-upload to include' : '', !missing, missing);
  }
  songCat(body, 'Loops (from the pedal’s SD card)');
  const loopBox = document.createElement('div'); loopBox.className = 'song-list'; body.appendChild(loopBox);
  const loopNames = (link.connected && dev.loops && dev.loops.sd && Array.isArray(dev.loops.loops)) ? dev.loops.loops : [];
  if (!loopNames.length) songMsg(loopBox, 'warn', link.connected ? 'No loops on the card (or no card).' : 'Connect the pedal to include saved loops.');
  for (const n of loopNames) songRow(loopBox, 'loop', n, '', false);
  songCat(body, 'Also carry');
  const extraBox = document.createElement('div'); extraBox.className = 'song-list'; body.appendChild(extraBox);
  const cPlay = songRow(extraBox, 'extra', 'playback', 'speed · transpose · mute/solo · A/B · loop', true, false, 'Playback preferences');
  const cSw = songRow(extraBox, 'extra', 'switches', link.connected && dev.switches ? '' : 'connect the pedal to read them', !!(link.connected && dev.switches), !(link.connected && dev.switches), 'Footswitch assignments');
  const cLay = songRow(extraBox, 'extra', 'layout', 'how the panels are arranged', false, false, 'Panel layout');
  const msg = document.createElement('div'); body.appendChild(msg);
  const row = document.createElement('div'); row.className = 'actions-row';
  const go = document.createElement('button'); go.className = 'btn accent'; go.textContent = 'Export';
  const cancel = document.createElement('button'); cancel.className = 'btn'; cancel.textContent = 'Cancel';
  cancel.addEventListener('click', songModalClose);
  row.append(go, cancel); body.appendChild(row);
  go.addEventListener('click', async () => {
    const picked = kind => [...body.querySelectorAll(`input[data-kind="${kind}"]:checked`)].map(c => c.dataset.name);
    const sel = { title: title.value.trim() || 'Song', presets: picked('preset'), midi: picked('midi'), loops: picked('loop'),
                  playback: cPlay.checked, switches: cSw.checked, layout: cLay.checked };
    go.disabled = true; msg.replaceChildren(); songMsg(msg, 'ok', sel.loops.length ? 'Reading loops from the pedal…' : 'Packing…');
    try {
      const pkg = await sessionBuild(sel);
      const json = JSON.stringify(pkg);
      if (json.length > SONG_LIMITS.json)
        throw new Error(`the session file would be ${fmtBytes(json.length)} — the limit is ${fmtBytes(SONG_LIMITS.json)}`);
      const fname = (sanitizeFileName(sel.title).replace(/\.txt$/, '') || 'song') + '.glsong.json';
      saveBlob(new Blob([json], { type: 'application/json' }), fname);
      consoleLog('ok', `Exported ${fname} (${fmtBytes(json.length)}: ${pkg.presets.length} presets, ${pkg.midiFiles.length} MIDI, ${pkg.loops.length} loops)`);
      songModalClose();
    } catch (e) {
      msg.replaceChildren(); songMsg(msg, 'err', 'Export failed: ' + e.message);
      go.disabled = false;
    }
  });
  songModalShow(body);
}

function songImportOpen(text, fileName) {
  let pkg;
  try { pkg = JSON.parse(text); }
  catch (e) { consoleLog('err', `${fileName}: not JSON — not a song session`); return; }
  const v = sessionValidate(pkg);
  const body = document.createElement('div');
  const h = document.createElement('h2'); h.textContent = 'Open song session'; body.appendChild(h);
  const sub = document.createElement('div'); sub.className = 'sub';
  sub.textContent = `${fileName}${v.data.title ? ' — ' + v.data.title : ''}${pkg && pkg.created ? ' · ' + String(pkg.created).slice(0, 10) : ''}`;
  body.appendChild(sub);
  if (!v.ok) {
    songMsg(body, 'err', 'Nothing was changed. The file cannot be used:');
    for (const e of v.errors.slice(0, 12)) songMsg(body, 'err', e);
    if (v.errors.length > 12) songMsg(body, 'err', `…and ${v.errors.length - 12} more.`);
    const row = document.createElement('div'); row.className = 'actions-row';
    const close = document.createElement('button'); close.className = 'btn'; close.textContent = 'Close';
    close.addEventListener('click', songModalClose);
    row.appendChild(close); body.appendChild(row);
    songModalShow(body);
    return;
  }
  for (const wmsg of v.warnings) songMsg(body, 'warn', wmsg);
  const d = v.data;
  let pedalSel = null, pedalSave = null;
  if (d.presets.length) {
    songCat(body, 'Presets — added to the workspace (existing ones are never touched)');
    const box = document.createElement('div'); box.className = 'song-list'; body.appendChild(box);
    for (const p of d.presets) songRow(box, 'preset', p.title, p.mode === 'custom' ? 'custom routing' : 'chain', true);
    // the song's sound, onto the pedal (NEW): one imported preset may be
    // applied live after import — explicit, and the SD card only with its own tick
    songCat(body, 'Pedal — the song’s sound');
    const pb = document.createElement('div'); pb.className = 'song-list'; body.appendChild(pb);
    if (!link.connected) songMsg(pb, 'warn', 'Connect the pedal to load one of these presets onto it after import.');
    else {
      pedalSel = document.createElement('select'); pedalSel.className = 'midi-sel'; pedalSel.style.width = '100%';
      const opt = (v, label) => { const o = document.createElement('option'); o.value = v; o.textContent = label; pedalSel.appendChild(o); };
      opt('', 'Do not touch the pedal');
      for (const p of d.presets) opt(p.title, `Apply "${p.title}" live after import`);
      pb.appendChild(pedalSel);
      pedalSave = songRow(pb, 'opt', 'pedalsave', 'unticked: live only, the SD card is untouched', false, false,
                          'Also write that preset to the pedal’s SD card');
    }
  }
  const midiHere = scoreFiles().map(f => f.name);
  if (d.midi.length) {
    songCat(body, midi.netHost ? 'MIDI files — uploaded to the Pi' : 'MIDI files — kept in this browser');
    const box = document.createElement('div'); box.className = 'song-list'; body.appendChild(box);
    for (const f of d.midi)
      songRow(box, 'midi', f.name, midiHere.includes(f.name) ? `exists — saved as ${dedupeName(f.name, midiHere)}` : fmtBytes(f.bytes.length), true);
  }
  const loopsReady = !!(link.connected && dev.loops && dev.loops.sd);
  if (d.loops.length) {
    songCat(body, 'Loops — written to the pedal’s SD card only if ticked');
    const box = document.createElement('div'); box.className = 'song-list'; body.appendChild(box);
    const here = loopsReady ? dev.loops.loops : [];
    for (const f of d.loops)
      songRow(box, 'loop', f.name,
              !loopsReady ? 'connect the pedal (with its SD card) first'
              : here.includes(loopFileName(f.name)) ? `exists — saved as ${dedupeName(loopFileName(f.name), here)}` : fmtBytes(f.bytes.length),
              false, !loopsReady);
  }
  songCat(body, 'Also apply');
  const extraBox = document.createElement('div'); extraBox.className = 'song-list'; body.appendChild(extraBox);
  let cPlay = null, cSw = null, cLay = null;
  if (d.playback)
    cPlay = songRow(extraBox, 'extra', 'playback',
      [d.playback.file, d.playback.speed && d.playback.speed !== 1 ? d.playback.speed + '×' : '',
       d.playback.transpose ? (d.playback.transpose > 0 ? '+' : '') + d.playback.transpose + ' st' : ''].filter(Boolean).join(' · '),
      true, false, 'Playback preferences');
  if (d.switches)
    cSw = songRow(extraBox, 'extra', 'switches', link.connected ? 'writes the six switch rows to the pedal' : 'connect the pedal first',
                  false, !link.connected, 'Footswitch assignments');
  if (d.layout)
    cLay = songRow(extraBox, 'extra', 'layout', 'rearranges the panels here', false, false, 'Panel layout');
  if (!extraBox.children.length) extraBox.remove();
  let cReplace = null;
  if (d.midi.length || d.loops.length) {
    const box = document.createElement('div'); box.className = 'song-list'; body.appendChild(box);
    cReplace = songRow(box, 'opt', 'replace', 'otherwise clashing names are renamed', false, false, 'Replace files that already exist');
  }
  const msg = document.createElement('div'); body.appendChild(msg);
  const row = document.createElement('div'); row.className = 'actions-row';
  const go = document.createElement('button'); go.className = 'btn accent'; go.textContent = 'Apply ticked items';
  const cancel = document.createElement('button'); cancel.className = 'btn'; cancel.textContent = 'Cancel';
  cancel.addEventListener('click', songModalClose);
  row.append(go, cancel); body.appendChild(row);
  go.addEventListener('click', async () => {
    const picked = kind => new Set([...body.querySelectorAll(`input[data-kind="${kind}"]:checked`)].map(c => c.dataset.name));
    const choose = { presets: picked('preset'), midi: picked('midi'), loops: picked('loop'),
                     playback: !!(cPlay && cPlay.checked), switches: !!(cSw && cSw.checked), layout: !!(cLay && cLay.checked),
                     replace: !!(cReplace && cReplace.checked),
                     pedalPreset: (pedalSel && pedalSel.value) || null, pedalSave: !!(pedalSave && pedalSave.checked) };
    if (choose.pedalPreset && !choose.presets.has(choose.pedalPreset)) choose.presets.add(choose.pedalPreset);
    go.disabled = true; msg.replaceChildren(); songMsg(msg, 'ok', 'Applying…');
    const res = await sessionApply(d, choose);
    for (const line of res.done) consoleLog('ok', 'Session: ' + line);
    for (const line of res.failed) consoleLog('err', 'Session: ' + line);
    msg.replaceChildren();
    if (res.failed.length) { for (const f of res.failed.slice(0, 8)) songMsg(msg, 'err', f); go.disabled = false; }
    if (res.done.length) songMsg(msg, 'ok', `Applied: ${res.done.length} item${res.done.length === 1 ? '' : 's'}.`);
    if (!res.failed.length) setTimeout(songModalClose, 900);
  });
  songModalShow(body);
}

function songBuildSection() {
  const sec = document.createElement('div'); sec.className = 'dev-sec coll'; sec.id = 'songSec';
  sec.dataset.title = 'Song session';
  sec.innerHTML = `<h3 role="button" tabindex="0"><span class="caret">&#9660;</span> SONG SESSION</h3>
  <div class="sec-body">
    <div class="play-hint">Everything a song needs — MIDI files, presets, loops, playback settings, footswitches — travels in one file.</div>
    <div class="actions-row">
      <button class="btn sm" id="songExportBtn" title="Pack the ticked pieces of this workspace into one shareable file">Export song&#8230;</button>
      <button class="btn sm" id="songImportBtn" title="Open a song session — everything is checked before anything is applied">Open song&#8230;</button>
    </div>
    <input type="file" id="songImportInput" accept=".json,.glsong" hidden>
  </div>`;
  const after = $('#scoreSec') || $('#chanSec') || $('#device').lastElementChild;
  after.insertAdjacentElement('afterend', sec);
  sec.querySelector('h3').addEventListener('click', () => sec.classList.toggle('closed'));
  $('#songExportBtn').addEventListener('click', songExportOpen);
  $('#songImportBtn').addEventListener('click', () => $('#songImportInput').click());
  $('#songImportInput').addEventListener('change', async ev => {
    const f = ev.target.files[0]; ev.target.value = '';
    if (!f) return;
    if (f.size > SONG_LIMITS.json) { consoleLog('err', `${f.name} is ${fmtBytes(f.size)} — session files are capped at ${fmtBytes(SONG_LIMITS.json)}`); return; }
    songImportOpen(await f.text(), f.name);
  });
}

/* ---- the panel ---- */
function midiBuildSection() {
  const sec = document.createElement('div'); sec.className = 'dev-sec coll'; sec.id = 'midiSec';
  sec.innerHTML = `<h3 role="button" tabindex="0"><span class="caret">▼</span> MIDI</h3>
  <div class="sec-body" id="midiBody">
    <div class="midi-line"><span id="midiPort">no MIDI link</span><button class="btn sm" id="midiWebBtn" title="Talk to the pedal's USB MIDI port from this browser (Chrome/Edge)">Web MIDI</button></div>
    <div class="midi-line mono" id="midiAct">in 0 · out 0</div>
    <div id="midiFiles"></div>
    <div class="loop-in">
      <button class="btn sm" id="midiUploadBtn">Upload .mid…</button><input type="file" id="midiUploadInput" accept=".mid,.midi,.smf" hidden>
      <button class="btn sm" id="midiStopBtn">Stop</button>
      <label class="midi-loop"><input type="checkbox" id="midiLoopChk"> loop</label>
    </div>
    <div class="midi-line mono" id="midiProg"></div>
    <select id="midiCtlSel" class="midi-sel" title="Forward a MIDI controller connected to this computer to the pedal"><option value="">Forward a controller…</option></select>
    <div class="play-hint">MIDI files play into the pedal's instruments; over the Pi the Pi plays them and keeps going if this screen sleeps. Notes the pedal plays itself come back here as MIDI out.</div>
  </div>`;
  const after = $('#loopSec') || $('#device').lastElementChild;
  after.insertAdjacentElement('afterend', sec);
  sec.querySelector('h3').addEventListener('click', () => sec.classList.toggle('closed'));
  $('#midiWebBtn').addEventListener('click', midiWebEnable);
  $('#midiUploadBtn').addEventListener('click', () => $('#midiUploadInput').click());
  $('#midiUploadInput').addEventListener('change', async ev => {
    const f = ev.target.files[0]; ev.target.value = '';
    if (!f) return;
    const buf = await f.arrayBuffer();
    let parsed;
    try { parsed = parseSmf(buf); } catch (e) { consoleLog('err', `${f.name}: ${e.message}`); return; }
    const name = f.name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.(midi|smf)$/i, '.mid');
    if (midi.netHost) {
      const r = await fetch('/midi-files/' + encodeURIComponent(name), { method: 'PUT', body: buf });
      const j = await r.json().catch(() => ({}));
      consoleLog(j.ok ? 'ok' : 'err', j.ok ? `Uploaded ${name} (${j.length_s} s)` : `Upload failed: ${j.message || r.status}`);
      midiRefreshFiles();
    } else {
      // bytes kept so a song session can carry the file (NEW)
      midi.local = midi.local.filter(x => x.name !== name).concat([{ name, length: parsed.length, events: parsed.events, uses: midiUsage(parsed.events), parsed, bytes: new Uint8Array(buf) }]);
      scoreSync();
      consoleLog('ok', `${name} loaded (${parsed.length.toFixed(1)} s) — plays from this browser over Web MIDI`);
      midiPaint();
    }
  });
  $('#midiStopBtn').addEventListener('click', () => performanceTransport.run('Stopping MIDI', transportStopMidi));
  $('#midiLoopChk').addEventListener('change', ev => { midi.loop = ev.target.checked; });
  $('#midiCtlSel').addEventListener('change', ev => midiForwardController(ev.target.value));
  midiPaint();
}
function midiPaint() {
  transportPaint();
  if (!$('#midiSec')) return;
  const tr = midiTransport();
  const port = $('#midiPort');
  if (tr === 'bridge') { const c = midi.status && midi.status.connected; port.textContent = midi.ws && midi.ws.readyState === 1 ? (c ? `pedal MIDI via the Pi (${(midi.status.port || '').replace('/dev/snd/', '')})` : 'Pi bridge: pedal MIDI port not found') : "connecting to the Pi\u2019s MIDI port…"; }
  else if (tr === 'webmidi') port.textContent = `Web MIDI → ${midi.out.name}`;
  else port.textContent = link.connected ? 'MIDI: connect over the Pi, or press Web MIDI' : 'no MIDI link';
  $('#midiWebBtn').hidden = tr === 'bridge' || !navigator.requestMIDIAccess;
  const st = midi.status || {};
  const inN = tr === 'bridge' ? (st.in_events !== undefined ? st.in_events : midi.inCount) : midi.inCount;
  const outN = tr === 'bridge' ? (st.out_events !== undefined ? st.out_events : midi.outCount) : midi.outCount;
  $('#midiAct').textContent = `in ${inN} · out ${outN}${midi.last ? ' · ' + midi.last : ''}`;
  // files
  const rows = tr === 'bridge' ? midi.files : midi.local;
  const playingFile = tr === 'bridge' ? (st.playing ? st.file : '') : (midi.player ? midi.player.name : '');
  const sig = [tr, playingFile, midi.covOpen || '', midi.presetRev || 0, diagCoverageSig(),
               rows.map(f => f.name + '/' + (f.bytes || 0) + '/' + (f.mtime || 0) + '/' + (f.uses ? 1 : 0)).join(',')].join('|');
  if (sig !== midi.listSig) midiPaintRows(rows, tr, st, sig);
  midiPaintTail(tr, st);
}
function midiPaintRows(rows, tr, st, sig) {
  midi.listSig = sig;
  const box = $('#midiFiles'), keepScroll = box.scrollTop;
  box.textContent = '';
  if (!rows.length) { const e = document.createElement('div'); e.className = 'play-hint'; e.textContent = tr === 'bridge' ? 'No MIDI files on the Pi yet — upload one.' : 'Upload a .mid to play it from here.'; box.appendChild(e); }
  for (const f of rows) {
    const row = document.createElement('div'); row.className = 'looprow';
    const nm = document.createElement('span'); nm.textContent = f.name; nm.title = f.name; row.appendChild(nm);
    // GLS-DIAG: coverage is judged against the CONFIRMED running patch, and is
    // honestly "unknown" (grey ?) when nothing has been confirmed — the Studio
    // draft never stands in for what the hardware is running.
    const cov = deviceMidiCoverage(f);
    let badge = null;
    if (cov) {
      badge = document.createElement('span');
      const cls = cov.state === 'ok' ? 'ok' : cov.state === 'warn' ? 'warn' : 'unknown';
      badge.className = 'midi-cov ' + cls;
      badge.textContent = cov.state === 'ok' ? '\u2713' : cov.state === 'warn' ? '\u26a0' : '?';
      if (cov.state === 'ok') badge.title = 'The patch confirmed running on the pedal answers every note this file plays';
      else {
        badge.title = cov.state === 'warn'
          ? 'Some notes will be silent on the pedal — hover or click for which'
          : 'Studio has not confirmed what the pedal is running — hover or click for why';
        badge.setAttribute('role', 'button'); badge.tabIndex = 0;
      }
      row.appendChild(badge);
    }
    // The row's button is a stop button for as long as its file is playing — the
    // Pi reports what it is playing once a second, the browser player is ours —
    // and turns back into play when the file ends or is stopped.
    const playingThis = tr === 'bridge' ? !!(st.playing && st.file === f.name) : !!(midi.player && midi.player.name === f.name);
    const play = document.createElement('button'); play.className = 'btn sm' + (playingThis ? ' accent' : '');
    play.textContent = playingThis ? '■' : '▶'; play.title = playingThis ? 'Stop' : 'Play into the pedal';
    play.disabled = performanceTransport.busy;
    play.addEventListener('click', () => transportMidiFile(f));
    row.appendChild(play);
    if (tr === 'bridge') {
      const dl = document.createElement('a'); dl.className = 'btn sm'; dl.textContent = '⤓'; dl.href = '/midi-files/' + encodeURIComponent(f.name); dl.download = f.name; dl.title = 'Download'; row.appendChild(dl);
    }
    const rm = document.createElement('button'); rm.className = 'btn sm danger'; rm.textContent = '✕'; rm.title = 'Delete';
    rm.addEventListener('click', async () => {
      if (!confirm(`Delete ${f.name}?`)) return;
      if (tr === 'bridge') { await fetch('/midi-files/' + encodeURIComponent(f.name), { method: 'DELETE' }); midiRefreshFiles(); }
      else { midi.local = midi.local.filter(x => x !== f); midiPaint(); }
    });
    row.appendChild(rm);
    box.appendChild(row);
    if (cov && cov.state !== 'ok') {
      // The explanation is wanted once, not on every glance: it shows while the
      // warning is hovered and stays put when it is clicked (click again to fold).
      const w = document.createElement('div');
      w.className = 'midi-cov-note' + (cov.state === 'unknown' ? ' info' : ''); w.hidden = true;
      w.textContent = deviceMidiCoverageNote(cov, f); box.appendChild(w);
      let pinned = midi.covOpen === f.name;
      w.hidden = !pinned;
      badge.addEventListener('mouseenter', () => { w.hidden = false; });
      badge.addEventListener('mouseleave', () => { if (!pinned) w.hidden = true; });
      const toggle = () => { pinned = !pinned; midi.covOpen = pinned ? f.name : null; w.hidden = !pinned; badge.classList.toggle('pinned', pinned); };
      badge.addEventListener('click', toggle);
      badge.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      badge.classList.toggle('pinned', pinned);
    }
  }
  box.scrollTop = keepScroll;                       // a rebuild must not jump the list back to the top
}
function midiPaintTail(tr, st) {
  // progress
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const prog = $('#midiProg');
  if (tr === 'bridge' && st.playing) prog.textContent = `▶ ${st.file}  ${fmt(st.position_s)} / ${fmt(st.length_s)}${st.loop ? '  ⟲' : ''}`;
  else if (midi.player) prog.textContent = `▶ ${midi.player.name}  ${fmt(midi.player.pos)} / ${fmt(midi.player.length)}${midi.loop ? '  ⟲' : ''}`;
  else prog.textContent = '';
  // controllers (Web MIDI only)
  const sel = $('#midiCtlSel');
  sel.hidden = !midi.access;
  if (midi.access) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">Forward a controller…</option>';
    for (const inp of midi.access.inputs.values()) {
      if (midi.pedalIn && inp.id === midi.pedalIn.id) continue;
      const o = document.createElement('option'); o.value = inp.id; o.textContent = inp.name; sel.appendChild(o);
    }
    sel.value = cur;
  }
}

