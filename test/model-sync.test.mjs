/**
 * /model-sync (singular) — custom-provider model discovery + merge tests.
 *
 * Covers the pure core of src/model-sync.ts (selectCustomProviders /
 * sanitizeDiscoveredModel / mergeModels) and runModelSync's glue against a
 * faked settings provider (stub style, cf. theme-settings.test.mjs) and a
 * faked LlmRuntime.discoverModels seam. The write path asserts the exact
 * mutate op (path ['providers', id, 'models']), the revision-at-execution-time
 * contract, the single SettingsConflictError retry, and per-route failure
 * isolation. Runs against the built lib/ (pnpm build && pnpm test). No test
 * here touches the real ~/.dsh/settings.yaml — everything runs on in-memory
 * fakes.
 *
 * The tail section pins the /model-sync local-handler wiring in src/index.ts:
 * services are resolved through ctx.get(...) (a bare ctx.llm read throws
 * "cannot get property without inject" under cordis outside an inject scope)
 * and an absent LLM runtime degrades to an error card instead of crashing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, SettingsConflictError } from '@deepseek-ai/dsh-settings'
import {
  mergeModels,
  runModelSync,
  sanitizeDiscoveredModel,
  selectCustomProviders,
} from '../lib/model-sync.js'

const here = dirname(fileURLToPath(import.meta.url))
const SRC_INDEX = readFileSync(join(here, '../src/index.ts'), 'utf8')
const LIB_INDEX = readFileSync(join(here, '../lib/index.js'), 'utf8')

const NS = settingsNamespace('llm-pi-ai')

/**
 * In-memory fake of the settings-provider surface model-sync touches:
 * describe() descriptors plus a nested-path mutate with strict optimistic
 * concurrency (stale expectedRevision → SettingsConflictError), mirroring the
 * real provider's contract. Updates are applied immutably so each descriptor
 * value is a fresh object after every commit.
 */
function makeSettings({ base = {}, revision = 4 } = {}) {
  const descriptors = []
  const mutations = []
  const attempts = []
  let currentRevision = revision
  let armedConflicts = 0

  function setPath(value, path, replacement) {
    if (path.length === 0) return replacement
    const [head, ...rest] = path
    const source = typeof value === 'object' && value !== null ? value : {}
    const clone = Array.isArray(source) ? [...source] : { ...source }
    clone[head] = setPath(source[head], rest, replacement)
    return clone
  }

  return {
    mutations,
    attempts,
    descriptors,
    /** Register a namespace directly with a starting section value. */
    seed(ns, value) {
      descriptors.push({ ns, schema: undefined, value, revision: currentRevision, applies: 'defer' })
    },
    /** Simulate one concurrent writer winning before the next mutate. */
    bumpRevision() {
      currentRevision += 1
      // The document moved: every registered namespace reports the new revision.
      for (const d of descriptors) d.revision = currentRevision
    },
    /** Make the next mutate behave as if it lost exactly one race. */
    armConflict() {
      armedConflicts += 1
    },
    describe() {
      return descriptors
    },
    async mutate(ns, ops, expectedRevision) {
      const descriptor = descriptors.find(d => d.ns === ns)
      if (descriptor === undefined) throw new Error('namespace not registered')
      attempts.push({ ns, ops, expectedRevision })
      if (armedConflicts > 0) {
        armedConflicts -= 1
        this.bumpRevision()
        throw new SettingsConflictError(ns, expectedRevision ?? -1, currentRevision)
      }
      if (expectedRevision !== undefined && expectedRevision !== descriptor.revision) {
        throw new SettingsConflictError(ns, expectedRevision, descriptor.revision)
      }
      let value = descriptor.value
      for (const op of ops) {
        if (op.op === 'set') value = setPath(value, op.path, op.value)
        // `unset` is unused by model-sync; unsupported ops surface loudly.
        else throw new Error(`fake mutate: unsupported op ${op.op}`)
      }
      descriptor.value = value
      this.bumpRevision()
      descriptor.revision = currentRevision
      mutations.push({ ns, ops, expectedRevision })
    },
  }
}

