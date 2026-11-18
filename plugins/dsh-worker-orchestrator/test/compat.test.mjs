import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

process.env.DSH_ORCH_DIR = 'Z:/dsh-orch-test'
process.env.DSH_ORCH_CTL = '0'
const original = Object.fromEntries(['appendFileSync', 'existsSync', 'mkdirSync', 'readFileSync', 'writeFileSync'].map(k => [k, fs[k]]))
const orch = p => typeof p === 'string' && p.replaceAll('\\', '/').startsWith('Z:/dsh-orch-test')
let logs = [], files = new Map(), runtimeVersion
fs.appendFileSync = (p, data, opts, ...rest) => {
  if (!orch(p)) return original.appendFileSync(p, data, opts, ...rest)
  if (String(p).endsWith('plugin.log')) logs.push(String(data))
  else if (opts?.flag === 'w') files.set(String(p).replaceAll('\\', '/'), String(data))
}
fs.existsSync = p => orch(p) ? true : original.existsSync(p)
fs.mkdirSync = (p, ...a) => orch(p) ? undefined : original.mkdirSync(p, ...a)
fs.readFileSync = (p, ...a) => {
  if (String(p).replaceAll('\\', '/').includes('compat-runtime/node_modules/@deepseek-ai/dsh/package.json')) {
    if (runtimeVersion) return JSON.stringify({ version: runtimeVersion })
    throw new Error('missing')
  }
  if (orch(p)) {
    const value = files.get(String(p).replaceAll('\\', '/'))
    if (value === undefined) throw new Error('missing')
    return value
  }
  return original.readFileSync(p, ...a)
}
fs.writeFileSync = (p, data, ...a) => orch(p) ? files.set(String(p).replaceAll('\\', '/'), String(data)) : original.writeFileSync(p, data, ...a)
syncBuiltinESMExports()
process.argv.push('compat-runtime')
const realTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 5000 ? 10 : ms, ...args)
const { apply } = await import('../index.mjs')
const sleep = ms => new Promise(resolve => realTimeout(resolve, ms))
const reset = (version, previous) => {
  logs = []; files = new Map(); runtimeVersion = version
  if (previous) files.set('Z:/dsh-orch-test/host.json', JSON.stringify({ version: previous }))
}
const makeApp = ({ noCreate = false, noFollowup = false, noRestrict = false, noMeter = false, delayed = false, badInbox = false } = {}) => {
  const defs = new Map(), handlers = new Map(), agents = new Map(), messages = [], disposed = []
  let injection, meter = !noMeter, onFollowup = () => {}
  agents.set('owner', { steer: m => messages.push(m.content[0].text) })
  const service = {
    get: id => agents.get(id),
    create: async ({ sessionId }) => {
      let resolve
      const agent = {
        status: 'idle', session: { header: { id: sessionId } },
        inbox: { hasPending: false, remove() {} }, steer() {}, cancel() {},
        whenIdle: () => new Promise(r => { resolve = r }),
        ctx: { tools: noRestrict ? {} : { restrict() {} } },
      }
      if (badInbox) Object.defineProperty(agent.inbox, 'hasPending', { get() { throw new Error('broken getter') } })
      if (!noFollowup) agent.followup = () => { agent.status = 'running'; onFollowup(sessionId) }
      agent.end = () => { agent.status = 'idle'; resolve?.() }
      agents.set(sessionId, agent)
      return { agent, dispose: async () => { disposed.push(sessionId); agents.delete(sessionId) } }
    },
  }
  service.resume = async ({ resumeSessionId }) => service.create({ sessionId: resumeSessionId })
  if (noCreate) delete service.create
  const ctx = { ...(delayed ? { inject: (_names, fn) => { injection = fn } } : { agents: service }), tools: { register: def => defs.set(def.name, def) }, on: (name, fn) => handlers.set(name, fn), get: name => name === 'tokenMeter' && meter ? { contextPressure() {} } : undefined }
  apply(ctx)
  const call = (name, args = {}, exec = { agent: { session: { header: { id: 'owner' } } } }) => defs.get(name).execute(args, exec)
  const spawn = () => call('worker_spawn', { provider: 'p', model: 'm', verify: false })
  const render = (name, value) => defs.get(name).output.render({}, JSON.parse(JSON.stringify(value))).map(x => x.text).join('')
  const end = (id, emit) => { if (emit) handlers.get('session/event')({ header: { id } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }); agents.get(id).end() }
  return { call, spawn, render, end, messages, disposed, inject: () => injection({ agents: service }), enableMeter: () => { meter = true }, onFollowup: fn => { onFollowup = fn }, emit: (id) => handlers.get('session/event')({ header: { id } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }) }
}
const results = []
const scenario = async (name, fn) => { try { await fn(); results.push('PASS ' + name) } catch (e) { results.push('FAIL ' + name + ': ' + e.stack) } }

