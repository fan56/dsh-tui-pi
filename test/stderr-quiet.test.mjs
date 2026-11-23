/**
 * src/stderr-quiet.ts — in-process interception of the core's periodic
 * model-listing SUCCESS line on raw stderr. The test injects a fake
 * `process.stderr.write` BEFORE install (the module's DI seam), then checks
 * byte-for-byte what reaches it. The golden rule: a write is swallowed only
 * when its ENTIRE text matches the success-line regex; everything else —
 * failure lines, half lines, multi-line blocks, chunks without a newline —
 * must be forwarded unchanged, with the original this/signature/return value.
 * Runs against the built lib/ (pretest).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MODEL_LISTING_SUCCESS,
  installStderrQuiet,
  resetStderrQuiet,
  setStderrQuietEnabled,
} from '../lib/stderr-quiet.js'

const OK_ACCOUNT = '[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)\n'
const OK_API_KEY_CRLF = '[llm-deepseek-api-key] model listing from https://api.example.com/models loaded 12 model(s), skipped 3 row(s)\r\n'
const FAIL_FIRST = '[llm-deepseek-account] model listing from https://api.deepseek.com/models failed (Error: boom); using the bundled catalog\n'
const FAIL_REFRESH = '[llm-deepseek-account] model listing refresh failed (Error: boom); keeping the previous catalog; check listing configuration and credentials\n'
const FAIL_NOTIFY = '[llm-deepseek-account] model listing change notification failed (Error: boom); reload the model catalog\n'

/** Yield one event-loop turn so nextTick(callback) of a swallowed write fires. */
const tick = () => new Promise(resolve => process.nextTick(resolve))

/**
 * Install the patch over a recording fake write. Returns the records plus
 * the real write so every test can restore the global exactly.
 * `returnValue` proves the passthrough return value is not replaced by true.
 */
function harness(t, { returnValue = true } = {}) {
  const seen = []
  const realWrite = process.stderr.write
  const fake = function (chunk, encoding, callback) {
    seen.push({ chunk, encoding, callback, argc: arguments.length })
    const cb = typeof encoding === 'function' ? encoding : callback
    if (typeof cb === 'function') cb()
    return returnValue
  }
  process.stderr.write = fake
  installStderrQuiet()
  const restore = () => {
    resetStderrQuiet()
    process.stderr.write = realWrite
  }
  t.after(restore)
  return { seen, fake, realWrite }
}

test('a complete success line is swallowed: both tags, LF/CRLF, string/Buffer; cb on nextTick', async t => {
  const h = harness(t)
  for (const line of [OK_ACCOUNT, OK_API_KEY_CRLF, Buffer.from(OK_ACCOUNT, 'utf8')]) {
    assert.equal(MODEL_LISTING_SUCCESS.test(Buffer.isBuffer(line) ? line.toString('utf8') : line), true)
    let cbCalls = 0
    const result = process.stderr.write(line, () => { cbCalls++ })
    assert.equal(result, true, 'a swallowed write reports accepted')
    assert.equal(cbCalls, 0, 'the callback is deferred, not called synchronously')
    await tick()
    assert.equal(cbCalls, 1, 'the callback runs exactly once on the next tick')
  }
  assert.deepEqual(h.seen, [], 'not one byte of a success line reaches stderr')
})

test('failure lines are forwarded byte-for-byte with the fake return value', t => {
  const h = harness(t, { returnValue: false })
  for (const line of [FAIL_FIRST, FAIL_REFRESH, FAIL_NOTIFY]) {
    assert.equal(MODEL_LISTING_SUCCESS.test(line), false)
    const result = process.stderr.write(line)
    assert.equal(result, false, 'passthrough keeps the original backpressure return value')
  }
  assert.equal(h.seen.length, 3)
  assert.deepEqual(h.seen.map(r => r.chunk), [FAIL_FIRST, FAIL_REFRESH, FAIL_NOTIFY])
})

test('a half line and an empty chunk are forwarded unchanged', t => {
  const h = harness(t)
  const half = '[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 mo'
  process.stderr.write(half)
  process.stderr.write('')
  assert.equal(h.seen.length, 2)
  assert.equal(h.seen[0].chunk, half, 'a truncated line is never eaten')
  assert.equal(h.seen[1].chunk, '', 'an empty chunk is not a match either')
})

