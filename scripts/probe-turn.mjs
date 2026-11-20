/** The decisive probe: can the official daemon run a turn without ListModels? */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CursorDaemon } from '../lib/cli/daemon.js'
import { listenAddress, locateDaemon } from '../lib/cli/locate.js'

const found = locateDaemon()
const daemon = new CursorDaemon({
  entry: found.entry,
  node: found.node,
  address: listenAddress({ pid: process.pid }),
  home: mkdtempSync(join(tmpdir(), 'dsh-cursor-turn-')),
  isolated: process.env.SHARED !== '1',
  log: (m) => console.log('  [daemon]', m),
})
const MODEL = process.env.MODEL ?? 'default'
const SVC = 'agent.v1.AgentHostService'
const clientInstanceId = randomUUID()
const sessionId = randomUUID()

await daemon.start({
  modelId: MODEL,
  updater: process.env.UPDATER === '1',
  env: process.env.UPDATER === '1'
    ? { AGENT_HOST_DAEMON_HARNESS_CDN: 'https://downloads.cursor.com/agent-host-harness/', AGENT_HOST_DAEMON_HARNESS_CHANNEL: 'stable' }
    : {},
})
console.log('ready')

const tryCall = async (method, body) => {
  try {
    const out = await daemon.call(SVC, method, body)
    console.log(`${method} -> OK`, JSON.stringify(out).slice(0, 240))
    return out
  } catch (error) {
    console.log(`${method} -> ${error.status ?? ''} ${String(error.body ?? error.message).slice(0, 220)}`)
    return null
  }
}

const { detectCursor } = await import('../lib/detect.js')
const { readCursorState } = await import('../lib/state-db.js')
const { unseal } = await import('../lib/cli/safe-storage.js')
const token = unseal((await readCursorState(detectCursor().dbPath, ['cursorAuth/accessToken']))['cursorAuth/accessToken'])
const issuedAtMs = Date.now()
await tryCall('UpdateDaemonAuth', { accessToken: token, issuedAtMs, clientInstanceId, signedOut: false })

await tryCall('WarmUpNetwork', { clientInstanceId })
await new Promise((r) => setTimeout(r, 1500))

await tryCall('CreateSession', { sessionId, clientInstanceId, sessionOptions: { workspacePaths: [process.cwd()] } })

const sent = await tryCall('SendMessage', {
  sessionId,
  text: 'Reply with exactly: BRIDGE OK',
  modelId: MODEL,
  messageId: randomUUID(),
  clientInstanceId,
})

if (sent) {
  console.log('streaming turns...')
  const deadline = setTimeout(() => process.exit(0), 45_000)
  try {
    for await (const event of daemon.stream(SVC, 'WatchTurns', { clientInstanceId })) {
      console.log('event:', JSON.stringify(event).slice(0, 300))
      if (JSON.stringify(event).includes('BRIDGE OK')) break
    }
  } catch (error) {
    console.log('watch error:', String(error.message).slice(0, 200))
  }
  clearTimeout(deadline)
}
await daemon.stop()
