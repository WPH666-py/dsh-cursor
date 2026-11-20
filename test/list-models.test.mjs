import assert from 'node:assert/strict'
import test from 'node:test'
import { parseModelList, listModelsPlan } from '../lib/cli/list-models.js'
import { mergeCliModels } from '../lib/catalog.js'

const OUTPUT = [
  'Available models',
  '',
  'auto - Auto (default)',
  'gpt-5.3-codex - Codex 5.3',
  'claude-opus-5-thinking-high - Claude Opus 5 1M Thinking',
  '- italic-row - Bulleted',
  'gpt-5.3-codex - Codex 5.3 (duplicate)',
  'garbage line without a dash',
].join(String.fromCharCode(10))

test('the CLI listing becomes ids, with auto mapped to the API id', () => {
  const models = parseModelList(OUTPUT)
  assert.deepEqual(models.map((m) => m.id), ['default', 'gpt-5.3-codex', 'claude-opus-5-thinking-high', 'italic-row'])
  assert.equal(models[0].name, 'Auto (default)')
  assert.equal(models[1].name, 'Codex 5.3', 'the first name wins over a duplicate')
})

test('Windows reaches the CLI through WSL, other platforms directly', () => {
  const win = listModelsPlan({ platform: 'win32', distro: 'dsh-cursor' })
  assert.equal(win.file, 'wsl.exe')
  assert.ok(win.args.includes('dsh-cursor'))
  assert.ok(win.args.includes('--list-models'))
  const mac = listModelsPlan({ platform: 'darwin', command: 'cursor-agent' })
  assert.deepEqual(mac, { file: 'cursor-agent', args: ['--list-models'] })
})

test('CLI ids borrow capability metadata from the on-disk catalog', () => {
  const offline = [
    { id: 'claude-opus-5-5-max', name: 'Opus max', description: 'deep', input: ['text', 'image'], maxMode: true, contextWindow: 300000, baseId: 'claude-opus-5-5' },
    { id: 'gpt-5.3-codex', name: 'Codex', description: '', input: ['text'], maxMode: false },
  ]
  const merged = mergeCliModels([
    { id: 'claude-opus-5-5-high', name: 'Opus high' },
    { id: 'gpt-5.3-codex', name: 'Codex 5.3' },
    { id: 'brand-new-model', name: 'Brand New' },
  ], offline)

  const opus = merged[0]
  assert.equal(opus.name, 'Opus high', 'the CLI name wins')
  assert.deepEqual(opus.input, ['text', 'image'], 'capabilities come from the base id')
  assert.equal(opus.contextWindow, 300000)
  assert.equal(opus.baseId, 'claude-opus-5-5')

  const unknown = merged[2]
  assert.equal(unknown.name, 'Brand New')
  assert.deepEqual(unknown.input, ['text'], 'an unknown id defaults to text only')
  assert.equal(unknown.contextWindow, undefined)
})
