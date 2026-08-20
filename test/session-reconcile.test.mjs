/**
 * Regression: the bridge's per-child round counting must survive a child
 * whose own `session/event` stream never bubbles to the plugin (the "rounds
 * always 0 / maxRounds never fires" symptom). Discovery lists such a child
 * from the PARENT's `tool-workflow/agent-start`, but its messages only ever
 * land in the child's authoritative session log (`ctx.sessions`).
 * `reconcileChildRounds` re-derives the count from that log and fires
 * `onRoundCount` so both the viewer's "rounds N/M" and the maxRounds policy
 * see the true value — and it never double-counts against the event-driven
 * path. Rounds are counted on `assistant/message` (one per LLM round-trip;
 * a one-shot child never advances `turn/end` while it works).
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

/** One assistant message (an LLM round-trip) — the round-counting unit. */
function assistantMessage(seq, time, usage) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'working…' }] },
      ...(usage === undefined ? {} : { usage }),
    },
  }
}

/** The main session the bridge lazily creates (`ctx.agents.create` above). */
function mainSession() {
  return { id: 'root-session', header: {} }
}

/** One main-session assistant message with a usage snapshot. */
function mainAssistantMessage(seq, time, usage) {
  return { ...assistantMessage(seq, time, usage) }
}

test('a running child counts one round per assistant/message — never per turn/end', async () => {
  // The core semantic: round = one LLM round-trip (assistant/message). A
  // one-shot child lives its whole life inside a single turn, so turn/end is
  // structurally inert for progress — only messages advance the counter.
  const { ctx, handlers } = makeHarness()
  const fired = []
  const bridge = new DshSessionBridge(ctx, {
    onRoundCount: (c, n) => fired.push([c, n]),
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  // Discover the child through its session header (the primary path).
  emit(handlers, { id: 'child-1', header: { origin: 'subagent', parentSession: 'root-session', delegationDepth: 1 } }, {
    type: 'subagent/descriptor',
    seq: 0,
    time: 2,
    data: { version: 1, mode: 'one-shot', provider: 'workhorse' },
  })
  const childSession = { id: 'child-1', header: { origin: 'subagent', parentSession: 'root-session', delegationDepth: 1 } }

  emit(handlers, childSession, assistantMessage(1, 10))
  assert.equal(bridge.getRoundCount('child-1'), 1, 'one assistant/message = round 1')
  assert.equal(bridge.getAgentViews()[0].rounds, 1, 'the view row carries the count for the widget')

  // turn/end does NOT advance rounds (a one-shot child never leaves its turn).
  emit(handlers, childSession, {
    type: 'turn/end', seq: 2, time: 11, data: { turn: 1, reason: { kind: 'stop' } },
  })
  assert.equal(bridge.getRoundCount('child-1'), 1, 'turn/end is not a round')

  // The next LLM round-trip advances again.
  emit(handlers, childSession, assistantMessage(3, 20))
  assert.equal(bridge.getRoundCount('child-1'), 2, 'a second assistant/message = round 2')
  assert.equal(bridge.getAgentViews()[0].rounds, 2, 'the view rounds follows the counter')
  assert.deepEqual(fired, [['child-1', 1], ['child-1', 2]], 'onRoundCount fired once per message')
  await bridge.dispose()
})

test('reconcileChildRounds recovers a child round count from the session log when events never reach', async () => {
  const { ctx, handlers, childEvents } = makeHarness()
  const fired = []
  const bridge = new DshSessionBridge(ctx, {
    onRoundCount: (c, n) => fired.push([c, n]),
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  discoverViaParentWorkflow(handlers, 'child-1')
  assert.equal(bridge.getRoundCount('child-1'), 0, 'no events streamed yet')

  // The child works; only its own log grows (ctx.sessions), never the bridge.
  childEvents.push(assistantMessage(1, 3))
  childEvents.push(assistantMessage(3, 5))
  bridge.reconcileChildRounds()

  assert.equal(bridge.getRoundCount('child-1'), 2, 'reconcile derived 2 rounds from the log')
  assert.deepEqual(fired, [['child-1', 2]], 'onRoundCount fired so maxRounds can act')
  await bridge.dispose()
})

test('reconcileChildRounds never double-counts against the event-driven path', async () => {
  const { ctx, handlers, childEvents } = makeHarness()
  const fired = []
  const bridge = new DshSessionBridge(ctx, {
    onRoundCount: (c, n) => fired.push([c, n]),
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  discoverViaParentWorkflow(handlers, 'child-1')
  const childSession = { id: 'child-1', header: { origin: 'subagent', parentSession: 'root-session', delegationDepth: 1 } }

  // Two rounds arrive BOTH as bridged events and in the log (healthy path).
  for (const seq of [1, 3]) {
    const event = assistantMessage(seq, 10 + seq)
    childEvents.push(event)
    emit(handlers, childSession, event)
  }
  assert.equal(bridge.getRoundCount('child-1'), 2, 'event path counted 2')
  bridge.reconcileChildRounds()
  assert.equal(bridge.getRoundCount('child-1'), 2, 'reconcile did not double count')

  // A third round only in the log (events lost) — reconcile corrects upward.
  childEvents.push(assistantMessage(5, 20))
  bridge.reconcileChildRounds()
  assert.equal(bridge.getRoundCount('child-1'), 3, 'reconcile corrected 2 -> 3 without duplication')
  assert.equal(fired[fired.length - 1][1], 3, 'onRoundCount last fired with 3')
  await bridge.dispose()
})

test('reconcileChildRounds is a no-op when the sessions service is absent', async () => {
  const { ctx, handlers } = makeHarness()
  delete ctx.sessions // simulate an environment without ctx.sessions
  const fired = []
  const bridge = new DshSessionBridge(ctx, {
    onRoundCount: (c, n) => fired.push([c, n]),
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  discoverViaParentWorkflow(handlers, 'child-1')
  bridge.reconcileChildRounds() // must not throw, must not fabricate a count
  assert.equal(bridge.getRoundCount('child-1'), 0)
  assert.deepEqual(fired, [])
  await bridge.dispose()
})

// ---------------------------------------------------------------------------
// Current-occupancy semantics (Task B): the footer/subagent `X/Y` numerator is
// the LATEST request's billed context, not the cumulative token spend — that
// total only grows, while the occupancy follows the latest request and drops
// after a compaction. The regression: a session whose cumulative input would
// show 175% of the window must price at ~33% (the last request) instead.

test('footer occupancy = the latest request (billed input + output), never the cumulative total', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  const session = mainSession()
  // Request 1: 142_400 input + 1_000 output.
  emit(handlers, session, mainAssistantMessage(1, 10, {
    inputTokens: 142400, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0,
  }))
  // Request 2: 32_600 input + 800 output → cumulative input = 175_000.
  emit(handlers, session, mainAssistantMessage(2, 20, {
    inputTokens: 32600, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0,
  }))
  const stats = bridge.getStats()
  // The cumulative total is still tracked — it feeds the /session panel's
  // four token buckets (tokens in/out, cache read/write) and the cache-hit
  // rate. The Context segment numerator is a DIFFERENT number.
  assert.equal(stats.inputTokens, 175000, 'cumulative inputTokens still tracked (the /session panel number)')
  // Old numerator (cumulative) would be 175_000/100_000 = 175.0%; the new one
  // is the last request: 32_600 (billed input) + 800 (output) = 33_400 → 33.4%.
  assert.equal(stats.contextTokens, 33400, 'occupancy = latest request billed input + output, NOT cumulative')
  await bridge.dispose()
})

test('the latest request\'s billed input includes its cache read/write buckets', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  const session = mainSession()
  // inputTokens is uncached input; billed input = input + cacheRead + cacheWrite
  // (the four TokenUsage buckets are disjoint — cache is never double-counted).
  emit(handlers, session, mainAssistantMessage(1, 1, {
    inputTokens: 2000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 300,
  }))
  assert.equal(bridge.getStats().contextTokens, 2000 + 500 + 300 + 100,
    'latest billed input includes cache read/write on top of the uncached input')
  // The cumulative cache buckets feed the cache-hit rate, not the occupancy.
  assert.equal(bridge.getStats().cacheReadTokens, 500, 'cumulative cacheReadTokens still tracked')
  await bridge.dispose()
})

test('subagent occupancy = latest request, while view.tokens stays cumulative (viewer/session semantics)', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  const childSession = { id: 'child-1', header: { origin: 'subagent', parentSession: 'root-session', delegationDepth: 1 } }
  // Discover the child through its header (the primary path).
  emit(handlers, childSession, {
    type: 'subagent/descriptor', seq: 0, time: 1,
    data: { version: 1, mode: 'one-shot', provider: 'workhorse' },
  })
  // Child round 1: 9_000 input + 500 output.
  emit(handlers, childSession, assistantMessage(1, 2, { inputTokens: 9000, outputTokens: 500 }))
  // Child round 2: 1_700 input + 300 output.
  emit(handlers, childSession, assistantMessage(2, 3, { inputTokens: 1700, outputTokens: 300 }))
  const view = bridge.getAgentViews()[0]
  assert.equal(view.tokens, 9000 + 500 + 1700 + 300,
    'view.tokens is the cumulative spend — the viewer picker/transcript and the /session panel number')
  assert.equal(view.contextTokens, 1700 + 300,
    'view.contextTokens is the compact `X/Y` numerator: the latest request only')
  // A child user/message after the last assistant message enters its next
  // request: 4 CJK chars -> 2 tokens, reflected in the occupancy (not tokens).
  emit(handlers, childSession, {
    type: 'user/message', seq: 4, time: 4,
    data: { content: [{ type: 'text', text: '继续执行' }], source: { kind: 'user' } },
  })
  const updated = bridge.getAgentViews()[0]
  assert.equal(updated.contextTokens, 1700 + 300 + 2, 'pending CJK estimate added to the child occupancy')
  assert.equal(updated.tokens, 11500, 'cumulative tokens untouched by the pending estimate')
  await bridge.dispose()
})

test('messages appended after the latest assistant/message are CJK-estimated into the occupancy', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  const session = mainSession()
  emit(handlers, session, mainAssistantMessage(1, 1, { inputTokens: 1000, outputTokens: 100 }))
  assert.equal(bridge.getStats().contextTokens, 1100, 'baseline: latest request billed input + output')

  // A user prompt (CJK) appended after the last message enters the NEXT
  // request — priced at its CJK ratio: 4 CJK chars -> 2.
  emit(handlers, session, {
    type: 'user/message', seq: 2, time: 2,
    data: { content: [{ type: 'text', text: '你好世界' }], source: { kind: 'user' } },
  })
  assert.equal(bridge.getStats().contextTokens, 1100 + 2, 'CJK user prompt priced at its CJK ratio')

  // A user prompt (ASCII) appended after it — priced at its ASCII ratio:
  // 11 chars -> ceil(11/4) = 3.
  emit(handlers, session, {
    type: 'user/message', seq: 3, time: 3,
    data: { content: [{ type: 'text', text: 'hello world' }], source: { kind: 'user' } },
  })
  assert.equal(bridge.getStats().contextTokens, 1100 + 2 + 3, 'ASCII user prompt priced at its ASCII ratio')

  // A tool result appended after it adds its text payload (16 chars -> 4).
  emit(handlers, session, {
    type: 'tool/result', seq: 4, time: 4,
    data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'tool output here' }] }] } },
  })
  assert.equal(bridge.getStats().contextTokens, 1100 + 2 + 3 + 4, 'tool result text priced after the last message')

  // The NEXT assistant/message resets the pending estimate — its usage
  // snapshot now covers everything up to it exactly.
  emit(handlers, session, mainAssistantMessage(5, 5, { inputTokens: 5000, outputTokens: 200 }))
  assert.equal(bridge.getStats().contextTokens, 5200,
    'a fresh usage snapshot replaces the pending estimate')
  await bridge.dispose()
})

