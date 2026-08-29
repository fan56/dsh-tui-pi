/**
 * /btw pure decision layer (src/btw.ts → lib/btw.js) — arg parsing, snapshot
 * assembly, the single-flight queue, stream consumption, and the controller
 * matrix over structural fakes, so everything runs without a terminal.
 * Runs against the built lib/ (pretest builds).
 *
 * Design contract (CONTEXT.md: Btw / Side call / Btw overlay / Last-btw slot /
 * Queued btw; docs/adr/0001-btw-tui-owned-command.md):
 * - `--model provider/model` is extractable anywhere in the line; no input at
 *   all is the review/usage gesture, not an error;
 * - the snapshot carries the last N user/assistant text messages oldest-first,
 *   text-only, per-message capped, malformed events skipped;
 * - one side call at a time, bounded FIFO queue behind it;
 * - a stream without a proper finish chunk is an error, never a silent success;
 * - cancelAll aborts the run, drops the queue and asks the glue to close the
 *   overlay, and never overwrites the Last-btw slot;
 * - a settled run whose overlay closed is pruned; a streaming one survives.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BTW_MAX_MESSAGE_CHARS,
  BTW_QUEUE_CAP,
  BTW_SNAPSHOT_DEFAULT_MESSAGES,
  BtwController,
  BtwQueue,
  buildBtwMessages,
  buildBtwSnapshot,
  consumeBtwStream,
  parseBtwInput,
  resolveSnapshotLimit,
} from '../lib/btw.js'

// ------------------------------------------------------------------ helpers --

const userEvent = (id, text) => ({
  type: 'user/message',
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})

const assistantEvent = (id, text, extra = []) => ({
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 1,
    message: { id, role: 'assistant', content: [{ type: 'text', text }, ...extra], source: { kind: 'model' } },
  },
})

async function* chunksOf(list) {
  yield* list
}

const flush = () => new Promise(resolve => setImmediate(resolve))

/** Controller test rig: structural fakes + recorded side effects. */
function makeRig(overrides = {}) {
  const calls = { started: [], notified: [], closeRequests: 0, renders: 0, streamOptions: [] }
  const deps = {
    stream: options => {
      calls.streamOptions.push(options)
      return chunksOf(overrides.streamChunks ?? [{ type: 'finish', reason: { kind: 'stop' } }])
    },
    // `'selection' in overrides` — `??` would swallow an explicit undefined.
    resolveSelection: () =>
      'selection' in overrides ? overrides.selection : { provider: 'p', model: 'm' },
    buildSnapshot: () => overrides.snapshot ?? [],
    requestRender: () => { calls.renders += 1 },
    notify: (message, kind) => { calls.notified.push({ message, kind }) },
    onRunStarted: run => { calls.started.push(run) },
    onOverlayRequestedClose: () => { calls.closeRequests += 1 },
    hasCapturingSurface: overrides.hasCapturingSurface,
  }
  const controller = new BtwController(deps)
  return { controller, calls }
}

// ------------------------------------------------------------- parseBtwInput --

test('parseBtwInput: no input is the review/usage gesture', () => {
  assert.equal(parseBtwInput(undefined).kind, 'empty')
  assert.equal(parseBtwInput('').kind, 'empty')
  assert.equal(parseBtwInput('   ').kind, 'empty')
})

test('parseBtwInput: plain question, whitespace folded at the edges', () => {
  const parsed = parseBtwInput('  what is this error?  ')
  assert.deepEqual(parsed, { kind: 'ok', question: 'what is this error?' })
})

test('parseBtwInput: multi-line question preserved', () => {
  const parsed = parseBtwInput('line one\nline two')
  assert.equal(parsed.kind, 'ok')
  assert.equal(parsed.question, 'line one\nline two')
})

test('parseBtwInput: --model extracted from the tail', () => {
  const parsed = parseBtwInput('hello --model anthropic/claude')
  assert.deepEqual(parsed, { kind: 'ok', question: 'hello', modelOverride: 'anthropic/claude' })
})

