import { spawnCli } from './spawn-cli.js'
import { WslKeeper } from './warm.js'

/**
 * The official non-interactive channel: `cursor-agent --print --output-format
 * stream-json`. One process runs one turn, and its NDJSON events map onto the
 * Harness stream vocabulary without any protocol handshake.
 */
export class PrintTurn {
  constructor() {
    this.started = false
    this.text = ''
    this.usage = null
    this.result = null
    this.failure = null
  }

  /** Feed one parsed event; returns the chunks it produces. */
  feed(event) {
    const chunks = []
    if (event?.type === 'assistant') {
      const next = collectText(event.message)
      if (!next) return chunks
      if (!this.started) {
        this.started = true
        chunks.push({ type: 'block-start', index: 0, blockType: 'text' })
      }
      // The CLI repeats the whole text on later events, so only the suffix is new.
      const delta = next.startsWith(this.text) ? next.slice(this.text.length) : next
      this.text = next
      if (delta) chunks.push({ type: 'text-delta', index: 0, text: delta })
      return chunks
    }
    if (event?.type === 'result') {
      this.result = event
      if (event.usage) {
        this.usage = {
          inputTokens: event.usage.inputTokens ?? 0,
          outputTokens: event.usage.outputTokens ?? 0,
        }
      }
      if (event.is_error) this.failure = new Error(String(event.result ?? 'cursor-agent reported an error'))
      return chunks
    }
    return chunks
  }

  /** Closing chunks, in the order the assembler expects them. */
  end() {
    const chunks = []
    if (!this.started) chunks.push({ type: 'block-start', index: 0, blockType: 'text' })
    chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text: this.text } })
    if (this.usage) chunks.push({ type: 'usage', usage: this.usage })
    chunks.push({ type: 'finish', reason: this.failure ? 'error' : this.result?.subtype === 'error_max_turns' ? 'length' : 'stop' })
    return chunks
  }
}

export function collectText(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** One prompt, one process: the CLI owns the session and the credentials. */
export function createPrintAdapter(options) {
  const provider = options.provider
  const getModels = options.getModels ?? (() => [])
  const spawnOptions = options.spawn ?? {}
  const keeper = options.warm === false || options.spawn?.platform !== 'win32' && process.platform !== 'win32'
    ? null
    : new WslKeeper({ distro: spawnOptions.distro ?? 'Ubuntu' })

  const adapter = {
    providerInfo() {
      return { id: provider, name: options.displayName ?? 'Cursor' }
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
      return runTurn(generate)
    },
  }

  async function* runTurn(generate) {
    const model = generate.model
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--stream-partial-output',
      '--model', model,
      '--trust',
      '--workspace', spawnOptions.workspace ?? '/tmp',
    ]
    // Hold the VM up between turns; the first turn still pays the boot cost.
    keeper?.start()
    const run = spawnCli({ ...spawnOptions, args })
    const closed = new Promise((resolve) => run.child.once('close', (code) => resolve(code)))
    const turn = new PrintTurn()
    run.stdin.write(promptText(generate))
    run.stdin.end()

    let buffer = ''
    for await (const chunk of run.stdout) {
      buffer += String(chunk)
      let index
      while ((index = buffer.indexOf(String.fromCharCode(10))) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        for (const out of turn.feed(event)) yield out
      }
    }
    const exitCode = await closed
    if (turn.failure) {
      run.kill()
      throw turn.failure
    }
    if (!turn.started && !turn.result) {
      const detail = options.diagnose ? ` | ${await options.diagnose()}` : ''
      throw new Error(`cursor-agent produced no events (exit ${exitCode}): ${run.stderr()}${detail}`)
    }
    for (const out of turn.end()) yield out
  }

  adapter.dispose = () => keeper?.stop()
  return adapter
}

/** The CLI takes one prompt string; roles are labelled inline. */
export function promptText(generate) {
  const parts = []
  if (typeof generate?.systemPrompt === 'string' && generate.systemPrompt.trim()) parts.push(generate.systemPrompt)
  for (const message of generate?.messages ?? []) {
    const text = messageText(message)
    if (text) parts.push(`${message.role ?? 'user'}: ${text}`)
  }
  return parts.join(String.fromCharCode(10)) || ''
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(String.fromCharCode(10))
}
