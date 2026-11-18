import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

// Isolate every plugin path under DSH_ORCH_DIR. Unlike caps/fix tests, registry
// writes and log lines are captured separately (a registry save is not ctl output).
// Plugin state goes to DSH_ORCH_DIR; a fake drive keeps every real path untouched.
process.env.DSH_ORCH_DIR = 'Z:/dsh-orch-test'
process.env.DSH_ORCH_CTL = '1'
const orch = (p) => typeof p === 'string' && p.replaceAll('\\', '/').startsWith('Z:/dsh-orch-test')
const original = Object.fromEntries(['appendFileSync', 'existsSync', 'mkdirSync', 'readFileSync', 'readdirSync', 'renameSync', 'unlinkSync', 'writeFileSync'].map(k => [k, fs[k]]))
const logs = []
let registrySeed = '{}', lastRegistry
fs.appendFileSync = (p, data, ...a) => { if (!orch(p)) return original.appendFileSync(p, data, ...a); if (String(p).endsWith('plugin.log')) logs.push(String(data).trim().replace(/^\S+ /, '')) }
fs.existsSync = (p) => orch(p) ? true : original.existsSync(p)
fs.mkdirSync = (p, ...a) => orch(p) ? undefined : original.mkdirSync(p, ...a)
fs.readFileSync = (p, ...a) => orch(p) ? (String(p).endsWith('workers.json') ? registrySeed : 'null') : original.readFileSync(p, ...a)
fs.readdirSync = (p, ...a) => orch(p) ? [] : original.readdirSync(p, ...a)
fs.renameSync = (p, ...a) => orch(p) ? undefined : original.renameSync(p, ...a)
fs.unlinkSync = (p, ...a) => orch(p) ? undefined : original.unlinkSync(p, ...a)
fs.writeFileSync = (p, data, ...a) => { if (!orch(p)) return original.writeFileSync(p, data, ...a); if (String(p).endsWith('workers.json')) lastRegistry = JSON.parse(data) }
syncBuiltinESMExports()
const { apply } = await import('../index.mjs')
// The TTL reaper runs on a 60 s interval: keep its callback so a test can fire it.
const reapers = []
const realSetInterval = globalThis.setInterval
globalThis.setInterval = (fn, ms, ...a) => { if (ms === 60000) reapers.push(fn); return realSetInterval(fn, ms, ...a) }
const source = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms))
const CAUSES = ['user', 'parent', 'disposed', 'hook']

// Fake app shaped after dsh-agent-loop: cancel takes an AgentCancelCause object,
// a disposed session refuses appends, followup on a running agent queues input,
// restrict rejects the whole call when one name is unknown.
const makeApp = ({ guiMissing = false, noRestrict = false } = {}) => {
  const app = { defs: new Map(), handlers: new Map(), agents: new Map(), steers: [], restricts: [], creates: 0, gateNth: 0, gate: undefined, createFail: () => false, onFollowup: () => {}, restrictFails: () => false, disposed: [], cwds: new Map() }
  const makeAgent = (id) => {
    const agent = {
      id, status: 'idle', pending: [], removed: [], causes: [], disposed: false,
      inbox: { get hasPending() { return agent.pending.length > 0 }, remove(mid) { agent.removed.push(mid); const i = agent.pending.findIndex(m => m.id === mid); if (i < 0) return false; agent.pending.splice(i, 1); return true } },
      followup(message) {
        if (agent.disposed) throw new Error('session "' + id + '" cannot append outside a SessionStore')
        if (agent.status === 'running') agent.pending.push(message); else agent.status = 'running'
        app.onFollowup(id, message)
      },
      steer(message) {
        if (agent.disposed) throw new Error('cannot append outside a SessionStore')
        app.steers.push({ id, text: message.content[0].text, mid: message.id })
      },
      cancel(cause) {
        if (cause === null || typeof cause !== 'object' || !CAUSES.includes(cause.kind)) throw new Error('unreachable variant: ' + JSON.stringify(cause))
        agent.causes.push(cause); agent.status = 'idle'; agent.resolveIdle?.()
      },
      whenIdle() { return agent.idle ??= new Promise(r => { agent.resolveIdle = () => { agent.idle = undefined; agent.resolveIdle = undefined; r() } }) },
      ctx: { tools: noRestrict ? {} : { restrict(opts) {
        if (guiMissing && opts.deny.some(n => n.startsWith('gui_'))) throw new Error('unknown tool name')
        if (opts.deny.some(n => app.restrictFails(n))) throw new Error('unknown tool name')
        app.restricts.push({ id, deny: opts.deny })
      } } },
    }
    return agent
  }
  const handleOf = (agent) => ({ agent, dispose: async () => { agent.disposed = true; app.disposed.push(agent.id); app.agents.delete(agent.id) } })
  const ctx = {
    get: (key) => key === 'tokenMeter' ? { contextPressure: async () => ({ pressureTokens: app.pressure }) } : undefined,
    tools: { register: d => app.defs.set(d.name, d) },
    on: (name, fn) => app.handlers.set(name, fn),
    agents: {
      create: async ({ sessionId, meta }) => {
        app.cwds.set(sessionId, meta?.cwd)
        const n = ++app.creates
        if (n === app.gateNth) await app.gate.promise
        if (app.createFail(n)) throw new Error('provider unavailable')
        const agent = makeAgent(sessionId); app.agents.set(sessionId, agent); return handleOf(agent)
      },
      get: (id) => app.agents.get(id),
      resume: async ({ resumeSessionId }) => { const agent = makeAgent(resumeSessionId); app.agents.set(resumeSessionId, agent); return handleOf(agent) },
    },
  }
  apply(ctx)
  app.reap = reapers.at(-1)
  app.makeAgent = makeAgent
  app.hold =(nth) => { app.gateNth = app.creates + nth; app.gate = Promise.withResolvers() }
  app.release = () => app.gate.resolve()
  app.call = (name, args, owner = 'A') => app.defs.get(name).execute(args, { agent: { session: { header: { id: owner } } } })
  app.emit = (id, data) => app.handlers.get('session/event')({ header: { id } }, data)
  // One turn: optional text and run_code calls, then turn/end; the agent goes idle
  // unless input is still queued (then the next queued message starts a new turn).
  app.endTurn = (id, { text, calls = 0, reason = { kind: 'completed' } } = {}) => {
    const content = [...(text ? [{ type: 'text', text }] : []), ...Array.from({ length: calls }, () => ({ type: 'tool-call', name: 'run_code' }))]
    if (content.length > 0) app.emit(id, { type: 'assistant/message', data: { message: { content } } })
    const agent = app.agents.get(id)
    app.emit(id, { type: 'turn/end', data: { reason } })
    if (agent === undefined) return
    if (agent.pending.length > 0 && !['aborted', 'error', 'blocked'].includes(reason.kind)) { agent.pending.shift(); return }
    agent.status = 'idle'; agent.resolveIdle?.()
  }
  app.reports = async (owner = 'A') => (await app.call('worker_reports', { clear: true }, owner)).reports.map(r => r.text)
  return app
}
const answerVerifier = (app, text) => { app.onFollowup = (id) => { const w = app.agents.get(id); if (w) setTimeout(() => app.endTurn(id, typeof text === 'function' ? text() : text), 5) } }
const results = []
const scenario = async (name, fn) => { try { await fn(); results.push('PASS ' + name) } catch (e) { results.push('FAIL ' + name + ': ' + String(e.message).split('\n')[0].slice(0, 160)) } }

