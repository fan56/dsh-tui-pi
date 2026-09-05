/**
 * /history — the read-only two-pane history browser (CONTEXT.md "History
 * browser", ADR 0003, docs/features/history.md).
 *
 * Left pane: a TablePanel listing the browsed session's COMPLETED turns
 * (turn 序号 + user-message preview, seq order — a list, not a tree; the
 * session log has no message-level branching). Right pane: the selected
 * turn's content — the user prompts in the main transcript's bubble style,
 * the assembled LLM replies as Markdown, and a per-tool call-count summary.
 * View and copy only: Enter/`c` refills the editor with the turn's user
 * prompt (a plain setText — never submitted), `s` swaps the browsed session
 * through a /resume-style picker, Esc closes. No resend, no branch, no
 * transcript jump.
 *
 * Snapshot semantics: the event list is read once per open / session switch
 * (live session → `session.snapshotEvents()`, stored session →
 * `sessionPersistence.inspect()` — a cold read, no writer lock, no agent
 * activation). A session that keeps running while the viewer is open does
 * NOT live-update; reopening refreshes.
 *
 * Layout: ≥100 terminal columns renders an HStack (list ≈40% with a 30-column
 * floor, detail takes the remainder); narrower terminals stack the panes
 * vertically (list on top). The container is chosen per render at the current
 * width. The window itself is FIXED geometry: the panel renders exactly
 * `overlayContentBudget()` lines (short content pads blank, long content
 * lives in the detail scroll window), so picking another turn never changes
 * the window size — only a terminal resize re-derives it (overlay mounted at
 * '90%' width / '85%' height; the budget floors the same percentage pi-tui
 * does).
 *
 * Focus model: the keyboard lives on the left list by default; `→` hands it
 * to the detail pane (`↑`/`↓` line-scroll, PgUp/PgDn or `[`/`]` page, `←` or
 * Esc steps back; every other key is inert there). Esc grades detail → list
 * → filter-clear → close — it never skips a level. Focus is visible: the
 * focused pane's cues are the list's ▸ cursor (demoted to `›` while the
 * detail is keyed) versus the detail pane's accent-BOLD title and its
 * `← list · ↑↓ scroll` footer hint.
 *
 * Scroll reality (documented deviation from the original sketch): pi-tui's
 * overlay path composites `component.render(width)` lines directly — the
 * layout engine never descends into overlays, so a ScrollView can never
 * obtain a viewport there (the same limitation AGENTS.md documents for plain
 * Containers). The detail pane therefore manages its own scroll window (the
 * SubagentViewerPanel precedent): `[` / `]` page, selection change resets to
 * the top. The content itself is built from the same pi-tui primitives the
 * main transcript uses (Text bubbles / Markdown), so the look matches.
 *
 * Static rebuild mode (the setTheme/relayout snapshot pattern): switching the
 * selected turn REBUILDS the detail container from the turn's events — the
 * render() path only ever slices an already-built line list and never
 * touches the event data (iron rule 1: render never re-scans). The one
 * deliberate exception is the render-time resize check below: an O(1)
 * budget comparison that may rebuild ALREADY-DERIVED display rows (never
 * events) so the fixed geometry tracks terminal resizes without a resize
 * listener. Unlike the transcript's event-driven relayout(), this runs
 * inside render() by design — do not copy it as a default pattern.
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
// Loads the SessionEventMap augmentation that adds the 'todo/write'
// whole-list snapshot (same vocabulary groupHistoryTurns reads through).
import type {} from '@deepseek-ai/dsh-tool-todo'
import {
  Container,
  getKeybindings,
  HStack,
  matchesKey,
  Markdown,
  Spacer,
  Text,
  VStack,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui'
import {
  groupHistoryTurns,
  matchesTurnFilter,
  toolCallSummary,
  turnPrimaryUserText,
  turnSeedSlice,
  type HistoryTurn,
} from './history-turns.ts'
import { stopIcon } from './icons.ts'
import { isCorruptLogError } from './log-repair.ts'
import { autoColumns, PanelHost, panelThemeFns, TablePanel, type TablePanelOptions } from './panels.ts'
import {
  isResumableSessionHeader,
  inspectPersistedSession,
  loadSessionLastUpdates,
  loadSessionPreviews,
  normalizePreview,
  PREVIEW_SESSION_CAP,
  RESUME_DIR_CAP,
  resumeRowTitle,
  sortSessionsByLastUpdate,
  type SessionPersistence,
} from './sessions.ts'
import { ansiFg, BOLD, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'

/** Terminal width at which the browser switches from stacked to side-by-side. */
export const DUAL_PANE_MIN_COLUMNS = 100

/** Floor of the left list pane in dual-pane mode (spec: min 30 columns). */
export const LEFT_PANE_MIN_COLUMNS = 30

/** Rendered-line cap of one user bubble in the detail pane (spec: truncated). */
export const MAX_USER_BUBBLE_LINES = 40

