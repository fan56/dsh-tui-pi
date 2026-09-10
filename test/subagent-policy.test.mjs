/**
 * Subagent-policy tests: the pure logic of `applySubagentPolicy` — the
 * maxAgents guard's allow/deny decision, the once-only maxRounds injection,
 * and the graceful degradation when a child is unresolvable. The policy is
 * exercised through a minimal fake ctx (tools/agents/settings slots + an
 * events bus stub) and a controllable fake state (live children, round
 * counts), so no dsh services are involved. The TUI-surface marker tests
 * additionally drive a REAL cordis Context from the linked
 * @deepseek-ai/cordis — the guard must read a genuine scope, not just fakes.
 * The deferred-injection regression test goes further: a REAL SessionStore
 * mount plus a REAL Inbox splice reproduce the append publication window the
 * bridge observes run inside. Runs against the built lib/ (pnpm build &&
 * pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NATIVE_SPAWN_TOOLS,
  SPAWN_TOOLS,
  wrapupMessage,
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
  /** The in-process agent registry: id → fake agent (for the ancestor walk). */
  const agentsById = overrides.agentsById ?? {}
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
      get(id) {
        const key = typeof id === 'string' ? id : String(id ?? '')
        if (key in agentsById) return agentsById[key]
        return captured.agent
      },
    },
    events: {
      on(name, listener) { captured.events.push({ name, listener }); return () => {} },
    },
  }
  return { ctx, captured }
}

/**
 * Fake state: a live array and a round-count map the test controls.
 */
function makeState({ live = [], roundCounts = {}, settled = [] } = {}) {
  return {
    getLive: () => live,
    getRoundCount: (childId) => roundCounts[childId] ?? 0,
    isSettled: (childId) => settled.includes(childId),
  }
}

/**
 * Yield one microtask turn: the policy schedules its followup with
 * `queueMicrotask`, whose callback sits AHEAD of this continuation in the
 * microtask queue (FIFO), so a single await deterministically flushes it.
 */
function microtaskFlush() {
  return new Promise(resolve => queueMicrotask(resolve))
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

test('onRoundCount injects nothing when maxRounds is 0', async () => {
  const followups = []
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 0 }),
    agent: { followup: (msg) => followups.push(msg) },
  })
  const policy = applySubagentPolicy(ctx, makeState())
  policy.onRoundCount('child-1', 1_000)
  await microtaskFlush()
  assert.deepEqual(followups, [], 'maxRounds 0: no summary request ever')
  policy.dispose()
})

test('onRoundCount injects the summary request exactly once at the round cap', async () => {
  const followups = []
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 3 }),
    agent: { followup: (msg) => followups.push(msg) },
  })
  const policy = applySubagentPolicy(ctx, makeState())

  policy.onRoundCount('child-1', 2)
  await microtaskFlush()
  assert.deepEqual(followups, [], 'below the cap: nothing injected')

  policy.onRoundCount('child-1', 3)
  await microtaskFlush()
  assert.equal(followups.length, 1, 'at the cap: one summary request')
  const message = followups[0]
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, wrapupMessage(3, 7), 'the summary message text names the cap')
  assert.equal(message.source.kind, 'plugin', 'message is plugin-sourced')
  assert.equal(message.source.plugin, 'dsh-tui-pi', 'message carries the plugin name')

  // Later round counts — including the wrap-up's OWN assistant message, which
  // pushes the count past maxRounds (max+1, max+2, …) — never re-inject.
  policy.onRoundCount('child-1', 4)
  policy.onRoundCount('child-1', 5)
  await microtaskFlush()
  assert.equal(followups.length, 1, 'later rounds: no repeat injection')

  // A different child still receives its own single request.
  policy.onRoundCount('child-2', 3)
  await microtaskFlush()
  assert.equal(followups.length, 2, 'each child is injected independently, once')
  policy.dispose()
})

