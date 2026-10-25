import { mascotSvg } from './mascot.js'
import { agentName, translator } from './i18n.js'

// The island's page. It draws the state the app sends and hands back decisions; every
// text from a session is escaped before it reaches the page.

const api = window.claudeIsland ?? demoApi()
const root = document.getElementById('island')
const SKINS = 10
const SERVERS_SHOWN = 3

let state = { sessions: [], permissions: [], companion: { skin: 0, name: 'Pixel', level: 1, days: 1 }, style: 'attached', lang: 'en' }
let t = translator('en')
let hovering = false
let dragging = false
let serversOpen = false
// The island tucks into a notch after a few quiet seconds, so it never sits on the tabs
// or buttons under it; hovering it, a request or a session changing state brings it back.
const TUCK_AFTER_MS = 4000
let lastActivity = Date.now()
let lastBusy = ''
let tuckTimer
const drawn = new Map()

root.innerHTML = `
  <div class="is-bar">
    <div class="is-pet" data-part="pet"></div>
    <div class="is-bar-text" data-part="status"></div>
    <div class="is-chip" data-part="chip"></div>
    <div class="is-glance"><div class="is-glance-fill"></div></div>
  </div>
  <div class="is-body"><div class="is-body-inner"><div class="is-content">
    <div class="is-head" data-part="head"></div>
    <div class="is-usage" data-part="usage"></div>
    <div data-part="perm"></div>
    <div class="is-section" data-part="servers-title"></div>
    <div data-part="servers"></div>
    <div class="is-section" data-part="sessions-title"></div>
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

// Thin line icons, drawn in the text colour.
const ICONS = {
  prev: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  next: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M3.5 12.5l1.1-1.1M11.4 4.6l1.1-1.1"/>',
  moon: '<path d="M13 9.6A5.4 5.4 0 0 1 6.4 3a5.4 5.4 0 1 0 6.6 6.6Z"/>',
  chevron: '<path d="M4 6l4 4 4-4"/>',
  open: '<path d="M6 3.5H3.5v9h9V10M9 3h4v4M13 3 7.5 8.5"/>',
}

function icon(name, size = 14) {
  return `<svg class="is-ico" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 10) return t('ago.now')
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`

  return `${Math.floor(s / 3600)} h`
}

function until(iso) {
  if (!iso) return ''
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60000)
  if (!(min > 0)) return t('reset.soon')
  if (min < 60) return t('reset.min', { n: min })
  const h = Math.floor(min / 60)

  return h < 48 ? t('reset.hours', { h, m: String(min % 60).padStart(2, '0') }) : t('reset.days', { n: Math.round(h / 24) })
}

function modelName(model) {
  const found = /(opus|sonnet|haiku|fable|grok)(?:[-_ ]?(\d{1,2})(?!\d))?(?:[-._](\d{1,2})(?!\d))?/i.exec(model ?? '')
  if (!found) return model ? String(model).slice(0, 14) : ''
  const family = found[1].toLowerCase()

  return family[0].toUpperCase() + family.slice(1) + (found[2] ? ` ${found[2]}${found[3] ? `.${found[3]}` : ''}` : '')
}

// A session's action in the island's language: by its key when the agent sent one.
function activityText(act) {
  if (!act) return ''
  const text = act.key ? t(`act.${act.key}`, { arg: act.arg }) : undefined

  return `${act.icon ?? '🛠️'} ${text ?? act.label ?? ''}`
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
  if (s.isStale) return { dot: '', text: t('status.stale') }
  if (justDone(s)) return s.outcome === 'done' ? { dot: 'is-done', text: t('status.done') } : { dot: 'is-idle', text: t('status.stopped') }
  if (s.waiting > 0) return { dot: 'is-waiting', text: t('status.waiting') }
  if (s.phase === 'tool' && s.activity) return { dot: 'is-tool', text: activityText(s.activity) }
  if (s.phase === 'thinking') return { dot: 'is-thinking', text: t('status.thinking') }

  return { dot: 'is-idle', text: t('status.ready') }
}

// A session that just finished stays in the list, at 100 %, for a few seconds.
const DONE_SHOWN_MS = 10_000
const ESTIMATE_CAP = 0.9
const ESTIMATE_SCALE = 12

function justDone(s) {
  return !s.isStale && s.phase === 'idle' && !(s.waiting > 0) && typeof s.finishedAt === 'number' && Date.now() - s.finishedAt < DONE_SHOWN_MS
}

// 0 to 1, as the bridge measured it, or estimated here from an adapter's action count
// (same curve as bridge/hooks/progress.ts). Undefined when nothing tells.
function progressOf(s) {
  if (justDone(s) && s.outcome === 'done' && !(s.progress?.measured && s.progress.done < s.progress.total)) return { ...(s.progress ?? { measured: false }), value: 1, done: s.progress?.total }
  if (s.progress && typeof s.progress.value === 'number') return s.progress
  if (typeof s.actions === 'number') return { value: ESTIMATE_CAP * (1 - Math.exp(-s.actions / ESTIMATE_SCALE)), measured: false }

  return undefined
}

const shownPct = new Map()

function progressBar(s) {
  const p = progressOf(s)
  if (!p) return ''
  const pct = Math.round(Math.max(0, Math.min(1, p.value)) * 100)
  const from = shownPct.get(s.sessionId) ?? 0
  shownPct.set(s.sessionId, pct)
  const steps = p.measured && p.total ? `<span class="is-steps">${p.done ?? 0}/${p.total}</span>` : ''
  const label = p.measured || pct === 100 ? `${pct} %` : `~${pct} %`

  return `<div class="is-progress${pct === 100 ? ' is-full' : ''}" title="${t(p.measured ? 'progress.measured' : 'progress.estimate')}">
    <div class="is-track"><div class="is-fill" style="width:${from}%" data-to="${pct}"></div></div>${steps}<span class="is-pct">${label}</span>
  </div>`
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
    const what = t(first.type === 'question' ? 'bar.question' : first.type === 'plan' ? 'bar.plan' : 'bar.waiting')
    part('status', `<span class="is-warn">${what}</span> <span class="is-sub">· ${esc(first.project)}${pending.length > 1 ? ` · +${pending.length - 1}` : ''}</span>`)
  } else if (live.length) {
    part('status', `${t('bar.active', { n: live.length })} <span class="is-sub">· ${esc(sessionStatus(live[0]).text)}</span>`)
  } else if (state.sessions.length) {
    part('status', `${t('bar.calm')} <span class="is-sub">· ${t('sessions', { n: state.sessions.length })}</span>`)
  } else {
    part('status', `<span class="is-sub">${t('bar.none')}</span>`)
  }

  const { five } = usage()
  const running = (state.servers ?? []).length
  part(
    'chip',
    (running ? `<span class="is-srv" title="${t('chip.servers', { n: running })}">● ${running}</span>` : '') +
      (five ? `5 h <b>${Math.round(five.percentUsed)} %</b>` : ''),
  )
}

// Three servers as chips; past three, a drawer unfolds every one with its details.
function drawServers() {
  const list = state.servers ?? []
  part('servers-title', t('section.servers'))
  if (list.length === 0) return part('servers', `<span class="is-none">${t('servers.none')}</span>`)
  const more = list.length - SERVERS_SHOWN
  const chip = s =>
    `<button class="is-server" data-port="${Number(s.port)}" title="${t('servers.open', { port: Number(s.port) })}"><i class="is-live"></i><b>:${Number(s.port)}</b><span>${esc(s.kind)}${s.project ? ` · ${esc(s.project)}` : ''}</span></button>`
  const toggle =
    more > 0
      ? `<button class="is-server is-drawer-btn${serversOpen ? ' is-on' : ''}" data-servers-toggle="1">${serversOpen ? t('servers.less') : t('servers.more', { n: more })}${icon('chevron', 12)}</button>`
      : ''
  if (!serversOpen || more <= 0) {
    return part('servers', `<div class="is-servers">${list.slice(0, SERVERS_SHOWN).map(chip).join('')}${toggle}</div>`)
  }
  const rows = list
    .map(
      s => `<button class="is-srv-row" data-port="${Number(s.port)}" title="${t('servers.open', { port: Number(s.port) })}">
        <i class="is-live"></i><b>:${Number(s.port)}</b>
        <span class="is-srv-kind">${esc(s.kind)}</span>
        <span class="is-srv-project">${esc(s.project ?? '')}</span>
        <span class="is-srv-pid">${s.pid ? t('servers.pid', { pid: Number(s.pid) }) : ''}</span>
        ${icon('open', 13)}
      </button>`,
    )
    .join('')
  part('servers', `<div class="is-drawer">${rows}</div><div class="is-servers">${toggle}</div>`)
}

function meter(label, limit) {
  if (!limit) return `<div class="is-meter"><div class="is-meter-top"><span>${label}</span><b>—</b></div><div class="is-track"></div><div class="is-reset">${t('meter.none')}</div></div>`
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

function cardHead(r, what, count) {
  return `<div class="is-perm-head"><span class="is-badge">${esc(agentName(r.source))}</span><span>· ${esc(r.project)} · ${what}</span><span class="is-count">${t('q.count', { i: 1, n: count })}</span></div>`
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
          : `<input class="is-other" data-other="${qi}" data-id="${esc(r.id)}" placeholder="${esc(kind === 'text' ? q.placeholder ?? t('q.text') : t(q.multiSelect ? 'q.add' : 'q.other'))}" value="${typed}" />`
      const total = (r.questions ?? []).length

      return `<div class="is-q">
        <div class="is-q-head">${total > 1 ? `${qi + 1}/${total} · ` : ''}${esc(q.header)}${q.multiSelect ? ` · <em>${t('q.several')}</em>` : ''}</div>
        <div class="is-q-text">${esc(q.question)}</div>
        ${q.description ? `<div class="is-q-desc">${esc(q.description)}</div>` : ''}
        ${kind === 'choice' ? `<div class="is-opts">${options}</div>` : ''}
        ${field}
      </div>`
    })
    .join('')

  return `<div class="is-perm is-question${entrance(r.id)}">
    ${cardHead(r, t('q.has'), count)}
    ${blocks}
    <div class="is-actions"><button class="is-btn is-primary" data-send="${esc(r.id)}" ${isComplete(r) ? '' : 'disabled'}>${t('q.send')}</button></div>
    <button class="is-link" data-decide="defer" data-id="${esc(r.id)}">${t('answer.in', { agent: agentName(r.source) })}</button>
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
  const agent = agentName(r.source)

  return `<div class="is-perm is-plan${entrance(r.id)}">
    ${cardHead(r, t('plan.has'), count)}
    <div class="is-perm-title">${t('plan.title')}</div>
    <div class="is-plan-body">${r.body ? planLines(r.body) : `<div class="is-plan-p">${t('plan.inClaude', { agent })}</div>`}</div>
    <div class="is-plan-hint">${t('plan.hint', { agent })}</div>
    <button class="is-link" data-decide="defer" data-id="${esc(r.id)}">${t('plan.hide')}</button>
  </div>`
}

