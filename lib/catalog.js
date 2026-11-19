import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertToken, cursorBaseUrl, fetchLiveCatalog } from './cursor-api.js'
import { log } from './log.js'
import { plainText, stripVariants } from './names.js'
import { expandPath } from './paths.js'
import { readCursorState } from './state-db.js'

const APPLICATION_USER_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'
const ACCOUNT_KEYS = [
  'cursorAuth/accessToken',
  'cursorAuth/cachedEmail',
  'cursorAuth/storedServerBackendUrl',
  'cursorAuth/stripeMembershipType',
  'cursorAuth/cachedSignUpType',
  APPLICATION_USER_KEY,
]

/**
 * Collect the model catalog for the current account.
 *
 * Order of truth: the live account view, then the previous live answer on
 * disk, then the catalog Cursor cached in its own state database. A machine
 * without Cursor never reaches this function: the caller stops at detection.
 */
export async function collectCatalog({ cursor, config, ctx }) {
  const account = await readAccount(cursor)
  const cachePath = catalogCachePath(config)
  const cached = readCache(cachePath)
  const clientVersion = cursor.version ?? '3.0.0'

  let models = null
  let source = null
  let fetchedAt = new Date().toISOString()

  if (config.liveCatalog && account.token) {
    try {
      const live = await fetchLiveCatalog({
        token: assertToken(account.token),
        baseUrl: cursorBaseUrl(account.backend),
        timeoutMs: config.requestTimeoutMs,
        clientVersion,
      })
      models = buildModels(live)
      if (models.length > 0) source = 'live'
      else models = null
    } catch (error) {
      log(ctx, 'warn', `live Cursor catalog unavailable (${error?.message ?? error}); falling back`)
    }
  }

  if (!models && cached?.models?.length) {
    models = cached.models
    source = 'cache'
    fetchedAt = cached.fetchedAt ?? fetchedAt
  }

  if (!models && config.offlineFallback) {
    const offline = buildModels(await readOfflineCatalog(cursor))
    if (offline.length > 0) {
      models = offline
      source = 'offline'
      fetchedAt = new Date().toISOString()
    }
  }

  if (!models || models.length === 0) {
    log(ctx, 'warn', 'no Cursor models could be read from this machine or account')
    return null
  }

  const selected = applySelection(models, config)
  const catalog = {
    schema: 1,
    source,
    fetchedAt,
    account: {
      email: account.email ?? null,
      membership: account.membership ?? null,
      backend: cursorBaseUrl(account.backend),
    },
    cursor: {
      version: cursor.version ?? null,
      installDir: cursor.installDir ?? null,
    },
    total: models.length,
    models: selected,
  }

  writeCache(cachePath, catalog)
  return catalog
}

/** Normalise one usable id list joined with the capability list. */
export function buildModels({ usable, available } = {}) {
  const meta = indexMetadata(available)
  const seen = new Set()
  const models = []
  for (const entry of Array.isArray(usable) ? usable : []) {
    const id = typeof entry?.modelId === 'string' ? entry.modelId : typeof entry?.name === 'string' ? entry.name : null
    if (!id || seen.has(id)) continue
    seen.add(id)
    const baseId = stripVariants(id)
    const info = meta.get(id) ?? meta.get(baseId) ?? null
    models.push({
      id,
      name: firstNonEmpty(entry?.displayName, info?.name, id),
      description: info?.description ?? '',
      input: info?.image ? ['text', 'image'] : ['text'],
      maxMode: entry?.maxMode === true || info?.maxMode === true,
      ...(info?.contextWindow ? { contextWindow: info.contextWindow } : {}),
      ...(baseId === id ? {} : { baseId }),
      ...(Array.isArray(entry?.aliases) && entry.aliases.length > 0 ? { aliases: [...entry.aliases] } : {}),
    })
  }
  return models
}

