/**
 * Session TUI overlays: the `/session` info panel and the `/resume`
 * persisted-session picker — terminal counterparts of the web surface's
 * session management. Both speak the shared FW table language (panels.ts):
 * the picker is a TablePanel and the info panel a read-only auto table
 * (autoColumns + booktabs rules), each in a framed overlay with
 * `restoreFocus` on close.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { getKeybindings, type Component, type TUI } from '@earendil-works/pi-tui'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { wrapFramedOverlay } from './frame.ts'
import {
  autoColumns,
  columnWidths,
  MARKER_W,
  padCell,
  panelThemeFns,
  TablePanel,
  tableHeaderLine,
  tableRuleLine,
  TABLE_SEP,
  type TableColumn,
} from './panels.ts'
import { BOLD, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth, visibleWidth } from './text.ts'

// ------------------------------------------------------------- `/session` panel --

/** Everything the `/session` info panel renders (snapshot, built by the caller). */
export interface SessionPanelData {
  id: string | undefined
  cwd: string | undefined
  createdAt: number | undefined
  /** "provider/model", or already including the reasoning effort. */
  model: string | undefined
  effort: string | undefined
  msgCount: number
  toolCallCount: number
  /** Per-route-segment totals (reset when the provider/model route changes) — see the panel title note. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  status: 'idle' | 'running' | 'none'
  eventCount: number | undefined
  parentSession: string | undefined
}

/** Fit cap for the FIELD column (the longest label is "cache read/write"). */
const FIELD_CAP = 12

/**
 * The `/session` key-value rows, in display order — pure so the panel's data
 * contract stays unit-testable. Values are PLAIN text: the panel clips/pads
 * them through the shared FW table helpers and paints afterwards.
 */
export function sessionInfoRows(data: SessionPanelData): ReadonlyArray<{ field: string; value: string }> {
  return [
    { field: 'session', value: data.id ?? '—' },
    { field: 'cwd', value: data.cwd ?? '—' },
    { field: 'created', value: data.createdAt === undefined ? '—' : new Date(data.createdAt).toLocaleString() },
    { field: 'model', value: data.model ?? '—' },
    { field: 'think', value: data.effort ?? '—' },
    { field: 'status', value: data.status },
    { field: 'messages', value: String(data.msgCount) },
    { field: 'tool calls', value: String(data.toolCallCount) },
    { field: 'tokens in', value: String(data.inputTokens) },
    { field: 'tokens out', value: String(data.outputTokens) },
    { field: 'cache read', value: String(data.cacheReadTokens) },
    { field: 'cache write', value: String(data.cacheWriteTokens) },
    { field: 'events', value: data.eventCount === undefined ? '—' : String(data.eventCount) },
    // Same short form the /resume rows use — a parent id is a pointer, not
    // something to read in full.
    { field: 'parent', value: data.parentSession === undefined ? '—' : clipToWidth(data.parentSession, 8) },
  ]
}

/**
 * One-shot read-only info panel in the shared FW auto-table style: FIELD
 * fits its content, VALUE runs to the right edge and clips (never wraps),
 * width-exact padded cells under the booktabs rule trio — the same table
 * language as the /resume picker and every other panel. Esc/Enter hides the
 * overlay and resolves.
 */
export class SessionInfoPanel implements Component {
  private readonly theme: TuiTheme
  private readonly data: SessionPanelData
  private readonly onClose: () => void

  constructor(theme: TuiTheme, data: SessionPanelData, onClose: () => void) {
    this.theme = theme
    this.data = data
    this.onClose = onClose
  }

  invalidate(): void {}