// ---------------------------------------------------------------------------
// Usage-less tolerance (review fix): `usage` is optional on assistant/message —
// an adapter that never reports it must not zero the occupancy. The baseline
// stays put and the pending estimate (which already holds the streamed chunk
// estimate accumulated for the usage-less message) keeps standing in until the
// next billed message.

test('a usage-less assistant/message keeps the main occupancy baseline (never resets to 0)', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  const session = mainSession()
  // A billed message establishes the exact baseline.
  emit(handlers, session, mainAssistantMessage(1, 1, { inputTokens: 1000, outputTokens: 100 }))
  assert.equal(bridge.getStats().contextTokens, 1100, 'baseline from the billed message')
  // A user prompt after it is priced into pending.
  emit(handlers, session, {
    type: 'user/message', seq: 2, time: 2,
    data: { content: [{ type: 'text', text: '你好世界' }], source: { kind: 'user' } },
  })
  assert.equal(bridge.getStats().contextTokens, 1102, 'pending CJK estimate added')
  // A usage-less assistant/message must NOT wipe lastUsage nor clear pending:
  // the occupancy keeps its last billed baseline + the pending estimate.
  emit(handlers, session, mainAssistantMessage(3, 3))
  assert.equal(bridge.getStats().contextTokens, 1102,
    'usage-less message keeps the last billed baseline + pending, never 0')
  await bridge.dispose()
})

