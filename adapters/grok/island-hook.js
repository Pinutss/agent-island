#!/usr/bin/env node
'use strict'

// Grok Build → Agent Island. Grok runs this script on its hook events (see
// agent-island.json beside it) with the event as JSON on stdin; the script tells the
// island's local hub what the session is doing. No dependencies, Node 18+.
//
// With --gate=<Tool,...> a PreToolUse of those tools is also put to the island, which
// can block it. Grok's hooks can only refuse a call (exit 2), never approve one, so the
// island offers Block or "Let Grok decide". Without an island, or on any error, the
// script exits 0 at once and Grok carries on as usual.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HUB_FILE = process.env.ISLAND_HUB_FILE ?? path.join(os.homedir(), '.claude', 'island', 'island.json')
const SILENCE_MS = 30 * 60_000
const WAIT_S = 20
const DECISION_TIMEOUT_MS = 85_000
const gate = (process.argv.find(a => a.startsWith('--gate=')) ?? '').slice('--gate='.length).split(',').filter(Boolean)

function readStdin() {
  return new Promise(resolve => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => (text += chunk))
    process.stdin.on('end', () => resolve(text))
    process.stdin.on('error', () => resolve(''))
  })
}

function hub() {
  try {
    const { port, token } = JSON.parse(fs.readFileSync(HUB_FILE, 'utf8'))

    return typeof port === 'number' && typeof token === 'string' ? { url: `http://127.0.0.1:${port}`, token } : undefined
  } catch {
    return undefined
  }
}

async function call(target, route, method = 'GET', body, timeoutMs = 2000) {
  try {
    return await fetch(`${target.url}${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-island-token': target.token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return undefined
  }
}

const str = (input, ...keys) => {
  for (const key of keys) if (typeof input?.[key] === 'string' && input[key]) return input[key]

  return ''
}
const short = (value, max = 80) => {
  const line = String(value).replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
const base = p => String(p).split(/[\\/]/).filter(Boolean).pop() ?? p

// Grok's tool, read as one of the island's actions (renderer/i18n.js, `act.<key>`).
function activity(tool, input) {
  const name = String(tool ?? '').toLowerCase()
  const with_ = (icon, key, arg) => (arg ? { icon, key, arg, label: `${tool} ${arg}` } : { icon, key: `${key}.none`, label: String(tool) })
  if (/bash|shell|exec|command|terminal/.test(name)) return with_('⌨️', 'bash', short(str(input, 'command', 'cmd')))
  if (/edit|patch|replace/.test(name)) return with_('✏️', 'edit', base(str(input, 'file_path', 'path', 'file')))
  if (/write|create/.test(name)) return with_('📝', 'write', base(str(input, 'file_path', 'path', 'file')))
  if (/read|view|open|cat/.test(name)) return with_('📖', 'read', base(str(input, 'file_path', 'path', 'file')))
  if (/grep|ripgrep|search_code|code_search/.test(name)) return with_('🔎', 'grep', short(str(input, 'pattern', 'query'), 50))
  if (/glob|find|list|ls/.test(name)) return with_('🗂️', 'glob', short(str(input, 'pattern', 'path'), 60))
  if (/web_search|websearch/.test(name)) return with_('🌍', 'search', short(str(input, 'query'), 60))
  if (/fetch|browse|url|web/.test(name)) {
    const url = str(input, 'url')

    return with_('🌐', 'fetch', /^https?:\/\/([^/]+)/.exec(url)?.[1] ?? url)
  }
  if (/agent|task/.test(name)) return with_('🤖', 'agent', short(str(input, 'description', 'prompt'), 60))

  return { icon: '🛠️', key: 'tool', label: short(String(tool ?? 'tool'), 40) }
}

function permission(tool, input) {
  const command = str(input, 'command', 'cmd')
  if (command) return { titleKey: 'command', title: 'Run this command?', kind: 'command', body: command }
  const file = str(input, 'file_path', 'path', 'file')
  if (file) return { titleKey: 'edit', titleArg: base(file), title: `Edit ${base(file)}?`, kind: 'text', file, body: JSON.stringify(input, null, 2).slice(0, 6000) }

  return { titleKey: 'tool', titleArg: tool, title: `Use ${tool}?`, kind: 'text', body: JSON.stringify(input ?? {}, null, 2).slice(0, 6000) }
}

async function main() {
  const event = JSON.parse((await readStdin()) || '{}')
  const target = hub()
  if (!target) return 0
  const name = event.hookEventName ?? process.env.GROK_HOOK_EVENT ?? ''
  const sessionId = `grok:${event.sessionId ?? process.env.GROK_SESSION_ID ?? 'unknown'}`
  const root = event.workspaceRoot ?? event.cwd ?? process.env.GROK_WORKSPACE_ROOT ?? ''
  const session = { sessionId, source: 'grok', cwd: root, project: base(root) || 'grok', staleAfterMs: SILENCE_MS, updatedAt: Date.now() }
  const push = extra => call(target, '/v1/session', 'POST', { ...session, ...extra })

  switch (name) {
    case 'SessionStart':
      await push({ phase: 'idle', startedAt: Date.now(), waiting: 0, agents: [] })
      break
    case 'UserPromptSubmit': {
      const prompt = str(event, 'prompt', 'userPrompt', 'message').split('\n')[0] ?? ''
      // A new turn: its action count and the end of the last one start over.
      await push({ phase: 'thinking', actions: 0, finishedAt: null, outcome: null, ...(prompt ? { title: short(prompt, 90) } : {}) })
      break
    }
    case 'PreToolUse': {
      // `tick` asks the hub to count this action: the island estimates progress from it.
      await push({ phase: 'tool', tick: 'action', activity: activity(event.toolName, event.toolInput) })
      if (gate.some(tool => tool.toLowerCase() === String(event.toolName ?? '').toLowerCase())) return gateCall(target, push, sessionId, session, event)
      break
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied':
      await push({ phase: 'thinking' })
      break
    case 'Stop':
    case 'StopFailure':
      await push({ phase: 'idle', activity: null, finishedAt: Date.now(), outcome: name === 'Stop' ? 'done' : 'stopped' })
      break
    case 'SessionEnd':
      await call(target, '/v1/session/end', 'POST', { sessionId })
      break
  }

  return 0
}

// Puts the call to the island and waits: a block is exit 2 with Grok's deny JSON;
// anything else lets Grok's own permissions decide.
async function gateCall(target, push, sessionId, session, event) {
  const id = `${sessionId}:${Date.now()}`
  const created = await call(target, '/v1/permission', 'POST', {
    id,
    sessionId,
    source: 'grok',
    project: session.project,
    tool: event.toolName,
    canAllow: false,
    ...permission(event.toolName, event.toolInput),
  })
  if (!created?.ok) return 0
  await push({ waiting: 1 })
  let decision
  const deadline = Date.now() + DECISION_TIMEOUT_MS
  while (!decision && Date.now() < deadline) {
    const reply = await call(target, `/v1/permission/${encodeURIComponent(id)}?wait=${WAIT_S}`, 'GET', undefined, (WAIT_S + 5) * 1000)
    if (!reply || (reply.status !== 200 && reply.status !== 204)) break
    if (reply.status === 200) decision = (await reply.json()).decision ?? 'defer'
  }
  if (!decision) await call(target, `/v1/permission/${encodeURIComponent(id)}`, 'DELETE')
  await push({ waiting: 0 })
  if (decision !== 'deny') return 0
  process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'Blocked from the island.' }))

  return 2
}

main().then(
  code => process.exit(code),
  () => process.exit(0),
)