test('parseBtwInput: --model extracted from the head', () => {
  const parsed = parseBtwInput('--model p/m what happened')
  assert.deepEqual(parsed, { kind: 'ok', question: 'what happened', modelOverride: 'p/m' })
})

test('parseBtwInput: --model without a question is an error', () => {
  const parsed = parseBtwInput('--model p/m')
  assert.equal(parsed.kind, 'error')
  assert.match(parsed.error, /No question/)
})

test('parseBtwInput: --model without a slash is an error', () => {
  const parsed = parseBtwInput('hi --model justmodel')
  assert.equal(parsed.kind, 'error')
  assert.match(parsed.error, /provider\/model/)
})

test('parseBtwInput: a bare --model token is a question, not a flag', () => {
  // The flag grammar needs a value; "--model" alone reads as a question.
  assert.deepEqual(parseBtwInput('--model'), { kind: 'ok', question: '--model' })
})

// ------------------------------------------------------------ buildBtwSnapshot --

test('buildBtwSnapshot: chronological order, text-only, last N wins', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    userEvent('u1', 'first'),
    assistantEvent('a1', 'one', [{ type: 'toolCall', id: 'c1', name: 'bash' }]),
    { type: 'tool/result', data: { callId: 'c1' } },
    userEvent('u2', 'second'),
    assistantEvent('a2', 'two'),
    { type: 'assistant/chunk', data: { chunk: {} } },
    userEvent('u3', 'third'),
  ]
  const snapshot = buildBtwSnapshot(events, 2)
  assert.deepEqual(snapshot.map(m => m.content[0].text), ['two', 'third'])
  assert.deepEqual(snapshot.map(m => m.id), ['a2', 'u3'])
})

test('buildBtwSnapshot: content is rebuilt as one fresh text block', () => {
  const snapshot = buildBtwSnapshot([assistantEvent('a1', 'text only', [{ type: 'toolCall', id: 'c' }])], 5)
  assert.equal(snapshot.length, 1)
  assert.deepEqual(snapshot[0].content, [{ type: 'text', text: 'text only' }])
  assert.equal(snapshot[0].source.kind, 'model')
})

test('buildBtwSnapshot: empty and whitespace-only texts are skipped', () => {
  const events = [userEvent('u1', '   '), assistantEvent('a1', ''), userEvent('u2', 'real')]
  assert.deepEqual(buildBtwSnapshot(events, 10).map(m => m.id), ['u2'])
})

test('buildBtwSnapshot: agent.inject synthetic context never crowds the dialog', () => {
  // agent.inject() rides the 'user/message' event type with a non-user
  // source (file notices, skill content, cron pings) — those must be
  // filtered out, the real prompts kept.
  const events = [
    { type: 'user/message', data: { id: 'inj1', role: 'user', content: [{ type: 'text', text: 'FILE CHANGED: a.ts' }], source: { kind: 'plugin', plugin: 'dsh-fs' } } },
    userEvent('u1', 'real question'),
    { type: 'user/message', data: { id: 'inj2', role: 'user', content: [{ type: 'text', text: 'skill content' }], source: { kind: 'plugin', plugin: 'dsh-tool-skill' } } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'reply' }], source: { kind: 'model' } } } },
  ]
  assert.deepEqual(buildBtwSnapshot(events, 6).map(m => m.id), ['u1', 'a1'])
})

test('buildBtwSnapshot: malformed event data is skipped, never thrown', () => {
  const events = [
    { type: 'user/message', data: null },
    { type: 'user/message', data: undefined },
    { type: 'assistant/message', data: {} },
    { type: 'user/message', data: { nope: true } },
    userEvent('u1', 'ok'),
  ]
  assert.deepEqual(buildBtwSnapshot(events, 10).map(m => m.id), ['u1'])
})

test('buildBtwSnapshot: per-message cap with truncation suffix', () => {
  const long = 'x'.repeat(BTW_MAX_MESSAGE_CHARS + 100)
  const snapshot = buildBtwSnapshot([userEvent('u1', long)], 5)
  const text = snapshot[0].content[0].text
  assert.ok(text.length < long.length)
  assert.ok(text.endsWith('…[truncated]'))
  assert.ok(text.startsWith('x'.repeat(10)))
})

