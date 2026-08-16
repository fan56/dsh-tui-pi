/**
 * App-level keybinding decisions (src/keymap.ts → lib/keymap.js) — the pi
 * interrupt chain made pure. Runs against the built lib/ (pretest builds).
 *
 * Raw key bytes (pi-tui keys.js normalization, verified on 0.84.2):
 * - Escape is the lone ESC byte '\x1b' (legacy Ctrl+[ collapses to the same
 *   byte, so ctrl+[ is recognized as escape too).
 * - Ctrl+C is '\x03', Ctrl+D is '\x04' (code & 0x1f).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { DOUBLE_PRESS_MS, resolveKeyAction } from '../lib/keymap.js'

const ESC = '\x1b'
const CTRL_C = '\x03'
const CTRL_D = '\x04'

function state(overrides = {}) {
  return {
    running: false,
    overlayOpen: false,
    editorHasText: false,
    autocompleteOpen: false,
    lastEscPress: 0,
    lastCtrlCPress: 0,
    ...overrides,
  }
}

test('Esc while the agent is running stops the current task (interrupt-cancel)', () => {
  const action = resolveKeyAction(ESC, state({ running: true }), 1000)
  assert.equal(action.kind, 'interrupt-cancel')
  assert.equal(action.consumes, true)
})

test('Esc with a popup open is left to the popup (no interception)', () => {
  const action = resolveKeyAction(ESC, state({ overlayOpen: true, running: true, editorHasText: true }), 1000)
  assert.equal(action.kind, 'overlay')
  assert.equal(action.consumes, false)
})

test('Esc while idle with a non-empty editor is a no-op (pi anti-misfire)', () => {
  const action = resolveKeyAction(ESC, state({ editorHasText: true }), 1000)
  assert.equal(action.kind, 'noop')
  assert.equal(action.consumes, false)
})

test('Esc on an empty idle editor: first press arms, second within the window fires the double action', () => {
  const first = resolveKeyAction(ESC, state(), 0)
  assert.equal(first.kind, 'interrupt-arm')
  assert.equal(first.consumes, true)
  // Second press exactly at the window boundary is still a double.
  const atBoundary = resolveKeyAction(ESC, state({ lastEscPress: 1000 }), 1500)
  assert.equal(atBoundary.kind, 'interrupt-double')
  assert.equal(atBoundary.consumes, true)
  // One ms past the window re-arms instead.
  const stale = resolveKeyAction(ESC, state({ lastEscPress: 1000 }), 1501)
  assert.equal(stale.kind, 'interrupt-arm')
})

test('Esc with the editor autocomplete open only closes the list — even mid-turn', () => {
  const action = resolveKeyAction(ESC, state({ autocompleteOpen: true, running: true }), 1000)
  assert.equal(action.kind, 'autocomplete-close')
  assert.equal(action.consumes, false)
})

test('Ctrl+C while running: first press cancels, second within the window quits', () => {
  const cancel = resolveKeyAction(CTRL_C, state({ running: true }), 1000)
  assert.equal(cancel.kind, 'ctrl-c-cancel')
  assert.equal(cancel.consumes, true)
  const quit = resolveKeyAction(CTRL_C, state({ running: true, lastCtrlCPress: 1000 }), 1400)
  assert.equal(quit.kind, 'ctrl-c-quit')
  assert.equal(quit.consumes, true)
  // A late second press re-cancels instead of quitting.
  const again = resolveKeyAction(CTRL_C, state({ running: true, lastCtrlCPress: 1000 }), 1600)
  assert.equal(again.kind, 'ctrl-c-cancel')
})

test('Ctrl+C while idle: first press clears the editor, second within the window quits', () => {
  const clear = resolveKeyAction(CTRL_C, state(), 1000)
  assert.equal(clear.kind, 'ctrl-c-clear')
  assert.equal(clear.consumes, true)
  const quit = resolveKeyAction(CTRL_C, state({ lastCtrlCPress: 1000 }), 1300)
  assert.equal(quit.kind, 'ctrl-c-quit')
  const stale = resolveKeyAction(CTRL_C, state({ lastCtrlCPress: 1000 }), 1600)
  assert.equal(stale.kind, 'ctrl-c-clear')
})

test('Ctrl+C with a popup open is left to the popup (picker cancel binding)', () => {
  const action = resolveKeyAction(CTRL_C, state({ overlayOpen: true, running: true }), 1000)
  assert.equal(action.kind, 'overlay')
  assert.equal(action.consumes, false)
})

test('Ctrl+D quits only on an empty editor; with text it stays a delete-char', () => {
  const quit = resolveKeyAction(CTRL_D, state(), 1000)
  assert.equal(quit.kind, 'ctrl-d-quit')
  assert.equal(quit.consumes, true)
  const deleteChar = resolveKeyAction(CTRL_D, state({ editorHasText: true }), 1000)
  assert.equal(deleteChar.kind, 'noop')
  assert.equal(deleteChar.consumes, false)
  const withPopup = resolveKeyAction(CTRL_D, state({ overlayOpen: true }), 1000)
  assert.equal(withPopup.kind, 'overlay')
  assert.equal(withPopup.consumes, false)
})

test('Ctrl+L opens the model picker; a popup on screen keeps its own keys', () => {
  const picker = resolveKeyAction('\x0c', state(), 1000) // ctrl+l
  assert.equal(picker.kind, 'model-picker')
  assert.equal(picker.consumes, true)
  const withPopup = resolveKeyAction('\x0c', state({ overlayOpen: true }), 1000)
  assert.equal(withPopup.kind, 'overlay')
  assert.equal(withPopup.consumes, false)
})

test('Ctrl+C while running is a cancel, not a quit, even when the editor has text', () => {
  const action = resolveKeyAction(CTRL_C, state({ running: true, editorHasText: true }), 1000)
  assert.equal(action.kind, 'ctrl-c-cancel')
})

test('unbound keys fall through to the focused component', () => {
  for (const data of ['a', 'enter', '\r', '\t', '\x1b[A', ' ']) {
    const action = resolveKeyAction(data, state(), 1000)
    assert.equal(action.kind, 'noop', `key ${JSON.stringify(data)}`)
    assert.equal(action.consumes, false)
  }
})

test('custom key bindings remap the app keys (future keybindings.json override)', () => {
  const custom = { escape: 'ctrl+x', ctrlC: 'alt+c', ctrlD: 'ctrl+w' }
  const escape = resolveKeyAction('\x18', state({ running: true }), 1000, custom) // ctrl+x
  assert.equal(escape.kind, 'interrupt-cancel')
  const ctrlC = resolveKeyAction('\x1bc', state(), 1000, custom) // alt+c (ESC + c legacy)
  assert.equal(ctrlC.kind, 'ctrl-c-clear')
  const ctrlD = resolveKeyAction('\x17', state(), 1000, custom) // ctrl+w
  assert.equal(ctrlD.kind, 'ctrl-d-quit')
  // The default escape byte no longer matches any binding under the remap.
  const notEscape = resolveKeyAction(ESC, state({ running: true }), 1000, custom)
  assert.equal(notEscape.kind, 'noop')
  // Bindings NOT overridden keep their defaults (partial merge).
  const modelPicker = resolveKeyAction('\x0c', state(), 1000, custom) // ctrl+l
  assert.equal(modelPicker.kind, 'model-picker')
})

test('double-press window constant is 500ms (pi app.clear)', () => {
  assert.equal(DOUBLE_PRESS_MS, 500)
})