await scenario('A1 a spawn attaches no verifier; each coordinator gets its own on first verify', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  const b = await app.call('worker_spawn', { provider: 'p', model: 'm2', verify: false, allow_model_repeat: true }, 'B')
  assert.equal(a.verifier_id, undefined); assert.equal(b.verifier_id, undefined)
  assert.equal(app.creates, 2, 'two producers, no verifier')
  answerVerifier(app, { text: 'VERDICT: PASS' })
  const va = await app.call('worker_verify', { claim: 'x' }, 'A')
  answerVerifier(app, { text: 'VERDICT: FAIL' })
  const vb = await app.call('worker_verify', { claim: 'x' }, 'B')
  assert.equal(va.verdict, 'PASS'); assert.equal(vb.verdict, 'FAIL'); assert.notEqual(va.verifier_id, vb.verifier_id)
})

await scenario('A2 verifier owner fixed before await (another session calls during its creation)', async () => {
  const app = makeApp()
  await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  app.hold(1) // the next create = A's verifier, made by worker_verify
  answerVerifier(app, { text: 'VERDICT: PASS' })
  const pV = app.call('worker_verify', { claim: 'x' }, 'A')
  for (let i = 0; i < 20 && app.creates < 2; i++) await tick()
  await app.call('worker_status', {}, 'B')
  app.release()
  const v = await pV
  assert.equal(v.verdict, 'PASS')
  assert.ok(!(await app.call('worker_status', {}, 'B')).workers.some(w => w.worker_id === v.verifier_id))
})

await scenario('A3 readiness probe survives another session calling during spawn', async () => {
  const app = makeApp()
  app.hold(1)
  app.onFollowup = (id) => setTimeout(() => app.endTurn(id, { text: '391', calls: 1 }), 5)
  const pA = app.call('worker_spawn', { provider: 'p', model: 'm' }, 'A')
  await tick()
  await app.call('worker_status', {}, 'B')
  app.release()
  const a = await pA
  assert.equal(a.verified, true)
  assert.ok(logs.some(l => /verify worker=.* structural=null answered=true run_code=1/.test(l)), 'probe log shows run_code count')
})

await scenario('B/C cancel passes an object cause, frees the slot; a cancelled verifier is replaced', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'go' }, 'A')
  const agent = app.agents.get(a.worker_id)
  await app.call('worker_cancel', { worker_id: a.worker_id }, 'A')
  assert.deepEqual(agent.causes, [{ kind: 'user' }])
  const live = (await app.call('worker_status', {}, 'A')).workers.filter(w => w.state === 'live').map(w => w.worker_id)
  assert.ok(!live.includes(a.worker_id), 'cancelled worker left the pool')
  answerVerifier(app, { text: 'VERDICT: PASS' })
  const v0 = await app.call('worker_verify', { claim: 'x0' }, 'A')
  await app.call('worker_cancel', { worker_id: v0.verifier_id }, 'A')
  const v = await app.call('worker_verify', { claim: 'x' }, 'A')
  assert.equal(v.verdict, 'PASS'); assert.notEqual(v.verifier_id, v0.verifier_id)
})

await scenario('D waits stay under the 120 s run_code default; probe waits once', async () => {
  const wait = Number(source.match(/const WAIT_TIMEOUT_MS = (\d+)/)[1]), probeWait = Number(source.match(/const PROBE_TIMEOUT_MS = (\d+)/)[1])
  assert.ok(wait < 120000 && probeWait < 120000)
  assert.doesNotMatch(source.match(/dispatchProbe: [^\n]+/)[0], /wait: true/)
})

await scenario('E read-only and non-waiting tools are concurrency-safe', async () => {
  const app = makeApp()
  const safe = (n, args) => app.defs.get(n).isConcurrencySafe?.(args) === true
  assert.ok(safe('worker_status', {}) && safe('worker_result', {}) && safe('worker_dispatch', {}))
  assert.ok(!safe('worker_dispatch', { wait: true }) && !safe('worker_result', { wait: true }) && !safe('worker_spawn', {}) && !safe('worker_verify', {}))
})

