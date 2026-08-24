/**
 * The pending-message queue panel — the revoke / promote surface for
 * unclaimed prompts (docs/design-steer-followup.md §二.3/§二.4).
 *
 * Lists every pending main-session message (the live agent inbox's next-step
 * and next-turn lists). On an entry:
 * - `d` — remove (core `Inbox.remove`, outcome `canceled` on the core side);
 * - `s` — promote: pull out of the queue and steer the current turn NOW;
 *   the same race fallback applies, so a promote whose turn just ended stays
 *   queued as a follow-up and says so.
 * Esc closes. ↑↓ selects. The list re-reads live (~300ms tick, subagent
 * viewer precedent) because items vanish when the agent claims them.
 *
 * Action execution is injected (`QueuePanelDeps`): this module owns the UI
 * and outcome wording; index.ts wires the bridge calls and mirrors failures
 * into the buffered transcript notice channel.
 */

import { getKeybindings, type Component, type TUI } from '@earendil-works/pi-tui'
import { describeQueueActionResult, type PendingPromptView, type QueueActionResult } from './steer-flow.ts'
import { PanelHost, panelThemeFns } from './panels.ts'
import { normalizePreview } from './sessions.ts'
import { BOLD, RESET, ansiFg, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'

/** Live-refresh interval while the panel is open (subagent viewer cadence). */
const QUEUE_TICK_MS = 300

/**
 * Consecutive throwing ticks tolerated before ONE durable warning is raised
 * (v0.20.1): a single failed read is noise, but a persistent one must never
 * leave the panel silently showing stale data.
 */
export const QUEUE_REFRESH_FAIL_THRESHOLD = 3

/** The warning text raised once per failure streak at the threshold. */
export const QUEUE_REFRESH_FAILED_NOTICE = 'Queue status refresh failed — the list below may be stale.'

/** Rows visible without scrolling; the overlay maxHeight slices the rest. */
const QUEUE_MAX_VISIBLE = 12

/** Target glyph + label per inbox boundary (badge vocabulary of the design). */
function targetLabel(target: 'next-step' | 'next-turn'): string {
  return target === 'next-step' ? '↪ steer' : '⏳ queued'
}

/** Footer hint — hardcoded like every other in-panel key hint. */
export const QUEUE_PANEL_FOOTER = '↑↓ select · d remove · s steer now · Esc close'

/** Everything the panel needs from the outside — injectable for tests. */
export interface QueuePanelDeps {
  /** Live pending snapshot (re-read on every tick and action). */
  readonly readItems: () => readonly PendingPromptView[]
  /** Remove one pending item (`d`). */
  readonly onRemove: (item: PendingPromptView) => QueueActionResult
  /** Promote one pending item to a strict steer (`s`). */
  readonly onPromote: (item: PendingPromptView) => QueueActionResult
  /**
   * Mirror one outcome into the persistent transcript (buffered notice).
   * The in-panel line is transient feedback; degrade/error outcomes must
   * also survive here (theme-switch rebuild included).
   */
  readonly onOutcome?: (result: QueueActionResult) => void
  /**
   * Durable mirror for a PERSISTENT tick failure (v0.20.1): raised once per
   * failure streak when `QUEUE_REFRESH_FAIL_THRESHOLD` consecutive ticks
   * threw, so the transcript records that the panel went stale. Absent =
   * only the in-panel notice line.
   */
  readonly onRefreshError?: (message: string) => void
  /** Re-focus the CURRENT editor instance on close. */
  readonly restoreFocus: () => void
  /**
   * Liveness gate re-checked on every refresh tick (review S4): when it
   * turns false — e.g. the session was switched or detached while the panel
   * stood open — the panel closes itself instead of ticking against a dead
   * inbox. Absent = always valid.
   */
  readonly shouldStayOpen?: () => boolean
}

/**
 * One rendered queue row: selection marker + route badge + preview.
 * Exported for the regression test (row assembly is pure).
 */
export function queueRow(item: PendingPromptView, selected: boolean): string {
  const marker = selected ? '▸' : ' '
  return `${marker} ${targetLabel(item.target)} · ${normalizePreview(item.text)}`
}

/**
 * The framed overlay component. Owns its selection state and a transient
 * notice line; rows rebuild from `deps.readItems` on the tick and after
 * each action, with the selection clamped to the new length.
 */
export class PendingQueuePanel implements Component {
  private readonly theme: TuiTheme
  private readonly deps: QueuePanelDeps
  private readonly requestRenderFn: () => void
  private items: readonly PendingPromptView[] = []
  private selected = 0
  private notice: string | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false
  /** Consecutive ticks whose refresh threw (reset on any success). */
  private refreshFailures = 0
  /** Whether this streak already raised its one durable warning. */
  private refreshFailureReported = false

  constructor(theme: TuiTheme, deps: QueuePanelDeps, requestRender: () => void) {
    this.theme = theme
    this.deps = deps
    this.requestRenderFn = requestRender
    this.items = deps.readItems()
  }

  invalidate(): void {}

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Start the live refresh — only after the overlay actually mounted. */
  startTicking(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      if (this.closed) return
      try {
        // Session switched / detached mid-view → close instead of ticking on.
        if (this.deps.shouldStayOpen !== undefined && !this.deps.shouldStayOpen()) {
          this.close()
          return
        }
        this.refresh()
        // Success resets the failure streak — a transient blip never warns.
        this.refreshFailures = 0
        this.refreshFailureReported = false
        this.requestRenderFn()
      } catch {
        // A throwing tick must never take the process down. Count the
        // streak; at the threshold raise ONE warning (in-panel line plus
        // the durable onRefreshError mirror) instead of silently ticking on
        // stale data — later failures in the same streak stay quiet so a
        // persistent outage cannot spam the transcript.
        this.refreshFailures++
        if (this.refreshFailures >= QUEUE_REFRESH_FAIL_THRESHOLD && !this.refreshFailureReported) {
          this.refreshFailureReported = true
          this.notice = QUEUE_REFRESH_FAILED_NOTICE
          this.deps.onRefreshError?.(QUEUE_REFRESH_FAILED_NOTICE)
          this.requestRenderFn()
        }
      }
    }, QUEUE_TICK_MS)
    this.timer.unref?.()
  }

  render(width: number): string[] {
    const fns = panelThemeFns(this.theme)
    const wrap = Math.max(2, width - 2)
    const lines: string[] = [
      fns.accent(BOLD + clipToWidth('Pending messages', wrap) + RESET),
      '',
    ]
    const visible = this.items.slice(0, QUEUE_MAX_VISIBLE)
    if (visible.length === 0) {
      lines.push(fns.subtle(clipToWidth('— no pending messages —', wrap)))
    } else {
      for (let i = 0; i < visible.length; i++) {
        const row = clipToWidth(queueRow(visible[i]!, i === this.selected), wrap)
        lines.push(i === this.selected
          ? ansiFg(this.theme.palette.accent) + BOLD + row + RESET
          : fns.muted(row))
      }
    }
    lines.push('')
    if (this.notice !== undefined) lines.push(fns.subtle(clipToWidth(this.notice, wrap)))
    lines.push(fns.subtle(clipToWidth(QUEUE_PANEL_FOOTER, wrap)))
    return lines
  }

  handleInput(data: string): void {
    // Any keypress retires a transient notice (it is feedback, not state).
    this.notice = undefined
    const kb = getKeybindings()
    if (kb.matches(data, 'tui.select.cancel')) {
      this.close()
      return
    }
    if (kb.matches(data, 'tui.select.up') && this.selected > 0) {
      this.selected -= 1
      this.requestRenderFn()
      return
    }
    if (kb.matches(data, 'tui.select.down') && this.selected < this.items.length - 1) {
      this.selected += 1
      this.requestRenderFn()
      return
    }
    const item = this.items[this.selected]
    if (item === undefined) return
    const key = data.toLowerCase()
    if (key === 'd') this.apply(this.deps.onRemove(item))
    else if (key === 's') this.apply(this.deps.onPromote(item))
  }

  /** Apply one action outcome: transient line here, durable mirror outside. */
  private apply(result: QueueActionResult): void {
    this.deps.onOutcome?.(result)
    this.notice = describeQueueActionResult(result)
    this.refresh()
    this.requestRenderFn()
  }

  /** Re-read the snapshot and clamp the selection into the new length. */
  private refresh(): void {
    this.items = this.deps.readItems()
    if (this.selected >= this.items.length) {
      this.selected = Math.max(0, this.items.length - 1)
    }
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    this.dispose()
    // onClose FIRST (it hides the overlay through the host), restoreFocus
    // LAST: with the focus-preemption guard in place (review S6) restoring
    // while our own overlay is still mounted would be a no-op and leave the
    // keyboard nowhere.
    this.onClose?.()
    this.deps.restoreFocus()
  }

  /** Close hook assigned by the flow opener (settles the promise). */
  onClose?: () => void
}

/**
 * Open the pending-queue overlay. Resolves when the panel closes. An empty
 * queue still opens (the empty-state row explains itself); the panel never
 * auto-closes so the key never feels swallowed.
 */
export function openPendingQueuePanel(
  tui: TUI,
  theme: TuiTheme,
  deps: QueuePanelDeps,
): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    // A half-mounted overlay must not strand the keyboard — and must not
    // leak the panel's interval either: dispose runs on every exit path
    // (PanelHost also disposes its component on close/replace, review S4).
    const host = new PanelHost(tui, theme, () => {
      panel.dispose()
      deps.restoreFocus()
      settle()
    })
    const finish = (): void => {
      host.close()
      deps.restoreFocus()
      settle()
    }
    const panel = new PendingQueuePanel(theme, deps, () => tui.requestRender())
    panel.onClose = finish
    const handle = host.open(panel, '70%', '60%')
    if (handle !== undefined) panel.startTicking()
  })
}