test('a usage-less child assistant/message keeps the child occupancy baseline', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  const childSession = { id: 'child-1', header: { origin: 'subagent', parentSession: 'root-session', delegationDepth: 1 } }
  emit(handlers, childSession, {
    type: 'subagent/descriptor', seq: 0, time: 1,
    data: { version: 1, mode: 'one-shot', provider: 'workhorse' },
  })
  // A billed child message establishes the exact baseline.
  emit(handlers, childSession, assistantMessage(1, 2, { inputTokens: 9000, outputTokens: 500 }))
  assert.equal(bridge.getAgentViews()[0].contextTokens, 9500, 'child baseline from the billed message')
  // A usage-less child message must NOT wipe childUsage nor clear pending.
  emit(handlers, childSession, assistantMessage(2, 3))
  assert.equal(bridge.getAgentViews()[0].contextTokens, 9500,
    'usage-less child message keeps the last billed baseline, never 0')
  await bridge.dispose()
})

// ---------------------------------------------------------------------------
// Chunk/usage accounting (review fix): streamed chunks are CJK-estimated into
// pending as the output flows; the finalized assistant/message with exact usage
// must replace that estimate so the output is counted exactly once — never
// double-counted by the residual chunk estimate.

test('a streamed text-delta chunk estimate is superseded by the next billed assistant/message', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  const session = mainSession()
  // Streamed text is priced into pending as the output flows.
  emit(handlers, session, {
    type: 'assistant/chunk', seq: 1, time: 1,
    data: { chunk: { type: 'text-delta', text: 'hello world' } },
  })
  assert.equal(bridge.getStats().contextTokens, 3,
    'streamed text-delta priced into pending (11 chars -> ceil 11/4 = 3)')
  // The finalized message with exact usage replaces the estimate.
  emit(handlers, session, mainAssistantMessage(2, 2, { inputTokens: 5000, outputTokens: 200 }))
  assert.equal(bridge.getStats().contextTokens, 5200,
    'billed usage clears the pending estimate — output counted exactly once')
  await bridge.dispose()
})

