/**
 * The subagent viewer — the Ctrl+G surface. Two levels, both on the shared
 * PanelHost overlay: a FW table picker (TablePanel) over the bridge's child
 * views, then a live transcript panel for one child's buffered event log.
 *
 * Picker rows (running first, then the five most recent settled) carry the
 * full picture of a delegation: status icon, label, delegation mode, rounds
 * against the policy cap (`maxRounds` from `readSubagentLimits`, only shown
 * when > 0), token spend (k) and elapsed time. Rounds are the child's
 * assistant-message count (one per LLM round-trip) — the bridge maintains it
 * on `assistant/message`, so it advances while a one-shot child works.
 * Settled rows read as faded because their status icon and the muted
 * description column mark the outcome.
 *
 * Transcript panel: one human-readable line per buffered SessionEvent
 * (user/assistant messages, tool calls + truncated results, turns, descriptor,
 * todos). The log is a capped per-child ring buffer (2000 events); a dropped
 * head is reported at the top. While the panel is open a ~300ms timer rebuilds
 * the lines from the bridge and re-renders, and the view follows the tail like
 * a ScrollView follow:'end' (an explicit scroll-up detaches; reaching the
 * bottom re-attaches). Esc closes, or a deliberate double-`x` within
 * `DOUBLE_PRESS_MS`.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  getKeybindings,
  type Component,
  type SelectItem,
  type TUI,
} from '@earendil-works/pi-tui'
import type { AgentView } from './dsh-events.ts'
import { isDcpCompactionNotice } from './dsh-events.ts'
import { sunglassesIcon } from './icons.ts'
import type { DshSessionBridge } from './session.ts'
import { DOUBLE_PRESS_MS, MIN_DOUBLE_PRESS_GAP_MS } from './keymap.ts'
import { readSubagentLimits } from './theme-settings.ts'
import { fitColumnWidth, PanelHost, panelThemeFns, TablePanel, type PanelThemeFns } from './panels.ts'
import { normalizePreview } from './sessions.ts'
import { toolSubject } from './activity.ts'
import { ansiFg, BOLD, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'

/** Live-refresh interval of the transcript panel while it is open. */
const VIEWER_TICK_MS = 300
/** How many recent settled children appear after the running ones. */
const SETTLED_CAP = 5
/** Rows of the picker table visible without scrolling (single source). */
const PICKER_MAX_VISIBLE = 12
/** Running-agent spinner glyph (first frame of the live widget's cycle). */
const RUNNING_GLYPH = '⠋'
/** The per-child log cap the bridge applies (mirrors the truncation hint). */
const CHILD_LOG_CAP = 2000

// ---------------------------------------------------------------- helpers --

/** Join an unknown message content into one trimmed text string. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const blockText = (block as { text?: unknown }).text
      if (typeof blockText === 'string') text += blockText + ' '
    }
  }
  return text.trim()
}

/** First text block of a tool result body, collapsed to one line. */
function resultPreview(content: unknown): string {
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block && typeof block === 'object') {
      const typed = block as { type?: string; text?: string }
      if (typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim() !== '') {
        return normalizePreview(typed.text)
      }
    }
  }
  return ''
}

