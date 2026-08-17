/**
 * clipToWidth behavior lock — terminal-column clipping must be CJK-aware
 * (full-width characters count 2 columns), surrogate-pair safe, and never
 * wider than the budget. Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { clipToWidth, lastNonBlankLine, visibleWidth } from '../lib/text.js'

test('lastNonBlankLine returns the newest non-blank line, ANSI-stripped and folded', () => {
  assert.equal(lastNonBlankLine('one\ntwo\n\n'), 'two', 'trailing blanks skipped')
  assert.equal(lastNonBlankLine('a  b\tc'), 'a b c', 'interior whitespace folded to one space')
  assert.equal(lastNonBlankLine('\x1b[3mstyled\x1b[23m'), 'styled', 'SGR sequences stripped')
  assert.equal(lastNonBlankLine('crlf\r\nnext\r\n'), 'next', 'CR/LF normalized')
  assert.equal(lastNonBlankLine('bare\rcr'), 'cr', 'a bare CR splits lines — the newest segment wins')
  assert.equal(lastNonBlankLine('  \n\t\n'), undefined, 'blank-only text has no visible line')
  assert.equal(lastNonBlankLine(''), undefined)
})

test('clipToWidth leaves text shorter than the budget untouched, no ellipsis', () => {
  assert.equal(clipToWidth('hello', 10), 'hello')
  assert.equal(clipToWidth('', 10), '')
})

test('clipToWidth keeps exactly-fitting text whole', () => {
  assert.equal(clipToWidth('hello', 5), 'hello')
  assert.equal(clipToWidth('你好世界', 8), '你好世界')
})

test('clipToWidth truncates pure ASCII to the budget', () => {
  assert.equal(clipToWidth('x'.repeat(61), 60), 'x'.repeat(60))
  assert.equal(visibleWidth(clipToWidth('x'.repeat(61), 60)), 60)
})

test('clipToWidth counts CJK full-width as two columns', () => {
  // '你好世界' is 8 columns; at a 4-column budget the prefix '你好' fills it
  // exactly — no column is free for the ellipsis, so the clip is content-only.
  assert.equal(clipToWidth('你好世界', 4), '你好')
  assert.equal(visibleWidth(clipToWidth('你好世界', 4)), 4)
})

test('clipToWidth appends the ellipsis only when a column is free', () => {
  assert.equal(clipToWidth('你好世界', 5), '你好…')
  assert.equal(visibleWidth(clipToWidth('你好世界', 5)), 5)
})

test('clipToWidth never splits a surrogate pair', () => {
  // '👍' is 2 columns: a 1-column budget keeps nothing (and no content).
  assert.equal(clipToWidth('👍', 1), '')
  assert.equal(visibleWidth(clipToWidth('👍', 1)), 0)
  // Two thumbs: budget 3 keeps one thumb (2 columns) + the ellipsis (1).
  assert.equal(clipToWidth('👍👍', 3), '👍…')
  assert.equal(visibleWidth(clipToWidth('👍👍', 3)), 3)
})

test('clipToWidth honors a non-positive budget', () => {
  assert.equal(clipToWidth('anything', 0), '')
  assert.equal(clipToWidth('anything', -1), '')
})
