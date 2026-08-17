/**
 * Live widgets: the Todos boxed panel pinned ABOVE the chat input, and the
 * running-subagent activity merged into the last-request area BELOW the
 * editor. Two separate plain containers keep the two live surfaces apart:
 *
 *  - `todosDoc` — the dock slot above the input (`ui.widgets`): a single
 *    bordered Todos panel (top border + header row + tree body rows + bottom
 *    border, same chrome as the thinking/tool panels). Auto height — it
 *    renders zero rows while empty and grows to its content while the model
 *    has todos.
 *  - `activityDoc` — the lastRequest container below the editor
 *    (`ui.lastRequest`): the ` ● <last request>` line (persisting across
 *    agent churn) followed by one compact line PER RUNNING agent. NO box
 *    chrome, NO `● Agents` header, NO provider — just
 *    `├─ ⠋ <name> · ↻N≤M · 21k/1m · 13.6s · <latest output>`, the `├─ ` /
 *    `└─ ` prefix in the same column as the todo rows and the request ` ● `
 *    (the last running agent closes the list with `└─ `). Auto height — it
 *    collapses to zero rows when both the last-request line is cleared and no
 *    agent runs.
 *
 * Show-when-content, clear-when-done: the Todos panel appears only while it
 * has content and disappears when it empties (an all-completed snapshot or
 * `/new`); an agent line renders only while its child RUNS (a settled child
 * drops off immediately). `clear()` (/new) drops the Todos panel and the
 * agent lines but preserves the last-request echo.
 *
 * Live refresh: `tickLive` (the AGENT_TICK_MS timer in index.ts) advances the
 * spinner and re-reads the elapsed clock; it is a no-op while nothing runs.
 * `setTheme` recolors in place on a theme hot-switch (no replay buffer — the
 * widget is live state, not transcript history).
 */

import { Container, Text, type Component } from '@earendil-works/pi-tui'
import type { AgentView } from './dsh-events.ts'
import { panelBoxWidth, clipPanelLine } from './messages.ts'
import { columnWidths, padCell, TABLE_SEP, type TableColumn } from './panels.ts'
import { ansiFg, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth, visibleWidth } from './text.ts'

/** Refresh interval of the live running-agent lines (spinner + elapsed). */
export const AGENT_TICK_MS = 100
/** Braille spinner cycle; the frame index advances once per tick. */
export const AGENT_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/**
 * Compact human-readable size: 1_500_000 -> `1.5m`, 20_965 -> `20k`, 999 -> `999`.
 * Millions keep one decimal (a trailing `.0` dropped), thousands floor to `k`.
 */
