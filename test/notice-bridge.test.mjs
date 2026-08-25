/**
 * Shared notice bridge (src/notice-bridge.ts) — the terminal-safe channel
 * every operator trace rides: config-validation warnings (retention /
 * resume), the settings-namespace registration failure, the missing
 * userQuestions service, the retention result line. Semantics under test:
 * sink-registered → immediate delivery; no sink yet → bounded pending
 * drained in order on registration (at-most-once); sink never arrives →
 * silently dropped, never a raw stderr/stdout byte (the alt-screen owns
 * the terminal). Runs against the built lib/ (pretest).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  emitNotice,
  resetNoticeBridge,
  setNoticeSink,
  takePendingNotices,
} from '../lib/notice-bridge.js'

/** The bridge's documented pending cap (FIFO, oldest dropped beyond it). */
const MAX_PENDING = 16

/**
 * Reset to the import-time state around every test: no sink, no pending —
 * test-order leakage is impossible.
 */
function reset() {
  resetNoticeBridge()
}

test('emitNotice with no sink holds messages pending in order and never touches the terminal', () => {
  reset()
  const stderrChunks = []
  const warnLines = []
  const originalWrite = process.stderr.write
  const originalWarn = console.warn
  process.stderr.write = chunk => {
    stderrChunks.push(String(chunk))
    return true
  }
  console.warn = (...args) => { warnLines.push(args.join(' ')) }
  try {
    emitNotice('first')
    emitNotice('second')
    emitNotice('third')
  } finally {
    process.stderr.write = originalWrite
    console.warn = originalWarn
  }
  // BOTH channels stay silent — console.warn funnels into stderr, and a
  // direct stderr write must not exist either; a TUI-less run writes
  // nothing to the terminal at all.
  assert.deepEqual(stderrChunks, [], 'no raw stderr bytes')
  assert.deepEqual(warnLines, [], 'no console.warn calls')
  assert.deepEqual(takePendingNotices(), ['first', 'second', 'third'], 'pending keeps emission order')
  assert.deepEqual(takePendingNotices(), [], 'pending drained exactly once')
})

test('registering a sink drains the whole pending batch in order, one call per message', () => {
  reset()
  emitNotice('m1')
  emitNotice('m2')
  emitNotice('m3')
  const seen = []
  setNoticeSink(message => { seen.push(message) })
  assert.deepEqual(seen, ['m1', 'm2', 'm3'], 'the batch arrives as individual messages in order')
  assert.deepEqual(takePendingNotices(), [], 'nothing stays pending after the drain')
  // At-most-once: a second registration (e.g. after /reload) gets nothing.
  const late = []
  setNoticeSink(message => { late.push(message) })
  assert.deepEqual(late, [])
})

test('a sink registered up front receives each message directly; nothing is held', () => {
  reset()
  const seen = []
  setNoticeSink(message => { seen.push(message) })
  emitNotice('direct-a')
  emitNotice('direct-b')
  assert.deepEqual(seen, ['direct-a', 'direct-b'])
  assert.deepEqual(takePendingNotices(), [])
})

test('clearing the sink re-arms pending; the next registration consumes the batch once', () => {
  reset()
  // The /reload-rollback shape: effect teardown clears the sink while the
  // module state survives, a late producer queues, and the restarted TUI's
  // registration drains exactly one batch.
  const first = []
  setNoticeSink(message => { first.push(message) })
  setNoticeSink(undefined)
  emitNotice('late-1')
  emitNotice('late-2')
  assert.deepEqual(first, [], 'the cleared sink sees nothing')
  const second = []
  setNoticeSink(message => { second.push(message) })
  assert.deepEqual(second, ['late-1', 'late-2'])
})

test('a throwing sink still consumes its batch — no message is ever redelivered', () => {
  reset()
  emitNotice('doomed-1')
  emitNotice('doomed-2')
  assert.throws(() => {
    setNoticeSink(() => { throw new Error('sink exploded') })
  }, /sink exploded/)
  // Delivery stops at the throw, but the batch was detached before the
  // first call: nothing replays to a later registration.
  assert.deepEqual(takePendingNotices(), [])
  const later = []
  setNoticeSink(message => { later.push(message) })
  assert.deepEqual(later, [])
})

test('a sink that unregisters itself mid-drain stops delivery; the remainder stays pending', () => {
  reset()
  emitNotice('s-1')
  emitNotice('s-2')
  emitNotice('s-3')
  const seen = []
  setNoticeSink(message => {
    seen.push(message)
    setNoticeSink(undefined)
  })
  assert.deepEqual(seen, ['s-1'], 'only the first message reached the sink before it unregistered')
  // The undelivered remainder goes back to the queue instead of being
  // written into a dead surface — and survives for the next registration.
  assert.deepEqual(takePendingNotices(), ['s-2', 's-3'])
})

test('pending is bounded: the OLDEST messages drop beyond the cap', () => {
  reset()
  const total = MAX_PENDING + 4
  for (let i = 0; i < total; i++) emitNotice(`n${i}`)
  const pending = takePendingNotices()
  assert.equal(pending.length, MAX_PENDING)
  assert.equal(pending[0], `n${total - MAX_PENDING}`, 'the oldest overflow messages were dropped')
  assert.equal(pending[pending.length - 1], `n${total - 1}`, 'the newest message survives')
})

test('resetNoticeBridge clears both the sink and every pending message', () => {
  reset()
  const seen = []
  setNoticeSink(message => { seen.push(message) })
  emitNotice('pre-reset')
  resetNoticeBridge()
  emitNotice('post-reset')
  assert.deepEqual(seen, ['pre-reset'], 'the reset sink is detached')
  assert.deepEqual(takePendingNotices(), ['post-reset'], 'only post-reset state remains')
})
