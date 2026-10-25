// How a tool call reads in the island: a short French label with an icon, and, for a
// permission request, what is about to happen (a diff, a command, a file).

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key]

  return typeof value === 'string' ? value : ''
}

function short(value: string, max = 80): string {
  const line = value.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function file(input: Record<string, unknown>, key = 'file_path'): string {
  return baseName(short(text(input, key), 160))
}

function label(prefix: string, value: string, fallback: string, quoted = false): string {
  if (value === '') return fallback

  return quoted ? `${prefix} « ${value} »` : `${prefix} ${value}`
}

export type Activity = { icon: string; label: string }

export function describeTool(tool: string, input: Record<string, unknown>): Activity {
  switch (tool) {
    case 'Read':
      return { icon: '📖', label: label('Lit', file(input), 'Lit un fichier') }
    case 'Write':
      return { icon: '📝', label: label('Écrit', file(input), 'Écrit un fichier') }
    case 'Edit':
    case 'MultiEdit':
      return { icon: '✏️', label: label('Modifie', file(input), 'Modifie un fichier') }
    case 'NotebookEdit':
      return { icon: '📓', label: label('Modifie', file(input, 'notebook_path'), 'Modifie un notebook') }
    case 'Bash':
      return { icon: '⌨️', label: label('$', short(text(input, 'command')), 'Lance une commande') }
    case 'PowerShell':
      return { icon: '⌨️', label: label('PS', short(text(input, 'command')), 'Lance une commande') }
    case 'Grep':
      return { icon: '🔎', label: label('Cherche', short(text(input, 'pattern'), 50), 'Cherche dans le code', true) }
    case 'Glob':
      return { icon: '🗂️', label: label('Trouve', short(text(input, 'pattern'), 60), 'Trouve des fichiers') }
    case 'WebFetch': {
      const url = short(text(input, 'url'), 120)

      return { icon: '🌐', label: label('Consulte', /^https?:\/\/([^/]+)/.exec(url)?.[1] ?? url, 'Consulte une page web') }
    }
    case 'WebSearch':
      return { icon: '🌍', label: label('Recherche', short(text(input, 'query'), 60), 'Recherche sur le web', true) }
    case 'Agent':
    case 'Task':
      return { icon: '🤖', label: label('Lance', short(text(input, 'description'), 60), 'Lance un sous-agent', true) }
    case 'AskUserQuestion':
      return { icon: '❓', label: 'Pose une question' }
    case 'ExitPlanMode':
      return { icon: '📋', label: 'Propose un plan' }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { icon: '🗒️', label: 'Met à jour ses tâches' }
  }
  if (tool.startsWith('mcp__')) {
    const [, rawServer = '', ...rest] = tool.split('__')
    const server = rawServer.replace(/^plugin_[^_]+_/, '')
    const shown = server === '' || /^[0-9a-f]{8}-/i.test(server) ? 'MCP' : short(server, 18)

    return { icon: '🔌', label: `${shown} › ${short(rest.join('__'), 40) || 'outil'}` }
  }

  return { icon: '🛠️', label: short(tool, 40) || 'Outil' }
}

export type PermissionDetail = {
  title: string
  kind: 'diff' | 'command' | 'file' | 'text'
  file?: string
  body: string
}

const MAX_LINES = 80
const MAX_CHARS = 6000

function clipLines(lines: string[]): string {
  const kept = lines.slice(0, MAX_LINES)
  const more = lines.length - kept.length
  const body = kept.join('\n') + (more > 0 ? `\n… ${more} ligne${more > 1 ? 's' : ''} de plus` : '')

  return body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS - 1)}…` : body
}

function diff(oldText: string, newText: string): string[] {
  return [...oldText.split('\n').map(l => `-${l}`), ...newText.split('\n').map(l => `+${l}`)]
}

export function describePermission(tool: string, raw: unknown): PermissionDetail {
  const input = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const path = text(input, 'file_path') || text(input, 'notebook_path')
  switch (tool) {
    case 'Edit':
      return {
        title: `Modifier ${baseName(path) || 'un fichier'} ?`,
        kind: 'diff',
        file: path,
        body: clipLines(diff(text(input, 'old_string'), text(input, 'new_string'))),
      }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
      const lines = edits.flatMap((edit, i) => [
        ...(i > 0 ? ['@@'] : []),
        ...diff(text(edit, 'old_string'), text(edit, 'new_string')),
      ])

      return { title: `Modifier ${baseName(path) || 'un fichier'} ?`, kind: 'diff', file: path, body: clipLines(lines) }
    }
    case 'Write':
      return {
        title: `Écrire ${baseName(path) || 'un fichier'} ?`,
        kind: 'file',
        file: path,
        body: clipLines(text(input, 'content').split('\n').map(l => `+${l}`)),
      }
    case 'Bash':
    case 'PowerShell': {
      const why = text(input, 'description')

      return {
        title: why ? `${why} ?` : 'Lancer cette commande ?',
        kind: 'command',
        body: clipLines(text(input, 'command').split('\n')),
      }
    }
    case 'WebFetch':
      return { title: 'Consulter cette page ?', kind: 'text', body: text(input, 'url') }
  }
  const { label: what } = describeTool(tool, input)

  return { title: `${what} ?`, kind: 'text', body: clipLines(JSON.stringify(input, null, 2).split('\n')) }
}
