/**
 * CH (cache-hit) reset-on-route-change tests: a `request/header` event whose
 * provider/model VALUE differs from the running baseline restarts the CH
 * accumulators (input/cacheRead/cacheWrite totals + cacheHitRate); a
 * same-value header — including the resume pseudo-event that re-emits an
 * identical header for unchanged content — must NOT reset; the first header
 * (initial) only establishes the baseline.
 *
 * Contract under test:
 * - Normal accumulation: usage folds into the cumulative totals and the rate
 *   is cacheRead ÷ billed input (input + cacheRead + cacheWrite).
 * - Route change: the next assistant/message's usage starts from zero —
 *   pre-switch tokens no longer dilute the new route's rate.
 * - Same-value headers (any reason): totals keep growing across them.
 * - Route-independent stats survive a reset: outputTokens, msgCount,
 *   toolCallCount, contextTokens are untouched.
 * - Replay re-segments identically: feeding the same log through `replay`
   yields the same post-switch totals as the live path.
 *
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DshSessionBridge } from '../lib/session.js'

/** A minimal harness: capture `session/event`, expose the main session. */
function makeHarness() {
  const handlers = new Map()
  const ctx = {
    on(evt, fn) { handlers.set(evt, fn); return () => handlers.delete(evt) },
    get() { return undefined },
    sessions: { get() { return undefined } },
    agents: {
      async create() { return { agent: { session: { id: 'root-session' } }, async dispose() {} } },
    },
  }
  return { ctx, handlers, session: { id: 'root-session', header: {} } }
}

function emit(h, event) {
  h.handlers.get('session/event')(h.session, event)
}

function headerEvent(seq, time, provider, model, reason) {
  return {
    type: 'request/header',
    seq,
    time,
    data: { header: { config: { provider, model } }, reason },
  }
}

function assistantMessage(seq, time, usage) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'ok' }] },
      usage,
    },
  }
}

async function makeBridge(h, callbacks = {}) {
  const bridge = new DshSessionBridge(h.ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {}, ...callbacks,
  })
  await bridge.ensureAgent()
  return bridge
}

test('usage accumulates normally under one route', async () => {
  const h = makeHarness()
  const bridge = await makeBridge(h)
  emit(h, headerEvent(1, 10, 'deepseek', 'deepseek-chat', 'initial'))
  emit(h, assistantMessage(2, 20, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 }))
  let s = bridge.getStats()
  assert.equal(s.inputTokens, 100)
  assert.equal(s.cacheReadTokens, 900)
  assert.equal(s.cacheHitRate, 90) // 900 / (100+900+0)
  // A second message keeps accumulating.
  emit(h, assistantMessage(3, 30, { inputTokens: 50, outputTokens: 5, cacheReadTokens: 950, cacheWriteTokens: 0 }))
  s = bridge.getStats()
  assert.equal(s.inputTokens, 150)
  assert.equal(s.cacheReadTokens, 1850)
  assert.equal(s.cacheHitRate, (1850 / 2000) * 100)
  await bridge.dispose()
})

test('a provider/model value change resets the CH accumulators', async () => {
  const h = makeHarness()
  const bridge = await makeBridge(h)
  emit(h, headerEvent(1, 10, 'deepseek', 'deepseek-chat', 'initial'))
  emit(h, assistantMessage(2, 20, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 50 }))
  emit(h, headerEvent(3, 30, 'minimax-cn', 'MiniMax-M3', 'change'))
  // Rate is hidden until the next billed message arrives on the new route.
  assert.equal(bridge.getStats().cacheHitRate, undefined)
  assert.equal(bridge.getStats().inputTokens, 0)
  assert.equal(bridge.getStats().cacheReadTokens, 0)
  assert.equal(bridge.getStats().cacheWriteTokens, 0)
  // The first message on the new route prices alone.
  emit(h, assistantMessage(4, 40, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 800, cacheWriteTokens: 0 }))
  const s = bridge.getStats()
  assert.equal(s.inputTokens, 200)
  assert.equal(s.cacheReadTokens, 800)
  assert.equal(s.cacheHitRate, 80) // 800 / 1000 — not diluted by the old route
  await bridge.dispose()
})

