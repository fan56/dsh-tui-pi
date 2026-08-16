/**
 * Provider-catalog module tests — pure data and pure functions, no TTY needed.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDER_CATALOG,
  catalogEntry,
  deriveKeyRef,
  directoryProviderEntries,
  providerProfileFor,
  providerRowView,
  unconfiguredCatalogEntries,
} from '../lib/provider-catalog.js'

/** Route keys must stay usable as settings dict keys AND credential stems. */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
/** A derived key ref must be a POSIX shell identifier. */
const POSIX_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

test('PROVIDER_CATALOG entries are unique, sorted, and route-valid', () => {
  const ids = PROVIDER_CATALOG.map(entry => entry.id)
  assert.equal(new Set(ids).size, ids.length, 'route keys must be unique')
  const names = PROVIDER_CATALOG.map(entry => entry.name)
  assert.deepEqual(names, [...names].sort(), 'directory is sorted by display name')
  for (const entry of PROVIDER_CATALOG) {
    assert.match(entry.id, ROUTE_PATTERN, `${entry.id} must be a usable route key`)
    assert.ok(entry.name.length > 0)
    assert.ok(entry.hint.length > 0)
  }
})

test('every catalog route derives a POSIX credential reference', () => {
  for (const entry of PROVIDER_CATALOG) {
    const ref = deriveKeyRef(entry.id)
    assert.match(ref, POSIX_IDENTIFIER, `${entry.id} derives ${ref}`)
    assert.ok(ref.endsWith('_API_KEY'))
  }
})

test('deriveKeyRef follows the web Models page convention', () => {
  assert.equal(deriveKeyRef('anthropic'), 'ANTHROPIC_API_KEY')
  assert.equal(deriveKeyRef('opencode-go'), 'OPENCODE_GO_API_KEY')
  assert.equal(deriveKeyRef('minimax-cn'), 'MINIMAX_CN_API_KEY')
  assert.equal(deriveKeyRef('openai'), 'OPENAI_API_KEY')
})

test('catalogEntry finds known routes and rejects unknown ones', () => {
  assert.equal(catalogEntry('openai')?.name, 'OpenAI')
  assert.equal(catalogEntry('opencode-go')?.hint.includes('gateway'), true)
  assert.equal(catalogEntry('zai-coding-cn')?.name, 'Z.AI Coding CN')
  assert.equal(catalogEntry('acme-gateway'), undefined)
})

test('unconfiguredCatalogEntries filters the configured set, preserving order', () => {
  const all = unconfiguredCatalogEntries(new Set())
  assert.equal(all.length, PROVIDER_CATALOG.length)
  const rest = unconfiguredCatalogEntries(new Set(['openai', 'anthropic', 'opencode-go']))
  assert.ok(!rest.some(entry => ['openai', 'anthropic', 'opencode-go'].includes(entry.id)))
  assert.equal(rest.length, PROVIDER_CATALOG.length - 3)
  assert.deepEqual(rest.map(entry => entry.name), [...rest.map(entry => entry.name)].sort())
})

test('directoryProviderEntries maps known routes to static names/hints', () => {
  const entries = directoryProviderEntries([{ provider: 'anthropic' }], new Set())
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0], {
    id: 'anthropic',
    name: 'Anthropic',
    hint: 'API key',
    catalogRoute: true,
  })
})

test('directoryProviderEntries falls back to the route key for unknown routes', () => {
  const entries = directoryProviderEntries([{ provider: 'acme-gateway' }], new Set())
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0], {
    id: 'acme-gateway',
    name: 'acme-gateway',
    hint: 'API key',
    catalogRoute: true,
  })
})

test('directoryProviderEntries filters out configured routes', () => {
  const entries = directoryProviderEntries(
    [{ provider: 'anthropic' }, { provider: 'openai' }, { provider: 'groq' }],
    new Set(['openai']),
  )
  assert.deepEqual(entries.map(entry => entry.id), ['anthropic', 'groq'])
})

test('directoryProviderEntries excludes declared: true entries', () => {
  const entries = directoryProviderEntries(
    [{ provider: 'anthropic' }, { provider: 'openai', declared: true }, { provider: 'groq' }],
    new Set(),
  )
  assert.deepEqual(entries.map(entry => entry.id), ['anthropic', 'groq'])
})

test('directoryProviderEntries preserves directory order', () => {
  const entries = directoryProviderEntries(
    [{ provider: 'zai' }, { provider: 'anthropic' }, { provider: 'minimax' }],
    new Set(),
  )
  assert.deepEqual(entries.map(entry => entry.id), ['zai', 'anthropic', 'minimax'])
})

test('directoryProviderEntries returns an empty list for an empty directory', () => {
  assert.deepEqual(directoryProviderEntries([], new Set()), [])
})

