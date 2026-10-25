'use strict'

// Finds the dev servers listening on this machine: ports held by node, python, bun and
// the like, named after what runs them (vite, next, uvicorn...) and the project folder
// their command line points into. Windows only: netstat, tasklist and one CIM query for
// the command line of each process seen for the first time.

const { execFile } = require('node:child_process')

const DEV = /^(node|bun|deno|python\d*(\.\d+)?|pythonw?|py|ruby|php|java|dotnet|go|uvicorn|gunicorn|hugo|caddy|nginx|esbuild|vite)(\.exe)?$/i
const KNOWN = [
  ['vite', /\bvite\b/i],
  ['next', /\bnext\b/i],
  ['nuxt', /\bnuxt\b/i],
  ['astro', /\bastro\b/i],
  ['remix', /\bremix\b/i],
  ['storybook', /storybook/i],
  ['webpack', /webpack/i],
  ['expo', /\bexpo\b/i],
  ['angular', /\bng(\.js)?\s+serve|@angular/i],
  ['svelte', /svelte-kit|sveltekit/i],
  ['wrangler', /wrangler/i],
  ['uvicorn', /uvicorn/i],
  ['flask', /flask/i],
  ['django', /manage\.py\s+runserver/i],
  ['http.server', /http\.server/i],
  ['jupyter', /jupyter/i],
  ['rails', /\brails\b/i],
]
const commandLines = new Map()

function run(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, out) =>
      resolve(error ? '' : String(out)),
    )
  })
}

function listening(netstat, skipPort) {
  const ports = new Map()
  for (const line of netstat.split(/\r?\n/)) {
    // A listening socket has no remote end (0.0.0.0:0 or [::]:0), whatever the locale
    // calls the state column.
    const m = /^\s*TCP\s+(\S+):(\d+)\s+(?:0\.0\.0\.0:0|\[::\]:0)\s+\S+\s+(\d+)\s*$/i.exec(line)
    if (!m) continue
    const [, host, rawPort, pid] = m
    if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\])$/.test(host)) continue
    const port = Number(rawPort)
    if (port < 1024 || port === skipPort || ports.has(port)) continue
    ports.set(port, Number(pid))
  }

  return ports
}

function processNames(tasklist) {
  const names = new Map()
  for (const line of tasklist.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line)
    if (m) names.set(Number(m[2]), m[1])
  }

  return names
}

async function readCommandLines(pids) {
  const fresh = pids.filter(pid => !commandLines.has(pid))
  if (fresh.length === 0) return
  const filter = fresh.map(pid => `ProcessId=${pid}`).join(' OR ')
  const out = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`,
  ])
  for (const pid of fresh) commandLines.set(pid, '')
  for (const line of out.split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (tab > 0) commandLines.set(Number(line.slice(0, tab)), line.slice(tab + 1))
  }
}

function describe(name, command) {
  const kind = KNOWN.find(([, test]) => test.test(command))?.[0] ?? name.replace(/\.exe$/i, '')
  const project =
    /([^\\/"]+)[\\/]node_modules[\\/]/i.exec(command)?.[1] ??
    /([^\\/"]+)[\\/](?:\.venv|venv)[\\/]/i.exec(command)?.[1] ??
    undefined

  return { kind, project }
}

async function scanServers({ skipPort } = {}) {
  if (process.platform !== 'win32') return []
  const [netstat, tasklist] = await Promise.all([run('netstat', ['-ano', '-p', 'TCP']), run('tasklist', ['/fo', 'csv', '/nh'])])
  const names = processNames(tasklist)
  const found = [...listening(netstat, skipPort)]
    .map(([port, pid]) => ({ port, pid, name: names.get(pid) ?? '' }))
    .filter(s => DEV.test(s.name))
  await readCommandLines([...new Set(found.map(s => s.pid))])
  for (const pid of commandLines.keys()) if (!names.has(pid)) commandLines.delete(pid)

  return found
    .map(s => ({ port: s.port, pid: s.pid, ...describe(s.name, commandLines.get(s.pid) ?? '') }))
    .sort((a, b) => a.port - b.port)
}

module.exports = { scanServers, listening, describe }
