/**
 * The fork-at-turn confirmation dialog — the /history browser's `f` key.
 *
 * Forking at a turn starts a NEW session seeded with the browsed session's
 * events through the selected turn's `turn/end` (inclusive) and switches to
 * it; the current session stays untouched and resumable via /resume. That is
 * a user-visible, hard-to-reverse-looking action, so it is gated behind this
 * confirmation (mirroring the /resume repair dialog's pure-reducer split,
 * src/repair-dialog.ts, so the decision matrix stays unit-testable without a
 * terminal). Two options — Fork now / Cancel — Esc = cancel.
 *
 * The dialog mounts as its own overlay ON TOP of the open browser (the
 * browser stays mounted underneath and keeps the keyboard after the dialog
 * resolves; the switch itself runs after confirmation).
 */

import { getKeybindings, type Component, type TUI } from '@earendil-works/pi-tui'
import { PanelHost, panelThemeFns } from './panels.ts'
import { BOLD, RESET, ansiFg, type TuiTheme } from './theme/index.ts'
import { clipToWidth, wrapText } from './text.ts'

/** The two choices in display order; index 0 is preselected. */
export const FORK_AT_TURN_OPTION_IDS: ReadonlyArray<'fork' | 'cancel'> = ['fork', 'cancel']

/** Accent-BOLD dialog title (`N` = the selected turn's number). */
export function forkAtTurnTitle(turnLabel: string): string {
  return `● Fork at turn ${turnLabel}?`
}

/**
 * The fixed body points, one entry per bullet — each wrapped to the terminal
 * width by the panel before painting. `N` is the selected turn's number,
 * `M` the session's total turn count (as listed). `detachedLiveId` is set
 * when the browsed session is NOT the live one (a cold read): forking then
 * detaches the LIVE session, and the body must say so — "the current
 * session" alone would read as the browsed one and hide the live session's
 * fate. Undefined = live browse (or nothing live at all), where the generic
 * wording is exact.
 */
export function forkAtTurnBody(turnLabel: string, totalTurns: number, detachedLiveId?: string): readonly string[] {
  return [
    `The new session carries turns through ${turnLabel} (of ${totalTurns}); later turns stay in the current session.`,
    detachedLiveId === undefined
      ? 'The current session stays resumable via /resume.'
      : `Your live session ${detachedLiveId} will be detached — it stays resumable via /resume.`,
  ]
}

/** The fixed option rows for one target turn. */
export function forkAtTurnOptions(turnLabel: string): ReadonlyArray<{ id: 'fork' | 'cancel'; text: string }> {
  return [
    { id: 'fork', text: `Fork now — new session through turn ${turnLabel}` },
    { id: 'cancel', text: 'Cancel' },
  ]
}

/** Footer hint — hardcoded like every other panel footer (English-only). */
export const FORK_AT_TURN_FOOTER = '↑↓ select · 1/2 pick · Enter confirm · Esc cancel'

/** Pure dialog state: which row is highlighted, and the terminal outcome. */
export interface ForkAtTurnState {
  selected: number
  /**
   * Set once by a terminal key: `'confirm'` (Enter on a selection) or
   * `'cancel'` (Esc). Further input is ignored afterwards.
   */
  settled?: 'confirm' | 'cancel'
}

export function initialForkAtTurnState(): ForkAtTurnState {
  return { selected: 0 }
}

/**
 * Apply one raw key sequence to the dialog state. Unknown keys are no-ops;
 * anything after a settle is ignored (single terminal outcome guard).
 */
export function updateForkAtTurn(state: ForkAtTurnState, data: string): ForkAtTurnState {
  if (state.settled !== undefined) return state
  const kb = getKeybindings()
  if (kb.matches(data, 'tui.select.cancel')) return { ...state, settled: 'cancel' }
  if (kb.matches(data, 'tui.input.submit')) return { ...state, settled: 'confirm' }
  if (kb.matches(data, 'tui.select.up')) {
    return { ...state, selected: Math.max(0, state.selected - 1) }
  }
  if (kb.matches(data, 'tui.select.down')) {
    return { ...state, selected: Math.min(FORK_AT_TURN_OPTION_IDS.length - 1, state.selected + 1) }
  }
  // Digit direct-select (1-based): selects the row, Enter still confirms —
  // same select-then-confirm split as the routing dialog.
  const digit = /^([1-9])$/.exec(data)
  if (digit !== null) {
    const index = Number(digit[1]) - 1
    if (index < FORK_AT_TURN_OPTION_IDS.length) return { ...state, selected: index }
  }
  return state
}