await scenario('all seams and event present', async () => {
  reset('2.0', '2.0'); const app = makeApp(); const worker = await app.spawn()
  await app.call('worker_dispatch', { worker_id: worker.worker_id, prompt: 'x' }); app.end(worker.worker_id, true)
  assert.ok(logs.some(s => s.includes('compat required session-event turn/end ok')))
  assert.ok(!logs.some(s => /compat (required .* FAIL|optional .* off)/.test(s)))
  assert.ok(!app.render('worker_spawn', worker).includes('[호환 점검]'))
})
await scenario('missing service create rejects', async () => {
  reset(); const app = makeApp({ noCreate: true })
  await assert.rejects(app.spawn(), /\[호환\].*agents.create/)
})
await scenario('missing followup disposes', async () => {
  reset(); const app = makeApp({ noFollowup: true })
  await assert.rejects(app.spawn(), /\[호환\].*agent.followup/); assert.equal(app.disposed.length, 1)
})
await scenario('isolation warning once per owner', async () => {
  reset(); const app = makeApp({ noRestrict: true }); const first = await app.spawn(); const second = await app.spawn()
  assert.equal(first.isolation, 'off'); assert.match(first.warning, /\[호환\]/); assert.equal(second.warning, undefined); assert.equal(second.isolation, 'off')
})
await scenario('missing meter shown in status', async () => {
  reset(); const app = makeApp({ noMeter: true }); await app.spawn()
  app.emit('owner'); await sleep(1)
  assert.ok(logs.some(s => s.includes('compat optional tokenMeter.contextPressure off 교대 알림')))
  assert.ok((await app.call('worker_status')).host.off.includes('교대 알림'))
})
await scenario('version changed, unchanged and unknown', async () => {
  reset('2.0', '1.0'); let app = makeApp(); let value = await app.call('worker_status')
  assert.match(app.render('worker_status', value), /\[호환 점검\] DSH 1.0 → 2.0/)
  assert.match(value.compat_notice, /\[호환 점검\] DSH 1.0 → 2.0/)
  assert.doesNotMatch(app.render('worker_status', await app.call('worker_status')), /\[호환 점검\]/)
  assert.equal(JSON.parse(files.get('Z:/dsh-orch-test/host.json')).version, '2.0')
  reset('2.0', '2.0'); app = makeApp(); assert.doesNotMatch(app.render('worker_status', await app.call('worker_status')), /\[호환 점검\]/)
  reset(); app = makeApp(); assert.equal((await app.call('worker_status')).host.version, 'unknown')
})
await scenario('missing turn event alerts and blocks; received event passes', async () => {
  reset(); let app = makeApp(); let worker = await app.spawn()
  await app.call('worker_dispatch', { worker_id: worker.worker_id, prompt: 'x' }); app.end(worker.worker_id, false); await sleep(40)
  assert.ok(logs.some(s => s.includes('compat required session-event turn/end FAIL')))
  assert.equal(app.messages.filter(s => s.includes('[호환]')).length, 1)
  assert.equal((await app.call('worker_status')).host.ok, false)
  await assert.rejects(app.spawn(), /\[호환\].*session-event turn\/end/)
  reset(); app = makeApp(); worker = await app.spawn()
  await app.call('worker_dispatch', { worker_id: worker.worker_id, prompt: 'x' }); app.end(worker.worker_id, true); await sleep(40)
  assert.ok(logs.some(s => s.includes('compat required session-event turn/end ok'))); assert.equal(app.messages.length, 0)
})
await scenario('missing caller id never reuses previous owner', async () => {
  reset(); const app = makeApp(); await app.call('worker_status')
  await assert.rejects(app.call('worker_status', {}, { agent: { session: { header: {} } } }), /호출자 세션 id/)
})
await scenario('failure permits recovery tools and another worker event recovers', async () => {
  reset(); const app = makeApp(); const a = await app.spawn(), b = await app.spawn(), c = await app.spawn(), d = await app.spawn()
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'x' }); app.end(a.worker_id, false); await sleep(40)
  const status = await app.call('worker_status'); assert.equal(status.host.ok, false); assert.ok(status.host.failed.includes('session-event turn/end'))
  await assert.rejects(app.spawn(), /새 일꾼·새 지시/)
  await assert.rejects(app.call('worker_dispatch', { worker_id: b.worker_id, prompt: 'x' }), /\[호환\]/)
  await app.call('worker_result', { worker_id: a.worker_id }); await app.call('worker_reports'); await app.call('worker_finish', { worker_id: b.worker_id }); await app.call('worker_cancel', { worker_id: c.worker_id })
  app.emit(d.worker_id); assert.ok(logs.some(s => s.includes('session-event turn/end ok (recovered)')))
  assert.equal((await app.call('worker_status')).host.ok, true); await app.spawn()
})
await scenario('cancelled canary defers check and next dispatch is watched', async () => {
  reset(); const app = makeApp(); const a = await app.spawn(), b = await app.spawn()
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'x' }); app.end(a.worker_id, false)
  await app.call('worker_cancel', { worker_id: a.worker_id }); await sleep(40)
  assert.ok(!logs.some(s => s.includes('session-event turn/end FAIL')))
  await app.call('worker_dispatch', { worker_id: b.worker_id, prompt: 'x' }); app.end(b.worker_id, true)
  assert.ok(logs.some(s => s.includes('session-event turn/end ok')))
})
await scenario('late service and meter are pending then checked', async () => {
  reset(); const app = makeApp({ delayed: true, noMeter: true })
  assert.ok(logs.some(s => s.includes('compat required agents.create pending')))
  assert.ok(!logs.some(s => /compat required agents\.(create|get) FAIL/.test(s)))
  assert.equal(files.has('Z:/dsh-orch-test/host.json'), false)
  app.inject(); app.enableMeter(); app.emit('owner'); await sleep(1)
  assert.ok(logs.some(s => s.includes('compat required agents.create ok')))
  assert.ok(!(await app.call('worker_status')).host.off.includes('교대 알림'))
  assert.ok(logs.some(s => s.includes('compat optional tokenMeter.contextPressure ok')))
})
await scenario('unconsumed version notice survives restart', async () => {
  reset('2.0', '1.0'); makeApp()
  assert.equal(JSON.parse(files.get('Z:/dsh-orch-test/host.json')).version, '1.0')
  const app = makeApp(); assert.match((await app.call('worker_status')).compat_notice, /1.0 → 2.0/)
})
await scenario('unknown version does not erase known version', async () => {
  reset(undefined, '1.0'); const app = makeApp(); await app.call('worker_status')
  assert.equal(JSON.parse(files.get('Z:/dsh-orch-test/host.json')).version, '1.0')
})
await scenario('first resume checks worker instance', async () => {
  reset(); files.set('Z:/dsh-orch-test/workers.json', JSON.stringify({ saved: { owner: 'owner', role: 'worker' } }))
  const app = makeApp(); await app.call('worker_resume', { worker_id: 'saved' })
  assert.ok(logs.some(s => s.includes('compat required agent.followup ok')))
  assert.ok(logs.some(s => s.includes('compat optional agents.resume ok')))
})
await scenario('verifier reports missing isolation', async () => {
  reset(); const app = makeApp({ noRestrict: true })
  app.onFollowup(id => realTimeout(() => app.end(id, true), 5))
  const result = await app.call('worker_verify', { claim: 'test' })
  assert.equal(result.isolation, 'off'); assert.match(result.warning, /\[호환\]/)
  const worker = await app.spawn(); assert.equal(worker.warning, undefined)
})
await scenario('instance getter failure disposes handle', async () => {
  reset(); const app = makeApp({ badInbox: true })
  await assert.rejects(app.spawn(), /\[호환\].*agent.instance/); assert.equal(app.disposed.length, 1)
})
await scenario('service still pending at first call becomes failure', async () => {
  reset(); const app = makeApp({ delayed: true })
  await assert.rejects(app.spawn(), /\[호환\].*agents.create/)
  assert.ok(logs.some(s => s.includes('compat required agents.create FAIL')))
})
for (const result of results) console.log(result)
if (results.some(r => r.startsWith('FAIL'))) process.exitCode = 1