// A request's title in the island's language, from its key when the agent sent one.
function permissionTitle(r) {
  return (r.titleKey && t(`perm.${r.titleKey}`, { arg: r.titleArg })) || r.title || ''
}

function drawPermission() {
  const pending = state.permissions
  if (!pending.length) return part('perm', '')
  const r = pending[0]
  if (r.type === 'question') return part('perm', drawQuestion(r, pending.length))
  if (r.type === 'plan') return part('perm', drawPlan(r, pending.length))
  const agent = agentName(r.source)
  const who = r.agent ? ` · ${t('perm.subagent', { name: esc(r.agent) })}` : ''
  // An agent whose hooks can only refuse (Grok) gets Block and "let it decide".
  const actions =
    r.canAllow === false
      ? `<button class="is-btn is-danger" data-decide="deny" data-id="${esc(r.id)}">${t('perm.block')}</button>
         <button class="is-btn is-primary" data-decide="defer" data-id="${esc(r.id)}">${t('perm.let', { agent })}</button>`
      : `<button class="is-btn is-danger" data-decide="deny" data-id="${esc(r.id)}">${t('perm.deny')} <kbd>Ctrl N</kbd></button>
         ${r.canAlways ? `<button class="is-btn" data-decide="always" data-id="${esc(r.id)}">${t('perm.always')}</button>` : ''}
         <button class="is-btn is-primary" data-decide="allow" data-id="${esc(r.id)}">${t('perm.allow')} <kbd>Ctrl Y</kbd></button>`
  part(
    'perm',
    `<div class="is-perm${entrance(r.id)}">
      <div class="is-perm-head"><span class="is-badge">${esc(agent)}</span><span>· ${esc(r.project)}${who} · ${t('perm.asks')}</span><span class="is-count">${t('q.count', { i: 1, n: pending.length })}</span></div>
      <div class="is-perm-title">${esc(permissionTitle(r))}</div>
      ${r.file ? `<div class="is-perm-file">${esc(r.file)}</div>` : ''}
      <div class="is-code">${code(r)}</div>
      <div class="is-actions">${actions}</div>
      ${r.canAllow === false ? '' : `<button class="is-link" data-decide="defer" data-id="${esc(r.id)}">${t('answer.in', { agent })}</button>`}
      ${pending.length > 1 ? `<div class="is-more">${t('perm.more', { n: pending.length - 1 })}</div>` : ''}
    </div>`,
  )
}

