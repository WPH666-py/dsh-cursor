import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log.js'
import { slug } from '../names.js'
import { expandPath } from '../paths.js'
import { renderCodexConfig } from '../toml.js'

/**
 * Write the token-free artifacts every consumer can read without running the
 * plugin: the canonical manifest plus one file per supported client.
 */
export function writeArtifacts({ cursor, catalog, config, ctx }) {
  const directory = expandPath(config.exportDir)
  if (!directory) return null
  try {
    mkdirSync(directory, { recursive: true })
    const files = {
      manifest: join(directory, 'cursor-models.json'),
      claudeCode: join(directory, 'claude-code.json'),
      codex: join(directory, 'codex.toml'),
      cache: join(directory, '.cache.json'),
    }

    writeJson(files.manifest, {
      schema: 1,
      generatedAt: new Date().toISOString(),
      source: catalog.source,
      total: catalog.total,
      imported: catalog.models.length,
      account: catalog.account,
      cursor: { ...catalog.cursor, dataDir: cursor.dataDir },
      models: catalog.models,
    })

    writeJson(files.claudeCode, renderClaudeCode(catalog, config))

    const codexHeader = config.bridge.explicit
      ? ''
      : '# base_url is a placeholder: point it at the local Cursor bridge that serves these ids\n'
    writeFileSync(files.codex, `${codexHeader}${renderCodexConfig({
      providerId: config.targets.codex.providerId,
      name: config.displayName,
      baseURL: bridgeUrl(config),
      wireApi: config.bridge.wireApi,
      envKey: config.bridge.apiKeyEnv,
      models: catalog.models,
      maxProfiles: config.targets.codex.maxProfiles,
      slug,
    })}`, 'utf8')

    log(ctx, 'info', `wrote ${catalog.models.length} models to ${directory}`)
    return { directory, files }
  } catch (error) {
    log(ctx, 'warn', `could not write export artifacts: ${error?.message ?? error}`)
    return null
  }
}

/** Claude Code exposes three named slots, not an arbitrary model list. */
export function renderClaudeCode(catalog, config) {
  const slots = pickClaudeSlots(catalog.models, config.targets.claudeCode.slots)
  const env = {}
  if (config.bridge.explicit) env.ANTHROPIC_BASE_URL = bridgeUrl(config)
  if (slots.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = slots.opus
  if (slots.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = slots.sonnet
  if (slots.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = slots.haiku
  return {
    $comment: 'Merge this env block into ~/.claude/settings.json. Claude Code lists three named slots; the full Cursor list is in cursor-models.json.',
    env,
    slots,
    models: catalog.models.map((model) => model.id),
  }
}

/**
 * Explicit slot overrides win. Otherwise the strongest non-fast variant of the
 * family is picked: Cursor exposes `claude-opus-5-5-max`, never a bare id.
 */
export function pickClaudeSlots(models, explicit = {}) {
  return {
    opus: explicit.opus || bestVariant(models, /opus/i),
    sonnet: explicit.sonnet || bestVariant(models, /sonnet/i),
    haiku: explicit.haiku || bestVariant(models, /haiku/i),
  }
}

const EFFORT_RANK = { max: 6, xhigh: 5, high: 4, medium: 3, low: 2, minimal: 1, none: 0 }

/** Highest effort suffix wins; `-fast` variants are a latency trade, not a capability. */
export function bestVariant(models, pattern) {
  let best = null
  let bestScore = -Infinity
  for (const model of Array.isArray(models) ? models : []) {
    if (!pattern.test(model.id) || /-fast$/.test(model.id)) continue
    const suffix = /-([a-z]+)$/.exec(model.id)?.[1] ?? ''
    const score = EFFORT_RANK[suffix] ?? 0
    if (score > bestScore) {
      best = model.id
      bestScore = score
    }
  }
  return best ?? ''
}

export function bridgeUrl(config) {
  return typeof config.bridge.baseURL === 'string' ? config.bridge.baseURL.replace(/\/+$/, '') : ''
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}