export function fmtCompact(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? String(m) : m.toFixed(1).replace(/\.0$/, '')}m`
  }
  if (n >= 1_000) return `${Math.floor(n / 1_000)}k`
  return String(n)
}

/** One bordered row of the Todos panel: `│ ` + inner + ` │` (no trailing RESET). */
function borderedRow(boxWidth: number, borderFg: string, inner: string): string {
  const pad = Math.max(0, boxWidth - 4 - visibleWidth(inner))
  return `${borderFg}│ ${inner}${' '.repeat(pad)}${borderFg} │`
}

/** Top border line (`┌─…─┐`), `boxWidth` columns wide. */
function panelTopBorder(boxWidth: number, borderFg: string): string {
  return `${borderFg}┌${'─'.repeat(Math.max(0, boxWidth - 2))}┐`
}

/** The todos table columns: right-aligned row number, status icon, flex content. */
const TODO_COLUMNS: readonly TableColumn[] = [
  { key: 'idx', title: '#', width: 3, align: 'right' },
  { key: 'status', title: '✓', width: 2 },
  { key: 'content', title: 'Task', flex: true },
]

/** Status icon of one todo: pending / in-progress / completed. */
function todoIcon(status: string): string {
  if (status === 'completed') return '☑'
  if (status === 'in_progress') return '◐'
  return '☐'
}

/**
 * The live Todos panel - a self-drawing table on the panel framework
 * (padCell/columnWidths from panels.ts), rendered at the CURRENT width on
 * every frame. pi-tui's Container calls `render(width)` per frame with no
 * caching, so a terminal resize re-lays the table out (clip + column widths)
 * automatically - no stale baked rows, no word-wrap. Renders zero rows while
 * the list is empty or every todo is completed (clear-when-done).
 */
export class TodosPanel implements Component {
  private todos: readonly { content: string; status: string }[] = []
  private readonly getTheme: () => TuiTheme

  constructor(getTheme: () => TuiTheme) {
    this.getTheme = getTheme
  }

  invalidate(): void { /* stateless between renders - the theme comes via getTheme */ }

  /** Replace the todos snapshot (`todo/write` events, replay, /new). */
  setTodos(todos: readonly { content: string; status: string }[]): void {
    this.todos = todos
  }

  render(width: number): string[] {
    if (this.todos.length === 0 || this.todos.every(todo => todo.status === 'completed')) return []
    const theme = this.getTheme()
    const p = theme.palette
    const boxWidth = panelBoxWidth(width)
    const borderFg = ansiFg(p.borderDefault)
    const innerWidth = boxWidth - 4
    const colWidths = columnWidths(innerWidth, TODO_COLUMNS)
    const subtle = (text: string) => ansiFg(p.fgSubtle) + text + RESET

    // Header row of the panel: `● Todos (done/total)` in the accent/subtle pair.
    const done = this.todos.filter(todo => todo.status === 'completed').length
    const headerInner = ansiFg(p.accent) + '● Todos ' + RESET
      + subtle(`(${done}/${this.todos.length})`)
    const out = [panelTopBorder(boxWidth, borderFg), borderedRow(boxWidth, borderFg, headerInner)]

    // Table header: every cell padded to its column so the rows align.
    out.push(borderedRow(
      boxWidth,
      borderFg,
      TODO_COLUMNS.map((column, i) => padCell(column.title, colWidths[i], column.align)).join(TABLE_SEP),
    ))

    for (let i = 0; i < this.todos.length; i++) {
      const todo = this.todos[i]
      // Plain (clipped+padded) cells FIRST, ANSI after - the panel-line rule.
      const idxCell = padCell(String(i + 1), colWidths[0], 'right')
      const iconCell = padCell(todoIcon(todo.status), colWidths[1])
      const contentCell = padClip(todo.content, colWidths[2])
      // One color per status across the icon and content cells (the icon has
      // its own column here - no baked-in prefix from theme.chat.todo*).
      const color = todo.status === 'completed'
        ? p.success
        : todo.status === 'in_progress' ? p.attention : p.fgSubtle
      const statusStyle = (text: string) => ansiFg(color) + text + RESET
      out.push(borderedRow(
        boxWidth,
        borderFg,
        subtle(idxCell) + TABLE_SEP + statusStyle(iconCell) + TABLE_SEP + statusStyle(contentCell),
      ))
    }

    out.push(panelBottomRow(boxWidth, borderFg))
    return out
  }
}

/** Bottom border line (`└─…─┘`), `boxWidth` columns wide. */
function panelBottomRow(boxWidth: number, borderFg: string): string {
  return `${borderFg}└${'─'.repeat(Math.max(0, boxWidth - 2))}┘`
}

/** Clip one todo's content (a possibly multiline model string) to one row. */
function padClip(content: string, width: number): string {
  const flat = content.replace(/\r/g, '').replace(/\n/g, ' ').trim()
  return padCell(flat, width)
}

export class LiveWidgets {
  private readonly todosDoc: Container
  private readonly activityDoc: Container
  private theme: TuiTheme
  private readonly requestRender: () => void
  /** The self-drawing Todos table, mounted once in `todosDoc`. */
  private readonly todosPanel: TodosPanel
  /** Latest subagent views from the bridge's onLive fold. */
  private liveAgents: readonly AgentView[] = []
  /** The merged running-agent Text in `activityDoc`, replaced on rebuild. */
  private agentsText: Text | undefined
  /** The ` ● <last request>` Text in `activityDoc` (persists across churn). */
  private requestText: Text | undefined
  /** Plain clipped last-request text backing `requestText` (for setTheme). */
  private requestDisplay: string | undefined
  /** Spinner frame counter, advanced by tickLive while any agent runs. */
  private spinnerFrame = 0

  /**
   * @param todosDoc The dock slot ABOVE the chat input - the Todos table
   *   panel lives here.
   * @param activityDoc The lastRequest container BELOW the editor - the ` ● `
   *   last-request line plus the compact running-agent lines live here.
   */
  constructor(
    todosDoc: Container,
    activityDoc: Container,
    theme: TuiTheme,
    requestRender: () => void,
  ) {
    this.todosDoc = todosDoc
    this.activityDoc = activityDoc
    this.theme = theme
    this.requestRender = requestRender
    // Mounted once: the panel re-renders at the live width every frame and
    // reads the theme through the getter, so theme swaps and terminal
    // resizes need no rebuild wiring here.
    this.todosPanel = new TodosPanel(() => this.theme)
    todosDoc.addChild(this.todosPanel)
  }

  /**
   * Render the ` ● <text>` last-request line in `activityDoc`, UNDER which the
   * running-agent lines appear. `undefined` (or blank) removes the line. Same
   * styling as before the merge: `fgMuted` prefix, but the text is clipped to
   * the terminal width (`columns - 5`) so it ALWAYS renders on one row and
   * never wraps; outside a TTY (columns undefined) it falls back to 195.
   */
  setLastRequest(text: string | undefined): void {
    if (text === undefined || text.trim() === '') {
      if (this.requestText !== undefined) {
        this.activityDoc.removeChild(this.requestText)
        this.requestText = undefined
        this.requestDisplay = undefined
        this.requestRender()
      }
      return
    }
    // One-row budget: paddingX=1 on each side (2 cols) + the ` ● ` prefix (3
    // cols) → the plain `display` must fit `columns - 5`. Non-TTY fallback
    // keeps the old 200-col behavior.
    const budget = Math.max(1, (process.stdout.columns ?? 200) - 5)
    const display = clipToWidth(text, budget)
    if (this.requestText === undefined) {
      this.requestText = new Text('', 1, 0)
      // Keep the ● line ABOVE the running-agent lines regardless of whether
      // they already render (no insert-at on a plain Container — remove and
      // re-add both in the right order).
      if (this.agentsText !== undefined) this.activityDoc.removeChild(this.agentsText)
      this.activityDoc.addChild(this.requestText)
      if (this.agentsText !== undefined) this.activityDoc.addChild(this.agentsText)
    }
    this.requestDisplay = display
    this.requestText.setText(ansiFg(this.theme.palette.fgMuted) + ` ● ${display}` + RESET)
    this.requestRender()
  }

  /** Replace the todos snapshot (`todo/write` events and replay). */
  renderTodos(todos: readonly { content: string; status: string }[]): void {
    this.todosPanel.setTodos(todos)
    this.requestRender()
  }

  /** Replace the subagent views (the bridge's onLive fold). */
  renderAgents(agents: readonly AgentView[]): void {
    this.liveAgents = agents
    this.rebuild()
  }

  /**
   * Live refresh ~10x/sec while any subagent runs: advance the spinner and
   * repaint (the elapsed column re-reads Date.now()). No-op when nothing runs
   * — the activity area then holds its final (empty) state.
   */
  tickLive(): void {
    if (!this.liveAgents.some(view => view.outcome === undefined)) return
    this.spinnerFrame += 1
    this.rebuild()
  }

  /** Recolor the widget (Todos panel, ● line and agent lines) under a theme
   * hot-switch (no-op on the same bundle). The Todos panel reads the theme
   * through its getter, so the swap needs only a repaint. */
  setTheme(theme: TuiTheme): void {
    if (theme === this.theme) return
    this.theme = theme
    this.rebuild()
    // The request line is not part of rebuild() (it persists independent of the
    // agent lines); recolor it here from the cached plain text.
    if (this.requestDisplay !== undefined && this.requestText !== undefined) {
      this.requestText.setText(ansiFg(this.theme.palette.fgMuted) + ` ● ${this.requestDisplay}` + RESET)
    }
  }

  /**
   * Drop everything except the last-request echo (`/new`): clears the Todos
   * panel and the running-agent lines, keeps the ` ● ` line. The bridge also
   * fires `renderAgents([])`.
   */
  clear(): void {
    this.liveAgents = []
    this.spinnerFrame = 0
    this.todosPanel.setTodos([])
    if (this.agentsText !== undefined) {
      this.activityDoc.removeChild(this.agentsText)
      this.agentsText = undefined
    }
    this.requestRender()
  }

  /**
   * Rebuild the running-agent surface of `activityDoc`: the ` ● ` line
   * (managed separately, persists) followed by ONE Text holding the compact
   * running-agent lines joined by '\n' (or nothing when no agent runs - the
   * slot collapses to the ● line). The Todos table panel is NOT rebuilt
   * here - it is a self-drawing component that re-renders each frame.
   * Clear-when-done: the agent lines hide once no child is running.
   */
  private rebuild(): void {
    const running = this.liveAgents.filter(view => view.outcome === undefined)
    if (running.length > 0) {
      const lines = running.map((view, i) => this.compactAgentLine(view, i === running.length - 1))
      const text = lines.join('\n')
      if (this.agentsText !== undefined) {
        this.agentsText.setText(text)
      } else {
        this.agentsText = new Text(text, 1, 0)
        // Append under the ● line when it is present (plain Container appends).
        this.activityDoc.addChild(this.agentsText)
      }
    } else if (this.agentsText !== undefined) {
      this.activityDoc.removeChild(this.agentsText)
      this.agentsText = undefined
    }
    this.requestRender()
  }

  /**
   * One compact running-agent line for the last-request area, todo-style:
   * `├─ `/`└─ ` connector (same column as the todo rows and the request
   * ` ● `) + spinner + the agent NAME (`view.label`, matching the boxed
   * panel's main line) + the exact meta that main line showed (`↻retries≤max`,
   * compact `tokens[/contextWindow]`, elapsed) + the child's latest output
   * line when one exists (` · <tail>`, so the user sees it is alive). NO box
   * chrome, NO provider — the name is the prominent element; the last running
   * agent closes the list with `└─ `. The label is the only unbounded field;
   * it is clipped against a budget measured from the terminal width so the
   * whole plain line (prefix included) fits, then the assembled plain line is
   * clipped to the terminal width BEFORE any ANSI is applied (clipToWidth
   * counts SGR fragments as visible columns — style last).
   */
  private compactAgentLine(view: AgentView, isLast: boolean): string {
    // Todo-style tree connector: `├─ ` for non-final rows, `└─ ` for the last
    // running agent — aligned with the todo rows and the request ` ● `.
    const PREFIX = isLast ? '└─ ' : '├─ '
    const width = Math.max(1, process.stdout.columns ?? 80)
    const glyph = AGENT_SPINNER_FRAMES[this.spinnerFrame % AGENT_SPINNER_FRAMES.length]
    const metaParts: string[] = []
    if (view.retries >= 1) {
      metaParts.push(view.maxRetries === undefined ? `↻${view.retries}` : `↻${view.retries}≤${view.maxRetries}`)
    }
    if (view.tokens > 0) {
      // Compact tokens[/contextWindow]: `21k/1m` — no percent, no "token".
      const ctx = typeof view.contextWindow === 'number' && view.contextWindow > 0
        ? `/${fmtCompact(view.contextWindow)}`
        : ''
      metaParts.push(`${fmtCompact(view.tokens)}${ctx}`)
    }
    const elapsed = (Date.now() - view.startedAt) / 1000
    metaParts.push(`${elapsed.toFixed(1)}s`)
    let metaPlain = ' · ' + metaParts.join(' · ')
    // Tail: the child's latest visible output line, appended after the elapsed
    // column so the user knows it is alive. Budget ≤30% of the terminal width
    // (clamped 20..60 cols); when the folded line is wider, clip to
    // tailBudget-2 and end with `..` (clipToWidth's own `…` is stripped).
    const lastLine = view.lastLine
    if (lastLine !== undefined && lastLine !== '') {
      const folded = lastLine.replace(/\s+/g, ' ').trim()
      if (folded !== '') {
        const tailBudget = Math.min(60, Math.max(20, Math.floor(width * 0.3)))
        if (visibleWidth(folded) > tailBudget) {
          const clipped = clipToWidth(folded, tailBudget - 2).replace(/…$/, '')
          metaPlain += ` · ${clipped}..`
        } else {
          metaPlain += ` · ${folded}`
        }
      }
    }
    // Defensive: never render an empty name — fall back to `subagent`.
    const rawLabel = clipPanelLine(view.label, 0).replace(/\r/g, '').trim()
    const namePlain = rawLabel === ''
      ? 'subagent'
      : rawLabel
    // Fixed chrome: prefix (3) + spinner (1) + following space (1) + a safety
    // column. The label takes the remainder of the width budget after meta.
    const fixed = visibleWidth(PREFIX) + 1 + 1 + 1
    const nameBudget = width - fixed - visibleWidth(metaPlain)
    const nameClipped = clipToWidth(namePlain, Math.max(0, nameBudget))
    // The full PLAIN line, clipped to the terminal width BEFORE styling.
    const plain = PREFIX + glyph + ' ' + nameClipped + metaPlain
    const clipped = clipToWidth(plain, width)
    // Style segments from the (clipped, guaranteed-identical-when-it-fits)
    // plain pieces: connector subtle, spinner muted, NAME default (prominent),
    // meta (incl. the tail) subtle.
    const connector = ansiFg(this.theme.palette.fgSubtle) + PREFIX + RESET
    const spinner = ansiFg(this.theme.palette.fgMuted) + glyph + RESET
    const metaStyled = ansiFg(this.theme.palette.fgSubtle) + metaPlain + RESET
    const nameStyled = ansiFg(this.theme.palette.fgDefault) + nameClipped + RESET
    const base = connector + spinner + ' ' + nameStyled + metaStyled
    // If clipping truncated the plain line (pathological meta), re-clip the
    // assembled styled line's visible width too; otherwise base is exact.
    if (visibleWidth(clipped) < visibleWidth(plain)) {
      // Defensive: fall back to a single muted style over the clipped line so
      // no styled segment can push past the terminal width.
      return ansiFg(this.theme.palette.fgMuted) + clipped + RESET
    }
    return base
  }
}