/**
 * Source-line budget for the ASSISTANT Markdown of one turn's detail pane
 * (user bubbles carry their own per-bubble cap; the tool summary and end
 * notice are one-liners). A pathological multi-thousand-line reply parses
 * once at rebuild (an explicit action) and would otherwise dominate the
 * width-cache line arrays for every frame — past the budget the tail is
 * replaced by one dim truncation marker pointing at /resume. Source lines,
 * not wrapped lines: the wrap factor is bounded by the terminal width and
 * the budget exists to kill the parse, not to police layout. Within the
 * budget nothing changes.
 */
export const MAX_DETAIL_LINES = 4000

/** List footer hint (the detail pane carries the scroll hints). */
const HISTORY_FOOTER = '↑↓ navigate · Enter/c copy · f fork · → detail · s session · / filter · Esc close'

/**
 * Content-row budget inside the framed overlay: showOverlay slices the
 * component's lines at maxHeight ('85%' of the terminal — pi-tui floors the
 * percentage, and so do we, so the budget never exceeds the real slice),
 * and the FramedOverlay adds 4 chrome rows (top/bottom border + a blank
 * spacer each). The browser renders EXACTLY this many lines (pad or cap —
 * fixed window geometry), and every inner budget derives from it so no
 * footer is ever sliced off. Testable; `rows` injected.
 */
export function overlayContentBudget(rows: number | undefined = process.stdout.rows): number {
  return Math.max(6, Math.floor((rows ?? 24) * 0.85) - 4)
}

/**
 * Visible rows of the left list: the TablePanel chrome is 7 rows (title,
 * ┬/header/┼/┴ rules, blank spacer, footer) and 2 more rows are reserved
 * for the filter line and the status line — the two optional lines that can
 * co-display with results (an applied filter plus a copy/load status), and
 * under-reserving them slices the panel footers off the fixed budget; the
 * stacked layout additionally owes the detail pane its own chrome + a living
 * body (15 reserved rows), the side-by-side layout only the slice guard (9).
 * Fixed at panel construction — a terminal resize mid-open keeps the stale
 * budget until reopened (the accepted overlay behavior). Testable.
 */
export function listMaxVisible(
  rows: number | undefined = process.stdout.rows,
  columns: number | undefined = process.stdout.columns,
): number {
  const budget = overlayContentBudget(rows)
  const reserve = (columns ?? 120) >= DUAL_PANE_MIN_COLUMNS ? 9 : 15
  return Math.max(3, Math.min(20, budget - reserve))
}

/** One row of the left list: the turn plus its pre-clipped display cells. */
export interface HistoryRow {
  turn: HistoryTurn
  /** The log turn number, as displayed. */
  turnLabel: string
  /** One-line preview (control chars folded, hard character cap). */
  preview: string
}

/**
 * The left-list rows for a turn list under `query`: case-insensitive
 * substring match on the preview text and the turn number, in seq order.
 * Pure; the TablePanel clips `preview` to the cell width at render time.
 */
export function historyRows(turns: readonly HistoryTurn[], query: string): HistoryRow[] {
  return turns
    .filter(turn => matchesTurnFilter(turn, query))
    .map(turn => ({
      turn,
      turnLabel: String(turn.turn),
      preview: normalizePreview(turn.previewText) || '(no text)',
    }))
}

/** The left-list title for one browsed session. */
function historyListTitle(sessionId: string, live: boolean): string {
  return `● History · ${clipToWidth(sessionId, 8)}${live ? ' (live)' : ''}`
}

/**
 * The user bubble's styled body: `▎ `-prefixed lines (the main transcript's
 * bubble look) with the theme foreground, capped at MAX_USER_BUBBLE_LINES
 * with an explicit continuation marker — the pane scrolls, but a 500-line
 * paste must not bury the reply wholesale.
 */
function userBubbleText(text: string, theme: TuiTheme): string {
  const lines = text.split('\n')
  const body = lines.length <= MAX_USER_BUBBLE_LINES
    ? lines
    : [...lines.slice(0, MAX_USER_BUBBLE_LINES), `… +${lines.length - MAX_USER_BUBBLE_LINES} more lines`]
  return theme.chat.userMessageText(body.map(line => `▎ ${line}`).join('\n'))
}

/** The turn-end status line (the main transcript's renderTurnEnd vocabulary). */
function turnEndLine(turn: HistoryTurn, theme: TuiTheme): string | undefined {
  if (turn.endReason === 'error') {
    return ansiFg(theme.palette.danger) + `✘ ${turn.endError ?? 'turn failed'}` + RESET
  }
  if (turn.endReason === 'aborted' || turn.endReason === 'interrupted' || turn.interrupted) {
    return ansiFg(theme.palette.fgSubtle) + `${stopIcon()} interrupted` + RESET
  }
  if (turn.endReason === 'max-tokens') {
    return ansiFg(theme.palette.attention) + '⚠ output token limit reached' + RESET
  }
  return undefined
}

/**
 * The detail pane's content for one turn, as a fresh Container of the same
 * primitives the main transcript renders: user prompts as canvasSubtle
 * bubbles (Text + bg), replies as Markdown parsed once per rebuild, then the
 * `⚙` tool-count summary line and any turn-end notice. Assistant source
 * lines are capped at MAX_DETAIL_LINES — the tail is replaced by one dim
 * marker pointing at /resume (the truncation happens HERE, on the explicit
 * rebuild path, never inside render()). `sessionId` (optional) only flavors
 * that marker's short id. Exported for tests.
 */
