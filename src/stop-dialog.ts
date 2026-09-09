/**
 * The stop-everything confirmation dialog — the gate behind the double-Esc
 * stop gesture.
 *
 * "Stop all LLM work" is the widest lever the TUI has: it cancels the main
 * turn AND every live subagent (background/continuable children survive a
 * plain parent cancel, so the stop enumerates and cancels each). That reach
 — and the fact that the gesture is two Esc presses, the same key users
 * mash to close popups — is exactly why the second Esc opens THIS dialog
 * instead of firing: the arm notice plus an explicit, read-before-confirm
 * panel is the misfire guard. The old 200ms auto-fire window confirmed the
 * *timing* of the press, not the *intent*; a dialog states what will die
 * and waits for Enter.
 *
 * Mirrors the preset-switch dialog's pure-reducer split (src/preset-dialog.ts,
 * itself modeled on src/repair-dialog.ts) so the decision matrix stays
 * unit-testable without a terminal. Two ways out: STOP (Enter on the
 * preselected row, or `1`) and CANCEL (Esc, `2`, or Enter on row 2). While
 * the overlay is open the keymap yields every app key to it, so a third Esc
 * lands in the dialog (cancel), never straight at the task. Framing/focus
 * follow the shared overlay contract: PanelHost framing, close re-focuses
 * the CURRENT editor instance through `restoreFocus`.
 */

import { getKeybindings, type Component, type TUI } from '@earendil-works/pi-tui'
import { PanelHost, panelThemeFns } from './panels.ts'
import { BOLD, RESET, ansiFg, type TuiTheme } from './theme/index.ts'
import { clipToWidth, wrapText } from './text.ts'

/** The two choices in display order; index 0 (STOP) is preselected. */
export const STOP_CONFIRM_OPTION_IDS: ReadonlyArray<'stop' | 'cancel'> = ['stop', 'cancel']

/** What the dialog says: the title plus the "what is running" body points. */
export interface StopConfirmWording {
  title: string
  body: readonly string[]
}

/**
 * The dialog wording for one stop moment. The body names exactly what will
 * be cancelled — the main turn when mid-turn, the running-subagent count —
 * because the dialog is the only place the blast radius is stated before
 * the user commits. Always ends with the reassurance that queued prompts
 * survive (`keepInbox`) and the session stays resumable.
 */
export function stopConfirmWording(mainRunning: boolean, runningChildren: number): StopConfirmWording {
  const running: string[] = []
  if (mainRunning) running.push('the main turn is generating')
  if (runningChildren > 0) {
    running.push(`${runningChildren} subagent${runningChildren === 1 ? ' is' : 's are'} running`)
  }
  const situation = running.length > 0
    ? `Right now ${running.join(' and ')}.`
    : 'Nothing is running right now.'
  return {
    title: '● Stop all LLM work?',
    body: [
      situation,
      'Confirming cancels the main turn and every running subagent. '
      + 'Queued messages are kept and the session stays resumable.',
    ],
  }
}

/** The fixed option rows for one wording. */
export function stopConfirmOptions(): ReadonlyArray<{ id: 'stop' | 'cancel'; text: string }> {
  return [
    { id: 'stop', text: 'Stop everything — cancel the main turn and all subagents' },
    { id: 'cancel', text: 'Cancel — keep everything running' },
  ]
}

/** Accent-BOLD dialog title. */
export function stopConfirmTitle(wording: StopConfirmWording): string {
  return wording.title
}

/** Footer hint — hardcoded like every other panel footer (English-only). */
export const STOP_CONFIRM_FOOTER = '↑↓ select · 1/2 pick · Enter confirm · Esc keep running'

/**
 * Pure dialog state: which row is highlighted, and the terminal outcome.
 * Same shape as the preset dialog's state.
 */
export interface StopConfirmState {
  selected: number
  /**
   * Set once by a terminal key: `'confirm'` (Enter on a selection) or
   * `'cancel'` (Esc). Further input is ignored afterwards.
   */
  settled?: 'confirm' | 'cancel'
}

export function initialStopConfirmState(): StopConfirmState {
  return { selected: 0 }
}

/**
 * Apply one raw key sequence to the dialog state. Unknown keys are no-ops;
 * anything after a settle is ignored (single terminal outcome guard).
 */
