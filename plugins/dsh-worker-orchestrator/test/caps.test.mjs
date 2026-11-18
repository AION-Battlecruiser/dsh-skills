import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const source = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
const policy = (name, fn) => new Function(source.match(new RegExp('// #region ' + name + '[\\s\\S]*?// #endregion'))[0] + '\nreturn ' + fn)()
const cap = policy('call-cap-policy', 'callCapDecision')
const concurrency = policy('concurrency-policy', 'concurrencyDecision')
const event = (n = 1) => ({ type: 'assistant/message', data: { message: { content: Array.from({ length: n }, () => ({ type: 'tool-call', name: 'run_code' })) } } })
for (const [role, count, n, expected] of [['worker', 5, 1, [6]], ['worker', 6, 5, []], ['worker', 11, 2, [12]], ['worker', 0, 12, [6, 12]], ['verifier', 5, 1, [6]]]) {
  assert.deepEqual(cap({ role, count, maxCalls: 6, event: event(n) }).notices, expected)
}
// An interrupted message is stored but its tool calls never ran: not counted.
const interrupted = { ...event(3), data: { ...event(3).data, interrupted: true } }
assert.deepEqual(cap({ role: 'worker', count: 5, maxCalls: 6, event: interrupted }), { count: 5, notices: [] })
for (const [slots, running, target, fullSlots, fullRunning] of [[7, 3, 'x', false, false], [8, 4, 'x', true, true], [8, 4, '0', true, false]]) {
  const workers = Array.from({ length: slots }, (_, i) => ({ id: String(i), owner: 'o', role: 'worker', status: i < running ? 'running' : 'idle' }))
  workers.push({ id: 'v', owner: 'o', role: 'verifier', status: 'running' }, { id: 'other', owner: 'other', role: 'worker', status: 'running' })
  assert.deepEqual(concurrency({ workers, owner: 'o', targetId: target }), { slotsFull: fullSlots, runningFull: fullRunning })
}
console.log('policies: 8 cases passed')
assert.equal(concurrency({ workers: Array.from({ length: 7 }, () => ({ owner: 'o', role: 'worker' })), owner: 'o', pending: 1 }).slotsFull, true)