/** Fake LlmRuntime narrowed to discoverModels, recording every request. */
function makeLlm(routes) {
  const calls = []
  return {
    calls,
    async discoverModels(settingsNs, request) {
      calls.push({ settingsNs, request })
      const route = routes[request.provider]
      if (route instanceof Error) throw route
      return route ?? []
    },
  }
}

test('mergeModels unions by id, preserves local overrides verbatim, skips duplicates', () => {
  const existing = [
    { id: 'local-a', reasoningEfforts: { high: 'reasoning' }, input: ['text'] },
    { id: 'z-local', name: 'Kept Name' },
  ]
  const discovered = [
    { id: 'remote-b', name: 'Remote B', contextWindow: 128000, maxTokens: 8192 },
    { id: 'local-a', contextWindow: 1 }, // duplicate of a local entry → skipped
    { id: 'remote-c' }, // no metadata at all → still appended (schema allows)
  ]
  const result = mergeModels(existing, discovered)
  assert.deepEqual(result.added, 2)
  assert.deepEqual(result.kept, 2)
  assert.deepEqual(result.skipped, 1)
  // Stored entries keep their positions; new ids are appended at the end.
  assert.deepEqual(result.models.map(m => m.id), ['local-a', 'z-local', 'remote-b', 'remote-c'])
  // Local overrides survive byte-for-byte; nothing is overwritten or deleted.
  assert.deepStrictEqual(result.models[0], existing[0])
  assert.deepStrictEqual(result.models[1], existing[1])
  // New entries carry only their sanitized metadata.
  assert.deepEqual(result.models[2], { id: 'remote-b', name: 'Remote B', contextWindow: 128000, maxTokens: 8192 })
  assert.deepEqual(result.models[3], { id: 'remote-c' })
})

test('sanitizeDiscoveredModel drops unusable rows and strips invalid fields', () => {
  assert.equal(sanitizeDiscoveredModel(undefined), undefined)
  assert.equal(sanitizeDiscoveredModel('gpt-4'), undefined)
  assert.equal(sanitizeDiscoveredModel({}), undefined, 'no id')
  assert.equal(sanitizeDiscoveredModel({ id: '   ' }), undefined, 'blank id')
  assert.equal(sanitizeDiscoveredModel({ id: 42 }), undefined, 'non-string id')
  // Valid minimal row.
  assert.deepEqual(sanitizeDiscoveredModel({ id: ' bare ' }), { id: 'bare' }, 'id trimmed')
  // Invalid capacities are stripped per field; the row itself survives.
  assert.deepEqual(
    sanitizeDiscoveredModel({ id: 'm', contextWindow: 0, maxTokens: 1.5, name: '' }),
    { id: 'm' },
    'zero / fractional / blank values dropped',
  )
  assert.deepEqual(
    sanitizeDiscoveredModel({ id: 'm', name: ' M ', contextWindow: 200000, maxTokens: 65536 }),
    { id: 'm', name: 'M', contextWindow: 200000, maxTokens: 65536 },
  )
})

test('selectCustomProviders keeps hand-declared baseURL routes, drops catalog routes, sorts by id', () => {
  const providers = {
    zeta: { baseURL: 'https://zeta.example/v1', api: 'openai-completions' },
    openai: { baseURL: 'https://spoofed.example/v1' }, // catalog key → excluded even with a baseURL
    alpha: { baseURL: 'https://alpha.example/v1' },
    noEndpoint: { displayName: 'No Endpoint' }, // no baseURL → not syncable
  }
  assert.deepEqual(selectCustomProviders(providers), [
    { id: 'alpha', baseURL: 'https://alpha.example/v1' },
    { id: 'zeta', baseURL: 'https://zeta.example/v1', api: 'openai-completions' },
  ])
  assert.deepEqual(selectCustomProviders(undefined), [])
  assert.deepEqual(selectCustomProviders({}), [])
})

