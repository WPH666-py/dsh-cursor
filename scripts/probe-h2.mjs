/** Try HTTP/2 over the daemon pipe, which is what an HTTP/1 parser error implies. */
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http2 from 'node:http2'
import { listenAddress, locateDaemon } from '../lib/cli/locate.js'
import { CursorDaemon } from '../lib/cli/daemon.js'

const found = locateDaemon()
const home = mkdtempSync(join(tmpdir(), 'dsh-cursor-h2-'))
const daemon = new CursorDaemon({ entry: found.entry, node: found.node, address: listenAddress({ pid: process.pid }), home })
await daemon.start()
console.log('ready', daemon.path)

const session = http2.connect('http://localhost', { createConnection: () => createRequire(import.meta.url)('node:net').connect(daemon.path) })
session.on('error', (error) => console.log('session error', error.message))

function call(service, method, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body ?? {})
    const req = session.request({
      ':method': 'POST',
      ':path': `/${service}/${method}`,
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      'content-length': Buffer.byteLength(payload),
    })
    let text = ''
    let status = null
    req.on('response', (headers) => { status = headers[':status'] })
    req.setEncoding('utf8')
    req.on('data', (chunk) => { text += chunk })
    req.on('end', () => resolve({ status, text }))
    req.on('error', (error) => resolve({ status, text: `ERR ${error.message}` }))
    req.end(payload)
  })
}

const services = ['agent.v1.AgentHostService', 'agent.v1.AgentService']
const methods = ['GetUsableModels', 'GetModels', 'ListModels', 'GetAllowedModelIntents', 'GetDefaultModelForCli']
for (const service of services) {
  for (const method of methods) {
    const r = await call(service, method, {})
    console.log(`${service}/${method} -> ${r.status} ${String(r.text).slice(0, 120)}`)
  }
}
session.close()
await daemon.stop()