test('buildBtwSnapshot: limit 0 disables the snapshot entirely', () => {
  assert.deepEqual(buildBtwSnapshot([userEvent('u1', 'hi')], 0), [])
})

test('buildBtwSnapshot: an empty event log yields an empty snapshot', () => {
  assert.deepEqual(buildBtwSnapshot([], 6), [])
})

// ------------------------------------------------------------- buildBtwMessages --

test('buildBtwMessages: appends the question as a plugin-sourced user message', () => {
  const snapshot = buildBtwSnapshot([userEvent('u1', 'hi')], 5)
  const messages = buildBtwMessages(snapshot, 'what is that?')
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0], snapshot[0])
  assert.equal(messages[1].role, 'user')
  assert.deepEqual(messages[1].content, [{ type: 'text', text: 'what is that?' }])
  assert.deepEqual(messages[1].source, { kind: 'plugin', plugin: 'dsh-tui-pi:btw' })
})

test('buildBtwMessages: works on an empty snapshot', () => {
  const messages = buildBtwMessages([], 'q')
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'q' }])
})

// -------------------------------------------------------------------- BtwQueue --

test('BtwQueue: first submit starts, later submits queue with positions', () => {
  const queue = new BtwQueue()
  assert.deepEqual(queue.submit({ question: 'a' }), { kind: 'started' })
  assert.equal(queue.running, true)
  assert.deepEqual(queue.submit({ question: 'b' }), { kind: 'queued', position: 1 })
  assert.deepEqual(queue.submit({ question: 'c' }), { kind: 'queued', position: 2 })
  assert.equal(queue.queuedCount, 2)
})

test(`BtwQueue: rejects beyond the cap of ${BTW_QUEUE_CAP}`, () => {
  const queue = new BtwQueue()
  queue.submit({ question: 'a' })
  for (let i = 1; i <= BTW_QUEUE_CAP; i += 1) {
    assert.equal(queue.submit({ question: `q${i}` }).kind, 'queued')
  }
  const rejected = queue.submit({ question: 'overflow' })
  assert.equal(rejected.kind, 'rejected')
  assert.match(rejected.reason, /full/)
})

test('BtwQueue: finishCurrent promotes the next; drained queue runs empty', () => {
  const queue = new BtwQueue()
  assert.equal(queue.finishCurrent(), undefined)
  queue.submit({ question: 'a' })
  queue.submit({ question: 'b' })
  queue.submit({ question: 'c' })
  // Each settle promotes the next job into the running slot (the controller
  // launches exactly what finishCurrent returns).
  assert.equal(queue.finishCurrent().question, 'b')
  assert.equal(queue.running, true)
  assert.equal(queue.finishCurrent().question, 'c')
  assert.equal(queue.running, true)
  assert.equal(queue.finishCurrent(), undefined)
  assert.equal(queue.running, false)
})

test('BtwQueue: cancelAll reports what it dropped and empties everything', () => {
  const queue = new BtwQueue()
  queue.submit({ question: 'a' })
  queue.submit({ question: 'b' })
  assert.deepEqual(queue.cancelAll(), { canceledRunning: true, canceledQueued: 1 })
  assert.equal(queue.running, false)
  assert.equal(queue.queuedCount, 0)
  assert.deepEqual(queue.cancelAll(), { canceledRunning: false, canceledQueued: 0 })
})

// ------------------------------------------------------------ consumeBtwStream --

