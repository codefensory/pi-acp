/**
 * Human-readable ACP title for a tool call. Most tools are identified by their
 * name alone; the subagent tool carries the identity of the agent it spawns, and
 * a tool that names a subject in its args is titled by that subject.
 */
export function toolTitle(toolName: string, args: unknown): string {
  const a = (args ?? {}) as any
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '')

  if (toolName === 'subagent') {
    const type = str(a.subagent_type)
    const description = str(a.description)
    if (type && description) return `${type}: ${description}`
    return type || description || toolName
  }

  // A search tool is identified by what it looks for, a file tool by its path.
  const subject = str(a.description) || str(a.pattern) || str(a.query) || str(a.path) || str(a.command)
  if (subject) return `${toolName}: ${subject}`

  // Tools that name a verb and a target instead (`climier_flow {action, task_id}`).
  const verb = str(a.action)
  const target = str(a.task_id) || str(a.taskId)
  if (verb && target) return `${toolName}: ${verb} ${target}`

  return toolName
}

/**
 * One line of progress from the details a tool streams with each partial result.
 *
 * Two shapes are understood: the subagent tool's own counters, and the
 * `details.activity` descriptor extensions publish for their own rendering
 * (`{label, target, meta, phase}`), which is what climier-flow emits while a
 * flow runs.
 */
export function progressText(partialResult: unknown): string | undefined {
  const details = (partialResult as any)?.details
  if (!details || typeof details !== 'object') return undefined

  const activity = details.activity
  if (activity && typeof activity === 'object') {
    const parts = [activity.label, activity.target, activity.meta]
      .map((v: unknown) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
    if (parts.length) return parts.join(' · ')
  }

  if (typeof details.subagentType !== 'string' && typeof details.activity !== 'string') return undefined

  const parts: string[] = []
  if (typeof details.activity === 'string' && details.activity.trim()) parts.push(details.activity.trim())
  if (typeof details.toolUses === 'number') parts.push(`${details.toolUses} tool uses`)
  if (typeof details.tokens === 'string' && details.tokens.trim()) parts.push(details.tokens.trim())
  if (typeof details.durationMs === 'number' && details.durationMs > 0) {
    parts.push(`${(details.durationMs / 1000).toFixed(1)}s`)
  }

  return parts.length ? parts.join(' · ') : undefined
}

const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled'])

export interface PlanSnapshot {
  id: string
  entries: Array<{ content: string; priority: string; status: string }>
}

/**
 * The plan a tool publishes for the session's task panel: `details.plan` as
 * `{id?, entries: [{content, status, priority?}]}`. An empty entry list is a
 * removal, not an empty plan.
 */
export function planSnapshot(partialResult: unknown, fallbackId: string): PlanSnapshot | undefined {
  const plan = (partialResult as any)?.details?.plan
  if (!plan || typeof plan !== 'object') return undefined

  const raw = Array.isArray(plan) ? plan : plan.entries
  if (!Array.isArray(raw)) return undefined

  const entries: PlanSnapshot['entries'] = []
  for (const entry of raw) {
    const content = typeof entry?.content === 'string' ? entry.content.trim() : ''
    if (!content) continue
    const status = typeof entry?.status === 'string' && PLAN_STATUSES.has(entry.status) ? entry.status : 'pending'
    const priority = typeof entry?.priority === 'string' && entry.priority ? entry.priority : 'medium'
    entries.push({ content, priority, status })
  }

  const id = typeof plan.id === 'string' && plan.id.trim() ? plan.id.trim() : fallbackId
  return { id, entries }
}

export function toolResultToText(result: unknown): string {
  if (!result) return ''

  const details = (result as any)?.details

  // pi's edit tool returns a terse success message in content and the full unified diff in details.diff.
  const diff = details?.diff
  if (typeof diff === 'string' && diff.trim()) {
    return diff
  }

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length) return texts.join('')
  }

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const stdout =
    (typeof details?.stdout === 'string' ? details.stdout : undefined) ??
    (typeof (result as any)?.stdout === 'string' ? (result as any).stdout : undefined) ??
    (typeof details?.output === 'string' ? details.output : undefined) ??
    (typeof (result as any)?.output === 'string' ? (result as any).output : undefined)

  const stderr =
    (typeof details?.stderr === 'string' ? details.stderr : undefined) ??
    (typeof (result as any)?.stderr === 'string' ? (result as any).stderr : undefined)

  const exitCode =
    (typeof details?.exitCode === 'number' ? details.exitCode : undefined) ??
    (typeof (result as any)?.exitCode === 'number' ? (result as any).exitCode : undefined) ??
    (typeof details?.code === 'number' ? details.code : undefined) ??
    (typeof (result as any)?.code === 'number' ? (result as any).code : undefined)

  if ((typeof stdout === 'string' && stdout.trim()) || (typeof stderr === 'string' && stderr.trim())) {
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim()) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim()) parts.push(`stderr:\n${stderr}`)
    if (typeof exitCode === 'number') parts.push(`exit code: ${exitCode}`)
    return parts.join('\n\n').trimEnd()
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

const TOOL_KINDS: Record<string, string> = {
  read: 'read',
  write: 'edit',
  edit: 'edit',
  ls: 'read',
  list: 'read',
  list_dir: 'read',
  grep: 'search',
  glob: 'search',
  find: 'search',
  web_search: 'fetch',
  web_fetch: 'fetch',
  fetch: 'fetch',
  todo: 'think',
  todo_write: 'think',
  bash: 'execute',
  shell: 'execute',
  run_code: 'execute'
}

/** ACP tool kind: the icon and grouping a client gives the tool call. */
export function toolKind(toolName: string): string {
  return TOOL_KINDS[toolName] ?? 'other'
}