let doneTimer

function slideBars() {
  nextFrame(() => {
    for (const fill of root.querySelectorAll('.is-fill[data-to]')) fill.style.width = `${fill.dataset.to}%`
  })
}

// The pill's own line: how far the sessions at work are, on average.
function drawGlance() {
  const shown = state.sessions.filter(s => isBusy(s) || justDone(s)).map(progressOf).filter(Boolean)
  const glance = root.querySelector('.is-glance')
  glance.classList.toggle('is-on', shown.length > 0)
  if (!shown.length) return
  const mean = shown.reduce((sum, p) => sum + Math.max(0, Math.min(1, p.value)), 0) / shown.length
  glance.style.setProperty('--v', mean.toFixed(3))
  glance.classList.toggle('is-full', mean >= 0.999)
}
// Redraws when the next finished session has had its few seconds.
function scheduleDoneExpiry() {
  clearTimeout(doneTimer)
  const left = state.sessions.filter(justDone).map(s => DONE_SHOWN_MS - (Date.now() - s.finishedAt))
  if (left.length) doneTimer = setTimeout(render, Math.max(50, Math.min(...left) + 20))
}

function drawSessions() {
  part('sessions-title', t('section.sessions'))
  const working = state.sessions.filter(s => isBusy(s) || justDone(s))
  scheduleDoneExpiry()
  if (!working.length) {
    part('sessions', `<div class="is-empty">${t(state.sessions.length ? 'empty.idle' : 'empty.none')}</div>`)

    return
  }
  part(
    'sessions',
    working
      .map(s => {
        const status = sessionStatus(s)
        const running = (s.agents ?? []).filter(a => a.phase === 'running')
        const agents = running.length
          ? `<span class="is-agents" title="${t('subagents', { n: running.length })}">${running
              .slice(0, 4)
              .map(a => mascotSvg(a.skin, 'work', 20, 19))
              .join('')}<span class="is-n">${running.length}</span></span>`
          : ''
        const source = s.source && s.source !== 'claude-code' ? `<span class="is-src">${esc(agentName(s.source))}</span>` : ''

        return `<div class="is-session${s.isStale ? ' is-stale' : ''}${justDone(s) ? ' is-finished' : ''}" data-session="${esc(s.sessionId)}">
          <div class="is-dot ${status.dot}"></div>
          <div class="is-s-title">${source}${esc(s.project)}${s.title ? ` <span>· ${esc(s.title)}</span>` : ''}</div>
          <div class="is-s-meta">${esc(ago(s.updatedAt ?? Date.now()))}</div>
          <div class="is-s-line"><span class="is-act">${esc(status.text)}</span>${agents}${s.model ? `<span class="is-model">${esc(modelName(s.model))}</span>` : ''}</div>
          ${progressBar(s)}
        </div>`
      })
      .join(''),
  )
}

