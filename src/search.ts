/**
 * Cross-session full-text search (/search, Ctrl+Shift+F) over the base
 * `sessionQuery` service's FTS5 index — the terminal counterpart of the
 * web sidebar's content search, wrapped the same way ApiSessionList
 * searches: user/assistant messages only, current surface, one row per
 * session ranked by its best match. Enter resumes the picked session
 * through the caller (the same /resume path); `n` pages deeper with the
 * continuation cursor.
 *
 * The index itself is enabled by this bundle's cordis.patch.yml override
 * of the stock session-query-sqlite row (durable file, openAt
 * first-search — no boot cost). Without it the service refuses search
 * with SESSION_QUERY_SEARCH_DISABLED; this panel maps that to an upgrade
 * hint instead of a raw stack string.
 *
 * Pure row building at the top (unit-testable); the panel is PanelHost
 * glue + EditField query → results table, exercised on a terminal.
 */

import type { Context } from '@deepseek-ai/cordis'
import { type Component, type TUI } from '@earendil-works/pi-tui'
import { t } from './i18n/index.ts'
import { EditField } from './settings.ts'
import { autoColumns, PanelHost, TablePanel, type TablePanelOptions } from './panels.ts'
import type { TuiTheme } from './theme/index.ts'
import { isResumableSessionHeader } from './sessions.ts'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

/**
 * Structural face of the sessionQuery service's search surface. Kept local
 * (not imported from dsh-session-query) so this file typechecks against
 * any host closure.
 */
export interface SessionQuerySearchSeam {
  searchSessions(request: {
    query: string
    eventFilters?: ReadonlyArray<{ kind: 'type' | 'surface'; values: readonly string[] }>
    limit?: number
    cursor?: string
  }): Promise<{
    items: ReadonlyArray<{
      header: SessionHeader
      live: boolean
      persisted: boolean
      bestMatch: { snippet: string; time?: number; type?: string; surface?: string }
    }>
    nextCursor?: string
  }>
  readTitleSnapshots?(sessionIds: readonly string[]): Promise<
    ReadonlyArray<{ session: SessionHeader; title?: string }>
  >
}

/** How deep one query pages before the user must press `n` again. */
const SEARCH_PAGE_LIMIT = 20

/** Maximum snippet characters shown in a row (the service caps at 240). */
const SNIPPET_MAX_CHARS = 160

/** Collapse a snippet to one display line: newlines/tabs to spaces, capped. */
export function normalizeSnippet(text: string, maxChars = SNIPPET_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`
}

/** Short directory label of a session cwd (the path tail). */
export function dirLabel(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return ''
  const parts = cwd.split(/[/\\]/).filter(part => part !== '')
  return parts.length === 0 ? cwd : parts[parts.length - 1]!
}

/** One rendered result row. */
export interface SearchHitRow {
  sessionId: string
  /** Title snapshot when known; the id tail otherwise. */
  title: string
  /** Best-match excerpt, single line. */
  snippet: string
  /** Locale-formatted date of the matched event (fallback: created). */
  when: string
  /** Directory name of the session cwd. */
  dir: string
  header: SessionHeader
}

/** Date label of a hit: the matched event's time, else the header creation. */
function whenLabel(time: number | undefined, createdAt: number | undefined): string {
  const ms = time ?? createdAt
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return ''
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const base = sameYear ? `${month}-${day}` : `${String(date.getFullYear())}-${month}-${day}`
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${base} ${hours}:${minutes}`
}

/**
 * Build result rows from raw hits: subagent children drop out (resuming
 * one would misplace the recursion budget — the /resume picker's rule),
 * titles resolve through the snapshot batch (one service call for the
 * whole page), snippets flatten to one line.
 */
export function buildSearchHitRows(
  hits: ReadonlyArray<{
    header: SessionHeader
    bestMatch: { snippet: string; time?: number; type?: string; surface?: string }
  }>,
  titles: ReadonlyMap<string, string>,
): SearchHitRow[] {
  const rows: SearchHitRow[] = []
  for (const hit of hits) {
    if (!isResumableSessionHeader(hit.header)) continue
    const id = String(hit.header.id)
    const title = titles.get(id)
    rows.push({
      sessionId: id,
      title: title !== undefined && title !== ''
        ? title
        : clipId(id),
      snippet: normalizeSnippet(hit.bestMatch.snippet),
      when: whenLabel(hit.bestMatch.time, hit.header.createdAt),
      dir: dirLabel(hit.header.cwd),
      header: hit.header,
    })
  }
  return rows
}

