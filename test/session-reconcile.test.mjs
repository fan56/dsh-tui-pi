/**
 * Regression: the bridge's per-child turn counting must survive a child whose
 * own `session/event` stream never bubbles to the plugin (the "rounds always
 * 0 / maxRounds never fires" symptom). Discovery lists such a child from the
 * PARENT's `tool-workflow/agent-start`, but its turns only ever land in the
 * child's authoritative session log (`ctx.sessions`). `reconcileChildTurns`
 * re-derives the count from that log and fires `onTurnCount` so both the
 * viewer's "rounds N/M" and the maxRounds policy see the true value — and it
 * never double-counts against the event-driven path.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { DshSessionBridge } from '../lib/session.js'

/** A minimal harness: capture `session/event`, expose a fake ctx.sessions store. */
function makeHarness() {
  const handlers = new Map()
  const childEvents = []
  const ctx = {
    on(evt, fn) { handlers.set(evt, fn); return () => handlers.delete(evt) },
    get() { return undefined },
    sessions: {
      get(id) { return String(id) === 'child-1' ? { events: childEvents } : undefined },
    },
    agents: {
      async create() { return { agent: { session: { id: 'root-session' } }, async dispose() {} } },
    },
  }
  return { ctx, handlers, childEvents }
}

/** Feed one event through the bridge's captured `session/event` subscription. */
function emit(handlers, session, event) {
  handlers.get('session/event')(session, event)
}

function discoverViaParentWorkflow(handlers, childId) {
  emit(handlers, { id: 'root-session', header: {} }, {
    type: 'tool-workflow/agent-start',
    time: 1,
    data: { runId: 'r1', seq: 0, label: 'workhorse', childId },
  })
}

test('reconcileChildTurns recovers a child turn count from the session log when events never reach', async () => {
  const { ctx, handlers, childEvents } = makeHarness()
  const fired = []
  const bridge = new DshSessionBridge(ctx, {
    onTurnCount: (c, n) => fired.push([c, n]),
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  discoverViaParentWorkflow(handlers, 'child-1')
  assert.equal(bridge.getTurnCount('child-1'), 0, 'no events streamed yet')

  // The child works; only its own log grows (ctx.sessions), never the bridge.
  childEvents.push({ type: 'turn/end', seq: 1, time: 3, data: { turn: 1, reason: { kind: 'completed' } } })
  childEvents.push({ type: 'turn/end', seq: 3, time: 5, data: { turn: 2, reason: { kind: 'completed' } } })
  bridge.reconcileChildTurns()

  assert.equal(bridge.getTurnCount('child-1'), 2, 'reconcile derived 2 turns from the log')
  assert.deepEqual(fired, [['child-1', 2]], 'onTurnCount fired so maxRounds can act')
  await bridge.dispose()
})

test('reconcileChildTurns never double-counts against the event-driven path', async () => {
  const { ctx, handlers, childEvents } = makeHarness()
  const fired = []
  const bridge = new DshSessionBridge(ctx, {
    onTurnCount: (c, n) => fired.push([c, n]),
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  discoverViaParentWorkflow(handlers, 'child-1')
  const childSession = { id: 'child-1', header: { origin: 'subagent', parentSession: 'root-session' } }

  // Two turns arrive BOTH as bridged events and in the log (healthy path).
  for (const t of [1, 2]) {
    const event = { type: 'turn/end', seq: t * 2 - 1, time: 10 + t, data: { turn: t, reason: { kind: 'completed' } } }
    childEvents.push(event)
    emit(handlers, childSession, event)
  }
  assert.equal(bridge.getTurnCount('child-1'), 2, 'event path counted 2')
  bridge.reconcileChildTurns()
  assert.equal(bridge.getTurnCount('child-1'), 2, 'reconcile did not double count')

  // A third turn only in the log (events lost) — reconcile corrects upward.
  childEvents.push({ type: 'turn/end', seq: 5, time: 20, data: { turn: 3, reason: { kind: 'completed' } } })
  bridge.reconcileChildTurns()
  assert.equal(bridge.getTurnCount('child-1'), 3, 'reconcile corrected 2 -> 3 without duplication')
  assert.equal(fired[fired.length - 1][1], 3, 'onTurnCount last fired with 3')
  await bridge.dispose()
})

test('reconcileChildTurns is a no-op when the sessions service is absent', async () => {
  const { ctx, handlers } = makeHarness()
  delete ctx.sessions // simulate an environment without ctx.sessions
  const fired = []
  const bridge = new DshSessionBridge(ctx, {
    onTurnCount: (c, n) => fired.push([c, n]),
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  discoverViaParentWorkflow(handlers, 'child-1')
  bridge.reconcileChildTurns() // must not throw, must not fabricate a count
  assert.equal(bridge.getTurnCount('child-1'), 0)
  assert.deepEqual(fired, [])
  await bridge.dispose()
})