function render() {
  t = translator(state.lang ?? 'en')
  document.documentElement.lang = state.lang ?? 'en'
  document.body.classList.toggle('is-floating', state.style === 'floating')
  document.body.classList.toggle('is-light', state.theme === 'light')
  // The island's own anchor leads: it changes on a drop, before the app echoes it.
  const sent = state.placement ? `${state.placement.vertical}-${state.placement.horizontal}` : anchor
  // After a drop, older placements still in flight are ignored until the app confirms
  // the new one (or for two seconds at most).
  if (echoWait && (sent === echoWait.name || Date.now() - echoWait.since > 2000)) echoWait = undefined
  else if (!echoWait && sent !== anchor && !dragging && !gliding) {
    anchor = sent
    glide()
  }
  const [vertical, horizontal] = anchor.split('-')
  document.body.classList.toggle('is-at-bottom', vertical === 'bottom')
  document.body.classList.toggle('is-v-middle', vertical === 'middle')
  document.body.classList.toggle('is-h-left', horizontal === 'left')
  document.body.classList.toggle('is-h-right', horizontal === 'right')
  const pending = state.permissions.length > 0

  const working = state.sessions.filter(isBusy).map(s => `${s.sessionId}:${s.phase}`).join('|')
  if (working !== lastBusy) {
    lastBusy = working
    lastActivity = Date.now()
  }
  const quietFor = Date.now() - lastActivity
  const tucked = state.tuck !== false && !hovering && !dragging && !pending && quietFor >= TUCK_AFTER_MS
  root.classList.toggle('is-tucked', tucked)
  clearTimeout(tuckTimer)
  if (!tucked && !hovering && !pending) tuckTimer = setTimeout(render, Math.max(50, TUCK_AFTER_MS - quietFor))

  root.classList.toggle('is-open', (hovering && !dragging) || pending)
  root.classList.toggle('is-dragging', dragging)
  root.classList.toggle('is-alert', pending)
  drawBar()

  const pet = state.companion
  const light = state.theme === 'light'
  part(
    'head',
    `<div class="is-pet${pending ? ' is-hop' : ''}">${mascotSvg(pet.skin, pending || state.sessions.some(isBusy) ? 'work' : 'idle', 56, 54)}</div>
     <div class="is-head-text"><div class="is-name">${esc(pet.name)}</div><div class="is-level">${t('pet.level', { level: pet.level, n: pet.days })}</div></div>
     <div class="is-seg">
       <button class="is-icon-btn" data-theme="${light ? 'dark' : 'light'}" title="${t(light ? 'theme.toDark' : 'theme.toLight')}" aria-label="${t(light ? 'theme.toDark' : 'theme.toLight')}">${icon(light ? 'moon' : 'sun')}</button>
       <i class="is-seg-gap"></i>
       <button class="is-icon-btn" data-skin="-1" title="${t('pet.prev')}" aria-label="${t('pet.prev')}">${icon('prev')}</button>
       <button class="is-icon-btn" data-skin="1" title="${t('pet.next')}" aria-label="${t('pet.next')}">${icon('next')}</button>
     </div>`,
  )
  const { five, week } = usage()
  part('usage', meter(t('meter.five'), five) + meter(t('meter.week'), week))
  drawPermission()
  drawServers()
  drawSessions()
  slideBars()
  drawGlance()
  const busy = state.sessions.filter(isBusy).length
  part('foot', t('foot', { n: state.sessions.length, busy }))
}

