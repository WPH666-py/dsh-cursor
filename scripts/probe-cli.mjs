/** Diagnostic: start Cursor's daemon and find a working model-list call. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CursorDaemon } from '../lib/cli/daemon.js'
import { listenAddress, locateDaemon } from '../lib/cli/locate.js'

const found = locateDaemon()
console.log('locate:', found?.source, found?.entry ? 'daemon' : found?.cli)
if (!found?.entry) process.exit(0)

const daemon = new CursorDaemon({
  entry: found.entry,
  node: found.node,
  address: listenAddress({ pid: process.pid }),
  home: mkdtempSync(join(tmpdir(), 'dsh-cursor-agent-')),
  log: (message) => console.log('  [daemon]', message),
})

try {
  await daemon.start()
  console.log('ready on', daemon.path)
  const candidates = [
    ['agent.v1.AiService', 'GetUsableModels'],
    ['agent.v1.AgentService', 'GetUsableModels'],
    ['agent.v1.ModelService', 'GetUsableModels'],
    ['agent.v1.AgentHostService', 'GetUsableModels'],
  ]
  for (const [service, method] of candidates) {
    try {
      const body = await daemon.call(service, method, {})
      const models = body?.models ?? []
      console.log(`OK ${service}/${method}: ${models.length} models`, JSON.stringify(models[0] ?? {}).slice(0, 220))
      break
    } catch (error) {
      console.log(`-- ${service}/${method}: ${error.status ?? ''} ${String(error.message).slice(0, 90)}`)
    }
  }
} catch (error) {
  console.log('FAILED:', error.message)
  console.log(daemon.stderr.join('').slice(-600))
} finally {
  await daemon.stop()
}