test('consumeBtwStream: accumulates text deltas and maps stop', async () => {
  const deltas = []
  const finish = await consumeBtwStream(
    chunksOf([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'a' },
      { type: 'reasoning-delta', index: 1, text: 'hidden' },
      { type: 'text-delta', index: 0, text: '' },
      { type: 'text-delta', index: 0, text: 'b' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
    text => { deltas.push(text) },
  )
  assert.deepEqual(finish, { kind: 'stop', answer: 'ab' })
  assert.deepEqual(deltas, ['a', 'b'])
})

test('consumeBtwStream: error finish carries the failure message', async () => {
  const finish = await consumeBtwStream(
    chunksOf([{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }]),
    () => {},
  )
  assert.deepEqual(finish, { kind: 'error', message: 'boom' })
})

test('consumeBtwStream: error finish without a failure detail falls back', async () => {
  const finish = await consumeBtwStream(
    chunksOf([{ type: 'finish', reason: { kind: 'error' } }]),
    () => {},
  )
  assert.match(finish.message, /Unknown model stream error/)
})

test('consumeBtwStream: max-tokens and tool-calls map to explicit errors', async () => {
  const capped = await consumeBtwStream(chunksOf([{ type: 'finish', reason: { kind: 'max-tokens' } }]), () => {})
  assert.match(capped.message, /token cap/)
  const tools = await consumeBtwStream(chunksOf([{ type: 'finish', reason: { kind: 'tool-calls' } }]), () => {})
  assert.match(tools.message, /requested tools/)
})

test('consumeBtwStream: unsupported finish reason is an error, not a crash', async () => {
  const finish = await consumeBtwStream(chunksOf([{ type: 'finish', reason: { kind: 'who-knows' } }]), () => {})
  assert.match(finish.message, /Unsupported stream finish/)
})

test('consumeBtwStream: a stream ending without finish is an error', async () => {
  const finish = await consumeBtwStream(chunksOf([{ type: 'text-delta', index: 0, text: 'half' }]), () => {})
  assert.equal(finish.kind, 'error')
  assert.match(finish.message, /without a finish chunk/)
})

test('consumeBtwStream: finish aborted maps to aborted', async () => {
  const finish = await consumeBtwStream(chunksOf([{ type: 'finish', reason: { kind: 'aborted' } }]), () => {})
  assert.deepEqual(finish, { kind: 'aborted' })
})

test('consumeBtwStream: an already-aborted signal wins immediately', async () => {
  const control = new AbortController()
  control.abort()
  const finish = await consumeBtwStream(
    chunksOf([{ type: 'text-delta', index: 0, text: 'late' }]),
    () => {},
    control.signal,
  )
  assert.deepEqual(finish, { kind: 'aborted' })
})

test('consumeBtwStream: a throwing iterator is an error; abort turns it into aborted', async () => {
  const thrown = await consumeBtwStream(
    (async function* () { throw new Error('socket died') })(),
    () => {},
  )
  assert.deepEqual(thrown, { kind: 'error', message: 'socket died' })

  const control = new AbortController()
  const aborter = (async function* () {
    yield { type: 'text-delta', index: 0, text: 'x' }
    control.abort()
    throw new Error('aborted transport')
  })()
  const aborted = await consumeBtwStream(aborter, () => {}, control.signal)
  assert.deepEqual(aborted, { kind: 'aborted' })
})

// ---------------------------------------------------------- resolveSnapshotLimit --

test('resolveSnapshotLimit: default, clamps, and garbage', () => {
  assert.equal(resolveSnapshotLimit(undefined), BTW_SNAPSHOT_DEFAULT_MESSAGES)
  assert.equal(resolveSnapshotLimit(''), BTW_SNAPSHOT_DEFAULT_MESSAGES)
  assert.equal(resolveSnapshotLimit('nope'), BTW_SNAPSHOT_DEFAULT_MESSAGES)
  assert.equal(resolveSnapshotLimit('3'), 3)
  assert.equal(resolveSnapshotLimit('0'), 0)
  assert.equal(resolveSnapshotLimit('-5'), 0)
  assert.equal(resolveSnapshotLimit('999'), 50)
})

// ---------------------------------------------------------------- BtwController --

test('controller: submit starts a run, streams, settles into the slot', async () => {
  const rig = makeRig({
    streamChunks: [
      { type: 'text-delta', index: 0, text: 'hello ' },
      { type: 'text-delta', index: 0, text: 'world' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    snapshot: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'ctx' }], source: { kind: 'user' } }],
  })
  const result = rig.controller.submit({ question: 'q?' })
  assert.deepEqual(result, { kind: 'started' })
  await flush()
  await flush()

  assert.equal(rig.calls.started.length, 1)
  assert.equal(rig.calls.streamOptions[0].provider, 'p')
  assert.equal(rig.calls.streamOptions[0].model, 'm')
  assert.equal(rig.calls.streamOptions[0].system.length > 0, true)
  assert.equal(rig.calls.streamOptions[0].messages.length, 2)
  assert.deepEqual(rig.calls.streamOptions[0].messages[1].source, { kind: 'plugin', plugin: 'dsh-tui-pi:btw' })

  const last = rig.controller.last
  assert.deepEqual(last, { question: 'q?', answer: 'hello world', modelLabel: 'p/m' })
  assert.equal(rig.controller.currentRun.status, 'done')
  assert.equal(rig.controller.queuedCount, 0)
})

