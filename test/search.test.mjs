/**
 * Cross-session search pure-builder tests (src/search.ts): snippet
 * normalization, directory labels, hit-row assembly (subagent children
 * excluded, titles resolved from the snapshot batch) and failure wording.
 * The overlay itself is PanelHost glue, exercised on a terminal.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSearchHitRows,
  dirLabel,
  normalizeSnippet,
  searchFailureText,
} from '../lib/search.js'

const header = (over = {}) => ({
  id: '11111111-2222-3333-4444-555555555555',
  createdAt: 1751600000000,
  cwd: '/Users/x/repo/dsh-tui-pi',
  origin: 'user',
  delegationDepth: 0,
  ...over,
})

test('normalizeSnippet flattens whitespace and caps the length', () => {
  assert.equal(normalizeSnippet('a\n\t b   c'), 'a b c')
  const long = 'x'.repeat(200)
  const capped = normalizeSnippet(long)
  assert.ok(capped.length <= 160 && capped.endsWith('…'))
  assert.equal(normalizeSnippet('  spaced  ', 100), 'spaced')
})

test('dirLabel takes the path tail of a session cwd', () => {
  assert.equal(dirLabel('/Users/x/repo/dsh-tui-pi'), 'dsh-tui-pi')
  assert.equal(dirLabel('C:\\work\\proj'), 'proj')
  assert.equal(dirLabel(''), '')
  assert.equal(dirLabel(undefined), '')
})

test('buildSearchHitRows: one row per resumable hit, titled from the snapshot batch', () => {
  const hits = [
    { header: header(), bestMatch: { snippet: 'the\nanswer', time: 1751700000000, type: 'assistant/message' } },
    { header: header({ id: '99999999-8888-7777-6666-555555555555', cwd: undefined }), bestMatch: { snippet: 'other', time: undefined } },
  ]
  const rows = buildSearchHitRows(hits, new Map([
    ['11111111-2222-3333-4444-555555555555', 'GitOps rollout question'],
  ]))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].title, 'GitOps rollout question')
  assert.equal(rows[0].snippet, 'the answer')
  assert.equal(rows[0].dir, 'dsh-tui-pi')
  assert.match(rows[0].when, /^\d{2}-\d{2} \d{2}:\d{2}$|^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  // Untitled + no cwd: id tail label, empty dir, creation-time fallback.
  assert.equal(rows[1].title, '55555555')
  assert.equal(rows[1].dir, '')
})

test('buildSearchHitRows drops subagent children (the /resume rule)', () => {
  const hits = [
    { header: header({ origin: 'subagent', delegationDepth: 1 }), bestMatch: { snippet: 'child' } },
    { header: header(), bestMatch: { snippet: 'parent' } },
  ]
  const rows = buildSearchHitRows(hits, new Map())
  assert.equal(rows.length, 1)
  assert.equal(rows[0].snippet, 'parent')
})

test('searchFailureText maps the disabled-index refusal to an upgrade hint', () => {
  const disabled = searchFailureText(new Error(
    'session search is disabled: this deployment configures the session-query index with openAt "never" (SESSION_QUERY_SEARCH_DISABLED)',
  ))
  assert.ok(!/SESSION_QUERY_SEARCH_DISABLED/.test(disabled), 'raw code never reaches the user')
  const raw = searchFailureText(new Error('database is locked'))
  assert.ok(raw.includes('database is locked'))
})
