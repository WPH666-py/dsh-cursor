import assert from 'node:assert/strict'
import test from 'node:test'
import { bestVariant, pickClaudeSlots, renderClaudeCode, bridgeUrl } from '../lib/publish/artifacts.js'
import { spliceBlock } from '../lib/publish/clients.js'
import { renderCodexConfig, tomlString } from '../lib/toml.js'
import { resolveConfig } from '../lib/config.js'

const MODELS = [
  { id: 'default', name: 'Auto', input: ['text', 'image'] },
  { id: 'claude-opus-5-5-low', name: 'Opus low', input: ['text'], baseId: 'claude-opus-5-5' },
  { id: 'claude-opus-5-5-max', name: 'Opus max', input: ['text'], baseId: 'claude-opus-5-5' },
  { id: 'claude-opus-5-5-max-fast', name: 'Opus max fast', input: ['text'], baseId: 'claude-opus-5-5' },
  { id: 'claude-sonnet-5-5-high', name: 'Sonnet high', input: ['text'], baseId: 'claude-sonnet-5-5' },
  { id: 'claude-haiku-5-5-low', name: 'Haiku low', input: ['text'], baseId: 'claude-haiku-5-5' },
]

test('the strongest non-fast variant fills a Claude Code slot', () => {
  assert.equal(bestVariant(MODELS, /opus/i), 'claude-opus-5-5-max')
  const slots = pickClaudeSlots(MODELS)
  assert.deepEqual(slots, {
    opus: 'claude-opus-5-5-max',
    sonnet: 'claude-sonnet-5-5-high',
    haiku: 'claude-haiku-5-5-low',
  })
})

test('an explicit slot override wins', () => {
  assert.equal(pickClaudeSlots(MODELS, { opus: 'claude-opus-5-5-low' }).opus, 'claude-opus-5-5-low')
})

test('Claude Code env only carries slots and a bridge that exist', () => {
  const config = resolveConfig({ bridge: { baseURL: 'http://127.0.0.1:8787/v1/' } })
  const rendered = renderClaudeCode({ models: MODELS, total: MODELS.length }, config)
  assert.equal(rendered.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787/v1')
  assert.equal(rendered.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5-5-max')
  assert.equal(bridgeUrl(config), 'http://127.0.0.1:8787/v1')
  const withoutBridge = renderClaudeCode({ models: MODELS, total: MODELS.length }, resolveConfig({}))
  assert.deepEqual(Object.keys(withoutBridge.env).sort(), [
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
  ])
})

test('Codex config quotes keys and caps the profile count', () => {
  const toml = renderCodexConfig({
    providerId: 'cursor',
    name: 'Cursor',
    baseURL: 'http://127.0.0.1:8787/v1',
    wireApi: 'chat',
    envKey: 'CURSOR_BRIDGE_API_KEY',
    models: MODELS,
    maxProfiles: 2,
    slug: (id) => id.replace(/[^a-z0-9]+/gi, '-'),
  })
  assert.match(toml, /\[model_providers\.cursor\]/)
  assert.equal((toml.match(/\[profiles\./g) ?? []).length, 2)
  assert.match(toml, /model = "default"/)
  assert.equal(tomlString('a"b'), '"a\\"b"')
})

test('the managed TOML block is appended once and replaced in place', () => {
  const block = '# >>> dsh-cursor managed block — regenerated on every import; do not edit\nmodel = "a"\n# <<< dsh-cursor managed block\n'
  const once = spliceBlock('', block)
  assert.equal(once, block)
  const appended = spliceBlock('theme = "dark"\n', block)
  assert.match(appended, /^theme = "dark"\n\n# >>>/)
  const replaced = spliceBlock(appended, '# >>> dsh-cursor managed block\nmodel = "b"\n# <<< dsh-cursor managed block\n')
  assert.match(replaced, /model = "b"/)
  assert.equal((replaced.match(/dsh-cursor managed block/g) ?? []).length, 2)
  assert.match(replaced, /^theme = "dark"/)
})

test('removing the block leaves the rest of the file intact', () => {
  const block = '# >>> dsh-cursor managed block\nmodel = "a"\n# <<< dsh-cursor managed block\n'
  const stripped = spliceBlock(`theme = "dark"\n\n${block}`, '')
  assert.equal(stripped.trimEnd(), 'theme = "dark"')
})