test('onRoundCount never re-injects when the wrap-up\'s own message crosses the cap', async () => {
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
  await microtaskFlush()
  assert.equal(followups.length, 1, 'injected once at maxRounds = 5')
  policy.onRoundCount('child-1', 6)
  policy.onRoundCount('child-1', 7)
  await microtaskFlush()
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

// ------------------------------------- deferred injection vs. the store ----

test('onRoundCount lands the wrap-up splice after the publication window closes', async () => {
  // Regression: onRoundCount fires inside a child `session/event` observer —
  // while the store-mounted session is mid-append (the publication window).
  // The old code called followup synchronously there; its inbox splice
  // reentered that very append and threw ("session append cannot reenter
  // while another append is being published"), the contained observer
  // dispatch swallowed it, and `injected.add` had ALREADY run — so the cap
  // was silently abandoned for that child. This drives the REAL path: a real
  // SessionStore-mounted session, a real Inbox splice over it, and the
  // policy invoked from a session/event listener exactly where the bridge
  // invokes it.
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: SessionStore, SessionId } = await import('@deepseek-ai/dsh-session')
  const { createUserMessage, createMessage } = await import('@deepseek-ai/dsh-llm')
  const { Inbox } = await import('@deepseek-ai/dsh-agent')

  const ctx = new Context()
  await ctx.plugin(SessionStore)
  ctx.provide('settings', {
    describe: () => [{ ns: 'dsh-tui', value: { maxAgents: 4, maxRounds: 1, disableSubagent: false } }],
  })
  const session = ctx.sessions.create(SessionId('wrap-child'), { meta: { cwd: process.cwd() } })
  // A real Inbox over the mounted session: followup rides the genuine
  // splice → durable append path, not a stub.
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  const agent = {
    followup: (message) => inbox.append('next-turn', message),
  }
  ctx.provide('agents', { get: () => agent })

  let windowGuarded = false
  let counted = 0
  ctx.on('session/event', (mountedSession, event) => {
    if (String(mountedSession.id) !== 'wrap-child' || event.type !== 'assistant/message') return
    counted += 1
    // Sanity: this listener really runs INSIDE the append publication
    // window — a nested append against the same mounted session hits the
    // reentrancy guard. Recorded as a flag (a throwing assert here would be
    // contained like any observer error and never reach the test body).
    try {
      mountedSession.append('turn/end', { turn: counted, reason: { kind: 'completed' } })
    } catch {
      windowGuarded = true
    }
    // Drive the policy exactly where the bridge drives it: synchronously,
    // inside the observer.
    policy.onRoundCount('wrap-child', counted)
  })

  const policy = applySubagentPolicy(ctx, makeState())
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'round one' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })

  assert.ok(windowGuarded, 'sanity: the observer really ran inside the publication window')
  assert.ok(!session.log.some(event => event.type === 'agent/inbox/spliced'), 'synchronously nothing landed yet')

  await microtaskFlush()

  assert.ok(
    session.log.some(event => event.type === 'agent/inbox/spliced'),
    'the wrap-up splice published once the window closed',
  )
  assert.ok(inbox.hasPending, 'the child inbox carries the pending wrap-up message')
  assert.equal(inbox.nextTurn.length, 1, 'exactly one wrap-up message was queued')
  policy.dispose()
})

