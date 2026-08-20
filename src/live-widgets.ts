/**
 * Live widgets — every fixed live surface around the chat window:
 *
 *  - `todosDoc` (the widgets slot ABOVE the chat input) hosts THREE pinned
 *    panels: the bordered Todos table, the ThinkPanel and the ToolPanel
 *    (src/activity.ts). Think/tool activity NEVER creates transcript blocks
 *    — one panel of each kind exists for the whole run, every event
 *    refreshes it in place, and a panel with no content renders zero rows.
 *  - `activityDoc` (the lastRequest container BELOW the editor): the
 *    ` ● <last request>` line (persisting across agent churn) followed by one
 *    compact line PER RUNNING agent — `├─ ⠋ <name> · ↻N≤M · 21k/1m ·
 *    round N/M · 13.6s · <content tail>`. The tail is the child's latest
 *    CONTENT line (assistant text/reasoning, live-refreshed — never a tool
 *    name) and takes whatever the row has left, truncated at the right edge:
 *    one row, no wrap. `round N/M` shows the child's assistant-message count
 *    against the policy cap (M only when `maxRounds > 0`).
 *
 * Event flow: index.ts routes every parent-session event through
 * `applyEvent` (think/tool phase machine) and todo/write snapshots through
 * `renderTodos`; the bridge's onLive fold feeds `renderAgents`. Phase rules
 * for the panels: a reasoning delta shows the think panel; a tool call
 * refreshes the tool panel (pending); a matching result settles it (status
 * icon, frozen time, result tail); a text delta / assembled message / user
 * message / turn end hides the finished phases. `clear()` (/new, resume)
 * hides both panels.
 *
 * Live refresh: `tickLive` (the AGENT_TICK_MS timer in index.ts) advances
 * the spinner and repaints while any agent runs OR either panel is visible
 * (the elapsed columns re-read the clock each frame); no-op otherwise.
 * `setTheme` recolors in place on a theme hot-switch (the panels re-render
 * each frame through their theme getters — no replay buffer, they are live
 * state, not transcript history).
 */

import { Container, Text, type Component } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_PANEL_HEIGHT,
  ThinkPanel,
  ToolPanel,
  borderedRow,
  clipPanelLine,
  panelBottomBorder,
  panelBoxWidth,
  panelTopBorder,
} from './activity.ts'
import type { PanelHeight } from './activity.ts'
import type { AgentView } from './dsh-events.ts'
import { columnWidths, padCell, TABLE_SEP, type TableColumn } from './panels.ts'
import { SPAWN_TOOLS } from './subagent-policy.ts'
import { ansiFg, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth, visibleWidth } from './text.ts'

