/**
 * Select-panel framework tests — pure functions and navigation state, no TTY
 * needed. Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  columnWidths,
  ListController,
  padCell,
  TABLE_SEP,
} from '../lib/panels.js'
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
  const clippedCjk = padCell('这是一个非常长的中文模型名字', 10)
  assert.ok(visibleWidth(clippedCjk) <= 10)
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
    { key: 'a', title: 'a', width: 30 },
    { key: 'b', title: 'b', flex: true },
  ]
  const widths = columnWidths(20, columns)
  assert.equal(widths[0], 30)
  assert.ok(widths[1] >= 8, 'flex column must keep its floor')
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