test('a failed followup leaves the cap unarmed — the next counted round retries', async () => {
  // Regression for the permanent-abandonment half of the bug: the old code
  // marked `injected` BEFORE calling followup, so one failure (the reentrancy
  // throw above, or any other) permanently gave up capping that child. Now
  // the mark happens only after success.
  const followups = []
  let failing = true
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 3 }),
    agent: {
      followup: (msg) => {
        if (failing) throw new Error('session append cannot reenter while another append is being published')
        followups.push(msg)
      },
    },
  })
  const policy = applySubagentPolicy(ctx, makeState())

  policy.onRoundCount('child-1', 3)
  await microtaskFlush()
  assert.deepEqual(followups, [], 'failed attempt injects nothing')

  // The retry trigger: the next counted round calls onRoundCount again —
  // allowed because injected stayed unset.
  failing = false
  policy.onRoundCount('child-1', 4)
  await microtaskFlush()
  assert.equal(followups.length, 1, 'the next round retries and lands the wrap-up')
  assert.equal(followups[0].content[0].text, wrapupMessage(3, 7), 'the retry carries the summary message')

  // After the successful retry the once-per-child cap holds again.
  policy.onRoundCount('child-1', 5)
  await microtaskFlush()
  assert.equal(followups.length, 1, 'no further injection after the successful retry')
  policy.dispose()
})

test('the deferred injection re-checks liveness at flush time', async () => {
  // Between scheduling and flushing the child may settle or its agent may be
  // replaced/torn down — the stale handle must never receive the injection.
  const followups = []
  const { ctx, captured } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 3 }),
    agent: { followup: (msg) => followups.push(msg) },
  })
  const settled = []
  const policy = applySubagentPolicy(ctx, makeState({ settled }))

  // Settle while queued: the flush abandons the injection.
  policy.onRoundCount('settled-late', 3)
  settled.push('settled-late')
  await microtaskFlush()
  assert.deepEqual(followups, [], 'a child settled before the flush: no injection')

  // Swap the agent while queued: identity mismatch abandons the injection.
  policy.onRoundCount('swap-child', 3)
  captured.agent = { followup: (msg) => followups.push(msg) }
  await microtaskFlush()
  assert.deepEqual(followups, [], 'an agent swapped out before the flush: no injection into the stale handle')
  policy.dispose()
})

test('dispose cancels a still-queued deferred injection', async () => {
  const followups = []
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 3 }),
    agent: { followup: (msg) => followups.push(msg) },
  })
  const policy = applySubagentPolicy(ctx, makeState())
  policy.onRoundCount('child-1', 3)
  policy.dispose()
  await microtaskFlush()
  assert.deepEqual(followups, [], 'teardown before the flush: no late wrap-up')
})

/** Fire the captured subagent/start listener for one child id. */
function fireSubagentStart(captured, id) {
  const entry = captured.events.find(({ name }) => name === 'subagent/start')
  assert.ok(entry !== undefined, 'subagent/start listener registered')
  entry.listener({ id })
}

test('the subagent/start backstop cancels a fan-out child when the others fill the cap', () => {
  const cancels = []
  // The newcomer's parent chain roots at a marked TUI session (the walk:
  // child → parent agent → marked scope) — TUI-owned, prunable.
  const parent = tuiAgent()
  const newcomer = { session: { header: { parentSession: 'parent-1' } }, cancel: (cause) => cancels.push(cause) }
  const { ctx, captured } = makeCtx({
    settings: makeSettings({ maxAgents: 2, maxRounds: 50 }),
    agentsById: { newcomer, 'parent-1': parent },
  })
  // Two other live children fill the cap; the workflow newcomer overshoots.
  const policy = applySubagentPolicy(ctx, makeState({ live: [
    { label: 'a' }, { label: 'b' },
  ] }))
  fireSubagentStart(captured, 'newcomer')
  assert.equal(cancels.length, 1, 'over the cap: the newcomer is pruned')
  assert.equal(cancels[0].kind, 'hook', 'pruned with a hook cause')
  assert.equal(policy.getStats().pruned, 1, 'the prune is counted in the runtime stats')
  policy.dispose()
})

