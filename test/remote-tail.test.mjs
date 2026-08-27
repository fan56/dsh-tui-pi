/**
 * Read-only remote view: the tail watcher's watermark/filter semantics and
 * the bridge wiring (watchRemote backfills + live-tick delivery through the
 * SAME renderer callbacks a live session uses; prompt refused while
 * watching). Decoder is injected — no zstd, no disk below mkdtemp dirs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { DshSessionBridge } from '../lib/session.js'
import { RemoteSessionTail } from '../lib/remote-tail.js'

/** A deterministic decoder queue: each tickOnce() consumes the next entry. */
function makeDecoderHarness(entries) {
  let i = 0
  const decode = async () => {
    const value = entries[Math.min(i, entries.length - 1)]
    i += 1
    return value
  }
  return { decode }
}

test('emits only durable rows in order; streaming deltas and identity rows filtered', async () => {
  const h = makeDecoderHarness([[
    '{"type":"session","id":"x"}',
    '{"type":"user/message","seq":1,"data":{}}',
    '{"type":"reasoning-chunks","seq0":2,"time0":3,"data":{"dt":[],"texts":["s"]}}',
    '{"type":"assistant/message","seq":5,"data":{}}',
    '{"type":"tool/call","seq":6,"data":{}}',
  ].join('\n')])
  const events = []
  const tail = new RemoteSessionTail('/tmp/any.jsonl.zstd', {
    onEvents: list => events.push(...list),
  }, { intervalMs: 10_000, decode: h.decode })
  await tail.tickOnce()
  assert.deepEqual(events.map(e => e.type), ['user/message', 'assistant/message', 'tool/call'])
})

test('appends deliver only the suffix watermark; shrink resets to re-read the fresh stream', async () => {
  function plainRow(seq) {
    return JSON.stringify({ type: 'assistant/message', seq, data: {} })
  }
  const h = makeDecoderHarness([
    [plainRow(0), plainRow(1)].join('\n'),
    [plainRow(0), plainRow(1), '{"type":"assistant/chunk","seq":9}', plainRow(2)].join('\n'),
    // File shrank (repair replaced it) → watermark resets, full re-read.
    plainRow(7),
  ])
  const events = []
  const tail = new RemoteSessionTail('/f', { onEvents: list => events.push(...list.map(e => e.seq)) },
    { intervalMs: 10_000, decode: h.decode })

  await tail.tickOnce()
  assert.deepEqual(events, [0, 1])
  await tail.tickOnce()
  assert.deepEqual(events, [0, 1, 2])
  await tail.tickOnce()
  assert.deepEqual(events, [0, 1, 2, 7])
})

test('decode failures surface via onError once per failing tick, watcher stays alive', async () => {
  const errors = []
  let calls = 0
  const tail = new RemoteSessionTail('/f', { onEvents: () => {}, onError: e => errors.push(String(e)) },
    {
      intervalMs: 10_000,
      decode: async () => {
        calls += 1
        if (calls === 2) throw new Error('boom')
        return ''
      },
    })
  await tail.tickOnce() // call 1: healthy ('')
  await tail.tickOnce() // call 2: boom → onError surfaces
  await tail.tickOnce() // call 3: healthy again → watcher survives
  assert.equal(errors.length, 1)
  assert.equal(calls, 3, 'watcher keeps polling after failures')
  tail.stop()
})

// ---------------------------------------------------------------------------
// Bridge wiring

test('watchRemote backfills through the live-render callbacks and refuses prompts', async () => {
  const rendered = []
  const statuses = []
  const ctx = makeCtxForWatch()
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {},
    onStatus: s => statuses.push(s),
    onEvent: e => rendered.push(`${e.type}:${e.seq}`),
  }, { remoteTailOptions: { intervalMs: 60_000, decode: ctx.__decode } })
  try {
    await bridge.watchRemote('remote-1')
    // First tick delivered synchronously via injected decode at construction.
    assert.deepEqual(rendered, ['user/message:0', 'assistant/message:2', 'turn/end:3'],
      'identity/streaming rows skipped; durable+status delivered in log order')
    assert.equal(statuses.includes('idle'), true)

    await assert.rejects(() => bridge.prompt('hello'), /read-only/)
    assert.equal(bridge.isReadOnlyView(), true)
  } finally {
    await bridge.dispose()
  }
  assert.equal(bridge.isReadOnlyView(), false, 'dispose stops the watch')
})

test('a later resume() tears the watch down before binding the local agent', async () => {
  const rendered = []
  const ctx = makeCtxForWatch()
  let resumeCalls = 0
  ctx.agents.resume = async options => {
    resumeCalls += 1
    return { agent: { session: { id: String(options.resumeSessionId) }, followup() {} }, async dispose() {} }
  }
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: e => rendered.push(e.type),
  }, { remoteTailOptions: { intervalMs: 60_000, decode: ctx.__decode } })
  await bridge.watchRemote('remote-1')
  assert.equal(bridge.isReadOnlyView(), true)
  try {
    await bridge.resume('local-2')
    assert.equal(bridge.isReadOnlyView(), false)
    assert.equal(resumeCalls, 1)
    await bridge.prompt('back to normal') // must NOT throw now
  } finally {
    await bridge.dispose()
  }
})

function makeCtxForWatch(overrides = {}) {
  // The watched log content resolved from header cwd '/proj/w' via the same
  // projectKey encoding as production; zstd decode seam returns it directly.
  const log = [
    '{"type":"session","id":"remote-1"}',
    '{"type":"user/message","seq":0,"data":{}}',
    '{"type":"reasoning-chunks","seq0":1,"time0":1,"data":{"dt":[],"texts":["s"]}}',
    '{"type":"assistant/message","seq":2,"data":{}}',
    '{"type":"turn/end","seq":3,"data":{}}',
  ].join('\n')
  const headers = [{ id: 'remote-1', cwd: '/proj/w' }]
  return {
    on() { return () => {} },
    get(key) { return key === 'sessionPersistence' ? { list: async () => headers } : undefined },
    agents: Object.assign({
      get() { return undefined },
      async create(options) {
        const agent = { session: { id: String(options.sessionId) } }
        return { agent, followup() {}, async dispose() {} }
      },
      async resume() { throw new Error('replaced per-test') },
    }, overrides),
    __log: log,
    __decode: async () => log,
  }
}
