/**
 * Chat-editor message-history tests — the Up/Down shell-style recall of the
 * submitted-message list. CwdBorderEditor overrides the pi-tui base
 * addToHistory to cap at HISTORY_LIMIT (500) and adds a copy-on-read
 * getHistory() so a theme-swap rebuild can reseed the list, plus
 * reseedHistory/getBrowseState/restoreBrowseState for mid-browse rebuild
 * survival. Browsing itself is the pi-tui Editor native
 * cursorUp/cursorDown → navigateHistory path. Also guards the exported
 * FOOTER_HINT constant's 103-column width (the pre-feature width).
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { CwdBorderEditor, HISTORY_LIMIT } from '../lib/editor.js'
import { FOOTER_HINT } from '../lib/footer.js'
import { visibleWidth } from '../lib/text.js'

/** Stub TUI the Editor's constructor/render paths only read rows off. */
const stubTui = { requestRender() {}, terminal: { rows: 24 } }

/** Minimal EditorTheme the CwdBorderEditor constructor bakes borderColor from. */
const theme = { borderColor: s => s, selectList: {} }

/** Build a fresh chat editor. */
function makeEditor() {
  return new CwdBorderEditor(stubTui, theme, process.cwd())
}

test('HISTORY_LIMIT caps the history at 500, dropping the oldest', () => {
  assert.equal(HISTORY_LIMIT, 500)
  const editor = makeEditor()
  for (let i = 0; i < 600; i++) editor.addToHistory(`message ${i}`)
  const hist = editor.getHistory()
  assert.equal(hist.length, HISTORY_LIMIT)
  // index 0 is the newest (last added).
  assert.equal(hist[0], 'message 599')
  // The oldest 100 entries were dropped.
  assert.ok(!hist.includes('message 0'))
  assert.ok(!hist.includes('message 99'))
  assert.ok(hist.includes('message 100'))
  assert.ok(hist.includes('message 599'))
})

test('at exactly HISTORY_LIMIT nothing drops; 501 drops exactly the oldest', () => {
  const editor = makeEditor()
  for (let i = 0; i < 500; i++) editor.addToHistory(`message ${i}`)
  let hist = editor.getHistory()
  assert.equal(hist.length, 500)
  // At the cap boundary the very oldest entry is retained.
  assert.ok(hist.includes('message 0'))
  assert.equal(hist[0], 'message 499')

  // One more push drops exactly the oldest (and nothing else).
  editor.addToHistory('message 500')
  hist = editor.getHistory()
  assert.equal(hist.length, 500)
  assert.ok(!hist.includes('message 0'))
  assert.ok(hist.includes('message 1'))
  assert.equal(hist[0], 'message 500')
})

test('addToHistory trims and ignores empty, and skips consecutive duplicates', () => {
  const editor = makeEditor()
  editor.addToHistory('  hello world  ')
  editor.addToHistory('hello world') // trimmed duplicate of the previous
  editor.addToHistory('   ') // whitespace-only → ignored
  editor.addToHistory('')
  editor.addToHistory('next')
  assert.deepEqual(editor.getHistory(), ['next', 'hello world'])
})

test('Up on an empty editor recalls the most recent entry; walk/re-down navigate', () => {
  const editor = makeEditor()
  editor.addToHistory('one')
  editor.addToHistory('two')
  editor.addToHistory('three')

  editor.handleInput('\x1b[A') // Up → most recent
  assert.equal(editor.getText(), 'three')
  editor.handleInput('\x1b[A') // Up again → older
  assert.equal(editor.getText(), 'two')
  editor.handleInput('\x1b[A') // Up again → oldest
  assert.equal(editor.getText(), 'one')

  editor.handleInput('\x1b[B') // Down → forward one
  assert.equal(editor.getText(), 'two')
  editor.handleInput('\x1b[B') // Down
  assert.equal(editor.getText(), 'three')
  editor.handleInput('\x1b[B') // Down past the newest → back to empty draft
  assert.equal(editor.getText(), '')
})

test('single-entry browse: Up recalls, Up again stays, Down returns to the empty line', () => {
  const editor = makeEditor()
  editor.addToHistory('only')

  editor.handleInput('\x1b[A') // Up → the single entry
  assert.equal(editor.getText(), 'only')
  editor.handleInput('\x1b[A') // Up again → already the newest entry, stays
  assert.equal(editor.getText(), 'only')
  editor.handleInput('\x1b[B') // Down past the newest → back to empty
  assert.equal(editor.getText(), '')
})