test('the subagent/start backstop never prunes a foreign-rooted child', () => {
  const cancels = []
  // The newcomer descends from an UNMARKED root (a feishu-created session):
  // over the cap or not, the backstop must leave it alone.
  const newcomer = { session: { header: { parentSession: 'foreign-root' } }, cancel: () => cancels.push('pruned!') }
  const { ctx, captured } = makeCtx({
    settings: makeSettings({ maxAgents: 2, maxRounds: 50 }),
    agentsById: { newcomer, 'foreign-root': { ctx: { get() { return undefined } } } },
  })
  const policy = applySubagentPolicy(ctx, makeState({ live: [
    { label: 'a' }, { label: 'b' },
  ] }))
  fireSubagentStart(captured, 'newcomer')
  assert.deepEqual(cancels, [], 'a foreign-rooted newcomer is never pruned')
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
test('a RUNNING child is wrapped up through steer — the next step boundary, not a queued turn', async () => {
  // The original bug: the injection always used followup(), which queues a
  // whole next TURN. A running child can burn many more rounds (steps) inside
  // its current turn before the wrap-up lands — the cap visibly never bit.
  // A running child must take steer() (consumed at the next step boundary,
  // i.e. the very next LLM round-trip), matching the Ctrl+G steer routing.
  const steers = []
  const followups = []
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 3 }),
    agent: {
      status: 'running',
      steer: msg => steers.push(msg),
      followup: msg => followups.push(msg),
    },
  })
  const policy = applySubagentPolicy(ctx, makeState())
  policy.onRoundCount('child-1', 3)
  await microtaskFlush()
  assert.equal(steers.length, 1, 'running child receives the wrap-up through steer')
  assert.equal(followups.length, 0, 'no next-turn followup for a running child')
  assert.equal(steers[0].content[0].text, wrapupMessage(3, 7))
  policy.dispose()
})

test('an IDLE-but-unsettled child is wrapped up through followup (its own ordinary turn)', async () => {
  const steers = []
  const followups = []
  const { ctx } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 3 }),
    agent: {
      status: 'idle',
      steer: msg => steers.push(msg),
      followup: msg => followups.push(msg),
    },
  })
  const policy = applySubagentPolicy(ctx, makeState())
  policy.onRoundCount('child-1', 3)
  await microtaskFlush()
  assert.equal(followups.length, 1, 'idle child receives the wrap-up as its own next turn')
  assert.equal(steers.length, 0, 'steer is never sent to an idle child')
  policy.dispose()
})

test('wrapupMessage is a directive that forbids further tool calls and names the limit', () => {
  const text = wrapupMessage(12)
  assert.ok(text.includes('12'), 'names the round limit')
  assert.ok(/Do NOT call any more tools/i.test(text), 'forbids further tool calls')
  assert.ok(/final answer/i.test(text), 'demands a final answer')
})

// ------------------------------------------------------- hard-stop ladder --

/**
 * A RUNNING fake child agent (the steer recipient at stage 1) plus a cancel
 * sink for stage 2, wired through the state's cancelChild.
 */
function ladderCtx({ cap, grace, status = 'running' } = {}) {
  const steers = []
  const followups = []
  const cancels = []
  const agent = {
    status,
    steer: msg => steers.push(msg),
    followup: msg => followups.push(msg),
  }
  const { ctx, captured } = makeCtx({
    settings: makeSettings({ maxAgents: cap, maxRounds: cap, ...(grace !== undefined ? { maxRoundsGrace: grace } : {}) }),
    agent,
  })
  return { ctx, steers, followups, cancels, agent }
}

test('hard-stop ladder: cancel fires at cap+grace and reports onHardStop', async () => {
  const grace = 2
  const { ctx, steers } = ladderCtx({ cap: 3, grace })
  const cancels = []
  const stops = []
  const policy = applySubagentPolicy(
    ctx,
    {
      ...makeState({}),
      cancelChild: (id) => { cancels.push(id); return true },
    },
  )
  policy.onHardStop = record => stops.push(record)
  policy.onRoundCount('c1', 3)
  await microtaskFlush()
  assert.equal(steers.length, 1, 'stage 1 landed')
  policy.onRoundCount('c1', 4)
  assert.deepEqual(cancels, [], 'grace round 1: no stop yet')
  policy.onRoundCount('c1', 5) // cap(3) + grace(2) = 5
  assert.deepEqual(cancels, ['c1'], 'stage 2: force-stopped at cap+grace')
  assert.deepEqual(stops, [{ childId: 'c1', round: 5, cap: 3, grace: 2 }], 'the stop is reported with cap facts')
  policy.onRoundCount('c1', 6)
  assert.equal(cancels.length, 1, 'no double stop')
  policy.dispose()
})

