import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

/**
 * Mirrors the Cordis guard that broke activation: reading a Service off the owning
 * Context throws unless the plugin resolved it through `inject`.
 */
function cordisLike() {
  const calls = { registered: [], replaced: [], disposed: 0 }
  const disposers = []
  const scoped = {
    get llm() {
      return {
        registerAdapter(providers, adapter) {
          calls.registered.push({ providers, adapter })
          const dispose = Object.assign(() => { calls.disposed += 1 }, {
            replace: (next) => calls.replaced.push(next),
          })
          return dispose
        },
        async *stream() {},
      }
    },
  }
  const root = {
    logger: () => ({ info() {}, warn() {} }),
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['llm'])
      const dispose = callback(scoped)
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }
  Object.defineProperty(root, 'llm', {
    get() {
      throw new Error('cannot get property "llm" without inject')
    },
  })
  return { root, calls, disposers }
}

const offline = (root) => mkdtempSync(join(tmpdir(), 'dsh-cursor-plugin-'))

test('the owning context refuses a direct Service read', () => {
  const { root } = cordisLike()
  assert.throws(() => root.llm, /without inject/)
})

test('the plugin mounts without touching ctx.llm directly', async (t) => {
  const directory = offline()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const { root, calls, disposers } = cordisLike()
  t.after(() => disposers.reverse().forEach((dispose) => dispose()))

  assert.doesNotThrow(() =>
    apply(root, { exportDir: directory, liveCatalog: false, offlineFallback: false, refreshSeconds: 3600 }),
  )
  await new Promise((resolve) => setTimeout(resolve, 120))

  assert.equal(calls.registered.length, 1, 'exactly one route registration')
  assert.deepEqual(calls.registered[0].providers, ['cursor'])
  assert.deepEqual(calls.registered[0].adapter.providerInfo(), { id: 'cursor', name: 'Cursor' })
})

test('a catalog-only route fails loudly instead of pretending to stream', async (t) => {
  const directory = offline()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const { root, calls, disposers } = cordisLike()
  t.after(() => disposers.reverse().forEach((dispose) => dispose()))
  apply(root, { exportDir: directory, liveCatalog: false, offlineFallback: false, refreshSeconds: 3600 })

  const adapter = calls.registered[0].adapter
  await assert.rejects(async () => {
    for await (const chunk of adapter.stream({ provider: 'cursor', model: 'default', messages: [] })) void chunk
  }, (error) => {
    assert.equal(error.code, 'CURSOR_NO_DELEGATE', 'a catalog-only route names its own failure')
    return true
  })
})