test('Up on a non-empty editor only browses when cursor is at line start', () => {
  const editor = makeEditor()
  editor.addToHistory('hello')
  editor.setText('abc')
  // Cursor defaults to line end; Up must NOT browse (moves cursor instead).
  editor.handleInput('\x1b[A')
  assert.equal(editor.getText(), 'abc')
  // Home puts the cursor at line start; Up now browses into history.
  editor.handleInput('\x1b[H')
  editor.handleInput('\x1b[A')
  assert.equal(editor.getText(), 'hello')
})

test('Down exits history and restores the browse-mode draft', () => {
  const editor = makeEditor()
  editor.addToHistory('remember me')
  editor.setText('draft in progress')
  editor.handleInput('\x1b[H') // cursor to line start
  editor.handleInput('\x1b[A') // enter history
  assert.equal(editor.getText(), 'remember me')
  editor.handleInput('\x1b[B') // Down back out of history
  assert.equal(editor.getText(), 'draft in progress')
})

test('multi-line history entries round-trip verbatim after trim', () => {
  const editor = makeEditor()
  const multiline = 'line one\nline two\n\nline three'
  const padded = `  ${multiline}\n`
  editor.addToHistory(padded)
  editor.setText('')
  editor.handleInput('\x1b[A') // Up recalls the multi-line entry
  // Leading/trailing whitespace was trimmed at submit; interior newlines kept.
  assert.equal(editor.getText(), multiline)
})

test('getHistory returns a copy (mutating it does not touch the editor)', () => {
  const editor = makeEditor()
  editor.addToHistory('alpha')
  editor.addToHistory('beta')
  const snapshot = editor.getHistory()
  snapshot.push('gamma')
  snapshot[0] = 'mutated'
  assert.deepEqual(editor.getHistory(), ['beta', 'alpha'])
})

test('history survives a rebuild: reseeding oldest→newest reproduces the order', () => {
  const a = makeEditor()
  a.addToHistory('first')
  a.addToHistory('second')
  a.addToHistory('third')

  const b = makeEditor()
  b.reseedHistory(a.getHistory())

  assert.deepEqual(b.getHistory(), a.getHistory())
  assert.deepEqual(b.getHistory(), ['third', 'second', 'first'])
})

test('mid-browse rebuild restores the browse cursor and pre-browse draft', () => {
  const a = makeEditor()
  // index 0 = most recent = 'two' (added last); list reads ['two', 'one'].
  a.addToHistory('one')
  a.addToHistory('two')
  a.setText('draft')
  a.handleInput('\x1b[H') // cursor to line start
  a.handleInput('\x1b[A') // Up → 'two', browsing; the 'draft' is saved by the base
  assert.equal(a.getText(), 'two')

  const browse = a.getBrowseState()
  assert.equal(browse.index, 0)
  assert.deepEqual(browse.draft, { lines: ['draft'], cursorLine: 0, cursorCol: 0 })

  // Theme-swap rebuild: a fresh editor reseeded from A's history + browse state.
  const b = makeEditor()
  b.reseedHistory(a.getHistory())
  b.restoreBrowseState(browse)

  // Down on the replacement must restore the pre-browse draft, not drop it.
  b.handleInput('\x1b[B')
  assert.equal(b.getText(), 'draft')
})

test('restoreBrowseState clamps a stale index and degrades an empty history to not browsing', () => {
  const editor = makeEditor()
  editor.addToHistory('only')
  // A snapshot with an out-of-range index (from a shorter history) must clamp
  // to the last entry rather than browse out of bounds.
  editor.restoreBrowseState({ index: 99, draft: null })
  assert.equal(editor.getText(), '')
  editor.handleInput('\x1b[B') // down from the clamped newest → empty line
  assert.equal(editor.getText(), '')

  // A snapshot whose history reseeded to nothing degrades to not browsing.
  const empty = makeEditor()
  empty.restoreBrowseState({ index: 0, draft: null })
  empty.handleInput('\x1b[A') // no history → nothing happens (not browsing)
  assert.equal(empty.getText(), '')
})

test('FOOTER_HINT is at most 103 visible columns (the pre-feature width)', () => {
  // Guard against future footer-hint length regressions: a longer hint
  // word-wraps to 2 lines on 105–118-column terminals and hides its suffix on
  // ≤104 columns. 103 is exactly the pre-history-feature width.
  assert.ok(visibleWidth(FOOTER_HINT) <= 103, `FOOTER_HINT is ${visibleWidth(FOOTER_HINT)} columns`)
})
