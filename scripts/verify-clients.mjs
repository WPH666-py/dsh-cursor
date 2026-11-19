/** Exercise the opt-in client merge/rollback paths against a temporary home. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearClientTargets, syncClientTargets } from '../lib/publish/clients.js'
import { resolveConfig } from '../lib/config.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-cursor-clients-'))
const claudeDir = join(root, 'claude')
const codexDir = join(root, 'codex')
mkdirSync(claudeDir, { recursive: true })
mkdirSync(codexDir, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = claudeDir
process.env.CODEX_HOME = codexDir

writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ env: { EXISTING: '1' }, permissions: { allow: ['Bash'] } }, null, 2))
writeFileSync(join(codexDir, 'config.toml'), 'theme = "dark"\n')

const config = resolveConfig({ targets: { claudeCode: { apply: true }, codex: { apply: true } }, bridge: { baseURL: 'http://127.0.0.1:8787/v1' } })
const log = { info: (message) => console.log('  info:', message), warn: (message) => console.log('  warn:', message) }
const catalog = {
  total: 3,
  models: [
    { id: 'claude-opus-5-5-max', name: 'Opus', input: ['text'] },
    { id: 'claude-sonnet-5-5-max', name: 'Sonnet', input: ['text'] },
    { id: 'claude-haiku-5-5-max', name: 'Haiku', input: ['text'] },
  ],
}

console.log('apply:')
syncClientTargets({ catalog, config, ctx: log })
const claude = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'))
console.log('  claude env:', JSON.stringify(claude.env))
console.log('  claude marker keys:', Object.keys(claude._dshCursor.envKeys))
console.log('  claude kept permissions:', JSON.stringify(claude.permissions))
const codex = readFileSync(join(codexDir, 'config.toml'), 'utf8')
console.log('  codex has block:', codex.includes('dsh-cursor managed block'), '| kept theme:', codex.includes('theme = "dark"'))
console.log('  backup exists:', readFileSync(join(codexDir, 'config.toml.dsh-cursor.bak'), 'utf8').includes('theme = "dark"'))

console.log('clear:')
clearClientTargets(config, log)
const claudeAfter = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'))
console.log('  claude env after:', JSON.stringify(claudeAfter.env), '| marker:', claudeAfter._dshCursor)
const codexAfter = readFileSync(join(codexDir, 'config.toml'), 'utf8').trimEnd()
console.log('  codex after:', JSON.stringify(codexAfter))

rmSync(root, { recursive: true, force: true })