/** Human token display: thousands read as `1.2k tok`. */
function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${tokens} tok`
}

/** Status glyph for one child view: running / completed / failed / cancelled. */
function statusGlyph(view: AgentView): string {
  if (view.outcome === undefined) return RUNNING_GLYPH
  if (view.outcome === 'completed') return '✓'
  if (view.outcome === 'failed') return '✗'
  return '—'
}

/**
 * The one human-readable line per buffered event. `callNames` pairs
 * `tool/result` rows back to their `tool/call` name (call ids are opaque).
 * Returns undefined to skip events that carry no readable surface (raw
 * `assistant/chunk` deltas fold into the assembled message, command nodes
 * render in the parent's transcript only).
 */
export function eventLine(event: SessionEvent, callNames: Map<string, string>): string | undefined {
  switch (event.type) {
    case 'turn/start':
      return `– turn ${event.data.turn} start`
    case 'turn/end': {
      const reason = event.data.reason
      const detail = reason.kind === 'error'
        ? `error${reason.error !== undefined ? `: ${(reason.error as { message?: string }).message ?? ''}` : ''}`
        : reason.kind
      return `– turn ${event.data.turn} end · ${detail}`
    }
    case 'user/message': {
      const message = event.data as { source?: { kind?: string }; content?: unknown }
      const text = normalizePreview(textOfContent(message.content))
      if (text === '') return undefined
      // dsh-dcp compaction notice: flag the row with the compaction glyph
      // instead of the generic `ⓘ`, so the viewer shows whether DCP ran
      // inside this child (the shared guard also drives the bridge's tally).
      if (isDcpCompactionNotice(event)) {
        return `🧹 ${text}`
      }
      return message.source?.kind === 'user' ? `▎ ${text}` : `ⓘ ${text}`
    }
    case 'assistant/message': {
      const blocks = (event.data as { message?: { content?: unknown } }).message?.content
      const parts: string[] = []
      if (Array.isArray(blocks)) {
        for (const raw of blocks) {
          if (!raw || typeof raw !== 'object') continue
          const block = raw as { type?: string; text?: string; id?: string; name?: string; arguments?: string }
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
            parts.push(normalizePreview(block.text))
          } else if (block.type === 'tool-call') {
            const name = block.name ?? 'tool'
            const subject = block.arguments !== undefined && block.arguments !== ''
              ? ` ${toolSubject(block.arguments)}`
              : ''
            parts.push(`⚙ ${name}${subject}`)
          }
        }
      }
      const line = parts.length > 0 ? `🐳 ${parts.join(' ')}` : '🐳 …'
      return line
    }
    case 'tool/call':
      callNames.set(event.data.callId, event.data.name)
      return `⚙ ${event.data.name}${event.data.arguments !== '' ? ` ${toolSubject(event.data.arguments)}` : ''}`
    case 'tool/result': {
      const block = event.data.message.content[0]
      const toolCallId = block?.toolCallId ?? ''
      const name = callNames.get(toolCallId) ?? `tool:${toolCallId.slice(0, 8)}`
      const isError = event.data.error !== undefined || (block?.isError ?? false)
      const text = resultPreview(block?.content)
      return `${isError ? '✘' : '✔'} ${name}${text !== '' ? `: ${text}` : ''}`
    }
    case 'subagent/descriptor': {
      const descriptor = event.data
      const parts = [`${sunglassesIcon()} subagent`]
      if (descriptor.provider !== undefined && descriptor.provider !== '') parts.push(descriptor.provider)
      if (descriptor.mode !== undefined) parts.push(`[${descriptor.mode}]`)
      return parts.join(' ')
    }
    case 'todo/write': {
      const todos = event.data.todos
      const done = todos.filter(todo => todo.status === 'completed').length
      const summary = todos
        .map(todo => `${todo.status === 'in_progress' ? '◐' : '☐'} ${todo.content}`)
        .join('   ')
      return `☑ todos ${done}/${todos.length}: ${normalizePreview(summary)}`
    }
    default:
      return undefined
  }
}

/** All readable lines of one child's buffered log, in log order. */
export function eventLines(events: readonly SessionEvent[]): string[] {
  const lines: string[] = []
  const callNames = new Map<string, string>()
  for (const event of events) {
    const line = eventLine(event, callNames)
    if (line !== undefined) lines.push(line)
  }
  return lines
}

/**
 * The picker rows: running children first (the live items the key is for),
 * then the five most recent settled ones (newest settle first). Each row
 * reads `⠋ label [mode] · rounds N[/max]` with the token spend, the dsh-dcp
 * compaction count (when > 0) and elapsed seconds in the muted description
 * column.
 */
export function pickerItems(
  views: readonly AgentView[],
  getRoundCount: (childId: string) => number,
  maxRounds: number,
  getCompactionCount: (childId: string) => number = () => 0,
): SelectItem[] {
  const running = views.filter(view => view.outcome === undefined)
  const settled = views
    .filter((view): view is AgentView & { outcome: 'completed' | 'failed' | 'cancelled'; endedAt: number } =>
      view.outcome !== undefined && view.endedAt !== undefined)
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, SETTLED_CAP)
  return [...running, ...settled].map(view => {
    const rounds = getRoundCount(view.childId)
    const roundsText = maxRounds > 0 ? `rounds ${rounds}/${maxRounds}` : `rounds ${rounds}`
    const mode = view.mode === undefined ? '' : ` [${view.mode}]`
    const elapsedMs = (view.outcome === undefined ? Date.now() : view.endedAt ?? Date.now()) - view.startedAt
    const compactions = getCompactionCount(view.childId)
    const description = [
      ...(view.tokens > 0 ? [formatTokens(view.tokens)] : []),
      ...(compactions > 0 ? [`🧹 ${compactions}×`] : []),
      `${(elapsedMs / 1000).toFixed(1)}s`,
    ].join(' · ')
    return {
      value: view.childId,
      label: `${statusGlyph(view)} ${view.label}${mode}: ${roundsText}`,
      ...(description !== '' ? { description } : {}),
    }
  })
}

/**
 * The next selected index after a picker items swap, preserving the selection
 * by item value. `previous === undefined` (no selection yet) starts at 0; a
 * value that dropped off the new list (e.g. a settled child fell out of the
 * recent-settled cap) clamps to the last row rather than resetting the user
 * to the top. Pure and exported for the regression test.
 */
export function nextSelectedIndex(items: readonly SelectItem[], previous: string | undefined): number {
  if (previous === undefined) return 0
  const index = items.findIndex(item => item.value === previous)
  return index < 0 ? Math.max(0, items.length - 1) : index
}

/**
 * The live sub-agent picker — a TablePanel on the shared FW table language
 * (title, header + rule, │-separated SUB-AGENT/STATS columns, footer) whose
 * rows re-build on a ~300ms tick.
 *
 * The picker rows are live: the timer re-runs `buildItems` (re-reading the
 * bridge's turn counts, token spend and elapsed time) and swaps in a fresh
 * TablePanel — rows are taken only at construction and there is no
 * setRows, so the panel would otherwise hold a frozen snapshot for the whole
 * open duration. The selection follows the highlighted child across the
 * swap via `selectedRow` + `preselect`; the tick only starts once the
 * overlay actually mounted (mirroring the transcript panel).
 */
class LiveSubagentTable implements Component {
  private readonly theme: TuiTheme
  private list: TablePanel<SelectItem>
  private readonly buildItems: () => SelectItem[]
  private readonly requestRender: () => void
  /** Close flow for the live-tick empty case (mirrors the open-time one). */
  private readonly onEmpty: () => void
  private readonly onSelectItem: (item: SelectItem) => void
  private readonly onCancelPicker: () => void
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    theme: TuiTheme,
    items: SelectItem[],
    buildItems: () => SelectItem[],
    requestRender: () => void,
    onEmpty: () => void,
    onSelectItem: (item: SelectItem) => void,
    onCancelPicker: () => void,
  ) {
    this.theme = theme
    this.buildItems = buildItems
    this.requestRender = requestRender
    this.onEmpty = onEmpty
    this.onSelectItem = onSelectItem
    this.onCancelPicker = onCancelPicker
    this.list = this.buildList(items, 0)
  }

  invalidate(): void {
    this.list.invalidate()
  }

  startTicking(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      try {
        this.refresh()
      } catch {
        // A throwing tick must never take the process down — skip the frame
        // and let the next tick retry.
      }
    }, VIEWER_TICK_MS)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** A fresh table over `items` — widths re-fit, selection at `preselect`. */
  private buildList(items: readonly SelectItem[], preselect: number): TablePanel<SelectItem> {
    return new TablePanel(this.theme, {
      title: '● Sub-agents',
      columns: [
        { key: 'label', title: 'Sub-agent', flex: true },
        { key: 'description', title: 'Stats', width: fitColumnWidth('Stats', items.map(item => item.description ?? ''), 24) },
      ],
      rows: items,
      renderCell: (item, column) => (column.key === 'description' ? item.description ?? '' : item.label),
      maxVisible: PICKER_MAX_VISIBLE,
      preselect,
      footer: '↑↓ navigate · Enter open · Esc close',
      onSelect: item => this.onSelectItem(item),
      onCancel: () => this.onCancelPicker(),
    })
  }

  /**
   * Rebuild the rows from the bridge and swap in a fresh table, keeping
   * focus. An empty rebuild (the tracker cleared, or the last settled fell
   * out of the recent cap) closes exactly like the open-time empty path —
   * it must not park a stale table over a dead tracker.
   */
  private refresh(): void {
    const items = this.buildItems()
    if (items.length === 0) {
      this.dispose()
      this.onEmpty()
      return
    }
    const previous = this.list.selectedRow()?.value
    this.list = this.buildList(items, nextSelectedIndex(items, previous))
    this.requestRender()
  }

  render(width: number): string[] {
    return this.list.render(width)
  }

  handleInput(data: string): void {
    this.list.handleInput(data)
  }
}

/**
 * The live transcript panel: header (label · provider · mode · status ·
 * rounds · tokens) over a scrollable window of the child's event lines. A
 * ~300ms timer re-reads the bridge log and re-renders; the view follows the
 * tail until the user scrolls up (re-detached on reaching the bottom again).
 * Esc closes; a double-`x` within `DOUBLE_PRESS_MS` closes too (single `x`
 * only arms the window).
 */
class SubagentViewerPanel implements Component {
  private readonly theme: TuiTheme
  private readonly bridge: DshSessionBridge
  private readonly childId: string
  /** Live reader of the round cap — re-read on every render (hot maxRounds). */
  private readonly readMaxRounds: () => number
  private readonly onClose: () => void
  private readonly requestRender: () => void
  private timer: ReturnType<typeof setInterval> | undefined
  /** Timestamp of the last handled `x` press; 0 = none (the double-press arm). */
  private lastXPress = 0
  /** Current scroll offset into the transcript lines. */
  private scrollTop = 0
  /** Whether the view is pinned to the log tail (default, re-set on the bottom). */
  private followEnd = true
  /** Line count of the last render (the scroll range), for input handling. */
  private lineCount = 0
  /** Body-window rows of the last render, for input handling. */
  private bodyRows = 0

  constructor(
    theme: TuiTheme,
    bridge: DshSessionBridge,
    childId: string,
    readMaxRounds: () => number,
    onClose: () => void,
    requestRender: () => void,
  ) {
    this.theme = theme
    this.bridge = bridge
    this.childId = childId
    this.readMaxRounds = readMaxRounds
    this.onClose = onClose
    this.requestRender = requestRender
  }

  startTicking(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      try {
        this.requestRender()
      } catch {
        // A throwing tick must never take the process down — skip the frame.
      }
    }, VIEWER_TICK_MS)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const fns = panelThemeFns(this.theme)
    const view = this.bridge.getAgentViews().find(agent => agent.childId === this.childId)
    const lines = eventLines(this.bridge.getChildLog(this.childId))
    const truncated = this.bridge.isChildLogTruncated(this.childId)
    this.lineCount = lines.length
    this.bodyRows = bodyRowsFor(truncated)
    const maxScroll = Math.max(0, this.lineCount - this.bodyRows)
    this.scrollTop = this.followEnd ? maxScroll : Math.max(0, Math.min(this.scrollTop, maxScroll))

    const wrap = Math.max(2, width - 2)
    const out: string[] = [this.headerLine(view)]
    if (truncated) out.push(fns.subtle(`…history truncated (${CHILD_LOG_CAP} event cap)`))
    const slice = lines.slice(this.scrollTop, this.scrollTop + this.bodyRows)
    if (slice.length === 0) {
      out.push(fns.subtle('  — no events yet —'))
    } else {
      for (const line of slice) out.push(fns.muted(clipToWidth(line === '' ? ' ' : line, wrap)))
    }
    out.push('')
    out.push(fns.subtle('↑↓ scroll · Esc close · x ×2 close'))
    return out
  }

  handleInput(data: string): void {
    const kb = getKeybindings()
    if (kb.matches(data, 'tui.select.cancel')) {
      this.onClose()
      return
    }
    if (data.toLowerCase() === 'x') {
      const now = Date.now()
      // Auto-repeat of a held x (~30-50ms gaps) never completes the double
      // press — only a deliberate second press within the window closes.
      if (this.lastXPress !== 0 && now - this.lastXPress < MIN_DOUBLE_PRESS_GAP_MS) return
      if (this.lastXPress !== 0 && now - this.lastXPress <= DOUBLE_PRESS_MS) {
        this.onClose()
      } else {
        this.lastXPress = now
      }
      return
    }
    if (kb.matches(data, 'tui.select.up')) this.scrollBy(-1)
    else if (kb.matches(data, 'tui.select.down')) this.scrollBy(1)
  }

  /** Scroll the window; re-attach to the tail when it reaches the bottom. */
  private scrollBy(lines: number): void {
    const maxScroll = Math.max(0, this.lineCount - this.bodyRows)
    const start = this.followEnd ? maxScroll : this.scrollTop
    const next = Math.max(0, Math.min(maxScroll, start + lines))
    this.scrollTop = next
    this.followEnd = next === maxScroll
    this.requestRender()
  }

  /** One-line child summary: colored status, the rest in the accent bold. */
  private headerLine(view: AgentView | undefined): string {
    const p = this.theme.palette
    if (view === undefined) {
      return ansiFg(p.accent) + BOLD + `ⓘ subagent ${clipToWidth(this.childId, 8)}` + RESET
    }
    const status = view.outcome === undefined ? 'running'
      : view.outcome === 'completed' ? 'completed'
      : view.outcome === 'failed' ? 'failed'
      : 'cancelled'
    const statusColor = view.outcome === undefined ? p.accent
      : view.outcome === 'completed' ? p.success
      : view.outcome === 'failed' ? p.danger
      : p.fgMuted
    const tail: string[] = [view.label]
    if (view.provider !== undefined) tail.push(view.provider)
    if (view.mode !== undefined) tail.push(view.mode)
    const maxRounds = this.readMaxRounds()
    tail.push(`rounds ${this.bridge.getRoundCount(this.childId)}${maxRounds > 0 ? `/${maxRounds}` : ''}`)
    if (view.tokens > 0) tail.push(formatTokens(view.tokens))
    // Budget the plain text so the status suffix (its own color) still fits.
    const budget = Math.max(20, 140 - status.length - 3)
    const base = clipToWidth(tail.join(' · '), budget)
    return ansiFg(p.accent) + BOLD + base + RESET + ' · ' + ansiFg(statusColor) + status + RESET
  }
}

/**
 * Body-window rows for the transcript panel: the framed overlay adds 4 rows
 * of chrome and slices anything taller, so the rendered child budget is 80%
 * of the terminal minus the frame; the header, footer and the optional
 * truncation hint take theirs, everything else is the transcript window.
 */
function bodyRowsFor(truncated: boolean): number {
  const childBudget = Math.max(1, Math.floor((process.stdout.rows ?? 24) * 0.8) - 4)
  return Math.max(1, childBudget - 3 - (truncated ? 1 : 0))
}

// --------------------------------------------------------------- the flow --

/**
 * Open the subagent picker / viewer. A table of the bridge's child views
 * (running first, then the five recent settled) opens; Enter opens a
 * live-refreshing transcript panel for that child. An empty list (no running,
 * no settled) closes immediately. Focus returns to `restoreFocus` on close;
 * the promise settles when the viewer closes (value is meaningless — index.ts
 * never branches on it).
 */
export async function openSubagentViewer(
  ctx: Context,
  tui: TUI,
  theme: TuiTheme,
  bridge: DshSessionBridge,
  restoreFocus: () => void,
): Promise<void> {
  let settle: (() => void) | undefined
  const host = new PanelHost(tui, theme, () => {
    // A half-mounted overlay must not strand the keyboard.
    restoreFocus()
    settle?.()
  })

  const finish = (): void => {
    host.close()
    restoreFocus()
    settle?.()
  }

  const showPicker = (): void => {
    // `bridge.getRoundCount` reads instance state — wrap instead of passing
    // the unbound method through to the pure item builder. `buildItems`
    // re-reads the limits live on every tick, so a maxRounds change
    // hot-applies while the picker stays open (no more open-time snapshot).
    const buildItems = (): SelectItem[] => pickerItems(
      bridge.getAgentViews(),
      childId => bridge.getRoundCount(childId),
      readSubagentLimits(ctx).maxRounds,
      childId => bridge.getChildCompactionCount(childId),
    )
    const items = buildItems()
    if (items.length === 0) {
      finish()
      return
    }
    const panel = new LiveSubagentTable(
      theme, items, buildItems,
      () => tui.requestRender(),
      () => finish(),
      item => {
        // Opening a viewer leaves the picker behind — stop its live refresh.
        panel.dispose()
        showViewer(item.value)
      },
      () => {
        panel.dispose()
        finish()
      },
    )
    // Tick only when the overlay mounted: a failed showOverlay already fired
    // the host's onError (restoreFocus + settle) — an orphaned interval would
    // re-render forever against nothing. The table's chrome (title + header
    // + rule + footer) is 5 rows taller than the old bare SelectList, so the
    // cap moves to 95% to keep the bottom border on a 24-row terminal.
    const handle = host.open(panel, '80%', '95%')
    if (handle !== undefined) panel.startTicking()
  }

  const showViewer = (childId: string): void => {
    const panel = new SubagentViewerPanel(
      theme, bridge, childId,
      () => readSubagentLimits(ctx).maxRounds,
      () => {
        panel.dispose()
        finish()
      },
      () => tui.requestRender(),
    )
    // Tick only when the overlay mounted: a failed showOverlay already fired
    // the host's onError (restoreFocus + settle) — an orphaned interval would
    // re-render forever against nothing.
    const handle = host.open(panel)
    if (handle !== undefined) panel.startTicking()
  }

  return new Promise<void>(resolve => {
    settle = resolve
    showPicker()
  })
}