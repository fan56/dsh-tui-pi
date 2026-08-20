/**
 * Select-panel framework tests — pure functions and navigation state, no TTY
 * needed. Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  columnWidths,
  FieldPanel,
  filterSettingsRows,
  fitColumnWidth,
  ListController,
  padCell,
  SettingsListPanel,
  TABLE_SEP,
  tableHeaderLine,
  TablePanel,
  tableRuleLine,
} from '../lib/panels.js'
import { githubLight } from '../lib/theme/palette.js'
import { visibleWidth } from '../lib/text.js'

test('padCell: pads short text to the exact visible width, CJK-aware', () => {
  assert.equal(padCell('oldfox', 12), 'oldfox      ')
  assert.equal(visibleWidth(padCell('oldfox', 12)), 12)
  // CJK: 老法师 is 6 visible columns, padded to 12.
  const cjk = padCell('老法师', 12)
  assert.equal(visibleWidth(cjk), 12)
  assert.equal(cjk, '老法师      ')
  assert.equal(padCell('', 4), '    ')
})

test('padCell: right-align puts the padding on the left', () => {
  assert.equal(padCell('3', 4, 'right'), '   3')
  assert.equal(padCell('12', 4, 'right'), '  12')
})

test('padCell: never exceeds the width, ellipsis included', () => {
  const clipped = padCell('a very long model name that overflows', 10)
  assert.ok(visibleWidth(clipped) <= 10, `clipped cell must fit: "${clipped}"`)
  assert.ok(clipped.includes('…'), 'a cell that loses content ends with an ellipsis')
  const clippedCjk = padCell('这是一个非常长的中文模型名字', 10)
  assert.ok(visibleWidth(clippedCjk) <= 10)
  assert.ok(clippedCjk.includes('…'), 'CJK clips are marked too')
})

test('columnWidths: fixed columns keep width, flex takes the remainder', () => {
  const columns = [
    { key: 'name', title: 'name', width: 12 },
    { key: 'model', title: 'model', width: 24 },
    { key: 'deep', title: 'deep', width: 4, align: 'right' },
    { key: 'description', title: 'description', flex: true },
  ]
  const widths = columnWidths(110, columns)
  assert.deepEqual(widths, [12, 24, 4, 110 - 12 - 24 - 4 - visibleWidth(TABLE_SEP) * 3])
  const total = widths.reduce((sum, w) => sum + w, 0) + visibleWidth(TABLE_SEP) * 3
  assert.equal(total, 110, 'fixed + flex + separators must fill the width exactly')
})

test('columnWidths: flex column floors out on narrow widths', () => {
  const columns = [
    { key: 'a', title: 'A', width: 10 },
    { key: 'b', title: 'B', flex: true },
  ]
  const widths = columnWidths(20, columns)
  assert.equal(widths[0], 10)
  assert.ok(widths[1] >= 8, 'flex column must keep its floor')
})

// ---------------------------------------------------------- table language --

test('fitColumnWidth: widest of title and cells, capped', () => {
  assert.equal(fitColumnWidth('Provider', ['deepseek', 'zhipu'], 18), 8)
  // The UPPERCASE title participates: a short-cell column still fits TITLE.
  assert.equal(fitColumnWidth('on', ['●', '○'], 8), 2)
  // Cells beyond the cap clip — the width stays at the cap.
  assert.equal(fitColumnWidth('Key ref', ['a-very-long-ref-name'], 8), 8)
})

test('tableHeaderLine: marker slot + uppercase titles joined by the separator', () => {
  const columns = [
    { key: 'model', title: 'Model', flex: true },
    { key: 'provider', title: 'Provider', width: 8 },
  ]
  const widths = [20, 8]
  const header = tableHeaderLine(columns, widths)
  assert.ok(header.startsWith('  MODEL'), 'marker slot + uppercased title')
  assert.ok(header.includes('PROVIDER'), 'titles are uppercased')
  assert.equal(header.indexOf('│'), 2 + 20 + 1, 'separator sits after the flex column + its pad')
  assert.equal(visibleWidth(header), 2 + 20 + 3 + 8, 'header fills exactly its column budget')
})

test('tableRuleLine: junctions land exactly under the header separators', () => {
  const widths = [6, 4]
  const rule = tableRuleLine(widths)
  assert.equal(rule, '  ───────┼─────')
  // The ┼ position equals where TABLE_SEP puts the │ after the marker slot.
  assert.equal(rule.indexOf('┼'), 2 + 6 + 1)
  assert.equal(visibleWidth(rule), 2 + 6 + 3 + 4)
})

test('TablePanel render: title + header + rule + separator-aligned rows', () => {
  const columns = [
    { key: 'model', title: 'Model', flex: true },
    { key: 'provider', title: 'Provider', width: 9 },
  ]
  const rows = [
    { name: 'deepseek-chat', provider: 'deepseek' },
    { name: 'glm-4.7', provider: 'zhipu' },
  ]
  const panel = new TablePanel(theme, {
    title: '● Model',
    columns,
    rows,
    renderCell: (row, column) => (column.key === 'provider' ? row.provider : row.name),
    onSelect: () => {},
    onCancel: () => {},
  })
  const lines = panel.render(48)
  // Title, blank, header, rule, 2 rows, blank, footer.
  assert.equal(lines.length, 8)
  assert.equal(stripAnsi(lines[0]), '● Model')
  assert.match(stripAnsi(lines[2]), /^  MODEL\s+│ PROVIDER\s*$/)
  assert.match(stripAnsi(lines[3]), /^  ─+┼─+\s*$/)
  const row0 = stripAnsi(lines[4])
  const row1 = stripAnsi(lines[5])
  assert.match(row0, /^▸ deepseek-chat\s+│ deepseek\s*$/)
  assert.match(row1, /^  glm-4\.7\s+│ zhipu\s*$/)
  assert.equal(row0.indexOf('│'), row1.indexOf('│'), 'provider column aligns across rows')
  assert.equal(row0.indexOf('│'), stripAnsi(lines[2]).indexOf('│'), 'rows align with the header')
})

test('FieldPanel render: FIELD │ VALUE header + rule + ✎ affordance', () => {
  const panel = new FieldPanel(theme, {
    title: 'agent fields',
    fields: [
      { key: 'model', value: 'deepseek-chat' },
      { key: 'deep', value: '3', editable: false },
    ],
    onEdit: () => {},
    onCancel: () => {},
  })
  const lines = panel.render(48)
  // Title, blank, header, rule, 2 fields, blank, footer.
  assert.equal(lines.length, 8)
  assert.match(stripAnsi(lines[2]), /^  FIELD\s+│ VALUE/)
  assert.match(stripAnsi(lines[3]), /^  ─+┼─+\s*$/)
  assert.match(stripAnsi(lines[4]), /^▸ model\s+│ ✎ deepseek-chat\s*$/)
  assert.match(stripAnsi(lines[5]), /^  deep\s+│ 3\s*$/)
  assert.equal(
    stripAnsi(lines[4]).indexOf('│'),
    stripAnsi(lines[5]).indexOf('│'),
    'value column aligns across fields',
  )
})

test('ListController: navigation clamps at both ends', () => {
  const c = new ListController(() => 3)
  c.up()
  assert.equal(c.index, 0)
  c.down()
  c.down()
  c.down()
  assert.equal(c.index, 2)
  c.down()
  assert.equal(c.index, 2, 'down past the end clamps')
  c.up()
  c.up()
  assert.equal(c.index, 0)
})

test('ListController: pageUp/pageDown move by the viewport', () => {
  const c = new ListController(() => 40)
  c.setIndex(20)
  c.pageDown()
  assert.equal(c.index, 32)
  c.pageUp()
  assert.equal(c.index, 20)
  c.setIndex(39)
  c.pageDown()
  assert.equal(c.index, 39, 'pageDown clamps at the end')
  c.setIndex(0)
  c.pageUp()
  assert.equal(c.index, 0)
})

test('ListController: scroll follows the selection into the viewport', () => {
  const c = new ListController(() => 40)
  assert.equal(c.scroll, 0)
  c.setIndex(30)
  assert.equal(c.scroll, 30 - 12 + 1, 'selection below the viewport scrolls down')
  c.up()
  c.up()
  assert.equal(c.index, 28)
  assert.equal(c.scroll, 19)
  c.setIndex(0)
  assert.equal(c.scroll, 0, 'selection above the viewport scrolls back up')
})

test('ListController: empty list never overflows', () => {
  const c = new ListController(() => 0)
  c.down()
  c.pageDown()
  c.setIndex(5)
  assert.equal(c.index, 0)
  assert.equal(c.scroll, 0)
})

// --------------------------------------------------------- SettingsListPanel --

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')
/** "r;g;b" triple of a #rrggbb hex color, for SGR assertions. */
const hexRgb = hex => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
].join(';')
/** Minimal theme the panel reads (palette only). */
const theme = { palette: githubLight }

