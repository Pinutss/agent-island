import type { EngineInterface, HttpResponse, Register, SessionRateLimit } from 'claude-code'

import { baseName, describePermission, describeTool } from './labels'
import type { Activity } from './labels'
import { measure, newTracker, startTurn, track } from './progress'
import type { Progress } from './progress'

// The bridge between one Claude Code session and the Agent Island desktop app. It
// pushes the session's state to the island's local hub, and when Claude is about to
// ask for a permission, it puts the question to the island and applies its answer.
// With no island running, every call fails fast and the session behaves as usual.

const PUSH_MS = 400
const BEAT_MS = 5000
const HUB_RETRY_MS = 10_000
const WAIT_S = 20
// Past this, an unanswered request falls back to Claude's own dialog.
const DECISION_TIMEOUT_MS = 90_000
// At most one attempt to open the island per this long, per session.
const WAKE_RETRY_MS = 5 * 60_000
const WAKE_SETTLE_MS = 4000
const SKIN_BY_TYPE: Record<string, number> = { Explore: 1, Plan: 2, 'general-purpose': 3, teammate: 4 }

type Hub = { url: string; token: string }
type AgentRow = {
  id: string
  description: string
  type: string
  model: string
  skin: number
  phase: 'running' | 'done' | 'failed'
  activity?: Activity
}
type Session = {
  // Which agent the island shows this session as.
  source: 'claude-code'
  sessionId: string
  cwd: string
  project: string
  title: string
  model: string
  phase: 'idle' | 'thinking' | 'tool'
  activity?: Activity
  startedAt: number
  waiting: number
  agents: AgentRow[]
  rateLimits: SessionRateLimit[]
  // 0 to 1 for the current task (progress.ts); finishedAt marks the turn's end.
  progress?: Progress
  finishedAt?: number | null
  outcome?: 'done' | 'stopped' | null
}

let hub: Hub | undefined
let hubCheckedAt = -HUB_RETRY_MS
let session: Session | undefined
let pushTimer: unknown
let beatTimer: unknown
let lastPush = 0
let requestSeq = 0
let hubLookup: Promise<Hub | undefined> | undefined
let tracker = newTracker()
let wokeAt = -WAKE_RETRY_MS

// Calls made while a lookup runs wait for it rather than concluding there is no island.
async function findHub($: EngineInterface): Promise<Hub | undefined> {
  if (hub) return hub
  if (hubLookup) return hubLookup
  const now = await $.clock.now()
  if (hubLookup) return hubLookup
  if (now - hubCheckedAt < HUB_RETRY_MS) return undefined
  hubCheckedAt = now
  hubLookup = lookupHub($).finally(() => {
    hubLookup = undefined
  })

  return hubLookup
}

async function lookupHub($: EngineInterface): Promise<Hub | undefined> {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (!home) return undefined
    const raw = await $.fs.read(`${home}/.claude/island/island.json`)
    const found = JSON.parse(String(raw)) as { port?: number; token?: string }
    if (typeof found.port !== 'number' || typeof found.token !== 'string') return undefined
    hub = { url: `http://127.0.0.1:${found.port}`, token: found.token }
  } catch {
    hub = undefined
  }

  return hub
}

