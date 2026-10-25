// How far along a session's current task is, from 0 to 1.
//
// Measured when the session keeps a task list: TodoWrite, the desktop app's plan
// (update_plan / wrap_up) or TaskCreate/TaskUpdate. Done steps count in full and the
// step in progress counts for a part. Without a list, the count of actions in the turn
// gives an estimate that rises quickly at first and never passes ESTIMATE_CAP: only the
// real end of the turn shows 100 % (with a list, only once every step is done).

export type Step = 'pending' | 'in_progress' | 'completed'
export type Tracker = {
  steps: Step[]
  tasks: Map<string, Step>
  created: number
  source?: 'todos' | 'plan' | 'tasks'
  actions: number
}
export type Progress = { value: number; measured: boolean; done?: number; total?: number }

const ESTIMATE_CAP = 0.9
const ESTIMATE_SCALE = 12
const IN_PROGRESS_SHARE = 0.4
// Until the turn really ends, a full list still reads just short of 100 %.
const RUNNING_CAP = 0.97

export function newTracker(): Tracker {
  return { steps: [], tasks: new Map(), created: 0, actions: 0 }
}

function step(status: unknown): Step {
  if (status === 'completed' || status === 'done') return 'completed'

  return status === 'in_progress' ? 'in_progress' : 'pending'
}

const statuses = (list: unknown): Step[] => (Array.isArray(list) ? list.map(item => step((item as { status?: unknown } | null)?.status)) : [])

// Reads a tool call that changes the session's task list.
export function track(t: Tracker, tool: string, input: Record<string, unknown>): void {
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    t.steps = statuses(input.todos)
    t.source = 'todos'

    return
  }
  if (tool.endsWith('update_plan')) {
    if (Array.isArray(input.items)) {
      t.steps = statuses(input.items)
      t.source = 'plan'

      return
    }
    if (t.source !== 'plan') return
    if (Array.isArray(input.done)) for (const n of input.done) if (typeof n === 'number' && t.steps[n - 1]) t.steps[n - 1] = 'completed'
    if (input.advance === true) {
      const current = t.steps.indexOf('in_progress')
      if (current >= 0) t.steps[current] = 'completed'
      const following = t.steps.indexOf('pending')
      if (following >= 0) t.steps[following] = 'in_progress'
    }
    if (typeof input.start === 'number' && t.steps[input.start - 1]) t.steps[input.start - 1] = 'in_progress'

    return
  }
  // wrap_up closes the plan.
  if (tool.endsWith('wrap_up') && t.source === 'plan') {
    t.steps = t.steps.map(() => 'completed')

    return
  }
  if (tool === 'TaskCreate') {
    t.created++
    t.source = 'tasks'

    return
  }
  if (tool === 'TaskUpdate' && (typeof input.taskId === 'string' || typeof input.taskId === 'number')) {
    const id = String(input.taskId)
    if (input.status === 'deleted') t.tasks.delete(id)
    else if (input.status !== undefined) t.tasks.set(id, step(input.status))
    else if (!t.tasks.has(id)) t.tasks.set(id, 'pending')
    t.source = 'tasks'
  }
}

function list(t: Tracker): Step[] {
  if (t.source !== 'tasks') return t.steps
  const known = [...t.tasks.values()]
  const unseen = Math.max(0, t.created - known.length)

  return [...known, ...Array<Step>(unseen).fill('pending')]
}

// A new turn: a finished list belongs to the last task, and the action count restarts.
export function startTurn(t: Tracker): void {
  const steps = list(t)
  if (steps.length > 0 && steps.every(s => s === 'completed')) {
    t.steps = []
    t.tasks.clear()
    t.created = 0
    t.source = undefined
  }
  t.actions = 0
}

export function measure(t: Tracker, finished: boolean): Progress {
  const steps = list(t)
  if (steps.length > 0) {
    const done = steps.filter(s => s === 'completed').length
    const active = steps.filter(s => s === 'in_progress').length
    const share = (done + active * IN_PROGRESS_SHARE) / steps.length
    // A turn that ends with steps left (a question, a stop) keeps its real share.
    const value = done === steps.length && finished ? 1 : Math.min(RUNNING_CAP, share)

    return { value, measured: true, done, total: steps.length }
  }

  return { value: finished ? 1 : ESTIMATE_CAP * (1 - Math.exp(-t.actions / ESTIMATE_SCALE)), measured: false }
}