test('runModelSync full round: discovery request shape, write op, report line', async () => {
  const settings = makeSettings()
  settings.seed(NS, {
    providers: {
      gw: {
        apiKeyEnv: 'GW_API_KEY',
        api: 'openai-completions',
        baseURL: 'https://gw.acme/v1',
        models: [{ id: 'old-model', reasoningEfforts: { high: 'reasoning_high' } }],
      },
      other: { baseURL: 'https://other.example/v1' },
      openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    },
  })
  const llm = makeLlm({
    gw: [
      { id: 'new-model', name: 'New Model', contextWindow: 128000, maxTokens: 8192 },
      { id: 'old-model' }, // already stored locally → skipped
    ],
    other: [],
  })
  const result = await runModelSync({ settings, llm })

  // Discovery hit ONLY the custom routes, with the official seam's arguments.
  assert.deepEqual(llm.calls.map(c => c.request.provider), ['gw', 'other'])
  assert.equal(llm.calls[0].settingsNs, NS)
  assert.deepEqual(llm.calls[0].request.baseURL, 'https://gw.acme/v1')
  assert.deepEqual(llm.calls[0].request.api, 'openai-completions')
  assert.equal('apiKey' in llm.calls[0].request, false, 'no credential is ever passed')

  // Only the route that gained models reaches mutate; `other` discovered
  // nothing new, so its stored array is never written.
  assert.equal(settings.mutations.length, 1)
  const [gwWrite] = settings.mutations
  assert.equal(gwWrite.ns, NS)
  assert.equal(gwWrite.expectedRevision, 4)
  assert.deepEqual(gwWrite.ops, [{
    op: 'set',
    path: ['providers', 'gw', 'models'],
    value: [
      { id: 'old-model', reasoningEfforts: { high: 'reasoning_high' } },
      { id: 'new-model', name: 'New Model', contextWindow: 128000, maxTokens: 8192 },
    ],
  }])

  // Stored document actually moved.
  assert.deepEqual(settings.descriptors[0].value.providers.gw.models, gwWrite.ops[0].value)
  // Catalog route untouched.
  assert.deepEqual(settings.descriptors[0].value.providers.openai, { apiKeyEnv: 'OPENAI_API_KEY' })

  assert.equal(result.kind, 'success')
  assert.equal(result.text, 'gw: added 1 · kept 1 · skipped 1\nother: added 0 · kept 0 · skipped 0')
})

test('runModelSync retries once on SettingsConflictError with the fresh revision', async () => {
  const settings = makeSettings({ revision: 4 })
  settings.seed(NS, { providers: { gw: { baseURL: 'https://gw.acme/v1', models: [] } } })
  const llm = makeLlm({ gw: [{ id: 'm1', contextWindow: 8 }] })
  settings.armConflict()

  const result = await runModelSync({ settings, llm })
  assert.equal(result.kind, 'success')
  assert.equal(result.text, 'gw: added 1 · kept 0 · skipped 0')
  assert.equal(settings.attempts.length, 2, 'first attempt lost the race, second landed')
  assert.equal(settings.mutations.length, 1, 'only the retry committed')
  assert.equal(settings.attempts[0].expectedRevision, 4, 'first attempt read revision 4')
  assert.equal(settings.attempts[1].expectedRevision, 5, 'retry re-read the bumped revision')
  assert.deepEqual(settings.descriptors[0].value.providers.gw.models, [{ id: 'm1', contextWindow: 8 }])
})

