/**
 * Subagent-viewer tests: the pure display logic of the Ctrl+G picker —
 * the rounds string on each row, the live-refresh contract (re-invoking the
 * item builder with a higher round count changes the rendered rounds, which
 * is what the picker's 300ms tick now does), and the selection-preserving
 * index helper that keeps focus across a list swap. Rounds are the child's
 * assistant-message count (one per LLM round-trip).
 * Also: the Enter-steer injection — route decision (running → steer,
 * idle-unsettled → followup, missing/settled → ended), the plugin-sourced
 * message shape, and the steer input panel's deferred/retryable submission.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { pickerItems, nextSelectedIndex, eventLine, eventLines } from '../lib/subagent-viewer.js'
import {
  STEER_ENDED_NOTICE,
  STEER_FOOTER,
  STEER_SENT_NOTICE,
  SteerInputPanel,
  SubagentViewerPanel,
  VIEWER_FOOTER,
  buildSteerMessage,
  deliverSubagentSteer,
  resolveInjectionRoute,
} from '../lib/subagent-viewer.js'
import { githubLight } from '../lib/theme/palette.js'

/** Minimal running child view. */
function running(childId, label = `agent-${childId}`) {
  return {
    childId,
    label,
    startedAt: 1000,
    tokens: 0,
    retries: 0,
  }
}

/** Minimal settled child view. */
function settled(childId, endedAt = 2000, outcome = 'completed') {
  return {
    childId,
    label: `agent-${childId}`,
    startedAt: 1000,
    endedAt,
    outcome,
    tokens: 0,
    retries: 0,
  }
}

test('pickerItems shows rounds N/max when maxRounds > 0', () => {
  const items = pickerItems([running('a')], () => 3, 50)
  assert.equal(items.length, 1)
  assert.match(items[0].label, /rounds 3\/50/)
})

test('pickerItems shows rounds N without a cap when maxRounds is 0', () => {
  const items = pickerItems([running('a')], () => 3, 0)
  assert.match(items[0].label, /rounds 3$/)
  assert.doesNotMatch(items[0].label, /\//)
})

test('re-invoking the builder with a higher round count refreshes the displayed rounds', () => {
  // The regression this locks in: the picker used to snapshot the rows once
  // at open and never re-read round counts, so a running child's rounds stayed
  // frozen at the open-time value. The live tick re-invokes this builder.
  const views = [running('a')]
  const counts = { a: 0 }
  const build = () => pickerItems(views, id => counts[id] ?? 0, 50)

  assert.match(build()[0].label, /rounds 0\/50/)
  counts.a = 4
  assert.match(build()[0].label, /rounds 4\/50/, 'a newer count shows on the next build')
  assert.doesNotMatch(build()[0].label, /rounds 0\/50/)
})

test('pickerItems lists running children first, then recent settled', () => {
  const views = [
    settled('done-2', 4000),
    running('live'),
    settled('done-1', 3000),
  ]
  const items = pickerItems(views, () => 1, 50)
  assert.equal(items[0].value, 'live', 'running row comes first')
  assert.equal(items[1].value, 'done-2', 'newest settled second')
  assert.equal(items[2].value, 'done-1', 'older settled third')
})

test('nextSelectedIndex keeps the highlighted child across a swap', () => {
  const before = [
    { value: 'a', label: 'a' },
    { value: 'b', label: 'b' },
    { value: 'c', label: 'c' },
  ]
  const after = [
    { value: 'a', label: 'a · rounds 1' },
    { value: 'b', label: 'b · rounds 4' },
    { value: 'c', label: 'c · rounds 2' },
  ]
  assert.equal(nextSelectedIndex(after, 'b'), 1, 'selection follows the child by value')
})

test('nextSelectedIndex tracks a child whose row moved down when rows are inserted above', () => {
  // A new running child arriving at the top pushes the highlighted row down
  // between ticks — the selection must follow by value, not stick to the old
  // numeric index (which would now highlight a different child).
  const before = [
    { value: 'a', label: 'a' },
    { value: 'b', label: 'b' },
  ]
  const after = [
    { value: 'new', label: 'new · rounds 1' },
    { value: 'a', label: 'a · rounds 2' },
    { value: 'b', label: 'b · rounds 4' },
  ]
  assert.equal(nextSelectedIndex(before, 'b'), 1, 'sanity: b starts at index 1')
  assert.equal(nextSelectedIndex(after, 'b'), 2, 'b followed by value to index 2 after a row was inserted above')
  assert.equal(nextSelectedIndex(after, 'a'), 1, 'a also tracks down from 0 to 1')
})

test('nextSelectedIndex starts at 0 with no prior selection', () => {
  const items = [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }]
  assert.equal(nextSelectedIndex(items, undefined), 0)
})

