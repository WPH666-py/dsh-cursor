import assert from 'node:assert/strict'
import test from 'node:test'
import { PrintTurn, collectText, promptText } from '../lib/cli/print-backend.js'

const assistant = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

test('repeated assistant events collapse into suffix deltas', () => {
  const turn = new PrintTurn()
  assert.deepEqual(turn.feed(assistant('BRIDGE ')).map((c) => c.type), ['block-start', 'text-delta'])
  const second = turn.feed(assistant('BRIDGE OK'))
  assert.deepEqual(second.map((c) => c.type), ['text-delta'])
  assert.equal(second[0].text, 'OK')
  assert.deepEqual(turn.feed(assistant('BRIDGE OK')), [], 'no delta when nothing is new')
  const end = turn.end()
  assert.equal(end[0].type, 'block-end')
  assert.equal(end[0].block.text, 'BRIDGE OK')
  assert.equal(end.at(-1).reason, 'stop')
})

test('the result event carries usage and the finish reason', () => {
  const turn = new PrintTurn()
  turn.feed(assistant('hi'))
  turn.feed({ type: 'result', subtype: 'success', is_error: false, result: 'hi', usage: { inputTokens: 2, outputTokens: 10 } })
  const end = turn.end()
  const usage = end.find((chunk) => chunk.type === 'usage')
  assert.deepEqual(usage.usage, { inputTokens: 2, outputTokens: 10 })
  assert.equal(end.at(-1).reason, 'stop')
})

test('an error result becomes a thrown failure rather than silent text', async () => {
  const turn = new PrintTurn()
  turn.feed({ type: 'result', subtype: 'error', is_error: true, result: 'not logged in' })
  assert.ok(turn.failure instanceof Error)
  assert.equal(turn.end().at(-1).reason, 'error')
})

test('an empty turn still closes the block', () => {
  const end = new PrintTurn().end()
  assert.deepEqual(end.map((c) => c.type), ['block-start', 'block-end', 'finish'])
})

test('prompt text labels roles and keeps the system prompt first', () => {
  const text = promptText({
    systemPrompt: 'be brief',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: 'prior' },
    ],
  })
  assert.equal(text, ['be brief', 'user: hello', 'assistant: prior'].join(String.fromCharCode(10)))
})

test('content blocks without text are ignored', () => {
  assert.equal(collectText({ content: [{ type: 'image' }, { type: 'text', text: 'a' }] }), 'a')
})