test('runModelSync isolates one route\'s discovery failure from the rest', async () => {
  const settings = makeSettings()
  settings.seed(NS, {
    providers: {
      bad: { baseURL: 'https://bad.example/v1', models: [] },
      good: { baseURL: 'https://good.example/v1', models: [] },
    },
  })
  const llm = makeLlm({ bad: new Error('could not reach https://bad.example/v1'), good: [{ id: 'ok' }] })
  const result = await runModelSync({ settings, llm })
  // Partial failure still reports success for the round; the failed line names the reason.
  assert.equal(result.kind, 'success')
  assert.equal(result.text, 'bad: could not reach https://bad.example/v1\ngood: added 1 · kept 0 · skipped 0')
  assert.deepEqual(settings.descriptors[0].value.providers.good.models, [{ id: 'ok' }])
  assert.equal(settings.mutations.length, 1, 'the failed route never reached mutate')
})

test('runModelSync reports error kind when every route fails', async () => {
  const settings = makeSettings()
  settings.seed(NS, { providers: { a: { baseURL: 'https://a/v1' }, b: { baseURL: 'https://b/v1' } } })
  const llm = makeLlm({ a: new Error('boom a'), b: new Error('boom b') })
  const result = await runModelSync({ settings, llm })
  assert.equal(result.kind, 'error')
  assert.equal(result.text, 'a: boom a\nb: boom b')
  assert.equal(settings.mutations.length, 0)
})

test('runModelSync rejects an unknown named provider without touching anything', async () => {
  const settings = makeSettings()
  settings.seed(NS, { providers: { gw: { baseURL: 'https://gw.acme/v1' } } })
  const llm = makeLlm({})
  const result = await runModelSync({ settings, llm }, { rawInput: 'ghost' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /not configured/)
  assert.deepEqual(llm.calls, [])
  assert.deepEqual(settings.mutations, [])
})

test('runModelSync rejects named catalog routes as out of scope', async () => {
  const settings = makeSettings()
  settings.seed(NS, { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } })
  const llm = makeLlm({})
  const result = await runModelSync({ settings, llm }, { rawInput: 'openai' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /built-in catalog route/)
  assert.deepEqual(llm.calls, [])
  assert.deepEqual(settings.mutations, [])
})

test('runModelSync says nothing to sync when only catalog routes are configured', async () => {
  const settings = makeSettings()
  settings.seed(NS, { providers: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } } })
  const llm = makeLlm({})
  const result = await runModelSync({ settings, llm })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /nothing to sync/i)
  assert.deepEqual(llm.calls, [])
  assert.deepEqual(settings.mutations, [])
})

test('runModelSync errors when the llm-pi-ai namespace is not registered', async () => {
  const settings = makeSettings()
  const llm = makeLlm({})
  const result = await runModelSync({ settings, llm })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /not registered/)
  assert.deepEqual(llm.calls, [])
})

test('runModelSync no-op round leaves stored models byte-identical with zero mutations', async () => {
  const stored = [
    { id: 'zulu', name: 'Zulu', reasoningEfforts: { high: 'reasoning_high' } },
    { id: 'alpha', contextWindow: 4096 },
    { displayName: 'id-less row stays too' },
  ]
  const settings = makeSettings()
  settings.seed(NS, { providers: { gw: { baseURL: 'https://gw.acme/v1', models: stored } } })
  // Discovery answers exactly the stored ids (in a different order) — nothing
  // new to add, so the round must be a true no-op.
  const llm = makeLlm({ gw: [{ id: 'alpha' }, { id: 'zulu', contextWindow: 1 }] })

  const result = await runModelSync({ settings, llm })
  assert.equal(result.kind, 'success')
  assert.equal(result.text, 'gw: added 0 · kept 3 · skipped 2')
  assert.equal(settings.mutations.length, 0, 'no-op sync performs zero mutate calls')
  assert.equal(settings.attempts.length, 0)
  // The fake applies every commit immutably (fresh object per mutate), so
  // reference identity proves the stored array was never rewritten.
  const after = settings.descriptors[0].value.providers.gw.models
  assert.strictEqual(after, stored)
  assert.equal(JSON.stringify(after), JSON.stringify([
    { id: 'zulu', name: 'Zulu', reasoningEfforts: { high: 'reasoning_high' } },
    { id: 'alpha', contextWindow: 4096 },
    { displayName: 'id-less row stays too' },
  ]))
})