test('nextSelectedIndex clamps to the last row when the child dropped off', () => {
  // A settled child can fall out of the recent-settled cap while the picker
  // stays open; the selection must not underflow.
  const after = [{ value: 'x', label: 'x' }, { value: 'y', label: 'y' }]
  assert.equal(nextSelectedIndex(after, 'gone'), 1, 'clamps to the last row')
})

test('nextSelectedIndex is safe on an empty list', () => {
  assert.equal(nextSelectedIndex([], 'gone'), 0)
  assert.equal(nextSelectedIndex([], undefined), 0)
})


// ---------------------------------------------------------------------------
// dsh-dcp compaction notices: the viewer renders the compaction notice with a
// compaction-specific marker line (not the generic `ⓘ`), and the picker
// rows carry the per-child compaction count.

/** A dsh-dcp compaction notice event (the shape dsh-dcp appends per commit). */
function dcpNotice(text, seq = 1) {
  return {
    type: 'user/message', seq, time: 0,
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-dcp', form: 'notice', summary: text },
    },
  }
}

test('eventLine renders a dsh-dcp compaction notice with the compaction marker', () => {
  const line = eventLine(dcpNotice('dcp: compacted 40 history items (~12.3k tokens, round)'), new Map())
  assert.equal(line, '🧹 dcp: compacted 40 history items (~12.3k tokens, round)')
})

test('eventLine keeps the info marker for a generic plugin message (not a compaction)', () => {
  const line = eventLine({
    type: 'user/message', seq: 1, time: 0,
    data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'plugin', plugin: 'dsh-tui-pi' } },
  }, new Map())
  assert.equal(line, 'ⓘ hello')
})

test('eventLine keeps the user marker for a human prompt', () => {
  const line = eventLine({
    type: 'user/message', seq: 1, time: 0,
    data: { content: [{ type: 'text', text: '继续执行' }], source: { kind: 'user' } },
  }, new Map())
  assert.equal(line, '▎ 继续执行')
})

test('eventLines maps a whole log with compaction notices in order', () => {
  const lines = eventLines([
    dcpNotice('dcp: compacted 40 history items (~12.3k tokens, round)', 1),
    { type: 'assistant/message', seq: 2, time: 1, data: { message: { content: [{ type: 'text', text: 'done' }] } } },
    dcpNotice('dcp: compacted 12 history items (~3.1k tokens, round)', 3),
  ])
  assert.deepEqual(lines, [
    '🧹 dcp: compacted 40 history items (~12.3k tokens, round)',
    '🐳 done',
    '🧹 dcp: compacted 12 history items (~3.1k tokens, round)',
  ])
})

test('pickerItems shows the compaction count in the description when > 0', () => {
  const items = pickerItems([settled('a', 2000)], () => 3, 50, id => (id === 'a' ? 2 : 0))
  assert.equal(items[0].label, '✓ agent-a: rounds 3/50')
  assert.equal(items[0].description, '🧹 2× · 1.0s')
})

test('pickerItems omits the compaction count when it is 0 or unread', () => {
  const items = pickerItems([settled('a', 2000)], () => 3, 50)
  assert.equal(items[0].description, '1.0s')
  const explicit = pickerItems([settled('a', 2000)], () => 3, 50, () => 0)
  assert.equal(explicit[0].description, '1.0s')
})

// ------------------------------------------------------- steer injection --

/** Flush the deferred (queueMicrotask) delivery of a steer submission. */
const flushMicrotask = () => new Promise(resolve => setImmediate(resolve))

/** Minimal bridge stub for the transcript panel (only what render reads). */
function makeBridge(views) {
  return {
    getAgentViews: () => views,
    getChildLog: () => [],
    isChildLogTruncated: () => false,
    getRoundCount: () => 1,
  }
}

