// The fs isolation below only works on Node. Under Bun the plugin's own fs imports
// stay real, so these fake workers would be written into the real state folder.
if (process.versions.bun) throw new Error('Run with node (npm test): this test must not run under Bun.')

import { homedir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const source = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
const region = source.match(/\/\/ #region rotation-notify-policy[\s\S]*?\/\/ #endregion/)
assert.ok(region, 'policy region exists')
const decide = new Function(region[0] + '\nreturn rotationDecision')()
const base = { threshold: 400000, step: 50000, isWorker: false }
for (const [pressure, lastBucket, isWorker, notify] of [
  [399999, undefined, false, false], [400000, undefined, false, true],
  [400000, 8, false, false], [449999, 8, false, false], [450000, 8, false, true],
  [500000, undefined, true, false], [undefined, undefined, false, false],
]) assert.equal(decide({ ...base, pressure, lastBucket, isWorker }).notify, notify)
console.log('policy: 7 cases passed')

// The plugin normally writes logs and polls a real control directory. Isolate all
// of those paths, including the registry, while importing the actual stage file.
// Plugin state goes to DSH_ORCH_DIR; a fake drive keeps every real path untouched.
process.env.DSH_ORCH_DIR = 'Z:/dsh-orch-test'
process.env.DSH_ORCH_CTL = '1'
const orch = (p) => typeof p === 'string' && p.replaceAll('\\', '/').startsWith('Z:/dsh-orch-test')
const original = Object.fromEntries(['appendFileSync', 'existsSync', 'mkdirSync', 'readFileSync', 'readdirSync', 'renameSync', 'unlinkSync', 'writeFileSync'].map(k => [k, fs[k]]))
let ctlCommand, ctlOutput
fs.appendFileSync = (p, ...args) => orch(p) ? undefined : original.appendFileSync(p, ...args)
fs.existsSync = (p) => orch(p) ? true : original.existsSync(p)
fs.mkdirSync = (p, ...args) => orch(p) ? undefined : original.mkdirSync(p, ...args)
fs.readFileSync = (p, ...args) => orch(p) ? (String(p).endsWith('workers.json') ? JSON.stringify({ 'worker-id': { role: 'worker' } }) : JSON.stringify(ctlCommand)) : original.readFileSync(p, ...args)
fs.readdirSync = (p, ...args) => orch(p) ? (ctlCommand ? ['test.json'] : []) : original.readdirSync(p, ...args)
fs.renameSync = (p, ...args) => orch(p) ? undefined : original.renameSync(p, ...args)
fs.unlinkSync = (p, ...args) => orch(p) ? undefined : original.unlinkSync(p, ...args)
fs.writeFileSync = (p, data, ...args) => { if (orch(p)) { ctlOutput = JSON.parse(data); ctlCommand = undefined; return } return original.writeFileSync(p, data, ...args) }
syncBuiltinESMExports()

const { apply } = await import('../index.mjs')
let handler, pressure = 400000, meter = 'ok'
const sent = []
const fakeCtx = {
  tools: { register() {} },
  on(event, fn) { if (event === 'session/event') handler = fn },
  get(key) {
    if (key !== 'tokenMeter' || meter === 'missing') return undefined
    if (meter === 'throw') throw Error('meter failed')
    return { contextPressure: async () => ({ pressureTokens: pressure }) }
  },
  agents: { create() {}, get: () => ({ steer: (message) => sent.push(message) }) },
}
apply(fakeCtx)
assert.equal(typeof handler, 'function')
const emit = async (id, type = 'turn/end') => { handler({ header: { id } }, { type }); await new Promise(resolve => setTimeout(resolve, 10)) }
await emit('owner', 'other'); assert.equal(sent.length, 0)
await emit('owner'); assert.equal(sent.length, 1)
assert.match(sent[0].content[0].text, /현재 창 400000토큰/)
assert.ok(sent[0].content[0].text.includes(join(homedir(), '.agents', 'skills', 'worker-orchestration', 'handoff_template.md')))
assert.ok(sent[0].content[0].text.includes(join('Z:/dsh-orch-test', 'handoff', '<작업명>_<NN>.md')))
await emit('owner'); assert.equal(sent.length, 1)
pressure = 450000; await emit('owner'); assert.equal(sent.length, 2)
await emit('worker-id'); assert.equal(sent.length, 2)
meter = 'missing'; await emit('missing'); assert.equal(sent.length, 2)
meter = 'throw'; await emit('throw'); assert.equal(sent.length, 2)
console.log('events: 400k once, 450k again, worker excluded, missing/throw safe')

ctlCommand = { id: 'test', code: 'return await api.rotationNotifyTest({ sessionId: "owner", pressure: 500000 })' }
await new Promise(resolve => setTimeout(resolve, 350))
assert.equal(ctlOutput?.ok, true)
assert.deepEqual(ctlOutput.value, { notify: true, bucket: 10, delivery: 'steer' })
assert.equal(sent.length, 3)
meter = 'ok'; pressure = 500000; await emit('owner'); assert.equal(sent.length, 4)
console.log('control: forced delivery passed; normal bucket unchanged')

// A failed notice must not close its bucket: the next turn end at the same pressure retries.
let failSteer = 1
fakeCtx.agents.get = () => ({ steer: (message) => { if (failSteer > 0) { failSteer -= 1; throw Error('transient') } sent.push(message) } })
meter = 'ok'; pressure = 400000
const before = sent.length
await emit('owner2'); assert.equal(sent.length, before)
await emit('owner2'); assert.equal(sent.length, before + 1)
await emit('owner2'); assert.equal(sent.length, before + 1)
console.log('retry: failed notice retried at the same bucket, then closed')
