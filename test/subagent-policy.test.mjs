/**
 * Subagent-policy tests: the pure logic of `applySubagentPolicy` — the
 * maxAgents guard's allow/deny decision, the once-only maxRounds injection,
 * and the graceful degradation when a child is unresolvable. The policy is
 * exercised through a minimal fake ctx (tools/agents/settings slots + an
 * events bus stub) and a controllable fake state (live children, round
 * counts), so no dsh services are involved. The TUI-surface marker tests
 * additionally drive a REAL cordis Context from the linked
 * @deepseek-ai/cordis — the guard must read a genuine scope, not just fakes.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NATIVE_SPAWN_TOOLS,
  SPAWN_TOOLS,
  SUMMARY_MESSAGE,
  TUI_SURFACE_KEY,
  applySubagentPolicy,
  installSpawnToolFence,
  markTuiSurface,
} from '../lib/subagent-policy.js'

/**
 * Fake settings provider: one `dsh-tui` section with the given limits. The
 * disableSubagent fence defaults to OFF here so the legacy maxAgents/maxRounds
 * scenarios below exercise the cap in isolation; the fence has its own tests.
 */
function makeSettings(limits) {
  return { describe: () => [{ ns: 'dsh-tui', value: { disableSubagent: false, ...limits } }] }
}

/**
 * A fake agent whose scope carries the TUI surface marker — the shape the
 * bridge's setups produce via `markTuiSurface(agentCtx)` (create AND resume).
 */
function tuiAgent() {
  return { ctx: { get(name) { return name === TUI_SURFACE_KEY ? true : undefined } } }
}

/**
 * A fake agent WITHOUT the marker — e.g. a Web UI session in a shared
 * process, or a child spawned by another plugin's setup.
 */