await scenario('F all worker_* denied; per-name fallback; resume restricts again', async () => {
  const app = makeApp({ guiMissing: true })
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  const denied = new Set(app.restricts.filter(r => r.id === a.worker_id).flatMap(r => r.deny))
  for (const n of ['worker_verify', 'worker_finish', 'worker_reports', 'worker_transfer', 'worker_spawn']) assert.ok(denied.has(n), n)
  assert.ok(logs.some(l => l.startsWith('restrict partial')))
  await app.call('worker_finish', { worker_id: a.worker_id }, 'A')
  const before = app.restricts.filter(r => r.id === a.worker_id).length
  await app.call('worker_resume', { worker_id: a.worker_id }, 'A')
  assert.ok(app.restricts.filter(r => r.id === a.worker_id).length > before, 'resume restricted')
})

await scenario('G queued input continues the turn: worker stays running, cap still counts, dispatch refused meanwhile', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'T1', max_calls: 3 }, 'A')
  app.agents.get(a.worker_id).pending.push({ id: 'typed', content: [{ type: 'text', text: 'typed into the worker window' }] }) // queued
  app.endTurn(a.worker_id, { text: 'T1 done' }) // the queued input opens the next turn
  assert.equal((await app.call('worker_status', { worker_id: a.worker_id }, 'A')).status, 'running')
  app.emit(a.worker_id, { type: 'assistant/message', data: { message: { content: Array.from({ length: 3 }, () => ({ type: 'tool-call', name: 'run_code' })) } } })
  await tick(20)
  assert.ok(app.steers.some(s => s.id === a.worker_id && /run_code 3회/.test(s.text)))
  assert.deepEqual(await app.reports(), [], 'no premature report while the next turn runs')
  await assert.rejects(app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'T2' }, 'A'), /is running: dispatch after its report arrives/)
})

await scenario('H no stale report on finish or on a silent turn', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'job1' }, 'A')
  app.endTurn(a.worker_id, { text: 'OLD OUTPUT job1' })
  assert.deepEqual(await app.reports(), ['OLD OUTPUT job1'])
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'job2' }, 'A')
  app.endTurn(a.worker_id, { calls: 1 })
  assert.deepEqual(await app.reports(), ['[턴 종료(completed): 이번 지시의 출력 없음]'])
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'job3' }, 'A')
  await app.call('worker_finish', { worker_id: a.worker_id }, 'A')
  assert.deepEqual(await app.reports(), [])
  assert.equal((await app.call('worker_result', { worker_id: a.worker_id }, 'A')).text, '')
})

await scenario('I verdict = last exact line of this dispatch; error turn = UNKNOWN', async () => {
  const app = makeApp()
  await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  let n = 0 // a distinct claim each time: the same claim is not re-verified
  const v = async (answer) => { answerVerifier(app, answer); return (await app.call('worker_verify', { claim: 'x' + n++ }, 'A')).verdict }
  assert.equal(await v({ text: 'VERDICT: PASS' }), 'PASS')
  assert.equal(await v({}), 'UNKNOWN') // silent turn: the earlier PASS must not stand
  assert.equal(await v({ text: '형식 VERDICT: PASS|FAIL|UNKNOWN 에 따라 검토\nVERDICT: FAIL' }), 'FAIL')
  assert.equal(await v({ text: 'VERDICT: PASSIVE 하게는 못 봄' }), 'UNKNOWN')
  assert.equal(await v({ text: '**VERDICT:** PASS' }), 'PASS')
  assert.equal(await v({ text: 'VERDICT: PASS', reason: { kind: 'error', error: { message: 'LLM 503' } } }), 'UNKNOWN')
})

await scenario('J a spawn creates no verifier; a verifier creation failure fails only worker_verify', async () => {
  const app = makeApp()
  app.createFail = (n) => n === 2
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  assert.equal(app.creates, 1)
  await assert.rejects(app.call('worker_verify', { claim: 'x' }, 'A'), /provider unavailable/)
  assert.ok((await app.call('worker_status', {}, 'A')).workers.some(w => w.worker_id === a.worker_id && w.state === 'live'))
})

await scenario('K an error turn retracts the readiness proof', async () => {
  const app = makeApp()
  app.onFollowup = (id) => setTimeout(() => app.endTurn(id, { text: '391', calls: 1 }), 5)
  const a = await app.call('worker_spawn', { provider: 'pk', model: 'mk' }, 'A')
  app.onFollowup = () => {}
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'task' }, 'A')
  app.endTurn(a.worker_id, { reason: { kind: 'error', error: { message: 'LLM 503' } } })
  assert.ok(logs.some(l => /probe cache invalidate key=pk\|mk\|.*reason=turn error/.test(l)))
})

await scenario('L a queued call-cap notice is removed before the next dispatch', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'x', max_calls: 2 }, 'A')
  app.emit(a.worker_id, { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'run_code' }, { type: 'tool-call', name: 'run_code' }] } } })
  await tick(20)
  const mid = app.steers.find(s => s.id === a.worker_id)?.mid
  assert.ok(mid)
  app.endTurn(a.worker_id, { text: 'stopped' })
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'y' }, 'A')
  assert.ok(app.agents.get(a.worker_id).removed.includes(mid))
})

await scenario('N digest names workers by their id tail and says how to drain', async () => {
  assert.match(source, /suppressed\.map\(\(report\) => String\(report\.worker_id\)\.slice\(-8\)\)/)
  assert.match(source, /worker_reports\(clear:true\) 1회로 회수/)
})

await scenario('O/P dispatch to a finished worker fails with a clear cause', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_finish', { worker_id: a.worker_id }, 'A')
  await assert.rejects(app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'x' }, 'A'), /no live session handle|is finished/)
})

await scenario('Q archived result names its owner', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_finish', { worker_id: a.worker_id }, 'A')
  assert.equal((await app.call('worker_result', { worker_id: a.worker_id }, 'B')).owner, 'A')
})