export function buildTurnDetailContainer(turn: HistoryTurn, theme: TuiTheme, sessionId?: string): Container {
  const doc = new Container()
  for (const text of turn.userTexts) {
    doc.addChild(new Text(userBubbleText(text, theme), 1, 0, theme.chat.userMessageBg))
    doc.addChild(new Spacer(1))
  }
  // The turn's replies, one Markdown per assembled message (steps), seq
  // order — never assistant/chunk (iron rule 9). Budgeted: past
  // MAX_DETAIL_LINES source lines the remaining replies fold into one
  // truncation marker.
  let budget = MAX_DETAIL_LINES
  let truncated = 0
  for (const text of turn.assistantTexts) {
    const sourceLines = text.split('\n').length
    if (budget <= 0) {
      truncated += sourceLines
      continue
    }
    const keep = Math.min(sourceLines, budget)
    truncated += sourceLines - keep
    const body = keep === sourceLines ? text : text.split('\n').slice(0, keep).join('\n')
    doc.addChild(new Markdown(body, 1, 0, theme.markdown, {
      color: line => ansiFg(theme.palette.fgDefault) + line + RESET,
    }))
    doc.addChild(new Spacer(1))
    budget -= keep
  }
  if (truncated > 0) {
    const pointer = sessionId !== undefined ? `/resume ${clipToWidth(sessionId, 8)} ` : '/resume '
    doc.addChild(new Text(
      ansiFg(theme.palette.fgSubtle) + `… ${truncated} more lines truncated — ${pointer}for the full turn` + RESET,
      1, 0,
    ))
    doc.addChild(new Spacer(1))
  }
  if (turn.userTexts.length === 0 && turn.assistantTexts.length === 0) {
    doc.addChild(new Text(ansiFg(theme.palette.fgSubtle) + '(this turn rendered no prompt or reply text)' + RESET, 1, 0))
    doc.addChild(new Spacer(1))
  }
  if (turn.toolCallNames.length > 0) {
    doc.addChild(new Text(ansiFg(theme.palette.fgMuted) + `⚙ ${toolCallSummary(turn.toolCallNames)}` + RESET, 1, 0))
    doc.addChild(new Spacer(1))
  }
  const end = turnEndLine(turn, theme)
  if (end !== undefined) doc.addChild(new Text(end, 1, 0))
  return doc
}

/**
 * The right pane: one selected turn's content with a self-managed scroll
 * window (see the module comment for why pi-tui's ScrollView cannot live
 * inside an overlay). `basisRows` pins the row budget in stacked layout;
 * undefined uses the full overlay budget (side-by-side layout).
 */
class TurnDetailPane implements Component {
  private readonly theme: TuiTheme
  private readonly requestRender: () => void
  private container: Container
  private headerTitle = ''
  private scrollTop = 0
  private bodyRows = 1
  private lineCount = 0
  /** Whether the focus model has the keyboard on this pane (see the panel). */
  private focused = false
  /** Fixed row budget (stacked layout); undefined = full overlay budget. */
  basisRows: number | undefined = undefined
  /**
   * Rendered lines per width. HStack measures every child at the full
   * overlay width before allocating the real pane width, so the pane renders
   * at TWO widths per frame — without this cache the Markdown child would
   * re-parse at alternating widths every frame (its cache is single-slot).
   * Cleared on rebuild (the only time content changes); bounded because the
   * realistic width set is two (measure + allocated) per terminal size.
   */
  private readonly widthCache = new Map<number, string[]>()

  constructor(theme: TuiTheme, requestRender: () => void) {
    this.theme = theme
    this.requestRender = requestRender
    this.container = new Container()
  }

  invalidate(): void {}

  /** Static rebuild: swap the content to `turn`'s events and reset to the top. */
  setTurn(turn: HistoryTurn | undefined, live: boolean, sessionId: string | undefined): void {
    this.scrollTop = 0
    const source = live ? ' · live snapshot' : ''
    this.headerTitle = turn === undefined
      ? 'History'
      : `Turn ${String(turn.turn)}${turn.endReason === 'completed' ? '' : ` · ${turn.endReason}`}${turn.interrupted ? ' · interrupted' : ''}${source}`
    this.container = turn === undefined
      ? new Container()
      : buildTurnDetailContainer(turn, this.theme, sessionId)
    this.widthCache.clear()
    this.requestRender()
  }

