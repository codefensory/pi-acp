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

  assert.equal(conn.updates.length, 1)
  const update = conn.updates[0]!.update as any
  assert.equal(update.sessionUpdate, 'tool_call')
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

  const updates = conn.updates.map(u => u.update as any)
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

  const updates = conn.updates.map(u => u.update as any)
  assert.equal(updates.length, 3)
  assert.equal((updates[2].content as any)[0].content.text, 'editing 2 files · 4 tool uses · 12.4k token · 1.5s')
})