test('hard-stop ladder: a child that settles inside grace is never stopped', async () => {
  const { ctx } = ladderCtx({ cap: 3, grace: 1 })
  const cancels = []
  const settled = []
  const policy = applySubagentPolicy(ctx, {
    getLive: () => [],
    getRoundCount: () => 0,
    isSettled: () => true, // settled by the time stage 2 counts arrive
    cancelChild: (id) => { cancels.push(id); return true },
  })
  policy.onRoundCount('c1', 3)
  await microtaskFlush()
  policy.onRoundCount('c1', 4)
  assert.deepEqual(cancels, [], 'a self-completed child is left alone')
  policy.dispose()
})

test('hard-stop ladder: grace 0 collapses to the historical warn-only behavior', async () => {
  const { ctx, steers } = ladderCtx({ cap: 3, grace: 0 })
  const cancels = []
  const policy = applySubagentPolicy(ctx, {
    ...makeState({}),
    cancelChild: (id) => { cancels.push(id); return true },
  })
  for (const count of [3, 4, 5, 6, 10, 20]) {
    policy.onRoundCount('c1', count)
    await microtaskFlush()
  }
  assert.equal(steers.length, 1, 'the wrap-up landed once')
  assert.deepEqual(cancels, [], 'grace 0: never force-stopped')
  policy.dispose()
})

test('per-agent cap: the resolver overrides the global cap for a labeled child', async () => {
  const { ctx, steers } = ladderCtx({ cap: 100, grace: 2 })
  const resolved = []
  const policy = applySubagentPolicy(
    ctx,
    { ...makeState({ live: [{ childId: 'c1', label: 'workhorse' }] }) },
    label => { resolved.push(label); return label === 'workhorse' ? 5 : undefined },
  )
  policy.onRoundCount('c1', 4)
  await microtaskFlush()
  assert.deepEqual(steers, [], 'below the per-agent cap: nothing')
  policy.onRoundCount('c1', 5)
  await microtaskFlush()
  assert.equal(steers.length, 1, 'the per-agent cap (5) fired before the global (100)')
  assert.ok(steers[0].content[0].text.includes('5'), 'the wrap-up names the per-agent cap')
  policy.dispose()
})

test('per-agent cap: a resolver miss falls back to the global cap', async () => {
  const { ctx, steers } = ladderCtx({ cap: 4, grace: 1 })
  const policy = applySubagentPolicy(ctx, makeState({ live: [{ childId: 'c1', label: 'unknown-agent' }] }), () => undefined)
  policy.onRoundCount('c1', 3)
  await microtaskFlush()
  assert.deepEqual(steers, [], 'below the global cap: nothing')
  policy.onRoundCount('c1', 4)
  await microtaskFlush()
  assert.equal(steers.length, 1, 'the global cap applies on a resolver miss')
  policy.dispose()
})

test('per-agent cap: caps resolve once per child and stay frozen across stages', async () => {
  const { ctx } = ladderCtx({ cap: 3, grace: 1 })
  let resolveCount = 0
  const policy = applySubagentPolicy(ctx, {
    ...makeState({ live: [{ childId: 'c1', label: 'x' }] }),
    cancelChild: () => true,
  }, () => { resolveCount += 1; return 2 })
  policy.onRoundCount('c1', 2) // resolves (cap 2) → stage 1
  await microtaskFlush()
  policy.onRoundCount('c1', 3) // stage 2 at 2+1: must reuse the frozen cap
  policy.onRoundCount('c1', 4)
  assert.equal(resolveCount, 1, 'one resolution per child, cached')
  policy.dispose()
})

