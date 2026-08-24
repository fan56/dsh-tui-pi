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
import {
  DOUBLE_PRESS_MS,
  MIN_DOUBLE_PRESS_GAP_MS,
  OVERLAY_ESC_GUARD_MS,
  QUIT_MIN_GAP_MS,
  resolveKeyAction,
} from '../lib/keymap.js'

const ESC = '\x1b'
const CTRL_C = '\x03'
const CTRL_D = '\x04'
// Kitty-protocol sequences (terminals reporting event types, e.g. Ghostty /
// cmux / kitty / iTerm2): press, auto-repeat (flag 2), release (flag 3).
const KITTY_CTRL_C_PRESS = '\x1b[99;5u'
const KITTY_CTRL_C_REPEAT = '\x1b[99;5:2u'
const KITTY_CTRL_C_RELEASE = '\x1b[99;5:3u'
const KITTY_ESC_RELEASE = '\x1b[27;1:3u'

function state(overrides = {}) {
  return {
    running: false,
    overlayOpen: false,
    editorHasText: false,
    autocompleteOpen: false,
    runningAgents: 0,
    lastRunningEscPress: 0,
    lastCtrlCPress: 0,
    lastOverlayEscPress: 0,
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
  // the editor holds text — Esc must resolve to `overlay-esc` (the viewer
  // closes itself) and NEVER to interrupt-cancel/arm-stop.
  const action = resolveKeyAction(ESC, state({ overlayOpen: true, running: true, editorHasText: true }), 1000)
  assert.equal(action.kind, 'overlay-esc')
  assert.equal(action.consumes, false)
  assert.notEqual(action.kind, 'interrupt-cancel')
  assert.notEqual(action.kind, 'interrupt-arm-stop')
})

