/**
 * Panel-line clipping tests — the fixed 5-row panels (think block / tool
 * card) must never exceed their height: every body row is clipped to one
 * physical terminal row BEFORE styling, so pi-tui's wrapTextWithAnsi (the
 * Text component wraps at `width - paddingX*2`) has nothing to fold.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { clipPanelLine, panelBodyText, panelLineCap } from '../lib/messages.js'
import { visibleWidth } from '../lib/text.js'

test('panelLineCap leaves headroom for the row padding and indent', () => {
  // Body Text paddingX = 1 → wraps at columns - 2; tool rows also carry a
  // 2-column indent, hence the -4 headroom.
  assert.equal(panelLineCap(80), 76)
  assert.equal(panelLineCap(120), 116)
  // Conservative fallback when the terminal width is unknown (tests, pipes).
  assert.equal(panelLineCap(undefined), 196)
  assert.equal(panelLineCap(0), 1)
  assert.equal(panelLineCap(-5), 1)
})

test('clipPanelLine clips long lines to exactly one physical panel row', () => {
  const cap = panelLineCap(process.stdout.columns)
  const clipped = clipPanelLine('x'.repeat(500))
  assert.ok(visibleWidth(clipped) <= cap, 'clipped line fits the cap')
  // The body Text wraps at width - paddingX*2 (paddingX = 1) → contentWidth
  // is cap + 2; a clipped line must survive wrapping on a single row.
  assert.equal(wrapTextWithAnsi(clipped, cap + 2).length, 1, 'no wrap at panel width')
  // Short lines pass through untouched.
  assert.equal(clipPanelLine('short line'), 'short line')
  assert.equal(clipPanelLine(''), '')
})

test('clipPanelLine counts CJK full-width columns', () => {
  const cap = panelLineCap(process.stdout.columns)
  const clipped = clipPanelLine('长'.repeat(300))
  assert.ok(visibleWidth(clipped) <= cap)
  assert.equal(wrapTextWithAnsi(clipped, cap + 2).length, 1)
  // No surrogate pair is ever split by the clip.
  const emojiClipped = clipPanelLine('👍'.repeat(200))
  assert.equal(visibleWidth(emojiClipped) % 2, 0)
  assert.equal(wrapTextWithAnsi(emojiClipped, cap + 2).length, 1)
})

test('clipping before styling keeps the ANSI prefix and one physical row', () => {
  // B1 contract: clip the plain text first, then apply ANSI (clipToWidth
  // counts the ASCII fragments of an SGR code as visible columns, so styled
  // input must never reach the clip).
  const cap = panelLineCap(process.stdout.columns)
  const styled = '\x1b[3m\x1b[38;2;111;66;193m' + clipPanelLine('y'.repeat(400))
  assert.ok(visibleWidth(styled) <= cap, 'styled row still fits the cap')
  assert.equal(wrapTextWithAnsi(styled, cap + 2).length, 1, 'styled row does not wrap')
  assert.ok(styled.startsWith('\x1b[3m\x1b[38;2;111;66;193m'), 'style prefix survives')
})

test('panelBodyText keeps the tail and pads to PANEL_BODY_LINES rows', () => {
  const body = panelBodyText(['a', 'b', 'c', 'd', 'e'])
  const rows = body.split('\n')
  assert.equal(rows.length, 4, 'never more than the 4 body rows')
  assert.deepEqual(rows, ['b', 'c', 'd', 'e'], 'newest rows win')
  // Empty bodies pad with lone-SGR rows so Text does not drop them.
  const padded = panelBodyText([])
  assert.equal(padded.split('\n').length, 4)
  assert.ok(padded.split('\n').every(row => row === '\x1b[39m'))
})
