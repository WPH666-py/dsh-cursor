/** Minimal TOML emitters for Codex configuration; values are always quoted. */

export function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/** A quoted table key, stable for ids that contain dots or dashes. */
export function tomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)
}

/**
 * Codex model providers plus one profile per imported model.
 * @param {{providerId: string, name: string, baseURL: string, wireApi: string, envKey: string, models: Array<{id: string}>, maxProfiles: number, slug: (id: string) => string}} input
 */
export function renderCodexConfig(input) {
  const lines = [
    `[model_providers.${tomlKey(input.providerId)}]`,
    `name = ${tomlString(input.name)}`,
    `base_url = ${tomlString(input.baseURL)}`,
    `wire_api = ${tomlString(input.wireApi)}`,
    `env_key = ${tomlString(input.envKey)}`,
    '',
  ]
  const models = input.models.slice(0, input.maxProfiles)
  for (const model of models) {
    lines.push(`[profiles.${tomlKey(`${input.providerId}-${input.slug(model.id)}`)}]`)
    lines.push(`model = ${tomlString(model.id)}`)
    lines.push(`model_provider = ${tomlString(input.providerId)}`)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}