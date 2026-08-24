/**
 * The submit routing dialog — shown when the user submits a prompt while the
 * main agent is mid-turn (docs/design-steer-followup.md §二.1).
 *
 * Two options, exactly the design's contract:
 *   1. Queue as follow-up — deliver when the current turn ends.
 *   2. Steer now — inject at the next step boundary of the running turn.
 * ↑↓ moves the selection, `1`/`2` select directly, Enter confirms, Esc
 * cancels WITHOUT sending (the caller restores the editor draft).
 *
 * The key→state decision is a pure reducer (`updateRouteDialog`) so the whole
 * dialog matrix is unit-testable without a terminal; the component only
 * renders and forwards keys. Framing/focus follow the shared overlay
 * contract: PanelHost framing, close re-focuses the CURRENT editor instance
 * through `restoreFocus`.
 */

import { getKeybindings, type Component, type TUI } from '@earendil-works/pi-tui'
import { PanelHost, panelThemeFns } from './panels.ts'
import { normalizePreview } from './sessions.ts'
import type { PromptRoute } from './steer-flow.ts'
import { BOLD, RESET, ansiFg, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'

/** The two routing choices in display order (design §二.1). */
export const ROUTE_OPTIONS: ReadonlyArray<{ id: PromptRoute; title: string; hint: string }> = [
  { id: 'followup', title: 'Queue as follow-up', hint: 'delivered when the current turn ends' },
  { id: 'steer', title: 'Steer now', hint: 'injected at the next step boundary' },
]

/** Pure dialog state: which row is highlighted, and the terminal outcome. */
export interface RouteDialogState {
  selected: number
  /**
   * Set once by a terminal key: `'confirm'` (Enter on a selection) or
   * `'cancel'` (Esc). Further input is ignored afterwards.
   */
  settled?: 'confirm' | 'cancel'
}

export function initialRouteDialogState(): RouteDialogState {
  return { selected: 0 }
}

/**
 * Apply one raw key sequence to the dialog state. Unknown keys are no-ops;
 * anything after a settle is ignored (single terminal outcome guard).
 */
export function updateRouteDialog(state: RouteDialogState, data: string): RouteDialogState {
  if (state.settled !== undefined) return state
  const kb = getKeybindings()
  if (kb.matches(data, 'tui.select.cancel')) return { ...state, settled: 'cancel' }
  if (kb.matches(data, 'tui.input.submit')) return { ...state, settled: 'confirm' }
  if (kb.matches(data, 'tui.select.up')) {
    return { ...state, selected: Math.max(0, state.selected - 1) }
  }
  if (kb.matches(data, 'tui.select.down')) {
    return { ...state, selected: Math.min(ROUTE_OPTIONS.length - 1, state.selected + 1) }
  }
  // Digit direct-select (1-based): selects the row, Enter still confirms —
  // same select-then-confirm split as the design's "数字键选，Enter 确认".
  const digit = /^([1-9])$/.exec(data)
  if (digit !== null) {
    const index = Number(digit[1]) - 1
    if (index < ROUTE_OPTIONS.length) return { ...state, selected: index }
  }
  return state
}

/** Resolved dialog outcome: the chosen route, or undefined on cancel. */
export function routeDialogOutcome(state: RouteDialogState): PromptRoute | undefined {
  if (state.settled !== 'confirm') return undefined
  return ROUTE_OPTIONS[state.selected]?.id
}

/** Footer hint — hardcoded like every other panel footer (English-only). */
export const ROUTE_DIALOG_FOOTER = '↑↓ select · 1/2 pick · Enter confirm · Esc cancel'

/**
 * The framed overlay component. Renders the draft preview plus the two
 * option rows; every key goes through {@link updateRouteDialog}, and the
 * first terminal key fires `onFinish` exactly once.
 */
export class RouteDialogPanel implements Component {
  private readonly theme: TuiTheme
  private readonly draft: string
  private readonly onFinish: (route: PromptRoute | undefined) => void
  private readonly requestRenderFn: () => void
  private state: RouteDialogState = initialRouteDialogState()

  constructor(
    theme: TuiTheme,
    draft: string,
    onFinish: (route: PromptRoute | undefined) => void,
    requestRender: () => void,
  ) {
    this.theme = theme
    this.draft = draft
    this.onFinish = onFinish
    this.requestRenderFn = requestRender
  }

  invalidate(): void {}

  render(width: number): string[] {
    const fns = panelThemeFns(this.theme)
    const wrap = Math.max(2, width - 2)
    // Review S1: the preview is display-only — a multi-line draft must be
    // folded onto one clipped row here (a raw newline would shatter the
    // overlay layout); the FULL raw text is what gets restored on Esc.
    const preview = normalizePreview(this.draft, 400)
    const lines: string[] = [
      fns.accent(BOLD + clipToWidth('Agent is running — route your message', wrap) + RESET),
      fns.muted(clipToWidth(preview === '' ? '(empty message)' : preview, wrap)),
      '',
    ]
    for (let i = 0; i < ROUTE_OPTIONS.length; i++) {
      const option = ROUTE_OPTIONS[i]!
      const marker = i === this.state.selected ? '▸' : ' '
      const row = clipToWidth(`${marker} ${i + 1}. ${option.title} — ${option.hint}`, wrap)
      lines.push(i === this.state.selected
        ? ansiFg(this.theme.palette.accent) + BOLD + row + RESET
        : fns.muted(row))
    }
    lines.push('')
    lines.push(fns.subtle(clipToWidth(ROUTE_DIALOG_FOOTER, wrap)))
    return lines
  }

  handleInput(data: string): void {
    const previous = this.state
    this.state = updateRouteDialog(this.state, data)
    if (this.state === previous) return
    if (this.state.settled === undefined) {
      this.requestRenderFn()
      return
    }
    this.onFinish(routeDialogOutcome(this.state))
  }
}

/**
 * Open the routing dialog for one submitted draft. Resolves with the chosen
 * route, or `undefined` when the user cancelled (or the overlay failed to
 * mount — treated as cancel so the draft is never lost). Closing always
 * hands focus back through `restoreFocus` before the promise settles.
 */
export function openSubmitRouteDialog(
  tui: TUI,
  theme: TuiTheme,
  draft: string,
  restoreFocus: () => void,
): Promise<PromptRoute | undefined> {
  return new Promise(resolve => {
    let settled = false
    const settle = (route: PromptRoute | undefined): void => {
      if (settled) return
      settled = true
      resolve(route)
    }
    // A half-mounted overlay must not strand the keyboard: PanelHost's
    // onError closes + calls restoreFocus, then we settle as cancelled.
    const host = new PanelHost(tui, theme, () => {
      restoreFocus()
      // A failed dialog degrades to the idle direct-send behavior (cancel).
      settle(undefined)
    })
    const finish = (route: PromptRoute | undefined): void => {
      host.close()
      restoreFocus()
      settle(route)
    }
    const panel = new RouteDialogPanel(
      theme,
      draft,
      route => finish(route),
      () => tui.requestRender(),
    )
    host.open(panel, '70%', '30%')
  })
}