  /** Flip the focus visuals (accent vs subtle header, focus footer hint). */
  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    this.requestRender()
  }

  /** Page the window by `delta` pages (negative = up), clamped. */
  scrollByPage(delta: number): void {
    const maxScroll = Math.max(0, this.lineCount - this.bodyRows)
    this.scrollTop = Math.max(0, Math.min(this.scrollTop + delta * this.bodyRows, maxScroll))
    this.requestRender()
  }

  /** Scroll the window by `delta` lines (negative = up), clamped. */
  scrollByLines(delta: number): void {
    const maxScroll = Math.max(0, this.lineCount - this.bodyRows)
    this.scrollTop = Math.max(0, Math.min(this.scrollTop + delta, maxScroll))
    this.requestRender()
  }

  render(width: number): string[] {
    const fns = panelThemeFns(this.theme)
    const budget = Math.max(4, this.basisRows ?? overlayContentBudget())
    // Fixed geometry: header + blank + body + blank + footer = bodyRows + 4
    // = budget EXACTLY, whatever the turn's content — short turns pad with
    // blank body rows, long ones slice (the scroll window).
    this.bodyRows = Math.max(1, budget - 4)
    let lines = this.widthCache.get(width)
    if (lines === undefined) {
      lines = this.container.render(width)
      if (this.widthCache.size >= 4) this.widthCache.clear()
      this.widthCache.set(width, lines)
    }
    this.lineCount = lines.length
    const maxScroll = Math.max(0, lines.length - this.bodyRows)
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll))
    const body: string[] = this.lineCount === 0
      ? [fns.subtle(clipToWidth('Select a turn on the left.', width))]
      : lines.slice(this.scrollTop, this.scrollTop + this.bodyRows)
    while (body.length < this.bodyRows) body.push('')
    // Focus visuals: the focused pane's title reads accent BOLD, the idle
    // one fades to subtle; the focused footer carries the exit/scroll hints.
    const title = this.headerTitle === '' ? 'History' : this.headerTitle
    const header = this.focused
      ? fns.accent(BOLD + clipToWidth(title, width) + RESET)
      : fns.subtle(clipToWidth(title, width))
    const window = this.lineCount > this.bodyRows
      ? `${this.scrollTop + 1}–${Math.min(this.lineCount, this.scrollTop + this.bodyRows)}/${this.lineCount} lines`
      : `${this.lineCount} line${this.lineCount === 1 ? '' : 's'}`
    const footer = this.focused
      ? `← list · ↑↓ scroll · [ / ] page · ${window}`
      : `[ / ] page · ${window}`
    return [header, '', ...body, '', fns.subtle(clipToWidth(footer, width))]
  }
}

/** Structural TUI/session seam of the browser — keeps the flow testable. */
export interface HistoryBrowserDeps {
  readonly ctx: Context
  readonly tui: TUI
  readonly theme: TuiTheme
  /** Current live session id, when one exists. */
  getSessionId(): string | undefined
  /** Event snapshot of the live session (its agent's session.snapshotEvents()). */
  getLiveEvents(): readonly SessionEvent[] | undefined
  /** Copy target: a plain editor setText (never submitted). */
  copyToEditor(text: string): void
  /**
   * Show the fork-at-turn confirmation over the open browser; resolves true
   * = fork now. `turnLabel` is the selected turn's number (as displayed),
   * `totalTurns` the session's listed turn count; `cold` is true when the
   * browsed session is not the live one — the fork then detaches the LIVE
   * session, and the dialog must say so instead of hiding it.
   */
  confirmForkAtTurn(turnLabel: string, totalTurns: number, cold: boolean): Promise<boolean>
  /**
   * Fork-and-switch at the turn boundary: start a new session on the CURRENT
   * preset selection seeded with `seed` (the browsed session's prefix), and
   * switch to it. Resolves when the new session is live; a rejection leaves
   * every existing binding untouched (the browser stays open).
   */
  forkAtTurn(seed: readonly SessionEvent[], parentSessionId: string): Promise<unknown>
  /** Buffered channel for fork failures (a transcript notice). */
  reportError(message: string): void
  restoreFocus(): void
  requestRender(): void
}

/** Events + provenance of one browsed session. */
interface LoadedSession {
  sessionId: string
  live: boolean
  events: readonly SessionEvent[]
}

/**
 * Read one session's events: the live snapshot when the id IS the live
 * session (fresher than any stored copy, and no persistence round-trip),
 otherwise a cold read through `sessionPersistence.inspect` — the host
 * decompresses, no writer lock, no resume, no agent activation.
 */
async function loadSessionEvents(deps: HistoryBrowserDeps, id: string): Promise<LoadedSession> {
  if (deps.getSessionId() === id) {
    const events = deps.getLiveEvents()
    if (events !== undefined) return { sessionId: id, live: true, events }
  }
  const { events } = await inspectPersistedSession(deps.ctx, SessionId(id))
  return { sessionId: id, live: false, events }
}

/**
 * The user-facing failure line for a failed session load. Corrupt logs get
 * the ⚠ + repair pointer (the /resume vocabulary — repair itself is an
 * agent-side flow and stays out of this read-only browser).
 */
export function historyLoadErrorMessage(id: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const short = clipToWidth(id, 8)
  if (isCorruptLogError(message)) {
    return `⚠ ${short}: corrupt session log — /resume ${short} offers a repair.`
  }
  return `Cannot read ${short}: ${message}`
}

/** One row of the `s` session picker (the /resume picker's vocabulary). */
export interface SessionPickRow {
  id: string
  updated: string
  dir: string
  session: string
}

/**
 * Case-insensitive substring filter over the picker's display vocabulary:
 * the session title (preview/label, the ⚠ and ● markers included), the
 * directory, and the raw session id (paste-an-id narrowing). Empty query
 * matches everything, order preserved. Pure; exported for tests.
 */
