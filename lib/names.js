/** Text helpers shared by every target; no I/O here so they stay unit-testable. */

/** Cursor appends capability suffixes to a base model id (gpt-5.3-codex-high-fast). */
const VARIANT_SUFFIXES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'fast']

/** Strip at most two trailing variant segments, e.g. `x-high-fast` -> `x`. */
export function stripVariants(id) {
  let base = String(id ?? '')
  for (let round = 0; round < 2; round += 1) {
    const match = /-([a-z]+)$/.exec(base)
    if (!match || !VARIANT_SUFFIXES.includes(match[1])) break
    base = base.slice(0, -match[1].length - 1)
  }
  return base
}

/** A filesystem-safe, TOML-key-safe slug for one model id. */
export function slug(id) {
  return String(id ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'model'
}

/** Collapse Cursor's tooltip markdown into one short sentence. */
export function plainText(markdown, limit = 160) {
  const text = String(markdown ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*|__|`|\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

export function nonEmpty(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

export function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}