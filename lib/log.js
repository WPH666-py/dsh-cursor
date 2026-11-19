/** Logging that can never break activation: a missing logger degrades to console. */
export function log(ctx, level, message) {
  const text = `[dsh-cursor] ${message}`
  try {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('dsh-cursor') : ctx?.logger
    const emit = logger?.[level] ?? logger?.info
    if (typeof emit === 'function') {
      emit.call(logger, message)
      return
    }
  } catch {
    /* the host logger is optional */
  }
  if (level === 'warn' || level === 'error') console.warn(text)
  else console.log(text)
}