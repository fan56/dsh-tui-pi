/**
 * Footer hint bar tests - src/footer.ts's buildFooterHint and the no-wrap
 * FooterHint component. buildFooterHint assembles the hint bar from the
 * per-segment on/off selection; FooterHint clips it to the current width so
 * it never word-wraps on a narrow terminal.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_FOOTER_HINTS,
  FOOTER_HINT,
  FOOTER_HINT_ITEMS,
  FooterHint,
  buildFooterHint,
} from '../lib/footer.js'
import { darkTheme } from '../lib/theme/index.js'
import { visibleWidth } from '../lib/text.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

test('buildFooterHint with the default selection equals the legacy FOOTER_HINT', () => {
  assert.equal(buildFooterHint(DEFAULT_FOOTER_HINTS), FOOTER_HINT)
})

test('buildFooterHint keeps only the selected segments, in the fixed display order', () => {
  const shown = { ...DEFAULT_FOOTER_HINTS, send: false, subagents: false }
  const hint = buildFooterHint(shown)
  assert.equal(hint, '⌨ Esc ×2: stop · Ctrl+C ×2: quit · Ctrl+D: quit (empty) · ↑↓: history')
  assert.ok(!hint.includes('Enter: send'))
  assert.ok(!hint.includes('Ctrl+G: subagents'))
})

test('buildFooterHint with every segment off is empty', () => {
  const allOff = Object.fromEntries(FOOTER_HINT_ITEMS.map(item => [item.id, false]))
  assert.equal(buildFooterHint(allOff), '')
})

test('DEFAULT_FOOTER_HINTS covers exactly the six FOOTER_HINT_ITEMS keys, all on', () => {
  const ids = FOOTER_HINT_ITEMS.map(item => item.id)
  assert.deepEqual(Object.keys(DEFAULT_FOOTER_HINTS).sort(), ids.slice().sort())
  for (const id of ids) assert.equal(DEFAULT_FOOTER_HINTS[id], true)
})

test('the default hint is at most 103 visible columns (the pre-feature width)', () => {
  assert.equal(visibleWidth(FOOTER_HINT), 103)
})

test('FooterHint renders one clipped row at any width - never a wrap', () => {
  const hint = new FooterHint(() => darkTheme, () => DEFAULT_FOOTER_HINTS)
  for (const width of [40, 80, 200]) {
    const rows = hint.render(width)
    assert.equal(rows.length, 1, `one row at width ${width}`)
    const plain = stripAnsi(rows[0])
    assert.ok(visibleWidth(plain) <= width, `row fits ${width} (${visibleWidth(plain)})`)
  }
  // Narrow widths clip the tail (the hint is 103 cols); wide widths show it all.
  const narrow = stripAnsi(hint.render(60)[0])
  assert.ok(!narrow.includes('↑↓: history'), 'narrow row clips the trailing segment')
  const wide = stripAnsi(hint.render(200)[0])
  assert.ok(wide.includes('↑↓: history'), 'wide row shows the full hint')
})

test('FooterHint renders zero rows when every hint is off', () => {
  const allOff = Object.fromEntries(FOOTER_HINT_ITEMS.map(item => [item.id, false]))
  const hint = new FooterHint(() => darkTheme, () => allOff)
  assert.deepEqual(hint.render(80), [])
})