await scenario('R transfer carries reports already queued for the moved worker', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'x' }, 'A')
  app.endTurn(a.worker_id, { text: 'result for the next coordinator' })
  await app.call('worker_transfer', { to_session_id: 'C', worker_ids: [a.worker_id] }, 'A')
  assert.deepEqual(await app.reports('C'), ['result for the next coordinator'])
})

await scenario('S registry trim drops finished records, never a live worker; finish keeps owner', async () => {
  // The live worker's record must become the oldest: 199 newer spawn+finish
  // cycles, with the clock pushed 7 s per cycle past the 10-per-minute guard.
  const realNow = Date.now
  let shift = 0
  Date.now = () => realNow() + shift
  try {
    const app = makeApp()
    const live = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
    for (let i = 0; i < 199; i++) {
      shift += 7000
      const w = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
      await app.call('worker_finish', { worker_id: w.worker_id }, 'A')
    }
    assert.ok(Object.keys(lastRegistry).length <= 200)
    assert.ok(lastRegistry[live.worker_id], 'live worker record survived the trim')
    await app.call('worker_finish', { worker_id: live.worker_id }, 'A')
    assert.equal(lastRegistry[live.worker_id].owner, 'A')
  } finally { Date.now = realNow }
})

await scenario('T a longer report sharing the stored 4000-char prefix is not deduped', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'x' }, 'A')
  app.endTurn(a.worker_id, { text: 'a'.repeat(4000) + 'X'.repeat(1000) })
  await app.call('worker_finish', { worker_id: a.worker_id }, 'A')
  await app.reports()
  await app.call('worker_resume', { worker_id: a.worker_id }, 'A')
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'y' }, 'A')
  app.endTurn(a.worker_id, { text: 'a'.repeat(4000) + 'Y'.repeat(1500) })
  assert.equal((await app.reports()).length, 1)
})

await scenario('U ttl_minutes is validated', async () => {
  const app = makeApp()
  for (const ttl of [0, -5, 'abc', 5000]) await assert.rejects(app.call('worker_spawn', { provider: 'p', model: 'm', verify: false, ttl_minutes: ttl }, 'A'), /ttl_minutes/)
})

await scenario('V model-diversity gate ignores another coordinator\'s producers', async () => {
  const app = makeApp()
  const b = await app.call('worker_spawn', { provider: 'p', model: 'deepseek/x', verify: false }, 'B')
  await app.call('worker_dispatch', { worker_id: b.worker_id, prompt: 'run' }, 'B')
  await app.call('worker_spawn', { provider: 'p', model: 'deepseek/x', verify: false }, 'A')
})

// ---- Code-review fixes R1~R8 (on top of A~X) ----

await scenario('R1 registry trim keeps unfinished records up to 400, then drops the oldest non-live', async () => {
  const seed = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => ['session-old-' + i, { owner: 'X', role: 'worker', model: 'm', at: i }]))
  try {
    registrySeed = JSON.stringify(seed(250))
    const app = makeApp()
    const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
    assert.equal(Object.keys(lastRegistry).filter(id => id.startsWith('session-old-')).length, 250, 'unfinished records kept under 400')
    assert.ok(lastRegistry[a.worker_id])
    registrySeed = JSON.stringify(seed(450))
    const app2 = makeApp()
    const b = await app2.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
    assert.ok(Object.keys(lastRegistry).length <= 400, 'hard ceiling 400')
    assert.ok(lastRegistry[b.worker_id], 'live record survives')
    assert.ok(!lastRegistry['session-old-0'] && lastRegistry['session-old-449'], 'oldest dropped first')
  } finally { registrySeed = '{}' }
})

await scenario('R2 the finished output is not re-reported after resume (long or short, trailing whitespace) until a new dispatch', async () => {
  for (const out of ['b'.repeat(4500) + '\n\n', 'same short\n']) {
    const app = makeApp()
    const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
    await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'x' }, 'A')
    app.endTurn(a.worker_id, { text: out })
    await app.call('worker_finish', { worker_id: a.worker_id }, 'A')
    assert.equal((await app.reports()).length, 1)
    await app.call('worker_resume', { worker_id: a.worker_id }, 'A')
    app.endTurn(a.worker_id, { text: out }) // a turn of the resumed session, no new dispatch
    assert.deepEqual(await app.reports(), [], 'untrimmed vs untrimmed, chars = full length (' + out.length + ')')
  }
})

await scenario('R3 worker_* that cannot be hidden: spawn/resume dispose and fail; no restrict API = logged only', async () => {
  const app = makeApp()
  app.restrictFails = (n) => n === 'worker_spawn'
  await assert.rejects(app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A'), /could not hide worker_spawn/)
  assert.equal(app.agents.size, 0, 'refused session disposed')
  assert.equal(app.disposed.length, 1)
  app.restrictFails = () => false
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_finish', { worker_id: a.worker_id }, 'A')
  app.restrictFails = (n) => n === 'worker_dispatch'
  await assert.rejects(app.call('worker_resume', { worker_id: a.worker_id }, 'A'), /could not hide worker_dispatch/)
  assert.ok(!app.agents.has(a.worker_id), 'resumed session disposed')
  const bare = makeApp({ noRestrict: true })
  const b = await bare.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  assert.ok(logs.includes('restrict unavailable ' + b.worker_id.slice(-8)))
})

await scenario('R4 a probe answered without run_code passes but is not cached', async () => {
  const app = makeApp()
  app.onFollowup = (id) => setTimeout(() => app.endTurn(id, { text: '391', calls: 0 }), 5)
  const a = await app.call('worker_spawn', { provider: 'p4', model: 'm4' }, 'A')
  assert.equal(a.verified, true)
  assert.equal(a.readiness.cached, false); assert.equal(a.readiness.runCodeCalls, 0)
  assert.ok(logs.includes('probe not cached (answered without run_code) worker=' + a.worker_id.slice(-8)))
  const b = await app.call('worker_spawn', { provider: 'p4', model: 'm4', allow_model_repeat: true }, 'A')
  assert.equal(b.verified, true); assert.equal(b.readiness.cached, false, 'second spawn of the same shape probed again')
})

await scenario('R5 a 5th worker\'s readiness probe is not blocked by the 4-running cap', async () => {
  const app = makeApp()
  for (let i = 0; i < 4; i++) {
    const w = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false, allow_model_repeat: true }, 'A')
    await app.call('worker_dispatch', { worker_id: w.worker_id, prompt: 'busy' }, 'A')
  }
  app.onFollowup = (id) => setTimeout(() => app.endTurn(id, { text: '391', calls: 1 }), 5)
  const e = await app.call('worker_spawn', { provider: 'p5', model: 'm', allow_model_repeat: true }, 'A')
  assert.equal(e.verified, true)
  await assert.rejects(app.call('worker_dispatch', { worker_id: e.worker_id, prompt: 'x' }, 'A'), /동시 실행 상한 4/)
})