test('an idle Esc is a no-op even right after a running-stop arm (no idle double window)', () => {
  // The turn settled in between: the armed running clock must not leak into
  // any idle behavior — and there IS no idle double anymore (the old
  // empty-editor double-Esc opened /session; that binding was removed).
  const settled = resolveKeyAction(ESC, state({ running: false, lastRunningEscPress: 1000 }), 1300)
  assert.equal(settled.kind, 'noop')
  assert.equal(settled.consumes, false)
  // ...while a mid-run press still arms the stop window.
  const running = resolveKeyAction(ESC, state({ running: true }), 1300)
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

test('Esc on an empty idle editor is a no-op — the double-Esc /session binding is gone', () => {
  // Every idle press on an empty editor is inert, including a rapid second
  // one inside what used to be the 500ms double-press window: /session opens
  // via the slash command only.
  for (const now of [0, 200, 499, 500, 1500]) {
    const action = resolveKeyAction(ESC, state(), now)
    assert.equal(action.kind, 'noop', `now=${now}`)
    assert.equal(action.consumes, false, `now=${now}`)
  }
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
  for (const data of ['a', 'enter', '\r', '\x1b[A', ' ']) {
    const action = resolveKeyAction(data, state(), 1000)
    assert.equal(action.kind, 'noop', `key ${JSON.stringify(data)}`)
    assert.equal(action.consumes, false)
  }
})

test('Tab cycles agent presets (overlay and autocomplete yield first)', () => {
  const tab = resolveKeyAction('\t', state(), 1000)
  assert.equal(tab.kind, 'preset-cycle')
  assert.equal(tab.consumes, true)
  // Overlay open → Tab belongs to the popup.
  assert.equal(resolveKeyAction('\t', state({ overlayOpen: true }), 1000).kind, 'overlay')
  // Autocomplete open → Tab closes the list.
  assert.equal(resolveKeyAction('\t', state({ autocompleteOpen: true }), 1000).kind, 'autocomplete-close')
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
  // ctrl-c-quit - a single press-and-hold quit the TUI. Now the gap between
  // CONSECUTIVE arrivals must reach QUIT_MIN_GAP_MS before the second counts
  // as a deliberate press.
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
  // A slow repeat rate (10/s = 100ms gaps) still never reaches the floor -
  // the old 80ms floor let TWO such repeats read as a double quit.
  const slowRepeat = resolveKeyAction(CTRL_C, state({ running: true, lastCtrlCPress: 2000 }), 2100)
  assert.equal(slowRepeat.kind, 'key-repeat')
  // A human-paced second press (>= QUIT_MIN_GAP_MS, <= DOUBLE_PRESS_MS) quits.
  const deliberate = resolveKeyAction(CTRL_C, state({ lastCtrlCPress: 2000 }), 2200)
  assert.equal(deliberate.kind, 'ctrl-c-quit')
})

test('quit gap boundary: exactly QUIT_MIN_GAP_MS is a deliberate press, under it is a repeat', () => {
  const atFloor = resolveKeyAction(CTRL_C, state({ lastCtrlCPress: 1000 }), 1000 + QUIT_MIN_GAP_MS)
  assert.equal(atFloor.kind, 'ctrl-c-quit', 'gap == floor counts as a deliberate press')
  const underFloor = resolveKeyAction(CTRL_C, state({ lastCtrlCPress: 1000 }), 1000 + QUIT_MIN_GAP_MS - 1)
  assert.equal(underFloor.kind, 'key-repeat')
})

// ---------------------------------------------- kitty protocol key events ----

test('kitty key-release events are swallowed - a slow key release is never a second press', () => {
  // The reported bug: one physical Ctrl+C press quits when the user releases
  // the key slowly. Terminals reporting event types send press + release,
  // and matchesKey matches BOTH - without the filter the release landed
  // 150-500ms after the press, right inside the double-press window.
  for (const data of [KITTY_CTRL_C_RELEASE, KITTY_ESC_RELEASE]) {
    const action = resolveKeyAction(data, state({ running: true, lastCtrlCPress: 1000, lastRunningEscPress: 1000 }), 1300)
    assert.equal(action.kind, 'key-release', JSON.stringify(data))
    assert.equal(action.consumes, true)
  }
})

test('kitty press events still resolve like legacy presses', () => {
  const press = resolveKeyAction(KITTY_CTRL_C_PRESS, state(), 1000)
  assert.equal(press.kind, 'ctrl-c-clear')
})

test('kitty auto-repeat events resolve to key-repeat regardless of the arrival gap', () => {
  // Flag-2 repeats are the terminal TELLING us the key is held - no gap
  // heuristic needed. Even 400ms after the press (a slow repeat-rate setup)
  // the flagged repeat must not complete the double press.
  const repeat = resolveKeyAction(KITTY_CTRL_C_REPEAT, state({ lastCtrlCPress: 1000 }), 1400)
  assert.equal(repeat.kind, 'key-repeat')
  assert.equal(repeat.key, 'ctrl-c')
  assert.equal(repeat.consumes, true)
})

// ------------------------------------------------ post-popup Esc guard ----

test('the trailing Esc of a panel-close double-press is swallowed, never a stop arm', () => {
  // The reported flow: Esc closes the subagent detail panel, the user's
  // habitual second Esc (within the guard window) used to arm the running
  // stop. The popup-owned press arms the guard; the trailing press resolves
  // to esc-after-overlay (inert) no matter whether the agent runs.
  const running = resolveKeyAction(
    ESC, state({ running: true, lastOverlayEscPress: 1000 }), 1200,
  )
  assert.equal(running.kind, 'esc-after-overlay')
  assert.equal(running.consumes, true)
  const idle = resolveKeyAction(
    ESC, state({ lastOverlayEscPress: 1000 }), 1200,
  )
  assert.equal(idle.kind, 'esc-after-overlay')
  // Past the guard window the Esc chain runs normally again.
  const after = resolveKeyAction(
    ESC, state({ running: true, lastOverlayEscPress: 1000 }), 1000 + OVERLAY_ESC_GUARD_MS + 1,
  )
  assert.equal(after.kind, 'interrupt-arm-stop')
  // At the boundary exactly, the guard still holds.
  const atBoundary = resolveKeyAction(
    ESC, state({ running: true, lastOverlayEscPress: 1000 }), 1000 + OVERLAY_ESC_GUARD_MS,
  )
  assert.equal(atBoundary.kind, 'esc-after-overlay')
})

test('guard window constant is 300ms (a panel-close double-press, not a task stop)', () => {
  assert.equal(OVERLAY_ESC_GUARD_MS, 300)
})

test('quit minimum gap constant is 150ms (above repeat rates, under human double-presses)', () => {
  assert.equal(QUIT_MIN_GAP_MS, 150)
})

test('a held Esc on an empty idle editor is inert (no idle window left to fire)', () => {
  const action = resolveKeyAction(ESC, state(), 1000)
  assert.equal(action.kind, 'noop')
  assert.equal(action.consumes, false)
  // Running still arms the stop window once; its repeats are swallowed by
  // the gap floor (see the held-Esc-while-running test).
  const running = resolveKeyAction(ESC, state({ running: true }), 1035)
  assert.equal(running.kind, 'interrupt-arm-stop')
})

test('repeat floor constant is 80ms (above common repeat rates, under human double-presses)', () => {
  assert.equal(MIN_DOUBLE_PRESS_GAP_MS, 80)
})

// ------------------------------------------------- Ctrl+O queue panel --

const CTRL_O = '\x0f'
// The keybindings file contract must keep offering the queue panel for
// remapping (src/hotkeys.ts APP_KEY_FIELDS reads the same field).
import { DEFAULT_KEYBINDINGS } from '../lib/keymap.js'

test('Ctrl+O with a session opens the pending queue panel and consumes the key', () => {
  assert.equal(DEFAULT_KEYBINDINGS.queuePanel, 'ctrl+o')
  const action = resolveKeyAction(CTRL_O, state({ hasSession: true }), 1000)
  assert.equal(action.kind, 'queue-panel')
  assert.equal(action.consumes, true)
})

test('Ctrl+O yields to an open overlay like every other app key', () => {
  const action = resolveKeyAction(CTRL_O, state({ overlayOpen: true, hasSession: true }), 1000)
  assert.equal(action.kind, 'overlay')
  assert.equal(action.consumes, false)
})

test('Ctrl+O without a session falls through untouched (no inbox to list)', () => {
  const action = resolveKeyAction(CTRL_O, state(), 1000)
  assert.equal(action.kind, 'noop')
  assert.equal(action.consumes, false)
})
