'use strict'

// Runs island-hook.js as Grok would (event JSON on stdin) against a real hub.
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHub } = require('../../app/hub')

async function start() {
  const hub = createHub({ token: 'grok-test' })
  const port = await hub.listen(0)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-'))
  const file = path.join(dir, 'island.json')
  fs.writeFileSync(file, JSON.stringify({ port, token: 'grok-test' }))

  return { hub, file }
}

function hook(file, event, args = []) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, 'island-hook.js'), ...args], { env: { ...process.env, ISLAND_HUB_FILE: file } })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.on('close', code => resolve({ code, out }))
    child.stdin.end(JSON.stringify(event))
  })
}

const base = { sessionId: 'abc', cwd: 'C:/dev/api', workspaceRoot: 'C:/dev/api' }

test('a Grok session shows up with its prompt and its current tool', async () => {
  const { hub, file } = await start()
  await hook(file, { ...base, hookEventName: 'SessionStart' })
  await hook(file, { ...base, hookEventName: 'UserPromptSubmit', prompt: 'Fix the payment tests' })
  const { code } = await hook(file, { ...base, hookEventName: 'PreToolUse', toolName: 'Bash', toolInput: { command: 'npm test' } })
  assert.equal(code, 0)
  const s = hub.snapshot().sessions[0]
  assert.equal(s.source, 'grok')
  assert.equal(s.project, 'api')
  assert.equal(s.title, 'Fix the payment tests')
  assert.deepEqual([s.phase, s.activity.key, s.activity.arg], ['tool', 'bash', 'npm test'])
  await hook(file, { ...base, hookEventName: 'PreToolUse', toolName: 'Read', toolInput: { path: 'a.py' } })
  assert.equal(hub.snapshot().sessions[0].actions, 2)
  await hook(file, { ...base, hookEventName: 'Stop' })
  assert.equal(hub.snapshot().sessions[0].outcome, 'done')
  assert.equal(typeof hub.snapshot().sessions[0].finishedAt, 'number')
  await hook(file, { ...base, hookEventName: 'UserPromptSubmit', prompt: 'Next' })
  assert.deepEqual([hub.snapshot().sessions[0].actions, hub.snapshot().sessions[0].finishedAt], [0, null])
  await hook(file, { ...base, hookEventName: 'SessionEnd' })
  assert.equal(hub.snapshot().sessions.length, 0)
  hub.close()
})

test('with --gate, a block in the island is a deny Grok reads', async () => {
  const { hub, file } = await start()
  const running = hook(file, { ...base, hookEventName: 'PreToolUse', toolName: 'Bash', toolInput: { command: 'rm -rf build' } }, ['--gate=Bash'])
  let request
  for (let i = 0; i < 50 && !request; i++) {
    await new Promise(r => setTimeout(r, 50))
    request = hub.snapshot().permissions[0]
  }
  assert.equal(request.canAllow, false)
  assert.equal(request.body, 'rm -rf build')
  hub.decide(request.id, 'deny')
  const { code, out } = await running
  assert.equal(code, 2)
  assert.deepEqual(JSON.parse(out), { decision: 'deny', reason: 'Blocked from the island.' })
  hub.close()
})

test('without an island, the hook steps aside', async () => {
  const { code, out } = await hook(path.join(os.tmpdir(), 'no-such-island.json'), { ...base, hookEventName: 'PreToolUse', toolName: 'Bash' }, ['--gate=Bash'])
  assert.equal(code, 0)
  assert.equal(out, '')
})
