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
import { DOUBLE_PRESS_MS, MIN_DOUBLE_PRESS_GAP_MS, resolveKeyAction } from '../lib/keymap.js'

const ESC = '\x1b'
const CTRL_C = '\x03'
const CTRL_D = '\x04'

function state(overrides = {}) {
  return {
    running: false,
    overlayOpen: false,
    editorHasText: false,
    autocompleteOpen: false,
    runningAgents: 0,
    lastEscPress: 0,
    lastRunningEscPress: 0,
    lastCtrlCPress: 0,
    ...overrides,
  }
}

test('Esc while running: first press arms the stop window, second within it stops the task', () => {
  // 1st Esc mid-turn: just arms — the task keeps running.
  const arm = resolveKeyAction(ESC, state({ running: true }), 1000)
  assert.equal(arm.kind, 'interrupt-arm-stop')
  assert.equal(arm.consumes, true)
  // 2nd Esc exactly at the window boundary fires the cancel (the whole task,
  // parent + subagents).
  const atBoundary = resolveKeyAction(ESC, state({ running: true, lastRunningEscPress: 1000 }), 1500)
  assert.equal(atBoundary.kind, 'interrupt-cancel')
  assert.equal(atBoundary.consumes, true)
  // 2nd Esc one ms past the window just re-arms instead of cancelling.
  const stale = resolveKeyAction(ESC, state({ running: true, lastRunningEscPress: 1000 }), 1501)
  assert.equal(stale.kind, 'interrupt-arm-stop')
})

test('Esc with a popup open is left to the popup (no interception) — the subagent viewer closes, the task is untouched', () => {
  // Exactly the reported flow: Ctrl+G viewer open while the parent runs and
  // the editor holds text — Esc must resolve to `overlay` (the viewer closes
  // itself) and NEVER to interrupt-cancel/arm-stop.
  const action = resolveKeyAction(ESC, state({ overlayOpen: true, running: true, editorHasText: true }), 1000)
  assert.equal(action.kind, 'overlay')
  assert.equal(action.consumes, false)
  assert.notEqual(action.kind, 'interrupt-cancel')
  assert.notEqual(action.kind, 'interrupt-arm-stop')
})

test('the running-stop and idle double-Esc windows own separate clocks', () => {
  // A recent arm on the running clock must not count toward the idle
  // /session double when the turn settled in between...
  const settled = resolveKeyAction(ESC, state({ running: false, lastRunningEscPress: 1000, lastEscPress: 0 }), 1300)
  assert.equal(settled.kind, 'interrupt-arm')
  assert.notEqual(settled.kind, 'interrupt-double')
  // ...and a recent idle arm must not let a mid-run press fire an early stop.
  const running = resolveKeyAction(ESC, state({ running: true, lastEscPress: 1000, lastRunningEscPress: 0 }), 1300)
  assert.equal(running.kind, 'interrupt-arm-stop')
  assert.notEqual(running.kind, 'interrupt-cancel')
})

