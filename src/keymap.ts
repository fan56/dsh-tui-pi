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
 *   4. editor non-empty or empty (idle) → NO-OP — pi's anti-misfire core.
 *                                     (pi's empty-editor double-Esc opens
 *                                     /tree; dsh deliberately does NOT map
 *                                     it — /session is slash-command only.)
 *
 *   The running-stop window owns its own clock (`lastRunningEscPress`).
 *
 * Ctrl+C chain (dsh convention, windowed): first press cancels a running
 * turn - or clears the editor while idle - and a second press within
 * `DOUBLE_PRESS_MS` AND at least `QUIT_MIN_GAP_MS` after the previous arrival
 * quits (the deliberate-press delay). This keeps dsh's "first cancels /
 * second quits" while filtering held-key auto-repeat two ways: kitty-protocol
 * repeats arrive explicitly flagged (`:2`) and resolve to `key-repeat` outright,
 * and on terminals without event types the gap between consecutive arrivals
 * (the ctrl+c clock advances on every arrival) stays under the floor for
 * every realistic repeat rate. The executor additionally confirms a quit for
 * QUIT_CONFIRM_MS and aborts on a follow-up repeat (see index.ts).
 *
 * Key-release events (kitty protocol flag 3) are matched by `matchesKey` like
 * presses; they are swallowed at the top of `resolveKeyAction` so a slow key
 * release can never masquerade as a fast second press.
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

import { isKeyRelease, isKeyRepeat, matchesKey, type KeyId } from '@earendil-works/pi-tui'

/** Double-press window (ms) for ctrl+c quit and running-task Esc stop. */
export const DOUBLE_PRESS_MS = 500

/**
 * Window (ms) after an Esc was handed to a popup during which another Esc is
 * still considered aimed at the (just-closed) popup - swallowed before the
 * Esc chain runs. Users routinely double-press Esc to dismiss a panel; the
 * second press must not arm the running-stop window.
 */
export const OVERLAY_ESC_GUARD_MS = 300

/**
 * Minimum gap (ms) between two ctrl+c arrivals for the second to count as a
 * deliberate quit double-press (the user-requested delay). The ctrl+c clock
 * advances on EVERY arrival (press or repeat), so the gap measures
 * consecutive key events: a held key auto-repeats every ~30-100ms (slower
 * repeat-rate settings sit under this floor), which can never complete the
 * double. Human double-presses land above it.
 */
export const QUIT_MIN_GAP_MS = 150

/**
 * Minimum gap (ms) between two presses of the same key for the second to
 * count as a deliberate press rather than terminal auto-repeat. A held key is
 * re-sent every ~30-50ms after the OS repeat delay (183ms-2s) and terminals
 * report no key-up, so gap alone is the discriminator on non-kitty terminals:
 * anything closer than this floor is auto-repeat (see `key-repeat`).
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
  /** Timestamp (ms) of the last handled escape press that armed the
   *  running-stop window; 0 = none. */
  lastRunningEscPress: number
  /** Timestamp (ms) of the last ctrl+c arrival (press OR repeat); 0 = none. */
  lastCtrlCPress: number
  /**
   * Timestamp (ms) of the last escape press handed to a popup (`overlay-esc`);
   * 0 = none. Arms the `OVERLAY_ESC_GUARD_MS` window that swallows the
   * trailing Esc of a panel-close double-press.
   */
  lastOverlayEscPress: number
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
  | { kind: 'interrupt-arm-stop'; consumes: true }   // 1st Esc while running - arms the stop double-press
  | { kind: 'interrupt-cancel'; consumes: true }     // 2nd Esc while running - cancels the task
  | { kind: 'ctrl-c-cancel'; consumes: true }        // 1st Ctrl+C while running
  | { kind: 'ctrl-c-clear'; consumes: true }         // 1st Ctrl+C while idle
  | { kind: 'ctrl-c-quit'; consumes: true }          // 2nd Ctrl+C within window
  | { kind: 'ctrl-d-quit'; consumes: true }          // Ctrl+D on empty editor
  | { kind: 'model-picker'; consumes: true }         // Ctrl+L opens the picker
  | { kind: 'subagent-viewer'; consumes: true }      // Ctrl+G while subagents run
  /**
   * Esc handed to an open popup - the popup closes itself with it (the popup
   * branch of the Esc chain). Not consumed (the focused popup sees the key);
   * tui.ts arms the post-popup guard window from it.
   */
  | { kind: 'overlay-esc'; consumes: false }
  /**
   * Esc arriving inside the post-popup guard window - the trailing press of a
   * panel-close double-press. Consumed and inert: it must never arm the
   * running-stop window.
   */
  | { kind: 'esc-after-overlay'; consumes: true }
  /**
   * A kitty-protocol key-release event (flag 3) for one of the app keys.
   * Terminals that report event types send one per physical key-up, and
   * `matchesKey` matches them like presses - without this filter a slow key
   * release lands inside the double-press window and reads as a fast second
   * press (the "one Ctrl+C press quits" bug on kitty/Ghostty/cmux).
   * Consumed and inert.
   */
  | { kind: 'key-release'; consumes: true }
  /**
   * Auto-repeat of a windowed key (Ctrl+C / armed Esc) - the key is being
   * held. Either explicitly flagged by the kitty protocol (`:2`) or deduced
   * from the arrival gap on terminals without event types. Consumed so the
   * editor never sees it, but no action fires and the Esc double-press clock
   * does NOT advance (a repeat must never arm or complete an Esc double press).
   * The executor can use the `key` to cancel a pending quit confirmation (a
   * repeat betrays a held key).
   */
  | { kind: 'key-repeat'; key: 'ctrl-c' | 'escape'; consumes: true }