function foreignAgent() {
  return { ctx: { get() { return undefined } } }
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

/** Fake state: a live array and a round-count map the test controls. */
function makeState({ live = [], roundCounts = {}, settled = [] } = {}) {
  return {
    getLive: () => live,
    getRoundCount: (childId) => roundCounts[childId] ?? 0,
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

test('the guard denies a marked TUI spawn at the cap with the running labels in the reason', () => {
  const { ctx, captured } = makeCtx({ settings: makeSettings({ maxAgents: 2, maxRounds: 50 }) })
  const live = [{ label: 'backend-1' }, { label: 'researcher' }]
  const policy = applySubagentPolicy(ctx, makeState({ live }))

  const reason = captured.guard({ name: 'subagent', agent: tuiAgent() })
  assert.equal(typeof reason, 'string', 'over the cap: denied')
  assert.ok(reason.includes('backend-1'), 'deny reason lists a running label')
  assert.ok(reason.includes('researcher'), 'deny reason lists all running labels')

  // Other spawn-ish names are guarded too.
  for (const name of SPAWN_TOOLS) {
    if (name === 'subagent') continue
    assert.equal(typeof captured.guard({ name, agent: tuiAgent() }), 'string', `${name} intercepted as a spawn tool`)
  }
  policy.dispose()
})

test('the guard is disabled when maxAgents is 0 and defaults apply without settings', () => {
  // Zero lifts the cap entirely.
  const zero = makeCtx({ settings: makeSettings({ maxAgents: 0, maxRounds: 50 }) })
  const zeroPolicy = applySubagentPolicy(zero.ctx, makeState({ live: [{ label: 'x' }, { label: 'y' }] }))
  assert.equal(zero.captured.guard({ name: 'subagent' }), undefined, 'maxAgents 0: never denied')
  zeroPolicy.dispose()

  // No settings service: the documented defaults still gate the guard. The
  // fence is ALSO on by default, so the registry tool (`use_agent`) is the
  // probe that reaches the cap check - the native names are fenced off first.
  const bare = makeCtx()
  const busy = applySubagentPolicy(bare.ctx, makeState({ live: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }] }))
  assert.equal(typeof bare.captured.guard({ name: 'use_agent', agent: tuiAgent() }), 'string', 'settings-less: default cap enforced')
  assert.equal(typeof bare.captured.guard({ name: 'subagent', agent: tuiAgent() }), 'string', 'settings-less: default fence enforced')
  busy.dispose()
})

// ------------------------------------------------------- disableSubagent ----

test('disableSubagent denies ONLY the plain subagent tool and passes the rest through', () => {
  const { ctx, captured } = makeCtx({ settings: makeSettings({ maxAgents: 4, maxRounds: 50, disableSubagent: true }) })
  const policy = applySubagentPolicy(ctx, makeState({ live: [] }))

  const reason = captured.guard({ name: 'subagent', agent: tuiAgent() })
  assert.equal(typeof reason, 'string', 'subagent denied')
  assert.ok(reason.includes('use_agent'), 'deny reason points at use_agent')
  // The fork/workflow/ralph variants and the registry tool are NOT fenced.
  for (const name of ['subagent_fork', 'workflow', 'ralph', 'use_agent']) {
    assert.equal(captured.guard({ name, agent: tuiAgent() }), undefined, `${name}: allowed`)
  }
  // Non-spawn tools never see the fence.
  assert.equal(captured.guard({ name: 'bash', agent: tuiAgent() }), undefined, 'non-spawn tool: allowed')
  policy.dispose()
})

test('the fence wins over the cap reason, and turns off with the setting', () => {
  // Both violations at once (over the cap AND the fenced tool): the fence is
  // the reported reason - the tool rule is the primary contract.
  const { ctx, captured } = makeCtx({ settings: makeSettings({ maxAgents: 1, maxRounds: 50, disableSubagent: true }) })
  const policy = applySubagentPolicy(ctx, makeState({ live: [{ label: 'busy' }] }))
  const reason = captured.guard({ name: 'subagent', agent: tuiAgent() })
  assert.ok(reason.includes('use_agent') && !reason.includes('Agent limit reached'), 'fence reason wins')
  // At the cap, the registry tool still reports the CAP (not the fence).
  assert.ok(captured.guard({ name: 'use_agent', agent: tuiAgent() }).includes('Agent limit reached'), 'use_agent at cap reports the cap')
  policy.dispose()

  // Toggle off: subagent passes to the cap check again.
  const off = makeCtx({ settings: makeSettings({ maxAgents: 4, maxRounds: 50, disableSubagent: false }) })
  const offPolicy = applySubagentPolicy(off.ctx, makeState({ live: [] }))
  assert.equal(off.captured.guard({ name: 'subagent', agent: tuiAgent() }), undefined, 'fence off: subagent allowed under the cap')
  offPolicy.dispose()
})

// ------------------------------------------------- disableSubagent scope ----

test('markTuiSurface works on a REAL cordis Context and the guard reads it back', async () => {
  // Regression against the real cordis implementation (the linked
  // @deepseek-ai/cordis, not a fake): `set` of an unprovided name THROWS on
  // a genuine Context ("cannot set property ... without provide") — and
  // markTuiSurface runs inside the session setups, where a throw rolls back
  // the whole session create/resume. provide → get is the only safe write.
  const { Context } = await import('@deepseek-ai/cordis')
  const agentCtx = new Context()
  assert.throws(() => agentCtx.set(TUI_SURFACE_KEY, true), /without provide/, 'sanity: plain set really throws unprovided')
  assert.doesNotThrow(() => markTuiSurface(agentCtx), 'markTuiSurface must not throw on a real Context')
  assert.equal(agentCtx.get(TUI_SURFACE_KEY), true, 'provide → get roundtrip carries the marker')

  // The guard's own read path (isTuiSurfaceAgent) sees the REAL context's
  // marker end to end — no fake in between.
  const { ctx, captured } = makeCtx({ settings: makeSettings({ maxAgents: 4, maxRounds: 50, disableSubagent: true }) })
  const policy = applySubagentPolicy(ctx, makeState({ live: [] }))
  const reason = captured.guard({ name: 'subagent', agent: { ctx: agentCtx } })
  assert.equal(typeof reason, 'string', 'real marked Context: subagent denied')

  // An equally real but UNMARKED Context reads as not TUI-owned.
  const foreignCtx = new Context()
  assert.equal(captured.guard({ name: 'subagent', agent: { ctx: foreignCtx } }), undefined, 'real unmarked Context: allowed')
  policy.dispose()
})

test('markTuiSurface sets the marker readable through a scoped child context', async () => {
  // dsh hands the setup a scoped agent ctx (child of the plugin scope); a
  // marker provided there must be visible from that same scope's get().
  const { Context } = await import('@deepseek-ai/cordis')
  const parent = new Context()
  const child = new Context(parent)
  markTuiSurface(child)
  assert.equal(child.get(TUI_SURFACE_KEY), true, 'scoped provide → scoped get roundtrip')
})

test('disableSubagent fails open for anything but a marked TUI session', () => {
  const { ctx, captured } = makeCtx({ settings: makeSettings({ maxAgents: 4, maxRounds: 50, disableSubagent: true }) })
  const policy = applySubagentPolicy(ctx, makeState({ live: [] }))

  // No exec.agent at all — a caller that bypasses the agent loop.
  assert.equal(captured.guard({ name: 'subagent' }), undefined, 'absent exec.agent: allowed')
  // A live agent without the marker — e.g. a Web UI session of a shared process.
  assert.equal(captured.guard({ name: 'subagent', agent: foreignAgent() }), undefined, 'unmarked agent: allowed')
  // Degenerate shapes must read as unmarked, never throw.
  assert.equal(captured.guard({ name: 'subagent', agent: null }), undefined, 'null agent: allowed')
  assert.equal(captured.guard({ name: 'subagent', agent: {} }), undefined, 'agent without ctx: allowed')
  assert.equal(captured.guard({ name: 'subagent', agent: { ctx: {} } }), undefined, 'ctx without get(): allowed')
  const throwing = { ctx: { get() { throw new Error('cannot get property without inject') } } }
  assert.equal(captured.guard({ name: 'subagent', agent: throwing }), undefined, 'throwing ctx.get(): allowed')
  // A falsy marker is not a marker.
  const falsy = { ctx: { get(name) { return name === TUI_SURFACE_KEY ? false : undefined } } }
  assert.equal(captured.guard({ name: 'subagent', agent: falsy }), undefined, 'falsy marker: allowed')
  policy.dispose()
})

test('the maxAgents cap is surface-scoped too: an unmarked spawn over the cap is allowed', () => {
  // C1 boundary convergence: BOTH enforcement branches (fence and cap) only
  // fire for marked TUI sessions — an unmarked agent sharing this process
  // spawns freely even over the TUI's live-children budget. The COUNT stays
  // global; only the denial is scoped.
  const { ctx, captured } = makeCtx({ settings: makeSettings({ maxAgents: 1, maxRounds: 50, disableSubagent: true }) })
  const policy = applySubagentPolicy(ctx, makeState({ live: [{ label: 'busy' }] }))
  for (const name of SPAWN_TOOLS) {
    assert.equal(captured.guard({ name, agent: foreignAgent() }), undefined, `unmarked ${name} over the cap: allowed`)
  }
  assert.equal(captured.guard({ name: 'use_agent' }), undefined, 'absent exec.agent over the cap: allowed')
  // The same call from a MARKED agent is still denied.
  assert.ok(captured.guard({ name: 'use_agent', agent: tuiAgent() }).includes('Agent limit reached'), 'marked agent at cap: still denied')
  policy.dispose()
})

test('onRoundCount injects nothing when maxRounds is 0', () => {
  const followups = []
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 0 }),
    agent: { followup: (msg) => followups.push(msg) },
  })
  const policy = applySubagentPolicy(ctx, makeState())
  policy.onRoundCount('child-1', 1_000)
  assert.deepEqual(followups, [], 'maxRounds 0: no summary request ever')
  policy.dispose()
})

