import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  return { conn, proc }
}

const progress = {
  content: [{ type: 'text', text: '3 tool uses...' }],
  details: { subagentType: 'Explore', activity: 'reading', toolUses: 3, tokens: '12.4k token', durationMs: 1500 }
}

test('PiAcpSession: subagent tool call is titled by its agent, not "subagent"', async () => {
  const { conn, proc } = makeSession()

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'subagent',
    args: { subagent_type: 'Explore', description: 'Find auth files', prompt: 'find them' }
  })

  await new Promise(r => setTimeout(r, 0))

  const calls = conn.updates.map(u => u.update as any).filter(u => u.sessionUpdate === 'tool_call')
  assert.equal(calls.length, 1)
  const update = calls[0]
  assert.equal(update.title, 'Explore: Find auth files')
  assert.equal(update.kind, 'other')
})

test('PiAcpSession: subagent progress comes from details and is throttled', async () => {
  const { conn, proc } = makeSession()

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'subagent',
    args: { subagent_type: 'Explore', description: 'Find auth files' }
  })
  proc.emit({ type: 'tool_execution_update', toolCallId: 't1', toolName: 'subagent', partialResult: progress })
  proc.emit({ type: 'tool_execution_update', toolCallId: 't1', toolName: 'subagent', partialResult: progress })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'subagent',
    isError: false,
    result: { content: [{ type: 'text', text: 'Agent completed in 5.6s (1 tool uses, 17.1k token).' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const updates = conn.updates.map(u => u.update as any).filter(u => u.sessionUpdate !== 'subagent_update')
  assert.equal(updates.length, 3, 'the 80ms progress stream collapses to one update per second')
  assert.equal(updates[1].status, 'in_progress')
  assert.deepEqual(updates[1].content, [{ type: 'content', content: { type: 'text', text: 'reading · 3 tool uses · 12.4k token · 1.5s' } }])
  assert.equal(updates[2].status, 'completed')
  assert.deepEqual(updates[2].content, [
    { type: 'content', content: { type: 'text', text: 'Agent completed in 5.6s (1 tool uses, 17.1k token).' } }
  ])
})

test('PiAcpSession: a later subagent progress update passes once the interval elapses', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'subagent', args: { subagent_type: 'Plan' } })
  proc.emit({ type: 'tool_execution_update', toolCallId: 't1', toolName: 'subagent', partialResult: progress })
  await new Promise(r => setTimeout(r, 1100))
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    toolName: 'subagent',
    partialResult: { details: { ...progress.details, activity: 'editing 2 files', toolUses: 4 } }
  })

  await new Promise(r => setTimeout(r, 0))

  const updates = conn.updates.map(u => u.update as any).filter(u => u.sessionUpdate !== 'subagent_update')
  assert.equal(updates.length, 3)
  assert.equal((updates[2].content as any)[0].content.text, 'editing 2 files · 4 tool uses · 12.4k token · 1.5s')
})

test('PiAcpSession: announces the subagent as a child session and settles it', async () => {
  const { conn, proc } = makeSession()

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'subagent',
    args: { subagent_type: 'Explore', description: 'Find auth files' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'subagent',
    isError: false,
    result: { content: [{ type: 'text', text: 'Agent completed in 1.0s' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const updates = conn.updates.map(u => u.update as any)
  const announced = updates.filter(u => u.sessionUpdate === 'subagent_update')
  assert.equal(announced.length, 2, 'running then idle')
  assert.match(announced[0].sessionId, /^[0-9a-f-]{20,}$/)
  assert.equal(announced[0].title, 'Explore: Find auth files')
  assert.equal(announced[0].description, 'Explore')
  assert.deepEqual(announced[0].state, { state: 'running' })
  assert.equal(announced[1].sessionId, announced[0].sessionId, 'same child session throughout')
  assert.deepEqual(announced[1].state, { state: 'idle', stopReason: 'end_turn' })
  // The child announcement rides the parent session, never the child id.
  assert.equal(conn.updates[0]!.sessionId, 's1')
})

test('PiAcpSession: a resumed subagent keeps the child session its agent id names', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'subagent', args: { id: 'c5261ee6-1df2-4a7', prompt: 'keep going' } })

  await new Promise(r => setTimeout(r, 0))

  const announced = (conn.updates.map(u => u.update as any)).find(u => u.sessionUpdate === 'subagent_update')
  assert.equal(announced.sessionId, 'c5261ee6-1df2-4a7')
})

test('PiAcpSession: a failed subagent settles idle/error', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'subagent', args: { subagent_type: 'Plan' } })
  proc.emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'subagent', isError: true, result: { content: [] } })

  await new Promise(r => setTimeout(r, 0))

  const idle = (conn.updates.map(u => u.update as any)).filter(u => u.sessionUpdate === 'subagent_update').at(-1)
  assert.deepEqual(idle.state, { state: 'idle', stopReason: 'error' })
})