/** True when a second press within the window follows `lastPress`. */
function isDoublePress(lastPress: number, now: number): boolean {
  return lastPress > 0 && now - lastPress <= DOUBLE_PRESS_MS
}

/** True when this press is auto-repeat of a held key (gap under the floor). */
function isGapRepeat(lastPress: number, now: number): boolean {
  return lastPress > 0 && now - lastPress < MIN_DOUBLE_PRESS_GAP_MS
}

/** True when `now` falls inside the post-popup Esc guard window. */
function insideOverlayEscGuard(lastOverlayEscPress: number, now: number): boolean {
  return lastOverlayEscPress > 0 && now - lastOverlayEscPress <= OVERLAY_ESC_GUARD_MS
}

/** The Esc chain — pi app.interrupt, popup and autocomplete first. */
function resolveEscape(state: KeyPressState, now: number): KeyAction {
  // 1. An open overlay owns Esc: the popup (subagent viewer, pickers,
  //    dialogs) closes itself and the running task is NEVER touched by that
  //    press — Esc is a per-popup cancel, not the global stop.
  if (state.overlayOpen) return { kind: 'overlay-esc', consumes: false }
  if (state.autocompleteOpen) return { kind: 'autocomplete-close', consumes: false }
  // 1b. The trailing Esc of a panel-close double-press: the popup already
  //     consumed the first press moments ago - this one is still aimed at the
  //     (gone) popup, never at the task.
  if (insideOverlayEscGuard(state.lastOverlayEscPress, now)) {
    return { kind: 'esc-after-overlay', consumes: true }
  }
  // 2. Agent mid-turn: stopping the whole task (parent + subagents) is a
  //    deliberate double-press - the first Esc only arms the stop window, so
  //    a stray Esc (e.g. one aimed at a just-closed popup) can never kill a
  //    running turn. Its clock is the separate `lastRunningEscPress`; held
  //    auto-repeat never arms or fires it.
  if (state.running) {
    if (isGapRepeat(state.lastRunningEscPress, now)) return { kind: 'key-repeat', key: 'escape', consumes: true }
    return isDoublePress(state.lastRunningEscPress, now)
      ? { kind: 'interrupt-cancel', consumes: true }
      : { kind: 'interrupt-arm-stop', consumes: true }
  }
  // 3. Idle (empty or non-empty editor): NO-OP — pi's anti-misfire core.
  //    (pi's empty-editor double-Esc opens /tree; dsh deliberately does not
  //    map it — /session stays slash-command only.)
  return { kind: 'noop', consumes: false }
}

/**
 * Ctrl+C - dsh's "first cancels / second quits", windowed against misfires.
 * The gap is measured between CONSECUTIVE ctrl+c arrivals (tui.ts advances
 * the clock on every arrival, repeats included), so a held key - whose
 * repeats arrive every ~30-100ms, or are explicitly flagged by the kitty
 * protocol before this function runs - never reaches the `QUIT_MIN_GAP_MS`
 * floor and can never complete the quit double press.
 */
function resolveCtrlC(state: KeyPressState, now: number): KeyAction {
  if (state.overlayOpen) return { kind: 'overlay', consumes: false }
  const gap = state.lastCtrlCPress > 0 ? now - state.lastCtrlCPress : Number.POSITIVE_INFINITY
  if (gap < QUIT_MIN_GAP_MS) return { kind: 'key-repeat', key: 'ctrl-c', consumes: true }
  const double = gap <= DOUBLE_PRESS_MS
  if (state.running) {
    return double ? { kind: 'ctrl-c-quit', consumes: true } : { kind: 'ctrl-c-cancel', consumes: true }
  }
  return double ? { kind: 'ctrl-c-quit', consumes: true } : { kind: 'ctrl-c-clear', consumes: true }
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
/**
 * Merge a PARTIAL binding override onto the defaults - the effective
 * `KeyBindings` the app dispatches against. Exported so tui.ts can run the
 * same `matchesKey` checks for its double-press clock bookkeeping.
 */
export function mergeKeyBindings(keys: Partial<KeyBindings> = DEFAULT_KEYBINDINGS): KeyBindings {
  const bindings: KeyBindings = { ...DEFAULT_KEYBINDINGS }
  for (const id of Object.keys(keys) as (keyof KeyBindings)[]) {
    const value = keys[id]
    if (value !== undefined) bindings[id] = value
  }
  return bindings
}

export function resolveKeyAction(
  data: string,
  state: KeyPressState,
  now: number,
  keys: Partial<KeyBindings> = DEFAULT_KEYBINDINGS,
): KeyAction {
  // Key-release events (kitty protocol flag 3) arrive as one sequence per
  // physical key-up and `matchesKey` matches them like presses - swallow them
  // before any binding can count one. Terminals without event types never
  // send these sequences.
  if (isKeyRelease(data)) return { kind: 'key-release', consumes: true }
  const bindings = mergeKeyBindings(keys)
  // Explicitly flagged auto-repeats (kitty protocol flag 2) of the windowed
  // keys are held-key repeats no matter the arrival gap.
  if (matchesKey(data, bindings.escape)) {
    if (isKeyRepeat(data)) return { kind: 'key-repeat', key: 'escape', consumes: true }
    return resolveEscape(state, now)
  }
  if (matchesKey(data, bindings.ctrlC)) {
    if (isKeyRepeat(data)) return { kind: 'key-repeat', key: 'ctrl-c', consumes: true }
    return resolveCtrlC(state, now)
  }
  if (matchesKey(data, bindings.ctrlD)) return resolveCtrlD(state)
  if (matchesKey(data, bindings.modelPicker)) return resolveModelPicker(state)
  if (matchesKey(data, bindings.subagentViewer)) return resolveSubagentViewer(state)
  return { kind: 'noop', consumes: false }
}