test('a streamed child text-delta chunk estimate is superseded by the next billed child message', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  const childSession = { id: 'child-1', header: { origin: 'subagent', parentSession: 'root-session', delegationDepth: 1 } }
  emit(handlers, childSession, {
    type: 'subagent/descriptor', seq: 0, time: 1,
    data: { version: 1, mode: 'one-shot', provider: 'workhorse' },
  })
  emit(handlers, childSession, {
    type: 'assistant/chunk', seq: 1, time: 2,
    data: { chunk: { type: 'text-delta', text: 'abcd' } },
  })
  assert.equal(bridge.getAgentViews()[0].contextTokens, 1,
    'child streamed text priced into pending (4 chars -> 1)')
  emit(handlers, childSession, assistantMessage(2, 3, { inputTokens: 1700, outputTokens: 300 }))
  assert.equal(bridge.getAgentViews()[0].contextTokens, 2000,
    'billed child usage clears the pending estimate — output counted exactly once')
  await bridge.dispose()
})

// ---------------------------------------------------------------------------
// reasoning-delta pricing (review fix): usage.outputTokens includes reasoning
// tokens at snapshot time, so the live pending estimate must count
// reasoning-delta chunks too to stay consistent with that accounting.

test('assistant/chunk reasoning-delta prices into the main pending estimate', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  const session = mainSession()
  emit(handlers, session, {
    type: 'assistant/chunk', seq: 1, time: 1,
    data: { chunk: { type: 'reasoning-delta', text: 'reasoning' } },
  })
  assert.equal(bridge.getStats().contextTokens, 3,
    'reasoning-delta priced into pending (9 chars -> ceil 9/4 = 3)')
  await bridge.dispose()
})