// Opens and folds the moment the pointer crosses the island's edge.
// From the notch it opens only after a short dwell: a pointer passing over it on its way
// to a tab is not caught, and its click goes through to the tab.
const DWELL_MS = 300
let dwell
root.addEventListener('mouseenter', () => {
  const open = () => {
    hovering = true
    api.hover(true)
    render()
  }
  if (root.classList.contains('is-tucked')) dwell = setTimeout(open, DWELL_MS)
  else open()
})
root.addEventListener('mouseleave', () => {
  clearTimeout(dwell)
  if (dragging) return
  hovering = false
  lastActivity = Date.now()
  api.hover(false)
  render()
})

// ---- Placement and dragging.
// The window covers the screen and never moves: the island is placed in the page with a
// transform, on the GPU. Anchored, its corner follows its own size (it grows from its
// edge); held, it follows the pointer, with the places it can land shown and the
// nearest one pulling it in; dropped, it springs there.

const MARGIN = 12
const MAGNET_PX = 140
const SPRING = { stiffness: 300, damping: 24 }
const ANCHOR_NAMES = ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']
let anchor = 'top-center'
let echoWait
let gliding = false
let pos = { x: 0, y: 0 }
let tilt = 0

function workArea() {
  return state.area ?? { x: 0, y: 0, width: innerWidth, height: innerHeight }
}

