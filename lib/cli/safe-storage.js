import { createDecipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * Unseal a value Cursor stored through Electron safeStorage.
 *
 * Cursor 3.x keeps `cursorAuth/accessToken` as `cursor-safe-storage:v1:<b64>`,
 * which is Chrome's v10 envelope: AES-256-GCM under a key that the OS key store
 * wraps (DPAPI on Windows). The key is unwrapped once per process.
 */
const PREFIX = 'cursor-safe-storage:v1:'
let cachedKey = null

export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

export function unseal(value, options = {}) {
  if (!isSealed(value)) return value
  const blob = Buffer.from(value.slice(PREFIX.length), 'base64')
  const version = blob.subarray(0, 3).toString('latin1')
  if (version !== 'v10') throw new Error(`unsupported safeStorage envelope: ${version}`)
  const nonce = blob.subarray(3, 15)
  const tag = blob.subarray(blob.length - 16)
  const body = blob.subarray(15, blob.length - 16)
  const key = options.key ?? masterKey(options)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

/** The AES key lives in Local State, wrapped by DPAPI for the current user. */
function masterKey(options = {}) {
  if (cachedKey) return cachedKey
  const localState = options.localState ?? join(defaultUserData(), 'Local State')
  const raw = JSON.parse(readFileSync(localState, 'utf8'))
  const encrypted = Buffer.from(raw?.os_crypt?.encrypted_key ?? '', 'base64')
  if (encrypted.length === 0) throw new Error('Local State carries no os_crypt key')
  // The first five bytes are the literal marker "DPAPI".
  const unwrapped = dpapiUnprotect(encrypted.subarray(5))
  cachedKey = unwrapped
  return cachedKey
}

function defaultUserData() {
  return process.env.DSH_CURSOR_USERDATA ?? join(process.env.APPDATA ?? '', 'Cursor')
}

/**
 * DPAPI is only reachable through the platform API, so one short PowerShell call
 * does the unwrap. The ciphertext travels as base64 through argv, never a file.
 */
function dpapiUnprotect(payload) {
  const script = [
    'Add-Type -AssemblyName System.Security;',
    '$b=[Convert]::FromBase64String($env:DSH_DPAPI);',
    '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
    '[Convert]::ToBase64String($p)',
  ].join(' ')
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, DSH_DPAPI: payload.toString('base64') },
  })
  const text = (result.stdout ?? '').trim()
  if (!text) throw new Error(`DPAPI unwrap failed: ${(result.stderr ?? '').trim().slice(0, 200)}`)
  return Buffer.from(text, 'base64')
}
