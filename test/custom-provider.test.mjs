/**
 * Custom provider login tests — the pure field parsers/entry builder of the
 * hand-declared-route form, and the chained EditField flow that /login's
 * "Custom provider…" entry hosts (step advance, final-step commit, Esc
 * abandon). Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CUSTOM_PROVIDER_ID,
  CustomProviderFlow,
  SUPPORTED_PROTOCOLS,
  buildCustomEntry,
  customProviderEntry,
  parseCustomBaseUrl,
  parseCustomDisplayName,
  parseCustomModels,
  parseCustomProtocol,
  parseCustomProviderId,
} from '../lib/custom-provider.js'
import { providerProfileFor } from '../lib/provider-catalog.js'
import { githubLight } from '../lib/theme/palette.js'

// ------------------------------------------------------------ parsers --

test('parseCustomProviderId: lowercase slug, collision-checked', () => {
  const taken = new Set(['anthropic', 'openai'])
  assert.deepEqual(parseCustomProviderId('  Acme-Gateway  ', taken), { kind: 'value', value: 'acme-gateway' })
  assert.equal(parseCustomProviderId('anthropic', taken).kind, 'error')
  assert.equal(parseCustomProviderId('', taken).kind, 'error')
  assert.equal(parseCustomProviderId('a', taken).kind, 'error')
  assert.equal(parseCustomProviderId('has.dot', taken).kind, 'error')
  assert.equal(parseCustomProviderId('has space', taken).kind, 'error')
  assert.deepEqual(parseCustomProviderId('UPPER', taken), { kind: 'value', value: 'upper' }, 'uppercase is normalized, not rejected')
})

test('parseCustomDisplayName: optional, whitespace-folded, capped', () => {
  assert.deepEqual(parseCustomDisplayName('  Acme   Gateway  '), { kind: 'value', value: 'Acme Gateway' })
  assert.deepEqual(parseCustomDisplayName(''), { kind: 'value', value: '' })
  assert.equal(parseCustomDisplayName('x'.repeat(41)).kind, 'error')
})

test('parseCustomProtocol: empty defaults to openai-completions; membership enforced', () => {
  assert.deepEqual(parseCustomProtocol(''), { kind: 'value', value: 'openai-completions' })
  assert.deepEqual(parseCustomProtocol(' Anthropic-Messages '), { kind: 'value', value: 'anthropic-messages' })
  const bad = parseCustomProtocol('grpc')
  assert.equal(bad.kind, 'error')
  assert.ok(bad.error.includes(SUPPORTED_PROTOCOLS.join(', ')), 'error names the valid protocols')
})

test('parseCustomBaseUrl: http(s) URL required', () => {
  assert.deepEqual(parseCustomBaseUrl('https://gw.internal/v1'), { kind: 'value', value: 'https://gw.internal/v1' })
  assert.deepEqual(parseCustomBaseUrl('http://localhost:8080/v1'), { kind: 'value', value: 'http://localhost:8080/v1' })
  assert.equal(parseCustomBaseUrl('').kind, 'error')
  assert.equal(parseCustomBaseUrl('ftp://x').kind, 'error')
  assert.equal(parseCustomBaseUrl('https://a b').kind, 'error')
})

test('parseCustomModels: comma/whitespace split, de-duplicated, at least one', () => {
  assert.deepEqual(parseCustomModels('acme-large, acme-think  acme-large'), {
    kind: 'value',
    value: 'acme-large,acme-think',
  })
  assert.equal(parseCustomModels('   ').kind, 'error')
  assert.equal(parseCustomModels(',,,').kind, 'error')
})

// ------------------------------------------------------- entry building --

test('buildCustomEntry + providerProfileFor: the hand-declared profile shape upstream documents', () => {
  const entry = buildCustomEntry({
    id: 'acme-gateway',
    displayName: 'Acme Gateway',
    api: 'openai-completions',
    baseURL: 'https://gateway.acme.example/v1',
    models: 'acme-large,acme-think',
  })
  assert.equal(entry.catalogRoute, false)
  assert.deepEqual(
    providerProfileFor(entry),
    {
      apiKeyEnv: 'ACME_GATEWAY_API_KEY',
      displayName: 'Acme Gateway',
      api: 'openai-completions',
      baseURL: 'https://gateway.acme.example/v1',
      models: [{ id: 'acme-large' }, { id: 'acme-think' }],
    },
  )
})

test('buildCustomEntry without a display name omits it and shows the route id', () => {
  const entry = buildCustomEntry({
    id: 'acme-gateway', displayName: '', api: 'openai-completions',
    baseURL: 'https://x.example/v1', models: 'm1',
  })
  assert.equal(entry.name, 'acme-gateway')
  assert.equal(entry.displayName, undefined)
  assert.equal(providerProfileFor(entry).displayName, undefined)
})

test('customProviderEntry is the synthetic picker entry', () => {
  const entry = customProviderEntry()
  assert.equal(entry.id, CUSTOM_PROVIDER_ID)
  assert.equal(entry.catalogRoute, false)
})

// ----------------------------------------------------------- the flow --

/** Fake TUI for the EditField chain: requestRender capture only. */
function fakeTui() {
  return { requestRender() { /* captured elsewhere if needed */ } }
}

