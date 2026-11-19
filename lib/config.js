import { clampInt, nonEmpty } from './names.js'

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8787/v1'

/**
 * Normalise the row config. Every field is optional; an unknown or malformed
 * value falls back to the documented default instead of failing activation.
 */
export function resolveConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const targets = source.targets && typeof source.targets === 'object' ? source.targets : {}
  const harness = targets.harness && typeof targets.harness === 'object' ? targets.harness : {}
  const claudeCode = targets.claudeCode && typeof targets.claudeCode === 'object' ? targets.claudeCode : {}
  const codex = targets.codex && typeof targets.codex === 'object' ? targets.codex : {}
  const bridge = source.bridge && typeof source.bridge === 'object' ? source.bridge : {}
  const delegate = harness.delegate && typeof harness.delegate === 'object' ? harness.delegate : {}
  const slots = claudeCode.slots && typeof claudeCode.slots === 'object' ? claudeCode.slots : {}

  const provider = nonEmpty(source.provider, 'cursor')
  const delegateProvider = nonEmpty(delegate.provider, '')
  const modelMap = {}
  if (delegate.modelMap && typeof delegate.modelMap === 'object' && !Array.isArray(delegate.modelMap)) {
    for (const [from, to] of Object.entries(delegate.modelMap)) {
      if (typeof from === 'string' && typeof to === 'string' && to.trim() !== '') modelMap[from] = to.trim()
    }
  }

  return {
    enabled: source.enabled !== false,
    provider,
    displayName: nonEmpty(source.displayName, 'Cursor'),
    include: source.include === 'base' ? 'base' : 'all',
    filter: nonEmpty(source.filter, ''),
    refreshSeconds: clampInt(source.refreshSeconds, 900, 60, 86_400),
    liveCatalog: source.liveCatalog !== false,
    offlineFallback: source.offlineFallback !== false,
    requestTimeoutMs: clampInt(source.requestTimeoutMs, 10_000, 1_000, 120_000),
    exportDir: nonEmpty(source.exportDir, '~/.dsh-cursor'),
    targets: {
      harness: {
        enabled: harness.enabled !== false,
        // A delegated route must never point back at this plugin's own provider.
        delegate: {
          provider: delegateProvider === provider ? '' : delegateProvider,
          modelMap,
        },
      },
      claudeCode: {
        enabled: claudeCode.enabled !== false,
        apply: claudeCode.apply === true,
        slots: {
          opus: nonEmpty(slots.opus, ''),
          sonnet: nonEmpty(slots.sonnet, ''),
          haiku: nonEmpty(slots.haiku, ''),
        },
      },
      codex: {
        enabled: codex.enabled !== false,
        apply: codex.apply === true,
        providerId: nonEmpty(codex.providerId, 'cursor'),
        maxProfiles: clampInt(codex.maxProfiles, 60, 1, 500),
      },
    },
    bridge: {
      // Artifacts need a syntactically valid endpoint; only an explicit value
      // is trusted to actually serve requests when merging client configs.
      baseURL: nonEmpty(bridge.baseURL, DEFAULT_BRIDGE_URL),
      explicit: nonEmpty(bridge.baseURL, '') !== '',
      apiKeyEnv: nonEmpty(bridge.apiKeyEnv, 'CURSOR_BRIDGE_API_KEY'),
      wireApi: bridge.wireApi === 'responses' ? 'responses' : 'chat',
    },
  }
}