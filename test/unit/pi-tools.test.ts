import test from 'node:test'
import assert from 'node:assert/strict'
import { planSnapshot, progressText, toolKind, toolResultToText, toolTitle } from '../../src/acp/translate/pi-tools.js'

test('toolResultToText: extracts text from content blocks', () => {
  const text = toolResultToText({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' }
    ]
  })
  assert.equal(text, 'hello world')
})

test('toolResultToText: prefers details.diff when present', () => {
  const text = toolResultToText({
    content: [{ type: 'text', text: 'Successfully replaced 2 block(s) in a.txt.' }],
    details: { diff: '--- a\n+++ b\n' }
  })
  assert.equal(text, '--- a\n+++ b\n')
})

test('toolResultToText: falls back to JSON', () => {
  const text = toolResultToText({ a: 1 })
  assert.match(text, /"a": 1/)
})

test('toolResultToText: extracts bash stdout/stderr from details', () => {
  const text = toolResultToText({
    details: {
      stdout: 'ok\n',
      stderr: 'warn\n',
      exitCode: 0
    }
  })
  assert.match(text, /ok/)
  assert.match(text, /stderr:/)
  assert.match(text, /warn/)
  assert.match(text, /exit code: 0/)
})

test('toolTitle: names the agent a subagent call spawns', () => {
  assert.equal(toolTitle('subagent', { subagent_type: 'Explore', description: 'Find auth files' }), 'Explore: Find auth files')
})

test('toolTitle: falls back to the type, the description, then the tool name', () => {
  assert.equal(toolTitle('subagent', { subagent_type: 'Plan' }), 'Plan')
  assert.equal(toolTitle('subagent', { description: 'Audit deps' }), 'Audit deps')
  assert.equal(toolTitle('subagent', {}), 'subagent')
  assert.equal(toolTitle('read', { path: 'a.ts' }), 'read: a.ts')
})

test('subagentProgressText: renders one line from subagent details', () => {
  const text = progressText({
    content: [{ type: 'text', text: '3 tool uses...' }],
    details: { subagentType: 'Explore', activity: 'reading', toolUses: 3, tokens: '12.4k token', durationMs: 1500 }
  })
  assert.equal(text, 'reading · 3 tool uses · 12.4k token · 1.5s')
})

test('subagentProgressText: ignores partial results without subagent details', () => {
  assert.equal(progressText(undefined), undefined)
  assert.equal(progressText({ content: [{ type: 'text', text: 'partial' }] }), undefined)
  assert.equal(progressText({ details: { stdout: 'x' } }), undefined)
})

test('toolTitle: titles a tool by the subject in its args', () => {
  assert.equal(toolTitle('read', { path: 'src/a.ts' }), 'read: src/a.ts')
  assert.equal(toolTitle('grep', { pattern: 'TODO' }), 'grep: TODO')
  assert.equal(toolTitle('bash', { command: 'ls -la' }), 'bash: ls -la')
  assert.equal(toolTitle('climier_flow', { action: 'run', task_id: 'T-123', wait: true }), 'climier_flow: run T-123')
  assert.equal(toolTitle('climier_flow', { wait: true }), 'climier_flow')
})

test('progressText: renders the activity descriptor extensions publish', () => {
  const text = progressText({
    content: [{ type: 'text', text: 'waiting for T-123 (worker_running)…' }],
    details: {
      action: 'status',
      taskId: 'T-123',
      activity: { label: 'Flow', target: 'status T-123', meta: 'worker_running · waiting', phase: 'running' }
    }
  })
  assert.equal(text, 'Flow · status T-123 · worker_running · waiting')
})

test('progressText: a bare activity descriptor without meta still renders', () => {
  const text = progressText({ details: { activity: { label: 'Flow', target: 'list', meta: '' } } })
  assert.equal(text, 'Flow · list')
})

test('planSnapshot: reads details.plan entries and normalizes status', () => {
  const plan = planSnapshot(
    { details: { plan: { id: 'flow', entries: [{ content: 'work', status: 'in_progress' }, { content: 'review', status: 'nonsense', priority: 'high' }] } } },
    'climier_flow'
  )
  assert.deepEqual(plan, {
    id: 'flow',
    entries: [
      { content: 'work', priority: 'medium', status: 'in_progress' },
      { content: 'review', priority: 'high', status: 'pending' }
    ]
  })
})

test('planSnapshot: accepts a bare entry array and drops nameless entries', () => {
  const plan = planSnapshot({ details: { plan: [{ content: 'work', status: 'completed' }, { status: 'pending' }] } }, 'climier_flow')
  assert.deepEqual(plan, { id: 'climier_flow', entries: [{ content: 'work', priority: 'medium', status: 'completed' }] })
})

test('planSnapshot: ignores details with no plan', () => {
  assert.equal(planSnapshot({ details: { activity: 'x' } }, 'climier_flow'), undefined)
  assert.equal(planSnapshot({ details: { plan: { entries: 'nope' } } }, 'climier_flow'), undefined)
})

test('toolKind: maps search, file and shell tools to their ACP kind', () => {
  assert.equal(toolKind('grep'), 'search')
  assert.equal(toolKind('glob'), 'search')
  assert.equal(toolKind('find'), 'search')
  assert.equal(toolKind('read'), 'read')
  assert.equal(toolKind('ls'), 'read')
  assert.equal(toolKind('write'), 'edit')
  assert.equal(toolKind('bash'), 'execute')
  assert.equal(toolKind('web_search'), 'fetch')
  assert.equal(toolKind('todo'), 'think')
  assert.equal(toolKind('subagent'), 'other')
})

test('toolTitle: a search tool is titled by what it looks for', () => {
  assert.equal(toolTitle('grep', { pattern: 'subagentProgressText', path: 'src' }), 'grep: subagentProgressText')
})
