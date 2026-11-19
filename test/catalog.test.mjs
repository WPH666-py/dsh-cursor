import assert from 'node:assert/strict'
import test from 'node:test'
import { applySelection, buildModels, buildModelsFromState, contextFromText } from '../lib/catalog.js'
import { slug, stripVariants } from '../lib/names.js'

const USABLE = [
  { modelId: 'default', displayName: 'Auto', maxMode: false, aliases: ['auto'] },
  { modelId: 'claude-opus-5-5-high', displayName: 'Claude Opus 5.5 High', maxMode: false },
  { modelId: 'claude-opus-5-5-high-fast', displayName: 'Claude Opus 5.5 High Fast', maxMode: false },
  { modelId: 'gpt-5.3-codex', displayName: 'Codex 5.3', maxMode: false },
  { modelId: 'gpt-5.3-codex', displayName: 'duplicate' },
]

const AVAILABLE = [
  {
    name: 'claude-opus-5-5',
    clientDisplayName: 'Claude Opus 5.5',
    supportsImages: true,
    supportsMaxMode: true,
    idAliases: ['opus'],
    tooltipData: { markdownContent: '**Claude Opus 5.5**<br />Deep reasoning. 200k context window' },
  },
  { name: 'gpt-5.3-codex', clientDisplayName: 'Codex 5.3', supportsImages: false, tooltipData: { markdownContent: '272k context window' } },
]

test('joins usable ids with capability metadata by base id', () => {
  const models = buildModels({ usable: USABLE, available: AVAILABLE })
  assert.equal(models.length, 4, 'duplicate ids collapse')
  const opus = models.find((model) => model.id === 'claude-opus-5-5-high')
  assert.equal(opus.name, 'Claude Opus 5.5 High')
  assert.deepEqual(opus.input, ['text', 'image'])
  assert.equal(opus.maxMode, true)
  assert.equal(opus.baseId, 'claude-opus-5-5')
  assert.equal(opus.contextWindow, 200_000)
  const codex = models.find((model) => model.id === 'gpt-5.3-codex')
  assert.deepEqual(codex.input, ['text'])
  assert.equal(codex.baseId, undefined)
})

test('variant suffixes strip in two passes only', () => {
  assert.equal(stripVariants('gpt-5.3-codex-high-fast'), 'gpt-5.3-codex')
  assert.equal(stripVariants('gpt-5.3-codex-max'), 'gpt-5.3-codex')
  assert.equal(stripVariants('deepseek-v41-flash-1017'), 'deepseek-v41-flash-1017')
  assert.equal(stripVariants('claude-opus-5-5'), 'claude-opus-5-5')
})

test('context windows come from the tooltip text', () => {
  assert.equal(contextFromText('272k context window'), 272_000)
  assert.equal(contextFromText('1m context window'), 1_000_000)
  assert.equal(contextFromText('no numbers here'), undefined)
})

test('selection supports base-only and a regular expression filter', () => {
  const models = buildModels({ usable: USABLE, available: AVAILABLE })
  assert.deepEqual(applySelection(models, { include: 'base', filter: '' }).map((m) => m.id), ['default', 'gpt-5.3-codex'])
  assert.deepEqual(applySelection(models, { include: 'all', filter: 'opus' }).map((m) => m.id), ['claude-opus-5-5-high', 'claude-opus-5-5-high-fast'])
  assert.equal(applySelection(models, { include: 'all', filter: '(' }).length, 4, 'an invalid pattern disables the filter')
})

test('Cursor state payload reproduces a usable list', () => {
  const { usable, available } = buildModelsFromState({
    availableDefaultModels2: [{ name: 'grok-4.7', clientDisplayName: 'Grok 4.7', supportsImages: true, supportsMaxMode: true, tooltipData: {} }],
  })
  const models = buildModels({ usable, available })
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 'grok-4.7')
  assert.deepEqual(models[0].input, ['text', 'image'])
})

test('slugs are filesystem safe', () => {
  assert.equal(slug('gpt-5.3-codex'), 'gpt-5-3-codex')
  assert.equal(slug('  '), 'model')
})