import { mascotSvg } from './mascot.js'

// The island's page. It draws the state the app sends and hands back decisions; every
// text from a session is escaped before it reaches the page.

const api = window.claudeIsland ?? demoApi()
const root = document.getElementById('island')
const SKINS = 10

let state = { sessions: [], permissions: [], companion: { skin: 0, name: 'Pixel', level: 1, days: 1 }, style: 'attached' }
let hovering = false
const drawn = new Map()

root.innerHTML = `
  <div class="is-bar">
    <div class="is-pet" data-part="pet"></div>
    <div class="is-bar-text" data-part="status"></div>
    <div class="is-chip" data-part="chip"></div>
  </div>
  <div class="is-body"><div class="is-body-inner"><div class="is-content">
    <div class="is-head" data-part="head"></div>
    <div class="is-usage" data-part="usage"></div>
    <div data-part="perm"></div>
    <div class="is-section">Serveurs lancés</div>
    <div class="is-servers" data-part="servers"></div>
    <div class="is-section">Sessions au travail</div>
    <div class="is-sessions" data-part="sessions"></div>
    <div class="is-foot" data-part="foot"></div>
  </div></div></div>`

function part(name, html) {
  if (drawn.get(name) === html) return
  const el = root.querySelector(`[data-part="${name}"]`)
  // Never redraw under a field being typed in: it would lose its focus.
  if (document.activeElement?.tagName === 'INPUT' && el.contains(document.activeElement) && html !== '') return
  drawn.set(name, html)
  el.innerHTML = html
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 10) return 'à l’instant'
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`

  return `${Math.floor(s / 3600)} h`
}

function until(iso) {
  if (!iso) return ''
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60000)
  if (!(min > 0)) return 'remise à zéro imminente'
  if (min < 60) return `remise à zéro dans ${min} min`
  const h = Math.floor(min / 60)

  return h < 48 ? `remise à zéro dans ${h} h ${String(min % 60).padStart(2, '0')}` : `remise à zéro dans ${Math.round(h / 24)} j`
}

function modelName(model) {
  const found = /(opus|sonnet|haiku|fable)(?:[-_ ]?(\d{1,2})(?!\d))?(?:[-._](\d{1,2})(?!\d))?/i.exec(model ?? '')
  if (!found) return model ? String(model).slice(0, 14) : ''
  const family = found[1].toLowerCase()

  return family[0].toUpperCase() + family.slice(1) + (found[2] ? ` ${found[2]}${found[3] ? `.${found[3]}` : ''}` : '')
}

function usage() {
  const withLimits = state.sessions.find(s => Array.isArray(s.rateLimits) && s.rateLimits.length > 0)
  const limits = withLimits?.rateLimits ?? []

  return {
    five: limits.find(l => l.kind === 'five_hour'),
    week: limits.find(l => l.kind === 'seven_day'),
  }
}

function sessionStatus(s) {
  if (s.isStale) return { dot: '', text: 'Déconnectée' }
  if (s.waiting > 0) return { dot: 'is-waiting', text: '⏳ Attend ton accord' }
  if (s.phase === 'tool' && s.activity) return { dot: 'is-tool', text: `${s.activity.icon} ${s.activity.label}` }
  if (s.phase === 'thinking') return { dot: 'is-thinking', text: '💭 Réfléchit…' }

  return { dot: 'is-idle', text: 'Prête' }
}

function isBusy(s) {
  return !s.isStale && (s.phase !== 'idle' || s.waiting > 0 || (s.agents ?? []).some(a => a.phase === 'running'))
}

function drawBar() {
  const pending = state.permissions
  const live = state.sessions.filter(isBusy)
  const pet = state.companion
  const mood = pending.length ? 'work' : live.length ? 'work' : state.sessions.length ? 'idle' : 'sleep'
  part('pet', mascotSvg(pet.skin, mood, 24, 23))
  root.querySelector('[data-part="pet"]').classList.toggle('is-hop', pending.length > 0)

  if (pending.length) {
    const first = pending[0]
    const what = first.type === 'question' ? 'Une question pour toi' : first.type === 'plan' ? 'Plan à valider' : 'Attend ton accord'
    part('status', `<span class="is-warn">${what}</span> <span class="is-sub">· ${esc(first.project)}${pending.length > 1 ? ` · +${pending.length - 1}` : ''}</span>`)
  } else if (live.length) {
    const s = live[0]
    const what = sessionStatus(s).text
    part('status', `${live.length} session${live.length > 1 ? 's' : ''} active${live.length > 1 ? 's' : ''} <span class="is-sub">· ${esc(what)}</span>`)
  } else if (state.sessions.length) {
    part('status', `Tout est calme <span class="is-sub">· ${state.sessions.length} session${state.sessions.length > 1 ? 's' : ''}</span>`)
  } else {
    part('status', `<span class="is-sub">Aucune session Claude Code</span>`)
  }

  const { five } = usage()
  const running = (state.servers ?? []).length
  part(
    'chip',
    (running ? `<span class="is-srv" title="${running} serveur${running > 1 ? 's' : ''} lancé${running > 1 ? 's' : ''}">● ${running}</span>` : '') +
      (five ? `5 h <b>${Math.round(five.percentUsed)} %</b>` : ''),
  )
}

function drawServers() {
  const list = state.servers ?? []
  part(
    'servers',
    list.length === 0
      ? `<span class="is-none">Aucun serveur de dev en cours</span>`
      : list
          .map(
            s =>
              `<button class="is-server" data-port="${Number(s.port)}" title="Ouvrir http://localhost:${Number(s.port)}"><i class="is-live"></i><b>:${Number(s.port)}</b><span>${esc(s.kind)}${s.project ? ` · ${esc(s.project)}` : ''}</span></button>`,
          )
          .join(''),
  )
}

function meter(label, limit) {
  if (!limit) return `<div class="is-meter"><div class="is-meter-top"><span>${label}</span><b>—</b></div><div class="is-track"></div><div class="is-reset">pas encore de mesure</div></div>`
  const pct = Math.max(0, Math.min(100, limit.percentUsed))

  return `<div class="is-meter"><div class="is-meter-top"><span>${label}</span><b>${Math.round(limit.percentUsed)} %</b></div><div class="is-track"><div class="is-fill${pct >= 80 ? ' is-hot' : ''}" style="width:${pct}%"></div></div><div class="is-reset">${esc(until(limit.resetsAt))}</div></div>`
}

function code(request) {
  const lines = String(request.body ?? '').split('\n')
  if (request.kind === 'command') return lines.map(l => `<div class="is-cmd">${esc(l)}</div>`).join('')

  return lines
    .map(l => {
      const kind = l.startsWith('+') ? 'is-add' : l.startsWith('-') ? 'is-del' : ''

      return `<div class="${kind}">${esc(l)}</div>`
    })
    .join('')
}

// The choices picked on a question card, kept across redraws: "id|question" → labels.
const picks = new Map()
// Requests already drawn once: only a new one slides in.
const seen = new Set()

function entrance(id) {
  if (seen.has(id)) return ''
  seen.add(id)

  return ' is-new'
}
const others = new Map()

function answersFor(r) {
  const answers = {}
  ;(r.questions ?? []).forEach((q, qi) => {
    const key = `${r.id}|${qi}`
    const fallback = q.kind === 'number' && q.defaultValue !== undefined ? String(q.defaultValue) : ''
    const typed = (others.get(key) ?? fallback).trim()
    const chosen = [...(picks.get(key) ?? [])]
    // Several choices are joined with commas, as Claude's own dialog answers them; a
    // typed answer joins them on a multiple-choice question and replaces a single one.
    const value = q.multiSelect ? [...chosen, ...(typed ? [typed] : [])].join(', ') : typed || chosen[0] || ''
    if (value) answers[q.question] = value
  })

  return answers
}

function isComplete(r) {
  return Object.keys(answersFor(r)).length === (r.questions ?? []).length
}

function drawQuestion(r, count) {
  const blocks = (r.questions ?? [])
    .map((q, qi) => {
      const key = `${r.id}|${qi}`
      const chosen = picks.get(key) ?? new Set()
      const kind = q.kind ?? 'choice'
      const mark = q.multiSelect ? 'is-check' : 'is-radio'
      const options = (q.options ?? [])
        .map(
          (o, oi) =>
            `<button class="is-opt${chosen.has(o.label) ? ' is-picked' : ''}" data-pick="${qi}:${oi}" data-id="${esc(r.id)}" role="${q.multiSelect ? 'checkbox' : 'radio'}" aria-checked="${chosen.has(o.label)}"><i class="${mark}"></i><div><b>${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ''}</div></button>`,
        )
        .join('')
      const typed = esc(others.get(key) ?? (kind === 'number' && q.defaultValue !== undefined ? String(q.defaultValue) : ''))
      const field =
        kind === 'number'
          ? `<div class="is-num"><input class="is-other" type="number" data-other="${qi}" data-id="${esc(r.id)}" ${q.min !== undefined ? `min="${Number(q.min)}"` : ''} ${q.max !== undefined ? `max="${Number(q.max)}"` : ''} ${q.step !== undefined ? `step="${Number(q.step)}"` : ''} value="${typed}" />${q.unit ? `<span>${esc(q.unit)}</span>` : ''}</div>`
          : `<input class="is-other" data-other="${qi}" data-id="${esc(r.id)}" placeholder="${esc(kind === 'text' ? q.placeholder ?? 'Ta réponse…' : q.multiSelect ? 'Ajouter une autre réponse…' : 'Autre réponse…')}" value="${typed}" />`
      const total = (r.questions ?? []).length

      return `<div class="is-q">
        <div class="is-q-head">${total > 1 ? `${qi + 1}/${total} · ` : ''}${esc(q.header)}${q.multiSelect ? ' · <em>plusieurs choix possibles</em>' : ''}</div>
        <div class="is-q-text">${esc(q.question)}</div>
        ${q.description ? `<div class="is-q-desc">${esc(q.description)}</div>` : ''}
        ${kind === 'choice' ? `<div class="is-opts">${options}</div>` : ''}
        ${field}
      </div>`
    })
    .join('')

  return `<div class="is-perm is-question${entrance(r.id)}">
    <div class="is-perm-head"><span class="is-badge">Claude Code</span><span>· ${esc(r.project)} · a une question</span><span class="is-count">1 sur ${count}</span></div>
    ${blocks}
    <div class="is-actions"><button class="is-btn is-primary" data-send="${esc(r.id)}" ${isComplete(r) ? '' : 'disabled'}>Envoyer la réponse</button></div>
    <button class="is-link" data-decide="defer" data-id="${esc(r.id)}">Répondre dans Claude</button>
  </div>`
}

// A plan's markdown, read line by line: headings, bullets and plain lines.
function planLines(text) {
  return String(text ?? '')
    .split('\n')
    .map(line => {
      const heading = /^(#{1,4})\s+(.*)$/.exec(line)
      if (heading) return `<div class="is-plan-h${heading[1].length}">${esc(heading[2])}</div>`
      const bullet = /^(\s*)(?:[-*]|\d+\.)\s+(.*)$/.exec(line)
      if (bullet) return `<div class="is-plan-li" style="padding-left:${8 + Math.min(4, bullet[1].length / 2) * 10}px">${esc(bullet[2])}</div>`
      return line.trim() ? `<div class="is-plan-p">${esc(line)}</div>` : '<div class="is-plan-gap"></div>'
    })
    .join('')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

function drawPlan(r, count) {
  return `<div class="is-perm is-plan${entrance(r.id)}">
    <div class="is-perm-head"><span class="is-badge">Claude Code</span><span>· ${esc(r.project)} · propose un plan</span><span class="is-count">1 sur ${count}</span></div>
    <div class="is-perm-title">Plan prêt à valider</div>
    <div class="is-plan-body">${r.body ? planLines(r.body) : '<div class="is-plan-p">Le plan est affiché dans Claude.</div>'}</div>
    <div class="is-plan-hint">Validez ou modifiez-le dans Claude : seule sa fenêtre peut approuver un plan. Cette carte disparaît dès qu’il est tranché.</div>
    <button class="is-link" data-decide="defer" data-id="${esc(r.id)}">Masquer</button>
  </div>`
}

function drawPermission() {
  const pending = state.permissions
  if (!pending.length) return part('perm', '')
  const r = pending[0]
  if (r.type === 'question') return part('perm', drawQuestion(r, pending.length))
  if (r.type === 'plan') return part('perm', drawPlan(r, pending.length))
  const who = r.agent ? ` · sous-agent « ${esc(r.agent)} »` : ''
  part(
    'perm',
    `<div class="is-perm${entrance(r.id)}">
      <div class="is-perm-head"><span class="is-badge">Claude Code</span><span>· ${esc(r.project)}${who} · demande une autorisation</span><span class="is-count">1 sur ${pending.length}</span></div>
      <div class="is-perm-title">${esc(r.title)}</div>
      ${r.file ? `<div class="is-perm-file">${esc(r.file)}</div>` : ''}
      <div class="is-code">${code(r)}</div>
      <div class="is-actions">
        <button class="is-btn is-danger" data-decide="deny" data-id="${esc(r.id)}">Refuser <kbd>Ctrl N</kbd></button>
        ${r.canAlways ? `<button class="is-btn" data-decide="always" data-id="${esc(r.id)}">Toujours</button>` : ''}
        <button class="is-btn is-primary" data-decide="allow" data-id="${esc(r.id)}">Autoriser <kbd>Ctrl Y</kbd></button>
      </div>
      <button class="is-link" data-decide="defer" data-id="${esc(r.id)}">Répondre dans Claude</button>
      ${pending.length > 1 ? `<div class="is-more">+ ${pending.length - 1} autre${pending.length > 2 ? 's' : ''} demande${pending.length > 2 ? 's' : ''} en attente</div>` : ''}
    </div>`,
  )
}

function drawSessions() {
  const working = state.sessions.filter(isBusy)
  if (!working.length) {
    part('sessions', `<div class="is-empty">${state.sessions.length ? 'Aucune session au travail pour l’instant.' : 'Lance Claude Code : chaque session au travail apparaîtra ici.'}</div>`)

    return
  }
  part(
    'sessions',
    working
      .map(s => {
        const status = sessionStatus(s)
        const running = (s.agents ?? []).filter(a => a.phase === 'running')
        const agents = running.length
          ? `<span class="is-agents" title="${running.length} sous-agent${running.length > 1 ? 's' : ''}">${running
              .slice(0, 4)
              .map(a => mascotSvg(a.skin, 'work', 20, 19))
              .join('')}<span class="is-n">${running.length}</span></span>`
          : ''

        return `<div class="is-session${s.isStale ? ' is-stale' : ''}">
          <div class="is-dot ${status.dot}"></div>
          <div class="is-s-title">${esc(s.project)}${s.title ? ` <span>· ${esc(s.title)}</span>` : ''}</div>
          <div class="is-s-meta">${esc(ago(s.updatedAt ?? Date.now()))}</div>
          <div class="is-s-line"><span class="is-act">${esc(status.text)}</span>${agents}${s.model ? `<span class="is-model">${esc(modelName(s.model))}</span>` : ''}</div>
        </div>`
      })
      .join(''),
  )
}

function render() {
  document.body.classList.toggle('is-floating', state.style === 'floating')
  document.body.classList.toggle('is-light', state.theme === 'light')
  const pending = state.permissions.length > 0
  root.classList.toggle('is-open', hovering || pending)
  root.classList.toggle('is-alert', pending)
  drawBar()

  const pet = state.companion
  part(
    'head',
    `<div class="is-pet${pending ? ' is-hop' : ''}">${mascotSvg(pet.skin, pending || state.sessions.some(isBusy) ? 'work' : 'idle', 56, 54)}</div>
     <div class="is-head-text"><div class="is-name">${esc(pet.name)}</div><div class="is-level">Complicité niveau ${pet.level} · ${pet.days} jour${pet.days > 1 ? 's' : ''} ensemble</div></div>
     <div class="is-skin-nav"><button class="is-icon-btn" data-theme="${state.theme === 'light' ? 'dark' : 'light'}" title="${state.theme === 'light' ? 'Passer en sombre' : 'Passer en clair'}">${state.theme === 'light' ? '☾' : '☀'}</button><button class="is-icon-btn" data-skin="-1" title="Compagnon précédent">‹</button><button class="is-icon-btn" data-skin="1" title="Compagnon suivant">›</button></div>`,
  )
  const { five, week } = usage()
  part('usage', meter('Limite 5 h', five) + meter('Limite 7 jours', week))
  drawPermission()
  drawServers()
  drawSessions()
  const busy = state.sessions.filter(isBusy).length
  part('foot', `${state.sessions.length} session${state.sessions.length > 1 ? 's' : ''} · ${busy} active${busy > 1 ? 's' : ''}`)
}

// Opens and folds the moment the pointer crosses the island's edge.
root.addEventListener('mouseenter', () => {
  hovering = true
  api.hover(true)
  render()
})
root.addEventListener('mouseleave', () => {
  hovering = false
  api.hover(false)
  render()
})
root.addEventListener('click', event => {
  const target = event.target.closest('button')
  if (!target) return
  if (target.dataset.decide) api.decide(target.dataset.id, target.dataset.decide)
  if (target.dataset.pick) {
    const request = state.permissions.find(p => p.id === target.dataset.id)
    const [qi, oi] = target.dataset.pick.split(':').map(Number)
    const q = request?.questions?.[qi]
    const label = q?.options?.[oi]?.label
    if (!q || label === undefined) return
    const key = `${request.id}|${qi}`
    const chosen = new Set(q.multiSelect ? picks.get(key) ?? [] : [])
    if (chosen.has(label) && q.multiSelect) chosen.delete(label)
    else chosen.add(label)
    picks.set(key, chosen)
    if (!q.multiSelect) others.delete(key)
    render()
  }
  if (target.dataset.send) {
    const request = state.permissions.find(p => p.id === target.dataset.send)
    if (request && isComplete(request)) api.decide(request.id, 'answer', answersFor(request))
  }
  if (target.dataset.port) api.openServer(Number(target.dataset.port))
  if (target.dataset.theme) api.setTheme(target.dataset.theme)
  if (target.dataset.skin) {
    api.setCompanion({ skin: (state.companion.skin + Number(target.dataset.skin) + SKINS) % SKINS })
  }
})

root.addEventListener('input', event => {
  const field = event.target.closest('[data-other]')
  if (!field) return
  const key = `${field.dataset.id}|${field.dataset.other}`
  others.set(key, field.value)
  const typedFor = state.permissions.find(p => p.id === field.dataset.id)?.questions?.[Number(field.dataset.other)]
  if (field.value.trim() && !typedFor?.multiSelect) picks.delete(key)
  const request = state.permissions.find(p => p.id === field.dataset.id)
  const send = root.querySelector(`[data-send="${CSS.escape(field.dataset.id)}"]`)
  if (request && send) send.disabled = !isComplete(request)
})

api.onState(next => {
  state = next
  render()
})
api.ready()
// Relative times ("3 min") age even when nothing is pushed.
setInterval(render, 15000)

// Outside the app (a browser preview), the page draws a sample state.
function demoApi() {
  let listener = () => {}
  const now = Date.now()
  const demo = {
    style: 'attached',
    theme: new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark',
    servers: [
      { port: 3000, kind: 'next', project: 'checkout-app' },
      { port: 5173, kind: 'vite', project: 'site-web' },
      { port: 8000, kind: 'uvicorn' },
    ],
    companion: { skin: 0, name: 'Pixel', level: 3, days: 3 },
    permissions: [
      ...(new URLSearchParams(location.search).has('plan')
        ? [
            {
              id: 'demo:p',
              type: 'plan',
              project: 'checkout-app',
              title: 'Plan prêt à valider',
              body: [
                '# Mode sombre',
                '',
                '## 1. Thème',
                '- Ajouter `darkColors` dans **theme.ts**',
                '- Lire la préférence du système',
                '',
                '## 2. Réglages',
                '- Interrupteur dans Settings.tsx',
                '  - mémorisé dans `localStorage`',
                '',
                'Tests : `npm test`',
              ].join('\n'),
            },
          ]
        : []),
      ...(new URLSearchParams(location.search).has('question')
        ? [
            {
              id: 'demo:q',
              type: 'question',
              project: 'checkout-app',
              title: 'Quelle base de données en local ?',
              questions: [
                {
                  question: 'Quelle base de données en local ?',
                  header: 'Base',
                  multiSelect: false,
                  options: [
                    { label: 'Postgres dans Docker', description: 'Comme la production' },
                    { label: 'Fichier SQLite', description: 'Le plus simple pour démarrer' },
                  ],
                },
                {
                  question: 'Quels tests ajouter ?',
                  header: 'Tests',
                  multiSelect: true,
                  options: [
                    { label: 'Unitaires', description: 'Les fonctions du thème' },
                    { label: 'Intégration', description: 'La page des réglages' },
                    { label: 'Bout en bout', description: 'Le parcours complet' },
                  ],
                },
              ],
            },
          ]
        : []),
      {
        id: 'demo:1',
        project: 'checkout-app',
        title: 'Modifier middleware.ts ?',
        file: 'src/auth/middleware.ts',
        kind: 'diff',
        canAlways: true,
        body: '-  if (token) return next()\n+  if (await verify(token)) return next()\n   res.status(401).end()',
      },
    ],
    sessions: [
      { sessionId: 'a', project: 'checkout-app', title: 'Ajouter le mode sombre', phase: 'tool', waiting: 1, model: 'claude-opus-5-5', updatedAt: now, activity: { icon: '✏️', label: 'Modifie theme.ts' }, agents: [{ skin: 1, phase: 'running' }, { skin: 2, phase: 'running' }], rateLimits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: new Date(now + 2 * 3600e3).toISOString() }, { kind: 'seven_day', percentUsed: 18, resetsAt: new Date(now + 4 * 86400e3).toISOString() }] },
      { sessionId: 'b', project: 'checkout-app', title: 'Écrire les tests du paiement', phase: 'tool', waiting: 0, model: 'claude-sonnet-5-5', updatedAt: now - 12 * 60e3, activity: { icon: '⌨️', label: '$ npm test' }, agents: [] },
      { sessionId: 'c', project: 'site-web', title: 'Convertir les images', phase: 'idle', waiting: 0, model: 'claude-haiku-5-5', updatedAt: now - 3 * 60e3, agents: [] },
    ],
  }

  return {
    onState: callback => {
      listener = callback
    },
    ready: () => listener(demo),
    hover: () => {},
    decide: id => {
      demo.permissions = demo.permissions.filter(p => p.id !== id)
      demo.sessions[0].waiting = 0
      listener({ ...demo })
    },
    setCompanion: change => {
      demo.companion = { ...demo.companion, ...change }
      listener({ ...demo })
    },
    setTheme: theme => {
      demo.theme = theme
      listener({ ...demo })
    },
    openServer: () => {},
  }
}