test('same-value headers never reset — change and resume pseudo-events alike', async () => {
  const h = makeHarness()
  const bridge = await makeBridge(h)
  emit(h, headerEvent(1, 10, 'deepseek', 'deepseek-chat', 'initial'))
  emit(h, assistantMessage(2, 20, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 }))
  // reason='resume' with identical values (the resume pseudo-event).
  emit(h, headerEvent(3, 30, 'deepseek', 'deepseek-chat', 'resume'))
  // reason='change' but values unchanged (system prompt changed, route did not).
  emit(h, headerEvent(4, 40, 'deepseek', 'deepseek-chat', 'change'))
  emit(h, assistantMessage(5, 50, { inputTokens: 50, outputTokens: 5, cacheReadTokens: 950, cacheWriteTokens: 0 }))
  const s = bridge.getStats()
  assert.equal(s.inputTokens, 150, 'pseudo-headers do not clear the input total')
  assert.equal(s.cacheReadTokens, 1850)
  assert.equal(s.cacheHitRate, (1850 / 2000) * 100)
  await bridge.dispose()
})

test('a model-only or provider-only change also resets', async () => {
  for (const [provider, model] of [['deepseek', 'deepseek-reasoner'], ['minimax-cn', 'deepseek-chat']]) {
    const h = makeHarness()
    const bridge = await makeBridge(h)
    emit(h, headerEvent(1, 10, 'deepseek', 'deepseek-chat', 'initial'))
    emit(h, assistantMessage(2, 20, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 }))
    emit(h, headerEvent(3, 30, provider, model, 'change'))
    assert.equal(bridge.getStats().inputTokens, 0, `${provider}/${model} resets`)
    await bridge.dispose()
  }
})

test('route-independent stats survive the CH reset', async () => {
  const h = makeHarness()
  const bridge = await makeBridge(h)
  emit(h, headerEvent(1, 10, 'deepseek', 'deepseek-chat', 'initial'))
  emit(h, { type: 'user/message', seq: 2, time: 15, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } })
  emit(h, assistantMessage(3, 20, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 }))
  const before = bridge.getStats()
  emit(h, headerEvent(4, 30, 'minimax-cn', 'MiniMax-M3', 'change'))
  const after = bridge.getStats()
  assert.equal(after.outputTokens, before.outputTokens, 'outputTokens keeps running')
  assert.equal(after.msgCount, before.msgCount, 'msgCount keeps running')
  assert.equal(after.toolCallCount, before.toolCallCount, 'toolCallCount keeps running')
  assert.equal(after.contextTokens, before.contextTokens, 'context occupancy is route-independent')
  await bridge.dispose()
})

test('usage before the first header — the late header only sets the baseline', async () => {
  const h = makeHarness()
  const bridge = await makeBridge(h)
  // Legacy log: no request/header was ever recorded, usage arrives first.
  emit(h, assistantMessage(1, 10, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 50 }))
  let s = bridge.getStats()
  assert.equal(s.inputTokens, 100)
  assert.equal(s.cacheHitRate, (900 / 1050) * 100)
  // The first header arrives after the fact (e.g. replay of a legacy log):
  // it must ONLY establish the baseline — never reset what already happened.
  emit(h, headerEvent(2, 20, 'deepseek', 'deepseek-chat', 'initial'))
  s = bridge.getStats()
  assert.equal(s.inputTokens, 100, 'the initial header does not clear pre-baseline input')
  assert.equal(s.cacheReadTokens, 900)
  assert.equal(s.cacheWriteTokens, 50)
  assert.equal(s.cacheHitRate, (900 / 1050) * 100)
  // Same-route messages keep accumulating under the established baseline.
  emit(h, assistantMessage(3, 30, { inputTokens: 40, outputTokens: 4, cacheReadTokens: 960, cacheWriteTokens: 0 }))
  s = bridge.getStats()
  assert.equal(s.inputTokens, 140)
  assert.equal(s.cacheHitRate, (1860 / 2050) * 100) // billed keeps the carried-over cacheWriteTokens
  await bridge.dispose()
})

test('replay re-segments CH history identically to the live path', async () => {
  const log = [
    headerEvent(1, 10, 'deepseek', 'deepseek-chat', 'initial'),
    assistantMessage(2, 20, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 }),
    headerEvent(3, 30, 'minimax-cn', 'MiniMax-M3', 'change'),
    assistantMessage(4, 40, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 800, cacheWriteTokens: 0 }),
  ]
  // Live path.
  const liveH = makeHarness()
  const liveBridge = await makeBridge(liveH)
  for (const e of log) emit(liveH, e)

  // Replay path over the same log.
  const h = makeHarness()
  const bridge = await makeBridge(h)
  bridge.replay(log)

  const live = liveBridge.getStats()
  const replayed = bridge.getStats()
  assert.equal(replayed.inputTokens, 200, 'replay restarts at the switch too')
  assert.equal(replayed.inputTokens, live.inputTokens)
  assert.equal(replayed.cacheHitRate, live.cacheHitRate)
  assert.equal(replayed.msgCount, live.msgCount)
  await liveBridge.dispose()
  await bridge.dispose()
})

