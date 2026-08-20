/**
 * Subagent-viewer tests: the pure display logic of the Ctrl+G picker —
 * the rounds string on each row, the live-refresh contract (re-invoking the
 * item builder with a higher round count changes the rendered rounds, which
 * is what the picker's 300ms tick now does), and the selection-preserving
 * index helper that keeps focus across a list swap. Rounds are the child's
 * assistant-message count (one per LLM round-trip).
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { pickerItems, nextSelectedIndex, eventLine, eventLines } from '../lib/subagent-viewer.js'

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
