'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createHub } = require('../hub')

const TOKEN = 'test-token'

async function start() {
  const changes = []
  const hub = createHub({ token: TOKEN, onChange: s => changes.push(s) })
  const port = await hub.listen(0)
  const call = (path, { method = 'GET', body, token = TOKEN, headers = {} } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-island-token': token, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  return { hub, call, changes }
}

test('refuses a call without the token, and any browser request', async () => {
  const { hub, call } = await start()
  assert.equal((await call('/v1/health', { token: 'wrong' })).status, 401)
  assert.equal((await call('/v1/health', { headers: { origin: 'https://evil.example' } })).status, 403)
  assert.equal((await call('/v1/health')).status, 200)
  hub.close()
})

test('keeps the sessions the bridges push', async () => {
  const { hub, call } = await start()
  await call('/v1/session', { method: 'POST', body: { sessionId: 's1', project: 'checkout-app', updatedAt: 1 } })
  assert.equal(hub.snapshot().sessions[0].project, 'checkout-app')
  await call('/v1/session/end', { method: 'POST', body: { sessionId: 's1' } })
  assert.equal(hub.snapshot().sessions.length, 0)
  hub.close()
})

test('a waiting bridge gets the decision taken in the island', async () => {
  const { hub, call } = await start()
  const created = await call('/v1/permission', { method: 'POST', body: { id: 's1:1', sessionId: 's1', title: 'Modifier a.ts ?' } })
  assert.equal(created.status, 201)
  assert.equal(hub.snapshot().permissions.length, 1)

  const waiting = call('/v1/permission/s1%3A1?wait=5')
  setTimeout(() => hub.decide('s1:1', 'always'), 50)
  const answer = await waiting
  assert.equal(answer.status, 200)
  assert.deepEqual(await answer.json(), { decision: 'always' })
  assert.equal(hub.snapshot().permissions.length, 0)
  // Asked again (the bridge's next poll), the decision still stands.
  assert.deepEqual(await (await call('/v1/permission/s1%3A1')).json(), { decision: 'always' })
  hub.close()
})

test('an unanswered poll ends empty, and a cancelled request disappears', async () => {
  const { hub, call } = await start()
  await call('/v1/permission', { method: 'POST', body: { id: 'x', sessionId: 's1' } })
  assert.equal((await call('/v1/permission/x?wait=0')).status, 204)
  assert.equal((await call('/v1/permission/x', { method: 'DELETE' })).status, 204)
  assert.equal(hub.snapshot().permissions.length, 0)
  assert.equal((await call('/v1/permission/x')).status, 404)
  assert.equal(hub.decide('x', 'allow'), false)
  hub.close()
})

test('a question gets its answers back, and an empty answer is refused', async () => {
  const { hub, call } = await start()
  await call('/v1/permission', { method: 'POST', body: { id: 'q', sessionId: 's1', type: 'question' } })
  assert.equal(hub.decide('q', 'answer', {}), false)
  assert.equal(hub.decide('q', 'answer', { 'Quelle base ?': 'SQLite', bad: 3 }), true)
  assert.deepEqual(await (await call('/v1/permission/q')).json(), { decision: 'answer', answers: { 'Quelle base ?': 'SQLite' } })
  hub.close()
})