// ---------------------------------------------------------- ancestor walk --

test('ancestor walk: a child caller descending from a marked root is enforced', () => {
  const { ctx, captured } = makeCtx({
    settings: makeSettings({ maxAgents: 1, maxRounds: 50 }),
    agentsById: {
      // The calling child's parent chain: child → mid (unmarked) → root (marked).
      mid: { session: { header: { parentSession: 'root-1' } } },
      'root-1': tuiAgent(),
    },
  })
  const live = [{ label: 'a' }]
  const policy = applySubagentPolicy(ctx, makeState({ live }))
  const childCaller = { session: { header: { parentSession: 'mid' } } }
  const denial = captured.guard({ name: 'use_agent', agent: childCaller })
  assert.ok(typeof denial === 'string', 'a TUI-descended grandchild caller IS capped')
  policy.dispose()
})

test('ancestor walk: a foreign root stays fail-open', () => {
  const { ctx, captured } = makeCtx({
    settings: makeSettings({ maxAgents: 1, maxRounds: 50 }),
    agentsById: {
      mid: { session: { header: { parentSession: 'feishu-root' } } },
      'feishu-root': { ctx: { get() { return undefined } } },
    },
  })
  const live = [{ label: 'a' }]
  const policy = applySubagentPolicy(ctx, makeState({ live }))
  const childCaller = { session: { header: { parentSession: 'mid' } } }
  assert.equal(captured.guard({ name: 'use_agent', agent: childCaller }), undefined, 'a foreign-descended caller passes')
  policy.dispose()
})

test('ancestor walk: a broken chain (absent parent) fails open, cyclic headers terminate', () => {
  const { ctx, captured } = makeCtx({
    settings: makeSettings({ maxAgents: 1, maxRounds: 50 }),
    agentsById: {
      orphan: undefined, // get() returns undefined — chain dead end
      cyc_a: { session: { header: { parentSession: 'cyc_b' } } },
      cyc_b: { session: { header: { parentSession: 'cyc_a' } } },
    },
  })
  const live = [{ label: 'a' }, { label: 'b' }]
  const policy = applySubagentPolicy(ctx, makeState({ live }))
  // Over the cap either way — the assertion is the DECISION, not the scope:
  // both unmarked callers must pass (fail open), never throw.
  assert.equal(captured.guard({ name: 'use_agent', agent: { session: { header: { parentSession: 'orphan' } } } }), undefined)
  assert.equal(captured.guard({ name: 'use_agent', agent: { session: { header: { parentSession: 'cyc_a' } } } }), undefined)
  assert.equal(captured.guard({ name: 'use_agent', agent: { session: {} } }), undefined, 'no header: fail open')
  assert.equal(captured.guard({ name: 'use_agent', agent: undefined }), undefined, 'no agent: fail open')
  policy.dispose()
})

// ------------------------------------------ synchronous admission ledger ----

test('a same-step burst cannot overshoot: 6 parallel spawn calls admit exactly maxAgents', () => {
  // The 2026-09-10 incident: six background use_agent calls inside ONE
  // assistant message all passed a cap of 2 because the guard read the
  // bridge's async discovery count (still 0) on every call. The admission
  // ledger counts each allowance synchronously, so the burst denies itself.
  const { ctx, captured } = makeCtx({ settings: makeSettings({ maxAgents: 2, maxRounds: 50 }) })
  const policy = applySubagentPolicy(ctx, makeState({ live: [] }))
  const results = []
  for (let i = 0; i < 6; i += 1) results.push(captured.guard({ name: 'use_agent', agent: tuiAgent() }))
  const allowed = results.filter(reason => reason === undefined).length
  assert.equal(allowed, 2, 'exactly maxAgents admissions inside the burst')
  assert.equal(results.length - allowed, 4, 'the remaining calls are denied synchronously')
  for (const denial of results.filter(reason => reason !== undefined)) {
    assert.ok(denial.includes('Agent limit reached (2/2)'), 'the denial names the effective count')
    assert.ok(denial.includes('todo_write'), 'the denial directs the model to record the task')
    assert.ok(denial.includes('subagent_status'), 'the denial points at the live-board tool')
  }
  policy.dispose()
})

