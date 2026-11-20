import { AcpClient } from './acp.js'

/**
 * Presents an ACP agent as a Harness adapter.
 *
 * ACP is a turn protocol, not a token API: one prompt yields `session/update`
 * notifications until the prompt request itself settles. This adapter keeps one
 * session per working directory, serialises turns (ACP allows one at a time),
 * and maps text chunks straight onto the Harness stream vocabulary.
 */
export function createAcpAdapter(options) {
  const provider = options.provider
  const displayName = options.displayName ?? 'Cursor'
  const getModels = options.getModels ?? (() => [])
  const connect = options.connect
  const providerInfoName = displayName

  let connecting = null
  let turnQueue = Promise.resolve()

  async function ensureClient() {
    if (!connecting) {
      connecting = Promise.resolve(connect()).then(async ({ client, cwd }) => {
        await client.initialize()
        const session = await client.newSession({ cwd })
        return { client, sessionId: session.sessionId, models: session.models ?? null }
      })
      connecting.catch(() => { connecting = null })
    }
    return connecting
  }

  /**
   * ACP carries one turn at a time. The gate is released when a turn's stream
   * ends, so `stream` can stay an async iterable instead of a promise.
   */
  function beginTurn() {
    const previous = turnQueue
    let release = () => {}
    turnQueue = new Promise((resolve) => { release = resolve })
    return { previous, release }
  }

  const adapter = {
    providerInfo() {
      return { id: provider, name: providerInfoName }
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
      return getModels().map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        ...(model.description ? { description: model.description } : {}),
        ...(model.contextWindow ? { context: { contextWindow: model.contextWindow } } : {}),
        inputModalities: model.input ?? ['text'],
      }))
    },
    async resolveModel(_provider, id) {
      const found = getModels().find((model) => model.id === id)
      return {
        provider,
        id,
        name: found?.name ?? id,
        ...(found?.contextWindow ? { context: { contextWindow: found.contextWindow } } : {}),
        inputModalities: found?.input ?? ['text'],
      }
    },
    async prepareCall(_provider, id, signal) {
      const model = await adapter.resolveModel(provider, id, signal)
      return { model, stream: (generate) => adapter.stream(generate) }
    },
    stream(generate) {
      return (async function* () {
        const { previous, release } = beginTurn()
        await previous.catch(() => {})
        try {
          yield* runTurn(generate)
        } finally {
          release()
        }
      })()
    },
  }

  async function* runTurn(generate) {
    const { client, sessionId } = await ensureClient()
    const queue = createQueue()
    const unsubscribe = client.onMessage((message) => {
      if (message.method !== 'session/update') return
      const update = message.params?.update
      if (!update) return
      if (update.sessionUpdate === 'agent_message_chunk') queue.push(update.content ?? null)
      else if (update.sessionUpdate === 'agent_thought_chunk') queue.push(update.content ?? null, 'reasoning')
    })

    const pending = client
      .prompt(sessionId, toPromptBlocks(generate))
      .then((result) => queue.end(null, result))
      .catch((error) => queue.end(error))

    yield { type: 'block-start', index: 0, blockType: 'text' }
    let text = ''
    for await (const item of queue) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        text += item.text
        yield { type: 'text-delta', index: 0, text: item.text }
      }
    }
    const result = await pending.catch((error) => { throw error })
    unsubscribe()
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: finishReason(result?.stopReason) }
  }

  return adapter
}

/** Minimal async queue: pushes from the notification handler, drained by the stream. */
export function createQueue() {
  const items = []
  const waiters = []
  let done = false
  let failure = null
  return {
    push(item, _kind) {
      if (done) return
      if (waiters.length > 0) waiters.shift()({ value: item, done: false })
      else items.push(item)
    },
    end(error, result) {
      if (done) return
      done = true
      failure = error ?? null
      while (waiters.length > 0) waiters.shift()({ value: undefined, done: true })
      this.result = result
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (items.length > 0) return Promise.resolve({ value: items.shift(), done: false })
          if (failure) return Promise.reject(failure)
          if (done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve, reject) => {
            waiters.push((value) => (failure ? reject(failure) : resolve(value)))
          })
        },
      }
    },
  }
}

/** ACP prompt content blocks. Tool calls are not forwarded yet. */
export function toPromptBlocks(generate) {
  const parts = []
  if (typeof generate?.systemPrompt === 'string' && generate.systemPrompt.trim()) {
    parts.push({ type: 'text', text: generate.systemPrompt })
  }
  for (const message of generate?.messages ?? []) {
    const text = messageText(message)
    if (!text) continue
    parts.push({ type: 'text', text: `${message.role ?? 'user'}: ${text}` })
  }
  if (parts.length === 0) parts.push({ type: 'text', text: '' })
  return parts
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(String.fromCharCode(10))
}

function finishReason(stopReason) {
  if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') return 'length'
  return 'stop'
}