test('filterSettingsRows: empty query returns every row unchanged', () => {
  const rows = [
    { id: 'a', label: 'Models', value: '3 namespaces' },
    { id: 'b', label: 'llm-deepseek', value: '5 fields' },
  ]
  const filtered = filterSettingsRows(rows, '')
  assert.equal(filtered.length, 2)
  assert.deepEqual(filtered.map(row => row.id), ['a', 'b'])
  assert.notEqual(filtered, rows, 'returns a new array')
})

test('filterSettingsRows: case-insensitive fuzzy match on the label', () => {
  const rows = [
    { id: 'a', label: 'Models', value: '' },
    { id: 'b', label: 'llm-deepseek', value: '' },
    { id: 'c', label: 'web-search-deepseek', value: '' },
    { id: 'd', label: 'Agent Presets', value: '' },
  ]
  // Subsequence matching (the old SettingsList search): 'deepseek' hits the
  // namespaces that contain it, not Models / Agent Presets.
  assert.deepEqual(filterSettingsRows(rows, 'deepseek').map(row => row.id), ['b', 'c'])
  assert.deepEqual(filterSettingsRows(rows, 'MODELS').map(row => row.id), ['a'])
  assert.deepEqual(filterSettingsRows(rows, 'z').length, 0)
})

test('filterSettingsRows: whitespace/slash tokens all must match', () => {
  const rows = [
    { id: 'a', label: 'web-search-deepseek', value: '' },
    { id: 'b', label: 'shell', value: '' },
  ]
  assert.deepEqual(filterSettingsRows(rows, 'search deepseek').map(row => row.id), ['a'])
  assert.deepEqual(filterSettingsRows(rows, 'search shell').length, 0)
})