test('onRoundCount injects the summary request exactly once at the round cap', () => {
  const followups = []
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 3 }),
    agent: { followup: (msg) => followups.push(msg) },
  })
  const policy = applySubagentPolicy(ctx, makeState())

  policy.onRoundCount('child-1', 2)
  assert.deepEqual(followups, [], 'below the cap: nothing injected')

  policy.onRoundCount('child-1', 3)
  assert.equal(followups.length, 1, 'at the cap: one summary request')
  const message = followups[0]
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, SUMMARY_MESSAGE, 'the summary message text')
  assert.equal(message.source.kind, 'plugin', 'message is plugin-sourced')
  assert.equal(message.source.plugin, 'dsh-tui-pi', 'message carries the plugin name')

  // Later round counts — including the wrap-up's OWN assistant message, which
  // pushes the count past maxRounds (max+1, max+2, …) — never re-inject.
  policy.onRoundCount('child-1', 4)
  policy.onRoundCount('child-1', 5)
  assert.equal(followups.length, 1, 'later rounds: no repeat injection')

  // A different child still receives its own single request.
  policy.onRoundCount('child-2', 3)
  assert.equal(followups.length, 2, 'each child is injected independently, once')
  policy.dispose()
})

test('onRoundCount never re-injects when the wrap-up\'s own message crosses the cap', () => {
  // The full runaway scenario: at maxRounds the child is injected; the wrap-up
  // prompt makes it produce MORE assistant messages (round max+1, max+2, …),
  // each firing onRoundCount past the cap. The injected set must hold: no
  // second summary request, even though the count keeps climbing.
  const followups = []
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 5 }),
    agent: { followup: (msg) => followups.push(msg) },
  })
  const policy = applySubagentPolicy(ctx, makeState())
  for (let count = 1; count <= 5; count++) {
    policy.onRoundCount('child-1', count)
  }
  assert.equal(followups.length, 1, 'injected once at maxRounds = 5')
  policy.onRoundCount('child-1', 6)
  policy.onRoundCount('child-1', 7)
  assert.equal(followups.length, 1, 'the wrap-up replies (round 6, 7) never re-inject')
  policy.dispose()
})