function makeFlow(overrides = {}) {
  const events = { commits: [], exits: 0, errors: [] }
  const flow = new CustomProviderFlow({
    tui: fakeTui(),
    theme: { palette: githubLight },
    takenIds: new Set(['anthropic']),
    onCommit: overrides.onCommit ?? (async () => undefined),
    onExit: () => { events.exits += 1 },
    onError: message => { events.errors.push(message) },
  })
  return { flow, events }
}

/** Flush the EditField commit chain (onCommit's .then advances the step). */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/** Type one field's value and press Enter, then let the commit chain run. */
async function typeAndSubmit(flow, text) {
  for (const ch of text) flow.handleInput(ch)
  flow.handleInput('\r')
  await flush()
}

test('CustomProviderFlow: six chained steps advance in order and commit the built entry', async () => {
  const { flow, events } = makeFlow()
  const titles = []
  const seenTitle = () => flow.render(80).map(l => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')

  titles.push(seenTitle())
  await typeAndSubmit(flow, 'acme-gateway') // 1 id
  titles.push(seenTitle())
  await typeAndSubmit(flow, 'Acme Gateway') // 2 display name
  await typeAndSubmit(flow, '') // 3 protocol → default
  await typeAndSubmit(flow, 'https://gateway.acme.example/v1') // 4 base URL
  await typeAndSubmit(flow, 'acme-large, acme-think') // 5 models

  assert.match(titles[0], /1\/6 · Provider id/, 'step 1 title')
  assert.match(titles[1], /2\/6 · Display name/, 'step 2 title after the id commits')
  assert.equal(events.exits, 0, 'no exit before the final step')

  // The masked key step commits for real.
  let committed
  const { flow: flow2, events: events2 } = makeFlow({
    onCommit: async (entry, key) => { committed = { entry, key }; return undefined },
  })
  await typeAndSubmit(flow2, 'acme-gateway')
  await typeAndSubmit(flow2, '')
  await typeAndSubmit(flow2, '')
  await typeAndSubmit(flow2, 'https://x.example/v1')
  await typeAndSubmit(flow2, 'm1, m2')
  await typeAndSubmit(flow2, 'sk-secret')
  assert.equal(events2.exits, 1, 'flow exits after the successful key commit')
  assert.equal(committed.entry.id, 'acme-gateway')
  assert.equal(committed.entry.api, 'openai-completions', 'empty protocol normalized to the default')
  assert.deepEqual(committed.entry.models, [{ id: 'm1' }, { id: 'm2' }])
  assert.equal(committed.key, 'sk-secret')
})

test('CustomProviderFlow: an invalid field value stays on its step with the inline error', async () => {
  const { flow, events } = makeFlow()
  await typeAndSubmit(flow, 'anthropic') // collides with the taken ids
  const text = flow.render(80).map(l => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  assert.match(text, /1\/6 · Provider id/, 'still on step 1')
  assert.match(text, /already exists/, 'inline ✘ error names the collision')
  assert.equal(events.exits, 0)
})

test('CustomProviderFlow: a failed final commit keeps the form open for an Enter retry', async () => {
  let attempts = 0
  const { flow, events } = makeFlow({
    onCommit: async () => {
      attempts += 1
      return attempts === 1 ? { error: 'API key not stored: boom' } : undefined
    },
  })
  await typeAndSubmit(flow, 'acme-gateway')
  await typeAndSubmit(flow, '')
  await typeAndSubmit(flow, '')
  await typeAndSubmit(flow, 'https://x.example/v1')
  await typeAndSubmit(flow, 'm1')
  await typeAndSubmit(flow, 'sk-1')
  assert.equal(attempts, 1)
  assert.equal(events.exits, 0, 'flow stays open after the failed commit')
  assert.match(flow.render(80).map(l => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n'), /API key not stored/)

  flow.handleInput('\r') // Enter retries the commit idempotently
  await flush()
  assert.equal(attempts, 2)
  assert.equal(events.exits, 1, 'retry succeeds → flow exits')
})

test('CustomProviderFlow: Esc at any step abandons the whole flow', async () => {
  const { flow, events } = makeFlow()
  await typeAndSubmit(flow, 'acme-gateway')
  flow.handleInput('\x1b') // Esc on step 2
  assert.equal(events.exits, 1, 'Esc pops the whole flow, not one step')
})
