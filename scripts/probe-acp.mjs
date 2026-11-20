/** End-to-end probe for the ACP path: initialize, open a session, run one turn. */
import { AcpClient } from '../lib/cli/acp.js'
import { createAcpAdapter } from '../lib/cli/acp-adapter.js'
import { spawnAcp } from '../lib/cli/spawn-acp.js'

const distro = process.env.WSL_DISTRO ?? 'Ubuntu'
const command = process.env.CURSOR_AGENT ?? 'cursor-agent'
const cwd = process.env.PROBE_CWD ?? '/tmp'
const model = process.env.MODEL ?? 'default'

const agent = spawnAcp({ distro, command, cwd })
agent.child.on('exit', (code) => console.log(`[agent] exited ${code}`))

const client = new AcpClient({
  input: agent.input,
  output: agent.output,
  onPermission: () => 'allow_once',
})

try {
  const init = await client.initialize()
  console.log('initialize:', JSON.stringify(init).slice(0, 200))
} catch (error) {
  console.log('initialize failed:', error.message)
  console.log('stderr:', agent.stderr())
  agent.kill()
  process.exit(1)
}

const adapter = createAcpAdapter({
  provider: 'cursor',
  getModels: () => [{ id: model, name: model, input: ['text'] }],
  connect: async () => {
    const session = await client.newSession({ cwd })
    console.log('session:', JSON.stringify(session).slice(0, 200))
    return { client, cwd }
  },
})

let text = ''
for await (const chunk of adapter.stream({
  provider: 'cursor',
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: BRIDGE OK' }] }],
})) {
  if (chunk.type === 'text-delta') {
    text += chunk.text
    process.stdout.write(chunk.text)
  }
  if (chunk.type === 'finish') console.log(`\nfinish: ${chunk.reason}`)
}
console.log('collected:', JSON.stringify(text))
agent.kill()