test('onRoundCount silently skips a child that cannot be resolved', () => {
  const followups = []
  // agents.get returns undefined — a settled/cold child must not throw and
  // must not inject into nothing.
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 3 }),
    agent: undefined,
  })
  const policy = applySubagentPolicy(ctx, makeState())
  assert.doesNotThrow(() => policy.onRoundCount('ghost', 3), 'unresolvable child: silent skip')
  assert.deepEqual(followups, [], 'no followup for an unresolvable child')
  policy.dispose()
})

test('onRoundCount never re-awakens a settled child at the round cap', () => {
  const followups = []
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 3 }),
    agent: { followup: (msg) => followups.push(msg) },
  })
  // The settle event and the maxRounds-crossing assistant message fire
  // together: the child finished, so the wrap-up request would only wake it
  // wastefully.
  const policy = applySubagentPolicy(ctx, makeState({ settled: ['done-child'] }))
  policy.onRoundCount('done-child', 3)
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

// --------------------------------------------------- spawn-tool hide ----

test('installSpawnToolFence hides exactly the native spawn tools via restrict', () => {
  let filter
  const agentCtx = {
    get(name) {
      assert.equal(name, 'tools')
      return { restrict(f) { filter = f } }
    },
  }
  installSpawnToolFence(agentCtx)
  assert.deepEqual(filter.deny, [...NATIVE_SPAWN_TOOLS], 'deny list = the native spawn tools')
  // use_agent is deliberately NOT in the hide list.
  assert.ok(!filter.deny.includes('use_agent'), 'use_agent stays visible')
})

test('installSpawnToolFence is best-effort: no tools service or a throwing restrict never fails setup', () => {
  // No tools service: silent no-op.
  installSpawnToolFence({ get() { return undefined } })
  // A throwing restrict (unknown tool name, registration race) is swallowed.
  const throwing = {
    get() {
      return { restrict() { throw new Error('tools.restrict() names unknown global tool "workflow"') } }
    },
  }
  assert.doesNotThrow(() => installSpawnToolFence(throwing), 'restrict failure degrades silently')
})