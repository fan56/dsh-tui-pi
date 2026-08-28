/**
 * The /resume repair confirmation dialog — shown when a picked session's
 * log fails to load with a corrupt-log error (src/log-repair.ts
 * `isCorruptLogError`). Repairing rewrites user data on disk, so it is
 * NEVER done implicitly: this dialog is the explicit confirmation gate.
 *
 * Two options, in the spec's button order:
 *   1. Repair & resume — run the guarded in-place repair, then re-enter the
 *      selected row's resume path.
 *   2. Cancel — leave the log untouched; /resume reports the original error.
 * ↑↓ moves the selection, `1`/`2` select directly, Enter confirms, Esc
 * cancels — the exact keymap of the submit routing dialog (route-dialog.ts),
 * whose pure-reducer split this file mirrors so the decision matrix stays
 * unit-testable without a terminal. Framing/focus follow the shared overlay
 * contract: PanelHost framing, close re-focuses the CURRENT editor instance
 * through `restoreFocus`.
 */

import { getKeybindings, type Component, type TUI } from '@earendil-works/pi-tui'
import { PanelHost, panelThemeFns } from './panels.ts'
import { BOLD, RESET, ansiFg, type TuiTheme } from './theme/index.ts'
import { clipToWidth, wrapText } from './text.ts'

/** The two choices in display order; index 0 is preselected. */
export const REPAIR_CONFIRM_OPTIONS: ReadonlyArray<{ id: 'repair' | 'cancel'; title: string; hint: string }> = [
  { id: 'repair', title: 'Repair & resume', hint: 'rebuild the log in place, then enter the session' },
  { id: 'cancel', title: 'Cancel', hint: 'leave the log untouched' },
]

/** The fixed body copy (spec wording): what happened, what repair does, what is kept. */
export const REPAIR_CONFIRM_MESSAGE =
  'Resume log is corrupted (likely from a historical double-writer). '
  + 'Repair it in place? The original is kept as .corrupt-bak.'

/** Footer hint — hardcoded like every other panel footer (English-only). */
export const REPAIR_CONFIRM_FOOTER = '↑↓ select · 1/2 pick · Enter confirm · Esc cancel'

/** Pure dialog state: which row is highlighted, and the terminal outcome. */
export interface RepairConfirmState {
  selected: number
  /**
   * Set once by a terminal key: `'confirm'` (Enter on a selection) or
   * `'cancel'` (Esc). Further input is ignored afterwards.
   */
  settled?: 'confirm' | 'cancel'
}

export function initialRepairConfirmState(): RepairConfirmState {
  return { selected: 0 }
}

/**
 * Apply one raw key sequence to the dialog state. Unknown keys are no-ops;
 * anything after a settle is ignored (single terminal outcome guard).
 */
export function updateRepairConfirm(state: RepairConfirmState, data: string): RepairConfirmState {
  if (state.settled !== undefined) return state
  const kb = getKeybindings()
  if (kb.matches(data, 'tui.select.cancel')) return { ...state, settled: 'cancel' }
  if (kb.matches(data, 'tui.input.submit')) return { ...state, settled: 'confirm' }
  if (kb.matches(data, 'tui.select.up')) {
    return { ...state, selected: Math.max(0, state.selected - 1) }
  }
  if (kb.matches(data, 'tui.select.down')) {
    return { ...state, selected: Math.min(REPAIR_CONFIRM_OPTIONS.length - 1, state.selected + 1) }
  }
  // Digit direct-select (1-based): selects the row, Enter still confirms —
  // same select-then-confirm split as the routing dialog.
  const digit = /^([1-9])$/.exec(data)
  if (digit !== null) {
    const index = Number(digit[1]) - 1
    if (index < REPAIR_CONFIRM_OPTIONS.length) return { ...state, selected: index }
  }
  return state
}

/** Resolved dialog outcome: the chosen action, or undefined on cancel. */
export function repairConfirmOutcome(state: RepairConfirmState): 'repair' | 'cancel' | undefined {
  if (state.settled !== 'confirm') return undefined
  return REPAIR_CONFIRM_OPTIONS[state.selected]?.id
}

/**
 * The framed overlay component. Renders the fixed body copy plus the two
 * option rows; every key goes through {@link updateRepairConfirm}, and the
 * first terminal key fires `onFinish` exactly once.
 */
export class RepairConfirmPanel implements Component {
  private readonly theme: TuiTheme
  private readonly onFinish: (outcome: 'repair' | 'cancel' | undefined) => void
  private readonly requestRenderFn: () => void
  private state: RepairConfirmState = initialRepairConfirmState()

  constructor(
    theme: TuiTheme,
    onFinish: (outcome: 'repair' | 'cancel' | undefined) => void,
    requestRender: () => void,
  ) {
    this.theme = theme
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
      fns.accent(BOLD + clipToWidth('● Corrupted resume log', wrap) + RESET),
      ...wrapText(REPAIR_CONFIRM_MESSAGE, wrap).map(segment => fns.muted(clipToWidth(segment, wrap))),
      '',
    ]
    for (let i = 0; i < REPAIR_CONFIRM_OPTIONS.length; i++) {
      const option = REPAIR_CONFIRM_OPTIONS[i]!
      const marker = i === this.state.selected ? '▸' : ' '
      const row = clipToWidth(`${marker} ${i + 1}. ${option.title} — ${option.hint}`, wrap)
      lines.push(i === this.state.selected
        ? ansiFg(this.theme.palette.accent) + BOLD + row + RESET
        : fns.muted(row))
    }
    lines.push('')
    lines.push(fns.subtle(clipToWidth(REPAIR_CONFIRM_FOOTER, wrap)))
    return lines
  }

  handleInput(data: string): void {
    const previous = this.state
    this.state = updateRepairConfirm(this.state, data)
    if (this.state === previous) return
    if (this.state.settled === undefined) {
      this.requestRenderFn()
      return
    }
    this.onFinish(repairConfirmOutcome(this.state))
  }
}

/**
 * Open the repair confirmation dialog for one corrupt resume target.
 * Resolves `'repair'` when the user explicitly confirmed, `'cancelled'`
 * otherwise (Esc, or an overlay that failed to mount — treated as cancel so
 * a half-mounted dialog can never imply consent). Closing always hands
 * focus back through `restoreFocus` before the promise settles.
 */
export function openRepairConfirmDialog(
  tui: TUI,
  theme: TuiTheme,
  restoreFocus: () => void,
): Promise<'repair' | 'cancelled'> {
  return new Promise(resolve => {
    let settled = false
    const settle = (outcome: 'repair' | 'cancelled'): void => {
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
    const finish = (outcome: 'repair' | 'cancel' | undefined): void => {
      host.close()
      restoreFocus()
      settle(outcome === 'repair' ? 'repair' : 'cancelled')
    }
    const panel = new RepairConfirmPanel(
      theme,
      outcome => finish(outcome),
      () => tui.requestRender(),
    )
    // maxHeight is a hard slice in pi-tui: ~9 content rows + 5 frame rows
    // must fit or the bottom border (and footer) is cut. 75% of the 24-row
    // e2e floor is 18 — the same headroom the /resume picker reserves.
    host.open(panel, '70%', '75%')
  })
}
