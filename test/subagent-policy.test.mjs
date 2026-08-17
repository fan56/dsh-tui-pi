/**
 * Subagent-policy tests: the pure logic of `applySubagentPolicy` — the
 * maxAgents guard's allow/deny decision, the once-only maxRounds injection,
 * and the graceful degradation when a child is unresolvable. The policy is
 * exercised through a minimal fake ctx (tools/agents/settings slots + an
 * events bus stub) and a controllable fake state (live children, turn
 * counts), so no cordis runtime or dsh services are involved.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SPAWN_TOOLS,
  SUMMARY_MESSAGE,
  applySubagentPolicy,
} from '../lib/subagent-policy.js'

/** Fake settings provider: one `dsh-tui` section with the given limits. */
function makeSettings(limits) {
  return { describe: () => [{ ns: 'dsh-tui', value: { ...limits } }] }
}

/**
 * Build a fake ctx plus the captured hooks. `agents.get` resolves to
 * `capures.agent` (undefined by default — a settled/cold child); the fake
 * tools service records the registered guard so a test can invoke it.
 */
function makeCtx(overrides = {}) {
  const settings = overrides.settings
  const captured = {
    guard: undefined,
    guardDispose: undefined,
    agent: overrides.agent ?? undefined,
    events: [],
    disposed: { guard: false },
    followups: [],
  }
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          guard(guard) {
            captured.guard = guard
            return () => { captured.guard = undefined; captured.disposed.guard = true }
          },
        }
      }
      if (name === 'settings') return settings
      return undefined
    },
    agents: {
      get() { return captured.agent },
    },
    events: {
      on(name, listener) { captured.events.push({ name, listener }); return () => {} },
    },
  }
  return { ctx, captured }
}

/** Fake state: a live array and a turn-count map the test controls. */
function makeState({ live = [], turnCounts = {}, settled = [] } = {}) {
  return {
    getLive: () => live,
    getTurnCount: (childId) => turnCounts[childId] ?? 0,
    isSettled: (childId) => settled.includes(childId),
  }
}

test('the guard allows a spawn while live children are under maxAgents', () => {
  const { ctx, captured } = makeCtx({ settings: makeSettings({ maxAgents: 2, maxRounds: 50 }) })
  const live = [{ label: 'child-a' }]
  const policy = applySubagentPolicy(ctx, makeState({ live }))
  assert.ok(captured.guard !== undefined, 'guard registered')

  assert.equal(captured.guard({ name: 'subagent' }), undefined, 'below the cap: allowed')
  // Non-spawn tools are never denied.
  assert.equal(captured.guard({ name: 'bash' }), undefined, 'non-spawn tool: allowed')
  policy.dispose()
})

test('the guard denies a spawn at the cap with the running labels in the reason', () => {
  const { ctx, captured } = makeCtx({ settings: makeSettings({ maxAgents: 2, maxRounds: 50 }) })
  const live = [{ label: 'backend-1' }, { label: 'researcher' }]
  const policy = applySubagentPolicy(ctx, makeState({ live }))

  const reason = captured.guard({ name: 'subagent' })
  assert.equal(typeof reason, 'string', 'over the cap: denied')
  assert.ok(reason.includes('backend-1'), 'deny reason lists a running label')
  assert.ok(reason.includes('researcher'), 'deny reason lists all running labels')

  // Other spawn-ish names are guarded too.
  for (const name of SPAWN_TOOLS) {
    if (name === 'subagent') continue
    assert.equal(typeof captured.guard({ name }), 'string', `${name} intercepted as a spawn tool`)
  }
  policy.dispose()
})

test('the guard is disabled when maxAgents is 0 and defaults apply without settings', () => {
  // Zero lifts the cap entirely.
  const zero = makeCtx({ settings: makeSettings({ maxAgents: 0, maxRounds: 50 }) })
  const zeroPolicy = applySubagentPolicy(zero.ctx, makeState({ live: [{ label: 'x' }, { label: 'y' }] }))
  assert.equal(zero.captured.guard({ name: 'subagent' }), undefined, 'maxAgents 0: never denied')
  zeroPolicy.dispose()

  // No settings service: the documented defaults (4) still gate the guard.
  const bare = makeCtx()
  const busy = applySubagentPolicy(bare.ctx, makeState({ live: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }] }))
  assert.equal(typeof bare.captured.guard({ name: 'subagent' }), 'string', 'settings-less: default cap enforced')
  busy.dispose()
})

test('onTurnCount injects nothing when maxRounds is 0', () => {
  const followups = []
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 0 }),
    agent: { followup: (msg) => followups.push(msg) },
  })
  const policy = applySubagentPolicy(ctx, makeState())
  policy.onTurnCount('child-1', 1_000)
  assert.deepEqual(followups, [], 'maxRounds 0: no summary request ever')
  policy.dispose()
})

