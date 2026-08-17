/**
 * App-level keybinding decisions — the pi interrupt chain, kept pure.
 *
 * pi (badlogic/pi-mono) routes terminal key presses through an app-level
 * handler before the focused component sees them. This module is the
 * dsh-tui-pi equivalent: `tui.ts` composes the live state and calls
 * `resolveKeyAction`, `index.ts` executes the returned action. Keeping the
 * decision PURE makes the whole chain unit-testable without a terminal.
 *
 * Esc chain (mirrors pi's `app.interrupt`, verified on pi 0.84.2):
 *   1. popup/selector overlay open  → let the popup's own Esc handle it —
 *                                     Esc NEVER touches the running task
 *                                     from inside a popup (the subagent
 *                                     viewer, pickers and dialogs close
 *                                     themselves and leave the turn alone)
 *   2. editor autocomplete showing  → let the editor close the list only
 *   3. agent mid-turn (running)     → 1st press arms the stop window, 2nd
 *                                     press within `DOUBLE_PRESS_MS` cancels
 *                                     the whole task (parent + subagents) —
 *                                     stopping is a deliberate double-press
 *   4. editor non-empty (idle)      → NO-OP — pi's anti-misfire core
 *   5. editor empty (idle)          → 1st press arms, 2nd press within
 *                                     `DOUBLE_PRESS_MS` triggers the mapped
 *                                     action (pi defaults to /tree; dsh has
 *                                     no /tree, so we map to /session — the
 *                                     closest non-invasive analogue). The
 *                                     running-stop and idle windows own
 *                                     SEPARATE clocks (`lastRunningEscPress`
 *                                     vs `lastEscPress`) so an Esc that armed
 *                                     a stop never pops /session after the
 *                                     turn settles, and vice versa.
 *
 * Ctrl+C chain (dsh convention, windowed): first press cancels a running
 * turn — or clears the editor while idle — and a second press within
 * `DOUBLE_PRESS_MS` quits. This keeps dsh's "first cancels / second quits"
 * while requiring a deliberate double-press before an idle exit. Held-key
 * auto-repeat never counts: repeats inside `MIN_DOUBLE_PRESS_GAP_MS` resolve
 * to `key-repeat` (consumed, inert — and the executor aborts a pending quit
 * confirmation on one, since a repeat betrays a held key; see index.ts).
 *
 * Ctrl+D chain (pi `app.exit`): only quits on an EMPTY editor; with text it
 * is left alone so the pi-tui Editor's existing `tui.editor.deleteCharForward`
 * binding (delete, ctrl+d) deletes a character forward — exactly pi's
 * context distinction.
 *
 * Ctrl+L chain (pi `app.model.select`): opens the model/think picker — the
 * dsh analogue of pi's model selector. Like every app key here it yields to
 * an open overlay first, so a popup that is on screen keeps its own keys.
 *
 * Ctrl+G chain (dsh's subagent viewer): opens the subagent picker only while
 * a subagent runs (`runningAgents > 0`) — idle it falls through untouched.
 * Same overlay-yields-first rule as the other app keys.
 */

import { matchesKey, type KeyId } from '@earendil-works/pi-tui'

/** Double-press window (ms) for ctrl+c quit and empty-editor double-Esc. */
export const DOUBLE_PRESS_MS = 500

/**
 * Minimum gap (ms) between two presses of the same key for the second to
 * count as a deliberate press rather than terminal auto-repeat. A held key is
 * re-sent every ~30-50ms after the OS repeat delay (183ms-2s) and terminals
 * report no key-up, so gap alone is the discriminator: anything closer than
 * this floor is auto-repeat (see `key-repeat`). Human double-presses are
 * rarely faster than ~100ms; common repeat rates (20-33/s) sit well under it.
 */
export const MIN_DOUBLE_PRESS_GAP_MS = 80

/**
 * The key identifiers resolved for each app-level binding. Injectable so a
 * future `~/.dsh/keybindings.json` override can remap the app keys without
 * touching the decision logic (see README "Keyboard shortcuts").
 */
export interface KeyBindings {
  /** Stop the current task (pi app.interrupt). */
  escape: KeyId
  /** Cancels the running turn / clears the editor; double-press quits. */
  ctrlC: KeyId
  /** Quit, but only when the editor is empty (pi app.exit). */
  ctrlD: KeyId
  /** Open the model picker (pi app.model.select). */
  modelPicker: KeyId
  /** Open the subagent picker / viewer (running children). */
  subagentViewer: KeyId
}

