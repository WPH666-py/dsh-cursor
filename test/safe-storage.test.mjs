import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import test from 'node:test'
import { isSealed, unseal } from '../lib/cli/safe-storage.js'

/** Build the same v10 envelope Electron writes, with a key we control. */
function seal(plaintext, key) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const blob = Buffer.concat([Buffer.from('v10', 'latin1'), nonce, body, cipher.getAuthTag()])
  return `cursor-safe-storage:v1:${blob.toString('base64')}`
}

test('a plain value passes through untouched', () => {
  assert.equal(isSealed('eyJhbGciOiJI'), false)
  assert.equal(unseal('eyJhbGciOiJI'), 'eyJhbGciOiJI')
})

test('a v10 envelope round-trips with an injected key', () => {
  const key = randomBytes(32)
  const sealed = seal('cursor-safe-token', key)
  assert.equal(isSealed(sealed), true)
  assert.equal(unseal(sealed, { key }), 'cursor-safe-token')
})

test('a wrong key fails the authentication tag instead of returning garbage', () => {
  const sealed = seal('secret', randomBytes(32))
  assert.throws(() => unseal(sealed, { key: randomBytes(32) }))
})

test('an unknown envelope version is refused by name', () => {
  const blob = Buffer.concat([Buffer.from('v20', 'latin1'), randomBytes(40)])
  assert.throws(
    () => unseal(`cursor-safe-storage:v1:${blob.toString('base64')}`, { key: randomBytes(32) }),
    /unsupported safeStorage envelope: v20/,
  )
})
