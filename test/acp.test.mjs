import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { AcpClient } from '../lib/cli/acp.js'
import { createAcpAdapter, toPromptBlocks } from '../lib/cli/acp-adapter.js'

const NL = String.fromCharCode(10)

/**
 * A scripted ACP agent: reads JSON-RPC lines from its stdin and answers them,
 * which is exactly what a real agent does over stdio.
 */
function fakeAgent(script) {
  const toClient = new PassThrough()
  const fromClient = new PassThrough()
  const seen = []
  let buffer = ''
  fromClient.setEncoding('utf8')
  fromClient.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf(NL)) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      seen.push(message)
      script(message, (value) => toClient.write(JSON.stringify(value) + NL))
    }
  })
  return { toClient, fromClient, seen }
}

function connect(script, options = {}) {
  const agent = fakeAgent(script)
  const client = new AcpClient({ input: agent.toClient, output: agent.fromClient, ...options })
  return { client, agent }
}

const standardScript = (message, reply) => {
  if (message.method === 'initialize') reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'fake' } } })
  if (message.method === 'session/new') reply({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's-1' } })
  if (message.method === 'session/prompt') {
    reply({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'BRIDGE ' } } } })
    reply({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } })
    reply({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
}

test('initialize and newSession round-trip over newline JSON', async () => {
  const { client } = connect(standardScript)
  const init = await client.initialize()
  assert.equal(init.protocolVersion, 1)
  const session = await client.newSession({ cwd: '/tmp' })
  assert.equal(session.sessionId, 's-1')
})

test('a permission request is answered with a selected option', async () => {
  let answered = null
  const { client } = connect((message, reply) => {
    if (message.method === 'initialize') reply({ jsonrpc: '2.0', id: message.id, result: {} })
    if (message.method === 'session/request_permission') {
      answered = message
      reply({ jsonrpc: '2.0', id: 99, result: { ok: true } })
    }
  })
  await client.initialize()
  // The agent asks, and the client must answer without blocking.
  const agent = client
  agent.input.push(JSON.stringify({
    jsonrpc: '2.0', id: 'p-1', method: 'session/request_permission',
    params: { sessionId: 's-1', options: [{ optionId: 'no', kind: 'reject_once' }, { optionId: 'yes', kind: 'allow_once' }] },
  }) + NL)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(answered === null, 'the client answers requests it receives, not ones it sends')
  assert.equal(client.pending.size, 0)
})

test('the adapter maps ACP chunks onto the harness stream vocabulary', async () => {
  const { client } = connect(standardScript)
  const adapter = createAcpAdapter({
    provider: 'cursor',
    getModels: () => [{ id: 'default', name: 'Auto', input: ['text', 'image'], contextWindow: 200000 }],
    connect: async () => ({ client, cwd: '/tmp' }),
  })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'cursor', model: 'default', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'finish'])
  assert.equal(chunks[1].text + chunks[2].text, 'BRIDGE OK')
  assert.equal(chunks[3].block.text, 'BRIDGE OK')
  assert.equal(chunks[4].reason, 'stop')
})

test('models advertise context and modalities', async () => {
  const { client } = connect(standardScript)
  const adapter = createAcpAdapter({
    provider: 'cursor',
    getModels: () => [{ id: 'default', name: 'Auto', input: ['text', 'image'], contextWindow: 200000 }],
    connect: async () => ({ client, cwd: '/tmp' }),
  })
  const [model] = await adapter.listModels()
  assert.deepEqual(model.context, { contextWindow: 200000 })
  assert.deepEqual(model.inputModalities, ['text', 'image'])
})

test('prompt blocks label roles and skip empty content', () => {
  const blocks = toPromptBlocks({
    systemPrompt: 'be brief',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [] },
    ],
  })
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].text, 'be brief')
  assert.equal(blocks[1].text, 'user: hello')
})
