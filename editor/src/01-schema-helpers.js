/* ============================================================================
   2. Schema lookups & small helpers
   ========================================================================== */
const SCHEMA_BY_TYPE = Object.fromEntries(EFFECTS_SCHEMA.effects.map(e => [e.type, e]));
const MACRO_BY_ID    = Object.fromEntries(EFFECTS_SCHEMA.macros.map(m => [m.id, m]));
const KNOWN_TOKENS   = new Set([...Object.keys(EFFECTS_SCHEMA.constants), 'OR', 'XOR', 'AND', 'MODULO']);
/* Instrument macros (schema note "Editor instrument: …") live in the Instruments lane,
   not in the effect chain; midi() is the PatchScript voice-binding extension. */
const INSTRUMENT_IDS = EFFECTS_SCHEMA.macros.filter(m => /^Editor instrument:/.test(m.note || '')).map(m => m.id);
const MIDI_BINDABLE  = new Set(EFFECTS_SCHEMA.midiBindable || []);
const MIDI_BINDING   = EFFECTS_SCHEMA.midiBinding || { method: 'midi', args: [] };
const MAX_OBJECTS = (EFFECTS_SCHEMA.limits || {}).objects || 32, MAX_CONNECTIONS = (EFFECTS_SCHEMA.limits || {}).connections || 64, MAX_FILE_BYTES = 16384;
const MAX_INSTRUMENTS = 5, MAX_LOOP_BYTES = 8 * 1024 * 1024, LOOP_RATE = 44100, LOOP_NAME_MAX = 64;
const PUT_ABORT_HOLD_MS = 10500;   // the pedal abandons an interrupted upload after 10 s idle
const enc = new TextEncoder();
const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/** Format a number for PatchScript output / readouts: up to 4 decimals, trimmed. */
function fmtNum(v) {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  let s = n.toFixed(4);
  s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** Short identifier base for a type: AudioEffectFreeverb -> "freeverb". */
function baseOf(type) {
  const b = type.replace(/^Audio(Effect|Filter|Synth|Analyze)?/, '').toLowerCase();
  return b || 'obj';
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function sanitizeFileName(title) {
  let s = String(title || 'preset').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (s || 'preset') + '.txt';
}

/** Normalize text for round-trip comparison (line endings + trailing whitespace). */
function normalizeText(t) {
  return String(t).replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '') + '\n';
}