export const DEFAULT_KEYBINDINGS: KeyBindings = {
  escape: 'escape',
  ctrlC: 'ctrl+c',
  ctrlD: 'ctrl+d',
  modelPicker: 'ctrl+l',
  subagentViewer: 'ctrl+g',
}

/** Live snapshot of everything the decision needs — composed by tui.ts. */
export interface KeyPressState {
  /** Agent mid-turn (`bridge.isRunning()`). */
  running: boolean
  /** An overlay/popup is open and focused (`tui.hasOverlay()`). */
  overlayOpen: boolean
  /** Editor buffer is non-empty. */
  editorHasText: boolean
  /** Editor autocomplete dropdown is currently showing. */
  autocompleteOpen: boolean
  /** Live (not settled) subagent count; 0 = nothing for ctrl+g to open. */
  runningAgents: number
  /** Timestamp (ms) of the last handled escape press; 0 = none. */
  lastEscPress: number
  /** Timestamp (ms) of the last handled escape press that armed the
   *  running-stop window (branch 3 above); 0 = none. Own clock: independent
   *  of `lastEscPress` so the two Esc windows never bleed into each other. */
  lastRunningEscPress: number
  /** Timestamp (ms) of the last handled ctrl+c press; 0 = none. */
  lastCtrlCPress: number
}

/**
 * One resolved app-level key action. `consumes` mirrors pi-tui's
 * `TuiInputListenerResult.consume`: true stops the key from reaching the
 * focused component, false lets it through (the popup / the editor handle
 * it — e.g. Esc-close, ctrl+d delete-char, drop of an unbound key).
 */
export type KeyAction =
  | { kind: 'overlay'; consumes: false }             // popup owns the key
  | { kind: 'autocomplete-close'; consumes: false }  // editor closes its list
  | { kind: 'noop'; consumes: false }                // nothing to do
  | { kind: 'interrupt-arm-stop'; consumes: true }   // 1st Esc while running — arms the stop double-press
  | { kind: 'interrupt-cancel'; consumes: true }     // 2nd Esc while running — cancels the task
  | { kind: 'interrupt-arm'; consumes: true }        // 1st Esc, empty editor
  | { kind: 'interrupt-double'; consumes: true }     // 2nd Esc within window
  | { kind: 'ctrl-c-cancel'; consumes: true }        // 1st Ctrl+C while running
  | { kind: 'ctrl-c-clear'; consumes: true }         // 1st Ctrl+C while idle
  | { kind: 'ctrl-c-quit'; consumes: true }          // 2nd Ctrl+C within window
  | { kind: 'ctrl-d-quit'; consumes: true }          // Ctrl+D on empty editor
  | { kind: 'model-picker'; consumes: true }         // Ctrl+L opens the picker
  | { kind: 'subagent-viewer'; consumes: true }      // Ctrl+G while subagents run
  /**
   * Auto-repeat of a windowed key (Ctrl+C / armed Esc) — the key is being
   * held. Consumed so the editor never sees it, but no action fires and the
   * double-press clock does NOT advance (a repeat must never arm or complete
   * a double press). The executor can use the `key` to cancel a pending
   * quit confirmation (a repeat betrays a held key).
   */
  | { kind: 'key-repeat'; key: 'ctrl-c' | 'escape'; consumes: true }

/** True when a second press within the window follows `lastPress`. */
function isDoublePress(lastPress: number, now: number): boolean {
  return lastPress > 0 && now - lastPress <= DOUBLE_PRESS_MS
}

/** True when this press is auto-repeat of a held key (gap under the floor). */
function isKeyRepeat(lastPress: number, now: number): boolean {
  return lastPress > 0 && now - lastPress < MIN_DOUBLE_PRESS_GAP_MS
}

