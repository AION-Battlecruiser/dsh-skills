/**
 * Ordinary-session worker orchestrator for DeepSeek Harness.
 *
 * Workers are independent DSH sessions created through the Agent service
 * (no subagent parent, no agent team), driven with followup prompts and read
 * through the host session event stream. Tool definitions are registered as
 * plain JSON Schema objects, so the plugin needs no @deepseek-ai imports.
 *
 * State lives in one directory (DSH_ORCH_DIR, default ~/.dsh/worker-orchestrator):
 * plugin.log, worker_reports.log, workers.json and handoff/.
 *
 * An optional file-based control channel (<dir>/ctl) exposes the live plugin
 * instance to the operator: write { id, code } JSON into in/, read the result
 * from out/. It runs arbitrary code inside the app, so it is off unless
 * DSH_ORCH_CTL=1.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

const ENV = globalThis.process?.env ?? {}
const ORCH_DIR = String(ENV.DSH_ORCH_DIR || join(homedir(), '.dsh', 'worker-orchestrator')).replaceAll('\\', '/').replace(/\/+$/, '')
const CTL_ENABLED = ENV.DSH_ORCH_CTL === '1'
const HANDOFF_DIR = join(ORCH_DIR, 'handoff')
const HANDOFF_TEMPLATE = join(homedir(), '.agents', 'skills', 'worker-orchestration', 'handoff_template.md')
try { if (!existsSync(ORCH_DIR)) mkdirSync(ORCH_DIR, { recursive: true }) } catch {}

const PROBE_LOG = ORCH_DIR + '/plugin.log'
// Reports are pushed into the coordinator's chat; this file is the audit trail.
const REPORT_LOG = ORCH_DIR + '/worker_reports.log'
const sinkReport = (text) => {
  try { appendFileSync(REPORT_LOG, '\n===== ' + new Date().toISOString() + ' =====\n' + text + '\n') } catch {}
}
const CTL_IN = ORCH_DIR + '/ctl/in'
const CTL_OUT = ORCH_DIR + '/ctl/out'

const probe = (line) => {
  try { appendFileSync(PROBE_LOG, new Date().toISOString() + ' ' + line + '\n') } catch {}
}

probe('module loaded v4-r3 dir=' + ORCH_DIR + ' ctl=' + (CTL_ENABLED ? 'enabled' : 'disabled'))

export const name = 'worker-orchestrator'
export const inject = ['tools']

const ROTATION_NOTIFY_AT = 400000
const ROTATION_STEP = 50000
const ROTATION_NOTIFY_ENABLED = true
// Longest wait for the coordinator to go idle before a rotation notice is steered anyway.
const ROTATION_IDLE_WAIT_MS = 30000

// #region rotation-notify-policy
const rotationDecision = ({ pressure, lastBucket, isWorker, threshold, step }) => {
  const bucket = typeof pressure === 'number' && Number.isFinite(pressure) ? Math.floor(pressure / step) : undefined
  return { notify: !isWorker && bucket !== undefined && pressure >= threshold && bucket > (lastBucket ?? -1), bucket }
}
// #endregion

// #region call-cap-policy
const callCapDecision = ({ role, maxCalls, count, event }) => {
  // An interrupted (aborted mid-stream) message is stored but its tool calls never run.
  // The verifier is capped too (live 11-18: one verify ran 25 run_code uncapped).
  if ((role !== 'worker' && role !== 'verifier') || !Number.isInteger(maxCalls) || event?.type !== 'assistant/message' || event.data?.interrupted === true) return { count, notices: [] }
  const calls = (Array.isArray(event.data?.message?.content) ? event.data.message.content : []).filter((block) => block?.type === 'tool-call' && block.name === 'run_code').length
  const notices = [maxCalls, 2 * maxCalls].filter((limit) => count < limit && count + calls >= limit)
  return { count: count + calls, notices }
}
// #endregion

// #region concurrency-policy
const concurrencyDecision = ({ workers, owner, targetId, pending = 0 }) => {
  const own = workers.filter((worker) => worker.owner === owner && worker.role === 'worker' && worker.finished !== true)
  return { slotsFull: own.length + pending >= 8, runningFull: own.filter((worker) => worker.id !== targetId && worker.status === 'running').length >= 4 }
}
// #endregion

const MAX_WORKERS = 8

// "VERDICT: PASS" at the start of a line: markdown, bullet, emoji or list-number
// prefix and bold/colon separators allowed ("1. VERDICT: FAIL", "**VERDICT**: **FAIL**",
// "### 🔴 VERDICT: FAIL"). Rejects the echoed template "VERDICT: PASS|FAIL|UNKNOWN"
// and words like PASSIVE. Lines that disagree make the verdict UNKNOWN (ha_2 H4).
const VERDICT_LINE = /^[^\w\n]{0,10}(?:\d{1,2}[.)][^\w\n]{0,4})?VERDICT[^\w\n]{0,8}(PASS|FAIL|UNKNOWN)\b(?![ \t]*\|)/gim

// A readiness probe is proven per model/preset combination, not per spawn: one
// probe turn costs ~4,560 U and the same combination answers the same way.
// Process-lifetime only — a restart must re-prove, so nothing is persisted.
const PROBE_CACHE_TTL_MS = 10 * 60 * 1000
const PROBE_CACHE_MAX = 64

// MAIN-only surface: workers get none of the orchestration or GUI tools.
// `skill` too: the app builds its skill catalog only for an agent that sees the skill
// tool (dsh-tool-skill), so hiding it drops ~12k chars from every worker step and the
// full catalog re-send whenever a skill is installed (live 11-18: 16,187 chars).
const WORKER_DENIED = [
  'worker_spawn', 'worker_dispatch', 'worker_status', 'worker_result', 'worker_cancel', 'worker_resume',
  'worker_verify', 'worker_finish', 'worker_reports', 'worker_transfer',
  'gui_open_workers', 'gui_tile_workers', 'gui_focus_worker', 'gui_close_worker', 'gui_layout',
  'gui_screenshot', 'gui_list_windows', 'gui_click', 'gui_type', 'gui_key',
  'skill',
]

// A report's copy in the coordinator's chat stays in its window for every later step;
// worker_result returns the whole text, the audit log keeps the queued copy (≤6,000).
const CHAT_REPORT_MAX = 1200

const obj = (properties, required = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
})

const anyObj = { type: 'object', additionalProperties: true, properties: {} }

const textRender = (value) => [{
  type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
}]

const safeType = (fn) => {
  try { return typeof fn() } catch (error) { return 'throw:' + String(error?.message ?? error).slice(0, 80) }
}

// tools.view().visible is a Map in the app; Object.keys(Map) is always empty.
const visibleNames = (visible) => (visible instanceof Map ? [...visible.keys()] : Object.keys(visible ?? {})).map(String)

const describeError = (error) =>
  String(error?.message ?? error) +
  (error?.violations ? ' :: ' + JSON.stringify(error.violations).slice(0, 300) : '')

export function apply(ctx) {
  probe('apply called v4')
  probe('tools=' + safeType(() => ctx.tools?.register))
  probe('tools-view=' + safeType(() => visibleNames(ctx.tools.view(undefined).visible).join(',')))
  probe('agents-direct=' + safeType(() => ctx.agents?.create))
  probe('agents-get=' + safeType(() => ctx.get?.('agents')?.create))
  probe('root-tools=' + safeType(() => ctx.root?.tools?.register))

  // ---- ownership ---------------------------------------------------------
  // Every worker belongs to exactly one coordinator session. Reports go only to
  // that owner and no session may address another session's worker: a shared
  // "last caller" pointer let unrelated sessions receive each other's reports.
  const workers = new Map()
  const pendingSpawns = new Map()
  const verifierPending = new Map() // owner -> in-flight verifier creation
  // Spawns reserve their slot before awaiting creation; the global cap must see them too.
  const slotsInUse = () => { let n = workers.size + verifierPending.size; for (const count of pendingSpawns.values()) n += count; return n }
  // The live agent decides "running": a turn/end closes one turn, and a queued
  // followup starts the next one while the bookkeeping already says idle.
  const liveStatus = (worker) => { try { const live = worker?.handle?.agent?.status; return typeof live === 'string' ? live : undefined } catch { return undefined } }
  const isRunning = (worker) => { const live = liveStatus(worker); return live === undefined ? worker?.status === 'running' : live === 'running' }
  // concurrencyDecision is pure over a status field; feed it the live view.
  const liveWorkers = () => [...workers.values()].map((worker) => (isRunning(worker) && worker.status !== 'running' ? { ...worker, status: 'running' } : worker))
  const archived = new Map()
  const reports = []
  const rotationBuckets = new Map()
  const rotationPending = new Set()
  const notifyState = new Map()
  const MAX_NOTIFY = 6
  const MIN_NOTIFY_GAP_MS = 4000
  const spawnTimes = []
  const MAX_SPAWN_PER_MINUTE = 10
  const DEFAULT_TTL_MINUTES = 120
  const VERIFIER_TTL_MINUTES = 30

  const REGISTRY = ORCH_DIR + '/workers.json'
  let registry = {}
  try { registry = JSON.parse(readFileSync(REGISTRY, 'utf8')) } catch { registry = {} }
  for (const [id, record] of Object.entries(registry)) {
    if (record.state === 'finished' && typeof record.text === 'string') {
      archived.set(id, { worker_id: id, role: record.role, model: record.model, status: 'finished', chars: record.chars ?? record.text.length, text: record.text, finishedAt: record.at ?? Date.now() })
    }
  }
  const saveRegistry = () => {
    try {
      const entries = Object.entries(registry)
      if (entries.length > 200) {
        // Oldest first by `at`; a live worker's record is never trimmed.
        // 1) Finished records down to 200 in total, but the newest 100 finished stay:
        //    results are read and resumed by id after a reload or a rotation, and 200+
        //    unfinished records must not wipe a just-finished one (ha_2 H1).
        // 2) Unfinished records are ownership (a resumable session of an earlier
        //    process): only past a hard ceiling of 400, oldest non-live of any kind.
        const byAge = entries.filter(([id]) => !workers.has(id)).sort((a, b) => (Number(a[1].at) || 0) - (Number(b[1].at) || 0))
        const finished = byAge.filter(([, record]) => record.state === 'finished')
        const gone = new Set()
        let drop = Math.min(entries.length - 200, finished.length - 100)
        for (const [id] of finished) { if (drop <= 0) break; gone.add(id); drop -= 1 }
        let over = entries.length - gone.size - 400
        for (const [id] of byAge) { if (over <= 0) break; if (!gone.has(id)) { gone.add(id); over -= 1 } }
        registry = Object.fromEntries(entries.filter(([id]) => !gone.has(id)))
      }
      writeFileSync(REGISTRY, JSON.stringify(registry))
    } catch (error) { probe('registry save failed: ' + String(error?.message ?? error).slice(0, 100)) }
  }

  let callerId
  let callerAgentRef
  const noteCaller = (exec) => {
    try {
      const agent = exec?.agent
      if (agent === undefined) return
      callerAgentRef = agent
      const id = agent?.session?.header?.id
      if (typeof id === 'string' && id !== '') callerId = id
      // A handed-off worker reports to its new owner from the first call onward.
      for (const worker of workers.values()) {
        if (worker.owner === callerId && worker.ownerAgent === undefined) worker.ownerAgent = callerAgentRef
      }
    } catch {}
  }
  const requireCaller = () => {
    if (typeof callerId !== 'string' || callerId === '') {
      throw new Error('worker tools need a coordinator session identity: call them from a normal session turn')
    }
    return callerId
  }

  /**
   * Arm a flush for undelivered reports that have no timer behind them, so a
   * batch is never left waiting for the next event to arrive.
   */
  const armFlush = (ownerId, state) => {
    if (state === undefined || state.timer !== undefined) return
    if (!state.items.some((report) => report.delivered !== true)) return
    const wait = Math.max(0, MIN_NOTIFY_GAP_MS - (Date.now() - state.lastAt))
    state.timer = setTimeout(() => { state.timer = undefined; scheduleNotify(ownerId) }, wait)
    if (typeof state.timer?.unref === 'function') state.timer.unref()
  }

  /**
   * Push a report straight into the coordinator's chat. `steer` splices the
   * message at the coordinator's next step boundary and wakes an idle
   * coordinator, so a finished worker reports mechanically instead of waiting
   * for a worker_reports() call the coordinator may never make.
   * @returns the channel that accepted the message, or why none did.
   */
  const deliverToOwner = (ownerId, text, messageId = randomUUID()) => {
    try {
      const service = agentService()
      const agent = typeof service.get === 'function' ? service.get(ownerId) : undefined
      if (agent === undefined) return 'no-live-agent'
      const message = {
        id: messageId,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }
      if (typeof agent.steer === 'function') { agent.steer(message); return 'steer' }
      if (typeof agent.followup === 'function') { agent.followup(message); return 'followup' }
      return 'no-channel'
    } catch (error) {
      probe('deliver failed: ' + describeError(error))
      return 'error'
    }
  }

  /**
   * Deliver outside the current session/event dispatch. Observers run inside the
   * session's synchronous commit, and steering that same session from there
   * throws "session append cannot reenter"; a timer lets the commit finish first
   * (commit is synchronous, so no append is in flight when a timer runs).
   * `stillWanted` is checked first so a late notice never wakes a worker whose
   * turn already ended. No retry: steer may fail after it already enqueued.
   */
  const deliverLater = (sessionId, text, label, stillWanted = () => true, messageId) => {
    const timer = setTimeout(() => {
      if (!stillWanted()) { probe(label + ' skipped'); return }
      probe(label + ' delivery=' + deliverToOwner(sessionId, text, messageId))
    }, 0)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  /**
   * The notice comes from the session's own turn/end. Until the app's driver
   * unwinds, the agent still reports running, and a steer then only queues: the
   * app's wakeDriver does nothing for a running agent, so the notice sat in the
   * inbox until other input woke the session (live 11-18: woken 51 s later by a
   * worker report). Wait for idle, bounded; a steer into a turn that really is
   * running is claimed at its next step. Returns the ms waited.
   */
  const waitOwnerIdle = async (id) => {
    const startedAt = Date.now()
    let agent
    try { agent = agentService().get?.(id) } catch { return 0 }
    if (agent?.status !== 'running' || typeof agent.whenIdle !== 'function') return 0
    let timer
    const cap = new Promise((resolve) => {
      timer = setTimeout(resolve, ROTATION_IDLE_WAIT_MS)
      if (typeof timer?.unref === 'function') timer.unref()
    })
    try { await Promise.race([agent.whenIdle(), cap]) } catch {} finally { clearTimeout(timer) }
    return Date.now() - startedAt
  }

  const checkRotation = async (session, forcedPressure, test = false) => {
    try {
      const id = session?.header?.id
      if (!ROTATION_NOTIFY_ENABLED || typeof id !== 'string' || !id) return { notify: false }
      const isWorker = workers.has(id) || archived.has(id) || Object.hasOwn(registry, id)
      if (isWorker) return { notify: false }
      const pressure = test ? forcedPressure : (await Promise.resolve(ctx.get('tokenMeter')?.contextPressure?.(session)))?.pressureTokens
      const decision = rotationDecision({ pressure, lastBucket: test ? undefined : rotationBuckets.get(id), isWorker, threshold: ROTATION_NOTIFY_AT, step: ROTATION_STEP })
      if (!decision.notify) return decision
      const message ='[교대 알림] 현재 창 ' + pressure + '토큰(기준 400k). 남은 일이 없으면 마무리 보고만 하고 끝내라. 남은 일이 있으면 새 배치·새 작업을 시작하지 말고, 진행 중인 일꾼 결과만 회수·finish한 뒤 ' + HANDOFF_TEMPLATE + ' 양식대로 ' + join(HANDOFF_DIR, '<작업명>_<NN>.md') + ' 핸드오프를 쓰고, 마스터 프롬프트 1줄(워커오케스트레이션: <핸드오프 경로> 읽고 다음 할 일부터 바로 이어서 작업 시작)을 코드블록으로 출력하고 종료하라.'
      // One notice in flight per session: a later turn end must not send a second
      // one while the first still waits for idle.
      if (!test && rotationPending.has(id)) return { ...decision, notify: false, pending: true }
      if (!test) rotationPending.add(id)
      try {
        const waitedMs = test ? 0 : await waitOwnerIdle(id)
        const delivery = deliverToOwner(id, message)
        // Only an accepted notice closes its bucket; a failed one retries at the next turn end.
        if (!test && (delivery === 'steer' || delivery === 'followup')) rotationBuckets.set(id, decision.bucket)
        probe('rotation notify ' + id + ' bucket=' + decision.bucket + ' delivery=' + delivery + ' waitedMs=' + waitedMs)
        return { ...decision, delivery }
      } finally {
        if (!test) rotationPending.delete(id)
      }
    } catch (error) {
      try { probe('rotation notify error: ' + String(error?.message ?? error)) } catch {}
      return { notify: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * Wake one owner with the reports that arrived inside one window. The queue is
   * per owner, so two coordinators never see each other's workers.
   */
  const scheduleNotify = (ownerId) => {
    const state = notifyState.get(ownerId)
    if (state === undefined || state.timer !== undefined) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      if (state.items.length === 0) return
      if (state.count >= MAX_NOTIFY) {
        // No wake. Park the batch instead of dropping it and tell the coordinator
        // once so it can drain the queue with worker_reports().
        if (state.suppressed === undefined) state.suppressed = []
        for (const report of state.items) if (report.delivered !== true) state.suppressed.push(report)
        state.items = []
        probe('notify suppressed owner=' + ownerId.slice(-8) + ' budget=' + state.count + ' held=' + state.suppressed.length)
        if (state.digestSent !== true && state.suppressed.length > 0) {
          state.digestSent = true
          const ids = [...new Set(state.suppressed.map((report) => String(report.worker_id).slice(-8)))].join(',')
          const text = '[WORKER REPORTS PENDING ' + state.suppressed.length + '] ids=' + ids + ' — 자동 알림 ' + MAX_NOTIFY + '회 예산 소진. worker_reports(clear:true) 1회로 회수하면 예산이 다시 찬다.'
          sinkReport(text)
          const chat = deliverToOwner(ownerId, text)
          if (chat !== 'steer' && chat !== 'followup') state.digestSent = false
          probe('digest owner=' + ownerId.slice(-8) + ' held=' + state.suppressed.length + ' chat=' + chat)
        }
        return
      }
      if (Date.now() - state.lastAt < MIN_NOTIFY_GAP_MS) {
        state.timer = setTimeout(() => { state.timer = undefined; scheduleNotify(ownerId) }, MIN_NOTIFY_GAP_MS)
        return
      }
      const batch = state.items.filter((report) => report.delivered !== true)
      state.items = []
      for (const report of batch) report.delivered = true
      state.count += 1
      state.lastAt = Date.now()
      const head = '[WORKER REPORT' + (batch.length > 1 ? 'S x' + batch.length : '') + ']\n'
      const tag = (report) => '[' + report.role + ' ' + String(report.worker_id).slice(-8) + '] '
      const clip = (report) => {
        const full = String(report.text ?? '')
        if (full.length <= CHAT_REPORT_MAX) return full
        return full.slice(0, CHAT_REPORT_MAX) + '…\n(전문 ' + report.chars + '자: 필요할 때만 worker_result({worker_id:"' + report.worker_id + '"}) 또는 산출물 파일)'
      }
      const text = head + batch.map((report) => tag(report) + clip(report)).join('\n\n')
      sinkReport(head + batch.map((report) => tag(report) + report.text).join('\n\n'))
      const chat = deliverToOwner(ownerId, text)
      if (chat === 'steer' || chat === 'followup') {
        // The chat copy is the report: drop it from the queue so worker_reports()
        // cannot hand the same output back twice.
        for (const report of batch) {
          const index = reports.indexOf(report)
          if (index >= 0) reports.splice(index, 1)
        }
      }
      probe('notify owner=' + ownerId.slice(-8) + ' reports=' + batch.length + ' chat=' + chat)
    }, 1500)
    if (typeof state.timer?.unref === 'function') state.timer.unref()
    armFlush(ownerId, state)
  }

  /** Hand a finished worker's output to its own coordinator only. */
  const publishReport = (worker) => {
    // A dispatch that produced no text of its own must not re-send the previous
    // dispatch's output as if it were new (finish, cancel, silent turn end).
    if (worker.textSinceDispatch === false) {
      probe('report skipped (no output since dispatch) ' + String(worker.id).slice(-8))
      return undefined
    }
    // worker_verify returns this turn's verdict itself: a chat copy would be read twice.
    if (worker.role === 'verifier' && worker.awaitingVerify === true) return undefined
    const text = String(worker.text ?? '').trim()
    if (text === '') return undefined
    // The in-memory key dies with a reload; the registry copy survives it, so a
    // resumed or adopted worker cannot re-report the output it finished with. Only
    // until its first dispatch here: the same words answering a new task are a new
    // report (ha_2 H3). The copy is the untrimmed text cut at 4000 chars with its
    // full length, so compare untrimmed to untrimmed (ha_3 F5).
    const persisted = registry[worker.id]
    const persistedText = persisted?.text
    const raw = String(worker.text ?? '')
    const samePersisted = worker.dispatchSeq === undefined && typeof persistedText === 'string' &&
      persistedText === raw.slice(0, 4000) && Number(persisted.chars ?? persistedText.length) === raw.length
    if (worker.reportedText === text || samePersisted) {
      probe('report deduped ' + String(worker.id).slice(-8) + ' (persisted=' + (typeof persistedText === 'string') + ')')
      return undefined
    }
    worker.reportedText = text
    const payload = {
      worker_id: worker.id,
      owner: worker.owner,
      role: worker.role ?? 'worker',
      status: worker.status,
      chars: text.length,
      text: text.length > 6000 ? text.slice(0, 6000) + '…' : text,
      at: Date.now(),
    }
    reports.push(payload)
    if (reports.length > 64) reports.shift()
    const ownerId = worker.owner
    if (typeof ownerId !== 'string' || ownerId === '') {
      probe('report queued without owner: ' + String(worker.id).slice(-8))
      return payload
    }
    const state = notifyState.get(ownerId) ?? { agent: worker.ownerAgent, items: [], timer: undefined, count: 0, lastAt: 0, suppressed: [], digestSent: false }
    state.agent = worker.ownerAgent ?? state.agent
    state.items.push(payload)
    notifyState.set(ownerId, state)
    scheduleNotify(ownerId)
    return payload
  }

  /** Reclaim slots from workers nobody collected (default 120 min idle). */
  const reapIdle = () => {
    const now = Date.now()
    for (const worker of [...workers.values()]) {
      // A long run_code emits no event: never reap a turn still running (ha_2 H6).
      if (isRunning(worker)) continue
      // Verifiers are per coordinator and nothing else closes one whose coordinator
      // ended without a full transfer: each would hold a global slot (ha_2 H2, ha_3 F1).
      // worker_verify makes a new one on demand.
      const ttl = (worker.role === 'verifier' ? VERIFIER_TTL_MINUTES : worker.ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60000
      if (now - (worker.updatedAt ?? worker.startedAt ?? now) < ttl) continue
      probe('ttl reap ' + worker.id.slice(-8) + ' idle=' + Math.round((now - worker.updatedAt) / 60000) + 'm')
      finishWorker(worker.id).catch((error) => probe('ttl reap failed: ' + String(error?.message ?? error).slice(0, 100)))
    }
  }
  {
    const timer = setInterval(() => { try { reapIdle() } catch (error) { probe('reaper failed: ' + String(error?.message ?? error).slice(0, 100)) } }, 60000)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  /** Finish one worker: report, close its window, free the slot (session persists). */
  const finishWorker = async (workerId) => {
    const worker = workers.get(workerId)
    if (worker === undefined) {
      const record = registry[workerId]
      if (record !== undefined) {
        // Already released by a previous process: acknowledge, do not throw.
        return { worker_id: workerId, role: record.role ?? 'worker', finished: true, provider: record.provider ?? '', model: record.model ?? '', chars: Number(record.chars ?? 0), text: String(record.text ?? '') }
      }
      throw new Error('unknown worker "' + workerId + '"')
    }
    if (worker.finished === true) return summary(worker)
    worker.finished = true
    publishReport(worker)
    let closedWindow = false
    try {
      closedWindow = globalThis[Symbol.for('dsh.gui.window')]?.close?.(worker.id) === true
    } catch (error) {
      probe('gui close failed: ' + String(error?.message ?? error).slice(0, 120))
    }
    if (!closedWindow) {
      try { ctx.emit?.('worker/finished', { sessionId: worker.id, role: worker.role ?? 'worker' }) } catch (error) {
        probe('finish emit failed: ' + String(error?.message ?? error).slice(0, 120))
      }
    }
    worker.status = 'finished'
    try { await worker.handle.dispose?.() } catch (error) {
      probe('finish dispose failed: ' + String(error?.message ?? error).slice(0, 120))
    }
    // The archive answers worker_result: never hand back a previous dispatch's text as this one's.
    const finishedText = worker.textSinceDispatch === false ? '' : String(worker.text ?? '')
    archived.set(worker.id, { ...summary(worker), text: finishedText, finishedAt: Date.now() })
    // Keep owner/role even when the record was trimmed: a record without owner
    // makes the real owner's status/resume fail the cross-session check.
    registry[worker.id] = { owner: worker.owner, role: worker.role ?? 'worker', model: worker.model, ...registry[worker.id], state: 'finished', chars: finishedText.length, text: finishedText.slice(0, 4000), at: Date.now() }
    saveRegistry()
    workers.delete(worker.id)
    probe('finish ' + worker.id.slice(-8) + ' role=' + (worker.role ?? 'worker') + ' window_closed=' + closedWindow)
    return { ...summary(worker), finished: true }
  }

  /**
   * Finish an auto_finish worker once its agent is really idle. turn/end closes one
   * turn, not the activity: a queued followup starts another turn. Keep re-checking
   * on a timer while the agent runs; a later turn/end finds this chain already armed.
   */
  const autoFinishLater = (worker, deferred = false) => {
    if (worker.autoFinishArmed === true && !deferred) return
    worker.autoFinishArmed = true
    setTimeout(() => {
      if (worker.finished === true || workers.get(worker.id) !== worker) { worker.autoFinishArmed = false; return }
      if (liveStatus(worker) === 'running') {
        if (!deferred) probe('auto-finish deferred ' + worker.id.slice(-8))
        worker.status = 'running'
        autoFinishLater(worker, true)
        return
      }
      worker.autoFinishArmed = false
      finishWorker(worker.id).catch((error) => probe('auto-finish failed: ' + String(error?.message ?? error).slice(0, 120)))
    }, 1200)
  }

  const hasQueuedInput = (worker) => { try { return worker.handle?.agent?.inbox?.hasPending === true } catch { return false } }

  /** The dispatch's work is over: mark errors and silent turns, then report or auto-finish. */
  const closeWork = (worker, reason) => {
    if (reason?.kind === 'error' || reason?.kind === 'blocked') {
      // An error or a rejected step can end the turn with no text; without a marker
      // publishReport() drops the empty report and the coordinator never hears of it.
      const detail = reason.kind === 'error' ? String(reason.error?.message ?? reason.error?.code ?? 'unknown').slice(0, 300) : 'step rejected'
      worker.error = detail
      // The app never rejects whenIdle, so track()'s safety valve cannot fire:
      // retract the readiness proof for this worker's shape here.
      if (reason.kind === 'error') invalidateProbeCache(worker, worker.handle, 'turn error')
      // Keep only this dispatch's text: the previous dispatch's output was already reported.
      worker.text = (worker.textSinceDispatch === true && worker.text ? worker.text + '\n\n' : '') + '[턴 ' + (reason.kind === 'error' ? '오류' : '차단') + ' 종료: ' + detail + ']'
      worker.textSinceDispatch = true
    } else if (worker.textSinceDispatch === false) {
      // Nothing written since the dispatch: say so instead of re-sending the previous output.
      worker.text = '[턴 종료(' + String(reason?.kind ?? 'unknown') + '): 이번 지시의 출력 없음]'
      worker.textSinceDispatch = true
    }
    if (worker.autoFinish === false) { publishReport(worker); return }
    // Let the caller's tool result land before reporting and closing.
    autoFinishLater(worker)
  }

  /**
   * A turn/end with queued input opens the next turn, whose own turn/end closes the
   * work (even a turn that claims nothing ends with turn/end). This is a safety net
   * for the rare idle without that turn (turn/start append failure, an abort between
   * turns): re-check the live agent and close the work if no later turn/end did.
   * It watches one task only: a new dispatch ends the watch (ha_3 F4).
   */
  const watchContinuation = (worker) => {
    if (worker.continuationWatch === true) return
    worker.continuationWatch = true
    const seq = worker.dispatchSeq
    const check = () => {
      if (worker.finished === true || workers.get(worker.id) !== worker || worker.dispatchSeq !== seq) { worker.continuationWatch = false; return }
      if (liveStatus(worker) === 'running') { const again = setTimeout(check, 1500); if (typeof again?.unref === 'function') again.unref(); return }
      worker.continuationWatch = false
      if (worker.status !== 'running') return // a later turn/end already closed the work
      worker.status = 'idle'
      probe('continuation closed without turn/end ' + String(worker.id).slice(-8))
      closeWork(worker, { kind: 'completed' })
    }
    const timer = setTimeout(check, 1500)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  const textOf = (message) => {
    const content = message?.content
    if (!Array.isArray(content)) return ''
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
  }

  let agentsCtx
  try {
    ctx.inject(['agents'], (agentCtx) => {
      agentsCtx = agentCtx
      probe('agents-injected=' + safeType(() => agentCtx.agents?.create))
    })
    probe('inject=ok')
  } catch (error) {
    probe('inject=failed ' + describeError(error))
  }

  const agentService = () => {
    if (agentsCtx !== undefined) {
      const injected = agentsCtx.agents
      if (injected !== undefined && typeof injected.create === 'function') return injected
    }
    try {
      const direct = ctx.agents
      if (direct !== undefined && typeof direct.create === 'function') return direct
    } catch {}
    for (const key of ['agents', 'agent', 'agentService']) {
      try {
        const service = ctx.get?.(key)
        if (service !== undefined && typeof service.create === 'function') return service
      } catch {}
    }
    throw new Error('worker-orchestrator: Agent service not available')
  }

  const resolve = (workerId) => {
    const worker = workers.get(workerId)
    if (worker === undefined) {
      // A reload drops the live map but keeps the registry. Rebuild a finished
      // stub from the record instead of failing: finish/status stay idempotent
      // and no slot is consumed (the stub never enters the live map).
      const record = registry[workerId]
      if (record === undefined) throw new Error('unknown worker "' + workerId + '": call worker_spawn first')
      const owner = requireCaller()
      if (record.owner !== owner) {
        throw new Error('cross-session control refused: worker "' + String(workerId).slice(-12) + '" belongs to another session (' + String(record.owner).slice(-12) + ')')
      }
      // No live handle either way; only a finished record is reported as finished.
      const done = record.state === 'finished'
      return {
        id: workerId,
        owner: record.owner,
        role: record.role ?? 'worker',
        finished: done,
        status: done ? 'finished' : 'released',
        text: String(record.text ?? ''),
        provider: record.provider ?? '',
        model: record.model ?? '',
        chars: Number(record.chars ?? 0),
        handle: undefined,
        autoFinish: false,
        startedAt: Number(record.at ?? Date.now()),
        updatedAt: Date.now(),
      }
    }
    const owner = requireCaller()
    if (worker.owner !== owner) {
      throw new Error('cross-session control refused: worker "' + String(workerId).slice(-12) + '" belongs to another session (' + String(worker.owner).slice(-12) + ')')
    }
    return worker
  }

  const summary = (worker) => ({
    worker_id: worker.id,
    role: worker.role ?? 'worker',
    effort: worker.effort ?? null,
    finished: worker.finished === true,
    provider: worker.provider,
    model: worker.model,
    // A live agent that is running wins over bookkeeping (turn/end already said
    // idle while a queued followup runs); finished/error/idle keep their own value.
    status: worker.finished !== true && liveStatus(worker) === 'running' ? 'running' : worker.status,
    chars: worker.text.length,
    error: worker.error ?? null,
    since: new Date(worker.startedAt).toISOString(),
  })

  const track = (worker, promise) => {
    worker.idle = Promise.resolve(promise)
      .then(() => { worker.status = 'idle' })
      .catch((error) => {
        worker.status = 'error'
        worker.error = describeError(error)
        invalidateProbeCache(worker, worker.handle, 'worker error')
      })
      .finally(() => { worker.updatedAt = Date.now() })
    return worker.idle
  }

  const presetService = () => {
    try { return ctx.get?.('agentPresets') } catch { return undefined }
  }

  /** Mirror the API controller: record the preset, then mount its tool composition. */
  const compose = async () => {
    const presets = presetService()
    if (presets === undefined) return undefined
    try {
      const resolved = await presets.resolve(undefined)
      const presetId = resolved.id
      return {
        agentPreset: presetId,
        setup: async (agentCtx, agent) => {
          try { agent?.session?.append?.('agent-preset/selected', { agentPreset: presetId }) } catch (error) {
            probe('preset record failed: ' + String(error?.message ?? error).slice(0, 100))
          }
          await presets.mount(agentCtx, presetId)
        },
      }
    } catch (error) {
      probe('preset resolve failed: ' + String(error?.message ?? error).slice(0, 120))
      return undefined
    }
  }

  const rejected = []
  const register = (definition) => {
    try {
      ctx.tools.register(definition)
      return true
    } catch (error) {
      const detail = 'register ' + definition.name + ' failed: ' + describeError(error)
      rejected.push(detail)
      probe(detail)
      return false
    }
  }

  const defs = []

  const modelFamily = (model) => {
    const value = String(model ?? '').toLowerCase()
    if (value.includes('glm')) return 'glm'
    if (value.includes('deepseek')) return 'deepseek'
    return value.split('/')[0] || 'unknown'
  }

  // The verifier route: override both when your DSH has no such provider/model.
  const VERIFIER_PROVIDER = ENV.DSH_ORCH_VERIFIER_PROVIDER || 'vercel-pareto'
  const VERIFIER_MODEL = ENV.DSH_ORCH_VERIFIER_MODEL || 'deepseek/deepseek-v4.1-flash-1017'
  // high, not max: live 11-18 a max verifier spent ~1.05M tokens on one claim, no verdict.
  const VERIFIER_EFFORT = 'high'
  const VERIFY_MAX_CALLS = 8
  // After a verify timed out, how long the verifier may still finish before it is stopped.
  const VERIFY_STOP_GRACE_MS = 60000
  const GLM_EFFORT = 'max'

  /**
   * Hide MAIN-only tools from a worker session. One unknown name (gui_* when the
   * GUI plugin is not loaded) makes the app reject the whole call, so fall back to
   * denying name by name instead of silently leaving every tool visible.
   */
  const restrictWorker = (handle, sessionId) => {
    const tag = String(sessionId).slice(-8)
    const tools = handle?.agent?.ctx?.tools
    // An app without restrict cannot be helped here: record it and go on (all live
    // logs so far show "restrict ok").
    if (typeof tools?.restrict !== 'function') { probe('restrict unavailable ' + tag); return }
    try {
      tools.restrict({ deny: WORKER_DENIED })
      probe('restrict ok ' + tag)
    } catch (error) {
      const failed = []
      for (const name of WORKER_DENIED) { try { tools.restrict({ deny: [name] }) } catch { failed.push(name) } }
      probe('restrict partial ' + tag + ' failed=' + failed.join(',') + ' first=' + String(error?.message ?? error).slice(0, 80))
      // gui_* may be absent (GUI plugin not loaded); our own worker_* must be hidden,
      // or a worker can spawn, dispatch and verify as if it were a coordinator.
      const open = failed.filter((name) => name.startsWith('worker_'))
      if (open.length > 0) throw new Error('could not hide ' + open.join(',') + ' from worker ' + tag)
    }
  }

  const createWorker = async (args, callerCwd, role, ownerId) => {
    // Owner is fixed before any await: the global caller id can be overwritten by
    // another session's tool call while this creation is in flight.
    const owner = ownerId ?? requireCaller()
    const nowMs = Date.now()
    while (spawnTimes.length > 0 && nowMs - spawnTimes[0] > 60000) spawnTimes.shift()
    if (spawnTimes.length >= MAX_SPAWN_PER_MINUTE) {
      throw new Error('spawn rate guard: ' + spawnTimes.length + ' workers created in the last 60s (max ' + MAX_SPAWN_PER_MINUTE + '). Stop and consolidate — a dispatch/finish loop is not progress.')
    }
    spawnTimes.push(nowMs)
    const sessionId = 'session-' + randomUUID()
    const cwd = args.cwd ?? callerCwd ?? process.cwd()
    const family = modelFamily(args.model)
    // GLM always reasons at its ceiling: it carries adversarial verification,
    // where a shallow pass costs more than the tokens it saves.
    const effort = family === 'glm' ? GLM_EFFORT : args.effort
    const agentOptions = { provider: args.provider, model: args.model }
    if (effort !== undefined) agentOptions.reasoningEffort = effort
    const composition = await compose()
    const handle = await agentService().create({
      sessionId,
      meta: { cwd },
      agentOptions,
      ...(composition === undefined ? {} : { setup: composition.setup }),
    })
    // Hide MAIN-only tools before the worker enters the pool; a worker that cannot
    // be restricted is disposed instead of joining with coordinator powers.
    try { restrictWorker(handle, sessionId) } catch (error) {
      try { await handle?.dispose?.() } catch {}
      throw error
    }
    const now = Date.now()
    workers.set(sessionId, {
      id: sessionId,
      handle,
      role,
      owner,
      ownerAgent: callerAgentRef,
      autoFinish: role === 'verifier' ? false : args.auto_finish === true,
      ttlMinutes: args.ttl_minutes,
      finished: false,
      provider: args.provider,
      model: args.model,
      effort,
      status: 'idle',
      text: '',
      error: undefined,
      prompt: undefined,
      startedAt: now,
      updatedAt: now,
      idle: undefined,
    })
    registry[sessionId] = { owner, role, model: args.model, at: now }
    saveRegistry()
    probe('spawn ' + sessionId.slice(-8) + ' role=' + role + ' owner=' + owner.slice(-8) + ' ' + args.model)
    return { worker_id: sessionId, role, provider: args.provider, model: args.model, effort: effort ?? null, status: 'idle' }
  }

  /**
   * One adversarial verifier per coordinator (DeepSeek Flash, effort high), created
   * by the first worker_verify — never by a spawn: a verifier is paid for only when a
   * claim needs one. Dispatch checks ownership per coordinator, so a single shared
   * verifier was refused to every coordinator but the one that created it. Concurrent
   * calls of one coordinator share its in-flight creation (plugin.log once showed 2~4
   * verifiers created in the same second).
   */
  const ensureVerifier = async (callerCwd, owner) => {
    for (const worker of workers.values()) if (worker.role === 'verifier' && worker.owner === owner && worker.finished !== true) return worker
    const inFlight = verifierPending.get(owner)
    if (inFlight !== undefined) return inFlight
    if (slotsInUse() >= MAX_WORKERS) return undefined
    const creating = createWorker({ provider: VERIFIER_PROVIDER, model: VERIFIER_MODEL, effort: VERIFIER_EFFORT }, callerCwd, 'verifier', owner)
      .then((created) => workers.get(created.worker_id))
    verifierPending.set(owner, creating)
    try { return await creating } finally { verifierPending.delete(owner) }
  }

  /** What the worker can actually call: a spawn without run_code is a dead worker. */
  /**
   * The worker's callable tools, or undefined when introspection is unavailable.
   * `undefined` must not read as "no tools": that would fail healthy workers.
   */
  const toolSurface = (handle) => {
    try {
      const agentCtx = handle?.agent?.ctx
      const view = agentCtx?.tools?.view
      if (typeof view !== 'function') return undefined
      const snapshot = view.call(agentCtx.tools, handle.agent)
      const visible = snapshot?.visible
      if (visible instanceof Map) return [...visible.keys()].map(String)
      if (Array.isArray(visible)) return visible.map(String)
      return undefined
    } catch (error) {
      probe('tool surface failed: ' + String(error?.message ?? error).slice(0, 100))
      return undefined
    }
  }

  // Below the coordinator's run_code default timeout (120 s, dsh-ptc-runtime-node):
  // a wait that ends at 120 s loses the race and the timed_out result is discarded.
  const WAIT_TIMEOUT_MS = 100000
  const PROBE_TIMEOUT_MS = 90000
  // Returns true if the wait hit the timeout (worker not idle yet), false if it settled.
  const waitSettled = async (worker, timeoutMs) => {
    const idle = worker.idle ?? Promise.resolve()
    let timer
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); if (typeof timer?.unref === 'function') timer.unref() })
    const outcome = await Promise.race([Promise.resolve(idle).then(() => 'settled'), timeout])
    clearTimeout(timer)
    return outcome === 'timeout'
  }

  // #region probe-cache-policy
  // Pure policy: no imports, no module scope. The offline test extracts this
  // region verbatim, so the text under test is the text that ships.
  const createProbeCachePolicy = ({ ttlMs, max, now, log = () => {} }) => {
    const entries = new Map()
    const keyOf = (worker, preset) => [
      String(worker?.provider ?? ''),
      String(worker?.model ?? ''),
      String(preset ?? 'default'),
      String(worker?.effort ?? 'default'),
    ].join('|')
    const sweep = () => {
      const at = now()
      for (const [key, entry] of entries) if (at - entry.at >= ttlMs) entries.delete(key)
      while (entries.size > max) {
        let oldestKey
        let oldestAt = Infinity
        for (const [key, entry] of entries) if (entry.at < oldestAt) { oldestAt = entry.at; oldestKey = key }
        if (oldestKey === undefined) break
        entries.delete(oldestKey)
      }
    }
    return {
      keyOf,
      size: () => entries.size,
      get(worker, preset) {
        const key = keyOf(worker, preset)
        const entry = entries.get(key)
        if (entry === undefined) return { key, hit: false }
        const ageMs = now() - entry.at
        if (ageMs >= ttlMs) { entries.delete(key); return { key, hit: false, expired: true } }
        return { key, hit: true, ageMs, entry }
      },
      store(worker, preset, value) {
        sweep()
        const key = keyOf(worker, preset)
        entries.set(key, { at: now(), ...value })
        log('probe cache store key=' + key)
        return key
      },
      invalidate(worker, preset, reason) {
        const key = keyOf(worker, preset)
        const removed = entries.delete(key)
        if (removed) log('probe cache invalidate key=' + key + ' reason=' + reason)
        return removed
      },
    }
  }
  // #endregion probe-cache-policy

  const probeCachePolicy = createProbeCachePolicy({ ttlMs: PROBE_CACHE_TTL_MS, max: PROBE_CACHE_MAX, now: () => Date.now(), log: probe })

  // #region probe-verify-core
  /**
   * The probe decision itself: every side effect is injected, so the plugin and
   * the offline test run the same lines. A spawn is not success; a worker that
   * answers 391 is. A cached key answers for a fresh worker of the same shape.
   */
  const runProbeVerification = async ({ worker, preset, policy, surface, dispatchProbe, settle, toolCalls = () => undefined, log = () => {} }) => {
    const found = policy.get(worker, preset)
    if (found.hit === true) {
      // Surface introspection stays advisory: it never fails a cached worker.
      const cachedSurface = surface()
      const cachedStructural = cachedSurface !== undefined && cachedSurface.includes('run_code') ? true : found.entry.structural
      log('probe cache hit key=' + found.key + ' ageMs=' + found.ageMs)
      return { verified: true, cached: true, structural: cachedStructural, answered: found.entry.answered, preset: preset ?? null, tools: cachedSurface ?? found.entry.tools, latencyMs: 0, sample: found.entry.sample, error: null }
    }
    const startSurface = surface()
    // run_code is a reserved dispatcher, not a registered tool, so the visible
    // surface never lists it in code mode: absence proves nothing (null = unknown).
    const structural = startSurface !== undefined && startSurface.includes('run_code') ? true : null
    let text = ''
    let error
    let timedOut = false
    const startedAt = Date.now()
    try {
      await dispatchProbe()
      timedOut = (await settle()) === true
      text = String(worker.text ?? '').trim()
    } catch (caught) {
      error = String(caught?.message ?? caught)
    }
    const latencyMs = Date.now() - startedAt
    // 391 is the expected answer. A model can compute 17*23 without run_code, so the
    // number alone does not prove the tool path. The worker still passes (rejecting a
    // healthy worker that answered from its head costs a spawn), but only a probe that
    // actually issued run_code is cached as proof for later workers of this shape.
    // toolCalls() is undefined where calls cannot be counted: the answer alone counts.
    // A probe turn that ended in error or a blocked step fails even with 391 in its
    // text, and a turn still running at the timeout proves nothing for the cache.
    const answered = /391/.test(text)
    const verified = answered === true && !worker.error
    const runCodeCalls = toolCalls()
    const proven = verified && !timedOut && (runCodeCalls === undefined || runCodeCalls >= 1)
    const result = { verified, cached: false, structural, answered, runCodeCalls: runCodeCalls ?? null, preset: preset ?? null, tools: startSurface ?? null, latencyMs, sample: text.slice(0, 80), error: error ?? worker.error ?? null }
    if (proven) {
      policy.store(worker, preset, { structural, answered, tools: result.tools, sample: result.sample })
    } else if (verified) {
      log('probe not cached (' + (timedOut ? 'timed out' : 'answered without run_code') + ') worker=' + String(worker.id ?? '').slice(-8))
    } else {
      // A failed probe proves nothing: never let an older entry stand in for it.
      policy.invalidate(worker, preset, 'probe failed')
    }
    log('verify worker=' + String(worker.id ?? '').slice(-8) + ' verified=' + result.verified + ' structural=' + structural + ' answered=' + answered + ' run_code=' + (runCodeCalls ?? 'n/a') + ' ms=' + latencyMs)
    return result
  }
  // #endregion probe-verify-core

  const verifyPresetOf = (handle) => { try { return handle?.agent?.session?.header?.agentPreset } catch { return undefined } }

  // Spawns of one shape that miss the cache together share the first probe: the later
  // ones wait for it and then read the proof it stored (x2 B2: get→get→two probes).
  const probeInflight = new Map()
  const verifyWorker = async (worker, handle) => {
    const preset = verifyPresetOf(handle)
    const key = probeCachePolicy.keyOf(worker, preset)
    const prior = probeInflight.get(key)
    if (prior !== undefined) { try { await prior } catch {} }
    const run = probeOnce(worker, handle, preset)
    if (prior === undefined) {
      probeInflight.set(key, run)
      const clear = () => { if (probeInflight.get(key) === run) probeInflight.delete(key) }
      run.then(clear, clear)
    }
    return run
  }

  const probeOnce = (worker, handle, preset) => runProbeVerification({
    worker,
    preset,
    policy: probeCachePolicy,
    surface: () => toolSurface(handle),
    // Internal dispatch on the worker object: the ownership check reads the global
    // caller id, which another session's tool call may have changed during spawn.
    // One bounded wait (not wait:true + settle = 120 s + 90 s): the coordinator's
    // run_code times out at 120 s by default, and then the spawn result is lost.
    dispatchProbe: async () => dispatch({ worker_id: worker.id, prompt: 'Readiness probe: use run_code to compute 17*23, then reply with only the number.' }, worker),
    settle: () => waitSettled(worker, PROBE_TIMEOUT_MS),
    toolCalls: () => worker.callCount,
    log: probe,
  })

  /**
   * Safety valve: a worker that really failed retracts the proof for its key, so
   * the next spawn of this shape pays for a fresh probe instead of trusting it.
   */
  const invalidateProbeCache = (worker, handle, reason) => {
    try { return probeCachePolicy.invalidate(worker, verifyPresetOf(handle), reason) } catch { return false }
  }

  const spawnWorker = async (args, callerCwd) => {
    const spawnOwner = requireCaller()
    // The app does not validate tool arguments against the schema: check by hand.
    if (args.ttl_minutes !== undefined && !(typeof args.ttl_minutes === 'number' && Number.isFinite(args.ttl_minutes) && args.ttl_minutes >= 1 && args.ttl_minutes <= 1440)) {
      throw new Error('ttl_minutes must be a number from 1 to 1440')
    }
    if (concurrencyDecision({ workers: liveWorkers(), owner: spawnOwner, pending: pendingSpawns.get(spawnOwner) ?? 0 }).slotsFull) throw new Error('슬롯 8 초과: idle 워커를 결과 회수 후 worker_finish 한 뒤 spawn')
    if (slotsInUse() >= MAX_WORKERS) throw new Error('worker limit reached (' + MAX_WORKERS + ', 검증자·다른 코디 일꾼 포함 전역 칸): idle 워커를 결과 회수 후 worker_finish 한 뒤 spawn')
    // Diversity gate over producers: the verifier is excluded, so hiring the
    // verifier never excuses a producer monoculture.
    const family = modelFamily(args.model)
    // Only this coordinator's concurrent producers count: a short-lived worker that
    // already answered is not a monoculture, the verifier is excluded,
    // and another coordinator's workers are not this coordinator's mix.
    const producers = [...workers.values()].filter((worker) => worker.owner === spawnOwner && worker.role !== 'verifier' && isRunning(worker))
    const families = new Set(producers.map((worker) => modelFamily(worker.model)))
    if (args.allow_model_repeat !== true && producers.length >= 1 && families.size === 1 && families.has(family)) {
      const other = family === 'deepseek' ? 'zai/glm-5.3-flash' : 'deepseek/deepseek-v4.1-flash-1017'
      throw new Error('model-diversity gate: ' + producers.length + ' producer(s) already run ' + family + '. Spawn this role on ' + other + ' (worker-orchestration §2), or pass allow_model_repeat:true when a second model genuinely adds nothing.')
    }
    pendingSpawns.set(spawnOwner, (pendingSpawns.get(spawnOwner) ?? 0) + 1)
    let created
    try { created = await createWorker(args, callerCwd, 'worker', spawnOwner) } finally {
      const remaining = pendingSpawns.get(spawnOwner) - 1
      if (remaining) pendingSpawns.set(spawnOwner, remaining); else pendingSpawns.delete(spawnOwner)
    }
    const worker = workers.get(created.worker_id)
    let readiness = { verified: false, skipped: true }
    if (worker !== undefined && args.verify !== false) {
      if (worker !== undefined) worker.verifying = true
      readiness = await verifyWorker(worker, worker.handle)
      worker.verifying = false
      worker.verified = readiness.verified === true
      if (readiness.verified !== true) {
        // A failed probe must not leave a cached proof behind for the next spawn.
        invalidateProbeCache(worker, worker.handle, 'verification failed')
        // Clean up before failing: a half-alive worker must not linger in the pool.
        try { await worker.handle?.dispose?.() } catch {}
        workers.delete(worker.id)
        throw new Error('worker_spawn failed verification: ' + JSON.stringify({
          preset: readiness.preset,
          hasRunCode: readiness.structural,
          answered: readiness.answered,
          sample: readiness.sample,
          error: readiness.error,
          latencyMs: readiness.latencyMs,
        }) + ' — the worker session exists but cannot run. Fix the cause before dispatching work.')
      }
    }
    // No verifier here: worker_verify creates one when a claim meets the skill's
    // verification criteria (a spawn-time verifier held a slot and was paid for always).
    return { ...created, verified: readiness.verified === true, readiness }
  }

  /** Hand workers (and their registry records) to another coordinator session. */
  const transferWorkers = async (args) => {
    const caller = requireCaller()
    const target = String(args.to_session_id ?? '')
    if (target === '') throw new Error('to_session_id is required')
    if (target === caller) throw new Error('target session already owns these workers')
    const only = Array.isArray(args.worker_ids) && args.worker_ids.length > 0 ? new Set(args.worker_ids) : undefined
    const moved = []
    for (const [id, record] of Object.entries(registry)) {
      if (record.owner !== caller) continue
      if (only !== undefined && !only.has(id)) continue
      // A verifier stays with its coordinator: the target keeps or creates its own,
      // and a second one would never be reclaimed (TTL skips verifiers).
      if (record.role === 'verifier') continue
      registry[id] = { ...record, owner: target, at: Date.now() }
      const live = workers.get(id)
      if (live !== undefined) { live.owner = target; live.ownerAgent = undefined }
      moved.push(id)
    }
    saveRegistry()
    // Reports already queued (or held over the notify budget) follow their workers;
    // otherwise they stay addressed to the old coordinator, which may be gone.
    const movedIds = new Set(moved)
    for (const report of reports) if (movedIds.has(report.worker_id)) report.owner = target
    const from = notifyState.get(caller)
    if (from !== undefined) {
      const take = (list) => { const out = list.filter((report) => movedIds.has(report.worker_id)); list.splice(0, list.length, ...list.filter((report) => !movedIds.has(report.worker_id))); return out }
      const items = take(from.items)
      const held = take(from.suppressed ?? [])
      if (items.length + held.length > 0) {
        const to = notifyState.get(target) ?? { agent: undefined, items: [], timer: undefined, count: 0, lastAt: 0, suppressed: [], digestSent: false }
        to.items.push(...items, ...held.map((report) => { report.delivered = false; return report }))
        notifyState.set(target, to)
        scheduleNotify(target)
      }
    }
    // A full transfer is a rotation: the old coordinator is leaving, so its verifier
    // (which stays behind) is closed here and its slot returned (ha_2 H2).
    const verifiersClosed = []
    if (only === undefined) {
      for (const worker of [...workers.values()]) {
        if (worker.role !== 'verifier' || worker.owner !== caller || worker.finished === true) continue
        try { await finishWorker(worker.id); verifiersClosed.push(worker.id) } catch (error) { probe('transfer verifier close failed: ' + String(error?.message ?? error).slice(0, 100)) }
      }
    }
    probe('transfer to=' + target.slice(-8) + ' workers=' + moved.length + ' verifiers_closed=' + verifiersClosed.length)
    return { from: caller, to_session_id: target, transferred: moved.length, workers: moved, verifiers_closed: verifiersClosed }
  }

  /**
   * A verify that timed out leaves the verifier running (live 11-18: 6 m 48 s and
   * ~1.05M tokens more, then cancelled with no verdict). Ask for the verdict now; if
   * that turn still runs after the grace period, abort it and close the verifier (its
   * text so far is still reported). The next worker_verify creates a new one.
   */
  const stopVerifierLater = (verifier) => {
    const seq = verifier.dispatchSeq
    const tag = String(verifier.id).slice(-8)
    const still = () => workers.get(verifier.id) === verifier && verifier.finished !== true && verifier.dispatchSeq === seq && isRunning(verifier)
    deliverLater(verifier.id, '[검증 시간 초과] 더 조회하지 말고 지금까지 확인한 것만으로 첫 줄에 VERDICT(PASS/FAIL/UNKNOWN) 1줄, 근거 3줄 이내를 쓰고 턴을 끝내라.', 'verify wrap-up ' + tag, still)
    const timer = setTimeout(() => {
      if (!still()) return
      probe('verify stop ' + tag + ' (running ' + VERIFY_STOP_GRACE_MS + 'ms after timeout)')
      try { verifier.handle.agent.cancel({ kind: 'user' }) } catch (error) { probe('verify stop cancel failed ' + tag + ': ' + describeError(error).slice(0, 120)) }
      finishWorker(verifier.id).catch((error) => probe('verify stop finish failed ' + tag + ': ' + String(error?.message ?? error).slice(0, 100)))
    }, VERIFY_STOP_GRACE_MS)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  // One claim (sentence + target + evidence) is verified once per coordinator: a PASS answers from memory, a FAIL may
  // be re-checked once after rework, an UNKNOWN (timeout, stop, no verdict) is not
  // re-run (live 11-18: 4 verifies, 1.89M tokens, no verdict).
  const verifyMemo = new Map() // owner -> Map(claim+target+evidence -> { verdict, runs })
  const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

  /** Attack one claim with this coordinator's verifier and return its verdict. */
  const verifyClaim = async (args, callerCwd) => {
    const owner = requireCaller() // before any await: the global caller id can change
    if (squash(args.claim) === '') throw new Error('claim is required: one or two sentences to attack')
    // The same sentence about another artifact or on new evidence is a new claim.
    const key = [args.claim, args.target, args.evidence].map(squash).join('\u0000')
    const memo = verifyMemo.get(owner) ?? new Map()
    verifyMemo.set(owner, memo)
    const prior = memo.get(key)
    if (prior !== undefined && (prior.verdict !== 'FAIL' || prior.runs >= 2)) {
      probe('verify refused (same claim) verdict=' + prior.verdict + ' runs=' + prior.runs + ' owner=' + owner.slice(-8))
      return {
        verifier_id: null, verdict: prior.verdict, repeated: true,
        text: '같은 주장은 다시 검증하지 않는다(이전 판정 ' + prior.verdict + ', ' + prior.runs + '회).' + (prior.verdict === 'UNKNOWN' ? ' 이 주장은 UNKNOWN 으로 보고하고, 늦은 [verifier] 보고가 오면 반영한다.' : ''),
      }
    }
    // Created here, not at spawn: give it the coordinator's workspace, not the app's cwd.
    const verifier = await ensureVerifier(args.cwd ?? callerCwd, owner)
    if (verifier === undefined) throw new Error('cannot attach the verifier: worker limit reached (' + MAX_WORKERS + ')')
    const tag = String(verifier.id).slice(-8)
    // A previous claim that timed out may still be running: a new claim would queue
    // behind it and that claim's late answer would be read as this claim's verdict.
    if (liveStatus(verifier) === 'running') {
      probe('verify verdict=UNKNOWN verifier=' + tag + ' reason=busy')
      return { verifier_id: verifier.id, model: VERIFIER_MODEL, effort: VERIFIER_EFFORT, verdict: 'UNKNOWN', busy: true, text: '' }
    }
    const prompt = [
      '[ROLE] 적대적 검증자. 동의 문장 금지. 반증만 시도한다. 주장을 그대로 믿지 않는다.',
      '[OUTPUT] 첫 줄에 판정 1줄만(VERDICT: PASS 또는 FAIL 또는 UNKNOWN, 다른 줄에 VERDICT 쓰지 말 것) / COUNTEREXAMPLE: 입력->기대->실제 / BROKEN_CLAIM: 문장 인용 / FIX: 최소 수정',
      args.target === undefined ? '' : '[TARGET] ' + args.target,
      '[CLAIM] ' + args.claim,
      args.evidence === undefined ? '' : '[EVIDENCE] ' + args.evidence,
      '[ATTACK] ' + (args.focus ?? '반례, 경계값·빈값, 근거 없는 단정, 재현 불가 주장, 보안·데이터 손상 경로, 다른 해석'),
      '[RULE] 이 주장 1개만 확인한다(범위 넓히기 금지). EVIDENCE 의 경로부터 본다. run_code 는 ' + VERIFY_MAX_CALLS + '회 안에 끝내고, 못 끝내면 UNKNOWN. 실제로 실행·확인한 결과만 쓴다.',
    ].filter((line) => line !== '').join('\n')
    // The cap counts this claim's run_code calls (dispatch sets it only for producers).
    verifier.maxCalls = VERIFY_MAX_CALLS
    verifier.callCount = 0
    verifier.awaitingVerify = true
    let vres
    try { vres = await dispatch({ worker_id: verifier.id, prompt, wait: true }, verifier) } finally { verifier.awaitingVerify = false }
    const runs = (prior?.runs ?? 0) + 1
    const remember = (verdict) => {
      memo.delete(key)
      memo.set(key, { verdict, runs })
      if (memo.size > 100) memo.delete(memo.keys().next().value)
    }
    // A turn that ended right at the timeout already skipped its chat copy: read it here.
    if (vres.timed_out === true && isRunning(verifier)) {
      remember('UNKNOWN')
      stopVerifierLater(verifier)
      probe('verify verdict=UNKNOWN verifier=' + tag + ' reason=timeout ' + WAIT_TIMEOUT_MS + 'ms')
      return { verifier_id: verifier.id, model: VERIFIER_MODEL, effort: VERIFIER_EFFORT, verdict: 'UNKNOWN', timed_out: true, text: '' }
    }
    // Only this dispatch's answer counts (an earlier PASS must not stand in for it),
    // a turn that ended in error is UNKNOWN, and every "VERDICT: X" line must agree
    // (a FIX note "VERDICT: PASS 로 바뀜" after a FAIL makes it UNKNOWN, not PASS).
    const text = verifier.textSinceDispatch === true ? String(verifier.text ?? '') : ''
    // Returned here, so a later finish (TTL reap, rotation, transfer) must not re-send it.
    verifier.reportedText = text.trim()
    let verdict = 'UNKNOWN'
    let reason = 'turn error'
    if (!verifier.error) {
      const found = new Set([...text.matchAll(VERDICT_LINE)].map((match) => match[1].toUpperCase()))
      if (found.size === 1) verdict = [...found][0]
      reason = found.size === 0 ? 'no verdict line' : 'conflicting verdict lines'
    }
    remember(verdict)
    probe('verify verdict=' + verdict + ' verifier=' + tag + (verdict === 'UNKNOWN' ? ' reason=' + reason : ''))
    return { verifier_id: verifier.id, model: VERIFIER_MODEL, effort: VERIFIER_EFFORT, verdict, text }
  }

  /**
   * `known` is the plugin's own worker object for internal calls (readiness probe,
   * verifier): they must not re-run the ownership check, which reads the global
   * caller id that another session may have changed across an await.
   */
  const dispatch = async (args, known) => {
    const worker = known ?? resolve(args.worker_id)
    if (worker.handle === undefined) throw new Error('worker "' + String(worker.id).slice(-12) + '" has no live session handle (plugin reloaded or released): worker_resume it first, or worker_finish it')
    if (worker.finished === true) throw new Error('worker "' + String(worker.id).slice(-12) + '" is finished or finishing: worker_resume it first, or spawn a new one')
    // A direct dispatch would skip the busy guard and the call cap of worker_verify.
    if (known === undefined && worker.role === 'verifier') throw new Error('검증자에는 worker_dispatch 를 쓰지 않는다: worker_verify 로 주장 1개를 넘긴다')
    if (worker.role === 'worker') {
      // A dispatch to a running worker would queue behind its turn: the turn's output
      // then reads as the new task's result, or is lost, and an error turn leaves the
      // queued task unrun (ha_1 AD1-2, ha_3 F2·F3·F8). Refuse it instead.
      if (known === undefined && isRunning(worker)) throw new Error('worker "' + String(worker.id).slice(-12) + '" is running: dispatch after its report arrives (to correct it now: worker_cancel, then spawn again)')
      // The cap governs the coordinator's dispatches; the internal readiness probe of a
      // fresh spawn must not fail as "verification failed" because 4 others are running.
      if (known === undefined && concurrencyDecision({ workers: liveWorkers(), owner: worker.owner, targetId: worker.id }).runningFull) throw new Error('동시 실행 상한 4: 진행 중 일꾼이 끝난 뒤 dispatch')
      const maxCalls = args.max_calls === undefined ? 6 : args.max_calls
      if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 50) throw new Error('max_calls must be an integer from 1 to 50')
      worker.maxCalls = maxCalls
      worker.callCount = 0
    }
    // A call-cap notice left in the inbox (a stop that kept the inbox) would otherwise
    // be read first by this new task and end it at once.
    for (const noticeId of worker.capNoticeIds ?? []) { try { worker.handle.agent.inbox?.remove?.(noticeId) } catch {} }
    worker.capNoticeIds = []
    // Numbers this task: a call-cap notice still on its 0 ms timer, or a continuation
    // watch, from the previous task must not act on this one.
    worker.dispatchSeq = (worker.dispatchSeq ?? 0) + 1
    worker.prompt = args.prompt
    worker.reportedText = undefined
    worker.textSinceDispatch = false
    worker.error = undefined
    worker.status = 'running'
    worker.updatedAt = Date.now()
    try {
      await worker.handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: args.prompt }],
        source: { kind: 'user' },
      })
    } catch (error) {
      worker.status = 'error'
      worker.error = String(error?.message ?? error).slice(0, 200)
      worker.updatedAt = Date.now()
      invalidateProbeCache(worker, worker.handle, 'dispatch failed')
      throw error
    }
    track(worker, worker.handle.agent.whenIdle())
    let timedOut = false
    if (args.wait === true) {
      // Bounded wait: never freeze the caller's turn indefinitely on a stuck worker.
      timedOut = await waitSettled(worker, WAIT_TIMEOUT_MS)
      // A real task that ended in error retracts the key's proof (safety valve).
      if (!timedOut && worker.status === 'error') invalidateProbeCache(worker, worker.handle, 'task error')
    }
    return args.wait === true
      ? { worker_id: worker.id, status: worker.status, text: textOfThisDispatch(worker), timed_out: timedOut }
      : { worker_id: worker.id, status: worker.status }
  }

  // The previous dispatch's text is not this dispatch's result.
  const textOfThisDispatch = (worker) => (worker.textSinceDispatch === false ? '' : String(worker.text ?? ''))

  const statusOf = (args) => {
    if (args.worker_id !== undefined) return summary(resolve(args.worker_id))
    const owner = requireCaller()
    const live = [...workers.values()].filter((worker) => worker.owner === owner).map((worker) => ({ ...summary(worker), state: 'live' }))
    const liveIds = new Set(live.map((worker) => worker.worker_id))
    const persisted = Object.entries(registry)
      .filter(([id, record]) => record.owner === owner && !liveIds.has(id))
      .filter(([id]) => args.include_released === true || archived.has(id))
      .map(([id, record]) => ({
        worker_id: id,
        role: record.role,
        model: record.model,
        status: archived.has(id) ? 'finished' : 'persisted',
        chars: archived.get(id)?.chars ?? 0,
        state: archived.has(id) ? 'finished' : 'persisted',
      }))
    return { workers: [...live, ...persisted], handoff_dir: HANDOFF_DIR }
  }

  const resultOf = async (args) => {
    if (!workers.has(args.worker_id)) {
      // Deliberately readable by any coordinator that holds the id: after a rotation
      // the next coordinator collects the previous one's finished results this way
      // (handoff files carry the ids). The owner is returned so it is never ambiguous.
      const kept = archived.get(args.worker_id)
      if (kept !== undefined) return { worker_id: args.worker_id, status: 'finished', error: null, text: kept.text, archived: true, owner: registry[args.worker_id]?.owner ?? null }
    }
    const worker = resolve(args.worker_id)
    let timedOut = false
    if (args.wait === true && worker.idle !== undefined) timedOut = await waitSettled(worker, WAIT_TIMEOUT_MS)
    return { worker_id: worker.id, status: worker.status, error: worker.error ?? null, text: textOfThisDispatch(worker), timed_out: timedOut }
  }

  /**
   * Abort the running turn and finish the worker. The app's cancel takes an
   * AgentCancelCause object; a plain string hit its assertNever and left turn/end
   * with reason null. A cancelled handle used to stay in the pool disposed: a leaked
   * slot, and for a verifier every later worker_verify failed.
   */
  const cancel = async (args) => {
    const worker = resolve(args.worker_id)
    if (worker.handle === undefined || worker.finished === true) return { worker_id: worker.id, status: worker.status, finished: worker.finished === true }
    try { worker.handle.agent.cancel({ kind: 'user' }) } catch (error) { probe('cancel failed ' + String(worker.id).slice(-8) + ': ' + describeError(error).slice(0, 120)) }
    await finishWorker(worker.id)
    probe('cancel ' + String(worker.id).slice(-8) + ' role=' + (worker.role ?? 'worker'))
    return { worker_id: worker.id, status: 'cancelled', finished: true }
  }

  const resumeWorker = async (args) => {
    const caller = requireCaller()
    const record = registry[args.worker_id]
    if (record !== undefined && record.owner !== caller) {
      throw new Error('cross-session control refused: session "' + String(args.worker_id).slice(-12) + '" belongs to another session (' + String(record.owner).slice(-12) + '); it cannot be adopted by this session')
    }
    if (record === undefined) {
      throw new Error('refusing to adopt an unowned session "' + String(args.worker_id).slice(-12) + '": only sessions this coordinator spawned (worker_spawn) can be resumed')
    }
    // A revived verifier sat beside the new one, holding a slot that worker_verify never
    // used (live 11-18: cancel e6d598eb → new verifier → resume e6d598eb).
    if (record.role === 'verifier') {
      throw new Error('검증자는 worker_resume 하지 않는다: 다음 worker_verify 가 필요할 때 새로 만든다')
    }
    if (slotsInUse() >= MAX_WORKERS) {
      throw new Error('worker limit reached (' + MAX_WORKERS + '): finish an idle worker before resuming')
    }
    const agents = agentService()
    const found = agents.get?.(args.worker_id)
    // The registry stores Agents; a handle is what the tools drive.
    const live = found === undefined ? undefined : found.agent === undefined ? { agent: found } : found
    if (live !== undefined) {
      const existing = workers.get(args.worker_id)
      // Restriction is a layer on the agent's own scope: every adopted or resumed
      // agent needs it again, or the worker sees every MAIN-only tool.
      restrictWorker(live, args.worker_id)
      if (existing !== undefined) { existing.handle = live; return summary(existing) }
      const adopted = {
        id: args.worker_id, handle: live,
        role: registry[args.worker_id]?.role ?? 'worker',
        owner: caller,
        autoFinish: false,
        provider: args.provider ?? '', model: args.model ?? '',
        // A live agent may be mid-turn; its next turn/end sets idle.
        status: live.agent?.status === 'running' ? 'running' : 'idle', text: '', error: undefined, prompt: undefined,
        startedAt: Date.now(), updatedAt: Date.now(), idle: undefined,
      }
      workers.set(args.worker_id, adopted)
      return summary(adopted)
    }
    const agentOptions = args.provider === undefined || args.model === undefined
      ? undefined
      : { provider: args.provider, model: args.model }
    const composition = await compose()
    const handle = await agents.resume({
      resumeSessionId: args.worker_id,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(composition === undefined ? {} : { setup: composition.setup }),
    })
    try { restrictWorker(handle, args.worker_id) } catch (error) {
      try { await handle?.dispose?.() } catch {}
      throw error
    }
    const now = Date.now()
    const resumed = {
      id: args.worker_id, handle,
      role: registry[args.worker_id]?.role ?? 'worker',
      owner: caller,
      autoFinish: false,
      provider: args.provider ?? '', model: args.model ?? '',
      status: 'idle', text: '', error: undefined, prompt: undefined,
      startedAt: now, updatedAt: now, idle: undefined,
    }
    workers.set(args.worker_id, resumed)
    probe('resume ' + args.worker_id)
    return summary(resumed)
  }

  defs.push({
    name: 'worker_spawn',
    description: 'Create an independent ordinary DSH session (not a subagent, not an agent team) and register it as a worker. Returns the worker_id used by worker_dispatch, worker_status, worker_result, worker_cancel and worker_resume.',
    parameters: obj({
      provider: { type: 'string', description: 'Provider id, for example vercel-pareto.' },
      model: { type: 'string', description: 'Model id, for example deepseek/deepseek-v4.1-flash-1017 or zai/glm-5.3-flash.' },
      cwd: { type: 'string', description: 'Optional absolute working directory the new session owns; defaults to the caller session workspace.' },
      effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort for this worker; omission follows the adapter default.' },
      allow_model_repeat: { type: 'boolean', description: 'Bypass the model-diversity gate. Only for single-model work where a second opinion adds nothing.' },
      auto_finish: { type: 'boolean', description: 'Report the result and close the worker window when its turn ends (default false: the worker stays alive until worker_finish). Pass true only for single-turn workers.' },
      verify: { type: 'boolean', description: 'Run a short readiness turn before returning (default true). A worker that cannot answer is disposed and worker_spawn throws.' },
      ttl_minutes: { type: 'number', description: 'Idle minutes before the worker is reclaimed automatically (default 120). Keeps the 8-slot pool from filling with abandoned workers.' },
    }, ['provider', 'model']),
    output: { schema: anyObj, render: (_args, value) => textRender(value) },
    execute: async (args, exec) => {
      noteCaller(exec)
      const header = exec?.agent?.session?.header
      const callerCwd = header?.cwd ?? header?.meta?.cwd
      return spawnWorker(args, callerCwd)
    },
  })

  defs.push({
    name: 'worker_dispatch',
    description: 'Queue a prompt on an existing worker session and start its turn. Returns immediately unless wait is true.',
    parameters: obj({
      worker_id: { type: 'string', description: 'Worker id from worker_spawn.' },
      prompt: { type: 'string', description: 'Instruction text delivered as a user message.' },
      wait: { type: 'boolean', description: 'Wait for the turn to settle before returning.' },
      max_calls: { type: 'integer', minimum: 1, maximum: 50, default: 6, description: 'run_code call notice threshold for this dispatch.' },
    }, ['worker_id', 'prompt']),
    output: { schema: anyObj, render: (_args, value) => textRender(value) },
    // The app runs a tool exclusively unless it declares itself concurrency-safe, so
    // Promise.all over worker_* calls inside one run_code was serial. A dispatch that
    // does not wait only queues a prompt; waiting dispatches stay one at a time.
    isConcurrencySafe: (args) => args?.wait !== true,
    execute: async (args, exec) => { noteCaller(exec); return dispatch(args) },
  })

  defs.push({
    name: 'worker_verify',
    description: 'Attack one claim with this coordinator\'s adversarial verifier (DeepSeek Flash, effort high, run_code cap 8) and return its VERDICT. Costs about one worker: call it only when the worker-orchestration verification criteria apply. Created on first use and reused; the same claim is not verified twice (a FAIL may be re-checked once after rework).',
    parameters: obj({
      claim: { type: 'string', description: 'The conclusion to attack, in one or two sentences.' },
      evidence: { type: 'string', description: 'What backs it now: file:line, command output, or test result.' },
      target: { type: 'string', description: 'Optional artifact under test: absolute path or session/worker id.' },
      focus: { type: 'string', description: 'Optional attack focus, e.g. "concurrency" or "empty input".' },
      cwd: { type: 'string', description: 'Optional working directory for a newly created verifier.' },
    }, ['claim']),
    output: { schema: anyObj, render: (_args, value) => textRender(value) },
    execute: async (args, exec) => {
      noteCaller(exec)
      const header = exec?.agent?.session?.header
      return verifyClaim(args, header?.cwd ?? header?.meta?.cwd)
    },
  })

  defs.push({
    name: 'worker_finish',
    description: 'Finish one worker now: hand its latest output to the coordinator, close its window and free the worker slot. The session itself is persisted and can be revived with worker_resume.',
    parameters: obj({
      worker_id: { type: 'string', description: 'Worker id to finish.' },
    }, ['worker_id']),
    output: { schema: anyObj, render: (_args, value) => textRender(value) },
    execute: async (args, exec) => {
      noteCaller(exec)
      resolve(args.worker_id) // ownership check before an explicit finish
      return finishWorker(args.worker_id)
    },
  })

  defs.push({
    name: 'worker_reports',
    description: 'Read worker reports queued since the coordinator last checked (oldest first). Reports are also delivered into the coordinator session as [WORKER REPORT] messages.',
    parameters: obj({
      clear: { type: 'boolean', description: 'Drop the returned reports from the queue (default true).' },
      limit: { type: 'number', description: 'Maximum reports to return (default 20).' },
    }),
    output: { schema: anyObj, render: (_args, value) => textRender(value) },
    execute: async (args, exec) => {
      noteCaller(exec)
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(64, args.limit)) : 20
      const owner = requireCaller()
      const state = notifyState.get(owner)
      if (state !== undefined) {
        state.count = 0
        state.suppressed = []
        state.digestSent = false
      }
      const mine = reports.filter((report) => report.owner === owner)
      const batch = mine.slice(0, limit)
      if (args.clear !== false) {
        // Collected here = delivered: the 1.5 s chat flush must not send them again (x2 B1).
        const taken = new Set(batch)
        for (const report of batch) {
          report.delivered = true
          const index = reports.indexOf(report)
          if (index >= 0) reports.splice(index, 1)
        }
        if (state !== undefined) state.items = state.items.filter((report) => !taken.has(report))
      }
      return { count: batch.length, pending: reports.filter((report) => report.owner === owner).length, reports: batch }
    },
  })

  defs.push({
    name: 'worker_transfer',
    description: 'Hand every worker this session owns (or the listed ids) to another coordinator session. The target session can then resume, dispatch, collect and finish them; this session loses control immediately.',
    parameters: obj({
      to_session_id: { type: 'string', description: 'Session id of the coordinator that should own the workers.' },
      worker_ids: { type: 'array', items: { type: 'string' }, description: 'Optional subset; omit to transfer every worker this session owns.' },
    }, ['to_session_id']),
    output: { schema: anyObj, render: (_args, value) => textRender(value) },
    execute: async (args, exec) => { noteCaller(exec); return transferWorkers(args) },
  })

  defs.push({
    name: 'worker_status',
    description: 'Report worker states. Omit worker_id for every worker.',
    parameters: obj({
      worker_id: { type: 'string', description: 'Optional single worker id.' },
      include_released: { type: 'boolean', description: 'Also list registry entries that have no live handle and no archived result (default false).' },
    }),
    output: { schema: anyObj, render: (_args, value) => textRender(value) },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => { noteCaller(exec); return statusOf(args) },
  })

  defs.push({
    name: 'worker_result',
    description: 'Return the latest assistant text produced by a worker. Waits for the running turn when wait is true.',
    parameters: obj({
      worker_id: { type: 'string', description: 'Worker id.' },
      wait: { type: 'boolean', description: 'Wait for the running turn to finish first.' },
    }, ['worker_id']),
    output: { schema: anyObj, render: (_args, value) => textRender(value) },
    isConcurrencySafe: (args) => args?.wait !== true,
    execute: async (args, exec) => { noteCaller(exec); return resultOf(args) },
  })

  defs.push({
    name: 'worker_cancel',
    description: 'Abort the active turn and finish the worker: its slot is freed and only output produced since the last dispatch is reported. The session itself is persisted; worker_resume revives it.',
    parameters: obj({ worker_id: { type: 'string', description: 'Worker id.' } }, ['worker_id']),
    output: { schema: anyObj, render: (_args, value) => textRender(value) },
    execute: async (args, exec) => { noteCaller(exec); return cancel(args) },
  })

  defs.push({
    name: 'worker_resume',
    description: 'Re-attach to a persisted worker session after it was cancelled or the handle was disposed.',
    parameters: obj({
      worker_id: { type: 'string', description: 'Session id of the worker to resume.' },
      provider: { type: 'string', description: 'Provider id (defaults to the recorded one).' },
      model: { type: 'string', description: 'Model id (defaults to the recorded one).' },
    }, ['worker_id']),
    output: { schema: anyObj, render: (_args, value) => textRender(value) },
    execute: async (args, exec) => { noteCaller(exec); return resumeWorker(args) },
  })

  const registered = defs.filter(register).map((definition) => definition.name)
  probe('registered=' + registered.join(','))
  if (rejected.length > 0) probe('rejected=' + JSON.stringify(rejected))
  probe('tools-view-after=' + safeType(() => visibleNames(ctx.tools.view(undefined).visible).filter((n) => n.startsWith('worker_')).join(',')))

  // Tool registration is complete; wire observation last so a listener failure
  // cannot cost the tool surface.
  try {
    ctx.on('session/event', (session, event) => {
      const id = session?.header?.id
      if (typeof id !== 'string') return
      if (event?.type === 'turn/end') { try { void checkRotation(session) } catch {} }
      const worker = workers.get(id)
      if (worker === undefined) return
      const cap = callCapDecision({ role: worker.role, maxCalls: worker.maxCalls, count: worker.callCount ?? 0, event })
      worker.callCount = cap.count
      for (const limit of cap.notices) {
        const notice = '[호출 상한' + (limit === worker.maxCalls ? '' : ' 2차') + '] run_code ' + limit + '회 도달. 더 조회하지 말고 지금까지 확인한 것으로 ' +
          (worker.role === 'verifier' ? '첫 줄 VERDICT(PASS/FAIL/UNKNOWN) 1줄과 근거만 쓰고' : 'FINDINGS/EVIDENCE/CONFIDENCE/OPEN 보고 후') + ' 턴을 끝내라.'
        // Remember the id: the next dispatch removes it if a stop left it queued.
        const noticeId = randomUUID()
        const seq = worker.dispatchSeq
        ;(worker.capNoticeIds ??= []).push(noticeId)
        deliverLater(id, notice, 'cap notice ' + id.slice(-8) + ' limit=' + limit,
          () => workers.get(id) === worker && worker.finished !== true && worker.dispatchSeq === seq && isRunning(worker), noticeId)
      }
      if (event?.type === 'assistant/message') {
        const text = textOf(event.data?.message)
        if (text.length > 0) { worker.text = text; worker.textSinceDispatch = true }
        worker.updatedAt = Date.now()
      }
      if (event?.type === 'turn/end') {
        worker.updatedAt = Date.now()
        // finish/cancel already released this worker; its aborted turn adds nothing.
        if (worker.finished === true) return
        const reason = event.data?.reason
        // The app starts another turn right away when input is still queued (the plugin
        // refuses dispatches to a running worker, so this is input typed into the
        // worker's own window). That turn, not this one, ends the work: stay running,
        // so call-cap notices and the 4-running cap keep counting it, and report later.
        // Aborted, error and blocked turns never continue (the turn throws or returns).
        const continues = reason?.kind !== 'aborted' && reason?.kind !== 'error' && reason?.kind !== 'blocked' && hasQueuedInput(worker)
        worker.status = continues ? 'running' : 'idle'
        if (worker.verifying === true) {
          // closeWork is skipped while probing: keep the failure, or the probe's
          // answer from an error turn passes and is cached (ha_1 AD1-1).
          if (reason?.kind === 'error' || reason?.kind === 'blocked') worker.error = reason.kind === 'error' ? String(reason.error?.message ?? reason.error?.code ?? 'unknown').slice(0, 300) : 'step rejected'
          return
        }
        if (continues) { watchContinuation(worker); return }
        closeWork(worker, reason)
      }
    })
    probe('listener=ok')
  } catch (error) {
    probe('listener=failed ' + describeError(error))
  }

  // ---- file control channel -------------------------------------------------

  const AsyncFunction = (async () => {}).constructor
  const api = {
    ctx,
    rotationNotifyTest: async ({ sessionId, pressure }) => checkRotation({ header: { id: sessionId } }, pressure, true),
    get root() { try { return ctx.root } catch { return undefined } },
    workers,
    agentService,
    register,
    summary,
    spawnWorker,
    dispatch,
    statusOf,
    resultOf,
    cancel,
    resumeWorker,
    registered,
    probe,
    safeType,
    describeError,
  }

  const serialize = (value) => {
    try {
      return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'function' ? '[fn]' : v)))
    } catch {
      try { return String(value) } catch { return null }
    }
  }

  let busy = false

  const pollOnce = async () => {
    if (busy) return
    // An agent-less load of this module (e.g. cordis-test/apply.test.mjs, which imports
    // the live file) also polls the real control directory; it must not claim
    // commands meant for the live instance. The app context always has inject, so
    // ctl stays usable there even when the agent service is broken.
    if (typeof ctx.inject !== 'function') { try { agentService() } catch { return } }
    busy = true
    try {
      let names = []
      try { names = readdirSync(CTL_IN).filter((n) => n.endsWith('.json')) } catch { names = [] }
      for (const file of names.sort()) {
        const full = CTL_IN + '/' + file
        let command
        try {
          command = JSON.parse(readFileSync(full, 'utf8'))
          renameSync(full, CTL_IN + '/../done-' + file)
        } catch { continue }
        const id = String(command.id ?? file.replace(/\.json$/, ''))
        const startedAt = Date.now()
        let payload
        try {
          const fn = new AsyncFunction('ctx', 'root', 'api', 'workers', 'probe', 'require2', '"use strict";\n' + String(command.code ?? ''))
          const value = await fn(ctx, api.root, api, workers, probe, createRequire(import.meta.url))
          payload = { ok: true, value: serialize(value) }
        } catch (error) {
          payload = { ok: false, error: describeError(error), stack: String(error?.stack ?? '').slice(0, 1500) }
        }
        payload.id = id
        payload.durationMs = Date.now() - startedAt
        try { writeFileSync(CTL_OUT + '/' + id + '.json', JSON.stringify(payload, null, 1)) } catch {}
      }
    } finally {
      busy = false
    }
  }

  if (!CTL_ENABLED) {
    probe('ctl=off')
    return
  }
  try {
    if (!existsSync(CTL_IN)) mkdirSync(CTL_IN, { recursive: true })
    if (!existsSync(CTL_OUT)) mkdirSync(CTL_OUT, { recursive: true })
    let ticks = 0
    const tick = () => {
      ticks += 1
      if (ticks === 1 || ticks === 40) probe('poll tick ' + ticks)
      pollOnce()
        .catch((error) => probe('poll error ' + describeError(error)))
        .finally(() => {
          const timer = setTimeout(tick, 250)
          if (typeof timer.unref === 'function') timer.unref()
        })
    }
    tick()
    probe('ctl=on')
  } catch (error) {
    probe('ctl=failed ' + describeError(error))
  }
}
