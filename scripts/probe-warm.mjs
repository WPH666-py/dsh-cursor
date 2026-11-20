/** Cold vs warm: the same adapter, two turns in a row. */
import { createPrintAdapter } from '../lib/cli/print-backend.js'

const model = process.env.MODEL ?? 'claude-opus-5-thinking-high'
const adapter = createPrintAdapter({
  provider: 'cursor',
  getModels: () => [{ id: model, name: model, input: ['text'] }],
  spawn: { distro: 'Ubuntu', workspace: '/tmp' },
})

async function turn(label) {
  const started = Date.now()
  let text = ''
  for await (const chunk of adapter.stream({
    provider: 'cursor',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  console.log(`${label}: ${Date.now() - started} ms | ${JSON.stringify(text)}`)
}

await turn('cold')
await turn('warm')
adapter.dispose()
