/**
 * The Harness side: one adapter route whose catalog is the imported Cursor list.
 *
 * Harness adapters are duck-typed here on purpose — the plugin ships no runtime
 * dependency on the harness packages, so a locally linked bundle cannot break on
 * module resolution. Every optional hook `LlmAdapter` declares is implemented.
 */
export function createCursorAdapter({ getCatalog, config, llm }) {
  // The llm service arrives from the injected child context: reading `ctx.llm` here throws
  // "cannot get property \"llm\" without inject" the moment a request is streamed.
  const provider = config.provider
  const delegate = config.targets.harness.delegate

  const adapter = {
    providerInfo() {
      return { id: provider, name: config.displayName }
    },

    providerRetryPolicy() {
      return undefined
    },

    imageRequestPricing() {
      return undefined
    },

    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },

    async listModels() {
      return models().map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        ...(model.description ? { description: model.description } : {}),
        ...(model.contextWindow ? { context: { contextWindow: model.contextWindow } } : {}),
        inputModalities: model.input,
      }))
    },

    async resolveModel(_provider, id) {
      const found = models().find((model) => model.id === id)
      return {
        provider,
        id,
        name: found?.name ?? id,
        ...(found?.description ? { description: found.description } : {}),
        ...(found?.contextWindow ? { context: { contextWindow: found.contextWindow } } : {}),
        inputModalities: found?.input ?? ['text'],
      }
    },

    async prepareCall(_provider, id, signal) {
      const model = await adapter.resolveModel(provider, id, signal)
      return { model, stream: (options) => adapter.stream(options) }
    },

    async *stream(options) {
      const route = delegate.provider
      if (!route || typeof llm?.stream !== 'function') {
        throw cursorError(
          'CURSOR_NO_DELEGATE',
          `"${provider}" is a catalog-only route: set targets.harness.delegate.provider to a registered route that can serve these ids (a Cursor bridge declared through llm-pi-ai, for example)`,
        )
      }
      const model = delegate.modelMap[options.model] ?? options.model
      yield* llm.stream({ ...options, provider: route, model })
    },
  }

  function models() {
    const catalog = getCatalog()
    return Array.isArray(catalog?.models) ? catalog.models : []
  }

  return adapter
}

function cursorError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}