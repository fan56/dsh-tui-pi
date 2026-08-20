/**
 * CJK-aware token estimation tests — src/tokens.ts, ported from
 * @aiwayds/dsh-dcp (lib/summarizer.js, estimateTextTokens/estimateMessageTokens).
 * The estimate prices CJK scripts (Han/kana/hangul/CJK punctuation/full-width
 * forms) at ~2 chars/token and ASCII at 4, mirroring real tokenizers that
 * encode a CJK character in roughly one token; `ascii` mode is the flat
 * 4-chars/token host meter. These tests lock the per-script ratios the TUI's
 * "current occupancy" display relies on.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateContentTokens, estimateTextTokens } from '../lib/tokens.js'

test('estimateTextTokens prices pure ASCII at 4 chars/token (ceil)', () => {
  assert.equal(estimateTextTokens(''), 0, 'empty text is 0')
  assert.equal(estimateTextTokens('a'), 1, '1 char -> 1 (ceil)')
  assert.equal(estimateTextTokens('abc'), 1, '3 chars -> 1')
  assert.equal(estimateTextTokens('abcd'), 1, '4 chars -> 1')
  assert.equal(estimateTextTokens('abcdefg'), 2, '7 chars -> 2 (ceil 1.75)')
  assert.equal(estimateTextTokens('abcdefgh'), 2, '8 chars -> 2')
  assert.equal(estimateTextTokens('a b c d'), 2, 'whitespace counts as ASCII too')
})

test('estimateTextTokens prices CJK at ~2 chars/token (the cjk mode)', () => {
  // Han (Chinese): each character encodes roughly one token.
  assert.equal(estimateTextTokens('中'), 1, 'one CJK char -> 1')
  assert.equal(estimateTextTokens('你好'), 1, 'two CJK chars -> 1')
  assert.equal(estimateTextTokens('你好世界'), 2, 'four CJK chars -> 2')
  // Kana + hangul ride the same range.
  assert.equal(estimateTextTokens('こんにちは'), 3, 'kana prices at ~2 chars/token (5 -> ceil 2.5 = 3)')
  assert.equal(estimateTextTokens('안녕하세요'), 3, 'hangul prices at ~2 chars/token (5 -> 3)')
})

test('estimateTextTokens mixes CJK and ASCII with each script\'s own ratio', () => {
  // 'hello你好': 2 CJK (你好) + 5 ASCII -> ceil(2/2 + 5/4) = ceil(2.25) = 3.
  assert.equal(estimateTextTokens('hello你好'), 3, 'mixed CJK+ASCII prices per script')
  // Full-width forms / CJK punctuation are in the CJK range (U+FF00-FFEF,
  // U+3000-303F): '，' (U+FF0C) and '。' (U+3002) price like CJK, not ASCII.
  assert.equal(estimateTextTokens('，'), 1, 'full-width comma prices as CJK')
  assert.equal(estimateTextTokens('。'), 1, 'CJK full stop prices as CJK')
  assert.equal(estimateTextTokens('ＡＢＣ'), 2, 'full-width Latin prices as CJK (3 -> ceil 1.5 = 2)')
  assert.equal(estimateTextTokens('hello，world'), 3,
    'ASCII with a full-width comma: 11 chars, 1 CJK -> ceil(0.5 + 10/4) = ceil(3) = 3')
})

test('estimateTextTokens ascii mode is the flat 4 chars/token meter (byte-identical to the host)', () => {
  assert.equal(estimateTextTokens('你好', 'ascii'), 1, 'ascii mode treats CJK as 4/token (2 -> ceil 0.5 = 1)')
  assert.equal(estimateTextTokens('hello', 'ascii'), 2, 'ascii mode: 5 -> ceil 1.25 = 2')
  assert.equal(estimateTextTokens('abcdefg', 'ascii'), 2, 'ascii mode: 7 -> ceil 1.75 = 2')
  // Pure-ASCII text is identical in both modes (the documented cjk property).
  assert.equal(estimateTextTokens('hello world', 'cjk'), estimateTextTokens('hello world', 'ascii'))
})

test('estimateContentTokens counts text blocks, tool-call arguments and tool-result inner text', () => {
  const textOnly = [{ type: 'text', text: 'abcd' }]
  assert.equal(estimateContentTokens(textOnly), 1, 'text block counted at its text length')
  // Two text blocks join with '\n' and price as one body.
  assert.equal(estimateContentTokens([{ type: 'text', text: 'abcd' }, { type: 'text', text: '你好' }]), 3,
    "'abcd\\n你好': 2 CJK + 5 ASCII -> ceil(2.25) = 3")
  // Tool-call arguments (JSON) count as text.
  assert.equal(estimateContentTokens([{ type: 'tool-call', arguments: '{"cmd":"ls"}' }]), 3,
    'tool-call arguments counted (12 chars -> ceil 12/4 = 3)')
})

test('estimateContentTokens handles unknown shapes defensively', () => {
  assert.equal(estimateContentTokens(undefined), 0, 'no content -> 0')
  assert.equal(estimateContentTokens(null), 0, 'null content -> 0')
  assert.equal(estimateContentTokens('nope'), 0, 'non-array content -> 0')
  assert.equal(estimateContentTokens([]), 0, 'empty blocks -> 0')
  // Reasoning/unknown block types carry no counted text.
  assert.equal(estimateContentTokens([{ type: 'reasoning', text: 'x'.repeat(40) }]), 0,
    'reasoning blocks are not priced (only text/tool-call/tool-result)')
  // A tool-result block prices its inner text blocks.
  assert.equal(estimateContentTokens([
    { type: 'tool-result', content: [{ type: 'text', text: 'ok' }, { type: 'text', text: 'done' }] },
  ]), 2, 'tool-result inner text counted (6 chars -> ceil 1.5 = 2)')
})