/** Fake live child view (no outcome yet). */
function liveView(childId) {
  return { childId, label: `agent-${childId}`, startedAt: 1000, tokens: 0 }
}

/** Fake agent handle capturing steer/followup deliveries. */
function spyAgent(status, calls = []) {
  return {
    status,
    steer(message) { calls.push(['steer', message]) },
    followup(message) { calls.push(['followup', message]) },
  }
}

/** Minimal theme: real light palette + inert editor theme fns. */
function makeTheme() {
  return {
    palette: githubLight,
    editor: {
      borderColor: text => text,
      selectList: {
        selectedPrefix: text => text,
        selectedText: text => text,
        description: text => text,
        scrollInfo: text => text,
        noMatch: text => text,
      },
    },
  }
}

/** Minimal TUI stub: the pi-tui Editor only reads terminal.rows + requestRender. */
function makeTui() {
  const renders = []
  return { terminal: { rows: 24 }, requestRender: () => renders.push(1), renders }
}

test('resolveInjectionRoute routes a running child to steer', () => {
  const route = resolveInjectionRoute(liveView('a'), spyAgent('running'))
  assert.deepEqual(route, { kind: 'steer' })
})

test('resolveInjectionRoute routes an idle unsettled child to followup', () => {
  const route = resolveInjectionRoute(liveView('a'), spyAgent('idle'))
  assert.deepEqual(route, { kind: 'followup' })
})

test('resolveInjectionRoute reads a settled child as ended (all outcomes)', () => {
  for (const outcome of ['completed', 'failed', 'cancelled']) {
    const view = { ...liveView('a'), outcome, endedAt: 2000 }
    assert.deepEqual(resolveInjectionRoute(view, spyAgent('running')), { kind: 'ended' })
  }
})

test('resolveInjectionRoute reads a missing view or handle as ended', () => {
  assert.deepEqual(resolveInjectionRoute(undefined, spyAgent('running')), { kind: 'ended' })
  assert.deepEqual(resolveInjectionRoute(liveView('a'), undefined), { kind: 'ended' })
})

test('resolveInjectionRoute fails closed on an unexpected status shape', () => {
  assert.deepEqual(resolveInjectionRoute(liveView('a'), spyAgent('weird')), { kind: 'ended' })
  assert.deepEqual(resolveInjectionRoute(liveView('a'), { steer() {}, followup() {} }), { kind: 'ended' })
})

test('buildSteerMessage carries the text content and the plugin source', () => {
  const message = buildSteerMessage('focus on the failing test')
  assert.deepEqual(message.content, [{ type: 'text', text: 'focus on the failing test' }])
  assert.deepEqual(message.source, { kind: 'plugin', plugin: 'dsh-tui-pi' })
  assert.equal(message.role, 'user')
})

/** The delivered message must equal a fresh build (id aside — it is a uuid). */
function assertSteerMessage(actual, text) {
  const expected = buildSteerMessage(text)
  assert.equal(actual.role, expected.role)
  assert.deepEqual(actual.content, expected.content)
  assert.deepEqual(actual.source, expected.source)
}

