// How a tool call reads in the island. The island draws it in its own language from
// `key` and `arg` (renderer/i18n.js, keys `act.<key>` and `perm.<key>`); `label` and
// `title` are the English text, for anything that reads them as they are.

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

export type Activity = { icon: string; label: string; key: string; arg?: string }

const ENGLISH: Record<string, string> = {
  read: 'Reading {arg}',
  'read.none': 'Reading a file',
  'notebook.read': 'Reading {arg}',
  write: 'Writing {arg}',
  'write.none': 'Writing a file',
  edit: 'Editing {arg}',
  'edit.none': 'Editing a file',
  bash: '$ {arg}',
  'bash.none': 'Running a command',
  ps: 'PS {arg}',
  output: 'Reading a task’s output',
  stop: 'Stopping a task',
  monitor: 'Watching a process',
  grep: 'Searching “{arg}”',
  'grep.none': 'Searching the code',
  glob: 'Finding {arg}',
  'glob.none': 'Finding files',
  fetch: 'Reading {arg}',
  'fetch.none': 'Reading a web page',
  search: 'Searching the web for “{arg}”',
  'search.none': 'Searching the web',
  agent: 'Starting “{arg}”',
  'agent.none': 'Starting a subagent',
  workflow: 'Running a workflow',
  skill: 'Using the {arg} skill',
  'skill.none': 'Using a skill',
  toolsearch: 'Loading tools',
  message: 'Sending a message',
  question: 'Asking a question',
  plan: 'Proposing a plan',
  'worktree.in': 'Entering a worktree',
  'worktree.out': 'Leaving the worktree',
  'tasks.update': 'Updating its tasks',
  'tasks.read': 'Checking its tasks',
  'plan.update': 'Updating the plan',
}

// An action with a target: `<key>` when the target is known, `<key>.none` otherwise.
function act(icon: string, key: string, arg = ''): Activity {
  const k = arg === '' && ENGLISH[`${key}.none`] ? `${key}.none` : key
  const label = (ENGLISH[k] ?? key).replace('{arg}', arg)

  return arg === '' ? { icon, label, key: k } : { icon, label, key: k, arg }
}

export function describeTool(tool: string, input: Record<string, unknown>): Activity {
  switch (tool) {
    case 'Read':
      return act('📖', 'read', file(input))
    case 'NotebookRead':
      return act('📓', 'notebook.read', file(input, 'notebook_path'))
    case 'Write':
      return act('📝', 'write', file(input))
    case 'Edit':
    case 'MultiEdit':
      return act('✏️', 'edit', file(input))
    case 'NotebookEdit':
      return act('📓', 'edit', file(input, 'notebook_path'))
    case 'Bash':
      return act('⌨️', 'bash', short(text(input, 'command')))
    case 'PowerShell': {
      const command = short(text(input, 'command'))

      return command ? act('⌨️', 'ps', command) : act('⌨️', 'bash')
    }
    case 'BashOutput':
    case 'TaskOutput':
      return act('📤', 'output')
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop':
      return act('⏹️', 'stop')
    case 'Monitor':
      return act('👁️', 'monitor')
    case 'Grep':
      return act('🔎', 'grep', short(text(input, 'pattern'), 50))
    case 'Glob':
      return act('🗂️', 'glob', short(text(input, 'pattern'), 60))
    case 'WebFetch': {
      const url = short(text(input, 'url'), 120)

      return act('🌐', 'fetch', /^https?:\/\/([^/]+)/.exec(url)?.[1] ?? url)
    }
    case 'WebSearch':
      return act('🌍', 'search', short(text(input, 'query'), 60))
    case 'Agent':
    case 'Task':
      return act('🤖', 'agent', short(text(input, 'description'), 60) || short(text(input, 'subagent_type'), 30))
    case 'Workflow':
      return act('🕸️', 'workflow')
    case 'Skill':
      return act('🧩', 'skill', short(text(input, 'skill'), 40))
    case 'ToolSearch':
      return act('🧰', 'toolsearch')
    case 'SendMessage':
      return act('💬', 'message')
    case 'AskUserQuestion':
      return act('❓', 'question')
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return act('📋', 'plan')
    case 'EnterWorktree':
      return act('🌿', 'worktree.in')
    case 'ExitWorktree':
      return act('🌿', 'worktree.out')
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return act('🗒️', 'tasks.update')
    case 'TaskList':
    case 'TaskGet':
      return act('🗒️', 'tasks.read')
  }
  if (tool.startsWith('mcp__')) {
    const [, rawServer = '', ...rest] = tool.split('__')
    const name = short(rest.join('__'), 40) || 'tool'
    if (name === 'update_plan') return act('🗒️', 'plan.update')
    const server = rawServer.replace(/^plugin_[^_]+_/, '')
    const shown = server === '' || /^[0-9a-f]{8}-/i.test(server) ? 'MCP' : short(server, 18)

    // A tool's own name reads the same in every language.
    return { icon: '🔌', label: `${shown} › ${name}`, key: 'tool' }
  }

  return { icon: '🛠️', label: short(tool, 40) || 'Tool', key: 'tool' }
}

export type PermissionDetail = {
  title: string
  titleKey: string
  titleArg?: string
  kind: 'diff' | 'command' | 'file' | 'text'
  file?: string
  body: string
}

const MAX_LINES = 80
const MAX_CHARS = 6000

function clipLines(lines: string[]): string {
  const kept = lines.slice(0, MAX_LINES)
  const more = lines.length - kept.length
  const body = kept.join('\n') + (more > 0 ? `\n… ${more} more line${more > 1 ? 's' : ''}` : '')

  return body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS - 1)}…` : body
}

function diff(oldText: string, newText: string): string[] {
  return [...oldText.split('\n').map(l => `-${l}`), ...newText.split('\n').map(l => `+${l}`)]
}

// A permission request's title, keyed for the island (`perm.<titleKey>`).
function titled(key: string, english: string, arg?: string): Pick<PermissionDetail, 'title' | 'titleKey' | 'titleArg'> {
  return arg ? { title: english.replace('{arg}', arg), titleKey: key, titleArg: arg } : { title: english, titleKey: key }
}

export function describePermission(tool: string, raw: unknown): PermissionDetail {
  const input = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const path = text(input, 'file_path') || text(input, 'notebook_path')
  const name = baseName(path)
  switch (tool) {
    case 'Edit':
      return {
        ...(name ? titled('edit', 'Edit {arg}?', name) : titled('edit.none', 'Edit a file?')),
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

      return { ...(name ? titled('edit', 'Edit {arg}?', name) : titled('edit.none', 'Edit a file?')), kind: 'diff', file: path, body: clipLines(lines) }
    }
    case 'Write':
      return {
        ...(name ? titled('write', 'Write {arg}?', name) : titled('write.none', 'Write a file?')),
        kind: 'file',
        file: path,
        body: clipLines(text(input, 'content').split('\n').map(l => `+${l}`)),
      }
    case 'Bash':
    case 'PowerShell': {
      // The command's own description is the agent's words, shown as they are.
      const why = short(text(input, 'description'), 120)

      return {
        ...(why ? titled('described', '{arg}?', why) : titled('command', 'Run this command?')),
        kind: 'command',
        body: clipLines(text(input, 'command').split('\n')),
      }
    }
    case 'WebFetch':
      return { ...titled('fetch', 'Open this page?'), kind: 'text', body: text(input, 'url') }
  }

  return { ...titled('tool', 'Use {arg}?', tool), kind: 'text', body: clipLines(JSON.stringify(input, null, 2).split('\n')) }
}