test('the ledger reconciles: discovered children consume slots, settled children free them', () => {
  const { ctx, captured } = makeCtx({ settings: makeSettings({ maxAgents: 2, maxRounds: 50 }) })
  const live = []
  const policy = applySubagentPolicy(ctx, makeState({ live }))

  // Two admissions while the board is empty — the third call already denies.
  assert.equal(captured.guard({ name: 'use_agent', agent: tuiAgent() }), undefined)
  assert.equal(captured.guard({ name: 'use_agent', agent: tuiAgent() }), undefined)
  assert.equal(typeof captured.guard({ name: 'use_agent', agent: tuiAgent() }), 'string', 'cap held pre-discovery')

  // The bridge discovers both children: they consume the two in-flight
  // entries, so the estimate must stay exactly 2 — no phantom slot appears.
  live.push({ childId: 'a', label: 'a' }, { childId: 'b', label: 'b' })
  assert.equal(typeof captured.guard({ name: 'use_agent', agent: tuiAgent() }), 'string', 'still at cap post-discovery')

  // One child settles: its slot frees.
  live.splice(0, 1)
  assert.equal(captured.guard({ name: 'use_agent', agent: tuiAgent() }), undefined, 'a settled child frees its slot')
  assert.equal(typeof captured.guard({ name: 'use_agent', agent: tuiAgent() }), 'string', 'the freed slot is taken again')
  policy.dispose()
})

test('settle and discovery interleaving never leaks a phantom slot', () => {
  // The delta-counting trap: one child settles while another is discovered
  // BETWEEN two guard calls — live length is unchanged, but one in-flight
  // entry must still be consumed. The credited-id ledger gets this right
  // where a live-count-delta reconciliation would double-hold the slot.
  const { ctx, captured } = makeCtx({ settings: makeSettings({ maxAgents: 2, maxRounds: 50 }) })
  const live = []
  const policy = applySubagentPolicy(ctx, makeState({ live }))

  assert.equal(captured.guard({ name: 'use_agent', agent: tuiAgent() }), undefined, 'A admitted')
  live.push({ childId: 'A', label: 'A' })
  assert.equal(captured.guard({ name: 'use_agent', agent: tuiAgent() }), undefined, 'A discovered (entry consumed); B admitted')
  // Between calls: A settles off the board AND B is discovered (net delta 0).
  live.splice(0, 1)
  live.push({ childId: 'B', label: 'B' })
  assert.equal(
    captured.guard({ name: 'use_agent', agent: tuiAgent() }),
    undefined,
    'exactly one slot is in use (B) — no phantom in-flight slot survives the swap',
  )
  assert.equal(typeof captured.guard({ name: 'use_agent', agent: tuiAgent() }), 'string', 'the second slot denies again once taken')
  policy.dispose()
})

test('an in-flight admission expires: a spawn that never materializes releases its slot', (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const { ctx, captured } = makeCtx({ settings: makeSettings({ maxAgents: 1, maxRounds: 50 }) })
  const policy = applySubagentPolicy(ctx, makeState({ live: [] }))
  assert.equal(captured.guard({ name: 'use_agent', agent: tuiAgent() }), undefined, 'admitted')
  assert.equal(typeof captured.guard({ name: 'use_agent', agent: tuiAgent() }), 'string', 'cap 1: the in-flight admission holds the slot')
  t.mock.timers.tick(60_000)
  assert.equal(captured.guard({ name: 'use_agent', agent: tuiAgent() }), undefined, 'the stale admission expired; the slot is back')
  policy.dispose()
})