test('PiAcpSession: a tool that publishes details.plan drives the task panel', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'climier_flow', args: { action: 'run', task_id: 'T-1', wait: true } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    toolName: 'climier_flow',
    partialResult: {
      content: [{ type: 'text', text: 'waiting for T-1 (worker_running)…' }],
      details: {
        activity: { label: 'Flow', target: 'status T-1', meta: 'worker_running · waiting', phase: 'running' },
        plan: { id: 'flow', entries: [{ content: 'prepare', status: 'completed' }, { content: 'work', status: 'in_progress' }] }
      }
    }
  })
  // The same plan polled again must not be resent.
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    toolName: 'climier_flow',
    partialResult: {
      details: {
        activity: { label: 'Flow', target: 'status T-1', meta: 'worker_running · waiting' },
        plan: { id: 'flow', entries: [{ content: 'prepare', status: 'completed' }, { content: 'work', status: 'in_progress' }] }
      }
    }
  })
  proc.emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'climier_flow', isError: false, result: { content: [{ type: 'text', text: 'done' }] } })

  await new Promise(r => setTimeout(r, 0))

  const updates = conn.updates.map(u => u.update as any)
  const plans = updates.filter(u => u.sessionUpdate === 'plan_update')
  assert.equal(plans.length, 1, 'one plan update for two identical polls')
  assert.deepEqual(plans[0].plan, {
    type: 'items',
    planId: 'flow',
    entries: [
      { content: 'prepare', priority: 'medium', status: 'completed' },
      { content: 'work', priority: 'medium', status: 'in_progress' }
    ]
  })
  assert.deepEqual(updates.filter(u => u.sessionUpdate === 'plan_removed'), [{ sessionUpdate: 'plan_removed', planId: 'flow' }], 'the panel clears when the tool finishes')

  const progress = updates.filter(u => u.sessionUpdate === 'tool_call_update' && u.content)
  assert.deepEqual(progress[0].content, [{ type: 'content', content: { type: 'text', text: 'Flow · status T-1 · worker_running · waiting' } }])
})

test('PiAcpSession: the final plan snapshot is published instead of removed', async () => {
  const { conn, proc } = makeSession()

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'climier_flow', args: { action: 'run', task_id: 'T-1', wait: true } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    toolName: 'climier_flow',
    partialResult: { details: { plan: { id: 'flow:T-1', entries: [{ content: 'prepare', status: 'in_progress' }] } } }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'climier_flow',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'Launched run for T-1.' }],
      details: { plan: { id: 'flow:T-1', entries: [{ content: 'prepare', status: 'completed' }, { content: 'work', status: 'completed' }] } }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const updates = conn.updates.map(u => u.update as any)
  const plans = updates.filter(u => u.sessionUpdate === 'plan_update')
  assert.equal(plans.length, 2, 'live plan, then the settled one')
  assert.deepEqual(plans[1].plan.entries, [
    { content: 'prepare', priority: 'medium', status: 'completed' },
    { content: 'work', priority: 'medium', status: 'completed' }
  ])
  assert.equal(updates.filter(u => u.sessionUpdate === 'plan_removed').length, 0)
})