await scenario('R6 transfer never moves the verifier: a subset keeps it, a full transfer (rotation) closes it', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  const b = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false, allow_model_repeat: true }, 'A')
  answerVerifier(app, { text: 'VERDICT: PASS' })
  const v0 = await app.call('worker_verify', { claim: 'x0' }, 'A')
  const t1 = await app.call('worker_transfer', { to_session_id: 'C', worker_ids: [a.worker_id] }, 'A')
  assert.deepEqual(t1.workers, [a.worker_id]); assert.deepEqual(t1.verifiers_closed, [])
  assert.equal((await app.call('worker_verify', { claim: 'x' }, 'A')).verifier_id, v0.verifier_id)
  const t2 = await app.call('worker_transfer', { to_session_id: 'C' }, 'A')
  assert.deepEqual(t2.workers, [b.worker_id]); assert.deepEqual(t2.verifiers_closed, [v0.verifier_id])
  assert.ok(!app.agents.has(v0.verifier_id), 'old verifier disposed, slot returned')
  assert.notEqual((await app.call('worker_verify', { claim: 'y' }, 'C')).verifier_id, v0.verifier_id)
})

await scenario('R7 a verifier still running an earlier claim answers UNKNOWN (busy) at once', async () => {
  const app = makeApp()
  await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  answerVerifier(app, { text: 'VERDICT: PASS' })
  const v0 = await app.call('worker_verify', { claim: 'x0' }, 'A')
  app.agents.get(v0.verifier_id).status = 'running'
  const late = new Promise((_, reject) => setTimeout(() => reject(new Error('verify waited instead of answering busy')), 500))
  const v = await Promise.race([app.call('worker_verify', { claim: 'x' }, 'A'), late])
  assert.equal(v.verdict, 'UNKNOWN'); assert.equal(v.busy, true)
  assert.equal(app.agents.get(v0.verifier_id).pending.length, 0, 'no claim queued behind the old one')
})

// Safety net only: in dsh-agent-loop a turn that claims nothing still ends with
// turn/end, so this idle-without-turn/end order needs a turn/start append failure or
// an abort between turns (ha_3 F4). The test forces it to check the net.
await scenario('R8 a queued turn that never opens is closed by the continuation watch', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'T1' }, 'A')
  const agent = app.agents.get(a.worker_id)
  agent.pending.push({ id: 'typed', content: [{ type: 'text', text: 'typed' }] }) // queued
  app.emit(a.worker_id, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'T1 done' }] } } })
  app.emit(a.worker_id, { type: 'turn/end', data: { reason: { kind: 'completed' } } }) // input still queued
  agent.pending.length = 0; agent.status = 'idle' // the wake claims nothing: no next turn
  const status = async () => (await app.call('worker_status', { worker_id: a.worker_id }, 'A')).status
  assert.equal(await status(), 'running')
  await tick(1800)
  assert.equal(await status(), 'idle')
  assert.equal((await app.reports()).length, 1)
  assert.ok(logs.includes('continuation closed without turn/end ' + a.worker_id.slice(-8)))
})

// ---- 3rd adversarial round (ha_1·ha_2·ha_3) ----

await scenario('X1 after resume, a new dispatch answered with the same words is reported (ha_2 H3)', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'x' }, 'A')
  app.endTurn(a.worker_id, { text: '완료. 변경 0건.' })
  await app.call('worker_finish', { worker_id: a.worker_id }, 'A')
  assert.equal((await app.reports()).length, 1)
  await app.call('worker_resume', { worker_id: a.worker_id }, 'A')
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'y' }, 'A')
  app.endTurn(a.worker_id, { text: '완료. 변경 0건.' })
  assert.deepEqual(await app.reports(), ['완료. 변경 0건.'])
})

await scenario('X2 a readiness probe whose turn ends in error fails and leaves no proof (ha_1 AD1-1)', async () => {
  const app = makeApp()
  app.onFollowup = (id) => setTimeout(() => app.endTurn(id, { text: '391', calls: 1, reason: { kind: 'error', error: { message: 'LLM 503' } } }), 5)
  await assert.rejects(app.call('worker_spawn', { provider: 'px2', model: 'mx2' }, 'A'), /failed verification/)
  app.onFollowup = (id) => setTimeout(() => app.endTurn(id, { text: '391', calls: 1 }), 5)
  const b = await app.call('worker_spawn', { provider: 'px2', model: 'mx2' }, 'A')
  assert.equal(b.verified, true); assert.equal(b.readiness.cached, false, 'the error turn cached nothing')
})

await scenario('X3 a call-cap notice still on its timer does not reach the next dispatch (ha_1 AD1-3)', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'T1', max_calls: 1 }, 'A')
  app.emit(a.worker_id, { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'run_code' }] } } }) // notice on a 0 ms timer
  app.endTurn(a.worker_id, { text: 'T1 done' })
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'T2' }, 'A') // before the timer fires
  await tick(20)
  assert.ok(!app.steers.some(s => s.id === a.worker_id), 'the T1 notice was dropped')
})

