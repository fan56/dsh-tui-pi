/**
 * Fixed widgets pinned ABOVE the chat input: the Todos panel and the Agents
 * panel, each a bordered box (top border + header row + body rows + bottom
 * border, same chrome as the thinking/tool panels). The dock slot they live
 * in has auto height — it renders zero rows while both panels are empty and
 * grows to their content while the model holds todos or has subagents running.
 *
 * Show-when-content, clear-when-done: a panel appears only while it has
 * content and disappears when it empties — todos render until an empty
 * `todo/write` snapshot (or `/new`); the Agents board renders ONLY running
 * children (a settled child drops off, so once every subagent finishes the
 * whole panel vanishes).
 *
 * Live refresh: `tickLive` (the AGENT_TICK_MS timer in index.ts) advances the
 * spinner and re-reads the elapsed clock; it is a no-op while nothing runs.
 * `setTheme` recolors in place on a theme hot-switch (no replay buffer — the
 * widget is live state, not transcript history).
 */

import { Container, Text } from '@earendil-works/pi-tui'
import type { AgentView } from './dsh-events.ts'
import { panelBodyText, panelBoxWidth, clipPanelLine } from './messages.ts'
import { ansiFg, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth, visibleWidth } from './text.ts'

/** Refresh interval of the live Agents board (spinner + elapsed). */
export const AGENT_TICK_MS = 100
/** Braille spinner cycle; the frame index advances once per tick. */
export const AGENT_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** One bordered row of a widget panel: `│ ` + inner + ` │` (no trailing RESET). */
function borderedRow(boxWidth: number, borderFg: string, inner: string): string {
  const pad = Math.max(0, boxWidth - 4 - visibleWidth(inner))
  return `${borderFg}│ ${inner}${' '.repeat(pad)}${borderFg} │`
}

/** Top border line (`┌─…─┐`), `boxWidth` columns wide. */
function panelTopBorder(boxWidth: number, borderFg: string): string {
  return `${borderFg}┌${'─'.repeat(Math.max(0, boxWidth - 2))}┐`
}

export class LiveWidgets {
  private readonly doc: Container
  private theme: TuiTheme
  private readonly requestRender: () => void
  /** Latest todo list from `todo/write`, rendered while non-empty. */
  private liveTodos: readonly { content: string; status: string }[] = []
  /** Latest subagent views from the bridge's onLive fold. */
  private liveAgents: readonly AgentView[] = []
  /** The single widget Text (both bordered panels), replaced on rebuild. */
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
   * — the panel then holds its final (empty) state.
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
   * Rebuild the single widget Text: one bordered panel per present section
   * (Todos tree, running-agents board), stacked with no separator. When
   * nothing is left to show the Text is removed and the dock slot collapses.
   */
  private rebuild(): void {
    const panels: string[] = []
    if (this.liveTodos.length > 0) panels.push(this.boxedPanel(this.todosHeader(), this.todoLines()))
    const running = this.liveAgents.filter(view => view.outcome === undefined)
    if (running.length > 0) panels.push(this.boxedPanel('● Agents', this.agentLines(running)))
    if (panels.length === 0) {
      if (this.liveText !== undefined) {
        this.doc.removeChild(this.liveText)
        this.liveText = undefined
      }
      this.requestRender()
      return
    }
    if (this.liveText !== undefined) this.doc.removeChild(this.liveText)
    this.liveText = new Text(panels.join('\n'), 1, 0)
    this.doc.addChild(this.liveText)
    this.requestRender()
  }

  /** One bordered panel: top border + header row + body rows + bottom border. */
  private boxedPanel(headerInner: string, bodyLines: string[]): string {
    const boxWidth = panelBoxWidth(process.stdout.columns)
    const borderFg = ansiFg(this.theme.palette.borderDefault)
    const top = panelTopBorder(boxWidth, borderFg)
    const header = borderedRow(boxWidth, borderFg, clipPanelLine(headerInner))
    // 'all' body: every line kept verbatim (each already clipped to one
    // physical row), bottom border appended.
    const body = panelBodyText(bodyLines, boxWidth, borderFg, 'all')
    return `${top}\n${header}\n${body}`
  }

  /** `● Todos (done/total)`, styled for the panel header row. */
  private todosHeader(): string {
    const done = this.liveTodos.filter(todo => todo.status === 'completed').length
    return ansiFg(this.theme.palette.accent) + '● Todos ' + RESET
      + ansiFg(this.theme.palette.fgSubtle) + `(${done}/${this.liveTodos.length})` + RESET
  }

  /**
   * Tree-style todo body lines: `├─`/`└─` connectors with `☐`/`◐`/`☑` status
   * icons. Content is model-controlled: clipped BEFORE styling to the boxed
   * row's inner budget minus the tree chrome (connector 3 cols + icon+space
   * 2 cols) — see clipPanelLine's contract.
   */
  private todoLines(): string[] {
    const innerCap = panelBoxWidth(process.stdout.columns) - 4
    const lines: string[] = []
    const total = this.liveTodos.length
    for (let i = 0; i < total; i++) {
      const todo = this.liveTodos[i]
      const content = clipToWidth(todo.content, Math.max(10, innerCap - 5))
      const connector = ansiFg(this.theme.palette.fgSubtle) + (i === total - 1 ? '└─ ' : '├─ ') + RESET
      const statusStyled = todo.status === 'completed'
        ? this.theme.chat.todoDone(content)
        : todo.status === 'in_progress'
          ? ansiFg(this.theme.palette.attention) + `◐ ${content}` + RESET
          : this.theme.chat.todoOpen(content)
      lines.push(connector + statusStyled)
    }
    return lines
  }

  /**
   * Agent board body lines: one main line per RUNNING view (connector +
   * spinner + provider + label + meta) with an activity line beneath. The
   * label is the only unbounded field — its budget is computed against the
   * actual chrome width so no row ever exceeds the boxed inner budget; every
   * line is clipped BEFORE styling (see clipPanelLine's contract).
   */
  private agentLines(views: readonly AgentView[]): string[] {
    const innerCap = panelBoxWidth(process.stdout.columns) - 4
    const lines: string[] = []
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
      // 3 = connector, 2 = icon + space, 2 = safety column so the styled line
      // never wraps inside the box. Provider and label share the remaining
      // name budget; both are clipped (provider is a config value and can be
      // arbitrarily long, label is model-controlled).
      const nameBudget = innerCap - 3 - 2 - visibleWidth(metaPlain) - 2
      const providerClipped = clipToWidth(providerPlain, Math.max(0, nameBudget - 12))
      const labelBudget = Math.max(10, nameBudget - visibleWidth(providerClipped) - 2)
      const label = clipPanelLine(view.label, 0)
      const labelClipped = clipToWidth(label, labelBudget)
      const nameStyled = providerClipped === ''
        ? ansiFg(this.theme.palette.fgMuted) + labelClipped + RESET
        : ansiFg(this.theme.palette.fgDefault) + providerClipped + RESET + '  '
          + ansiFg(this.theme.palette.fgMuted) + labelClipped + RESET
      const metaStyled = ansiFg(this.theme.palette.fgSubtle) + metaPlain + RESET
      lines.push(connector + icon + ' ' + nameStyled + metaStyled)
      const indent = last ? '     ' : '│    '
      const activity = view.lastTool === undefined ? 'working…' : `running ${view.lastTool}…`
      lines.push(indent + '⎿  ' + ansiFg(this.theme.palette.fgSubtle)
        + clipToWidth(activity, Math.max(1, innerCap - 8)) + RESET)
    }
    return lines
  }
}
