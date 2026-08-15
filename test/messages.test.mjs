/**
 * Panel-line clipping tests — the boxed panels (think block / tool card: top
 * border + header + body rows + bottom border) must never exceed their
 * configured height: every body row's content is clipped to one physical
 * terminal row BEFORE styling, so pi-tui's wrapTextWithAnsi (the Text
 * component wraps at `width - paddingX*2`) has nothing to fold. The default
 * panel is 5 rows (2 body rows); heights are configurable ('5'/'7'/'10' rows
 * or 'all' = print the full body).
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { clipPanelLine, panelBodyText, panelBoxWidth, panelLineCap } from '../lib/messages.js'
import { visibleWidth } from '../lib/text.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

test('panelLineCap leaves headroom for the box chrome and indent', () => {
  // Body Text paddingX = 1 → wraps at columns - 2; every row carries 4
  // columns of box chrome (`│ ` … ` │`); tool rows add a 2-column indent.
  assert.equal(panelLineCap(80), 74)
  assert.equal(panelLineCap(80, 2), 72)
  assert.equal(panelLineCap(120), 114)
  assert.equal(panelLineCap(120, 2), 112)
  // Conservative fallback when the terminal width is unknown (tests, pipes).
  assert.equal(panelLineCap(undefined), 194)
  assert.equal(panelLineCap(undefined, 2), 192)
  assert.equal(panelLineCap(0), 1)
  assert.equal(panelLineCap(-5), 1)
})

test('panelBoxWidth is the full bordered row width (cap + 4 chrome)', () => {
  assert.equal(panelBoxWidth(80), 78)
  assert.equal(panelBoxWidth(120), 118)
  assert.equal(panelBoxWidth(undefined), 198)
})

test('clipPanelLine clips long lines to exactly one physical panel row', () => {
  const cap = panelLineCap(process.stdout.columns)
  const clipped = clipPanelLine('x'.repeat(500))
  assert.ok(visibleWidth(clipped) <= cap, 'clipped line fits the cap')
  // The body Text wraps at width - paddingX*2 (paddingX = 1) → a boxed row
  // of `│ ` + clipped + ` │` (boxWidth = cap + 4) must survive wrapping on
  // a single line at the panel width.
  const boxed = `│ ${clipped} │`
  assert.equal(wrapTextWithAnsi(boxed, cap + 4).length, 1, 'boxed row does not wrap')
  // Short lines pass through untouched.
  assert.equal(clipPanelLine('short line'), 'short line')
  assert.equal(clipPanelLine(''), '')
})

test('clipPanelLine counts CJK full-width columns', () => {
  const cap = panelLineCap(process.stdout.columns)
  const clipped = clipPanelLine('长'.repeat(300))
  assert.ok(visibleWidth(clipped) <= cap)
  assert.equal(wrapTextWithAnsi(`│ ${clipped} │`, cap + 4).length, 1)
  // No surrogate pair is ever split by the clip.
  const emojiClipped = clipPanelLine('👍'.repeat(200))
  assert.equal(visibleWidth(emojiClipped) % 2, 0)
  assert.equal(wrapTextWithAnsi(`│ ${emojiClipped} │`, cap + 4).length, 1)
})

test('clipping before styling keeps the ANSI prefix and one physical row', () => {
  // B1 contract: clip the plain text first, then apply ANSI (clipToWidth
  // counts the ASCII fragments of an SGR code as visible columns, so styled
  // input must never reach the clip).
  const cap = panelLineCap(process.stdout.columns)
  const styled = '\x1b[3m\x1b[38;2;111;66;193m' + clipPanelLine('y'.repeat(400))
  assert.ok(visibleWidth(styled) <= cap, 'styled row still fits the cap')
  assert.equal(wrapTextWithAnsi(`│ ${styled} │`, cap + 4).length, 1, 'styled row does not wrap')
  assert.ok(styled.startsWith('\x1b[3m\x1b[38;2;111;66;193m'), 'style prefix survives')
})

test('boxed rows fit at the narrow-terminal budget (80 columns)', () => {
  // Max think content (74) plus chrome is exactly the box width (78); a row
  // one column wider would wrap. Tool rows carry the 2-column indent.
  const thinkRow = `│ ${'x'.repeat(74)} │`
  assert.equal(visibleWidth(thinkRow), 78)
  assert.equal(wrapTextWithAnsi(thinkRow, 78).length, 1)
  const toolRow = `│ ${'  ' + 'x'.repeat(72)} │`
  assert.equal(visibleWidth(toolRow), 78)
  assert.equal(wrapTextWithAnsi(toolRow, 78).length, 1)
})

test('panelBodyText keeps the tail, boxes every row, appends the bottom border', () => {
  const borderFg = '\x1b[38;2;169;192;171m'
  const body = panelBodyText(['a', 'b', 'c', 'd', 'e'], 20, borderFg)
  const rows = body.split('\n')
  assert.equal(rows.length, 3, '2 body rows + the bottom border')
  assert.deepEqual(rows.slice(0, 2).map(stripAnsi).map(s => s.trimEnd().slice(0, 3)), ['│ d', '│ e'],
    'newest rows win, left-aligned after the left border')
  // Bottom border row.
  assert.match(stripAnsi(rows[2]), /^└─+┘$/, 'bottom border shape')
  assert.equal(visibleWidth(rows[2]), 20, 'bottom border spans the full box width')
  // Every row is exactly boxWidth visible columns.
  for (const row of rows) assert.equal(visibleWidth(row), 20, 'row is one box-width line')
})

test('panelBodyText pads short bodies with empty boxed rows', () => {
  const borderFg = '\x1b[38;2;169;192;171m'
  const body = panelBodyText([], 20, borderFg)
  const rows = body.split('\n')
  assert.equal(rows.length, 3, '2 pad rows + the bottom border')
  // Pad rows are non-empty (the box characters survive Text's trim fast
  // path) and carry both side borders.
  for (const row of rows.slice(0, 2)) {
    assert.ok(stripAnsi(row).startsWith('│'), 'pad row has a left border')
    assert.ok(stripAnsi(row).trimEnd().endsWith('│'), 'pad row has a right border')
    assert.equal(visibleWidth(row), 20)
  }
  assert.match(stripAnsi(rows[2]), /^└─+┘$/, 'bottom border shape')
})

test('panelBodyText rows keep the border color prefix with no trailing RESET', () => {
  const borderFg = '\x1b[38;2;169;192;171m'
  const body = panelBodyText(['a'], 20, borderFg)
  for (const row of body.split('\n')) {
    // No RESET inside: the panel bg function terminates the row.
    assert.ok(!row.includes('\x1b[0m'), 'row carries no trailing reset')
  }
  assert.ok(panelBodyText(['a'], 20, borderFg).includes(borderFg), 'border color applied')
})

test('panelBodyText honors an explicit body-row budget (7/10-row panels)', () => {
  const borderFg = '\x1b[38;2;169;192;171m'
  // 7-row panel → 4 body rows: tail kept, short bodies padded, border appended.
  const body = panelBodyText(['a', 'b', 'c'], 20, borderFg, 4)
  const rows = body.split('\n')
  assert.equal(rows.length, 5, '4 body rows + the bottom border (7-row panel)')
  assert.deepEqual(rows.slice(0, 4).map(stripAnsi).map(s => s.trimEnd().slice(0, 3)), ['│ a', '│ b', '│ c', '│  '],
    'content kept in order, one pad row fills the budget')
  assert.match(stripAnsi(rows[4]), /^└─+┘$/, 'bottom border shape')
  // 10-row panel → 7 body rows.
  const tall = panelBodyText(['x'], 20, borderFg, 7)
  assert.equal(tall.split('\n').length, 8, '7 body rows + the bottom border (10-row panel)')
  // Oversized input still truncates to the tail at a fixed budget.
  const trimmed = panelBodyText(['1', '2', '3', '4', '5'], 20, borderFg, 4)
  const trimmedRows = trimmed.split('\n').map(stripAnsi)
  assert.ok(trimmedRows[0].startsWith('│ 2'), 'fixed budget keeps only the tail')
  assert.ok(trimmedRows[3].startsWith('│ 5'), 'newest row survives the tail cut')
})

test("panelBodyText 'all' keeps every line and closes the box", () => {
  const borderFg = '\x1b[38;2;169;192;171m'
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
  const body = panelBodyText(lines, 20, borderFg, 'all')
  const rows = body.split('\n')
  assert.equal(rows.length, 41, 'all 40 lines + the bottom border — no truncation')
  assert.ok(stripAnsi(rows[0]).startsWith('│ line 1'), 'first line kept')
  assert.ok(stripAnsi(rows[39]).startsWith('│ line 40'), 'last line kept')
  for (const row of rows.slice(0, 40)) {
    assert.equal(visibleWidth(row), 20, 'every body row is one box-width line')
  }
  assert.match(stripAnsi(rows[40]), /^└─+┘$/, 'bottom border closes the box')

  // 'all' never pads: an empty body is just the bottom border (box still closed).
  const empty = panelBodyText([], 20, borderFg, 'all')
  assert.equal(empty.split('\n').length, 1, 'no pad rows in all mode')
  assert.match(stripAnsi(empty), /^└─+┘$/, 'bottom border closes the empty box')
})
