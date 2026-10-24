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