await scenario('X4 with 200+ unfinished records, a just-finished record survives the next save (ha_2 H1)', async () => {
  try {
    registrySeed = JSON.stringify(Object.fromEntries(Array.from({ length: 210 }, (_, i) => ['session-old-' + i, { owner: 'X', role: 'worker', model: 'm', at: i }])))
    const app = makeApp()
    const w = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
    await app.call('worker_dispatch', { worker_id: w.worker_id, prompt: 'x' }, 'A')
    app.endTurn(w.worker_id, { text: 'W1 RESULT' })
    await app.call('worker_finish', { worker_id: w.worker_id }, 'A')
    await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A') // the next save
    assert.equal(lastRegistry[w.worker_id]?.text, 'W1 RESULT')
    assert.equal(Object.keys(lastRegistry).filter(id => id.startsWith('session-old-')).length, 210)
  } finally { registrySeed = '{}' }
})

await scenario('X5 verdict lines: list number, bold, emoji; lines that disagree = UNKNOWN (ha_2 H4)', async () => {
  const app = makeApp()
  await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  let n = 0 // a distinct claim each time: the same claim is not re-verified
  const v = async (text) => { answerVerifier(app, { text }); return (await app.call('worker_verify', { claim: 'x' + n++ }, 'A')).verdict }
  assert.equal(await v('1. VERDICT: FAIL\n2. COUNTEREXAMPLE: a->b->c'), 'FAIL')
  assert.equal(await v('**VERDICT**: **FAIL**'), 'FAIL')
  assert.equal(await v('- **VERDICT**: **PASS**'), 'PASS')
  assert.equal(await v('### 🔴 VERDICT: FAIL'), 'FAIL')
  assert.equal(await v('VERDICT: FAIL\nFIX: x 를 고치면\nVERDICT: PASS 로 바뀜'), 'UNKNOWN')
  assert.equal(await v('VERDICT: PASS|FAIL|UNKNOWN 중 하나\nVERDICT: PASS'), 'PASS')
})

await scenario('X6 worker_verify with the global slots full says why (ha_2 H5)', async () => {
  const app = makeApp()
  for (let i = 0; i < 4; i++) await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false, allow_model_repeat: true }, 'B')
  for (let i = 0; i < 4; i++) await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false, allow_model_repeat: true }, 'A') // 8 global
  await assert.rejects(app.call('worker_verify', { claim: 'x' }, 'A'), /cannot attach the verifier: worker limit reached \(8\)/)
})

await scenario('X7 TTL reaper skips a running worker; an idle verifier is closed after 30 min (ha_2 H6·H2)', async () => {
  const realNow = Date.now
  let shift = 0
  Date.now = () => realNow() + shift
  try {
    const app = makeApp()
    const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false, ttl_minutes: 1 }, 'A')
    answerVerifier(app, { text: 'VERDICT: PASS' })
    const v0 = await app.call('worker_verify', { claim: 'x0' }, 'A')
    app.onFollowup = () => {}
    await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'one long run_code' }, 'A')
    shift += 31 * 60000
    app.reap(); await tick(20)
    assert.ok(app.agents.has(a.worker_id), 'running worker kept')
    assert.ok(!app.agents.has(v0.verifier_id), 'idle verifier closed')
    app.endTurn(a.worker_id, { text: 'built' })
    shift += 2 * 60000
    app.reap(); await tick(20)
    assert.ok(!app.agents.has(a.worker_id), 'idle past its ttl: reaped')
  } finally { Date.now = realNow }
})

await scenario('X8 the continuation watch never closes a later dispatch (ha_3 F4)', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'T1' }, 'A')
  const agent = app.agents.get(a.worker_id)
  agent.pending.push({ id: 'typed', content: [{ type: 'text', text: 'typed' }] })
  app.emit(a.worker_id, { type: 'turn/end', data: { reason: { kind: 'completed' } } }) // watch armed
  agent.pending.length = 0; agent.status = 'idle'
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'T2' }, 'A')
  agent.status = 'idle' // e.g. maintenance (manual compact) reports idle while T2 waits for its wake
  await tick(1800)
  assert.deepEqual(await app.reports(), [], 'T2 was not closed as silent')
  assert.equal((await app.call('worker_status', { worker_id: a.worker_id }, 'A')).status, 'running')
})

// ---- Live 11-18: rotation notice stuck in the inbox until a worker report woke the coordinator ----