test('double replay is idempotent — stats identical after both passes', async () => {
  const log = [
    headerEvent(1, 10, 'deepseek', 'deepseek-chat', 'initial'),
    { type: 'user/message', seq: 2, time: 15, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    assistantMessage(3, 20, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 50 }),
    headerEvent(4, 30, 'minimax-cn', 'MiniMax-M3', 'change'),
    assistantMessage(5, 40, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 800, cacheWriteTokens: 0 }),
    assistantMessage(6, 50, { inputTokens: 60, outputTokens: 6, cacheReadTokens: 940, cacheWriteTokens: 0 }),
  ]
  // Replay rebuilds from zero each time (accumulators AND the route baseline
  // reset at the top of replay()), so a second pass over the same log must
  // land on exactly the same stats — including the post-switch segmentation.
  const h = makeHarness()
  const bridge = await makeBridge(h)
  bridge.replay(log)
  const first = bridge.getStats()
  assert.equal(first.inputTokens, 260) // only the new-route messages count
  assert.equal(first.cacheReadTokens, 1740)
  assert.equal(first.cacheHitRate, (1740 / 2000) * 100)

  bridge.replay(log)
  const second = bridge.getStats()
  assert.deepEqual(second, first, 'the second replay pass changes nothing')
  await bridge.dispose()
})

test('after detachCurrent the fresh session\'s first header only sets the baseline', async () => {
  const h = makeHarness()
  const bridge = await makeBridge(h)
  // The old session ran and billed on one route.
  emit(h, headerEvent(1, 10, 'minimax-cn', 'MiniMax-M3', 'initial'))
  emit(h, assistantMessage(2, 20, { inputTokens: 300, outputTokens: 30, cacheReadTokens: 700, cacheWriteTokens: 0 }))
  // /new detaches: every incremental stat zeroes and the route baseline clears.
  await bridge.detachCurrent()
  const fresh = bridge.getStats()
  assert.equal(fresh.inputTokens, 0)
  assert.equal(fresh.cacheReadTokens, 0)
  assert.equal(fresh.cacheWriteTokens, 0)
  assert.equal(fresh.cacheHitRate, undefined)

  // The next prompt lazily creates the fresh session (the /new flow) — only
  // after that re-bind do events reach applyEvent again (the subscription
  // filters on sessionId, which detach cleared).
  await bridge.ensureAgent()

  // New session: usage can land before its first header reaches us (same
  // ordering the legacy-log test exercises) — the first header must ONLY
  // establish the baseline, never clear what already happened.
  emit(h, assistantMessage(3, 30, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 }))
  emit(h, headerEvent(4, 40, 'deepseek', 'deepseek-chat', 'initial'))
  let s = bridge.getStats()
  assert.equal(s.inputTokens, 100, 'the fresh session\'s first header does not clear earlier usage')
  assert.equal(s.cacheReadTokens, 900)
  assert.equal(s.cacheHitRate, (900 / 1000) * 100)
  // Under the new baseline, same-value headers keep accumulating…
  emit(h, headerEvent(5, 50, 'deepseek', 'deepseek-chat', 'resume'))
  emit(h, assistantMessage(6, 60, { inputTokens: 40, outputTokens: 4, cacheReadTokens: 960, cacheWriteTokens: 0 }))
  s = bridge.getStats()
  assert.equal(s.inputTokens, 140)
  assert.equal(s.cacheHitRate, (1860 / 2000) * 100)
  // …and a genuine route change within the new session still resets.
  emit(h, headerEvent(7, 70, 'minimax-cn', 'MiniMax-M3', 'change'))
  s = bridge.getStats()
  assert.equal(s.inputTokens, 0)
  assert.equal(s.cacheHitRate, undefined)
  assert.equal(s.outputTokens, 14, 'route-independent totals survive (fresh-session only)')
  await bridge.dispose()
})
