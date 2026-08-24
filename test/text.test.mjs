/**
 * clipToWidth behavior lock — terminal-column clipping must be CJK-aware
 * (full-width characters count 2 columns), surrogate-pair safe, and never
 * wider than the budget. Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { clipToWidth, lastNonBlankLine, visibleWidth, wrapText } from '../lib/text.js'

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

// ------------------------------------------------------------------ wrapText --

test('wrapText returns short text as a single line, unchanged', () => {
  assert.deepEqual(wrapText('hello world', 20), ['hello world'])
  assert.deepEqual(wrapText('', 10), [''], 'empty input still yields one (empty) line')
})

test('wrapText breaks between words when the budget is exceeded', () => {
  const lines = wrapText('deploy to the staging cluster', 12)
  assert.ok(lines.length >= 3, `wraps onto several lines: ${JSON.stringify(lines)}`)
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 12, `line "${line}" stays within the budget`)
  }
  assert.equal(lines.join(' '), 'deploy to the staging cluster', 'no words lost or reordered')
})

test('wrapText hard-breaks a single word wider than the budget', () => {
  const lines = wrapText('x'.repeat(25), 10)
  assert.equal(lines.length, 3)
  assert.deepEqual(lines.map(l => l.length), [10, 10, 5])
})

test('wrapText wraps CJK text without spaces at the column limit', () => {
  // '你好世界' is 8 columns — no spaces, so wrapping must break by width.
  const lines = wrapText('你好世界你好世界', 6)
  assert.equal(lines.length, 3)
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 6, `CJK line "${line}" stays within ${6} columns`)
  }
  assert.equal(lines.join(''), '你好世界你好世界', 'no characters lost')
})

test('wrapText never splits a surrogate pair while hard-breaking', () => {
  // '👍' is one grapheme (2 columns); a 5-column budget fits two thumbs per line.
  const lines = wrapText('👍👍👍👍', 4)
  assert.equal(lines.length, 2)
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 4)
    assert.ok(!line.includes('\ud83d') || line.includes('👍'), 'no lone surrogate leaks')
  }
  assert.equal([...lines.join('')].filter(c => c === '👍').length, 4, 'all four emoji survive')
})

test('wrapText honors a non-positive budget by degrading to a single empty line', () => {
  assert.deepEqual(wrapText('anything', 0), [''])
  assert.deepEqual(wrapText('anything', -1), [''])
})

test('wrapText keeps an oversized grapheme whole without a ghost leading blank line', () => {
  // Budget 1 vs a 2-column emoji: hard-breaking must NOT push the empty
  // running line before the grapheme, and the cluster itself is never split.
  const lines = wrapText('👍👍', 1)
  assert.deepEqual(lines, ['👍', '👍'], `no ghost empty line, emoji intact: ${JSON.stringify(lines)}`)
  assert.equal(lines[0], '👍')
})
