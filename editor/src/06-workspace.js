/* ============================================================================
   7. Workspace store (localStorage)
   ========================================================================== */
const LS_KEY = 'gls.workspace.v1';
const store = {
  state: { v: 1, currentId: null, presets: [] },
  _t: null,
  load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && Array.isArray(s.presets)) this.state = s;
      }
    } catch (e) { /* first run / storage unavailable */ }
    if (!this.state.presets.length) {
      // Seed a friendly starter preset on first run.
      const p = {
        id: uid(), title: 'Ambient Starter', fileName: '01_ambient_starter.txt',
        fileNameCustom: false, mode: 'chain',
        chain: [newFxItem('AudioEffectChorus'), newFxItem('AudioEffectFreeverb')],
        instruments: [], customText: null, updated: Date.now()
      };
      this.state.presets.push(p);
      this.state.currentId = p.id;
    }
    if (!this.state.presets.some(p => p.id === this.state.currentId))
      this.state.currentId = this.state.presets[0].id;
  },
  save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.state)); }
    catch (e) { consoleLog('err', 'Could not save workspace to localStorage: ' + e.message); }
  },
  saveSoon() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.save(), 250);
  }
};
function current() { return store.state.presets.find(p => p.id === store.state.currentId); }
function ensureFileName(p) {
  if (!p.fileName) { p.fileName = sanitizeFileName(p.title); p.fileNameCustom = false; }
  return p.fileName;
}

