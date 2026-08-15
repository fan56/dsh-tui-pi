/**
 * Fixed widgets pinned ABOVE the chat window: the live Todos tree and the
 * subagent Agents board. Unlike the transcript (which scrolls), both render
 * into a fixed top slot with auto height — the slot collapses to zero rows
 * while there is nothing to show and grows to its content while the model
 * holds todos or has subagents running.
 *
 * Show-when-content, clear-when-done: the Agents board renders ONLY running
 * children (a settled child drops off the board, so once every subagent
 * finishes the section — and the whole widget when todos are gone too —
 * disappears). Todos are model-controlled via `todo/write` snapshots; an
 * empty list (or `/new`) hides the section.
 *
 * Live refresh: `tickLive` (the AGENT_TICK_MS timer in index.ts) advances the
 * spinner and re-reads the elapsed clock; it is a no-op while nothing runs.
 * `setTheme` recolors in place on a theme hot-switch (no replay buffer — the
 * widget is live state, not transcript history).
 */

import { Container, Text } from '@earendil-works/pi-tui'
import type { AgentView } from './dsh-events.ts'
import { ansiFg, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth, visibleWidth } from './text.ts'

/** Refresh interval of the live Agents board (spinner + elapsed). */
export const AGENT_TICK_MS = 100
/** Braille spinner cycle; the frame index advances once per tick. */
export const AGENT_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export class LiveWidgets {
  private readonly doc: Container
  private theme: TuiTheme
  private readonly requestRender: () => void
  /** Latest todo list from `todo/write`, rendered while non-empty. */
  private liveTodos: readonly { content: string; status: string }[] = []
  /** Latest subagent views from the bridge's onLive fold. */
  private liveAgents: readonly AgentView[] = []
  /** The single widget Text (todos + separator + agents), replaced on rebuild. */
  private liveText: Text | undefined
  /** Spinner frame counter, advanced by tickLive while any agent runs. */
  private spinnerFrame = 0

  constructor(doc: Container, theme: TuiTheme, requestRender: () => void) {
    this.doc = doc
    this.theme = theme
    this.requestRender = requestRender
  }

  /** Replace the todos snapshot (`todo/write` events and replay). */
  renderTodos(todos: readonly { content: string; status: string }[]): void {
    this.liveTodos = todos
    this.rebuild()
  }

  /** Replace the subagent views (the bridge's onLive fold). */
  renderAgents(agents: readonly AgentView[]): void {
    this.liveAgents = agents
    this.rebuild()
  }

  /**
   * Live refresh ~10x/sec while any subagent runs: advance the spinner and
   * repaint (the elapsed column re-reads Date.now()). No-op when nothing runs
   * — the widget then holds its final (empty) state.
   */
  tickLive(): void {
    if (!this.liveAgents.some(view => view.outcome === undefined)) return
    this.spinnerFrame += 1
    this.rebuild()
  }

  /** Recolor the widget under a theme hot-switch (no-op on the same bundle). */
  setTheme(theme: TuiTheme): void {
    if (theme === this.theme) return
    this.theme = theme
    this.rebuild()
  }

  /** Drop everything (`/new`); the bridge also fires `renderAgents([])`. */
  clear(): void {
    this.liveTodos = []
    this.liveAgents = []
    this.spinnerFrame = 0
    if (this.liveText !== undefined) {
      this.doc.removeChild(this.liveText)
      this.liveText = undefined
      this.requestRender()
    }
  }

  /**
   * Rebuild the single widget Text (todos section, a blank separator when
   * both sections are present, agents section) and re-append it. Removing and
   * re-adding on every call keeps the fixed slot sized to the latest content;
   * when nothing is left to show the Text is removed and the slot collapses.
   */
  private rebuild(): void {
    const sections: string[] = []
    if (this.liveTodos.length > 0) sections.push(this.todosSection())
    // Clear-when-done: settled children drop off the board immediately.
    const running = this.liveAgents.filter(view => view.outcome === undefined)
    if (running.length > 0) {
      if (sections.length > 0) sections.push('')
      sections.push(this.agentsSection(running))
    }
    if (sections.length === 0) {
      if (this.liveText !== undefined) {
        this.doc.removeChild(this.liveText)
        this.liveText = undefined
      }
      this.requestRender()
      return
    }
    if (this.liveText !== undefined) this.doc.removeChild(this.liveText)
    this.liveText = new Text(sections.join('\n'), 1, 0)
    this.doc.addChild(this.liveText)
    this.requestRender()
  }

  /** Tree-style todo list: `● Todos (done/total)` header + one line per item. */
  private todosSection(): string {
    const width = process.stdout.columns ?? 200
    const done = this.liveTodos.filter(todo => todo.status === 'completed').length
    const total = this.liveTodos.length
    const lines = [
      ansiFg(this.theme.palette.accent) + '● Todos ' + RESET
        + ansiFg(this.theme.palette.fgSubtle) + `(${done}/${total})` + RESET,
    ]
    for (let i = 0; i < total; i++) {
      const todo = this.liveTodos[i]
      // Model-controlled content: clip BEFORE styling (see clipPanelLine's
      // contract), leaving the tree chrome headroom — the connector (`├─ ` /
      // `└─ `, 3 cols) plus the icon+space (2 cols) plus 1 safety column.
      const content = clipToWidth(todo.content, Math.max(10, width - 6))
      const connector = ansiFg(this.theme.palette.fgSubtle) + (i === total - 1 ? '└─ ' : '├─ ') + RESET
      const statusStyled = todo.status === 'completed'
        ? this.theme.chat.todoDone(content)
        : todo.status === 'in_progress'
          ? ansiFg(this.theme.palette.attention) + `◐ ${content}` + RESET
          : this.theme.chat.todoOpen(content)
      lines.push(connector + statusStyled)
    }
    return lines.join('\n')
  }

  /**
   * Subagent board: `● Agents` header, then one main line per RUNNING view
   * (connector + spinner + provider + label + meta) with an activity line
   * beneath. The label is the only unbounded field — its budget is computed
   * against the actual chrome width (connector, icon, provider, meta) so the
   * assembled line never exceeds the terminal; it is clipped BEFORE styling.
   */
  private agentsSection(views: readonly AgentView[]): string {
    const width = process.stdout.columns ?? 200
    const lines = [ansiFg(this.theme.palette.accent) + '● Agents' + RESET]
    const total = views.length
    for (let i = 0; i < total; i++) {
      const view = views[i]
      const last = i === total - 1
      const connector = ansiFg(this.theme.palette.fgSubtle) + (last ? '└─ ' : '├─ ') + RESET
      const glyph = AGENT_SPINNER_FRAMES[this.spinnerFrame % AGENT_SPINNER_FRAMES.length]
      const icon = ansiFg(this.theme.palette.fgMuted) + glyph + RESET
      const metaParts: string[] = []
      if (view.retries >= 1) {
        metaParts.push(view.maxRetries === undefined ? `↻${view.retries}` : `↻${view.retries}≤${view.maxRetries}`)
      }
      if (view.tokens > 0) {
        const pct = typeof view.contextWindow === 'number' && view.contextWindow > 0
          ? ` (${Math.round(view.tokens / view.contextWindow * 100)}%)`
          : ''
        metaParts.push(`${view.tokens} token${pct}`)
      }
      const elapsed = (Date.now() - view.startedAt) / 1000
      metaParts.push(`${elapsed.toFixed(1)}s`)
      // Plain (unstyled) meta for the label budget; styled only once assembled.
      const metaPlain = ' · ' + metaParts.join(' · ')
      const providerPlain = view.provider ?? ''
      // 3 = connector, 2 = icon + space, 2 = the spaces before the label,
      // 2 = safety column so the styled line never wraps on the terminal.
      const labelBudget = Math.max(10, width - 3 - 2 - visibleWidth(providerPlain) - 2 - visibleWidth(metaPlain) - 2)
      const label = clipToWidth(view.label, labelBudget)
      const nameStyled = providerPlain === ''
        ? ansiFg(this.theme.palette.fgMuted) + label + RESET
        : ansiFg(this.theme.palette.fgDefault) + view.provider + RESET + '  '
          + ansiFg(this.theme.palette.fgMuted) + label + RESET
      const metaStyled = ansiFg(this.theme.palette.fgSubtle) + metaPlain + RESET
      lines.push(connector + icon + ' ' + nameStyled + metaStyled)
      const indent = last ? '     ' : '│    '
      const activity = view.lastTool === undefined ? 'working…' : `running ${view.lastTool}…`
      lines.push(indent + '⎿  ' + ansiFg(this.theme.palette.fgSubtle)
        + clipToWidth(activity, Math.max(1, width - 8)) + RESET)
    }
    return lines.join('\n')
  }
}