async function call($: EngineInterface, path: string, method = 'GET', body?: unknown): Promise<HttpResponse | undefined> {
  const target = await findHub($)
  if (!target) return undefined
  try {
    const response = await $.http.fetch(`${target.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-island-token': target.token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (response.status === 401) hub = undefined

    return response
  } catch {
    // The island is closed or restarting: look for it again a little later.
    hub = undefined

    return undefined
  }
}

async function push($: EngineInterface): Promise<void> {
  pushTimer = undefined
  if (!session) return
  lastPush = await $.clock.now()
  session.progress = measure(tracker, typeof session.finishedAt === 'number')
  await call($, '/v1/session', 'POST', { ...session, updatedAt: lastPush })
}

function schedule($: EngineInterface): void {
  if (pushTimer !== undefined) return
  pushTimer = $.clock.after(PUSH_MS, () => void push($))
}

async function ensure($: EngineInterface, cwd?: string): Promise<Session> {
  if (session) return session
  const dir = cwd ?? (await $.session.cwd())
  session = {
    source: 'claude-code',
    sessionId: await $.session.id(),
    cwd: dir,
    project: baseName(dir) || dir,
    title: '',
    model: '',
    phase: 'idle',
    startedAt: await $.clock.now(),
    waiting: 0,
    agents: [],
    rateLimits: [],
  }

  return session
}

function agentRow(s: Session, id: string): AgentRow | undefined {
  return s.agents.find(a => a.id === id)
}

async function beat($: EngineInterface): Promise<void> {
  const s = await ensure($)
  try {
    const usage = await $.session.usage()
    if (usage.rateLimits.length > 0) s.rateLimits = usage.rateLimits
  } catch {
    // No reading yet.
  }
  // Agents whose end this module did not hear are settled from the session's list.
  if (s.agents.some(a => a.phase === 'running')) {
    const list = await $.agent.list()
    for (const row of s.agents) {
      const info = list.find(a => a.id === row.id)
      if (row.phase !== 'running' || !info) continue
      if (info.status === 'completed' || info.status === 'idle') row.phase = 'done'
      else if (info.status === 'failed' || info.status === 'killed') row.phase = 'failed'
    }
  }
  s.agents = s.agents.slice(-12)
  await push($)
}

type Launch = { platform?: string; argv?: string[]; command?: string; auto?: boolean }

// WMI starts the island outside this session's process tree, so closing Claude does
// not close it with it. The command line comes from the launch file, never from here.
const WINDOWS_LAUNCH =
  '$l = Get-Content -Raw -LiteralPath $env:ISLAND_LAUNCH | ConvertFrom-Json; ' +
  'Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $l.command } | Out-Null'

// No island answering: open it the way it last described itself (launch.json, written
// at each of its launches), unless it was told not to open with Claude Code.
async function wakeIsland($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (now - wokeAt < WAKE_RETRY_MS) return
  wokeAt = now
  if ((await call($, '/v1/health'))?.ok) return
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (!home) return
    const file = `${home}/.claude/island/launch.json`
    const launch = JSON.parse(String(await $.fs.read(file))) as Launch
    if (launch.auto === false || !Array.isArray(launch.argv) || launch.argv.length === 0) return
    if (launch.platform === 'win32') {
      await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_LAUNCH], { env: { ISLAND_LAUNCH: file }, timeoutMs: 20_000 })
    } else {
      await $.process.run(['/bin/sh', '-c', 'nohup "$@" >/dev/null 2>&1 &', 'island', ...launch.argv], { timeoutMs: 10_000 })
    }
    // Look for its hub again once it has had time to start.
    $.clock.after(WAKE_SETTLE_MS, () => {
      hub = undefined
      hubCheckedAt = -HUB_RETRY_MS
      void push($)
    })
  } catch {
    // No launch file yet (the island never ran here) or it could not start: carry on.
  }
}

type IslandAnswer = { decision: string; answers?: Record<string, string> }

// Puts a request (a permission, a question) to the island and waits for its answer,
// polling the hub in long waits. Undefined: no island, no answer in time, or cancelled.
async function askIsland($: EngineInterface, signal: AbortSignal, request: Record<string, unknown>): Promise<IslandAnswer | undefined> {
  const s = await ensure($)
  const id = `${s.sessionId}:${++requestSeq}`
  const created = await call($, '/v1/permission', 'POST', { id, source: s.source, sessionId: s.sessionId, project: s.project, sessionTitle: s.title, ...request })
  if (!created?.ok) return undefined

  s.waiting++
  void push($)
  let answer: IslandAnswer | undefined
  try {
    const deadline = (await $.clock.now()) + DECISION_TIMEOUT_MS
    while (answer === undefined && !signal.aborted && (await $.clock.now()) < deadline) {
      const reply = await call($, `/v1/permission/${encodeURIComponent(id)}?wait=${WAIT_S}`)
      if (!reply || (reply.status !== 200 && reply.status !== 204)) break
      if (reply.status === 200) {
        const parsed = JSON.parse(reply.text) as Partial<IslandAnswer>
        answer = { decision: parsed.decision ?? 'defer', answers: parsed.answers }
      }
    }
  } finally {
    s.waiting = Math.max(0, s.waiting - 1)
    if (answer === undefined) void call($, `/v1/permission/${encodeURIComponent(id)}`, 'DELETE')
    void push($)
  }

  return answer
}

const PLAN_MAX = 16_000

async function showPlan<R>($: EngineInterface, e: unknown, next: (e: never) => Promise<R>): Promise<R> {
  const s = await ensure($)
  const raw = (e as { plan?: unknown }).plan
  const plan = typeof raw === 'string' ? raw : ''
  const id = `${s.sessionId}:plan:${++requestSeq}`
  const posted = await call($, '/v1/permission', 'POST', {
    id,
    type: 'plan',
    source: s.source,
    sessionId: s.sessionId,
    project: s.project,
    sessionTitle: s.title,
    tool: 'ExitPlanMode',
    title: 'Plan ready for review',
    body: plan.length > PLAN_MAX ? `${plan.slice(0, PLAN_MAX - 1)}…` : plan,
  })
  if (posted?.ok) {
    s.waiting++
    void push($)
  }
  try {
    return await next(e as never)
  } finally {
    if (posted?.ok) {
      s.waiting = Math.max(0, s.waiting - 1)
      await call($, `/v1/permission/${encodeURIComponent(id)}`, 'DELETE')
      void push($)
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    session = undefined
    tracker = newTracker()
    await ensure($, e.cwd)
    beatTimer ??= $.clock.every(BEAT_MS, () => void beat($))
    // Never in the way of the session: a failure here only means no island.
    void wakeIsland($).then(() => push($)).catch(() => undefined)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (session) await call($, '/v1/session/end', 'POST', { sessionId: session.sessionId })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const s = await ensure($)
    void wakeIsland($).catch(() => undefined)
    if (!e.isMeta && !e.command && e.text.trim()) {
      const line = e.text.trim().split('\n')[0] ?? ''
      s.title = line.length > 90 ? `${line.slice(0, 89)}…` : line
      schedule($)
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const s = await ensure($)
      s.phase = 'thinking'
      // null, not undefined: the hub merges what it gets, and JSON drops undefined.
      s.finishedAt = null
      s.outcome = null
      startTurn(tracker)
      schedule($)
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const s = await ensure($)
    if (e.agentId === undefined) {
      s.model = e.model
      if (s.phase === 'idle') s.phase = 'thinking'
    } else {
      const row = agentRow(s, e.agentId)
      if (row) row.model = e.model
    }
    schedule($)

    return yield* next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (!('agentId' in result) || !result.agentId) return result
    const s = await ensure($)
    tracker.actions++
    const id = result.agentId
    if (!agentRow(s, id)) {
      const used = new Set(s.agents.filter(a => a.phase === 'running').map(a => a.skin))
      let skin = SKIN_BY_TYPE[e.subagentType] ?? s.agents.length % 10
      for (let i = 0; used.has(skin) && i < 10; i++) skin = (skin + 1) % 10
      s.agents.push({
        id,
        description: e.description || e.subagentType,
        type: e.subagentType,
        model: result.model,
        skin,
        phase: 'running',
      })
    }
    schedule($)

    return result
  })

  // Agent and Workflow calls are left alone: wrapping them would nest the subagent's run
  // inside this plugin's hook.
  on('tool.call', { tool: /^(?!(?:Agent|Task|Workflow)$)/ }, async ($, e, next) => {
    // A question for the person goes to the island first; its answer is the tool's
    // result. No island, no answer in time, or "answer in Claude": the usual dialog.
    if (e.tool === 'AskUserQuestion') {
      const answer = await askIsland($, next.signal, {
        type: 'question',
        tool: 'AskUserQuestion',
        title: e.questions[0]?.question ?? 'Question',
        questions: e.questions.map(q => {
          // Newer questions may be free text or a number, with no options.
          const extra = q as unknown as Record<string, unknown>
          const pick = (k: string) => (extra[k] === undefined ? {} : { [k]: extra[k] })

          return {
            question: q.question,
            header: q.header,
            multiSelect: q.multiSelect === true,
            options: (q.options ?? []).map(o => ({ label: o.label, description: o.description })),
            ...pick('kind'),
            ...pick('description'),
            ...pick('placeholder'),
            ...pick('min'),
            ...pick('max'),
            ...pick('step'),
            ...pick('defaultValue'),
            ...pick('unit'),
          }
        }),
      })
      if (answer?.decision === 'answer' && answer.answers) {
        return { result: { questions: e.questions, answers: answer.answers } } as Awaited<ReturnType<typeof next>>
      }

      return next(e)
    }
    // A plan waits for the person's approval, which only Claude's own dialog can give: the
    // island shows the plan while that dialog is up and drops it once it is answered.
    if (e.tool === 'ExitPlanMode') return showPlan($, e, next)
    const s = await ensure($)
    const act = describeTool(String(e.tool), e as unknown as Record<string, unknown>)
    const row = e.agentId === undefined ? undefined : agentRow(s, e.agentId)
    if (e.agentId === undefined) {
      s.phase = 'tool'
      s.activity = act
      tracker.actions++
      track(tracker, String(e.tool), e as unknown as Record<string, unknown>)
    } else {
      // A subagent's actions move its parent's task along too, a little less.
      tracker.actions += 0.5
      if (row) row.activity = act
    }
    schedule($)
    const ran = await next(e)
    if (e.agentId === undefined && s.phase === 'tool') s.phase = 'thinking'
    schedule($)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const s = await ensure($)
    if (e.agentId === undefined) {
      s.phase = 'idle'
      s.activity = undefined
      s.finishedAt = await $.clock.now()
      s.outcome = e.reason === 'answer' ? 'done' : 'stopped'
    } else {
      const row = agentRow(s, e.agentId)
      if (row) row.phase = e.reason === 'answer' ? 'done' : 'failed'
    }
    schedule($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const s = await ensure($)
    if (e.rateLimits.length > 0) {
      s.rateLimits = e.rateLimits
      schedule($)
    }

    return next(e)
  })

  // Claude is about to show its permission dialog: the rules and the mode (auto
  // included) have already had their say. The island gets the question first; with no
  // island, no answer in time, or "answer in Claude", the dialog shows as usual.
  on('classic.PermissionRequest', async ($, e, next) => {
    // A question that reached the dialog was already put to the island and sent back;
    // a plan can only be approved in Claude, and the island shows it on its own.
    if (e.tool_name === 'AskUserQuestion' || e.tool_name === 'ExitPlanMode') return next(e)
    const s = await ensure($)
    const agent = e.agent_id ? agentRow(s, e.agent_id) : undefined
    const answer = await askIsland($, next.signal, {
      type: 'permission',
      tool: e.tool_name,
      agent: agent?.description,
      canAlways: (e.permission_suggestions?.length ?? 0) > 0,
      ...describePermission(e.tool_name, e.tool_input),
    })

    switch (answer?.decision) {
      case 'allow':
        return { decision: { behavior: 'allow' } }
      case 'always':
        return {
          decision: {
            behavior: 'allow',
            ...(e.permission_suggestions?.length ? { updatedPermissions: e.permission_suggestions } : {}),
          },
        }
      case 'deny':
        return { decision: { behavior: 'deny', message: 'Denied from the island.' } }
      default:
        return next(e)
    }
  })
}