test('SettingsListPanel render: accent BOLD title + whole-row selection + footer', () => {
  const rows = [
    { id: 'a', label: 'Models', value: '3 namespaces' },
    { id: 'b', label: 'General', value: '2 namespaces' },
    { id: 'c', label: 'Plugins', value: '1 namespace' },
  ]
  const panel = new SettingsListPanel(theme, {
    title: '⚙ settings',
    rows,
    onCancel: () => {},
  })
  const lines = panel.render(40)
  // Title row, blank, header, rule, 3 rows, blank, footer.
  assert.equal(lines.length, 9)
  // Title: accent fg + BOLD, plain text is the title.
  assert.equal(stripAnsi(lines[0]), '⚙ settings')
  assert.ok(lines[0].includes('\x1b[1m'), 'title is bold')
  assert.ok(lines[0].includes(`\x1b[38;2;${hexRgb(githubLight.accent)}m`), 'title uses accent')
  // Header row: uppercase titles, marker-slot indented, subtle.
  assert.match(stripAnsi(lines[2]), /^  SETTING\s+│ VALUE\s*$/)
  assert.ok(lines[2].includes(`\x1b[38;2;${hexRgb(githubLight.fgSubtle)}m`), 'header is subtle')
  // Rule row: ─ runs with the ┼ junction exactly under the header's │.
  assert.match(stripAnsi(lines[3]), /^  ─+┼─+\s*$/)
  assert.equal(
    stripAnsi(lines[2]).indexOf('│'),
    stripAnsi(lines[3]).indexOf('┼'),
    'rule junction sits under the header separator',
  )
  // Selected row 0: accent + BOLD with the ▸ marker; label padded so the
  // value column aligns behind the │ separator.
  assert.match(stripAnsi(lines[4]), /^▸ Models\s+│ 3 namespaces\s*$/)
  assert.ok(lines[4].includes('\x1b[1m'), 'selected row is bold')
  assert.ok(lines[4].includes(`\x1b[38;2;${hexRgb(githubLight.accent)}m`), 'selected row uses accent')
  // Unselected rows: muted, no accent, no bold, same column alignment.
  assert.match(stripAnsi(lines[5]), /^  General\s+│ 2 namespaces\s*$/)
  assert.ok(!lines[5].includes('\x1b[1m'), 'unselected row not bold')
  assert.ok(!lines[5].includes(`\x1b[38;2;${hexRgb(githubLight.accent)}m`), 'unselected row not accent')
  assert.ok(lines[5].includes(`\x1b[38;2;${hexRgb(githubLight.fgMuted)}m`), 'unselected row is muted')
  assert.equal(
    stripAnsi(lines[4]).indexOf('│'),
    stripAnsi(lines[5]).indexOf('│'),
    'value column aligns across rows',
  )
  // Footer.
  assert.equal(stripAnsi(lines[8]), '↑↓ navigate · Enter select · Esc back')
  assert.ok(lines[8].includes(`\x1b[38;2;${hexRgb(githubLight.fgSubtle)}m`), 'footer is subtle')
})

