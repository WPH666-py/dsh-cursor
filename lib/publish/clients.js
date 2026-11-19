import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { log } from '../log.js'
import { expandPath } from '../paths.js'
import { renderCodexConfig } from '../toml.js'
import { slug } from '../names.js'
import { bridgeUrl, pickClaudeSlots } from './artifacts.js'

const MARKER = '_dshCursor'
const BLOCK_BEGIN = '# >>> dsh-cursor managed block — regenerated on every import; do not edit'
const BLOCK_END = '# <<< dsh-cursor managed block'

/**
 * Optionally merge the imported models into the clients that are installed.
 *
 * Nothing is written unless the client is present, the target sets `apply: true`
 * and a bridge endpoint is configured — a model list a client cannot reach is
 * worse than no list at all.
 */
export function syncClientTargets({ catalog, config, ctx }) {
  if (config.targets.claudeCode.enabled && config.targets.claudeCode.apply) applyClaudeCode(catalog, config, ctx)
  if (config.targets.codex.enabled && config.targets.codex.apply) applyCodex(catalog, config, ctx)
}

/** Undo both merges; called when Cursor disappears or the plugin is disabled. */
export function clearClientTargets(config, ctx) {
  clearClaudeCode(ctx)
  clearCodex(ctx)
}

export function claudeSettingsPath(env = process.env) {
  const directory = expandPath(env.CLAUDE_CONFIG_DIR ?? '~/.claude', env)
  return directory ? join(directory, 'settings.json') : null
}

export function codexConfigPath(env = process.env) {
  const directory = expandPath(env.CODEX_HOME ?? '~/.codex', env)
  return directory ? join(directory, 'config.toml') : null
}

export function clientInstalled(kind, env = process.env, exists = existsSync, home = homedir()) {
  if (kind === 'claudeCode') {
    return exists(join(expandPath(env.CLAUDE_CONFIG_DIR ?? '~/.claude', env) ?? '', 'settings.json'))
      || exists(join(home, '.claude'))
      || exists(join(home, '.claude.json'))
  }
  if (kind === 'codex') {
    return exists(join(expandPath(env.CODEX_HOME ?? '~/.codex', env) ?? '', 'config.toml'))
      || exists(join(home, '.codex'))
  }
  return false
}

function applyClaudeCode(catalog, config, ctx) {
  if (!clientInstalled('claudeCode')) return
  const url = bridgeUrl(config)
  if (!config.bridge.explicit) {
    log(ctx, 'info', 'Claude Code merge skipped: set bridge.baseURL so the imported ids are reachable')
    return
  }
  const path = claudeSettingsPath()
  if (!path) return
  let settings
  try {
    settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  } catch (error) {
    log(ctx, 'warn', `Claude Code settings are not valid JSON; left untouched (${error?.message ?? error})`)
    return
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return

  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {}
  const written = []
  const set = (key, value) => {
    if (!value) return
    env[key] = value
    written.push(key)
  }
  set('ANTHROPIC_BASE_URL', url)
  const slots = pick(catalog, config)
  set('ANTHROPIC_DEFAULT_OPUS_MODEL', slots.opus)
  set('ANTHROPIC_DEFAULT_SONNET_MODEL', slots.sonnet)
  set('ANTHROPIC_DEFAULT_HAIKU_MODEL', slots.haiku)
  settings.env = env
  settings[MARKER] = { at: new Date().toISOString(), envKeys: written }

  backupOnce(path)
  writeAtomic(path, `${JSON.stringify(settings, null, 2)}\n`)
  log(ctx, 'info', `merged ${written.length} keys into ${path}`)
}

function clearClaudeCode(ctx) {
  const path = claudeSettingsPath()
  if (!path || !existsSync(path)) return
  let settings
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return
  }
  const marker = settings?.[MARKER]
  if (!marker) return
  for (const key of Array.isArray(marker.envKeys) ? marker.envKeys : []) {
    if (settings.env && key in settings.env) delete settings.env[key]
  }
  if (settings.env && Object.keys(settings.env).length === 0) delete settings.env
  delete settings[MARKER]
  writeAtomic(path, `${JSON.stringify(settings, null, 2)}\n`)
  log(ctx, 'info', `removed the dsh-cursor keys from ${path}`)
}

function applyCodex(catalog, config, ctx) {
  if (!clientInstalled('codex')) return
  const url = bridgeUrl(config)
  if (!config.bridge.explicit) {
    log(ctx, 'info', 'Codex merge skipped: set bridge.baseURL so the imported ids are reachable')
    return
  }
  const path = codexConfigPath()
  if (!path) return
  const block = `# ${BLOCK_BEGIN.slice(2)}\n${renderCodexConfig({
    providerId: config.targets.codex.providerId,
    name: config.displayName,
    baseURL: url,
    wireApi: config.bridge.wireApi,
    envKey: config.bridge.apiKeyEnv,
    models: catalog.models,
    maxProfiles: config.targets.codex.maxProfiles,
    slug,
  })}# ${BLOCK_END.slice(2)}\n`

  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  backupOnce(path)
  writeAtomic(path, spliceBlock(existing, block))
  log(ctx, 'info', `merged ${config.targets.codex.maxProfiles} profiles into ${path}`)
}

function clearCodex(ctx) {
  const path = codexConfigPath()
  if (!path || !existsSync(path)) return
  const existing = readFileSync(path, 'utf8')
  if (!existing.includes('dsh-cursor managed block')) return
  writeAtomic(path, spliceBlock(existing, ''))
  log(ctx, 'info', `removed the dsh-cursor block from ${path}`)
}

/** Replace the managed block in place, or append it when absent. */
export function spliceBlock(existing, block) {
  const begin = existing.indexOf('# >>> dsh-cursor managed block')
  const end = existing.indexOf('# <<< dsh-cursor managed block')
  if (begin !== -1 && end !== -1 && end > begin) {
    const after = existing.indexOf('\n', end)
    const head = existing.slice(0, begin)
    const tail = after === -1 ? '' : existing.slice(after + 1)
    return `${head}${block}${tail}`.replace(/\n{3,}/g, '\n\n')
  }
  const trimmed = existing.replace(/\s+$/, '')
  return `${trimmed === '' ? '' : `${trimmed}\n\n`}${block}`
}

function pick(catalog, config) {
  return pickClaudeSlots(catalog.models, config.targets.claudeCode.slots)
}

function backupOnce(path) {
  const backup = `${path}.dsh-cursor.bak`
  if (existsSync(backup) || !existsSync(path)) return
  try {
    copyFileSync(path, backup)
  } catch {
    /* a missing backup never blocks the merge */
  }
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.dsh-cursor.tmp`
  writeFileSync(temporary, content, 'utf8')
  renameSync(temporary, path)
}