// The island's top-left corner on an anchor, for a given size.
function anchorBox(name, w, h) {
  const a = workArea()
  const [v, hz] = name.split('-')
  const gap = state.style === 'floating' ? 10 : 0
  const inset = v === 'middle' ? 0 : MARGIN
  const x = hz === 'left' ? a.x + inset : hz === 'right' ? a.x + a.width - w - inset : a.x + (a.width - w) / 2
  const y = v === 'top' ? a.y + gap : v === 'bottom' ? a.y + a.height - h - gap : a.y + a.height * 0.22

  return { x: Math.round(x), y: Math.round(y) }
}

function setPos(x, y, angle = 0) {
  pos = { x, y }
  root.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${angle}deg)`
}

// Anchored: re-placed whenever the island changes size (opening, folding, tucking).
function layout() {
  if (dragging || gliding) return
  const box = anchorBox(anchor, root.offsetWidth, root.offsetHeight)
  setPos(box.x, box.y)
}
new ResizeObserver(layout).observe(root)
addEventListener('resize', layout)

// The next animation frame, or a timer where frames are paused (a hidden page).
function nextFrame(fn) {
  let done = false
  const go = () => {
    if (done) return
    done = true
    fn(performance.now())
  }
  requestAnimationFrame(go)
  setTimeout(go, 34)
}

// Springs from where the island is to its anchor, carrying the drag's speed and tilt.
function glide(velocity = { x: 0, y: 0 }) {
  gliding = true
  let { x, y } = pos
  let vx = velocity.x
  let vy = velocity.y
  let angle = tilt
  let va = 0
  let last = performance.now()
  const step = now => {
    const dt = Math.min(0.032, (now - last) / 1000)
    last = now
    const target = anchorBox(anchor, root.offsetWidth, root.offsetHeight)
    vx += (SPRING.stiffness * (target.x - x) - SPRING.damping * vx) * dt
    vy += (SPRING.stiffness * (target.y - y) - SPRING.damping * vy) * dt
    va += (SPRING.stiffness * -angle - SPRING.damping * va) * dt
    x += vx * dt
    y += vy * dt
    angle += va * dt
    setPos(x, y, angle)
    if (Math.hypot(target.x - x, target.y - y) < 0.4 && Math.hypot(vx, vy) < 8 && Math.abs(angle) < 0.05) {
      gliding = false
      tilt = 0
      layout()

      return
    }
    nextFrame(step)
  }
  nextFrame(step)
}

const slots = document.createElement('div')
slots.className = 'is-slots'
document.body.prepend(slots)

// On the sides the pill stands upright: its slot there is tall and narrow.
const SIDE_WIDTH = 40
function slotSize(name, w, h) {
  return name.startsWith('middle-') ? { w: SIDE_WIDTH, h: Math.round(Math.min(300, Math.max(150, w * 0.72))) } : { w, h }
}

// The slot whose centre is nearest the held pill's centre.
function nearest(x, y, w, h) {
  const cx = x + w / 2
  const cy = y + h / 2

  return ANCHOR_NAMES.map(name => {
    const size = slotSize(name, w, h)
    const box = anchorBox(name, size.w, size.h)
    const center = { x: box.x + size.w / 2, y: box.y + size.h / 2 }

    return { name, box, size, center, distance: Math.hypot(center.x - cx, center.y - cy) }
  }).sort((a, b) => a.distance - b.distance)[0]
}

function showSlots(w, h) {
  slots.innerHTML = ANCHOR_NAMES.map(name => {
    const size = slotSize(name, w, h)
    const box = anchorBox(name, size.w, size.h)

    return `<div class="is-slot${name.startsWith('middle-') ? ' is-slot-side' : ''}" data-slot="${name}" style="width:${size.w}px;height:${size.h}px;transform:translate(${box.x}px, ${box.y}px)"></div>`
  }).join('')
  slots.classList.add('is-shown')
}

let press
let grab
let lastMove
let speed = { x: 0, y: 0 }
let pointer = { x: 0, y: 0 }

root.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.target.closest('.is-bar') || event.target.closest('button')) return
  press = { x: event.clientX, y: event.clientY, id: event.pointerId }
})

addEventListener('pointermove', event => {
  pointer = { x: event.clientX, y: event.clientY }
  if (!press) return
  if (!dragging) {
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < 5) return
    dragging = true
    gliding = false
    try {
      root.setPointerCapture(press.id)
    } catch {
      // No live pointer to capture (a synthetic event): the window still follows.
    }
    grab = { dx: press.x - pos.x, dy: press.y - pos.y }
    lastMove = { x: event.clientX, y: event.clientY, t: performance.now() }
    render()
    // Measured once the island has folded to its pill.
    setTimeout(() => showSlots(root.offsetWidth, root.offsetHeight), 220)
  }
  const now = performance.now()
  const dt = Math.max(1, now - lastMove.t) / 1000
  speed = {
    x: speed.x * 0.6 + ((event.clientX - lastMove.x) / dt) * 0.4,
    y: speed.y * 0.6 + ((event.clientY - lastMove.y) / dt) * 0.4,
  }
  lastMove = { x: event.clientX, y: event.clientY, t: now }

  const w = root.offsetWidth
  const h = root.offsetHeight
  let x = event.clientX - Math.min(grab.dx, w - 14)
  let y = event.clientY - Math.min(grab.dy, h - 6)
  // The nearest place pulls the island in as it gets close.
  const near = nearest(x, y, w, h)
  const pull = Math.max(0, 1 - near.distance / MAGNET_PX) ** 2 * 0.65
  x += (near.center.x - w / 2 - x) * pull
  y += (near.center.y - h / 2 - y) * pull
  for (const slot of slots.children) slot.classList.toggle('is-near', slot.dataset.slot === near.name)
  tilt = tilt * 0.8 + Math.max(-7, Math.min(7, speed.x / 220)) * 0.2
  setPos(x, y, tilt)
})

addEventListener('pointerup', () => {
  press = undefined
  if (!dragging) return
  dragging = false
  slots.classList.remove('is-shown')
  const landing = nearest(pos.x, pos.y, root.offsetWidth, root.offsetHeight)
  anchor = landing.name
  echoWait = { name: anchor, since: Date.now() }
  api.setAnchor?.(anchor)
  root.classList.remove('is-landed')
  void root.offsetWidth
  root.classList.add('is-landed')
  glide({ x: speed.x * 0.15, y: speed.y * 0.15 })
  speed = { x: 0, y: 0 }
  // Dropped away from the pointer: hand the clicks back to what is underneath.
  const under = document.elementFromPoint(pointer.x, pointer.y)
  if (!under?.closest('#island')) {
    hovering = false
    api.hover(false)
  }
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
  if (target.dataset.serversToggle) {
    serversOpen = !serversOpen
    render()
  }
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
  // A page around the preview (the launch video) can drive it:
  // postMessage({ island: state }) and postMessage({ islandHover: true }).
  const driven = new URLSearchParams(location.search).has('driven')
  window.addEventListener('message', event => {
    const data = event.data ?? {}
    if (data.island) listener(data.island)
    if (typeof data.islandHover === 'boolean') {
      hovering = data.islandHover
      render()
    }
  })
  const params = new URLSearchParams(location.search)
  const demo = {
    style: 'attached',
    placement: { vertical: params.has('bottom') ? 'bottom' : 'top', horizontal: 'center' },
    theme: new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark',
    lang: params.get('lang') === 'fr' ? 'fr' : 'en',
    servers: [
      { port: 3000, pid: 18244, kind: 'next', project: 'checkout-app' },
      { port: 5173, pid: 20112, kind: 'vite', project: 'docs' },
      { port: 8000, pid: 9940, kind: 'uvicorn', project: 'api' },
      { port: 6006, pid: 22410, kind: 'storybook', project: 'checkout-app' },
      { port: 8080, pid: 7716, kind: 'http.server' },
    ],
    companion: { skin: 0, name: 'Pixel', level: 3, days: 3 },
    permissions: [
      ...(new URLSearchParams(location.search).has('plan')
        ? [
            {
              id: 'demo:p',
              type: 'plan',
              project: 'email-management-plan',
              title: 'Plan prêt à valider',
              body: [
                '# Plan e-mails',
                '',
                '## 1. Panier abandonné',
                '- Relance à **J+1** avec `-10 %`',
                '- Lien direct vers le panier',
                '',
                '## 2. Avis client',
                '- E-mail à J+3',
                '  - code promo `AVIS10`',
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
                  question: 'Quels e-mails envoyer au lancement ?',
                  header: 'E-mails',
                  multiSelect: true,
                  options: [
                    { label: 'Bienvenue', description: 'À l’inscription' },
                    { label: 'Panier abandonné', description: 'Relance à J+1' },
                    { label: 'Avis client', description: 'À J+3 avec -10 %' },
                  ],
                },
              ],
            },
          ]
        : []),
      {
        id: 'demo:1',
        project: 'checkout-app',
        title: 'Edit middleware.ts?',
        titleKey: 'edit',
        titleArg: 'middleware.ts',
        file: 'src/auth/middleware.ts',
        kind: 'diff',
        canAlways: true,
        body: '-  if (token) return next()\n+  if (await verify(token)) return next()\n   res.status(401).end()',
      },
    ],
    sessions: [
      { sessionId: 'a', project: 'checkout-app', title: 'Ajouter le mode sombre', phase: 'tool', waiting: 1, model: 'claude-opus-5-5', updatedAt: now, progress: { value: 3.4 / 7, measured: true, done: 3, total: 7 }, activity: { icon: '✏️', key: 'edit', arg: 'theme.ts', label: 'Editing theme.ts' }, agents: [{ skin: 1, phase: 'running' }, { skin: 2, phase: 'running' }], rateLimits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: new Date(now + 2 * 3600e3).toISOString() }, { kind: 'seven_day', percentUsed: 18, resetsAt: new Date(now + 4 * 86400e3).toISOString() }] },
      { sessionId: 'b', project: 'checkout-app', title: 'Écrire les tests du paiement', phase: 'tool', waiting: 0, model: 'claude-sonnet-5-5', updatedAt: now - 12 * 60e3, progress: { value: 0.62, measured: false }, activity: { icon: '⌨️', key: 'bash', arg: 'npm test', label: '$ npm test' }, agents: [] },
      { sessionId: 'g', source: 'grok', project: 'api', title: 'Fix the payment tests', phase: 'tool', waiting: 0, model: 'grok-4.7', updatedAt: now - 40e3, actions: 5, activity: { icon: '⌨️', key: 'bash', arg: 'pytest -q' }, agents: [] },
      { sessionId: 'c', project: 'site-web', title: 'Convertir les images', phase: 'idle', waiting: 0, model: 'claude-haiku-5-5', updatedAt: now - 3e3, finishedAt: now - 1e3, outcome: 'done', progress: { value: 0.97, measured: true, done: 4, total: 4 }, agents: [] },
    ],
  }

  return {
    onState: callback => {
      listener = callback
    },
    ready: () => {
      if (params.has('quiet')) demo.permissions = []
      if (!driven) listener(demo)
    },
    setAnchor: name => {
      const [vertical, horizontal] = name.split('-')
      demo.placement = { vertical, horizontal }
      listener({ ...demo })
    },
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
