const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const html = fs.readFileSync('editor/index.html', 'utf8');
const code = html.slice(html.indexOf('function createTransportGate('), html.indexOf('const performanceTransport ='));
const ctx = vm.createContext({}); vm.runInContext(code, ctx);
test('duplicate clicks are rejected while an acknowledgement is pending', async () => {
  let finish, count = 0;
  const gate = ctx.createTransportGate(() => {});
  const pending = gate.run('Stopping', () => { count++; return new Promise(r => finish = r); });
  assert.equal(gate.busy, true);
  assert.equal(await gate.run('Stopping', () => count++), false);
  assert.equal(count, 1); finish(); assert.equal(await pending, true);
  assert.equal(gate.busy, false); assert.equal(gate.message, '');
});
test('failed Stop remains visible and allows a deliberate retry', async () => {
  const gate = ctx.createTransportGate(() => {});
  assert.equal(await gate.run('Stopping', async () => { throw new Error('Disconnected'); }), false);
  assert.equal(gate.message, 'Disconnected'); assert.equal(gate.busy, false);
  assert.equal(await gate.run('Stopping', async () => {}), true);
});
test('timeout never claims stopped', async () => {
  const gate = ctx.createTransportGate(() => {});
  await gate.run('Stopping', async () => { throw {name:'AbortError'}; });
  assert.match(gate.message, /unconfirmed/);
});