test('getStats reports the runtime counters', () => {
  const { ctx, captured } = makeCtx({ settings: makeSettings({ maxAgents: 2, maxRounds: 50 }) })
  const live = [{ childId: 'x', label: 'x' }]
  const policy = applySubagentPolicy(ctx, makeState({ live }))
  captured.guard({ name: 'use_agent', agent: tuiAgent() }) // allowed → live 1 + in-flight 1 = cap
  captured.guard({ name: 'use_agent', agent: tuiAgent() }) // denied
  assert.deepEqual(policy.getStats(), { live: 1, allowed: 1, denied: 1, pruned: 0, inFlight: 1 })
  policy.dispose()
})

// --------------------------------------------------- registeredOnly fence --

test('registeredOnly fences EVERY spawn tool except use_agent', () => {
  // The 2026-09-10 live-test leak: ad-hoc children labeled with task
  // descriptions ("实现 …") rode the non-registry spawn tools. With the
  // fence on, a child may only ever be backed by a registered agent
  // definition — everything else is denied at the guard.
  const { ctx, captured } = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 50, disableSubagent: false, registeredOnly: true }),
  })
  const policy = applySubagentPolicy(ctx, makeState({ live: [] }))
  for (const name of ['subagent', 'subagent_fork', 'workflow', 'ralph']) {
    const denial = captured.guard({ name, agent: tuiAgent() })
    assert.equal(typeof denial, 'string', `${name} denied under the registered-only fence`)
    assert.ok(denial.includes('use_agent'), `the ${name} denial points at the registry tool`)
  }
  assert.equal(captured.guard({ name: 'use_agent', agent: tuiAgent() }), undefined, 'the registry tool itself passes')
  policy.dispose()
})

test('registeredOnly is off by default and surface-scoped', () => {
  // Off by default: the ad-hoc tools pass when the knob is absent.
  const off = makeCtx({ settings: makeSettings({ maxAgents: 4, maxRounds: 50, disableSubagent: false }) })
  const offPolicy = applySubagentPolicy(off.ctx, makeState({ live: [] }))
  for (const name of ['subagent_fork', 'workflow', 'ralph']) {
    assert.equal(off.captured.guard({ name, agent: tuiAgent() }), undefined, `${name} allowed with the fence off`)
  }
  offPolicy.dispose()

  // Surface scope: a foreign caller fails open even with the fence on.
  const on = makeCtx({
    settings: makeSettings({ maxAgents: 4, maxRounds: 50, disableSubagent: false, registeredOnly: true }),
  })
  const onPolicy = applySubagentPolicy(on.ctx, makeState({ live: [] }))
  for (const name of SPAWN_TOOLS) {
    assert.equal(on.captured.guard({ name, agent: foreignAgent() }), undefined, `foreign ${name}: fail open`)
  }
  onPolicy.dispose()
})

test('the registeredOnly fence reason wins over the cap reason', () => {
  // At the cap AND fenced: the fence is the reported reason — the tool rule
  // is the primary contract (same precedence as the disableSubagent fence).
  const { ctx, captured } = makeCtx({
    settings: makeSettings({ maxAgents: 1, maxRounds: 50, disableSubagent: false, registeredOnly: true }),
  })
  const policy = applySubagentPolicy(ctx, makeState({ live: [{ childId: 'a', label: 'busy' }] }))
  const denial = captured.guard({ name: 'subagent_fork', agent: tuiAgent() })
  assert.ok(denial.includes('Ad-hoc subagents are disabled'), 'the fence reason wins')
  assert.ok(!denial.includes('Agent limit reached'), 'no cap reason leaks through')
  policy.dispose()
})