  render(width: number): string[] {
    // Scope note rides on the title line (no extra row: the panel must stay
    // at 20 rows so the framed overlay keeps its bottom border on a 24-row
    // terminal). The token totals are per provider/model route segment — they
    // reset on a route change — while messages/events are session-wide.
    const fns = panelThemeFns(this.theme)
    const lines: string[] = [fns.accent(BOLD + clipToWidth('ⓘ session · tokens: current route', width) + RESET)]
    if (this.data.id === undefined) {
      lines.push('')
      lines.push(fns.muted(clipToWidth('no active session — send a prompt or /resume one', width)))
      lines.push('')
      lines.push(fns.subtle(clipToWidth('Esc to close', width)))
      return lines
    }

    // Auto layout: FIELD fits its content (capped), VALUE is flex — it takes
    // the remainder and clips, so long values (cwd, full session id) never wrap.
    const rows = sessionInfoRows(this.data)
    const columns = autoColumns(
      [
        { key: 'field', title: 'Field', cap: FIELD_CAP },
        { key: 'value', title: 'Value' },
      ],
      rows,
      (row, key) => (key === 'value' ? row.value : row.field),
    )
    const widths = columnWidths(width - MARKER_W, columns)

    // The booktabs trio seals the table right under the title (no gap row):
    // TOP ┬ / header / MID ┼ / rows / BOTTOM ┴. Total height stays at 20 rows
    // so the framed overlay keeps its bottom border on a 24-row terminal.
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┬'), width)))
    lines.push(fns.subtle(clipToWidth(tableHeaderLine(columns, widths), width)))
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┼'), width)))
    for (const row of rows) {
      // Clip plain text BEFORE applying ANSI (iron rule 3). The flex column
      // is additionally clamped to the space actually left on the row (the
      // MIN_FLEX_WIDTH floor can push the layout past `width` on narrow
      // terminals), so the painted line never needs a second clip — cutting
      // ANSI-carrying text would leave a dangling SGR fragment behind.
      const fieldCell = padCell(row.field, widths[0]!)
      const remaining = width - MARKER_W - visibleWidth(TABLE_SEP) - visibleWidth(fieldCell)
      const valueCell = padCell(row.value, Math.min(widths[1]!, Math.max(remaining, 0)))
      const paintedValue = row.field === 'status' && this.data.status === 'running'
        ? fns.accent(valueCell)
        : fns.muted(valueCell)
      lines.push(`${' '.repeat(MARKER_W)}${fieldCell}${TABLE_SEP}${paintedValue}`)
    }
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┴'), width)))
    lines.push(fns.subtle(clipToWidth('Esc to close', width)))
    return lines
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, 'tui.select.cancel') || getKeybindings().matches(data, 'tui.select.confirm')) {
      this.onClose()
    }
  }
}

/**
 * Open the `/session` info panel; resolves when the user closes it. Focus
 * returns to `restoreFocus` on close — it must re-focus the CURRENT editor
 * instance, which may have been rebuilt under a theme hot-swap while the
 * panel was open (pi-tui's hide would otherwise restore focus to the stale
 * pre-overlay editor and swallow subsequent input).
 */
export async function showSessionInfo(
  tui: TUI,
  theme: TuiTheme,
  data: SessionPanelData,
  restoreFocus: () => void,
): Promise<void> {
  await new Promise<void>(resolve => {
    const panel = new SessionInfoPanel(theme, data, () => {
      overlay.hide()
      restoreFocus()
      resolve()
    })
    // maxHeight only ever slices (never stretches), and the framed overlay
    // needs 4 extra rows for its borders: cap high so the bottom border
    // survives on small terminals (24 rows: 20 panel rows + 4 frame rows).
    const overlay = tui.showOverlay(wrapFramedOverlay(theme, panel), { width: '70%', maxHeight: '100%' })
  })
}

// ------------------------------------------------------------- `/resume` picker --
// Each row is labelled with the session's first-message preview (the first
// direct human prompt) so sessions are distinguishable without opening them;
// fallback rows show the header label (cwd basename · short id).