test('mergeModels appends new ids at the end without reordering stored entries', () => {
  const existing = [
    { id: 'zulu', name: 'Kept Zulu' },
    { id: 'alpha', name: 'Kept Alpha' },
    { displayName: 'no id, left in place' },
  ]
  const result = mergeModels(existing, [
    { id: 'mike' },
    { id: 'bravo', contextWindow: 8 },
  ])
  assert.deepEqual(result.added, 2)
  assert.deepEqual(result.kept, 3)
  // Stored order verbatim (including the id-less row), then discovery order.
  assert.deepEqual(result.models.map(m => m.id ?? null), ['zulu', 'alpha', null, 'mike', 'bravo'])
  assert.deepStrictEqual(result.models[0], existing[0])
  assert.deepStrictEqual(result.models[1], existing[1])
  assert.deepStrictEqual(result.models[2], existing[2])
  assert.deepEqual(result.models[3], { id: 'mike' })
  assert.deepEqual(result.models[4], { id: 'bravo', contextWindow: 8 })
})

test('runModelSync names catalog routes accurately even when they carry a baseURL', async () => {
  // A catalog key with a hand-set baseURL: claiming "has no baseURL" would be
  // false — the message must identify it as a built-in catalog route.
  const spoofed = makeSettings()
  spoofed.seed(NS, { providers: { openai: { baseURL: 'https://spoofed.example/v1' } } })
  const spoofedLlm = makeLlm({})
  const spoofedResult = await runModelSync({ settings: spoofed, llm: spoofedLlm }, { rawInput: 'openai' })
  assert.equal(spoofedResult.kind, 'error')
  assert.match(spoofedResult.text, /built-in catalog route/)
  assert.doesNotMatch(spoofedResult.text, /no baseURL/)
  assert.deepEqual(spoofedLlm.calls, [])
  assert.deepEqual(spoofed.mutations, [])

  // A genuinely non-custom route (hand-declared key, no baseURL) keeps the
  // missing-baseURL message.
  const plain = makeSettings()
  plain.seed(NS, { providers: { relay: { displayName: 'Relay' } } })
  const plainLlm = makeLlm({})
  const plainResult = await runModelSync({ settings: plain, llm: plainLlm }, { rawInput: 'relay' })
  assert.equal(plainResult.kind, 'error')
  assert.match(plainResult.text, /no baseURL/)
  assert.doesNotMatch(plainResult.text, /built-in catalog route/)
  assert.deepEqual(plainLlm.calls, [])
  assert.deepEqual(plain.mutations, [])
})

// ---------------------------------------------------------------------------
// /model-sync local handler (src/index.ts wiring) — service-resolution
// contract. Regression: the handler read `ctx.llm` directly, which cordis
// rejects outside an inject scope ("cannot get property \"llm\" without
// inject") once the TUI fiber is live — every invocation failed before its
// own logic ran (found by tmux e2e at 4d69419). The fix resolves the service
// through ctx.get('llm') and degrades to an error card when the runtime is
// absent. The handler lives inside the plugin's runTui closure with no
// importable seam, so coverage is layered: (1) the cordis mechanism on a
// real context, (2) the real compiled handler executed against fakes, and
// (3) a source-level tripwire over src/ and lib/.
// ---------------------------------------------------------------------------

/** The /model-sync registration block: from the handler const to its registerLocal. */
function modelSyncHandlerBlock(source) {
  const start = source.indexOf('const modelSyncCustomHandler')
  assert.notEqual(start, -1, 'model-sync custom handler found in source')
  const end = source.indexOf("commands.registerLocal('model-sync'", start)
  assert.notEqual(end, -1, 'model-sync registerLocal found after the handler')
  return source.slice(start, end)
}

/**
 * The REAL compiled /model-sync handler from lib/index.js, evaluated with the
 * two closure names it captures (`ctx`, `runModelSync`) supplied by the test.
 * A regression to a bare `ctx.llm` read therefore fails loudly here: the fake
 * ctx exposes cordis-shaped getters that throw exactly like a live fiber.
 */