test('a multi-line block containing a success line is forwarded whole', t => {
  const h = harness(t)
  const block = `prefix noise\n${OK_ACCOUNT}suffix noise\n${OK_API_KEY_CRLF}`
  const asBuffer = Buffer.from(block, 'utf8')
  process.stderr.write(asBuffer)
  assert.equal(h.seen.length, 1)
  assert.ok(Buffer.isBuffer(h.seen[0].chunk), 'a Buffer chunk stays a Buffer')
  assert.ok(h.seen[0].chunk.equals(asBuffer), 'every byte survives, no decoding/transcoding')
})

test('a full line without its trailing newline is forwarded unchanged', t => {
  const h = harness(t)
  const noNewline = OK_ACCOUNT.slice(0, -1)
  process.stderr.write(noNewline)
  assert.equal(h.seen.length, 1, 'the anchored regex requires the trailing newline')
  assert.equal(h.seen[0].chunk, noNewline)
})

test('both (chunk, cb) and (chunk, enc, cb) signatures pass through untouched', async t => {
  const h = harness(t)
  const cb1 = () => {}
  const cb2 = () => {}
  process.stderr.write(FAIL_FIRST, cb1)
  process.stderr.write(FAIL_REFRESH, 'utf8', cb2)
  assert.equal(h.seen.length, 2)
  assert.deepEqual(
    h.seen.map(r => ({ argc: r.argc, encoding: r.encoding, callback: r.callback })),
    [
      { argc: 2, encoding: cb1, callback: undefined },
      { argc: 3, encoding: 'utf8', callback: cb2 },
    ],
    'the original argument shape (including this and argument count) is preserved',
  )
  // The swallowed branch must also accept the 3-arg form and still invoke
  // the trailing callback.
  let called = 0
  assert.equal(process.stderr.write(OK_ACCOUNT, 'utf8', () => { called++ }), true)
  await tick()
  assert.equal(called, 1)
})

test('repeated installStderrQuiet() is idempotent: one wrapper, one callback', async t => {
  const h = harness(t)
  const once = process.stderr.write
  installStderrQuiet()
  installStderrQuiet()
  assert.equal(process.stderr.write, once, 're-installs never stack another wrapper')
  let cbCalls = 0
  process.stderr.write(OK_ACCOUNT, () => { cbCalls++ })
  await tick()
  await tick()
  assert.equal(cbCalls, 1, 'a double wrapper would still only promise one callback')
  assert.deepEqual(h.seen, [])
})

test('setStderrQuietEnabled(false) lets a success line through; true re-mutes it', t => {
  const h = harness(t)
  setStderrQuietEnabled(false)
  process.stderr.write(OK_ACCOUNT)
  assert.deepEqual(h.seen.map(r => r.chunk), [OK_ACCOUNT], 'disabled patch is a pure passthrough')
  setStderrQuietEnabled(true)
  process.stderr.write(OK_ACCOUNT)
  assert.equal(h.seen.length, 1, 're-enabling mutes again')
})

test('resetStderrQuiet restores the captured write and clears the switch', async t => {
  const h = harness(t)
  const patched = process.stderr.write
  assert.notEqual(patched, h.fake, 'the patch sits over the injected fake')
  setStderrQuietEnabled(false)
  resetStderrQuiet()
  assert.equal(process.stderr.write, h.fake, 'the pre-install fake write is restored')
  installStderrQuiet()
  let called = 0
  assert.equal(process.stderr.write(OK_ACCOUNT, () => { called++ }), true, 'default-on after reset')
  await tick()
  assert.equal(called, 1)
  assert.deepEqual(h.seen, [])
})

test('a fresh module instance after /reload shares the global state and the same patch', async t => {
  const h = harness(t)
  // A query-string import evicts/creates a NEW module instance, the way a
  // /reload ESM re-evaluation does — but the globalThis symbol survives.
  const reloaded = await import('../lib/stderr-quiet.js?reload=1')
  assert.equal(reloaded.MODEL_LISTING_SUCCESS.source, MODEL_LISTING_SUCCESS.source)
  const before = process.stderr.write
  reloaded.installStderrQuiet()
  assert.equal(process.stderr.write, before, 'the new instance reuses the existing wrapper')

  reloaded.setStderrQuietEnabled(false)
  process.stderr.write(OK_ACCOUNT)
  assert.equal(h.seen.length, 1, 'the old patch reads the flag the new instance flipped')

  reloaded.setStderrQuietEnabled(true)
  process.stderr.write(OK_ACCOUNT)
  assert.equal(h.seen.length, 1, 'and flips back without reinstalling')
})