/** Last path-ish segment of a session id (uuid tail). */
function clipId(id: string): string {
  const tail = id.split('-').pop() ?? id
  return tail.length > 8 ? tail.slice(0, 8) : tail
}

// ---------------------------------------------------------------- the panel --

/** Options for the search overlay entry point. */
export interface OpenSearchOverlayOptions {
  ctx: Context
  tui: TUI
  theme: TuiTheme
  restoreFocus: () => void
}

/**
 * The search flow: an EditField query, then a filterable results table.
 * Resolves the picked session id (Enter on a hit — the caller routes it
 * through the /resume path), or undefined when dismissed.
 */
class SearchPanel implements Component {
  private readonly tui: TUI
  private readonly theme: TuiTheme
  private readonly seam: SessionQuerySearchSeam
  private readonly onPick: (sessionId: string) => void
  private readonly onExit: () => void
  /** Active child: the query editor or the results table. */
  private child: Component
  private query = ''
  private cursor: string | undefined
  private rows: SearchHitRow[] = []
  private tableOptions: TablePanelOptions<SearchHitRow>
  private table: TablePanel<SearchHitRow>
  /** Status line while indexing/searching or on failure. */
  private status: string | undefined
  private busy = false
  private readonly rerender = (): void => { this.tui.requestRender() }

  constructor(options: OpenSearchOverlayOptions & {
    seam: SessionQuerySearchSeam
    onPick: (sessionId: string) => void
    onExit: () => void
  }) {
    this.tui = options.tui
    this.theme = options.theme
    this.seam = options.seam
    this.onPick = options.onPick
    this.onExit = options.onExit
    this.tableOptions = {
      title: t('search.title.results'),
      columns: [],
      rows: [],
      renderCell: (row, column) => (column.key === 'meta' ? `${row.when} · ${row.dir}` : row.snippet),
      isSelectable: () => true,
      onSelect: row => this.onPick(row.sessionId),
      onCancel: () => this.onExit(),
      footer: t('search.footer.results'),
      status: () => this.status,
      emptyHint: t('search.empty'),
      shortcuts: {
        n: () => { void this.loadMore() },
        q: () => { this.child = this.buildQueryEditor(); this.rerender() },
      },
    }
    this.table = new TablePanel<SearchHitRow>(this.theme, this.tableOptions)
    this.child = this.buildQueryEditor()
  }

  invalidate(): void {
    this.child.invalidate()
  }

  render(width: number): string[] {
    return this.child.render(width)
  }

  handleInput(data: string): void {
    if (this.busy) return
    this.child.handleInput?.(data)
  }

  /** The initial query editor; a fresh query resets paging state. */
  private buildQueryEditor(): Component {
    return new EditField(this.tui, {
      title: t('search.title.query'),
      subtitle: t('search.query.hint'),
      initial: this.query,
      parse: text => (text.trim() === ''
        ? { kind: 'error' as const, error: t('search.query.empty') }
        : { kind: 'value' as const, value: text.trim() }),
      onCommit: async outcome => {
        if (outcome.kind !== 'value') return undefined
        const query = String(outcome.value)
        // The editor closes immediately; the (possibly slow first) index
        // build carries on against the table's status line.
        void this.runSearch(query)
        this.child = this.table
        return undefined
      },
      onDone: () => {
        // Enter already swapped to the table; Esc exits when nothing is on
        // screen, otherwise falls back to the results.
        if (this.rows.length === 0 && this.status === undefined) this.onExit()
        else {
          this.child = this.table
          this.rerender()
        }
      },
      onError: () => { /* contained: failures land on the status line */ },
    }, this.theme)
  }

  /** First page of a (possibly new) query. */
  private async runSearch(query: string): Promise<void> {
    this.query = query
    this.cursor = undefined
    this.rows = []
    await this.fetchPage(query, undefined)
  }

  /** `n`: fetch the continuation page and append. */
  private async loadMore(): Promise<void> {
    if (this.cursor === undefined || this.query === '') return
    await this.fetchPage(this.query, this.cursor)
  }

