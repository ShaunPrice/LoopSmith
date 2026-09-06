/* ============================================================================
   8. Console drawer (defined early so everything can log to it)
   ========================================================================== */
const consoleState = { entries: [], open: false };
function consoleLog(kind, text) {
  const e = { ts: new Date(), kind, text: String(text) };
  consoleState.entries.push(e);
  if (consoleState.entries.length > 500) consoleState.entries.splice(0, consoleState.entries.length - 500);
  if (typeof document !== 'undefined') appendConsoleLine(e);
}
function appendConsoleLine(e) {
  const log = document.getElementById('consoleLog');
  const cnt = document.getElementById('consoleCount');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'cl ' + e.kind;
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = e.ts.toTimeString().slice(0, 8) + '.' + String(e.ts.getMilliseconds()).padStart(3, '0');
  div.appendChild(ts);
  div.appendChild(document.createTextNode(e.text));
  log.appendChild(div);
  while (log.children.length > 500) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
  if (cnt) cnt.textContent = consoleState.entries.length + ' lines';
}

