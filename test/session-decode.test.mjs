/**
 * Bridge decode-speed accounting tests: the `tok/s` figures the subagent
 * viewer header and the /session panel render. The decode window per billed
 * message is first token → settlement (the embedded stream's first-token
 * time against the event's log time — the host sessionStats projection's
 * definition), tokens are that message's `usage.outputTokens`; the main
 * session additionally attributes each window to the route of the latest
 * `request/header`. Usage-less and stream-less messages contribute nothing.
 * Runs against the built lib/ (npm run build && npm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { DshSessionBridge } from '../lib/session.js'

/** A minimal harness: capture `session/event` + stream frames, fake ctx.sessions. */
function makeHarness() {
  const handlers = new Map()
  const ctx = {
    on(evt, fn) { handlers.set(evt, fn); return () => handlers.delete(evt) },
    get() { return undefined },
    agents: {
      async create() { return { agent: { session: { id: 'root-session' } }, async dispose() {} } },
    },
  }
  return { ctx, handlers }
}

function emit(handlers, session, event) {
  handlers.get('session/event')(session, event)
}

function emitFrame(handlers, sessionId, frame) {
  handlers.get('agent/assistant-stream')({ agent: { id: sessionId }, frame })
}

/** `request/header` pinning the route of every message until the next one. */
function headerEvent(seq, time, provider, model) {
  return {
    type: 'request/header',
    seq,
    time,
    data: { header: { config: { provider, model } }, reason: 'initial' },
  }
}

/**
 * One billed assistant message whose embedded stream starts at
 * `firstTokenAt` — the decode window is `time - firstTokenAt`.
 */
function assistantMsg(seq, time, outputTokens, firstTokenAt, extra = {}) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'working…' }] },
      stream: [{ type: 'text-chunks', time0: firstTokenAt, index: 0, dt: [0], texts: ['working…'] }],
      usage: { inputTokens: 10, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ...extra,
    },
  }
}

const MAIN = { id: 'root-session', header: {} }

test('main-session decode stats sum first-token→settlement windows and attribute them per route', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, { onLive: () => {}, onStatus: () => {}, onEvent: () => {} })
  await bridge.ensureAgent()

  // Route a/one: 100 tokens over 1500ms.
  emit(handlers, MAIN, headerEvent(0, 1000, 'a', 'one'))
  emit(handlers, MAIN, assistantMsg(1, 2500, 100, 1000))
  // Route b/two: 300 tokens over 500ms.
  emit(handlers, MAIN, headerEvent(2, 3000, 'b', 'two'))
  emit(handlers, MAIN, assistantMsg(3, 3500, 300, 3000))

  const stats = bridge.getDecodeStats()
  assert.equal(stats.decodeTokens, 400)
  assert.equal(stats.decodeMs, 2000)
  assert.deepEqual(stats.routes.map(route => route.route), ['a/one', 'b/two'], 'routes in first-billed order')
  assert.deepEqual(
    stats.routes.map(route => [route.requests, route.outputTokens, route.decodeMs, route.decodeTokens]),
    [[1, 100, 1500, 100], [1, 300, 500, 300]],
  )
  await bridge.dispose()
})

test('usage-less and stream-less messages contribute nothing to decode stats', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, { onLive: () => {}, onStatus: () => {}, onEvent: () => {} })
  await bridge.ensureAgent()

  emit(handlers, MAIN, headerEvent(0, 1000, 'a', 'one'))
  // No usage snapshot — nothing to bill, nothing to attribute.
  emit(handlers, MAIN, {
    type: 'assistant/message', seq: 1, time: 2000,
    data: { turn: 1, step: 1, message: { content: [] }, stream: [{ type: 'text-chunks', time0: 1500, index: 0, dt: [0], texts: ['x'] }] },
  })
  // No embedded stream — no first-token instant, no window.
  emit(handlers, MAIN, assistantMsg(2, 3000, 50, 9999, { stream: [] }))

  const stats = bridge.getDecodeStats()
  assert.equal(stats.decodeTokens, 0)
  assert.equal(stats.decodeMs, 0)
  assert.deepEqual(stats.routes, [], 'an unbilled route creates no entry — routes list billed models only')
  await bridge.dispose()
})

test('replay() resets the decode accounting with the rest of the stats', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, { onLive: () => {}, onStatus: () => {}, onEvent: () => {} })
  await bridge.ensureAgent()

  emit(handlers, MAIN, headerEvent(0, 1000, 'a', 'one'))
  emit(handlers, MAIN, assistantMsg(1, 2500, 100, 1000))
  assert.equal(bridge.getDecodeStats().decodeTokens, 100)

  bridge.replay([])
  const stats = bridge.getDecodeStats()
  assert.equal(stats.decodeTokens, 0)
  assert.equal(stats.decodeMs, 0)
  assert.deepEqual(stats.routes, [], 'route attribution resets too')
  await bridge.dispose()
})

test('child decode stats accumulate per child and the live window closes at settlement', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, { onLive: () => {}, onStatus: () => {}, onEvent: () => {} })
  await bridge.ensureAgent()

  // Adopt the child through its delegated header (the primary discovery path).
  const childSession = { id: 'child-1', header: { origin: 'subagent', parentSession: 'root-session', delegationDepth: 1 } }
  emit(handlers, childSession, {
    type: 'subagent/descriptor', seq: 0, time: 2,
    data: { version: 1, mode: 'one-shot', provider: 'workhorse' },
  })

  // Streaming deltas open the live window; inside the warmup it reads as
  // unknown, after it the estimated-token rate.
  const before = Date.now()
  emitFrame(handlers, 'child-1', { type: 'start', turn: 1, step: 1 })
  emitFrame(handlers, 'child-1', { type: 'chunk', turn: 1, step: 1, chunk: { type: 'text-delta', text: 'abcdefgh' } })
  assert.equal(bridge.getChildLiveTps('child-1', before), undefined, 'warmup: no rate yet')
  const midRate = bridge.getChildLiveTps('child-1', before + 2000)
  assert.ok(midRate !== undefined && midRate > 0 && midRate <= 2, `post-warmup rate ~1 tok/s, got ${midRate}`)

  // Settlement: the exact usage-based window lands, the live window closes.
  emit(handlers, childSession, assistantMsg(1, before + 1000, 200, before))
  assert.equal(bridge.getChildLiveTps('child-1', before + 5000), undefined, 'settled: live window closed')
  const childStats = bridge.getChildDecodeStats('child-1')
  assert.equal(childStats.decodeTokens, 200)
  assert.equal(childStats.decodeMs, 1000)
  await bridge.dispose()
})

test('unknown children read as zeroed decode stats', async () => {
  const { ctx, handlers } = makeHarness()
  const bridge = new DshSessionBridge(ctx, { onLive: () => {}, onStatus: () => {}, onEvent: () => {} })
  await bridge.ensureAgent()
  assert.deepEqual(bridge.getChildDecodeStats('nobody'), { decodeMs: 0, decodeTokens: 0 })
  assert.equal(bridge.getChildLiveTps('nobody', Date.now()), undefined)
  await bridge.dispose()
})
