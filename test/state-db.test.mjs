import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import { readJsonAt, scanStateFile } from '../lib/state-db.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('brace matching survives quotes and escapes', () => {
  const buffer = Buffer.from('xx{"a":"}{","b":[1,2]}yy', 'utf8')
  assert.equal(readJsonAt(buffer, 2), '{"a":"}{","b":[1,2]}')
})

test('the byte scan recovers a short JSON value and a bare token', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-cursor-test-'))
  try {
    const payload = Buffer.concat([
      Buffer.from('\x00\x01cursorAuth/cachedEmail\x01\x0e', 'latin1'),
      Buffer.from('user@example.com'),
      Buffer.from('\x03', 'latin1'),
      Buffer.from('\xffcursorAuth/accessToken\x01\x9d\x01', 'latin1'),
      Buffer.from('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-part'),
      Buffer.from('\xff'),
    ])
    const file = join(directory, 'state.vscdb')
    writeFileSync(file, payload)
    const state = scanStateFile(file, ['cursorAuth/cachedEmail', 'cursorAuth/accessToken'])
    assert.equal(state['cursorAuth/cachedEmail'], 'user@example.com')
    assert.match(state['cursorAuth/accessToken'], /^eyJhbGciOiJIUzI1NiJ9\./)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})