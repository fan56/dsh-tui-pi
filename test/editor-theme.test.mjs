/**
 * Chat-editor theme tests — the pi-tui Editor's input rows now carry the
 * theme's `textColor` (patched EditorTheme), so typed text is readable on the
 * app-painted canvas. Regression for the dark-theme "black text on black"
 * report: the content rows used to be unstyled and fell back to the terminal
 * default foreground, which is invisible on the dark canvas. The cursor's
 * reverse-video closes with ESC[27m (reverse off) so the themed foreground
 * survives a mid-text cursor.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { CwdBorderEditor } from '../lib/editor.js'
import { darkTheme, lightTheme, ansiFg } from '../lib/theme/index.js'
import { githubDark, githubLight } from '../lib/theme/palette.js'

/** Stub TUI the Editor's constructor/render paths only read rows off. */
const stubTui = { requestRender() {}, terminal: { rows: 24 } }

/** The rendered content row that carries the given text (ANSI kept). */
function contentRow(editor, text, width = 80) {
  const line = editor.render(width).find(l => l.includes(text))
  assert.ok(line, `content row containing ${JSON.stringify(text)} rendered`)
  return line
}

test('dark theme paints typed text with the light body color', () => {
  const editor = new CwdBorderEditor(stubTui, darkTheme.editor, process.cwd())
  editor.setText('hello world')
  const row = contentRow(editor, 'hello world')
  assert.ok(row.startsWith(ansiFg(githubDark.fgDefault)), 'input row opens with the dark-theme light fg')
})

test('light theme paints typed text with the dark body color', () => {
  const editor = new CwdBorderEditor(stubTui, lightTheme.editor, process.cwd())
  editor.setText('hello')
  const row = contentRow(editor, 'hello')
  assert.ok(row.startsWith(ansiFg(githubLight.fgDefault)), 'input row opens with the light-theme dark fg')
})

test('mid-text cursor keeps the themed foreground after it (ESC[27m not ESC[0m)', () => {
  const editor = new CwdBorderEditor(stubTui, darkTheme.editor, process.cwd())
  editor.setText('hello world')
  // Left arrow = ESC[D; move the cursor to just after 'hello ' (mid-text).
  for (let i = 0; i < 6; i++) editor.handleInput('\x1b[D')
  const row = contentRow(editor, 'hello')
  // The themed fg is set once at the row start; the reverse-video cursor
  // closes with reverse-off (ESC[27m), so the text after it keeps the fg
  // instead of falling back to the terminal default after a full reset.
  assert.ok(row.startsWith(ansiFg(githubDark.fgDefault)), 'input row opens with the themed fg')
  assert.ok(row.includes('\x1b[27m'), 'cursor closes with reverse-off, not a full reset')
  assert.ok(!row.includes('\x1b[7m \x1b[0m'), 'cursor no longer uses a full reset')
  assert.ok(row.includes('\x1b[7m \x1b[27mworld'), 'reverse-off runs directly into the following text (fg survives)')
  assert.ok(row.indexOf('\x1b[0m') > row.indexOf('world'), 'no full reset before the text after the cursor')
})

test('a theme without textColor leaves input rows unchanged (backward compatible)', () => {
  const plainTheme = { borderColor: s => s, selectList: {} }
  const editor = new CwdBorderEditor(stubTui, plainTheme, process.cwd())
  editor.setText('plain')
  const row = editor.render(80).find(l => l.includes('plain'))
  assert.ok(row && row.includes('plain'), 'content renders')
  // No fg SGR was injected — the minimal theme predates the textColor hook.
  assert.ok(!row.includes('\x1b[38;2;'), 'no injected foreground on a theme without textColor')
})
