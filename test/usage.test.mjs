/**
 * Usage-memory tests: `$DSH_HOME/tui-command-usage.json` storage
 * (src/usage.ts) + frequency-sorted slash completions (src/skills.ts,
 * src/commands.ts).
 *
 * Contract under test:
 * - The store never throws on read: missing / corrupt / wrong-version /
 *   malformed files degrade to an empty table; good entries survive beside
 *   bad ones.
 * - Writes are atomic and best-effort: success leaves no tmp sibling, a
 *   failing write reports false instead of throwing.
 * - The tracker persists across instances (restart / reload semantics),
 *   prunes beyond the cap (lowest count first, oldest lastUsed breaking
 *   ties) and always exposes a plain name → count snapshot.
 * - Completion ordering: most-used first, native name as tie-break, stable
 *   and non-mutating; an empty table degenerates to the historical pure
 *   name order; filtering runs BEFORE sorting so a filtered subset keeps
 *   its frequency-first order.
 * - CommandService records successful command executions and genuine
 *   `/skill` fall-through gestures — and nothing else.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  CommandUsageTracker,
  MAX_USAGE_ENTRIES,
  USAGE_FILE_VERSION,
  commandUsagePath,
  loadUsageEntries,
  pruneUsageEntries,
  saveUsageEntries,
} from '../lib/usage.js'
import { completionName, mergeMixedSkillItems, sortCompletionItems } from '../lib/skills.js'
import { CommandService } from '../lib/commands.js'

// ------------------------------------------------------------------ helpers --

/** Fresh isolated directory per test; caller cleans up via the returned fn. */
function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-usage-test-'))
  return { dir, path: join(dir, 'tui-command-usage.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Minimal AutocompleteItem builder (value carries the leading slash). */
function item(value, kind = 'command') {
  return { value, label: value, description: '', kind }
}

// ------------------------------------------------------------ store: loading --

test('loadUsageEntries returns an empty table when the file does not exist', () => {
  const t = tempHome()
  try {
    const entries = loadUsageEntries(t.path)
    assert.equal(entries.size, 0)
  } finally {
    t.cleanup()
  }
})

test('loadUsageEntries degrades to empty on corrupt JSON and non-object roots', () => {
  const t = tempHome()
  try {
    for (const body of ['not json{', '""', '[1,2]', 'null', '"a string"', '42']) {
      writeFileSync(t.path, body)
      assert.equal(loadUsageEntries(t.path).size, 0, `body: ${body}`)
    }
  } finally {
    t.cleanup()
  }
})

test('loadUsageEntries rejects unknown versions and malformed counts', () => {
  const t = tempHome()
  try {
    writeFileSync(t.path, JSON.stringify({ version: USAGE_FILE_VERSION + 1, counts: { model: { count: 2, lastUsed: 1 } } }))
    assert.equal(loadUsageEntries(t.path).size, 0)
    writeFileSync(t.path, JSON.stringify({ version: USAGE_FILE_VERSION, counts: 'nope' }))
    assert.equal(loadUsageEntries(t.path).size, 0)
    writeFileSync(t.path, JSON.stringify({ version: USAGE_FILE_VERSION }))
    assert.equal(loadUsageEntries(t.path).size, 0)
  } finally {
    t.cleanup()
  }
})

test('loadUsageEntries skips bad entries and keeps valid siblings', () => {
  const t = tempHome()
  try {
    writeFileSync(t.path, JSON.stringify({
      version: USAGE_FILE_VERSION,
      counts: {
        good: { count: 3, lastUsed: 100 },
        zero: { count: 0, lastUsed: 100 },
        negative: { count: -1 },
        fractional: { count: 1.5 },
        stringCount: { count: '5' },
        nullEntry: null,
        noLastUsed: { count: 2 },
      },
    }))
    const entries = loadUsageEntries(t.path)
    assert.deepEqual([...entries.keys()].sort(), ['good', 'noLastUsed'])
    assert.deepEqual(entries.get('noLastUsed'), { count: 2, lastUsed: 0 })
    assert.deepEqual(entries.get('good'), { count: 3, lastUsed: 100 })
  } finally {
    t.cleanup()
  }
})

test('loadUsageEntries strips a leading slash from keys', () => {
  const t = tempHome()
  try {
    writeFileSync(t.path, JSON.stringify({ version: 1, counts: { '/model': { count: 4, lastUsed: 9 }, '': { count: 1 } } }))
    const entries = loadUsageEntries(t.path)
    assert.deepEqual([...entries.entries()], [['model', { count: 4, lastUsed: 9 }]])
  } finally {
    t.cleanup()
  }
})

// ------------------------------------------------------------- store: saving --

test('saveUsageEntries round-trips through loadUsageEntries', () => {
  const t = tempHome()
  try {
    const entries = new Map([
      ['model', { count: 7, lastUsed: 111 }],
      ['data-analysis', { count: 2, lastUsed: 222 }],
    ])
    assert.equal(saveUsageEntries(t.path, entries), true)
    assert.equal(loadUsageEntries(t.path).size, 2)
    assert.deepEqual(loadUsageEntries(t.path).get('model'), { count: 7, lastUsed: 111 })

    const doc = JSON.parse(readFileSync(t.path, 'utf8'))
    assert.equal(doc.version, USAGE_FILE_VERSION)
    assert.deepEqual(Object.keys(doc.counts).sort(), ['data-analysis', 'model'])
  } finally {
    t.cleanup()
  }
})

test('saveUsageEntries leaves no tmp sibling behind on success', () => {
  const t = tempHome()
  try {
    saveUsageEntries(t.path, new Map([['model', { count: 1, lastUsed: 1 }]]))
    assert.deepEqual(readdirSync(t.dir), ['tui-command-usage.json'])
  } finally {
    t.cleanup()
  }
})

test('saveUsageEntries creates a missing target directory before writing', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-tui-usage-mkdir-'))
  try {
    const nested = join(base, 'fresh-dsh-home', 'nested')
    const target = join(nested, 'usage.json')
    assert.equal(saveUsageEntries(target, new Map([['model', { count: 1, lastUsed: 5 }]])), true)
    assert.deepEqual(loadUsageEntries(target).get('model'), { count: 1, lastUsed: 5 })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('saveUsageEntries fails silently (returns false) when a parent path is a file', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-tui-usage-fail-'))
  try {
    // mkdir -p cannot win here: `blocker` is a regular file, so the target
    // directory can never exist — containment must still hold.
    const blocker = join(base, 'blocker')
    writeFileSync(blocker, 'a file, not a directory')
    const ok = saveUsageEntries(join(blocker, 'usage.json'), new Map())
    assert.equal(ok, false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------- pruning --

test('pruneUsageEntries evicts lowest counts first, oldest lastUsed within a tier', () => {
  const entries = new Map([
    // Two candidates share the minimum count 1: the older lastUsed goes first.
    ['old-min', { count: 1, lastUsed: 10 }],
    ['new-min', { count: 1, lastUsed: 99 }],
    ['mid', { count: 5, lastUsed: 50 }],
    ['top', { count: 9, lastUsed: 40 }],
  ])
  pruneUsageEntries(entries, 3)
  assert.deepEqual([...entries.keys()].sort(), ['mid', 'new-min', 'top'])
  pruneUsageEntries(entries, 3)
  assert.equal(entries.size, 3) // at/below cap: no-op
})

// ------------------------------------------------------------------- tracker --

test('tracker record increments, sets injected time, and persists for the next instance', () => {
  const t = tempHome()
  try {
    let clock = 1000
    const tracker = new CommandUsageTracker(t.path, { now: () => ++clock })
    tracker.record('/model')
    tracker.record('model')
    tracker.record('skills')
    assert.deepEqual(tracker.snapshot(), new Map([['model', 2], ['skills', 1]]))

    // A fresh tracker (restart / post-/reload fiber) re-reads the disk copy.
    const reborn = new CommandUsageTracker(t.path)
    assert.deepEqual(reborn.snapshot(), new Map([['model', 2], ['skills', 1]]))
    const stored = loadUsageEntries(t.path)
    assert.equal(stored.get('model').lastUsed, 1002)
  } finally {
    t.cleanup()
  }
})

test('tracker ignores empty and bare-slash names', () => {
  const t = tempHome()
  try {
    const tracker = new CommandUsageTracker(t.path)
    tracker.record('')
    tracker.record('/')
    tracker.record('//')
    assert.equal(tracker.snapshot().size, 0)
  } finally {
    t.cleanup()
  }
})

test("interleaved trackers on one file keep both fibers' increments (baseline+delta merge)", () => {
  const t = tempHome()
  try {
    // Two dsh processes sharing $DSH_HOME: neither may clobber the other's
    // table with its own in-memory view.
    const a = new CommandUsageTracker(t.path, { now: () => 100 })
    const b = new CommandUsageTracker(t.path, { now: () => 200 })

    a.record('model') // A flushes {model:1}
    b.record('model') // B re-reads A's write, folds its own +1 → {model:2}
    b.record('skills') // B → {model:2, skills:1}
    a.record('model') // A re-reads B's table, adds only its unsaved delta

    const final = loadUsageEntries(t.path)
    assert.equal(final.get('model').count, 3, 'A×2 + B×1 all survive')
    assert.equal(final.get('skills').count, 1, "B's increment survives A's later write")

    // Each fiber resynced to the merged table after its last successful write.
    assert.deepEqual(a.snapshot(), new Map([['model', 3], ['skills', 1]]))
    assert.deepEqual(b.snapshot(), new Map([['model', 2], ['skills', 1]]))

    // And B keeps writing on top of A's table — no whole-file clobber either way.
    b.record('skills')
    const after = loadUsageEntries(t.path)
    assert.equal(after.get('skills').count, 2)
    assert.equal(after.get('model').count, 3)
  } finally {
    t.cleanup()
  }
})

test('tracker prunes on record: cap holds and the freshly recorded entry survives', () => {
  const t = tempHome()
  try {
    const tracker = new CommandUsageTracker(t.path, { maxEntries: 3, now: () => 1 })
    tracker.record('a')
    tracker.record('b')
    tracker.record('c')
    tracker.record('d') // all count 1 → oldest lastUsed ('a') evicted
    const snap = tracker.snapshot()
    assert.equal(snap.size, 3)
    assert.equal(snap.has('a'), false)
    assert.equal(snap.has('d'), true)

    // A high-count entry outlives many low-count newcomers.
    const hot = new CommandUsageTracker(t.path, { maxEntries: 3 })
    hot.record('hot')
    for (const name of ['x1', 'x2']) hot.record(name)
    assert.equal(hot.snapshot().has('hot'), true)
  } finally {
    t.cleanup()
  }
})

test('tracker constructor normalizes a hand-edited oversized file down to the cap', () => {
  const t = tempHome()
  try {
    const counts = {}
    for (let i = 0; i < 6; i++) counts[`n${i}`] = { count: i + 1, lastUsed: i }
    writeFileSync(t.path, JSON.stringify({ version: 1, counts }))
    const tracker = new CommandUsageTracker(t.path, { maxEntries: 2 })
    assert.deepEqual([...tracker.snapshot().entries()], [['n4', 5], ['n5', 6]])
  } finally {
    t.cleanup()
  }
})

test('commandUsagePath joins $DSH_HOME-style homes and defaults are sane', () => {
  assert.equal(commandUsagePath('/tmp/dsh'), join('/tmp/dsh', 'tui-command-usage.json'))
  assert.equal(typeof MAX_USAGE_ENTRIES, 'number')
  assert.ok(MAX_USAGE_ENTRIES >= 1)
})

// ------------------------------------------------------- completion ordering --

const NAME_USAGE = new Map([['model', 5], ['data-analysis', 3], ['lark-base', 3]])

test('sortCompletionItems without usage degenerates to the historical name order', () => {
  const mixed = [item('/model'), item('/data-analysis', 'native-skill'), item('/agents')]
  const sorted = sortCompletionItems(mixed)
  assert.deepEqual(sorted.map(s => completionName(s)), ['agents', 'data-analysis', 'model'])
  assert.deepEqual(sorted.map(s => s.value), ['/agents', '/data-analysis', '/model'])
})

test('sortCompletionItems ranks by count desc, ties broken by name asc', () => {
  const mixed = [
    item('/agents'), // unused → sinks below every counted row
    item('/lark-base', 'native-skill'),
    item('/model'),
    item('/data-analysis', 'native-skill'),
  ]
  const sorted = sortCompletionItems(mixed, NAME_USAGE)
  assert.deepEqual(
    sorted.map(s => completionName(s)),
    ['model', 'data-analysis', 'lark-base', 'agents'],
  )
})

test('sortCompletionItems stays stable and never mutates its input under usage', () => {
  const b1 = item('/b')
  const a = item('/a')
  const b2 = item('/b')
  const mixed = [b1, a, b2]
  const usage = new Map([['a', 1], ['b', 1]]) // same count → name order; duplicate b → input order
  const sorted = sortCompletionItems(mixed, usage)
  assert.deepEqual(sorted.map(s => s.value), ['/a', '/b', '/b'])
  assert.equal(sorted[1], b1, 'first /b in input order stays ahead of the duplicate')
  assert.equal(sorted[2], b2)
  assert.deepEqual(mixed.map(s => s.value), ['/b', '/a', '/b']) // input untouched
})

test('mergeMixedSkillItems keeps frequency-first order after keyword filtering', () => {
  const commands = [
    item('/model'),
    item('/data'),
    item('/agents'),
  ]
  const native = [
    { ...item('/data-analysis', 'native-skill'), label: '[s] /data-analysis' },
    { ...item('/deep-research', 'native-skill'), label: '[s] /deep-research' },
  ]
  const usage = new Map([['data-analysis', 9], ['deep-research', 2], ['model', 7]])

  // Empty query: everything, most-used first regardless of kind; the two
  // uncounted rows tie at 0 and fall back to native-name order.
  assert.deepEqual(
    mergeMixedSkillItems(commands, native, '', usage).map(s => completionName(s)),
    ['data-analysis', 'model', 'deep-research', 'agents', 'data'],
  )
  // Keyword filter runs first; whatever remains is still frequency-sorted.
  assert.deepEqual(
    mergeMixedSkillItems(commands, native, 'data', usage).map(s => completionName(s)),
    ['data-analysis', 'data'],
  )
  assert.deepEqual(mergeMixedSkillItems(commands, native, 'xnothere', usage), [])
})

// --------------------------------------------- CommandService recording wiring --

/**
 * Structural fakes for CommandService's collaborators. `parseCommand` comes
 * from the real @deepseek-ai/dsh-commands, so submitted lines must use the
 * canonical `[a-z][a-z0-9_-]*` charset.
 */
function fakeEnv({ descriptors = [], skills = [], findNames = [], executeResult } = {}) {
  // Shape mirrors what CommandService reads off a live agent
  // (listSkills derives the cwd from agent.session.header.cwd).
  const agent = /** @type {any} */ ({ session: { header: { cwd: process.cwd() } } })
  const commandsApi = {
    list: () => descriptors,
    find: (_agent, name) => (findNames.includes(name) ? /** @type {any} */ ({}) : undefined),
    execute: (_agent, _line, _images, _signal) =>
      Promise.resolve(executeResult === undefined ? undefined : { commandId: 'x', result: executeResult }),
  }
  const skillsApi = { list: () => Promise.resolve(skills) }
  const ctx = {
    get: (key) => {
      if (key === 'commands') return commandsApi
      if (key === 'skills') return skillsApi
      return undefined
    },
  }
  const bridge = {
    getAgent: () => (findNames.length > 0 ? agent : undefined),
    ensureAgent: () => Promise.resolve(agent),
  }
  return { ctx, bridge }
}

function capturingRecorder() {
  const recorded = []
  return { recorded, record: (name) => recorded.push(name), snapshot: () => new Map() }
}

test('successful local command execution is counted; failures are not', async () => {
  const t = tempHome()
  try {
    const tracker = new CommandUsageTracker(t.path)
    const { ctx, bridge } = fakeEnv()
    const service = new CommandService(/** @type {any} */ (ctx), /** @type {any} */ (bridge), tracker)
    service.registerLocal('session', () => ({ kind: 'success', text: 'ok' }))
    service.registerLocal('boom', () => ({ kind: 'error', text: 'nope' }))

    const ok = await service.tryExecute('/session', new AbortController().signal)
    assert.equal(ok.handled, true)
    const bad = await service.tryExecute('/boom', new AbortController().signal)
    assert.equal(bad.handled, true)
    assert.deepEqual(tracker.snapshot(), new Map([['session', 1]]))
  } finally {
    t.cleanup()
  }
})

test('registry command execution counts only successful results', async () => {
  const t = tempHome()
  try {
    const tracker = new CommandUsageTracker(t.path)
    const good = fakeEnv({
      findNames: ['compact'],
      executeResult: { kind: 'success', text: 'done' },
    })
    const serviceGood = new CommandService(/** @type {any} */ (good.ctx), /** @type {any} */ (good.bridge), tracker)
    const ok = await serviceGood.tryExecute('/compact extra args', new AbortController().signal)
    assert.equal(ok.handled, true)
    assert.deepEqual(tracker.snapshot(), new Map([['compact', 1]]))

    const bad = fakeEnv({
      findNames: ['failing'],
      executeResult: { kind: 'error', text: 'kaput' },
    })
    const serviceBad = new CommandService(/** @type {any} */ (bad.ctx), /** @type {any} */ (bad.bridge), tracker)
    const err = await serviceBad.tryExecute('/failing', new AbortController().signal)
    assert.equal(err.handled, true)
    assert.deepEqual(tracker.snapshot(), new Map([['compact', 1]])) // unchanged
  } finally {
    t.cleanup()
  }
})

test('a /skill fall-through gesture is counted; unknown non-skill fall-throughs are not', async () => {
  const t = tempHome()
  try {
    const tracker = new CommandUsageTracker(t.path)
    const env = fakeEnv({
      skills: [{ name: 'data-analysis', description: 'analyze data', invocation: { userInvocable: true, modelInvocable: true } }],
      // No findNames: every line falls through the dispatcher toward the model.
    })
    const service = new CommandService(/** @type {any} */ (env.ctx), /** @type {any} */ (env.bridge), tracker)

    const gesture = await service.tryExecute('/data-analysis summarize this', new AbortController().signal)
    assert.equal(gesture.handled, false, 'skill lines must still reach the model untouched')
    assert.deepEqual(tracker.snapshot(), new Map([['data-analysis', 1]]))
    const stored = loadUsageEntries(t.path).get('data-analysis')
    assert.ok(stored && stored.count === 1 && stored.lastUsed > 0, 'the gesture is persisted to disk')

    const unknown = await service.tryExecute('/definitely-not-a-command', new AbortController().signal)
    assert.equal(unknown.handled, false)
    assert.equal(tracker.snapshot().size, 1, 'unknown non-skill lines stay uncounted')
  } finally {
    t.cleanup()
  }
})

test('non-user-invocable skills are not counted on fall-through', async () => {
  const t = tempHome()
  try {
    const recorder = capturingRecorder()
    const env = fakeEnv({
      skills: [{ name: 'internal-only', invocation: { userInvocable: false, modelInvocable: true } }],
    })
    const service = new CommandService(/** @type {any} */ (env.ctx), /** @type {any} */ (env.bridge), recorder)
    const result = await service.tryExecute('/internal-only', new AbortController().signal)
    assert.equal(result.handled, false)
    assert.deepEqual(recorder.recorded, [])
  } finally {
    t.cleanup()
  }
})

test('fall-through skill probing is skipped entirely without a usage recorder', async () => {
  let listCalls = 0
  const commandsApi = {
    list: () => [],
    find: () => undefined,
    execute: () => Promise.resolve(undefined),
  }
  const skillsApi = { list: () => { listCalls += 1; return Promise.resolve([]) } }
  const ctx = {
    get: (key) => {
      if (key === 'commands') return commandsApi
      if (key === 'skills') return skillsApi
      return undefined
    },
  }
  const bridge = { getAgent: () => undefined, ensureAgent: () => Promise.resolve(/** @type {any} */ ({})) }
  const plain = new CommandService(/** @type {any} */ (ctx), /** @type {any} */ (bridge))

  const result = await plain.tryExecute('/unknown-thing', new AbortController().signal)
  assert.equal(result.handled, false)
  assert.equal(listCalls, 0, 'no skills.list() round-trip when nothing consumes the answer')
})

test('autocomplete suggestions come back usage-ordered across kinds', async () => {
  const t = tempHome()
  try {
    const tracker = new CommandUsageTracker(t.path)
    tracker.record('model')
    tracker.record('data-analysis')
    tracker.record('data-analysis')
    const env = fakeEnv({
      descriptors: [
        { name: 'agents', description: 'agent manager' },
        { name: 'model', description: 'model picker' },
      ],
      skills: [{ name: 'data-analysis', description: 'analyze data', invocation: { userInvocable: true, modelInvocable: true } }],
      findNames: ['agents', 'model'],
    })
    const service = new CommandService(/** @type {any} */ (env.ctx), /** @type {any} */ (env.bridge), tracker)
    const provider = service.autocompleteProvider()

    const all = await provider.getSuggestions(['/'], 0, 1, { signal: new AbortController().signal })
    assert.deepEqual(all.items.map(i => i.value), ['/data-analysis', '/model', '/agents'])

    const filtered = await provider.getSuggestions(['/da'], 0, 3, { signal: new AbortController().signal })
    assert.deepEqual(filtered.items.map(i => i.value), ['/data-analysis'])
    assert.equal(filtered.prefix, '/da')

    // Degraded mode (no usage recorder): historical name order.
    const plain = new CommandService(/** @type {any} */ (env.ctx), /** @type {any} */ (env.bridge))
    const fallback = await plain.autocompleteProvider().getSuggestions(['/'], 0, 1, { signal: new AbortController().signal })
    assert.deepEqual(fallback.items.map(i => i.value), ['/agents', '/data-analysis', '/model'])
  } finally {
    t.cleanup()
  }
})