test('onTurnCount injects the summary request exactly once at the round cap', () => {
  const followups = []
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 3 }),
    agent: { followup: (msg) => followups.push(msg) },
  })
  const policy = applySubagentPolicy(ctx, makeState())

  policy.onTurnCount('child-1', 2)
  assert.deepEqual(followups, [], 'below the cap: nothing injected')

  policy.onTurnCount('child-1', 3)
  assert.equal(followups.length, 1, 'at the cap: one summary request')
  const message = followups[0]
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, SUMMARY_MESSAGE, 'the summary message text')
  assert.equal(message.source.kind, 'plugin', 'message is plugin-sourced')
  assert.equal(message.source.plugin, 'dsh-tui-pi', 'message carries the plugin name')

  policy.onTurnCount('child-1', 4)
  policy.onTurnCount('child-1', 5)
  assert.equal(followups.length, 1, 'later turns: no repeat injection')

  // A different child still receives its own single request.
  policy.onTurnCount('child-2', 3)
  assert.equal(followups.length, 2, 'each child is injected independently, once')
  policy.dispose()
})

test('onTurnCount silently skips a child that cannot be resolved', () => {
  const followups = []
  // agents.get returns undefined — a settled/cold child must not throw and
  // must not inject into nothing.
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 3 }),
    agent: undefined,
  })
  const policy = applySubagentPolicy(ctx, makeState())
  assert.doesNotThrow(() => policy.onTurnCount('ghost', 3), 'unresolvable child: silent skip')
  assert.deepEqual(followups, [], 'no followup for an unresolvable child')
  policy.dispose()
})

test('onTurnCount never re-awakens a settled child at the round cap', () => {
  const followups = []
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 3 }),
    agent: { followup: (msg) => followups.push(msg) },
  })
  // The settle event and the maxRounds-crossing turn/end fire together: the
  // child finished, so the wrap-up request would only wake it wastefully.
  const policy = applySubagentPolicy(ctx, makeState({ settled: ['done-child'] }))
  policy.onTurnCount('done-child', 3)
  assert.deepEqual(followups, [], 'settled child: no injection')
  policy.dispose()
})

/** Fire the captured subagent/start listener for one child id. */
function fireSubagentStart(captured, id) {
  const entry = captured.events.find(({ name }) => name === 'subagent/start')
  assert.ok(entry !== undefined, 'subagent/start listener registered')
  entry.listener({ id })
}

test('the subagent/start backstop cancels a fan-out child when the others fill the cap', () => {
  const cancels = []
  const { ctx, captured } = makeCtx({
    settings: makeSettings({ maxAgents: 2, maxRounds: 50 }),
    agent: { cancel: (cause) => cancels.push(cause) },
  })
  // Two other live children fill the cap; the workflow newcomer overshoots.
  const policy = applySubagentPolicy(ctx, makeState({ live: [
    { label: 'a' }, { label: 'b' },
  ] }))
  fireSubagentStart(captured, 'newcomer')
  assert.equal(cancels.length, 1, 'over the cap: the newcomer is pruned')
  assert.equal(cancels[0].kind, 'hook', 'pruned with a hook cause')
  policy.dispose()
})

test('the subagent/start backstop never cancels a legitimate Nth-at-cap child', () => {
  const cancels = []
  const { ctx, captured } = makeCtx({
    settings: makeSettings({ maxAgents: 3, maxRounds: 50 }),
    agent: { cancel: (cause) => cancels.push(cause) },
  })
  // The race case: the newcomer's own session events reached the bridge's
  // count BEFORE subagent/start fired, so live includes the newcomer itself
  // at exactly the cap — excluding it, the others are under the cap.
  const policy = applySubagentPolicy(ctx, makeState({ live: [
    { childId: 'a', label: 'a' }, { childId: 'b', label: 'b' }, { childId: 'newcomer', label: 'newcomer' },
  ] }))
  fireSubagentStart(captured, 'newcomer')
  assert.deepEqual(cancels, [], 'at the cap counting the newcomer: not pruned')
  policy.dispose()
})

test('the subagent/start backstop is disabled when maxAgents is 0', () => {
  const cancels = []
  const { ctx, captured } = makeCtx({
    settings: makeSettings({ maxAgents: 0, maxRounds: 50 }),
    agent: { cancel: (cause) => cancels.push(cause) },
  })
  const policy = applySubagentPolicy(ctx, makeState({ live: [
    { label: 'a' }, { label: 'b' }, { label: 'c' },
  ] }))
  fireSubagentStart(captured, 'newcomer')
  assert.deepEqual(cancels, [], 'maxAgents 0: never pruned')
  policy.dispose()
})