test('PiAcpSession: acp.children entries announce extension-owned work as child sessions', async () => {
  const { conn, proc } = makeSession()

  const entry = (children: unknown[]) => ({ type: 'custom', customType: 'acp.children', data: { children } })

  proc.emit({
    type: 'entry_appended',
    entry: entry([
      { id: 'flow:T-1', title: 'Flow T-1 · refactor auth', description: 'work · worker', state: 'running' },
      { id: 'flow:T-2', title: 'Flow T-2 · docs', description: 'review', state: 'running' }
    ])
  })
  // Same snapshot again: nothing to resend.
  proc.emit({
    type: 'entry_appended',
    entry: entry([
      { id: 'flow:T-1', title: 'Flow T-1 · refactor auth', description: 'work · worker', state: 'running' },
      { id: 'flow:T-2', title: 'Flow T-2 · docs', description: 'review', state: 'running' }
    ])
  })
  // T-2 advanced to a new node.
  proc.emit({
    type: 'entry_appended',
    entry: entry([
      { id: 'flow:T-1', title: 'Flow T-1 · refactor auth', description: 'work · worker', state: 'running' },
      { id: 'flow:T-2', title: 'Flow T-2 · docs', description: 'integration · merger', state: 'running' }
    ])
  })
  // T-1 stopped; T-2 is no longer in the snapshot and must keep its last state.
  proc.emit({
    type: 'entry_appended',
    entry: entry([{ id: 'flow:T-1', title: 'Flow T-1 · refactor auth', description: 'work · worker', state: 'idle' }])
  })
  // Not our contract.
  proc.emit({ type: 'entry_appended', entry: { type: 'custom', customType: 'climier-flow.owned', data: { taskId: 'T-1' } } })

  await new Promise(r => setTimeout(r, 0))

  const children = conn.updates.map(u => u.update as any).filter(u => u.sessionUpdate === 'subagent_update')
  assert.deepEqual(
    children.map(c => [c.sessionId, c.description ?? null, c.state.state, c.state.stopReason ?? null]),
    [
      ['flow:T-1', 'work · worker', 'running', null],
      ['flow:T-2', 'review', 'running', null],
      ['flow:T-2', 'integration · merger', 'running', null],
      ['flow:T-1', 'work · worker', 'idle', 'end_turn']
    ]
  )
  assert.deepEqual(children[0].title, 'Flow T-1 · refactor auth')
  assert.equal(conn.updates.every(u => u.sessionId === 's1'), true, 'children ride the parent session')
})

test('PiAcpSession: polls session entries so extension children reach the client', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionEntries = [
    { id: 'e1', type: 'message', message: { role: 'user', content: 'hi' } },
    {
      id: 'e2',
      type: 'custom',
      customType: 'acp.children',
      data: {
        children: [
          { id: 'flow:T-1', title: 'Flow T-1 · auth', description: 'work · worker', state: 'running' },
          { id: 'flow:T-2', title: 'Flow T-2 · docs', description: 'review', state: 'running' }
        ]
      }
    }
  ]
  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    entryPollMs: 5
  })

  await new Promise(r => setTimeout(r, 40))

  let children = conn.updates.map(u => u.update as any).filter(u => u.sessionUpdate === 'subagent_update')
  assert.deepEqual(children.map(c => c.sessionId), ['flow:T-1', 'flow:T-2'])

  // A later snapshot settles one and advances the other; the cursor keeps it incremental.
  proc.sessionEntries.push({
    id: 'e3',
    type: 'custom',
    customType: 'acp.children',
    data: {
      children: [
        { id: 'flow:T-1', title: 'Flow T-1 · auth', description: 'review · validator', state: 'running' },
        { id: 'flow:T-2', title: 'Flow T-2 · docs', description: 'review', state: 'idle' }
      ]
    }
  })

  await new Promise(r => setTimeout(r, 40))

  children = conn.updates.map(u => u.update as any).filter(u => u.sessionUpdate === 'subagent_update')
  const last = children.slice(-2)
  assert.deepEqual(last.map(c => [c.sessionId, c.description ?? null, c.state]), [
    ['flow:T-1', 'review · validator', { state: 'running' }],
    ['flow:T-2', 'review', { state: 'idle', stopReason: 'end_turn' }]
  ])
})