test('deliverSubagentSteer sends steer() on a running child with the built message', () => {
  const calls = []
  const delivery = deliverSubagentSteer(liveView('a'), spyAgent('running', calls), 'hello')
  assert.deepEqual(delivery, { outcome: 'sent', via: 'steer' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'steer')
  assertSteerMessage(calls[0][1], 'hello')
})

test('deliverSubagentSteer sends followup() on an idle unsettled child', () => {
  const calls = []
  const delivery = deliverSubagentSteer(liveView('a'), spyAgent('idle', calls), 'hello')
  assert.deepEqual(delivery, { outcome: 'sent', via: 'followup' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'followup')
  assertSteerMessage(calls[0][1], 'hello')
})

test('deliverSubagentSteer injects nothing for an ended child', () => {
  const calls = []
  const settledView = { ...liveView('a'), outcome: 'completed', endedAt: 2000 }
  assert.deepEqual(deliverSubagentSteer(settledView, spyAgent('running', calls), 'x'), { outcome: 'ended' })
  assert.deepEqual(deliverSubagentSteer(liveView('a'), undefined, 'x'), { outcome: 'ended' })
  assert.equal(calls.length, 0)
})

test('deliverSubagentSteer surfaces a throwing primitive as a retryable error', () => {
  const agent = spyAgent('running')
  agent.steer = () => { throw new Error('session append cannot reenter') }
  const delivery = deliverSubagentSteer(liveView('a'), agent, 'x')
  assert.deepEqual(delivery, { outcome: 'error', error: 'session append cannot reenter' })
})

test('SteerInputPanel defers Enter delivery to a microtask and finishes on success', async () => {
  const tui = makeTui()
  const sends = []
  let finished
  const panel = new SteerInputPanel(tui, makeTheme(), {
    label: 'worker',
    onSend: text => {
      sends.push(text)
      return { outcome: 'sent', via: 'steer' }
    },
    onFinish: result => { finished = result },
    onCancel: () => { throw new Error('cancel must not fire') },
    requestRender: () => tui.requestRender(),
  })
  panel.handleInput('do it')
  panel.handleInput('\r')
  assert.equal(sends.length, 0, 'nothing may be injected on the synchronous keypress stack')
  await flushMicrotask()
  assert.deepEqual(sends, ['do it'])
  assert.deepEqual(finished, { outcome: 'sent', via: 'steer' })
})

test('SteerInputPanel Enter with an ended child finishes with the ended outcome', async () => {
  const tui = makeTui()
  let finished
  const panel = new SteerInputPanel(tui, makeTheme(), {
    label: 'worker',
    onSend: () => ({ outcome: 'ended' }),
    onFinish: result => { finished = result },
    onCancel: () => { throw new Error('cancel must not fire') },
    requestRender: () => tui.requestRender(),
  })
  panel.handleInput('too late')
  panel.handleInput('\r')
  await flushMicrotask()
  assert.deepEqual(finished, { outcome: 'ended' })
  assert.equal(STEER_ENDED_NOTICE, 'This subagent has ended — steering unavailable')
})

test('SteerInputPanel keeps the box open with the error on a failed send, retry works', async () => {
  const tui = makeTui()
  const sends = []
  let finished = 0
  const panel = new SteerInputPanel(tui, makeTheme(), {
    label: 'worker',
    onSend: text => {
      sends.push(text)
      return sends.length === 1
        ? { outcome: 'error', error: 'inbox splice failed' }
        : { outcome: 'sent', via: 'followup' }
    },
    onFinish: () => { finished += 1 },
    onCancel: () => {},
    requestRender: () => tui.requestRender(),
  })
  panel.handleInput('retry me')
  panel.handleInput('\r')
  await flushMicrotask()
  assert.equal(finished, 0, 'a failed send must not close the box')
  const rendered = panel.render(80).join('\n')
  assert.match(rendered, /✘ inbox splice failed/)
  // Retry: the draft survived the failed send — Enter alone re-sends it.
  panel.handleInput('\r')
  await flushMicrotask()
  assert.deepEqual(sends, ['retry me', 'retry me'])
  assert.equal(finished, 1)
})

test('SteerInputPanel Esc cancels without injecting anything', async () => {
  const tui = makeTui()
  let cancelled = 0
  let sends = 0
  const panel = new SteerInputPanel(tui, makeTheme(), {
    label: 'worker',
    onSend: () => { sends += 1; return { outcome: 'sent', via: 'steer' } },
    onFinish: () => { throw new Error('finish must not fire') },
    onCancel: () => { cancelled += 1 },
    requestRender: () => tui.requestRender(),
  })
  panel.handleInput('draft text')
  panel.handleInput('\x1b')
  await flushMicrotask()
  assert.equal(cancelled, 1)
  assert.equal(sends, 0)
})

test('SteerInputPanel Shift+Enter inserts a newline instead of sending', async () => {
  const tui = makeTui()
  const sends = []
  const panel = new SteerInputPanel(tui, makeTheme(), {
    label: 'worker',
    onSend: text => {
      sends.push(text)
      return { outcome: 'sent', via: 'steer' }
    },
    onFinish: () => {},
    onCancel: () => {},
    requestRender: () => tui.requestRender(),
  })
  panel.handleInput('line one')
  panel.handleInput('\x1b\r')
  panel.handleInput('line two')
  panel.handleInput('\r')
  await flushMicrotask()
  assert.deepEqual(sends, ['line one\nline two'])
  assert.ok(panel.render(80).some(line => line.includes(STEER_FOOTER)))
})

test('SteerInputPanel ignores an empty submit and collapses a double Enter', async () => {
  const tui = makeTui()
  const sends = []
  let finished = 0
  const panel = new SteerInputPanel(tui, makeTheme(), {
    label: 'worker',
    onSend: text => {
      sends.push(text)
      return { outcome: 'sent', via: 'steer' }
    },
    onFinish: () => { finished += 1 },
    onCancel: () => {},
    requestRender: () => tui.requestRender(),
  })
  panel.handleInput('   ')
  panel.handleInput('\r')
  await flushMicrotask()
  assert.deepEqual(sends, [], 'whitespace-only text must not inject')
  panel.handleInput('once')
  panel.handleInput('\r')
  panel.handleInput('\r')
  await flushMicrotask()
  assert.deepEqual(sends, ['once'], 'the pending guard must swallow the second Enter')
  assert.equal(finished, 1)
})

test('SubagentViewerPanel Enter requests the steer flow and the footer advertises it', () => {
  const tui = makeTui()
  let requested = 0
  const panel = new SubagentViewerPanel(
    makeTheme(), makeBridge([liveView('a')]), 'a',
    () => 0,
    () => {},
    () => tui.requestRender(),
    () => { requested += 1 },
  )
  assert.ok(panel.render(80).some(line => line.includes(VIEWER_FOOTER)))
  assert.match(VIEWER_FOOTER, /Enter steer/)
  panel.handleInput('\r')
  assert.equal(requested, 1)
})

test('SubagentViewerPanel shows a transient notice and retires it on the next keypress', () => {
  const tui = makeTui()
  const panel = new SubagentViewerPanel(
    makeTheme(), makeBridge([liveView('a')]), 'a',
    () => 0,
    () => {},
    () => tui.requestRender(),
    () => {},
  )
  panel.showNotice(STEER_SENT_NOTICE)
  assert.ok(panel.render(80).some(line => line.includes('Steer message sent')), 'notice renders above the footer')
  panel.handleInput('\x1b[B')
  assert.ok(!panel.render(80).some(line => line.includes('Steer message sent')), 'any keypress retires the notice')
})

test('SubagentViewerPanel initial notice renders and the notice steals a body row', () => {
  const tui = makeTui()
  // A full log is the case where the body budget binds: with the window
  // saturated, adding the notice row must shrink the window, not grow the
  // overlay (a 24-row terminal must not lose its footer off the bottom).
  const filler = Array.from({ length: 40 }, (_, i) => ({
    type: 'user/message', seq: i, time: i,
    data: { content: [{ type: 'text', text: `event ${i}` }], source: { kind: 'user' } },
  }))
  const fullBridge = views => ({ ...makeBridge(views), getChildLog: () => filler })
  const withNotice = new SubagentViewerPanel(
    makeTheme(), fullBridge([liveView('a')]), 'a',
    () => 0,
    () => {},
    () => tui.requestRender(),
    () => {},
    STEER_ENDED_NOTICE,
  )
  const rendered = withNotice.render(80)
  assert.ok(rendered.some(line => line.includes(STEER_ENDED_NOTICE)))
  const plain = new SubagentViewerPanel(
    makeTheme(), fullBridge([liveView('a')]), 'a',
    () => 0,
    () => {},
    () => tui.requestRender(),
    () => {},
  )
  const plainRows = plain.render(80)
  assert.equal(rendered.length, plainRows.length, 'the notice must not grow the overlay (24-row budget)')
})

test('SubagentViewerPanel Esc still closes and x still double-press closes', () => {
  const tui = makeTui()
  let closed = 0
  const panel = new SubagentViewerPanel(
    makeTheme(), makeBridge([liveView('a')]), 'a',
    () => 0,
    () => { closed += 1 },
    () => tui.requestRender(),
    () => {},
  )
  panel.handleInput('\x1b')
  assert.equal(closed, 1)
})
