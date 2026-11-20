import { randomUUID } from 'node:crypto'

// No literal escapes: this shell layer rewrites backslashes in written files.
const NL = String.fromCharCode(10)

/** ACP method names, kept in one place so a dialect change is a one-line edit. */
export const ACP = {
  initialize: 'initialize',
  newSession: 'session/new',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
  update: 'session/update',
  requestPermission: 'session/request_permission',
}

/**
 * A JSON-RPC 2.0 client for the Agent Client Protocol over newline-delimited JSON.
 *
 * Streams are injected so the whole client is testable without a real agent, and
 * so the same instance can sit on a child process, a named pipe, or wsl.exe.
 */
export class AcpClient {
  constructor(options) {
    this.input = options.input
    this.output = options.output
    this.onPermission = options.onPermission ?? (() => 'allow_once')
    this.onRequest = options.onRequest ?? null
    this.listeners = new Set()
    this.pending = new Map()
    this.buffer = ''
    this.closed = false
    this.input.setEncoding?.('utf8')
    this.input.on('data', (chunk) => this.consume(chunk))
    this.input.on('end', () => this.failAll(new Error('ACP stream ended')))
    this.input.on('error', (error) => this.failAll(error))
  }

  consume(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf(NL)) !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  dispatch(message) {
    if (typeof message?.method === 'string') {
      if (message.id !== undefined && message.id !== null) this.answer(message)
      else this.emit(message)
      return
    }
    const entry = this.pending.get(message?.id)
    if (!entry) return
    this.pending.delete(message.id)
    if (message.error) entry.reject(Object.assign(new Error(message.error.message ?? 'ACP error'), { code: message.error.code }))
    else entry.resolve(message.result ?? {})
  }

  /** Server-to-client request: permissions are answered, everything else is refused. */
  answer(message) {
    if (message.method === ACP.requestPermission) {
      this.reply(message.id, this.permissionResult(message.params))
      return
    }
    if (this.onRequest) {
      const handled = this.onRequest(message)
      if (handled !== undefined) {
        this.reply(message.id, handled)
        return
      }
    }
    this.replyError(message.id, -32601, `unsupported client method: ${message.method}`)
  }

  permissionResult(params) {
    const options = Array.isArray(params?.options) ? params.options : []
    const wanted = this.onPermission(params)
    const picked = options.find((option) => option.kind === wanted) ?? options[0]
    if (!picked) return { outcome: { outcome: 'cancelled' } }
    return { outcome: { outcome: 'selected', optionId: picked.optionId } }
  }

  emit(message) {
    for (const listener of this.listeners) {
      try {
        listener(message)
      } catch {
        /* a broken listener must not stop the stream */
      }
    }
  }

  onMessage(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  write(value) {
    if (this.closed) throw new Error('ACP client is closed')
    this.output.write(JSON.stringify(value) + NL)
  }

  reply(id, result) {
    this.write({ jsonrpc: '2.0', id, result })
  }

  replyError(id, code, message) {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  request(method, params) {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async initialize(clientInfo = { name: 'dsh-cursor', version: '0.1.0' }) {
    const result = await this.request(ACP.initialize, {
      protocolVersion: 1,
      clientInfo,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    this.capabilities = result
    return result
  }

  async newSession(options = {}) {
    const result = await this.request(ACP.newSession, {
      cwd: options.cwd,
      mcpServers: options.mcpServers ?? [],
    })
    return result
  }

  prompt(sessionId, blocks) {
    return this.request(ACP.prompt, { sessionId, prompt: blocks })
  }

  cancel(sessionId) {
    this.write({ jsonrpc: '2.0', method: ACP.cancel, params: { sessionId } })
  }

  failAll(error) {
    for (const [, entry] of this.pending) entry.reject(error)
    this.pending.clear()
  }

  close() {
    this.closed = true
    this.failAll(new Error('ACP client closed'))
  }
}