/** Refresh interval of the live surfaces (spinner + elapsed columns). */
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

    // Table header: every cell padded to its column so the rows align, each
    // painted in the subtle foreground (secondary info — matches the idx
    // column below).
    out.push(borderedRow(
      boxWidth,
      borderFg,
      TODO_COLUMNS.map((column, i) => subtle(padCell(column.title, colWidths[i], column.align))).join(TABLE_SEP),
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

    out.push(panelBottomBorder(boxWidth, borderFg))
    return out
  }
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
  /** The fixed think/tool status panels, mounted once in `todosDoc`. */
  private readonly thinkPanel: ThinkPanel
  private readonly toolPanel: ToolPanel
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
   * Live reader of the round cap (`readSubagentLimits(ctx).maxRounds`) for
   * the compact lines' `round N/M` — read per rebuild so a limits-panel
   * change hot-applies (the getter pattern the panels use for the theme).
   */
  private readonly readMaxRounds: () => number

  /**
   * @param todosDoc The dock slot ABOVE the chat input - the Todos table and
   *   the think/tool status panels live here.
   * @param activityDoc The lastRequest container BELOW the editor - the ` ● `
   *   last-request line plus the compact running-agent lines live here.
   * @param panelHeight Configured think/tool panel height ('1' one row, or a
   *   boxed budget - see activity.ts).
   * @param readMaxRounds Live round cap for the `round N/M` meta segment
   *   (0 = unlimited, the `/M` part is then omitted).
   */
  constructor(
    todosDoc: Container,
    activityDoc: Container,
    theme: TuiTheme,
    requestRender: () => void,
    panelHeight: PanelHeight = DEFAULT_PANEL_HEIGHT,
    readMaxRounds: () => number = () => 0,
  ) {
    this.todosDoc = todosDoc
    this.activityDoc = activityDoc
    this.theme = theme
    this.requestRender = requestRender
    this.readMaxRounds = readMaxRounds
    // Mounted once, in display order: Todos (persistent plan) above the
    // transient think/tool activity. The panels re-render at the live width
    // every frame and read the theme through their getters, so theme swaps
    // and terminal resizes need no rebuild wiring here.
    this.todosPanel = new TodosPanel(() => this.theme)
    this.thinkPanel = new ThinkPanel(() => this.theme)
    this.toolPanel = new ToolPanel(() => this.theme)
    this.thinkPanel.setHeight(panelHeight)
    this.toolPanel.setHeight(panelHeight)
    todosDoc.addChild(this.todosPanel)
    todosDoc.addChild(this.thinkPanel)
    todosDoc.addChild(this.toolPanel)
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
    // Extract the first line only — the last-request echo never wraps.
    const firstLine = text.split('\n')[0] ?? text
    const display = clipToWidth(firstLine, budget)
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

  /**
   * One parent-session session event, driving the think/tool phase machine:
   * a reasoning delta opens/feeds the think panel; a tool call refreshes the
   * tool panel (pending, replacing any tracked tool) — except delegation
   * spawn tools (`use_agent`/`subagent`/`workflow`/`ralph`), whose children
   * already render in the running-agent lines below the editor and never
   * open a tool block; a matching result settles the tracked tool; a text
   * delta, an assembled assistant message, a user message or a turn end
   * hides the finished phases. Called for every event AND for replayed
   * history (a resumed session replays its tool calls; its final turn/end
   * leaves the panels hidden).
   */
  applyEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'reasoning-delta') {
          if ((chunk.text ?? '') !== '') {
            this.thinkPanel.feed(chunk.text)
            this.toolPanel.hide()
          }
        } else if (chunk.type === 'text-delta' && (chunk.text ?? '') !== '') {
          // The answer streams into the transcript — the panels are done.
          this.thinkPanel.hide()
          this.toolPanel.hide()
        }
        break
      }
      case 'assistant/message':
        this.thinkPanel.hide()
        break
      case 'tool/call':
        // Delegation spawn tools (`use_agent`, `subagent`, `workflow`, …)
        // surface their children in the running-agent lines BELOW the editor
        // — showing them again as a tool block above it would duplicate the
        // display. They never open the tool panel, and a stale settled tool
        // is cleared when the delegation starts.
        if (SPAWN_TOOLS.includes(event.data.name)) {
          this.toolPanel.hide()
        } else {
          this.toolPanel.begin(event.data.callId, event.data.name, event.data.arguments)
        }
        this.thinkPanel.hide()
        break
      case 'tool/result': {
        const block = event.data.message.content[0]
        this.toolPanel.settle(block?.toolCallId ?? '', {
          error: event.data.error === undefined
            ? undefined
            : { name: event.data.error.name, code: event.data.error.code },
          block: block === undefined ? undefined : { isError: block.isError, content: block.content },
        })
        break
      }
      case 'user/message':
      case 'turn/end':
        this.thinkPanel.hide()
        this.toolPanel.hide()
        break
      default:
        break
    }
    this.requestRender()
  }

  /** Replace the subagent views (the bridge's onLive fold). */
  renderAgents(agents: readonly AgentView[]): void {
    this.liveAgents = agents
    this.rebuild()
  }

  /**
   * Live refresh ~10x/sec while any subagent runs or either status panel is
   * visible: advance the spinner and repaint (the elapsed columns re-read
   * Date.now() each frame). No-op otherwise — the activity area then holds
   * its final (empty) state.
   */
  tickLive(): void {
    const agentsLive = this.liveAgents.some(view => view.outcome === undefined)
    const panelsLive = this.thinkPanel.isVisible() || this.toolPanel.isVisible()
    if (!agentsLive && !panelsLive) return
    if (agentsLive) this.spinnerFrame += 1
    this.rebuild()
  }

  /**
   * Switch the configured think/tool panel height (the settings watch sink).
   * The panels re-render at the new budget on the next frame — no rebuild
   * wiring, they are self-drawing.
   */
  setPanelHeight(panelHeight: PanelHeight): void {
    this.thinkPanel.setHeight(panelHeight)
    this.toolPanel.setHeight(panelHeight)
    this.requestRender()
  }

  /** Recolor the widget (Todos panel, think/tool panels, ● line and agent
   * lines) under a theme hot-switch (no-op on the same bundle). The panels
   * read the theme through their getters, so the swap needs only a repaint. */
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
   * panel, hides the think/tool panels and drops the running-agent lines,
   * keeps the ` ● ` line. The bridge also fires `renderAgents([])`.
   */
  clear(): void {
    this.liveAgents = []
    this.spinnerFrame = 0
    this.todosPanel.setTodos([])
    this.thinkPanel.hide()
    this.toolPanel.hide()
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
   * slot collapses to the ● line). The pinned panels are NOT rebuilt here -
   * they are self-drawing components that re-render each frame.
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
   * ` ● `) + spinner + the agent NAME (`view.label`) + the exact meta the
   * boxed board showed (`↻retries≤max`, compact `tokens[/contextWindow]`,
   * `round N/M` — the assistant-message count against the live maxRounds cap,
   * elapsed) + the child's latest CONTENT line — live-refreshed assistant
   * text/reasoning, NEVER a tool name — as the ` · <tail>` suffix. NO box
   * chrome, NO provider. Layout against the terminal width: the name caps at
   * 40% of the space the meta leaves; the tail takes EVERYTHING else and is
   * truncated at the right edge (single row, never wrapped). The assembled
   * plain line is clipped to the terminal width BEFORE any ANSI is applied
   * (clipToWidth counts SGR fragments as visible columns — style last).
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
    if (view.contextTokens > 0) {
      // Compact context[/contextWindow]: `21k/1m` — no percent, no "token".
      // X is the CURRENT occupancy estimate (latest request billed input +
      // output + pending estimate, see AgentView.contextTokens), NOT the
      // cumulative spend `view.tokens` — that total only grows and stays the
      // viewer's/session panel's display.
      const ctx = typeof view.contextWindow === 'number' && view.contextWindow > 0
        ? `/${fmtCompact(view.contextWindow)}`
        : ''
      metaParts.push(`${fmtCompact(view.contextTokens)}${ctx}`)
    }
    // Assistant-message count against the cap: `round N/M` (the `/M` part is
    // dropped when maxRounds is 0/unlimited). Always shown — a freshly spawned
    // child at `round 0` proves the counter is live, not silently frozen.
    const maxRounds = this.readMaxRounds()
    metaParts.push(`round ${view.rounds ?? 0}${maxRounds > 0 ? `/${maxRounds}` : ''}`)
    const elapsed = (Date.now() - view.startedAt) / 1000
    metaParts.push(`${elapsed.toFixed(1)}s`)
    const metaPlain = ' · ' + metaParts.join(' · ')
    // Defensive: never render an empty name — fall back to `subagent`.
    const rawLabel = clipPanelLine(view.label, 0).replace(/\r/g, '').trim()
    const namePlain = rawLabel === ''
      ? 'subagent'
      : rawLabel
    // Fixed chrome: prefix (3) + spinner (1) + following space (1) + a safety
    // column. The name caps at 40% of what the meta leaves; the tail gets the
    // remainder of the width budget.
    const fixed = visibleWidth(PREFIX) + 1 + 1 + 1
    const avail = width - fixed - visibleWidth(metaPlain)
    const nameCap = Math.max(10, Math.floor(avail * 0.4))
    const nameClipped = clipToWidth(namePlain, Math.max(0, nameCap))
    const tailBudget = avail - visibleWidth(nameClipped) - 3
    let tailText = ''
    const folded = view.lastLine === undefined ? '' : view.lastLine.replace(/\s+/g, ' ').trim()
    if (folded !== '' && tailBudget >= 4) {
      tailText = ` · ${clipToWidth(folded, tailBudget - 3)}`
    }
    // The full PLAIN line, clipped to the terminal width BEFORE styling.
    const plain = PREFIX + glyph + ' ' + nameClipped + metaPlain + tailText
    const clipped = clipToWidth(plain, width)
    // Style segments from the (clipped, guaranteed-identical-when-it-fits)
    // plain pieces: connector subtle, spinner muted, NAME default (prominent),
    // meta subtle, content tail muted (the live signal the user watches).
    const connector = ansiFg(this.theme.palette.fgSubtle) + PREFIX + RESET
    const spinner = ansiFg(this.theme.palette.fgMuted) + glyph + RESET
    const metaStyled = ansiFg(this.theme.palette.fgSubtle) + metaPlain + RESET
    const tailStyled = ansiFg(this.theme.palette.fgMuted) + tailText + RESET
    const nameStyled = ansiFg(this.theme.palette.fgDefault) + nameClipped + RESET
    const base = connector + spinner + ' ' + nameStyled + metaStyled + tailStyled
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