/** Resolved dialog outcome: the chosen action, or undefined on cancel. */
export function forkAtTurnOutcome(state: ForkAtTurnState): 'fork' | 'cancel' | undefined {
  if (state.settled !== 'confirm') return undefined
  return FORK_AT_TURN_OPTION_IDS[state.selected]
}

/**
 * The framed overlay component. Renders the title, the wrapped body points
 * and the two option rows; every key goes through {@link updateForkAtTurn},
 * and the first terminal key fires `onFinish` exactly once.
 */
export class ForkAtTurnPanel implements Component {
  private readonly theme: TuiTheme
  private readonly turnLabel: string
  private readonly totalTurns: number
  private readonly detachedLiveId: string | undefined
  private readonly onFinish: (outcome: 'fork' | 'cancel' | undefined) => void
  private readonly requestRenderFn: () => void
  private state: ForkAtTurnState = initialForkAtTurnState()

  constructor(
    theme: TuiTheme,
    turnLabel: string,
    totalTurns: number,
    detachedLiveId: string | undefined,
    onFinish: (outcome: 'fork' | 'cancel' | undefined) => void,
    requestRender: () => void,
  ) {
    this.theme = theme
    this.turnLabel = turnLabel
    this.totalTurns = totalTurns
    this.detachedLiveId = detachedLiveId
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
      fns.accent(BOLD + clipToWidth(forkAtTurnTitle(this.turnLabel), wrap) + RESET),
      ...forkAtTurnBody(this.turnLabel, this.totalTurns, this.detachedLiveId).flatMap(point =>
        wrapText(point, wrap).map(segment => fns.muted(clipToWidth(segment, wrap)))),
      '',
    ]
    const options = forkAtTurnOptions(this.turnLabel)
    for (let i = 0; i < options.length; i++) {
      const option = options[i]!
      const marker = i === this.state.selected ? '▸' : ' '
      const row = clipToWidth(`${marker} ${i + 1}. ${option.text}`, wrap)
      lines.push(i === this.state.selected
        ? ansiFg(this.theme.palette.accent) + BOLD + row + RESET
        : fns.muted(row))
    }
    lines.push('')
    lines.push(fns.subtle(clipToWidth(FORK_AT_TURN_FOOTER, wrap)))
    return lines
  }

  handleInput(data: string): void {
    const previous = this.state
    this.state = updateForkAtTurn(this.state, data)
    if (this.state === previous) return
    if (this.state.settled === undefined) {
      this.requestRenderFn()
      return
    }
    this.onFinish(forkAtTurnOutcome(this.state))
  }
}

/**
 * Open the fork-at-turn confirmation dialog over the OPEN browser (its own
 * overlay — the browser stays mounted underneath and regains the keyboard
 * when the dialog resolves). Resolves `'fork'` when the user explicitly
 * confirmed, `'cancelled'` otherwise (Esc, or an overlay that failed to
 * mount — treated as cancel so a half-mounted dialog can never imply
 * consent). Closing hands focus back through `restoreFocus` first.
 */
export function openForkAtTurnDialog(
  tui: TUI,
  theme: TuiTheme,
  turnLabel: string,
  totalTurns: number,
  detachedLiveId: string | undefined,
  restoreFocus: () => void,
): Promise<'fork' | 'cancelled'> {
  return new Promise(resolve => {
    let settled = false
    const settle = (outcome: 'fork' | 'cancelled'): void => {
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
    const finish = (outcome: 'fork' | 'cancel' | undefined): void => {
      host.close()
      restoreFocus()
      settle(outcome === 'fork' ? 'fork' : 'cancelled')
    }
    const panel = new ForkAtTurnPanel(
      theme,
      turnLabel,
      totalTurns,
      detachedLiveId,
      outcome => finish(outcome),
      () => tui.requestRender(),
    )
    // maxHeight is a hard slice in pi-tui: title + 2 wrapped body points +
    // 2 options + footer ≈ 8 content rows + 4 frame rows; 75% of the 24-row
    // e2e floor is 18 (the /resume picker's headroom).
    host.open(panel, '70%', '75%')
  })
}