test('controller: the run state object streams into the overlay live', async () => {
  const seen = []
  const rig = makeRig({
    streamChunks: [
      { type: 'text-delta', index: 0, text: 'part' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  rig.controller.submit({ question: 'q' })
  // onRunStarted fired synchronously with the controller's own state object.
  const run = rig.calls.started[0]
  seen.push(run.answerText)
  await flush()
  await flush()
  seen.push(run.answerText, run.status)
  assert.deepEqual(seen, ['', 'part', 'done'])
})

test('controller: reasoningEffort rides along when the selection has one', async () => {
  const rig = makeRig({ selection: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
  rig.controller.submit({ question: 'q' })
  await flush()
  await flush()
  assert.equal(rig.calls.streamOptions[0].reasoningEffort, 'high')
})

test('controller: second submit queues; the queue drains on settle', async () => {
  const rig = makeRig()
  assert.deepEqual(rig.controller.submit({ question: 'one' }), { kind: 'started' })
  assert.deepEqual(rig.controller.submit({ question: 'two' }), { kind: 'queued', position: 1 })
  assert.equal(rig.controller.queuedCount, 1)
  await flush()
  await flush()
  // The queued job launched right after the first settled.
  assert.equal(rig.calls.started.length, 2)
  assert.equal(rig.calls.streamOptions[1].messages.at(-1).content[0].text, 'two')
  assert.equal(rig.controller.last.question, 'two')
  assert.equal(rig.controller.queuedCount, 0)
})

test('controller: cancelAll aborts the stream, drops the queue, closes the overlay', async () => {
  let release
  const released = new Promise(resolve => { release = resolve })
  const rig = makeRig({
    streamChunks: (async function* () {
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await released
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  rig.controller.submit({ question: 'one' })
  await flush()
  assert.equal(rig.controller.currentRun.status, 'streaming')
  rig.controller.submit({ question: 'two' })

  rig.controller.cancelAll()
  await flush()
  assert.equal(rig.calls.closeRequests, 1)
  assert.equal(rig.controller.currentRun, undefined)
  assert.equal(rig.controller.last, undefined)
  assert.equal(rig.controller.queuedCount, 0)
  // Let the suspended generator finish: the abort still wins — the late
  // finish must not resurrect the run or overwrite the slot.
  release()
  await flush()
  await flush()
  assert.equal(rig.controller.last, undefined)
})

test('controller: missing selection notifies and drains instead of hanging', async () => {
  const rig = makeRig({ selection: undefined })
  assert.deepEqual(rig.controller.submit({ question: 'q' }), { kind: 'started' })
  await flush()
  assert.equal(rig.calls.notified.length, 1)
  assert.match(rig.calls.notified[0].message, /No model selected/)
  assert.equal(rig.calls.started.length, 0)
})

test('controller: unavailable --model override notifies with the route', async () => {
  const rig = makeRig()
  // 'nope/' parses as a flag (has a slash) but is not a routable provider.
  rig.controller.submit({ question: 'q', modelOverride: 'nope/' })
  await flush()
  assert.equal(rig.calls.streamOptions.length, 0)
  assert.match(rig.calls.notified[0].message, /nope\//)
})

test('controller: a stream error surfaces via notify when no overlay is open', async () => {
  const rig = makeRig({
    streamChunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'nope' } } }],
  })
  rig.controller.submit({ question: 'q' })
  await flush()
  await flush()
  assert.equal(rig.calls.notified.length, 1)
  assert.match(rig.calls.notified[0].message, /btw failed: nope/)
  assert.equal(rig.controller.currentRun.status, 'error')
  assert.equal(rig.controller.last, undefined)
})

test('controller: with the overlay open the error renders in place, no notify', async () => {
  const rig = makeRig({
    streamChunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'nope' } } }],
  })
  rig.controller.submit({ question: 'q' })
  rig.controller.setOverlayOpen(true)
  await flush()
  await flush()
  assert.equal(rig.calls.notified.length, 0)
  assert.equal(rig.controller.currentRun.status, 'error')
})

test('controller: closing the overlay prunes a settled run, keeps a streaming one', async () => {
  let release
  const released = new Promise(resolve => { release = resolve })
  const rig = makeRig({
    streamChunks: (async function* () {
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await released
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  rig.controller.submit({ question: 'q' })
  await flush()
  rig.controller.setOverlayOpen(true)
  rig.controller.setOverlayOpen(false)
  assert.equal(rig.controller.currentRun.status, 'streaming')

  release()
  await flush()
  await flush()
  assert.equal(rig.controller.currentRun.status, 'done')
  rig.controller.setOverlayOpen(false)
  assert.equal(rig.controller.currentRun, undefined)
  // The slot survives the prune.
  assert.equal(rig.controller.last.answer, 'partial')
})

test('controller: openReview reopens the live run, the slot, or reports empty', async () => {
  const rig = makeRig()
  assert.equal(rig.controller.openReview(), 'empty')

  let release
  const released = new Promise(resolve => { release = resolve })
  const started = makeRig({
    streamChunks: (async function* () {
      await released
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  started.controller.submit({ question: 'live' })
  await flush()
  assert.equal(started.controller.openReview(), 'live')
  assert.equal(started.calls.started.length, 2)
  assert.equal(started.calls.started[1].question, 'live')
  release()
  await flush()
  await flush()
  // The settled run is still the live view (its overlay was never closed),
  // so bare /btw reopens it — pruning only happens through overlay close.
  assert.equal(started.controller.openReview(), 'live')
  assert.equal(started.calls.started[2].status, 'done')
  assert.equal(started.calls.started[2].question, 'live')
  // Once the overlay closed (pruning the settled run), bare /btw reviews the slot.
  started.controller.setOverlayOpen(true)
  started.controller.setOverlayOpen(false)
  assert.equal(started.controller.openReview(), 'review')
  assert.equal(started.calls.started[3].question, 'live')
})

test('controller: a drained launch under a capturing surface runs in the background', async () => {
  let surfaceBusy = true
  const rig = makeRig({
    streamChunks: [
      { type: 'text-delta', index: 0, text: 'bg' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    hasCapturingSurface: () => surfaceBusy,
  })
  assert.deepEqual(rig.controller.submit({ question: 'one' }), { kind: 'started' })
  assert.deepEqual(rig.controller.submit({ question: 'two' }), { kind: 'queued', position: 1 })
  await flush()
  await flush()
  // The first run popped its overlay (user-initiated); the drained second
  // run skipped the popup, notified, and still delivered into the slot.
  assert.equal(rig.calls.started.length, 1)
  assert.deepEqual(
    rig.calls.notified[0],
    { message: 'btw running in the background — /btw to view the answer.', kind: 'info' },
  )
  assert.equal(rig.controller.last.question, 'two')
  assert.equal(rig.controller.last.answer, 'bg')

  // With the surface free again, a drained launch pops normally.
  surfaceBusy = false
  const free = makeRig()
  assert.deepEqual(free.controller.submit({ question: 'one' }), { kind: 'started' })
  assert.deepEqual(free.controller.submit({ question: 'two' }), { kind: 'queued', position: 1 })
  await flush()
  await flush()
  assert.equal(free.calls.started.length, 2)
  assert.equal(free.calls.notified.length, 0)
})

test('controller: dispose aborts everything without overlay ceremony', async () => {
  const rig = makeRig()
  rig.controller.submit({ question: 'q' })
  rig.controller.dispose()
  assert.equal(rig.controller.currentRun, undefined)
  assert.equal(rig.calls.closeRequests, 0)
})
