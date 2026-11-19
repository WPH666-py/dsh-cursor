import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Expand `~`, `~/x` and environment variables in a configured path. */
export function expandPath(input, env = process.env) {
  let value = String(input ?? '').trim()
  if (value === '') return null
  if (value === '~') value = homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = join(homedir(), value.slice(2))
  value = value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (all, name) => env[name] ?? all)
  return isAbsolute(value) ? value : resolve(value)
}