export function updateStopConfirm(state: StopConfirmState, data: string): StopConfirmState {
  if (state.settled !== undefined) return state
  const kb = getKeybindings()
  if (kb.matches(data, 'tui.select.cancel')) return { ...state, settled: 'cancel' }
  if (kb.matches(data, 'tui.input.submit')) return { ...state, settled: 'confirm' }
  if (kb.matches(data, 'tui.select.up')) {
    return { ...state, selected: Math.max(0, state.selected - 1) }
  }
  if (kb.matches(data, 'tui.select.down')) {
    return { ...state, selected: Math.min(STOP_CONFIRM_OPTION_IDS.length - 1, state.selected + 1) }
  }
  // Digit direct-select (1-based): selects the row, Enter still confirms —
  // same select-then-confirm split as the preset dialog.
  const digit = /^([1-9])$/.exec(data)
  if (digit !== null) {
    const index = Number(digit[1]) - 1
    if (index < STOP_CONFIRM_OPTION_IDS.length) return { ...state, selected: index }
  }
  return state
}

/** Resolved dialog outcome: `'stop'`, or undefined on cancel. */
export function stopConfirmOutcome(state: StopConfirmState): 'stop' | undefined {
  if (state.settled !== 'confirm') return undefined
  return STOP_CONFIRM_OPTION_IDS[state.selected] === 'stop' ? 'stop' : undefined
}

/**
 * The framed overlay component. Renders the title, the wrapped body points
 * and the two option rows; every key goes through
 * {@link updateStopConfirm}, and the first terminal key fires `onFinish`
 * exactly once.
 */
export class StopConfirmPanel implements Component {
  private readonly theme: TuiTheme
  private readonly wording: StopConfirmWording
  private readonly onFinish: (outcome: 'stop' | undefined) => void
  private readonly requestRenderFn: () => void
  private state: StopConfirmState = initialStopConfirmState()

  constructor(
    theme: TuiTheme,
    wording: StopConfirmWording,
    onFinish: (outcome: 'stop' | undefined) => void,
    requestRender: () => void,
  ) {
    this.theme = theme
    this.wording = wording
    this.onFinish = onFinish
    this.requestRenderFn = requestRender
  }

  invalidate(): void {}

  render(width: number): string[] {
    const fns = panelThemeFns(this.theme)
    const wrap = Math.max(2, width - 2)
    // Word-wrap the body FIRST, then paint (iron rule: width math runs on
    // plain text, ANSI goes on after clipping).
    const lines: string[] = [
      fns.accent(BOLD + clipToWidth(stopConfirmTitle(this.wording), wrap) + RESET),
      ...this.wording.body.flatMap(point =>
        wrapText(point, wrap).map(segment => fns.muted(clipToWidth(segment, wrap)))),
      '',
    ]
    const options = stopConfirmOptions()
    for (let i = 0; i < options.length; i++) {
      const option = options[i]!
      const marker = i === this.state.selected ? '▸' : ' '
      const row = clipToWidth(`${marker} ${i + 1}. ${option.text}`, wrap)
      lines.push(i === this.state.selected
        ? ansiFg(this.theme.palette.accent) + BOLD + row + RESET
        : fns.muted(row))
    }
    lines.push('')
    lines.push(fns.subtle(clipToWidth(STOP_CONFIRM_FOOTER, wrap)))
    return lines
  }

  handleInput(data: string): void {
    const previous = this.state
    this.state = updateStopConfirm(this.state, data)
    if (this.state === previous) return
    if (this.state.settled === undefined) {
      this.requestRenderFn()
      return
    }
    this.onFinish(stopConfirmOutcome(this.state))
  }
}

/**
 * Open the stop-everything confirmation dialog. Resolves `'stop'` when the
 * user confirmed, or `'cancelled'` (Esc / row 2 / an overlay that failed to
 * mount — treated as cancel so a half-mounted dialog can never imply
 * consent). Closing always hands focus back through `restoreFocus` before
 * the promise settles.
 */
export function openStopConfirmDialog(
  tui: TUI,
  theme: TuiTheme,
  mainRunning: boolean,
  runningChildren: number,
  restoreFocus: () => void,
): Promise<'stop' | 'cancelled'> {
  return new Promise(resolve => {
    let settled = false
    const settle = (outcome: 'stop' | 'cancelled'): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    // A half-mounted overlay must not strand the keyboard: PanelHost's
    // onError closes + calls restoreFocus, then we settle as cancelled.
    const host = new PanelHost(tui, theme, () => {
      restoreFocus()
      settle('cancelled')
    })
    const finish = (outcome: 'stop' | undefined): void => {
      host.close()
      restoreFocus()
      settle(outcome === 'stop' ? 'stop' : 'cancelled')
    }
    const panel = new StopConfirmPanel(
      theme,
      stopConfirmWording(mainRunning, runningChildren),
      outcome => finish(outcome),
      () => tui.requestRender(),
    )
    // maxHeight is a hard slice in pi-tui: title + 2 wrapped body points +
    // 2 options + footer ≈ 8 content rows + 4 frame rows; the preset
    // dialog's 75%-of-24-rows headroom covers it with room to spare.
    host.open(panel, '70%', '75%')
  })
}