/** The Esc chain — pi app.interrupt, popup and autocomplete first. */
function resolveEscape(state: KeyPressState, now: number): KeyAction {
  // 1. An open overlay owns Esc: the popup (subagent viewer, pickers,
  //    dialogs) closes itself and the running task is NEVER touched by that
  //    press — Esc is a per-popup cancel, not the global stop.
  if (state.overlayOpen) return { kind: 'overlay', consumes: false }
  if (state.autocompleteOpen) return { kind: 'autocomplete-close', consumes: false }
  // 2. Agent mid-turn: stopping the whole task (parent + subagents) is a
  //    deliberate double-press — the first Esc only arms the stop window, so
  //    a stray Esc (e.g. one aimed at a just-closed popup) can never kill a
  //    running turn. Its clock is the separate `lastRunningEscPress`; held
  //    auto-repeat never arms or fires it.
  if (state.running) {
    if (isKeyRepeat(state.lastRunningEscPress, now)) return { kind: 'key-repeat', key: 'escape', consumes: true }
    return isDoublePress(state.lastRunningEscPress, now)
      ? { kind: 'interrupt-cancel', consumes: true }
      : { kind: 'interrupt-arm-stop', consumes: true }
  }
  // 3. Idle: a non-empty editor is untouched (pi's anti-misfire core).
  if (state.editorHasText) return { kind: 'noop', consumes: false }
  // 4. Empty editor, idle: first press arms, second within the window fires
  //    the double action (/session — dsh has no pi /tree). Auto-repeat of the
  //    armed key never fires the double action.
  if (isKeyRepeat(state.lastEscPress, now)) return { kind: 'key-repeat', key: 'escape', consumes: true }
  return isDoublePress(state.lastEscPress, now)
    ? { kind: 'interrupt-double', consumes: true }
    : { kind: 'interrupt-arm', consumes: true }
}

/**
 * Ctrl+C — dsh's "first cancels / second quits", windowed against misfires.
 * Auto-repeat (a held key) is swallowed: it neither cancels again nor ever
 * completes the quit double press.
 */
function resolveCtrlC(state: KeyPressState, now: number): KeyAction {
  if (state.overlayOpen) return { kind: 'overlay', consumes: false }
  if (isKeyRepeat(state.lastCtrlCPress, now)) return { kind: 'key-repeat', key: 'ctrl-c', consumes: true }
  if (state.running) {
    if (isDoublePress(state.lastCtrlCPress, now)) return { kind: 'ctrl-c-quit', consumes: true }
    return { kind: 'ctrl-c-cancel', consumes: true }
  }
  if (isDoublePress(state.lastCtrlCPress, now)) return { kind: 'ctrl-c-quit', consumes: true }
  return { kind: 'ctrl-c-clear', consumes: true }
}

/** Ctrl+D — pi app.exit: quit only on an empty editor, else let it delete. */
function resolveCtrlD(state: KeyPressState): KeyAction {
  if (state.overlayOpen) return { kind: 'overlay', consumes: false }
  if (state.editorHasText) return { kind: 'noop', consumes: false }
  return { kind: 'ctrl-d-quit', consumes: true }
}

/** Ctrl+L — pi app.model.select: open the model picker (overlay yields). */
function resolveModelPicker(state: KeyPressState): KeyAction {
  if (state.overlayOpen) return { kind: 'overlay', consumes: false }
  return { kind: 'model-picker', consumes: true }
}

/** Ctrl+G — open the subagent picker only while children run (overlay yields). */
function resolveSubagentViewer(state: KeyPressState): KeyAction {
  if (state.overlayOpen) return { kind: 'overlay', consumes: false }
  if (state.runningAgents > 0) return { kind: 'subagent-viewer', consumes: true }
  // No subagents to watch: let the key fall through to the focused component.
  return { kind: 'noop', consumes: false }
}

/**
 * Resolve one raw terminal input sequence into an app-level action.
 * `data` is the single decoded key sequence `addInputListener` receives
 * (e.g. "\x1b" for Escape, "\x03" for Ctrl+C); see keys.js for the
 * normalization: Escape is `\x1b`, and legacy Ctrl+[ collapses to the same
 * byte, so both are recognized as `escape`.
 *
 * `keys` may be a PARTIAL override — every missing binding falls back to the
 * default. That is the shape a future `~/.dsh/keybindings.json` loader will
 * feed in: remap one key, keep the rest.
 *
 * Any key outside the app bindings yields `noop` (not consumed — the focused
 * component, normally the editor, processes it).
 */
export function resolveKeyAction(
  data: string,
  state: KeyPressState,
  now: number,
  keys: Partial<KeyBindings> = DEFAULT_KEYBINDINGS,
): KeyAction {
  const bindings: KeyBindings = { ...DEFAULT_KEYBINDINGS }
  for (const id of Object.keys(keys) as (keyof KeyBindings)[]) {
    const value = keys[id]
    if (value !== undefined) bindings[id] = value
  }
  if (matchesKey(data, bindings.escape)) return resolveEscape(state, now)
  if (matchesKey(data, bindings.ctrlC)) return resolveCtrlC(state, now)
  if (matchesKey(data, bindings.ctrlD)) return resolveCtrlD(state)
  if (matchesKey(data, bindings.modelPicker)) return resolveModelPicker(state)
  if (matchesKey(data, bindings.subagentViewer)) return resolveSubagentViewer(state)
  return { kind: 'noop', consumes: false }
}