  private async fetchPage(query: string, cursor: string | undefined): Promise<void> {
    this.busy = true
    this.status = t('search.status.searching', { query })
    this.rerender()
    try {
      const page = await this.seam.searchSessions({
        query,
        // The ApiSessionList.search wrapper's filters: message content
        // only, the current surface — shadowed branches and log-only
        // events never surface as hits.
        eventFilters: [
          { kind: 'type', values: ['user/message', 'assistant/message'] },
          { kind: 'surface', values: ['current'] },
        ],
        limit: SEARCH_PAGE_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      this.cursor = page.nextCursor
      const titles = await this.fetchTitles(page.items.map(hit => String(hit.header.id)))
      const fresh = buildSearchHitRows(page.items, titles)
      const seen = new Set(this.rows.map(row => row.sessionId))
      this.rows = [...this.rows, ...fresh.filter(row => !seen.has(row.sessionId))]
      this.status = this.rows.length === 0
        ? t('search.status.noHits', { query })
        : this.cursor !== undefined
          ? t('search.status.moreAvailable', { count: this.rows.length })
          : undefined
      this.rebuildTable()
      this.child = this.table
    } catch (cause) {
      this.status = searchFailureText(cause)
      // The editor stays reachable: a disabled/failed index is a query-time
      // dead end, not a panel exit.
      if (this.rows.length > 0) this.rebuildTable()
    }
    this.busy = false
    this.rerender()
  }

  /** Title snapshot batch for one page (best-effort: misses stay untitled). */
  private async fetchTitles(ids: readonly string[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>()
    if (this.seam.readTitleSnapshots === undefined || ids.length === 0) return titles
    try {
      for (const snapshot of await this.seam.readTitleSnapshots(ids)) {
        if (snapshot.title !== undefined && snapshot.title !== '') {
          titles.set(String(snapshot.session.id), snapshot.title)
        }
      }
    } catch { /* untitled rows fall back to the id tail */ }
    return titles
  }

  private rebuildTable(): void {
    this.tableOptions.columns = autoColumns(
      [
        { key: 'snippet', title: t('search.col.match'), cap: 56 },
        { key: 'meta', title: t('search.col.meta') },
      ],
      this.rows,
      (row, key) => (key === 'meta' ? `${row.when} · ${row.dir}` : row.snippet),
    )
    this.tableOptions.rows = this.rows
    this.tableOptions.footer = this.cursor !== undefined
      ? t('search.footer.more')
      : t('search.footer.results')
    this.table.resyncCursor()
  }
}

/**
 * Map a search failure to display text: the disabled-index refusal (a
 * deployment without this bundle's session-query override) reads as an
 * upgrade hint, everything else as the raw message.
 */
export function searchFailureText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (cause instanceof Error && /SESSION_QUERY_SEARCH_DISABLED/.test(message)) {
    return t('search.status.disabled')
  }
  return t('search.status.failed', { message })
}

/**
 * Open the cross-session search overlay. Resolves the picked session id,
 * or undefined when dismissed. Focus returns to `restoreFocus` on close;
 * the picked-session resume is the CALLER's job (the /resume path — a
 * search hit must resume exactly like a /resume pick, repair flow and
 * write-lease fallback included). Returns undefined WITHOUT mounting when
 * the sessionQuery service is absent — the caller reports that itself.
 */
export async function openSearchOverlay(options: OpenSearchOverlayOptions): Promise<string | undefined> {
  const seam = options.ctx.get('sessionQuery') as SessionQuerySearchSeam | undefined
  if (seam === undefined || seam.searchSessions === undefined) {
    options.restoreFocus()
    return undefined
  }
  return new Promise(resolve => {
    let settled = false
    const settle = (picked: string | undefined): void => {
      if (settled) return
      settled = true
      host.close()
      options.restoreFocus()
      resolve(picked)
    }
    const host = new PanelHost(options.tui, options.theme, () => {
      options.restoreFocus()
      settle(undefined)
    })
    const panel = new SearchPanel({
      ...options,
      seam,
      onPick: sessionId => settle(sessionId),
      onExit: () => settle(undefined),
    })
    host.open(panel, '80%', '80%')
  })
}
