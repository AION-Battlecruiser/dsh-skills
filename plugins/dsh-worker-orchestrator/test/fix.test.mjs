// The fs isolation below only works on Node. Under Bun the plugin's own fs imports
// stay real, so these fake workers would be written into the real state folder.
if (process.versions.bun) throw new Error('Run with node (npm test): this test must not run under Bun.')

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

// Isolate the plugin's log, registry and control directory, as caps.test.mjs does.
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
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms))

// Fake agent service: one handle per session, controllable status, optional creation gate.
const makeCtx = () => {
  const defs = new Map(), handlers = new Map(), agents = new Map()
  let gate
  const ctx = {
    tools: { register: d => defs.set(d.name, d) },
    on: (name, fn) => handlers.set(name, fn),
    agents: {
      create: async ({ sessionId }) => {
        if (gate) await gate.promise
        const agent = { status: 'idle', followup: async () => {}, whenIdle: () => new Promise(() => {}), steer: () => {} }
        agents.set(sessionId, agent)
        return { agent }
      },
      get: (id) => agents.get(id),
    },
  }
  apply(ctx)
  const as = (owner) => ({ agent: { session: { header: { id: owner } } } })
  return {
    agents, defs,
    hold: () => { gate = Promise.withResolvers() },
    release: () => { gate.resolve(); gate = undefined },
    call: (name, args, owner = 'owner') => defs.get(name).execute(args, as(owner)),
    emit: (id, data) => handlers.get('session/event')({ header: { id } }, data),
  }
}
const ctl = async (code) => { output = undefined; command = { id: 'test', code }; for (let i = 0; i < 30 && !output; i++) await tick(50); assert.equal(output?.ok, true, JSON.stringify(output)); return output.value }

// 1. An agent-less load (seen live: no tools.view, no inject) must not claim control commands.
apply({ tools: { register() {} }, on() {} })
command = { id: 'test', code: 'return 1' }
await tick(600)
assert.equal(output, undefined); assert.ok(command, 'command still unclaimed')
const main = makeCtx()
for (let i = 0; i < 30 && !output; i++) await tick(50)
assert.deepEqual([output?.ok, output?.value], [true, 1])
console.log('ctl: agent-less instance leaves commands to the live one')

// 2. turn/end of one turn while the agent keeps running: auto-finish waits for the real end.
const a = (await main.call('worker_spawn', { provider: 'p', model: 'm', verify: false, auto_finish: true })).worker_id
await main.call('worker_dispatch', { worker_id: a, prompt: 'x' })
main.agents.get(a).status = 'running'
main.emit(a, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
await tick(1400)
assert.deepEqual(await ctl('const w = workers.get(' + JSON.stringify(a) + '); return [w?.finished, w?.status]'), [false, 'running'])
// The follow-on turn may end without a turn/end (aborted right after turn/start): the timer re-checks.
main.agents.get(a).status = 'idle'
await tick(1400)
assert.equal(await ctl('return workers.has(' + JSON.stringify(a) + ')'), false)
console.log('auto-finish: deferred while the agent runs, finished once idle even without another turn/end')

// 3. A turn that ends in error with no text still reaches the coordinator.
const b = (await main.call('worker_spawn', { provider: 'p', model: 'm', verify: false })).worker_id
await main.call('worker_dispatch', { worker_id: b, prompt: 'first' })
main.emit(b, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'old result' }] } } })
main.emit(b, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
await main.call('worker_reports', { clear: true })
await main.call('worker_dispatch', { worker_id: b, prompt: 'second' })
main.emit(b, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'LLM 503' } } } })
const queued = await main.call('worker_reports', { clear: false })
const mine = queued.reports.find(r => r.worker_id === b)
assert.ok(mine, 'error turn produced a report')
assert.equal(mine.text, '[턴 오류 종료: LLM 503]', 'no stale text from the previous dispatch')
console.log('error turn: reported with its cause, without the previous dispatch output')

// 4. Re-adopting a live agent that is mid-turn keeps it counted as running.
await ctl('workers.delete(' + JSON.stringify(b) + '); return true')
main.agents.get(b).status = 'running'
assert.equal((await main.call('worker_resume', { worker_id: b })).status, 'running')
console.log('resume: live running agent adopted as running')

// 5. The global cap counts spawns still being created, across owners.
const fresh = makeCtx()
fresh.hold()
const attempts = [...Array(5)].map(() => fresh.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A'))
  .concat([...Array(5)].map(() => fresh.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'B')))
const all = Promise.allSettled(attempts)
await tick()
fresh.release()
const settled = await all
const ok = settled.filter(s => s.status === 'fulfilled').length
assert.equal(ok, 8, 'eight slots in total')
assert.ok(settled.filter(s => s.status === 'rejected').every(s => /worker limit reached \(8, .*worker_finish/.test(s.reason.message)))
console.log('global cap: 10 concurrent spawns from 2 owners -> 8 created, 2 refused')

// 6. A spawn never creates a verifier (11-18): worker_verify makes one when a claim needs it.
const trio = makeCtx()
const spawned = await Promise.all([...Array(3)].map(() => trio.call('worker_spawn', { provider: 'p', model: 'm', verify: false })))
assert.equal(trio.agents.size, 3); assert.ok(spawned.every(s => s.verifier_id === undefined))
console.log('verifier: 3 concurrent spawns -> 0 verifiers')
process.exit(0)
