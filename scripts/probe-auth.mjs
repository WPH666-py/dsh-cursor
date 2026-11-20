/** Find the handshake that lets the official daemon list models. */
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http2 from 'node:http2'
import { listenAddress, locateDaemon } from '../lib/cli/locate.js'
import { CursorDaemon } from '../lib/cli/daemon.js'
import { detectCursor } from '../lib/detect.js'
import { readCursorState } from '../lib/state-db.js'

const token = (await readCursorState(detectCursor().dbPath, ['cursorAuth/accessToken']))['cursorAuth/accessToken']
console.log('token:', token ? `${token.slice(0, 12)}… (${token.length})` : 'none')

const found = locateDaemon()
const home = mkdtempSync(join(tmpdir(), 'dsh-cursor-auth-'))
const daemon = new CursorDaemon({ entry: found.entry, node: found.node, address: listenAddress({ pid: process.pid }), home })
await daemon.start()

const session = http2.connect('http://localhost', { createConnection: () => createRequire(import.meta.url)('node:net').connect(daemon.path) })
const callWith = (method, body, extra = {}) => new Promise((resolve) => {
  const payload = JSON.stringify(body ?? {})
  const req = session.request({ ':method': 'POST', ':path': `/agent.v1.AgentHostService/${method}`, 'content-type': 'application/json', 'connect-protocol-version': '1', ...extra })
  let text = ''
  let status = null
  req.on('response', (h) => { status = h[':status'] })
  req.setEncoding('utf8')
  req.on('data', (c) => { text += c })
  req.on('end', () => resolve({ status, text: text.slice(0, 140) }))
  req.on('error', (e) => resolve({ status, text: `ERR ${e.message}` }))
  req.end(payload)
})
const call = (method, body) => callWith(method, body)

const headers = [
  { authorization: `Bearer ${token}` },
  { 'x-cursor-auth-token': token },
  { 'x-access-token': token },
  { 'cursor-access-token': token },
  { 'x-cursor-access-token': token },
]
for (const header of headers) {
  const r = await callWith('ListModels', {}, header)
  console.log(`ListModels ${Object.keys(header)[0]} -> ${r.status} ${r.text}`)
}
const bodyTry = await call('ListModels', { accessToken: token })
console.log('ListModels body token ->', bodyTry.status, bodyTry.text)
session.close()
await daemon.stop()