test('child assistant/chunk reasoning-delta prices into the child pending estimate', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  const childSession = { id: 'child-1', header: { origin: 'subagent', parentSession: 'root-session', delegationDepth: 1 } }
  emit(handlers, childSession, {
    type: 'subagent/descriptor', seq: 0, time: 1,
    data: { version: 1, mode: 'one-shot', provider: 'workhorse' },
  })
  emit(handlers, childSession, {
    type: 'assistant/chunk', seq: 1, time: 2,
    data: { chunk: { type: 'reasoning-delta', text: 'abcd' } },
  })
  assert.equal(bridge.getAgentViews()[0].contextTokens, 1,
    'child reasoning-delta priced into pending (4 chars -> 1)')
  await bridge.dispose()
})

// ---------------------------------------------------------------------------
// Fork-driven child visibility: a fork lineage writes `parentSession` +
// `delegationDepth` but NOT `origin: 'subagent'` — the old discovery gate
// required the origin, so fork children never showed on the widget / Ctrl+G.
// The gate now requires the durable delegation budget instead (which BOTH the
// spawn and fork paths write), and the user-facing `Session.fork` lineage
// (parentSession + seedLength, no budget) stays off the board.

test('a fork-driven child (no origin, delegationDepth) is discovered and folds rounds', async () => {
  const { ctx, handlers } = makeHarness()
  const fired = []
  const bridge = new DshSessionBridge(ctx, {
    onRoundCount: (c, n) => fired.push([c, n]),
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  // Fork lineage: parentSession points at a tracked session, delegationDepth
  // is set, origin is absent — the fork child must still be discovered.
  const forkChild = { id: 'fork-1', header: { parentSession: 'root-session', delegationDepth: 1, seedLength: 4 } }
  emit(handlers, forkChild, assistantMessage(1, 10))
  assert.equal(bridge.getAgentViews().length, 1, 'fork child discovered via header')
  const view = bridge.getAgentViews()[0]
  assert.equal(view.childId, 'fork-1')
  assert.equal(view.parentSession, 'root-session')
  assert.equal(view.label, 'fork fork-1', 'fork children get the fork label (no descriptor refines it)')
  assert.equal(view.rounds, 1, 'rounds fold from the child own events')
  assert.equal(bridge.getRoundCount('fork-1'), 1)
  assert.equal(bridge.getChildLog('fork-1').length, 1, 'the child transcript buffers its own events')
  assert.equal(bridge.getLiveChildren().length, 1, 'a running fork child enables Ctrl+G')
  assert.deepEqual(fired, [['fork-1', 1]])
  await bridge.dispose()
})

test('a session whose parentSession is NOT tracked is not discovered', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  const stranger = { id: 'x-1', header: { parentSession: 'some-other', delegationDepth: 1 } }
  emit(handlers, stranger, assistantMessage(1, 10))
  assert.equal(bridge.getAgentViews().length, 0, 'not discovered — parent is not a tracked session')
  assert.equal(bridge.getLiveChildren().length, 0)
  await bridge.dispose()
})

test('a session with no parentSession and no origin is not discovered', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  const root = { id: 'root-2', header: {} }
  emit(handlers, root, assistantMessage(1, 10))
  assert.equal(bridge.getAgentViews().length, 0, 'a root-like session is never a child')
  await bridge.dispose()
})

test('a user-facing session fork (parentSession tracked, NO delegationDepth) is not discovered', async () => {
  // The guard: dsh's `Session.fork` lineage is parentSession + seedLength
  // only — a forked conversation is a real session, not a subagent, and must
  // not appear on the live board / Ctrl+G.
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  const userFork = { id: 'fork-user', header: { parentSession: 'root-session', seedLength: 2 } }
  emit(handlers, userFork, assistantMessage(1, 10))
  assert.equal(bridge.getAgentViews().length, 0, 'user fork stays off the subagent board')
  assert.equal(bridge.getLiveChildren().length, 0)
  await bridge.dispose()
})
