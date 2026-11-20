
import { apply } from '../index.js'

const events = []
let adapter = null
const ctx = {
  logger: () => ({ info: (m) => events.push(['info', m]), warn: (m) => events.push(['warn', m]) }),
  effect: (fn) => fn(),
  inject: (deps, callback) => callback({
    llm: {
      registerAdapter: (providers, instance) => {
        adapter = instance
        return Object.assign(() => {}, { replace: () => {} })
      },
      stream: async function* () {},
    },
  }),
  llm: {
    registerAdapter(providers, instance) {
      adapter = instance
      return Object.assign(() => {}, { replace: (next) => events.push(['replace', next.join(',')]) })
    },
    stream: async function* () { yield { type: 'text-delta', index: 0, text: 'ok' } },
  },
}

apply(ctx, {})
await new Promise((r) => setTimeout(r, 20000))
console.log('events:', events)
console.log('providerInfo:', adapter && adapter.providerInfo())
const models = adapter ? await adapter.listModels() : []
console.log('listModels:', models.length, models.slice(0, 3))
const one = adapter && (await adapter.resolveModel('cursor', 'claude-opus-5-5'))
console.log('resolveModel:', one)
try {
  for await (const _ of adapter.stream({ provider: 'cursor', model: 'claude-opus-5-5', messages: [] })) {}
  console.log('stream: no error (delegate unset?)')
} catch (error) {
  console.log('stream error:', error.code, String(error.message).slice(0, 80))
}