await scenario('W rotation notice from the coordinator\'s own turn end waits for idle, then wakes it once', async () => {
  const app = makeApp()
  app.pressure = 410000
  const c = app.makeAgent('A'); app.agents.set('A', c)
  const woke = []
  // As in dsh-agent-loop: a steer to a running agent only queues (wakeDriver returns),
  // only an idle agent is woken by it.
  c.steer = (m) => { c.pending.push(m); if (c.status === 'idle') { c.status = 'running'; woke.push(m.content[0].text) } }
  c.status = 'running'
  app.emit('A', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  app.emit('A', { type: 'turn/end', data: { reason: { kind: 'completed' } } }) // a second turn end while waiting
  await tick(1) // the app's driver unwinds after the turn/end commit
  assert.equal(c.pending.length, 0, 'no notice queued into a turn that is ending')
  c.status = 'idle'; c.resolveIdle?.()
  await tick(5)
  assert.equal(woke.length, 1)
  assert.match(woke[0], /^\[교대 알림\] 현재 창 410000토큰/)
  assert.equal(c.pending.length, 1, 'one notice, not two')
  assert.ok(logs.some(l => /^rotation notify A bucket=8 delivery=steer waitedMs=\d+$/.test(l)))
})

// ---- 11-18 token-leak audit (reports/배분점검_1118): verifier on demand, capped, stopped ----

const runCodeTurn = (app, id, n) => app.emit(id, { type: 'assistant/message', data: { message: { content: Array.from({ length: n }, () => ({ type: 'tool-call', name: 'run_code' })) } } })
// Timers of 60 s and more (verify wait 100 s, stop grace 60 s) run 1000x faster inside fn.
const fastLongTimers = async (fn) => {
  const real = globalThis.setTimeout
  globalThis.setTimeout = (cb, ms, ...a) => real(cb, ms >= 60000 ? ms / 1000 : ms, ...a)
  const keepAlive = setInterval(() => {}, 10) // the plugin unrefs its timers
  try { return await fn() } finally { globalThis.setTimeout = real; clearInterval(keepAlive) }
}

await scenario('Y1 workers and the verifier get no skill tool (no skill catalog); an app without the name still spawns', async () => {
  const app = makeApp()
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  answerVerifier(app, { text: 'VERDICT: PASS' })
  const v = await app.call('worker_verify', { claim: 'x' }, 'A')
  for (const id of [a.worker_id, v.verifier_id]) assert.ok(app.restricts.find(r => r.id === id).deny.includes('skill'), id)
  const app2 = makeApp()
  app2.restrictFails = (n) => n === 'skill'
  const b = await app2.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  assert.ok(b.worker_id)
  assert.ok(logs.some(l => l.startsWith('restrict partial ' + b.worker_id.slice(-8) + ' failed=skill ')))
})

await scenario('Y2 verifier effort high; a GLM worker still reasons at max', async () => {
  const app = makeApp()
  answerVerifier(app, { text: 'VERDICT: PASS' })
  assert.equal((await app.call('worker_verify', { claim: 'x' }, 'A')).effort, 'high')
  assert.equal((await app.call('worker_spawn', { provider: 'p', model: 'zai/glm-5.3-flash', verify: false }, 'A')).effort, 'max')
})

await scenario('Y3 the verifier is call-capped at 8: the notice asks for the VERDICT', async () => {
  const app = makeApp()
  app.onFollowup = (id) => setTimeout(async () => { runCodeTurn(app, id, 8); await tick(5); app.endTurn(id, { text: 'VERDICT: PASS' }) }, 5)
  const v = await app.call('worker_verify', { claim: 'x' }, 'A')
  assert.equal(v.verdict, 'PASS')
  const notices = app.steers.filter(s => s.id === v.verifier_id)
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /^\[호출 상한\] run_code 8회 도달\. .*첫 줄 VERDICT/)
})

await scenario('Y4 one claim is verified once: PASS remembered, FAIL re-checked once, UNKNOWN not re-run', async () => {
  const app = makeApp()
  let followups = 0
  const answer = (text) => { app.onFollowup = (id) => { followups++; setTimeout(() => app.endTurn(id, { text }), 5) } }
  answer('VERDICT: PASS')
  assert.equal((await app.call('worker_verify', { claim: 'a  b' }, 'A')).verdict, 'PASS')
  const again = await app.call('worker_verify', { claim: ' a b ' }, 'A')
  assert.deepEqual([again.verdict, again.repeated, followups], ['PASS', true, 1])
  answer('VERDICT: FAIL')
  assert.equal((await app.call('worker_verify', { claim: 'c' }, 'A')).verdict, 'FAIL')
  answer('VERDICT: PASS')
  assert.equal((await app.call('worker_verify', { claim: 'c' }, 'A')).verdict, 'PASS', 'FAIL → one re-check after rework')
  assert.equal(followups, 3)
  answer('검토했지만 판정 줄 없음')
  assert.equal((await app.call('worker_verify', { claim: 'd' }, 'A')).verdict, 'UNKNOWN')
  const d2 = await app.call('worker_verify', { claim: 'd' }, 'A')
  assert.deepEqual([d2.verdict, d2.repeated, followups], ['UNKNOWN', true, 4])
  assert.match(d2.text, /UNKNOWN 으로 보고/)
  assert.ok(logs.some(l => /^verify verdict=UNKNOWN verifier=\S{8} reason=no verdict line$/.test(l)))
  // Another coordinator's memory is its own.
  answer('VERDICT: FAIL')
  assert.equal((await app.call('worker_verify', { claim: 'a b' }, 'B')).verdict, 'FAIL')
})

await scenario('Y5 a timed-out verify asks for the verdict, then stops the verifier; a new claim gets a new one', async () => {
  await fastLongTimers(async () => {
    const app = makeApp()
    app.onFollowup = () => {} // the verifier never answers
    const v = await app.call('worker_verify', { claim: 'slow' }, 'A')
    assert.deepEqual([v.verdict, v.timed_out], ['UNKNOWN', true])
    const agent = app.agents.get(v.verifier_id)
    await tick(5)
    assert.ok(app.steers.some(s => s.id === v.verifier_id && /^\[검증 시간 초과\]/.test(s.text)), 'wrap-up asked')
    await tick(150)
    assert.deepEqual(agent.causes, [{ kind: 'user' }]); assert.ok(agent.disposed, 'verifier closed, slot returned')
    assert.ok(logs.some(l => l.startsWith('verify stop ' + v.verifier_id.slice(-8))))
    assert.ok(logs.some(l => l === 'verify verdict=UNKNOWN verifier=' + v.verifier_id.slice(-8) + ' reason=timeout 100000ms'))
    const same = await app.call('worker_verify', { claim: 'slow' }, 'A')
    assert.deepEqual([same.verdict, same.repeated, same.verifier_id], ['UNKNOWN', true, null])
    answerVerifier(app, { text: 'VERDICT: PASS' })
    const next = await app.call('worker_verify', { claim: 'other' }, 'A')
    assert.equal(next.verdict, 'PASS'); assert.notEqual(next.verifier_id, v.verifier_id)
  })
})

