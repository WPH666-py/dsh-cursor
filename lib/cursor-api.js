/**
 * The account half of the Cursor catalog.
 *
 * Cursor's own clients ask `aiserver.v1.AiService` over Connect with JSON, using
 * the bearer token the editor already stored locally. The plugin reuses that
 * token the same way; it is never written to a file, a log line, or an artifact.
 */
const DEFAULT_BASE_URL = 'https://api2.cursor.sh'

export function cursorBaseUrl(stored) {
  return typeof stored === 'string' && /^https?:\/\//.test(stored) ? stored.replace(/\/+$/, '') : DEFAULT_BASE_URL
}

export async function fetchCursorJson(path, options) {
  const { token, baseUrl = DEFAULT_BASE_URL, timeoutMs = 10_000, fetchImpl = globalThis.fetch, clientVersion = '3.0.0' } = options
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'x-cursor-client-version': clientVersion,
        'x-cursor-client-type': 'ide',
      },
      body: '{}',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`${path} answered HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch the two catalog views Cursor's UI joins together: the ids this account
 * may actually call, and the per-model capability metadata.
 */
export async function fetchLiveCatalog(options) {
  const usable = await fetchCursorJson('/aiserver.v1.AiService/GetUsableModels', options)
  let available = null
  try {
    available = await fetchCursorJson('/aiserver.v1.AiService/AvailableModels', options)
  } catch {
    // Capabilities are advisory; the usable ids alone are still a valid import.
  }
  return {
    usable: Array.isArray(usable?.models) ? usable.models : [],
    available: Array.isArray(available?.models) ? available.models : [],
  }
}

/** Fail fast on an expired token instead of importing an empty catalog. */
export function assertToken(token) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('Cursor is installed but no account token was found; open Cursor and sign in once')
  }
  return token.trim()
}