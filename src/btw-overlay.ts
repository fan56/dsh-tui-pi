/**
 * The btw overlay — framed floating panel presenting one side-call exchange
 * (CONTEXT.md: Btw overlay). Bound to a single BtwRunState object: a live
 * run is the controller's own mutable state (setText streaming, Markdown
 * once on settle), a review is a plain snapshot object from the Last-btw
 * slot. Esc closes through the shared overlay focus contract — closing
 * never stops the run; it delivers into the slot regardless.
 *
 * Pure rendering + key routing only; all decisions live in btw.ts. This file
 * is the PanelHost glue and is exercised on a terminal, not in unit tests
 * (same split as route-dialog).
 */

import { getKeybindings, Markdown, Text, type Component, type TUI } from '@earendil-works/pi-tui'
import { PanelHost, panelThemeFns } from './panels.ts'
import { BOLD, RESET, ansiFg, type TuiTheme } from './theme/index.ts'
import type { BtwController, BtwRunState } from './btw.ts'
import { clipToWidth } from './text.ts'

/**
 * Answer row budget, sized so the panel NEVER overflows the 24-row e2e
 * terminal (AGENTS.md matrix floor): maxHeight '80%' ≈ 19 rows there, the
 * FramedOverlay chrome eats 4, fixed rows are 4 (title + 2 blanks + status),
 * and the question rows come out of the remainder per frame — an overlay
 * taller than that just shows a roomier answer. Overflow of the answer
 * itself is a named tail window (the newest rows stay visible).
 */
const BTW_ANSWER_BASE_BUDGET = 11
const BTW_ANSWER_MIN_BUDGET = 3

export class BtwOverlayPanel implements Component {
  private readonly run: BtwRunState
  private readonly controller: BtwController
  private readonly theme: () => TuiTheme
  private readonly onClose: () => void
  private readonly question: Text
  /** Streaming view — one Text, setText per change (AGENTS.md #2). */
  private readonly answerText: Text
  private streamedText = ''
  /** Built once when the run settles; never re-parsed per frame. */
  private finalMarkdown: Markdown | undefined

  constructor(
    run: BtwRunState,
    controller: BtwController,
    theme: () => TuiTheme,
    onClose: () => void,
  ) {
    this.run = run
    this.controller = controller
    this.theme = theme
    this.onClose = onClose
    this.question = new Text(run.question, 1, 0)
    this.answerText = new Text('', 1, 0)
  }

  invalidate(): void {}

  render(width: number): string[] {
    const fns = panelThemeFns(this.theme())
    const wrap = Math.max(2, width - 2)
    const questionLines = this.question.render(wrap)
    const budget = Math.max(BTW_ANSWER_MIN_BUDGET, BTW_ANSWER_BASE_BUDGET - questionLines.length)
    const lines: string[] = [
      fns.accent(BOLD + clipToWidth(`⌘ btw — ${this.run.modelLabel}`, wrap) + RESET),
      ...questionLines,
      '',
    ]

    const queued = this.controller.queuedCount
    if (this.run.status === 'streaming') {
      if (this.run.answerText !== this.streamedText) {
        this.answerText.setText(this.run.answerText)
        this.streamedText = this.run.answerText
      }
      if (this.run.answerText !== '') {
        lines.push(...tailWindow(this.answerText.render(wrap), budget, wrap))
      } else {
        lines.push(fns.muted(clipToWidth('Thinking…', wrap)))
      }
      lines.push('')
      lines.push(fns.subtle(clipToWidth(
        `Running alongside the main task · Esc close${queued > 0 ? ` · ${queued} queued` : ''}`,
        wrap,
      )))
      return lines
    }

    if (this.run.status === 'error') {
      lines.push(fns.muted(clipToWidth(`✘ ${this.run.error ?? 'btw failed.'}`, wrap)))
    } else if (this.run.answerText === '') {
      lines.push(fns.muted(clipToWidth('(no answer text)', wrap)))
    } else {
      if (this.finalMarkdown === undefined) {
        // Parses ONCE on the settled answer — never per frame, per token.
        this.finalMarkdown = new Markdown(this.run.answerText, 1, 0, this.theme().markdown, {
          color: text => ansiFg(this.theme().palette.fgDefault) + text + RESET,
        })
      }
      lines.push(...tailWindow(this.finalMarkdown.render(wrap), budget, wrap))
    }
    lines.push('')
    lines.push(fns.subtle(clipToWidth(
      `Not kept in the session · /btw reopens this answer${queued > 0 ? ` · ${queued} queued` : ''}`,
      wrap,
    )))
    return lines
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, 'tui.select.cancel')) this.onClose()
  }
}

/** Last rows that fit the budget; the hidden count is named above the tail. */
function tailWindow(rendered: string[], budget: number, wrap: number): string[] {
  if (rendered.length <= budget) return rendered
  const hidden = rendered.length - budget
  return [clipToWidth(`… ${hidden} lines above`, wrap), ...rendered.slice(-budget)]
}

/**
 * Overlay lifecycle for btw runs: `open(run)` shows/swaps the framed panel
 * bound to that run state; Esc and cancelAll close it through restoreFocus.
 * Two-step wiring — construct first, `attach(controller)` once it exists
 * (the panel needs the controller for the queued count; the controller needs
 * these callbacks at construction).
 */
export class BtwOverlayWire {
  private readonly tui: TUI
  private readonly theme: () => TuiTheme
  private readonly restoreFocus: () => void
  private host: PanelHost | undefined
  private controller: BtwController | undefined

  constructor(deps: { tui: TUI; theme: () => TuiTheme; restoreFocus: () => void }) {
    this.tui = deps.tui
    this.theme = deps.theme
    this.restoreFocus = deps.restoreFocus
  }

  attach(controller: BtwController): void {
    this.controller = controller
  }

  /** Called by the controller for every launched or reviewed run. */
  open(run: BtwRunState): void {
    const controller = this.controller
    if (controller === undefined) return
    // A failed PanelHost.open releases the keyboard exactly like a normal
    // close (PanelHost calls onError first); the run itself is unaffected.
    const close = (): void => {
      this.host?.close()
      this.host = undefined
      controller.setOverlayOpen(false)
      this.restoreFocus()
    }
    this.host?.close()
    this.host = new PanelHost(this.tui, this.theme(), close)
    controller.setOverlayOpen(true)
    this.host.open(new BtwOverlayPanel(run, controller, this.theme, close), '70%', '80%')
  }

  /** Called by cancelAll — the overlay's run is gone either way. */
  requestClose(): void {
    if (this.host !== undefined) {
      this.host.close()
      this.host = undefined
      this.controller?.setOverlayOpen(false)
      this.restoreFocus()
    }
  }
}
