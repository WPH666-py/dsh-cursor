import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Refuse to hold a whole runaway state file in memory. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024
/** JSON values live right after their key inside one SQLite record. */
const HEADER_WINDOW = 4096

/**
 * Read selected `ItemTable` keys from Cursor's `state.vscdb`.
 *
 * Cursor keeps the database open in WAL mode, so the file is copied (with its
 * `-wal`/`-shm` companions) before it is opened: the running editor never sees
 * a lock, and a failed copy degrades to a byte scan instead of an exception.
 */
export async function readCursorState(dbPath, keys) {
  if (!dbPath || !existsSync(dbPath) || !Array.isArray(keys) || keys.length === 0) return {}
  const fromSqlite = await readWithSqlite(dbPath, keys)
  if (fromSqlite) return fromSqlite
  return scanStateFile(dbPath, keys)
}

async function readWithSqlite(dbPath, keys) {
  let directory = null
  let db = null
  try {
    directory = mkdtempSync(join(tmpdir(), 'dsh-cursor-state-'))
    const copy = join(directory, 'state.vscdb')
    copyFileSync(dbPath, copy)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) copyFileSync(`${dbPath}${suffix}`, `${copy}${suffix}`)
    }
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(copy, { readOnly: true })
    const statement = db.prepare('SELECT value FROM ItemTable WHERE key = ?')
    const result = {}
    for (const key of keys) {
      const row = statement.get(key)
      if (!row) continue
      const value = row.value
      if (typeof value === 'string') result[key] = value
      else if (value instanceof Uint8Array) result[key] = Buffer.from(value).toString('utf8')
    }
    return result
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* already closed or never opened */ }
    if (directory) {
      try { rmSync(directory, { recursive: true, force: true }) } catch { /* temp cleanup is best effort */ }
    }
  }
}

/** Last-resort reader: locate the key bytes and decode the value that follows. */
export function scanStateFile(dbPath, keys) {
  let buffer
  try {
    buffer = readFileSync(dbPath)
  } catch {
    return {}
  }
  if (buffer.length > MAX_SCAN_BYTES) return {}
  const result = {}
  for (const key of keys) {
    const at = buffer.indexOf(Buffer.from(key, 'utf8'))
    if (at < 0) continue
    const value = extractValue(buffer, at + Buffer.byteLength(key, 'utf8'))
    if (value !== undefined) result[key] = value
  }
  return result
}

/**
 * Decode the value that follows a key inside one SQLite record.
 *
 * The value starts within a few bytes of the key (serial type, then an optional
 * length varint), so candidates are probed tightly: widening the window would
 * let a later record answer for a missing key.
 */
function extractValue(buffer, from) {
  for (let offset = 0; offset <= 4; offset += 1) {
    const at = from + offset
    if (at >= buffer.length) return undefined
    const byte = buffer[at]
    if (byte === 0x7b || byte === 0x5b) {
      const json = readJsonAt(buffer, at)
      if (json !== undefined) return json
      continue
    }
    if (isValueStart(byte)) {
      const text = readPrintableAt(buffer, at)
      if (text !== undefined) return text
    }
  }
  return undefined
}

function isValueStart(byte) {
  return (byte >= 0x30 && byte <= 0x39)
    || (byte >= 0x41 && byte <= 0x5a)
    || (byte >= 0x61 && byte <= 0x7a)
    || byte === 0x22 || byte === 0x24 || byte === 0x5f
}

/** Read printable UTF-8 run; short values (emails, urls, tokens) are plain text. */
function readPrintableAt(buffer, start) {
  let end = start
  while (end < buffer.length && end - start < 8192) {
    const byte = buffer[end]
    if (byte < 0x20 || byte === 0x7f) break
    end += 1
  }
  if (end - start < 4) return undefined
  return buffer.subarray(start, end).toString('utf8')
}

function firstIndexOfAny(buffer, codes) {
  let best = -1
  for (const code of codes) {
    const at = buffer.indexOf(code)
    if (at >= 0 && (best === -1 || at < best)) best = at
  }
  return best
}

/** Brace-match a JSON value, tolerating strings and escapes. */
export function readJsonAt(buffer, start) {
  const open = buffer[start]
  if (open !== 0x7b && open !== 0x5b) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < buffer.length; i += 1) {
    const byte = buffer[i]
    if (inString) {
      if (escaped) escaped = false
      else if (byte === 0x5c) escaped = true
      else if (byte === 0x22) inString = false
      continue
    }
    if (byte === 0x22) inString = true
    else if (byte === 0x7b || byte === 0x5b) depth += 1
    else if (byte === 0x7d || byte === 0x5d) {
      depth -= 1
      if (depth === 0) return buffer.subarray(start, i + 1).toString('utf8')
    }
  }
  return undefined
}

function readTokenAt(buffer, start) {
  let end = start
  while (end < buffer.length && end - start < 4096) {
    const byte = buffer[end]
    const isToken = (byte >= 0x30 && byte <= 0x39)
      || (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || byte === 0x2d || byte === 0x5f || byte === 0x2e
    if (!isToken) break
    end += 1
  }
  return end - start >= 16 ? buffer.subarray(start, end).toString('utf8') : undefined
}