/** Cursor's own cached UI catalog, used when the account view cannot be reached. */
export function buildModelsFromState(payload) {
  const list = Array.isArray(payload?.availableDefaultModels2) ? payload.availableDefaultModels2 : []
  const usable = []
  const available = []
  for (const model of list) {
    const name = typeof model?.name === 'string' ? model.name : null
    if (!name) continue
    usable.push({ modelId: name, displayName: model.clientDisplayName ?? name, maxMode: model.supportsMaxMode === true })
    available.push({
      name,
      clientDisplayName: model.clientDisplayName ?? name,
      supportsImages: model.supportsImages === true,
      supportsMaxMode: model.supportsMaxMode === true,
      tooltipData: { markdownContent: model.tooltipData?.markdownContent ?? '' },
    })
  }
  return { usable, available }
}

function indexMetadata(available) {
  const meta = new Map()
  for (const model of Array.isArray(available) ? available : []) {
    const key = typeof model?.name === 'string' ? model.name : null
    if (!key) continue
    const description = plainText(model.tooltipData?.markdownContent ?? model.tagline ?? '')
    const record = {
      name: model.clientDisplayName ?? key,
      description,
      image: model.supportsImages === true,
      maxMode: model.supportsMaxMode === true,
      contextWindow: contextFromText(description),
    }
    meta.set(key, record)
    for (const alias of Array.isArray(model.idAliases) ? model.idAliases : []) {
      if (typeof alias === 'string' && !meta.has(alias)) meta.set(alias, record)
    }
  }
  return meta
}

/** Cursor's tooltip states the context window as `272k context window` or `1m context window`. */
export function contextFromText(text) {
  const match = /([\d.]+)\s*([km])\s*context window/i.exec(String(text ?? ''))
  if (!match) return undefined
  const size = Number(match[1])
  if (!Number.isFinite(size) || size <= 0) return undefined
  return Math.round(size * (match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000))
}

/** Apply `include` and `filter`; a bad regular expression disables the filter. */
export function applySelection(models, config) {
  let result = models
  if (config.include === 'base') result = result.filter((model) => !model.baseId)
  if (config.filter) {
    let pattern = null
    try {
      pattern = new RegExp(config.filter, 'i')
    } catch {
      pattern = null
    }
    if (pattern) result = result.filter((model) => pattern.test(model.id) || pattern.test(model.name))
  }
  return result
}

function firstNonEmpty(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return ''
}

async function readAccount(cursor) {
  const state = await readCursorState(cursor.dbPath, ACCOUNT_KEYS)
  let offline = null
  try {
    offline = state[APPLICATION_USER_KEY] ? JSON.parse(state[APPLICATION_USER_KEY]) : null
  } catch {
    offline = null
  }
  return {
    token: state['cursorAuth/accessToken'] ?? null,
    email: state['cursorAuth/cachedEmail'] ?? null,
    membership: state['cursorAuth/stripeMembershipType'] ?? offline?.membershipType ?? null,
    backend: state['cursorAuth/storedServerBackendUrl'] ?? null,
    state: offline,
  }
}

async function readOfflineCatalog(cursor) {
  const state = await readCursorState(cursor.dbPath, [APPLICATION_USER_KEY])
  try {
    return buildModelsFromState(state[APPLICATION_USER_KEY] ? JSON.parse(state[APPLICATION_USER_KEY]) : null)
  } catch {
    return { usable: [], available: [] }
  }
}

export function catalogCachePath(config) {
  const directory = expandPath(config.exportDir)
  return directory ? join(directory, '.cache.json') : null
}

function readCache(path) {
  if (!path || !existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && Array.isArray(parsed.models) && parsed.models.length > 0 ? parsed : null
  } catch {
    return null
  }
}

function writeCache(path, catalog) {
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    // The cache is a mirror of a public model list: no token, no email, no key.
    const payload = {
      schema: catalog.schema,
      fetchedAt: catalog.fetchedAt,
      source: catalog.source,
      total: catalog.total,
      models: catalog.models,
    }
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch {
    /* an unwritable export directory must not fail the import */
  }
}