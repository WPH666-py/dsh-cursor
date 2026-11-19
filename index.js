/**
 * dsh-cursor — import the local Cursor account's model catalog.
 *
 * Activation order:
 *   1. detect a local Cursor installation (nothing at all happens when it is absent)
 *   2. collect the account catalog: live account view -> disk cache -> Cursor's own state
 *   3. write token-free artifacts and, when enabled, merge Claude Code / Codex configuration
 *   4. register the `cursor` route so the imported models appear in the Harness picker
 */
import { collectCatalog } from './lib/catalog.js'
import { resolveConfig } from './lib/config.js'
import { detectCursor } from './lib/detect.js'
import { log } from './lib/log.js'
import { writeArtifacts } from './lib/publish/artifacts.js'
import { clearClientTargets, syncClientTargets } from './lib/publish/clients.js'
import { createCursorAdapter } from './lib/publish/harness.js'

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    log(ctx, 'info', 'disabled by configuration')
    return
  }

  let stopped = false
  let disposeRoute = null
  let routeFailed = false
  /** The llm service, once a context that declares it is available. */
  let llmService = null
  let catalog = null
  let signature = ''

  const stopRoute = () => {
    if (!disposeRoute) return
    try {
      disposeRoute()
    } catch {
      /* the route may already be gone */
    }
    disposeRoute = null
  }

  async function refresh(initial) {
    if (stopped) return
    const cursor = detectCursor()
    if (!cursor.installed) {
      clearClientTargets(config, ctx)
      stopRoute()
      if (initial) log(ctx, 'info', 'Cursor is not installed on this machine; nothing imported')
      return
    }

    const next = await collectCatalog({ cursor, config, ctx })
    if (!next || stopped) return

    catalog = next
    const nextSignature = `${next.source}|${next.fetchedAt}|${next.models.length}|${next.models.map((model) => model.id).join(',')}`
    const changed = nextSignature !== signature
    signature = nextSignature

    writeArtifacts({ cursor, catalog: next, config, ctx })
    syncClientTargets({ cursor, catalog: next, config, ctx })
    publishRoute(changed)

    if (initial || changed) {
      log(ctx, 'info', `imported ${next.models.length}/${next.total} Cursor models (${next.source}) as "${config.provider}"`)
    }
  }

  function publishRoute(changed) {
    if (!config.targets.harness.enabled) {
      stopRoute()
      return
    }
    if (routeFailed) return
    if (llmService === null) return
    if (typeof llmService.registerAdapter !== 'function') {
      routeFailed = true
      log(ctx, 'warn', 'this host has no llm service; the model list was exported but not registered')
      return
    }
    if (disposeRoute) {
      if (!changed) return
      try {
        disposeRoute.replace([config.provider])
        return
      } catch {
        disposeRoute = null
      }
    }
    try {
      const adapter = createCursorAdapter({ getCatalog: () => catalog, config, ctx })
      disposeRoute = llmService.registerAdapter([config.provider], adapter)
    } catch (error) {
      routeFailed = true
      log(ctx, 'warn', `could not register the "${config.provider}" route: ${error?.message ?? error}`)
    }
  }

  // Cordis rejects a direct `ctx.llm` read from a plugin that never declared the dependency,
  // and that throw used to be swallowed by the refresh catch: the catalog exported but the
  // route never registered, so the picker stayed empty. Resolve it through an injected child
  // context, which also retries once the service appears.
  ctx.inject(['llm'], (scoped) => {
    llmService = scoped.llm
    publishRoute(true)
    return () => {
      llmService = null
      stopRoute()
    }
  })

  ctx.effect(() => {
    let timer = null
    const run = (initial) => {
      refresh(initial).catch((error) => log(ctx, 'warn', `import failed: ${error?.message ?? error}`))
    }
    run(true)
    timer = setInterval(() => run(false), config.refreshSeconds * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      stopped = true
      if (timer) clearInterval(timer)
      stopRoute()
    }
  })
}