import test from 'node:test'
import assert from 'node:assert/strict'
import { subagentProgressText, toolResultToText, toolTitle } from '../../src/acp/translate/pi-tools.js'

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
  assert.equal(toolTitle('read', { path: 'a.ts' }), 'read')
})

test('subagentProgressText: renders one line from subagent details', () => {
  const text = subagentProgressText({
    content: [{ type: 'text', text: '3 tool uses...' }],
    details: { subagentType: 'Explore', activity: 'reading', toolUses: 3, tokens: '12.4k token', durationMs: 1500 }
  })
  assert.equal(text, 'reading · 3 tool uses · 12.4k token · 1.5s')
})

test('subagentProgressText: ignores partial results without subagent details', () => {
  assert.equal(subagentProgressText(undefined), undefined)
  assert.equal(subagentProgressText({ content: [{ type: 'text', text: 'partial' }] }), undefined)
  assert.equal(subagentProgressText({ details: { stdout: 'x' } }), undefined)
})