/** The `sessionPersistence` service surface we use (registered by the profile). */
interface SessionPersistence {
  /** Lightweight read of persisted session metadata (headers only). */
  list(signal?: AbortSignal): Promise<SessionHeader[]>
  /** Full event log of one persisted session (damaged tails repaired on load). */
  inspect(id: SessionId, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>
}

/**
 * How many of the most recent candidates get a first-message preview before
 * the picker opens. Older sessions fall back to the header label, so the
 * picker stays fast even with a long history.
 */
const PREVIEW_SESSION_CAP = 30

/** Concurrent `inspect` calls while enriching previews. */
const PREVIEW_CONCURRENCY = 6

/**
 * The jsonl persistence root guess: `$DSH_SESSION_ROOT`, else
 * `$DSH_HOME/sessions`, else `~/.dsh/sessions` — the dsh CLI convention. Only
 * used for the mtime-based last-update enrichment; a mismatched root simply
 * leaves the picker sorted by `createdAt` (the pre-existing behavior).
 */
function sessionLogRoot(): string {
  if (process.env.DSH_SESSION_ROOT !== undefined && process.env.DSH_SESSION_ROOT !== '') {
    return process.env.DSH_SESSION_ROOT
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** Physical log file names the jsonl backend writes (`logSuffix`). */
const LOG_FILE_NAMES = ['session.jsonl', 'session.jsonl.zstd'] as const

/**
 * Best-effort session-id → last-write time map from the jsonl store's file
 * mtimes: one walk of `<root>/<project>/<session>/session.jsonl[.zstd]`, stat
 * per log. Session directory names are the path-encoded session ids — UUID
 * ids encode to themselves, so the common case matches by name; an encoded
 * mismatch just misses the map and falls back to `createdAt`. Any failure
 * resolves an empty map (the picker degrades to creation-order sorting).
 */
export async function loadSessionLastUpdates(root: string = sessionLogRoot()): Promise<Map<string, number>> {
  const updates = new Map<string, number>()
  let projects: string[]
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return updates
  }
  for (const project of projects) {
    let sessionDirs: string[]
    try {
      sessionDirs = (await readdir(join(root, project), { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      continue
    }
    for (const dir of sessionDirs) {
      for (const name of LOG_FILE_NAMES) {
        try {
          const info = await stat(join(root, project, dir, name))
          if (info.mtimeMs > 0) updates.set(dir, info.mtimeMs)
          break
        } catch {
          // Not this suffix — try the next one.
        }
      }
    }
  }
  return updates
}

/**
 * Order resumable candidates by LAST update (newest first): the mtime map
 * when a log file is known, else the header's `createdAt`. Ties fall back to
 * `createdAt` then the id, so the order is deterministic. Pure — the mtime
 * walk lives in `loadSessionLastUpdates`.
 */
export function sortSessionsByLastUpdate(
  headers: readonly SessionHeader[],
  lastUpdates: ReadonlyMap<string, number>,
): SessionHeader[] {
  return headers.slice().sort((a, b) => {
    const at = lastUpdates.get(String(a.id)) ?? a.createdAt
    const bt = lastUpdates.get(String(b.id)) ?? b.createdAt
    if (bt !== at) return bt - at
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
    return String(b.id).localeCompare(String(a.id))
  })
}

/** Hard character cap for a preview string; the list column clips it further. */
const PREVIEW_MAX_CHARS = 140

/** Join the text blocks of a message's content into one trimmed string. */
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

/**
 * The session's "first sentence": the first direct human prompt, falling
 * back to the first non-injected user-role text (goal/cron/recall prompts),
 * then the first assistant message. Synthetic context injects (workspace
 * instructions, runtime reminders) are skipped entirely — they precede the
 * first real prompt and read as noise.
 */
export function previewOfEvents(events: readonly SessionEvent[]): string | undefined {
  let fallbackUser: string | undefined
  let fallbackAssistant: string | undefined
  for (const event of events) {
    if (event.type === 'user/message') {
      const message = event.data as { role?: string; source?: { kind?: string }; content?: unknown }
      const text = textOfContent(message?.content)
      if (!text) continue
      const kind = message?.source?.kind
      if (kind === 'user') return text
      if (kind === 'tool' || kind === 'plugin' || kind === 'agent-instructions') continue
      if (fallbackUser === undefined) fallbackUser = text
    } else if (event.type === 'assistant/message') {
      const message = (event.data as { message?: { content?: unknown } }).message
      const text = textOfContent(message?.content)
      if (text && fallbackAssistant === undefined) fallbackAssistant = text
    }
  }
  return fallbackUser ?? fallbackAssistant
}

/** Collapse control chars/whitespace and clip a raw message into a one-line preview. */
export function normalizePreview(text: string, maxChars = PREVIEW_MAX_CHARS): string {
  const oneLine = text.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars)}…`
}

/** Best-effort first-message preview per session id; failures map to undefined. */
async function loadSessionPreviews(
  persistence: SessionPersistence,
  ids: readonly SessionId[],
): Promise<Map<string, string | undefined>> {
  const previews = new Map<string, string | undefined>()
  let cursor = 0
  const workers = Array.from({ length: Math.min(PREVIEW_CONCURRENCY, ids.length) }, async () => {
    while (cursor < ids.length) {
      const index = cursor++
      const id = ids[index]
      let preview: string | undefined
      try {
        const { events } = await persistence.inspect(id)
        const text = previewOfEvents(events)
        if (text) preview = normalizePreview(text)
      } catch {
        preview = undefined
      }
      previews.set(String(id), preview)
    }
  })
  await Promise.all(workers)
  return previews
}

/**
 * Validate one persisted session's log without publishing it — the /resume
 * pre-check: a corrupt target must be rejected BEFORE the current live agent
 * is torn down. Throws when persistence is missing or the log fails to load.
 */
export async function inspectPersistedSession(
  ctx: Context,
  id: SessionId,
): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }> {
  const persistence = ctx.get('sessionPersistence') as SessionPersistence | undefined
  if (persistence === undefined) {
    throw new Error('Session persistence is not configured in this profile.')
  }
  return await persistence.inspect(id)
}

/** Outcome of the `/resume` picker, so the caller can phrase its reply. */
export type PickSessionResult =
  | { kind: 'empty' }
  | { kind: 'cancelled' }
  | { kind: 'picked'; id: SessionId; header: SessionHeader }

/**
 * Whether a persisted session header may be resumed as this TUI's main
 * conversation. Subagent children — spawn and fork-driven alike, both marked
 * `origin: 'subagent'` + `delegationDepth >= 1` — are excluded: resuming one
 * would misplace it in the recursion budget. Everything else is resumable.
 *
 * The budget test MUST be a value test, not a field-presence test: the jsonl
 * persistence backend writes `delegationDepth: header.delegationDepth ?? 0`
 * and reads it back unconditionally, so EVERY header from
 * `persistence.list()` carries the field — top-level sessions and
 * user-facing `Session.fork` conversations as `0`. A presence test
 * (`=== undefined`) would filter out every persisted session and leave
 * `/resume` with an empty list.
 */
export function isResumableSessionHeader(header: SessionHeader): boolean {
  return header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
}

/**
 * Open the persisted-session picker. Resolves with the picked session,
 * `cancelled` when dismissed, or `empty` when no other session exists.
 * Throws when the profile has no persistence backend. Focus returns to
 * `restoreFocus` on close.
 */
export async function pickPersistedSession(
  ctx: Context,
  tui: TUI,
  theme: TuiTheme,
  excludeSessionId: string | undefined,
  restoreFocus: () => void,
): Promise<PickSessionResult> {
  const persistence = ctx.get('sessionPersistence') as SessionPersistence | undefined
  if (persistence === undefined) {
    throw new Error('Session persistence is not configured in this profile.')
  }
  let headers: SessionHeader[]
  try {
    headers = await persistence.list()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to list persisted sessions: ${message}`)
  }
  const candidates = headers
    .filter(isResumableSessionHeader)
    .filter(header => String(header.id) !== excludeSessionId)
  // Order by last update (mtime of the jsonl log when known, else createdAt)
  // so a session the user touched yesterday-but-created-last-month surfaces
  // above newer-created stale ones. The mtime walk is best-effort: an
  // unknown root keeps the previous createdAt ordering.
  const lastUpdates = await loadSessionLastUpdates()
  const ordered = sortSessionsByLastUpdate(candidates, lastUpdates)
  if (ordered.length === 0) return { kind: 'empty' }

  // Enrich the most recent candidates with their first-message preview so the
  // rows are distinguishable at a glance; older ones fall back to the header
  // label (cwd + short id).
  const previews = await loadSessionPreviews(persistence, ordered.slice(0, PREVIEW_SESSION_CAP).map(header => header.id))

  const rows = ordered.map(header => {
    const id = String(header.id)
    const preview = previews.get(id)
    const updated = lastUpdates.get(id) ?? header.createdAt
    return {
      value: id,
      header,
      session: preview ?? `${basename(header.cwd ?? '?')} · ${clipToWidth(id, 8)}`,
      when: new Date(updated).toLocaleString(),
      dir: header.cwd ?? 'no cwd',
    }
  })

  return new Promise<PickSessionResult>(resolve => {
    // Auto layout: SESSION and UPDATED fit their content, DIR runs to the edge
    // (previews are often CJK, so SESSION gets a wider cap).
    const columns: readonly TableColumn[] = autoColumns(
      [
        { key: 'session', title: 'Session', cap: 36 },
        { key: 'when', title: 'Updated', cap: 26 },
        { key: 'dir', title: 'Dir' },
      ],
      rows,
      (row, key) => row[key as 'session' | 'when' | 'dir'],
    )
    const list = new TablePanel(theme, {
      title: '● Resume session',
      columns,
      rows,
      renderCell: (row, column) => row[column.key as 'session' | 'when' | 'dir'],
      onSelect: row => finish(row.header),
      onCancel: () => finish(undefined),
    })

    // Framed overlay: 13 list rows + 4 frame rows fit inside 75% of 24 rows.
    const overlay = tui.showOverlay(wrapFramedOverlay(theme, list), { width: '80%', maxHeight: '75%' })

    function finish(picked: SessionHeader | undefined): void {
      overlay.hide()
      restoreFocus()
      resolve(picked === undefined
        ? { kind: 'cancelled' }
        : { kind: 'picked', id: picked.id, header: picked })
    }
  })
}
