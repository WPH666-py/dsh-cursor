import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { detectCursor } from '../lib/detect.js'

const WIN_ENV = {
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
  PATH: 'C:\\Windows\\system32',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
}

function fakeFs(paths) {
  const set = new Set(paths.map((path) => path.toLowerCase()))
  return () => (path) => set.has(String(path).toLowerCase())
}

test('detects a default per-user Windows install', () => {
  const exe = join(WIN_ENV.LOCALAPPDATA, 'Programs', 'cursor', 'Cursor.exe')
  const db = join(WIN_ENV.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  const exists = fakeFs([exe, db])()
  const cursor = detectCursor({ platform: 'win32', env: WIN_ENV, home: 'C:\\Users\\u', exists, readText: () => '{"version":"1.2.3"}' })
  assert.equal(cursor.installed, true)
  assert.equal(cursor.executable, exe)
  assert.equal(cursor.dbPath, db)
})

test('follows the cursor shim on PATH to a custom install root', () => {
  const shim = join('D:\\cursor', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd')
  const env = { ...WIN_ENV, PATH: join('D:\\cursor', 'cursor', 'resources', 'app', 'bin') }
  const exists = fakeFs([shim])()
  const cursor = detectCursor({ platform: 'win32', env, home: 'C:\\Users\\u', exists })
  assert.equal(cursor.installed, true)
  assert.equal(cursor.cli.toLowerCase(), shim.toLowerCase())
  assert.equal(cursor.installDir, 'D:\\cursor\\cursor')
})

test('a machine without Cursor reports nothing installed', () => {
  const cursor = detectCursor({ platform: 'win32', env: { ...WIN_ENV, PATH: '' }, home: 'C:\\Users\\u', exists: () => false })
  assert.equal(cursor.installed, false)
  assert.equal(cursor.dbPath, null)
  assert.equal(cursor.installDir, null)
})

test('a leftover user-data directory alone still counts as an install', () => {
  const db = join(WIN_ENV.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  const cursor = detectCursor({ platform: 'win32', env: { ...WIN_ENV, PATH: '' }, home: 'C:\\Users\\u', exists: fakeFs([db])() })
  assert.equal(cursor.installed, true)
  assert.equal(cursor.executable, null)
})