export function filterSessionPickRows(rows: readonly SessionPickRow[], query: string): SessionPickRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...rows]
  return rows.filter(row =>
    row.session.toLowerCase().includes(needle)
    || row.dir.toLowerCase().includes(needle)
    || row.id.toLowerCase().includes(needle),
  )
}

/**
 * The `s` picker rows: every resumable session (isResumableSessionHeader —
 * subagent children excluded), ordered by last update (log mtime, falling
 * back to createdAt), the most recent ones enriched with first-message
 * previews and the ⚠ corrupt marker (the shared loadSessionPreviews — zero
 * extra IO beyond the preview inspects). The browsed session carries a `●`
 * marker. Deliberately NOT narrowed by the /resume display window
 * (`dsh-tui.resume.*` age/size knobs): that filter shapes what is worth
 * RESUMING, while a look-back browser may read any stored log.
 */
async function buildSessionPickRows(ctx: Context, currentId: string | undefined): Promise<SessionPickRow[]> {
  const persistence = ctx.get('sessionPersistence') as SessionPersistence | undefined
  if (persistence === undefined) {
    throw new Error('Session persistence is not configured in this profile.')
  }
  const headers: SessionHeader[] = (await persistence.list()).filter(isResumableSessionHeader)
  const lastUpdates = await loadSessionLastUpdates()
  const ordered = sortSessionsByLastUpdate(headers, lastUpdates)
  const { previews, corruptIds } = await loadSessionPreviews(
    persistence,
    ordered.slice(0, PREVIEW_SESSION_CAP).map(header => header.id),
  )
  return ordered.map(header => {
    const id = String(header.id)
    const updated = lastUpdates.get(id)?.mtimeMs ?? header.createdAt
    const title = resumeRowTitle(header, previews.get(id), corruptIds.has(id))
    return {
      id,
      updated: new Date(updated).toLocaleString(),
      dir: header.cwd ?? 'no cwd',
      session: id === currentId ? `● ${title}` : title,
    }
  })
}

/**
 * The browser overlay root: left TablePanel + right detail pane, arranged
 * side-by-side (≥100 columns) or stacked (narrower), the container chosen
 * per render at the current width. The keyboard stays with the left list
 * (navigation, `/` filter, Enter/`c` copy, `s` session switch, Esc close);
 * `[`/`]` page the detail pane; there is no focus management between panes.
 */
export class HistoryBrowserPanel implements Component {
  private readonly deps: HistoryBrowserDeps
  private readonly host: PanelHost
  // Both reassigned by rebuildListPanel (fresh panel per session switch);
  // the constructor assigns them through it (same pattern as settings.ts).
  private listOptions!: TablePanelOptions<HistoryRow>
  private list!: TablePanel<HistoryRow>
  private readonly detail: TurnDetailPane
  // Re-derived on terminal resize (see render).
  private listMax: number
  private sessionId: string
  private live: boolean
  private turns: HistoryTurn[]
  /** The browsed session's raw events — the fork-at-turn slice source. */
  private events: readonly SessionEvent[]
  private query = ''
  private rows: HistoryRow[]
  private status: string | undefined
  private closed = false
  private pickerLoading = false
  private forkInProgress = false
  /**
   * Where the keyboard lives: the left list (default) or the right detail
   * pane. `→` hands focus to the detail pane, `←`/Esc step back; only the
   * focused pane's keys act (detail focus makes ↑↓ scroll, list keys inert).
   */
  private focus: 'list' | 'detail' = 'list'
  /**
   * The overlay budget the current list panel was built for (and its derived
   * list height): a terminal resize re-derives both — the one explicit
   * external change the fixed-geometry render is allowed to react to.
   */
  private builtBudget: number
  /** Set by openHistoryBrowser; delivers the closing echo text. */
  onFinish: ((text: string) => void) | undefined

  constructor(deps: HistoryBrowserDeps, host: PanelHost, loaded: LoadedSession) {
    this.deps = deps
    this.host = host
    this.sessionId = loaded.sessionId
    this.live = loaded.live
    this.turns = groupHistoryTurns(loaded.events)
    this.events = loaded.events
    this.rows = historyRows(this.turns, '')
    this.listMax = listMaxVisible()
    this.builtBudget = overlayContentBudget()
    this.detail = new TurnDetailPane(deps.theme, deps.requestRender)
    this.detail.setTurn(this.rows[0]?.turn, loaded.live, loaded.sessionId)
    this.rebuildListPanel(historyListTitle(loaded.sessionId, loaded.live), this.rows[0]?.turn)
  }

