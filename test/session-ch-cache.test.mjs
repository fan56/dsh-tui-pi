/**
 * CH (cache-hit) accounting tests: the rate is SESSION-cumulative —
 * hit rate = ΣcacheRead ÷ (Σinput + ΣcacheRead + ΣcacheWrite) over the
 * whole session's input traffic. Output tokens never enter the denominator
 * (cache hit is an input-side metric; cacheWrite counts as this request's
 * miss), and `request/header` events never touch the counters — a
 * provider/model route change does NOT reset, because the rate describes
 * the session, not one route's prompt cache.
 *
 * Contract under test:
 * - Normal accumulation: usage folds into the cumulative totals; the rate
 *   follows the formula above.
 * - Route change (provider, model, or both; reason initial/change/resume):
 *   totals keep growing through it.
 * - Full resets still exist where the SESSION boundary does: detachCurrent
 *   zeroes every incremental stat, and replay() rebuilds from zero each
 *   pass (idempotent, and identical to the live fold over the same log).
 * - Route-independent stats keep running regardless: outputTokens,
 *   msgCount, toolCallCount, contextTokens.
 *
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { SessionId } from '@deepseek-ai/dsh-session'
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

test('usage accumulates normally; the rate is read ÷ billed input', async () => {
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

test('output tokens never dilute the hit rate', async () => {
  const h = makeHarness()
  const bridge = await makeBridge(h)
  emit(h, assistantMessage(1, 10, { inputTokens: 100, outputTokens: 1_000_000, cacheReadTokens: 300, cacheWriteTokens: 100 }))
  const s = bridge.getStats()
  assert.equal(s.outputTokens, 1_000_000, 'the output total keeps running')
  assert.equal(s.cacheHitRate, (300 / 500) * 100, 'rate ignores output entirely')
  await bridge.dispose()
})

test('a provider/model value change does NOT reset the session totals', async () => {
  const h = makeHarness()
  const bridge = await makeBridge(h)
  emit(h, headerEvent(1, 10, 'deepseek', 'deepseek-chat', 'initial'))
  emit(h, assistantMessage(2, 20, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 50 }))
  emit(h, headerEvent(3, 30, 'minimax-cn', 'MiniMax-M3', 'change'))
  // The switch is transparent: totals keep growing through it.
  let s = bridge.getStats()
  assert.equal(s.inputTokens, 100)
  assert.equal(s.cacheReadTokens, 900)
  assert.equal(s.cacheHitRate, (900 / 1050) * 100)
  emit(h, assistantMessage(4, 40, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 800, cacheWriteTokens: 0 }))
  s = bridge.getStats()
  assert.equal(s.inputTokens, 300, 'both routes\' input counts')
  assert.equal(s.cacheReadTokens, 1700)
  assert.equal(s.cacheHitRate, (1700 / 2050) * 100)
  // Same-value headers (resume pseudo-events, system-prompt-only changes)
  // are equally transparent.
  emit(h, headerEvent(5, 50, 'minimax-cn', 'MiniMax-M3', 'resume'))
  emit(h, assistantMessage(6, 60, { inputTokens: 60, outputTokens: 6, cacheReadTokens: 940, cacheWriteTokens: 0 }))
  s = bridge.getStats()
  assert.equal(s.inputTokens, 360)
  assert.equal(s.cacheHitRate, (2640 / 3050) * 100) // billed = 360 input + 2640 read + 50 carried write
  await bridge.dispose()
})

test('usage before the first header simply accumulates', async () => {
  const h = makeHarness()
  const bridge = await makeBridge(h)
  // Legacy log: no request/header was ever recorded, usage arrives first.
  emit(h, assistantMessage(1, 10, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 50 }))
  let s = bridge.getStats()
  assert.equal(s.inputTokens, 100)
  assert.equal(s.cacheHitRate, (900 / 1050) * 100)
  // A late header never touches anything.
  emit(h, headerEvent(2, 20, 'deepseek', 'deepseek-chat', 'initial'))
  emit(h, assistantMessage(3, 30, { inputTokens: 40, outputTokens: 4, cacheReadTokens: 960, cacheWriteTokens: 0 }))
  s = bridge.getStats()
  assert.equal(s.inputTokens, 140)
  assert.equal(s.cacheHitRate, (1860 / 2050) * 100)
  await bridge.dispose()
})

test('replay reproduces the live totals exactly, switches included', async () => {
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
  assert.equal(replayed.inputTokens, 300, 'both routes\' usage counts (session scope)')
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
  // Replay rebuilds from zero each time (the accumulators reset at the top
  // of replay()), so a second pass over the same log must land on exactly
  // the same session-cumulative stats.
  const h = makeHarness()
  const bridge = await makeBridge(h)
  bridge.replay(log)
  const first = bridge.getStats()
  assert.equal(first.inputTokens, 360) // every message counts (session scope)
  assert.equal(first.cacheReadTokens, 2640)
  assert.equal(first.cacheHitRate, (2640 / 3050) * 100) // billed = 360 + 2640 + 50 write

  bridge.replay(log)
  const second = bridge.getStats()
  assert.deepEqual(second, first, 'the second replay pass changes nothing')
  await bridge.dispose()
})

test('after detachCurrent the fresh session starts from zero and still never resets on a switch', async () => {
  const h = makeHarness()
  const bridge = await makeBridge(h)
  // The old session ran and billed on one route.
  emit(h, headerEvent(1, 10, 'minimax-cn', 'MiniMax-M3', 'initial'))
  emit(h, assistantMessage(2, 20, { inputTokens: 300, outputTokens: 30, cacheReadTokens: 700, cacheWriteTokens: 0 }))
  // /new detaches: every incremental stat zeroes — the session boundary is
  // the ONLY thing that resets CH.
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

  emit(h, assistantMessage(3, 30, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 }))
  emit(h, headerEvent(4, 40, 'deepseek', 'deepseek-chat', 'initial'))
  let s = bridge.getStats()
  assert.equal(s.inputTokens, 100, 'the fresh session\'s first header does not clear earlier usage')
  assert.equal(s.cacheHitRate, (900 / 1000) * 100)
  emit(h, assistantMessage(5, 50, { inputTokens: 40, outputTokens: 4, cacheReadTokens: 960, cacheWriteTokens: 0 }))
  s = bridge.getStats()
  assert.equal(s.inputTokens, 140)
  assert.equal(s.cacheHitRate, (1860 / 2000) * 100)
  // A genuine route change within the fresh session is equally transparent.
  emit(h, headerEvent(6, 60, 'minimax-cn', 'MiniMax-M3', 'change'))
  s = bridge.getStats()
  assert.equal(s.inputTokens, 140, 'headers never touch the totals')
  assert.equal(s.cacheHitRate, (1860 / 2000) * 100)
  await bridge.dispose()
})

// --------------------------------------------------- resume attach arm --

test('resume adopts an already-live session instead of resuming (feishu /new case)', async () => {
  const handlers = new Map()
  const liveAgent = { id: 'live-1', session: { id: 'live-1' }, status: 'idle' }
  let resumeCalled = 0
  const ctx = {
    on(evt, fn) { handlers.set(evt, fn); return () => handlers.delete(evt) },
    get() { return undefined },
    agents: {
      // dsh refuses resuming a live session — the attach arm must avoid it.
      get(id) { return String(id) === 'live-1' ? liveAgent : undefined },
      async create() { return { agent: { session: { id: 'root' } }, async dispose() {} } },
      async resume() { resumeCalled += 1; throw new Error('cannot prepare session while it is live') },
    },
  }
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
  await bridge.ensureAgent()
  const handle = await bridge.resume(SessionId('live-1'))
  assert.equal(handle.agent, liveAgent, 'adopted the SAME live instance')
  assert.equal(resumeCalled, 0, 'agents.resume never reached')
  assert.equal(bridge.getSessionId(), 'live-1')
  // The adopted agent is not ours — detaching must not dispose it.
  await bridge.dispose()
  assert.equal(liveAgent.status, 'idle')
})