test('providerProfileFor on a catalog route stores only the derived ref', () => {
  const profile = providerProfileFor(catalogEntry('opencode-go'))
  assert.deepEqual(profile, { apiKeyEnv: 'OPENCODE_GO_API_KEY' })
  // The real user configuration keeps exactly this shape: the endpoint and
  // model catalog come from the installed pi-ai catalog, never settings.yaml.
})

test('providerProfileFor on a hand-declared route carries api/baseURL/models', () => {
  const gateway = {
    id: 'acme-gateway',
    name: 'Acme Gateway',
    hint: 'API key',
    catalogRoute: false,
    api: 'openai-completions',
    baseURL: 'https://gateway.acme.example/v1',
    models: [
      { id: 'acme-large', name: 'Acme Large' },
      { id: 'acme-think' },
    ],
  }
  assert.deepEqual(providerProfileFor(gateway), {
    apiKeyEnv: 'ACME_GATEWAY_API_KEY',
    api: 'openai-completions',
    baseURL: 'https://gateway.acme.example/v1',
    models: [
      { id: 'acme-large', name: 'Acme Large' },
      { id: 'acme-think' },
    ],
  })
})

test('providerRowView picks displayName over catalog name over route key', () => {
  const entry = catalogEntry('openai')
  assert.equal(
    providerRowView('openai', entry, { displayName: 'My Gateway' }, {}).label,
    'My Gateway',
  )
  assert.equal(providerRowView('openai', entry, undefined, {}).label, 'OpenAI')
  assert.equal(providerRowView('zai-coding-cn', undefined, undefined, {}).label, 'zai-coding-cn')
  // An empty displayName falls through to the catalog name.
  assert.equal(providerRowView('openai', entry, { displayName: '' }, {}).label, 'OpenAI')
})

test('providerRowView summarizes the stored model list', () => {
  const entry = catalogEntry('opencode-go')
  assert.equal(
    providerRowView('opencode-go', entry, { models: [{ id: 'deepseek-v4-flash' }] }, {}).summary,
    'deepseek-v4-flash',
  )
  const many = providerRowView('x', undefined, { models: [{ id: 'a' }, { id: 'b' }] }, {})
  assert.equal(many.summary, 'a')
  // Hand-declared route with an explicit empty list: a real zero, not the
  // catalog case (the route owns its models and declared none).
  assert.equal(providerRowView('x', undefined, { models: [] }, {}).summary, '0 models')
  // A model entry without an id falls back to the count (singular form).
  assert.equal(providerRowView('x', undefined, { models: [{ name: 'Anon' }] }, {}).summary, '1 model')
  assert.equal(
    providerRowView('x', undefined, { models: [{ name: 'A' }, { name: 'B' }] }, {}).summary,
    '2 models',
  )
})

test('providerRowView reports catalog-served routes without an explicit list', () => {
  const entry = catalogEntry('opencode-go')
  // No models in the profile: the installed catalog serves them.
  assert.equal(providerRowView('opencode-go', entry, { apiKeyEnv: 'OPENCODE_GO_API_KEY' }, {}).summary, 'catalog')
  // The runtime-resolved profile shape: schemastery's implicit array default
  // fills `models: []` — still the catalog case, never `0 models`.
  assert.equal(
    providerRowView('opencode-go', entry, { apiKeyEnv: 'OPENCODE_GO_API_KEY', models: [] }, {}).summary,
    'catalog',
  )
  // A hand-declared route with no models has nothing to serve.
  assert.equal(providerRowView('acme', undefined, {}, {}).summary, '0 models')
  // Non-object profiles are treated as absent.
  assert.equal(providerRowView('x', undefined, 'junk', {}).summary, '0 models')
})

test('providerRowView reports the API-key state from the supplied environment', () => {
  const env = { OPENCODE_GO_API_KEY: 'sk-test' }
  const profile = { apiKeyEnv: 'OPENCODE_GO_API_KEY' }
  assert.equal(providerRowView('opencode-go', undefined, profile, env).status, 'API key set')
  assert.equal(providerRowView('opencode-go', undefined, profile, {}).status, 'API key missing')
  assert.equal(providerRowView('opencode-go', undefined, {}, env).status, 'API key not configured')
  // An empty ref counts as no key address.
  assert.equal(providerRowView('x', undefined, { apiKeyEnv: '' }, env).status, 'API key not configured')
  // An empty-string env value is not a usable key (truthy presence check).
  assert.equal(providerRowView('opencode-go', undefined, profile, { OPENCODE_GO_API_KEY: '' }).status, 'API key missing')
  // A stored key (credentials document) reads as set through the merged env.
  assert.equal(
    providerRowView('opencode-go', undefined, profile, { ...env, OPENCODE_GO_API_KEY: 'stored' }).status,
    'API key set',
  )
})