test('held Esc while running never stops the task (auto-repeat is swallowed)', () => {
  // A held Esc re-sends every ~30-50ms after the OS repeat delay: the first
  // repeat lands inside the 500ms arm window and used to be indistinguishable
  // from a deliberate second press. Now anything closer than the repeat floor
  // is inert key-repeat — a press-and-hold can never cancel a turn.
  const arm = resolveKeyAction(ESC, state({ running: true }), 1000)
  assert.equal(arm.kind, 'interrupt-arm-stop')
  const repeat = resolveKeyAction(ESC, state({ running: true, lastRunningEscPress: 1000 }), 1035)
  assert.equal(repeat.kind, 'key-repeat')
  assert.equal(repeat.key, 'escape')
  assert.equal(repeat.consumes, true)
  // The repeat does not advance the window: a deliberate press 200ms after
  // the ORIGINAL arm still cancels.
  const deliberate = resolveKeyAction(ESC, state({ running: true, lastRunningEscPress: 1000 }), 1200)
  assert.equal(deliberate.kind, 'interrupt-cancel')
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

test('Ctrl+G opens the subagent viewer while children run; idle it falls through', () => {
  const viewer = resolveKeyAction('\x07', state({ runningAgents: 2 }), 1000) // ctrl+g
  assert.equal(viewer.kind, 'subagent-viewer')
  assert.equal(viewer.consumes, true)
  // No subagents → noop, the key reaches the focused component.
  const idle = resolveKeyAction('\x07', state(), 1000)
  assert.equal(idle.kind, 'noop')
  assert.equal(idle.consumes, false)
  // An open overlay keeps its own keys even while subagents run.
  const withPopup = resolveKeyAction('\x07', state({ runningAgents: 1, overlayOpen: true }), 1000)
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
  const escape = resolveKeyAction('\x18', state({ running: true }), 1000, custom) // ctrl+x — 1st Esc while running arms the stop
  assert.equal(escape.kind, 'interrupt-arm-stop')
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
  const subagentViewer = resolveKeyAction('\x07', state({ runningAgents: 1 }), 1000, custom) // ctrl+g
  assert.equal(subagentViewer.kind, 'subagent-viewer')
})

test('double-press window constant is 500ms (pi app.clear)', () => {
  assert.equal(DOUBLE_PRESS_MS, 500)
})
test('held-key auto-repeat never quits: repeat gaps under the floor are swallowed', () => {
  // A held Ctrl+C re-sends every ~30-50ms after the OS repeat delay. The
  // first repeat (here +400ms, inside the 500ms window) used to resolve as
  // ctrl-c-quit — a single press-and-hold quit the TUI. Now anything closer
  // than MIN_DOUBLE_PRESS_GAP_MS to the last press is inert key-repeat.
  // Idle editor path:
  const idle1 = resolveKeyAction(CTRL_C, state({ editorHasText: false }), 1000)
  assert.equal(idle1.kind, 'ctrl-c-clear')
  const idleRepeat = resolveKeyAction(CTRL_C, state({ lastCtrlCPress: 1000 }), 1030)
  assert.equal(idleRepeat.kind, 'key-repeat')
  assert.equal(idleRepeat.key, 'ctrl-c')
  assert.equal(idleRepeat.consumes, true)
  // Running path (first press cancels, the repeat must not quit):
  const running1 = resolveKeyAction(CTRL_C, state({ running: true }), 2000)
  assert.equal(running1.kind, 'ctrl-c-cancel')
  const runningRepeat = resolveKeyAction(CTRL_C, state({ running: true, lastCtrlCPress: 2000 }), 2045)
  assert.equal(runningRepeat.kind, 'key-repeat')
  // The repeat does not advance the window: a press 100ms after the ORIGINAL
  // press (not after the repeat) is still a deliberate double press.
  const deliberate = resolveKeyAction(CTRL_C, state({ lastCtrlCPress: 2000 }), 2100)
  assert.equal(deliberate.kind, 'ctrl-c-quit')
})

test('repeat floor boundary: exactly MIN_DOUBLE_PRESS_GAP_MS is a press, under it is a repeat', () => {
  const atFloor = resolveKeyAction(CTRL_C, state({ lastCtrlCPress: 1000 }), 1000 + MIN_DOUBLE_PRESS_GAP_MS)
  assert.equal(atFloor.kind, 'ctrl-c-quit', 'gap == floor counts as a deliberate press')
  const underFloor = resolveKeyAction(CTRL_C, state({ lastCtrlCPress: 1000 }), 1000 + MIN_DOUBLE_PRESS_GAP_MS - 1)
  assert.equal(underFloor.kind, 'key-repeat')
})

test('held Esc does not fire the empty-editor double-Esc action', () => {
  const arm = resolveKeyAction(ESC, state(), 1000)
  assert.equal(arm.kind, 'interrupt-arm')
  const repeat = resolveKeyAction(ESC, state({ lastEscPress: 1000 }), 1035)
  assert.equal(repeat.kind, 'key-repeat')
  assert.equal(repeat.key, 'escape')
  // Running never reads the idle /session clock: a held Esc there arms the
  // stop window (once), then repeats are swallowed (see the running-repeat
  // test) — it can never pop /session.
  const running = resolveKeyAction(ESC, state({ running: true, lastEscPress: 1000, lastRunningEscPress: 0 }), 1035)
  assert.equal(running.kind, 'interrupt-arm-stop')
})

test('repeat floor constant is 80ms (above common repeat rates, under human double-presses)', () => {
  assert.equal(MIN_DOUBLE_PRESS_GAP_MS, 80)
})