  /**
   * (Re)build the left TablePanel over the current rows — the subagent
   * viewer's swap-the-panel pattern. Columns refit against the live rows
   * (autoColumns scans every row), so a session whose turn numbers gain a
   * digit gets a wider TURN column instead of a clipped one; the cursor
   * lands on `preselect` (row 0 of a freshly loaded session). In-place row
   * swaps (`setQuery`) keep using the retained options object.
   */
  private rebuildListPanel(title: string, preselect: HistoryTurn | undefined): void {
    // A mid-typing ENGAGED filter must survive the panel swap (a resize
    // rebuild must not degrade it to a merely applied query): the query is
    // caller-held and already in the rebuilt rows, only the input-mode flag
    // needs carrying over.
    const wasFiltering = this.list?.isFiltering() ?? false
    const columns = autoColumns(
      [
        { key: 'turnLabel', title: 'Turn', cap: 6, align: 'right' },
        { key: 'preview', title: 'Prompt' },
      ],
      this.rows,
      (row, key) => (key === 'preview' ? row.preview : row.turnLabel),
    )
    this.listOptions = {
      title,
      columns,
      rows: this.rows,
      renderCell: (row, column) => (column.key === 'preview' ? row.preview : row.turnLabel),
      maxVisible: this.listMax,
      footer: HISTORY_FOOTER,
      emptyHint: 'No completed turns',
      // Focus visualization: the focused list shows the ▸ cursor; while the
      // detail pane owns the keyboard the cursor demotes to `›` (the list is
      // still visible, just not keyed).
      marker: selected => selected ? (this.focus === 'detail' ? '› ' : '▸ ') : '  ',
      onSelect: row => this.copyTurn(row.turn),
      onCancel: () => this.finish('History closed.'),
      shortcuts: {
        c: () => this.copySelected(),
        s: () => { void this.openSessionPicker() },
        // Fork at the selected turn (confirmed in a dialog over the browser).
        f: () => { void this.forkAtSelectedTurn() },
        // Detail paging rides the list's shortcut map: the TablePanel checks
        // shortcuts only OUTSIDE filter-input mode (the engaged input returns
        // before the shortcut lookup), so `[`/`]` type into the query while
        // the filter is engaged and page the detail pane otherwise.
        '[': () => this.detail.scrollByPage(-1),
        ']': () => this.detail.scrollByPage(1),
      },
      filter: {
        getQuery: () => this.query,
        onQueryChange: next => this.setQuery(next),
      },
      status: () => this.status,
    }
    this.list = new TablePanel<HistoryRow>(this.deps.theme, this.listOptions)
    if (wasFiltering) this.list.beginFilterInput()
    const followed = preselect !== undefined && this.list.focusRow(row => row.turn === preselect)
    if (!followed) this.list.resyncCursor()
  }

  invalidate(): void {
    this.list.invalidate()
    this.detail.invalidate()
  }

  render(width: number): string[] {
    // Fixed geometry: the window is ALWAYS exactly `overlayContentBudget()`
    // lines — short content pads with blank rows, long content is capped by
    // the inner scroll windows. A terminal resize (the one external change
    // this is allowed to react to) re-derives the budget and the list height;
    // the current selection rides across the rebuild.
    const budget = overlayContentBudget()
    const listMax = listMaxVisible()
    if (budget !== this.builtBudget || listMax !== this.listMax) {
      this.builtBudget = budget
      this.listMax = listMax
      this.rebuildListPanel(historyListTitle(this.sessionId, this.live), this.list.selectedRow()?.turn)
    }
    let lines: string[]
    if (width >= DUAL_PANE_MIN_COLUMNS) {
      const leftWidth = Math.max(LEFT_PANE_MIN_COLUMNS, Math.floor(width * 0.4))
      this.detail.basisRows = undefined
      const stack = new HStack([
        // basis (columns) fixed at ~40%, shrinkable to the 30-column floor;
        // the detail pane grows into the remainder. Both panes render inside
        // the same fixed height (detail = budget, list ≤ budget).
        { component: this.list, basis: leftWidth, shrink: 1, minSize: LEFT_PANE_MIN_COLUMNS },
        { component: this.detail, basis: 0, grow: 1, minSize: 16 },
      ])
      lines = stack.render(width)
    } else {
      // Stacked: the list keeps its intrinsic height; the detail pane gets
      // what remains of the budget (the +2 is the filter-line and status-line
      // headroom — both can co-display with results, see listMaxVisible).
      this.detail.basisRows = Math.max(4, budget - (7 + this.listMax + 2))
      const stack = new VStack([
        { component: this.list, basis: 'auto', grow: 0, shrink: 0 },
        { component: this.detail, basis: this.detail.basisRows, grow: 0, shrink: 0 },
      ])
      lines = stack.render(width)
    }
    if (lines.length > budget) return lines.slice(0, budget)
    while (lines.length < budget) lines.push('')
    return lines
  }

