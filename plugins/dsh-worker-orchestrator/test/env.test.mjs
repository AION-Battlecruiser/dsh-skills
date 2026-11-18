import assert from 'node:assert/strict'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

// Without any DSH_ORCH_* variable the plugin keeps its state under
// ~/.dsh/worker-orchestrator and never opens the code-running control channel.
delete process.env.DSH_ORCH_DIR
delete process.env.DSH_ORCH_CTL
const dir = join(homedir(), '.dsh', 'worker-orchestrator').replaceAll('\\', '/')
const orch = (p) => typeof p === 'string' && p.replaceAll('\\', '/').startsWith(dir)
const original = Object.fromEntries(['appendFileSync', 'existsSync', 'mkdirSync', 'readFileSync', 'readdirSync', 'writeFileSync'].map(k => [k, fs[k]]))
const logs = []
const touched = []
fs.appendFileSync = (p, data, ...a) => { if (!orch(p)) return original.appendFileSync(p, data, ...a); logs.push(String(data).trim().replace(/^\S+ /, '')) }
fs.existsSync = (p) => { if (orch(p)) { touched.push(String(p)); return true } return original.existsSync(p) }
fs.mkdirSync = (p, ...a) => { if (orch(p)) { touched.push(String(p)); return undefined } return original.mkdirSync(p, ...a) }
fs.readFileSync = (p, ...a) => orch(p) ? '{}' : original.readFileSync(p, ...a)
fs.readdirSync = (p, ...a) => { if (orch(p)) { touched.push(String(p)); return [] } return original.readdirSync(p, ...a) }
fs.writeFileSync = (p, data, ...a) => orch(p) ? undefined : original.writeFileSync(p, data, ...a)
syncBuiltinESMExports()

const { apply } = await import('../index.mjs')
assert.ok(logs[0].startsWith('module loaded '), logs[0])
assert.ok(logs[0].includes('dir=' + dir), logs[0])
assert.ok(logs[0].endsWith('ctl=disabled'), logs[0])

// A minimal host: apply() must reach the end and skip the control channel.
const ctx = { get: () => undefined, on: () => () => {}, inject: () => {}, root: undefined }
try { apply(ctx) } catch {}
await new Promise(r => setTimeout(r, 400))
assert.ok(logs.includes('ctl=off'), logs.join('\n'))
assert.ok(!logs.includes('ctl=on'))
assert.equal(touched.filter(p => p.replaceAll('\\', '/').includes('/ctl/')).length, 0, touched.join('\n'))
console.log('env: default dir ' + dir + ', control channel off without DSH_ORCH_CTL=1')