test('SettingsListPanel render: all-empty values collapse to a single column', () => {
  const rows = [
    { id: 'a', label: 'General', value: '' },
    { id: 'b', label: 'Models', value: '' },
  ]
  const panel = new SettingsListPanel(theme, { title: 'T', rows, onCancel: () => {} })
  const lines = panel.render(40)
  // No VALUE column, no separator on rows, no ┼ rule — the header is the
  // only table chrome left (single column ⇒ no rule row either).
  assert.match(stripAnsi(lines[2]), /^  SETTING\s*$/)
  assert.match(stripAnsi(lines[3]), /^▸ General\s*$/)
  assert.ok(!stripAnsi(lines[3]).includes('│'), 'no column separator without a second column')
})

test('SettingsListPanel render: rows never paint their own background', () => {
  const rows = [
    { id: 'a', label: 'one', value: '1' },
    { id: 'b', label: 'two', value: '2' },
  ]
  const panel = new SettingsListPanel(theme, { title: 'T', rows, onCancel: () => {} })
  const bg = `\x1b[48;2;${hexRgb(githubLight.canvasSubtle)}m`
  for (const line of panel.render(30)) {
    assert.ok(!line.includes(bg), `row must not paint canvasSubtle itself: "${line}"`)
  }
})

test('SettingsListPanel render: description line + scroll info in the footer', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({
    id: String(i),
    label: `row-${i}`,
    value: String(i),
    ...(i === 0 ? { description: 'the first row' } : {}),
  }))
  const panel = new SettingsListPanel(theme, { title: 'T', rows, onCancel: () => {} })
  const lines = panel.render(60)
  // Title, blank, header, rule, 10 visible rows, description, blank, footer.
  assert.equal(lines.length, 17)
  assert.ok(stripAnsi(lines[14]).includes('the first row'), 'selected row description shown')
  // The list overflows (15 > 10) so the footer carries the scroll info.
  assert.ok(stripAnsi(lines[16]).includes('(1/15)'), 'footer carries scroll info')
  assert.ok(stripAnsi(lines[16]).includes('Enter select'))
})