  handleInput(data: string): void {
    if (this.closed) return
    const kb = getKeybindings()
    if (this.focus === 'detail') {
      // The right pane owns the keyboard: scroll keys act, the exit keys
      // (`←`/Esc) step back to the list, everything else — `/`, `c`, `s`,
      // Enter — is deliberately inert.
      if (kb.matches(data, 'tui.select.cancel') || matchesKey(data, 'left')) {
        this.setFocus('list')
        return
      }
      if (kb.matches(data, 'tui.select.up')) { this.detail.scrollByLines(-1); return }
      if (kb.matches(data, 'tui.select.down')) { this.detail.scrollByLines(1); return }
      if (kb.matches(data, 'tui.select.pageUp') || data === '[') { this.detail.scrollByPage(-1); return }
      if (kb.matches(data, 'tui.select.pageDown') || data === ']') { this.detail.scrollByPage(1); return }
      // The selection is the same whichever pane is keyed: `f` forks at it
      // from the detail focus too.
      if (data === 'f') { void this.forkAtSelectedTurn(); return }
      return
    }
    // List focus: `→` hands focus to the detail pane — except while the
    // filter input owns the keyboard, where an arrow must not yank focus
    // mid-typing (the TablePanel ignores arrows there either way).
    if (!this.list.isFiltering() && matchesKey(data, 'right')) {
      this.setFocus('detail')
      return
    }
    const before = this.list.selectedRow()?.turn
    // The list owns the keyboard: navigation, the `/` filter (which consumes
    // printable keys while engaged — `c`/`s`/`[`/`]` included), shortcuts,
    // Enter (copy) and Esc (filter-clear-then-close grading is the
    // TablePanel's). Selection changes rebuild the detail pane right here —
    // an explicit action, never the render path.
    this.list.handleInput(data)
    const selected = this.list.selectedRow()
    if (selected !== undefined && selected.turn !== before) {
      this.detail.setTurn(selected.turn, this.live, this.sessionId)
    }
  }

  /** Move the keyboard between the two panes and refresh the focus visuals. */
  private setFocus(focus: 'list' | 'detail'): void {
    if (this.focus === focus) return
    this.focus = focus
    this.detail.setFocused(focus === 'detail')
    this.deps.requestRender()
  }

  /** Close the overlay and deliver the closing echo text (once). */
  private finish(text: string): void {
    if (this.closed) return
    this.closed = true
    this.host.close()
    this.deps.restoreFocus()
    this.onFinish?.(text)
  }

  /** Refill the editor with the turn's user prompt and close (never submit). */
  private copyTurn(turn: HistoryTurn): void {
    // undefined for turns without a human prompt (injected-only turns must
    // not land in the editor — one Enter would submit a notice as a prompt).
    const text = turnPrimaryUserText(turn)
    if (text === undefined || text === '') {
      this.status = 'Nothing to copy — the turn has no user prompt.'
      this.deps.requestRender()
      return
    }
    this.deps.copyToEditor(text)
    this.finish('Prompt copied to the editor.')
  }

  private copySelected(): void {
    const row = this.list.selectedRow()
    if (row !== undefined) this.copyTurn(row.turn)
  }

  /** Swap the browsed session; failures surface on the browser's status line. */
  private async loadAndShow(id: string): Promise<void> {
    let loaded: LoadedSession
    try {
      loaded = await loadSessionEvents(this.deps, id)
    } catch (error) {
      // The browser may have been closed while the load was in flight (Esc
      // out of the picker during a slow cold read). Reopening a closed panel
      // would resurrect a dead overlay that finish() can no longer close.
      if (this.closed) return
      // The picker was the mounted overlay and has no status row of its own —
      // return to the browser (the flow's home surface; PanelHost shows the
      // new panel before hiding the old one) so the failure is actually seen.
      this.status = historyLoadErrorMessage(id, error)
      this.host.open(this, '90%', '85%')
      return
    }
    if (this.closed) return
    this.sessionId = loaded.sessionId
    this.live = loaded.live
    this.turns = groupHistoryTurns(loaded.events)
    this.events = loaded.events
    this.query = ''
    this.status = undefined
    this.rows = historyRows(this.turns, '')
    // A fresh TablePanel per session: the auto-fitted TURN column re-measures
    // against the new rows (a session with 3-digit turn numbers must not keep
    // a 1-digit-wide column) and the cursor starts at row 0.
    this.rebuildListPanel(historyListTitle(loaded.sessionId, loaded.live), this.rows[0]?.turn)
    this.detail.setTurn(this.list.selectedRow()?.turn, loaded.live, loaded.sessionId)
    // Show the (re)built browser before the host hides the picker — the
    // PanelHost show-new-then-hide-old contract, no focus flash.
    this.host.open(this, '90%', '85%')
  }

  /**
   * Build the `s` session picker over prepared rows. Public so tests can
   * drive the real panel (it mounts as its own overlay through the
   * PanelHost). The filter is the same caller-held-query contract as the
   * main list: `/` engages the input, every keystroke rebuilds the rows
   * (case-insensitive substring over session title, directory and session
   * id — `filterSessionPickRows`) with the cursor following its session
   * across the rebuild, Esc clears the query before popping. The query is
   * picker-local — reset on every `s` (CONTEXT.md "Filter").
   */
  buildSessionPickerPanel(rows: readonly SessionPickRow[]): TablePanel<SessionPickRow> {
    let query = ''
    const columns = autoColumns(
      [
        { key: 'updated', title: 'Updated', cap: 26 },
        // Same cap as the /resume picker's DIR column.
        { key: 'dir', title: 'Dir', cap: RESUME_DIR_CAP },
        { key: 'session', title: 'Session' },
      ],
      rows,
      (row, key) => row[key as 'updated' | 'dir' | 'session'],
    )
    let picker: TablePanel<SessionPickRow>
    const options: TablePanelOptions<SessionPickRow> = {
      title: '● Browse session',
      columns,
      rows: [...rows],
      renderCell: (row, column) => row[column.key as 'updated' | 'dir' | 'session'],
      footer: '↑↓ navigate · Enter browse · / filter · Esc back',
      maxVisible: listMaxVisible(),
      emptyHint: 'No matching sessions',
      onSelect: row => { void this.loadAndShow(row.id) },
      onCancel: () => {
        // Back to the browser: show it, then the host hides the picker. (A
        // closed browser must not be resurrected — nothing to do.)
        if (!this.closed) this.host.open(this, '90%', '85%')
      },
      filter: {
        getQuery: () => query,
        onQueryChange: next => {
          query = next
          const current = picker.selectedRow()?.id
          options.rows = filterSessionPickRows(rows, query)
          const followed = current !== undefined && picker.focusRow(row => row.id === current)
          if (!followed) picker.resyncCursor()
        },
      },
    }
    picker = new TablePanel<SessionPickRow>(this.deps.theme, options)
    return picker
  }