await scenario('Y6 a verdict that arrives after the timeout (within the grace) is reported once and not stopped', async () => {
  await fastLongTimers(async () => {
    const app = makeApp()
    app.onFollowup = () => {}
    const v = await app.call('worker_verify', { claim: 'slow' }, 'A')
    app.endTurn(v.verifier_id, { text: 'VERDICT: FAIL\nCOUNTEREXAMPLE: a->b->c' })
    const late = await app.reports('A')
    assert.equal(late.length, 1); assert.match(late[0], /^VERDICT: FAIL/)
    const agent = app.agents.get(v.verifier_id)
    await tick(150)
    assert.deepEqual(agent.causes, [], 'an idle verifier is not stopped')
  })
})

await scenario('Y7 a verdict returned by worker_verify is not also pushed into the chat', async () => {
  const app = makeApp()
  app.agents.set('A', app.makeAgent('A')) // the coordinator: chat copies land here
  answerVerifier(app, { text: 'VERDICT: PASS' })
  assert.equal((await app.call('worker_verify', { claim: 'x' }, 'A')).verdict, 'PASS')
  await tick(1700)
  assert.deepEqual(await app.reports('A'), [])
  assert.equal(app.steers.filter(s => s.id === 'A').length, 0)
})

await scenario('Y8 the verifier refuses worker_resume and worker_dispatch (N1·N2)', async () => {
  const app = makeApp()
  answerVerifier(app, { text: 'VERDICT: PASS' })
  const v = await app.call('worker_verify', { claim: 'x' }, 'A')
  await assert.rejects(app.call('worker_dispatch', { worker_id: v.verifier_id, prompt: 'p' }, 'A'), /검증자에는 worker_dispatch/)
  await app.call('worker_cancel', { worker_id: v.verifier_id }, 'A')
  await assert.rejects(app.call('worker_resume', { worker_id: v.verifier_id }, 'A'), /검증자는 worker_resume/)
})

await scenario('Y9 worker_reports(clear) before the 1.5 s flush: the chat gets no second copy (x2 B1)', async () => {
  const app = makeApp()
  app.agents.set('A', app.makeAgent('A')) // the coordinator: chat copies land here
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'go' }, 'A')
  app.endTurn(a.worker_id, { text: 'done' })
  assert.deepEqual(await app.reports('A'), ['done'])
  await tick(1700)
  assert.equal(app.steers.filter(s => s.id === 'A').length, 0)
})

await scenario('Y10 the chat copy of a long report is cut at 1,200 chars with the way to the full text', async () => {
  const app = makeApp()
  app.agents.set('A', app.makeAgent('A')) // the coordinator: chat copies land here
  const a = await app.call('worker_spawn', { provider: 'p', model: 'm', verify: false }, 'A')
  await app.call('worker_dispatch', { worker_id: a.worker_id, prompt: 'go' }, 'A')
  const long = 'L'.repeat(3000)
  app.endTurn(a.worker_id, { text: long })
  await tick(1700)
  const chat = app.steers.filter(s => s.id === 'A')
  assert.equal(chat.length, 1)
  assert.ok(chat[0].text.length < 1500, String(chat[0].text.length))
  assert.ok(chat[0].text.includes('전문 3000자') && chat[0].text.includes(a.worker_id))
  assert.equal((await app.call('worker_result', { worker_id: a.worker_id }, 'A')).text, long)
})

await scenario('Y11 two spawns of one shape that miss the cache together run one readiness probe (x2 B2)', async () => {
  const app = makeApp()
  let probes = 0
  app.onFollowup = (id, m) => { if (/Readiness probe/.test(m.content[0].text)) probes++; setTimeout(() => app.endTurn(id, { text: '391', calls: 1 }), 20) }
  const [a, b] = await Promise.all([
    app.call('worker_spawn', { provider: 'p', model: 'shape-y11', allow_model_repeat: true }, 'A'),
    app.call('worker_spawn', { provider: 'p', model: 'shape-y11', allow_model_repeat: true }, 'B'),
  ])
  assert.ok(a.verified && b.verified)
  assert.equal(probes, 1)
  assert.equal([a, b].filter(s => s.readiness.cached === true).length, 1)
})

await scenario('Y12 the memo key is claim + target + evidence: the same sentence about another target runs again', async () => {
  const app = makeApp()
  let followups = 0
  app.onFollowup = (id) => { followups++; setTimeout(() => app.endTurn(id, { text: 'VERDICT: PASS' }), 5) }
  await app.call('worker_verify', { claim: 'no leak', target: 'E:/a.mjs', evidence: 'a:1' }, 'A')
  assert.equal((await app.call('worker_verify', { claim: 'no leak', target: 'E:/b.mjs', evidence: 'a:1' }, 'A')).repeated, undefined)
  assert.equal((await app.call('worker_verify', { claim: 'no leak', target: 'E:/a.mjs', evidence: 'a:2 (after fix)' }, 'A')).repeated, undefined)
  assert.equal((await app.call('worker_verify', { claim: 'no  leak', target: 'E:/a.mjs', evidence: 'a:1' }, 'A')).repeated, true)
  assert.equal(followups, 3)
})

await scenario('Y13 a verdict already returned is not re-sent when the verifier is finished later', async () => {
  const app = makeApp()
  app.agents.set('A', app.makeAgent('A'))
  answerVerifier(app, { text: 'VERDICT: PASS' })
  const v = await app.call('worker_verify', { claim: 'x' }, 'A')
  await app.call('worker_finish', { worker_id: v.verifier_id }, 'A')
  await tick(1700)
  assert.deepEqual(await app.reports('A'), [])
  assert.equal(app.steers.filter(s => s.id === 'A').length, 0)
})

await scenario('Y14 the lazily created verifier works in the coordinator workspace, not the app cwd', async () => {
  const app = makeApp()
  answerVerifier(app, { text: 'VERDICT: PASS' })
  const v = await app.defs.get('worker_verify').execute({ claim: 'x' }, { agent: { session: { header: { id: 'A', cwd: 'D:/work' } } } })
  assert.equal(app.cwds.get(v.verifier_id), 'D:/work')
})

console.log(results.join('\n'))
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0)