function compileModelSyncHandler(ctx, runModelSyncOverride) {
  const marker = 'const modelSyncCustomHandler = '
  const block = modelSyncHandlerBlock(LIB_INDEX)
  const start = block.indexOf(marker)
  assert.notEqual(start, -1, 'compiled handler expression found in lib/index.js')
  const expression = block.slice(start + marker.length).trim().replace(/;$/, '')
  return new Function('ctx', 'runModelSync', `return (${expression});`)(
    ctx,
    runModelSyncOverride ?? runModelSync,
  )
}

test('cordis rejects a bare ctx.llm read on a live fiber while ctx.get degrades to undefined', async () => {
  const root = new Context()
  const fiber = await root.plugin({ name: 'probe', apply() {} })
  assert.throws(
    () => fiber.ctx.llm,
    /cannot get property "llm" without inject/,
    'the exact failure the fix removes: bare property access outside an inject scope',
  )
  assert.equal(
    fiber.ctx.get('llm'),
    undefined,
    'ctx.get is the safe seam — the absent-service guard branch is genuinely reachable',
  )
})

test('/model-sync handler resolves llm via ctx.get and degrades when the runtime is absent', async () => {
  const settings = { describe() { return [] } }
  const gets = []
  const ctx = {
    get(name) {
      gets.push(name)
      return name === 'settings' ? settings : undefined
    },
    // Cordis-shaped tripwire: reading this property instead of calling
    // ctx.get('llm') throws exactly like a live fiber outside inject.
    get llm() { throw new Error('cannot get property "llm" without inject') },
  }
  const runModelSyncCalls = []
  const handler = compileModelSyncHandler(ctx, deps => {
    runModelSyncCalls.push(deps)
    return { kind: 'success', text: 'unreachable' }
  })

  const result = await handler('', undefined)
  assert.deepEqual(gets, ['settings', 'llm'], 'services resolved through ctx.get, settings first')
  assert.deepEqual(result, { kind: 'error', text: 'LLM runtime is unavailable.' })
  assert.deepEqual(runModelSyncCalls, [], 'the sync never runs without the LLM runtime')
})

test('/model-sync handler forwards settings + llm to runModelSync when both services exist', async () => {
  const settings = { describe() { return [] } }
  const llm = { async discoverModels() { return [] } }
  const calls = []
  const ctx = {
    get: name => (name === 'settings' ? settings : name === 'llm' ? llm : undefined),
  }
  const sentinel = { kind: 'success', text: 'gw: added 1 · kept 0 · skipped 0' }
  const handler = compileModelSyncHandler(ctx, (deps, opts) => {
    calls.push({ deps, opts })
    return sentinel
  })

  const signal = new AbortController().signal
  const result = await handler('gw', signal)
  assert.equal(result, sentinel, "the handler returns runModelSync's result verbatim")
  assert.equal(calls.length, 1)
  assert.strictEqual(calls[0].deps.settings, settings)
  assert.strictEqual(calls[0].deps.llm, llm)
  assert.equal(calls[0].opts.rawInput, 'gw')
  assert.strictEqual(calls[0].opts.signal, signal)
})

test('model-sync registration block pins ctx.get resolution and bans the bare property read', () => {
  for (const [label, source] of [['src/index.ts', SRC_INDEX], ['lib/index.js', LIB_INDEX]]) {
    const block = modelSyncHandlerBlock(source)
    assert.ok(block.includes("ctx.get('settings')"), `${label}: settings resolved via ctx.get`)
    assert.ok(block.includes("ctx.get('llm')"), `${label}: llm resolved via ctx.get`)
    assert.ok(block.includes("'LLM runtime is unavailable.'"), `${label}: graceful degradation guard present`)
    assert.doesNotMatch(block, /ctx\s*\.\s*llm\b/, `${label}: no bare ctx.llm property access`)
  }
})