  /**
   * Fork at the selected turn (`f`): confirm over the open browser, then
   * hand the turn-bounded seed to the fork-and-switch seam. The browsed
   * session's events are the slice source — live snapshots and cold-read
   * (`inspect`) events fork alike. Cancel or an empty slice (nothing
   * completed to carry) changes nothing; a failed fork keeps the browser
   * open with the failure on the status line plus a buffered notice.
   */
  private async forkAtSelectedTurn(): Promise<void> {
    if (this.closed || this.forkInProgress) return
    const row = this.list.selectedRow()
    if (row === undefined) return
    const seed = turnSeedSlice(this.events, row.turn)
    if (seed.length === 0) return
    this.forkInProgress = true
    try {
      const outcome = await this.deps.confirmForkAtTurn(row.turnLabel, this.turns.length, !this.live)
      if (outcome !== true) return
      await this.deps.forkAtTurn(seed, this.sessionId)
      this.finish(`Forked at turn ${row.turnLabel} — new session opened.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.status = `Fork failed: ${message}`
      this.deps.reportError(`Fork at turn ${row.turnLabel} failed: ${message}`)
      this.deps.requestRender()
    } finally {
      this.forkInProgress = false
    }
  }

  /** Open the session picker overlay (the browser stays mounted underneath). */
  private async openSessionPicker(): Promise<void> {
    if (this.pickerLoading || this.closed) return
    this.pickerLoading = true
    let rows: SessionPickRow[]
    try {
      rows = await buildSessionPickRows(this.deps.ctx, this.sessionId)
    } catch (error) {
      this.pickerLoading = false
      this.status = historyLoadErrorMessage(this.sessionId, error)
      this.deps.requestRender()
      return
    }
    this.pickerLoading = false
    if (this.closed) return
    if (rows.length === 0) {
      this.status = 'No stored sessions to browse.'
      this.deps.requestRender()
      return
    }
    this.host.open(this.buildSessionPickerPanel(rows), '80%', '95%')
  }

  /** Live query swap: rebuild rows, keep the cursor on its turn when visible. */
  private setQuery(query: string): void {
    this.query = query
    const current = this.list.selectedRow()?.turn
    this.rows = historyRows(this.turns, query)
    this.listOptions.rows = this.rows
    const followed = current !== undefined && this.list.focusRow(row => row.turn === current)
    if (!followed) this.list.resyncCursor()
  }
}

/** Outcome text of the /history command (the command echo line). */
export interface HistoryOpenResult {
  text: string
  error: boolean
}

/**
 * Open the history browser. `sessionIdArg` (from `/history <sessionId>`)
 * cold-reads that session; without one the CURRENT live session is browsed
 * and, when none exists, a hint line is returned instead. Resolves with the
 * closing echo text once the overlay closes (Esc, or copy-to-editor).
 */
export async function openHistoryBrowser(
  deps: HistoryBrowserDeps,
  sessionIdArg: string | undefined,
): Promise<HistoryOpenResult> {
  const target = sessionIdArg ?? deps.getSessionId()
  if (target === undefined || target === '') {
    return {
      text: 'No active session — use /history <sessionId> to browse a stored one.',
      error: true,
    }
  }
  let loaded: LoadedSession
  try {
    loaded = await loadSessionEvents(deps, target)
  } catch (error) {
    return { text: historyLoadErrorMessage(target, error), error: true }
  }
  return new Promise<HistoryOpenResult>(resolve => {
    const host = new PanelHost(deps.tui, deps.theme, () => {
      // A half-mounted overlay must not strand the keyboard — and the caller
      // gets the truth: this is a mount failure, not a quiet close. (Promise
      // resolution is idempotent, so a later finish/onFinish is a no-op.)
      deps.restoreFocus()
      resolve({ text: 'Failed to open the history viewer.', error: true })
    })
    const panel = new HistoryBrowserPanel(deps, host, loaded)
    panel.onFinish = text => resolve({ text, error: false })
    const handle = host.open(panel, '90%', '85%')
    if (handle === undefined) {
      // host.open already ran the error path above (focus restored + resolve).
      resolve({ text: 'Failed to open the history viewer.', error: true })
    }
  })
}