// Plugin state goes to DSH_ORCH_DIR; a fake drive keeps every real path untouched.
process.env.DSH_ORCH_DIR = 'Z:/dsh-orch-test'
process.env.DSH_ORCH_CTL = '1'
const orch = (p) => typeof p === 'string' && p.replaceAll('\\', '/').startsWith('Z:/dsh-orch-test')
const original = Object.fromEntries(['appendFileSync', 'existsSync', 'mkdirSync', 'readFileSync', 'readdirSync', 'renameSync', 'unlinkSync', 'writeFileSync'].map(k => [k, fs[k]]))
let command, output
fs.appendFileSync = (p, ...a) => orch(p) ? undefined : original.appendFileSync(p, ...a)
fs.existsSync = (p) => orch(p) ? true : original.existsSync(p)
fs.mkdirSync = (p, ...a) => orch(p) ? undefined : original.mkdirSync(p, ...a)
fs.readFileSync = (p, ...a) => orch(p) ? (String(p).endsWith('workers.json') ? '{}' : JSON.stringify(command)) : original.readFileSync(p, ...a)
fs.readdirSync = (p, ...a) => orch(p) ? (command ? ['test.json'] : []) : original.readdirSync(p, ...a)
fs.renameSync = (p, ...a) => orch(p) ? undefined : original.renameSync(p, ...a)
fs.unlinkSync = (p, ...a) => orch(p) ? undefined : original.unlinkSync(p, ...a)
fs.writeFileSync = (p, data, ...a) => { if (orch(p)) { output = JSON.parse(data); command = undefined; return } return original.writeFileSync(p, data, ...a) }
syncBuiltinESMExports()
const { apply } = await import('../index.mjs')
const defs = new Map(), sent = [], handlers = new Map()
// Mirror dsh-session commit(): observers run while the session is appending, and
// steer() appends to that same session, so a synchronous steer from the observer throws.
let appending = false, failNext = 0
const handle = { agent: { followup: async () => {}, whenIdle: () => new Promise(() => {}), steer: (message) => {
  if (appending) throw new Error('session append cannot reenter while another append is being published')
  if (failNext > 0) { failNext -= 1; throw new Error('transient') }
  sent.push(message.content[0].text)
} } }
const ctx = { tools: { register: d => defs.set(d.name, d) }, on: (name, fn) => handlers.set(name, fn), agents: { create: async () => handle, get: () => handle.agent } }
apply(ctx)
const exec = { agent: { session: { header: { id: 'owner' } } } }
const call = (name, args) => defs.get(name).execute(args, exec)
const ctl = async (code) => { output = undefined; command = { id: 'test', code }; for (let i = 0; i < 30 && !output; i++) await new Promise(r => setTimeout(r, 50)); assert.equal(output?.ok, true); return output.value }
const id = (await call('worker_spawn', { provider: 'p', model: 'm', verify: false })).worker_id
await call('worker_dispatch', { worker_id: id, prompt: 'test' })
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms))
const emit = async (who, data = event()) => {
  appending = true
  try { handlers.get('session/event')({ header: { id: who } }, data) } finally { appending = false }
  await tick()
}
for (let i = 1; i <= 13; i++) { await emit(id); assert.equal(sent.length, i < 6 ? 0 : i < 12 ? 1 : 2) }
assert.match(sent[0], /^\[호출 상한\] run_code 6회/); assert.match(sent[1], /^\[호출 상한 2차\] run_code 12회/)
await ctl("workers.get(" + JSON.stringify(id) + ").status = 'idle'; return true") // the turn ended: a running worker refuses dispatch
await call('worker_dispatch', { worker_id: id, prompt: 'again' })
for (let i = 0; i < 6; i++) await emit(id)
assert.equal(sent.length, 3)
console.log('events: 6th/12th notices delivered after the reentrant commit, no extras, reset (verifier cap: policy cases)')
// No retry (steer may fail after enqueueing, a retry would duplicate); a worker no longer running is not woken.
await ctl("workers.get(" + JSON.stringify(id) + ").status = 'idle'; return true") // the turn ended: a running worker refuses dispatch
await call('worker_dispatch', { worker_id: id, prompt: 'fail once' })
failNext = 1
for (let i = 0; i < 6; i++) await emit(id)
await tick(300)
assert.equal(sent.length, 3); assert.equal(failNext, 0)
await ctl("workers.get(" + JSON.stringify(id) + ").status = 'idle'; return true") // the turn ended: a running worker refuses dispatch
await call('worker_dispatch', { worker_id: id, prompt: 'idle' })
await ctl("workers.get(" + JSON.stringify(id) + ").status = 'idle'; return true")
for (let i = 0; i < 6; i++) await emit(id)
assert.equal(sent.length, 3)
console.log('delivery: one attempt only, idle worker skipped')
await ctl("const w = [...workers.values()].find(x => x.role === 'worker'); for (let i = 1; i < 8; i++) workers.set('w'+i, { ...w, id: 'w'+i, status: 'idle' }); return true")
await assert.rejects(call('worker_spawn', { provider: 'p', model: 'm', verify: false }), /슬롯 8 초과: idle 워커를 결과 회수 후 worker_finish 한 뒤 spawn/)
await ctl("let i = 0; for (const w of workers.values()) if (w.role === 'worker') w.status = i++ < 4 ? 'running' : 'idle'; return true")
await assert.rejects(call('worker_dispatch', { worker_id: 'w4', prompt: 'test' }), /동시 실행 상한 4: 진행 중 일꾼이 끝난 뒤 dispatch/)
for (const invalid of [0, 51, 1.5, null]) await assert.rejects(call('worker_dispatch', { worker_id: id, prompt: 'test', max_calls: invalid }))
console.log('limits: ninth spawn and fifth dispatch rejected; invalid max_calls rejected (verifier dispatch refusal: fix2 Y8)')
