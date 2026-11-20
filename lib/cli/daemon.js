import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import http2 from 'node:http2'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { socketPath } from './locate.js'

const netModule = () => createRequire(import.meta.url)('node:net')

/**
 * Owns one Cursor agent-host daemon process and speaks Connect/JSON to it.
 *
 * Everything network-facing happens inside Cursor's own process: this class
 * only starts it, frames requests, and reads answers.
 */
export class CursorDaemon {
  constructor(options) {
    this.entry = options.entry
    this.node = options.node
    this.address = options.address
    this.path = socketPath(options.address)
    this.home = options.home
    // A private dir keeps sessions away from the editor; the shared one reuses
    // whatever sign-in state Cursor already stored.
    this.isolated = options.isolated !== false
    this.log = options.log ?? (() => {})
    this.child = null
    this.stderr = []
  }

  /** Spawn the daemon and wait until the pipe accepts a connection. */
  async start(options = {}) {
    if (this.child) return this
    const workDir = join(this.home, 'agent-host')
    mkdirSync(workDir, { recursive: true })
    const args = [this.entry, '--listen', this.address]
    // The scripted profile omits the surface flag; the surface profile keeps it.
    if (options.surface !== true) args.push('--no-surface-owns-background-wakeups')
    if (this.isolated) args.push('--agents-dir', workDir, '--blobs-dir', join(workDir, 'blobs'))
    if (options.modelId) args.push('--model-id', options.modelId)
    if (options.updater) args.push('--updater', '--local-loop')
    this.child = spawn(this.node, args, {
      cwd: join(this.entry, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...(options.env ?? {}) },
    })
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      this.stderr.push(text)
      if (this.stderr.length > 40) this.stderr.shift()
    })
    this.child.on('exit', (code) => {
      this.child = null
      this.log(`daemon exited with ${code}`)
    })
    await this.waitReady(options.timeoutMs ?? 20_000)
    return this
  }

  waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (Date.now() > deadline) {
          reject(new Error(`agent-host daemon did not accept ${this.path}: ${this.stderr.join('').slice(-400)}`))
          return
        }
        const socket = netModule().connect(this.path)
        socket.once('connect', () => { socket.destroy(); resolve() })
        socket.once('error', () => { socket.destroy(); setTimeout(attempt, 250) })
      }
      attempt()
    })
  }

  /** Lazily open the HTTP/2 session the daemon speaks on its pipe. */
  session() {
    if (this.http2) return this.http2
    const { connect: netConnect } = netModule()
    this.http2 = http2.connect('http://localhost', {
      createConnection: () => netConnect(this.path),
    })
    this.http2.on('error', (error) => this.log(`h2 session error: ${error.message}`))
    return this.http2
  }

  /** One Connect unary call over HTTP/2; resolves with the parsed JSON body. */
  call(service, method, body = {}, headers = {}) {
    const payload = JSON.stringify(body ?? {})
    const url = `/${service}/${method}`
    return new Promise((resolve, reject) => {
      let stream
      try {
        stream = this.session().request({
          ':method': 'POST',
          ':path': url,
          'content-type': 'application/json',
          'connect-protocol-version': '1',
          accept: 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        })
      } catch (error) {
        reject(error)
        return
      }
      let status = null
      let text = ''
      stream.on('response', (incoming) => { status = incoming[':status'] })
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => { text += chunk })
      stream.on('end', () => {
        if (status !== 200) {
          reject(Object.assign(new Error(`${url} -> HTTP ${status}: ${text.slice(0, 300)}`), { status, body: text }))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error(`${url} returned a non-JSON body: ${text.slice(0, 200)}`))
        }
      })
      stream.on('error', reject)
      stream.end(payload)
    })
  }

  /**
   * Server-streaming call.
   *
   * Connect frames each message as [flags:1][length:4][payload], so a raw chunk
   * boundary is not a message boundary and newline splitting would lose events.
   */
  async *stream(service, method, body = {}, headers = {}) {
    const payload = JSON.stringify(body ?? {})
    const url = `/${service}/${method}`
    const stream = this.session().request({
      ':method': 'POST',
      ':path': url,
      'content-type': 'application/connect+json',
      'connect-protocol-version': '1',
      ...headers,
    })
    // A streaming request is enveloped too: [flags:1][length:4][payload].
    const envelope = Buffer.from(payload, 'utf8')
    const header = Buffer.alloc(5)
    header.writeUInt32BE(envelope.length, 1)
    stream.end(Buffer.concat([header, envelope]))
    let buffer = Buffer.alloc(0)
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)])
      while (buffer.length >= 5) {
        const flags = buffer[0]
        const length = buffer.readUInt32BE(1)
        if (buffer.length < 5 + length) break
        const message = buffer.subarray(5, 5 + length)
        buffer = buffer.subarray(5 + length)
        if (flags & 0x02) {
          const text = message.toString('utf8').trim()
          if (text) this.log(`stream end frame: ${text.slice(0, 200)}`)
          continue
        }
        const text = message.toString('utf8')
        if (!text.trim()) continue
        yield JSON.parse(text)
      }
    }
  }

  async stop() {
    const child = this.child
    this.child = null
    if (this.http2) { try { this.http2.close() } catch { /* already closed */ } this.http2 = null }
    if (!child) return
    child.kill()
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}
