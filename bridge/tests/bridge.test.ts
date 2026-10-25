import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Sent = { url: string; method: string; body: unknown }

// Nothing sits beneath the plugin: these hooks stand for the engine, and `http.fetch`
// stands for the island's hub.
function engine(on: On, island: { answer?: string; answers?: Record<string, string>; present?: boolean }) {
  const clock = mock.clock(on)
  const sent: Sent[] = []
  let polls = 0
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/test' : undefined }))
  on('fs.read', () => {
    if (island.present === false) throw new Error('ENOENT')

    return { value: JSON.stringify({ port: 47823, token: 'secret' }) }
  })
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: 'C:/dev/checkout-app' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('classic.PermissionRequest', () => ({}))
  on('tool.call', () => ({ result: {} }))
  on('http.fetch', (_, e) => {
    const method = e.init?.method ?? 'GET'
    sent.push({ url: e.url, method, body: e.init?.body ? JSON.parse(e.init.body) : undefined })
    const isPoll = method === 'GET' && e.url.includes('/v1/permission/')
    if (isPoll && polls++ === 0) return { value: { status: 204, ok: true, headers: {}, text: '' } }
    const text = isPoll ? JSON.stringify({ decision: island.answer, answers: island.answers }) : '{}'

    return { value: { status: 200, ok: true, headers: {}, text } }
  })

  return { clock, sent }
}

const SUGGESTIONS: Array<{
  type: 'addRules'
  rules: Array<{ toolName: string }>
  behavior: 'allow'
  destination: 'session'
}> = [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' }]

const EDIT = {
  tool_name: 'Edit',
  tool_input: { file_path: 'src/auth/middleware.ts', old_string: 'if (token) return next()', new_string: 'if (await verify(token)) return next()' },
  permission_suggestions: SUGGESTIONS,
}

test('a permission request goes to the island, and "always" allows with the dialog’s rule', async ($, on) => {
  const { sent } = engine(on, { answer: 'always' })
  await $.session.start({ cwd: 'C:/dev/checkout-app', surface: 'desktop', isInteractive: true })
  const result = await $.classic.PermissionRequest(EDIT)

  expect(result.decision).toEqual({ behavior: 'allow', updatedPermissions: EDIT.permission_suggestions })
  const asked = sent.find(s => s.method === 'POST' && s.url.endsWith('/v1/permission'))
  expect(asked?.url).toBe('http://127.0.0.1:47823/v1/permission')
  expect(asked?.body).toMatchObject({ kind: 'diff', title: 'Modifier middleware.ts ?', project: 'checkout-app' })
  expect(String((asked?.body as { body: string }).body)).toContain('+if (await verify(token)) return next()')
})

test('a refusal in the island is a deny', async ($, on) => {
  engine(on, { answer: 'deny' })
  await $.session.start({ cwd: 'C:/dev/checkout-app', surface: 'desktop', isInteractive: true })
  const result = await $.classic.PermissionRequest(EDIT)

  expect(result.decision).toEqual({ behavior: 'deny', message: 'Refusé depuis Agent Island.' })
})

test('"answer in Claude" and a missing island both leave the dialog to Claude', async ($, on) => {
  engine(on, { answer: 'defer' })
  await $.session.start({ cwd: 'C:/dev/checkout-app', surface: 'desktop', isInteractive: true })
  expect((await $.classic.PermissionRequest(EDIT)).decision).toBeUndefined()
})

test('with no island running, nothing is sent and the dialog shows', async ($, on) => {
  const { sent } = engine(on, { present: false })
  await $.session.start({ cwd: 'C:/dev/checkout-app', surface: 'desktop', isInteractive: true })
  expect((await $.classic.PermissionRequest(EDIT)).decision).toBeUndefined()
  expect(sent.length).toBe(0)
})

test('the session and its current action reach the island', async ($, on) => {
  const { clock, sent } = engine(on, {})
  await $.session.start({ cwd: 'C:/dev/checkout-app', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'src/settings/theme.ts' })
  await clock.advance(1000)

  const pushes = sent.filter(s => s.url.endsWith('/v1/session')).map(s => s.body as Record<string, unknown>)
  expect(pushes.length).toBeGreaterThan(0)
  expect(pushes[0]).toMatchObject({ sessionId: 's1', project: 'checkout-app' })
  expect(pushes.some(p => (p.activity as { label?: string } | undefined)?.label === 'Lit theme.ts')).toBe(true)
})

test('a question is answered from the island, and the answer is the tool’s result', async ($, on) => {
  const { sent } = engine(on, { answer: 'answer', answers: { 'Quelle base de données en local ?': 'Fichier SQLite' } })
  await $.session.start({ cwd: 'C:/dev/checkout-app', surface: 'desktop', isInteractive: true })
  const questions = [
    {
      question: 'Quelle base de données en local ?',
      header: 'Base',
      multiSelect: false,
      options: [
        { label: 'Postgres dans Docker', description: 'Comme la prod' },
        { label: 'Fichier SQLite', description: 'Le plus simple' },
      ],
    },
  ]
  const ran = await $.tool.call({ tool: 'AskUserQuestion', questions })

  expect(ran).toMatchObject({ result: { answers: { 'Quelle base de données en local ?': 'Fichier SQLite' } } })
  const asked = sent.find(s => s.method === 'POST' && s.url.endsWith('/v1/permission'))
  expect(asked?.body).toMatchObject({ type: 'question', title: 'Quelle base de données en local ?' })
})

test('a plan is shown in the island while Claude’s own dialog decides, then withdrawn', async ($, on) => {
  const { sent } = engine(on, {})
  await $.session.start({ cwd: 'C:/dev/checkout-app', surface: 'desktop', isInteractive: true })
  const ran = await $.tool.call({ tool: 'ExitPlanMode', plan: '# Plan\n- Ajouter le mode sombre' } as never)

  expect(ran).toMatchObject({ result: {} })
  const shown = sent.find(s => s.method === 'POST' && s.url.endsWith('/v1/permission'))
  expect(shown?.body).toMatchObject({ type: 'plan', body: '# Plan\n- Ajouter le mode sombre' })
  expect(sent.some(s => s.method === 'DELETE' && decodeURIComponent(s.url).includes(':plan:'))).toBe(true)
  // Nothing waited for a decision from the island.
  expect(sent.some(s => s.method === 'GET' && decodeURIComponent(s.url).includes(':plan:'))).toBe(false)
})
