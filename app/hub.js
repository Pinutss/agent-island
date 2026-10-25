'use strict'

// The island's local hub: every Claude Code session's bridge pushes its state here and
// puts its permission requests here, then waits (long polling) for the decision taken
// in the island. Bound to 127.0.0.1 and guarded by a token only the user's profile holds.

const http = require('node:http')
const crypto = require('node:crypto')

const STALE_MS = 20_000
const DROP_MS = 10 * 60_000
const KEEP_DECIDED_MS = 30_000
const MAX_WAIT_S = 25
const MAX_BODY = 512 * 1024
const DECISIONS = new Set(['allow', 'always', 'deny', 'defer', 'answer'])

function sameToken(given, expected) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)

  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('too large'))
        req.destroy()

        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, body) {
  if (res.writableEnded) return
  if (body === undefined) {
    res.writeHead(status)
    res.end()

    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function createHub({ token, onChange = () => {}, log = () => {}, now = () => Date.now() }) {
  const sessions = new Map()
  const permissions = new Map()

  function snapshot() {
    const at = now()
    for (const [id, s] of sessions) if (at - s.seenAt > DROP_MS) sessions.delete(id)

    return {
      sessions: [...sessions.values()]
        .map(s => ({ ...s, isStale: at - s.seenAt > STALE_MS }))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
      permissions: [...permissions.values()]
        .filter(p => p.decision === undefined)
        .map(p => ({ ...p.request, createdAt: p.createdAt }))
        .sort((a, b) => a.createdAt - b.createdAt),
    }
  }

  const changed = () => onChange(snapshot())

  function release(entry, status, body) {
    for (const waiter of entry.waiters) {
      clearTimeout(waiter.timer)
      send(waiter.res, status, body)
    }
    entry.waiters.clear()
  }

  // `answers` (question text to answer) goes with an 'answer' to a question.
  function decide(id, decision, answers) {
    const entry = permissions.get(id)
    if (!entry || entry.decision !== undefined || !DECISIONS.has(decision)) return false
    const clean = {}
    if (answers && typeof answers === 'object') {
      for (const [question, value] of Object.entries(answers)) if (typeof value === 'string') clean[question] = value.slice(0, 2000)
    }
    if (decision === 'answer' && Object.keys(clean).length === 0) return false
    entry.decision = decision
    entry.answers = decision === 'answer' ? clean : undefined
    log(`${entry.request.type ?? 'permission'} ${id} → ${decision}`)
    release(entry, 200, { decision, answers: entry.answers })
    setTimeout(() => permissions.delete(id), KEEP_DECIDED_MS).unref?.()
    changed()

    return true
  }

  function cancel(id) {
    const entry = permissions.get(id)
    if (!entry) return
    permissions.delete(id)
    log(`request ${id} withdrawn by its session`)
    release(entry, 404, { error: 'gone' })
    changed()
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // A web page could reach 127.0.0.1 from a browser; it carries an Origin.
    if (req.headers.origin) return send(res, 403, { error: 'forbidden' })
    if (!sameToken(req.headers['x-island-token'], token)) return send(res, 401, { error: 'token' })

    if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { ok: true })

    if (req.method === 'POST' && url.pathname === '/v1/session') {
      const body = await readBody(req)
      if (typeof body.sessionId !== 'string' || body.sessionId === '') return send(res, 400, { error: 'sessionId' })
      if (!sessions.has(body.sessionId)) log(`session ${body.sessionId} (${body.project ?? '?'}) connected`)
      sessions.set(body.sessionId, { ...body, seenAt: now() })
      changed()

      return send(res, 204)
    }

    if (req.method === 'POST' && url.pathname === '/v1/session/end') {
      const body = await readBody(req)
      sessions.delete(body.sessionId)
      for (const [id, entry] of permissions) if (entry.request.sessionId === body.sessionId) cancel(id)
      changed()

      return send(res, 204)
    }

    if (req.method === 'POST' && url.pathname === '/v1/permission') {
      const body = await readBody(req)
      if (typeof body.id !== 'string' || body.id === '') return send(res, 400, { error: 'id' })
      permissions.set(body.id, { request: body, createdAt: now(), decision: undefined, waiters: new Set() })
      log(`${body.type ?? 'permission'} ${body.id} from ${body.project ?? '?'}: ${body.title ?? body.tool ?? ''}`)
      changed()

      return send(res, 201, { id: body.id })
    }

    const match = /^\/v1\/permission\/(.+)$/.exec(url.pathname)
    if (match) {
      const id = decodeURIComponent(match[1])
      const entry = permissions.get(id)
      if (req.method === 'DELETE') {
        cancel(id)

        return send(res, 204)
      }
      if (req.method === 'GET') {
        if (!entry) return send(res, 404, { error: 'unknown' })
        if (entry.decision !== undefined) return send(res, 200, { decision: entry.decision, answers: entry.answers })
        const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0))
        if (wait === 0) return send(res, 204)
        const waiter = { res, timer: undefined }
        waiter.timer = setTimeout(() => {
          entry.waiters.delete(waiter)
          send(res, 204)
        }, wait * 1000)
        entry.waiters.add(waiter)
        req.on('close', () => {
          clearTimeout(waiter.timer)
          entry.waiters.delete(waiter)
        })

        return undefined
      }
    }

    return send(res, 404, { error: 'route' })
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(() => send(res, 400, { error: 'bad request' }))
  })
  const ticker = setInterval(changed, 5000)
  ticker.unref?.()

  return {
    server,
    snapshot,
    decide,
    cancel,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve(server.address().port)
        })
      })
    },
    close() {
      clearInterval(ticker)
      for (const entry of permissions.values()) release(entry, 404, { error: 'closing' })
      server.close()
    },
  }
}

module.exports = { createHub }
