/** End-to-end: the Harness adapter drives the official CLI through WSL. */
import { createPrintAdapter } from '../lib/cli/print-backend.js'

const model = process.env.MODEL ?? 'claude-opus-5-thinking-high'
const adapter = createPrintAdapter({
  provider: 'cursor',
  displayName: 'Cursor',
  getModels: () => [{ id: model, name: model, input: ['text'] }],
  spawn: { distro: process.env.WSL_DISTRO ?? 'Ubuntu', workspace: '/tmp' },
})

const started = Date.now()
let text = ''
const chunks = []
for await (const chunk of adapter.stream({
  provider: 'cursor',
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: BRIDGE OK' }] }],
})) {
  chunks.push(chunk.type)
  if (chunk.type === 'text-delta') {
    text += chunk.text
    process.stdout.write(chunk.text)
  }
  if (chunk.type === 'usage') console.log('\nusage:', JSON.stringify(chunk.usage))
  if (chunk.type === 'finish') console.log('finish:', chunk.reason, '| ms:', Date.now() - started)
}
console.log('seq:', chunks.join(' → '))
console.log('text:', JSON.stringify(text))
