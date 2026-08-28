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
import { SESSION_LOG_FILE_NAMES } from './retention.ts'
import { isCorruptLogError } from './log-repair.ts'
import { emitNotice } from './notice-bridge.ts'
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

/**
 * Visible-width cap for the DIR column. Fitted column widths scan EVERY
 * candidate row, not just the visible ones, and real cwds span 12–67 chars
 * (measured over the local session store; the 67-char deep repo path blew
 * the column out to ~70 and starved the flex SESSION tail). 32 keeps the
 * 90th-percentile cwd (~31 chars) fully visible and clips only the deep
 * outliers — longer paths truncate with an ellipsis.
 */
const RESUME_DIR_CAP = 32

/**
 * Only sessions with log activity inside this window appear in `/resume`
 * (mtime semantics, same as the Updated column and the sort). The DEFAULT of
 * the resume-filter precedence chain (settings.yaml `dsh-tui.resume.maxAgeDays`
 * > `DSH_TUI_RESUME_MAX_AGE_DAYS` > this constant), deliberately coupled in
 * VALUE with its retention twin `RETENTION_MAX_AGE_DAYS` (src/retention.ts):
 * the two 7s are one product decision ("a week is the working set") but
 * serve different masters (this one HIDES picker rows, retention DELETES
 * logs), so they are separate constants — change them together.
 * Boundary semantics match retention: the boundary case survives in both
 * (retention deletes strictly-older-than, the picker keeps
 * not-older-than).
 */
export const RESUME_MAX_AGE_DAYS = 7

/**
 * Minimum on-disk log size for a session to appear in `/resume` — the
 * DEFAULT of the same precedence chain (`dsh-tui.resume.minBytes` >
 * `DSH_TUI_RESUME_MIN_BYTES` > this constant). This is the COMPRESSED size
 * — `stat().size` of `session.jsonl` or `session.jsonl.zstd`, whichever
 * exists — read from the same stat the mtime walk already does (zero extra
 * IO, no decompression). A session below 20KB is a stub or a false start,
 * not worth a picker row.
 */
export const RESUME_MIN_BYTES = 20 * 1024

/**
 * Explicit `dsh-tui.resume` overrides from settings.yaml — the USER layer
 * of the settings document (theme-settings.ts hands the raw section
 * through), so every field is `unknown`: a hand-edited file can carry
 * anything. Absent fields are simply not overridden; present-but-invalid
 * ones are rejected by `resolveResumeConfig` with one notice each.
 */
export interface ResumeSettingsInput {
  maxAgeDays?: unknown
  minBytes?: unknown
}

/** The `/resume` display-filter knobs after settings/env resolution. */
export interface ResumeConfig {
  /** Keep sessions with activity no older than this many days. */
  maxAgeDays: number
  /** Keep sessions whose compressed on-disk log is at least this many bytes. */
  minBytes: number
}

/**
 * One env slot parsed: a finite number passing `accept`, or undefined when
 * absent/garbage (an `accept` rejection is garbage too — it falls to the
 * default silently, same contract as src/retention.ts).
 */
function finiteEnv(
  raw: string | undefined,
  accept: (value: number) => boolean = () => true,
): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) && accept(value) ? value : undefined
}

/**
 * Narrow one explicit settings field: a finite number passing `accept`, or
 * undefined (absent, or present-but-invalid). An invalid value emits one
 * notice through the shared bridge (src/notice-bridge.ts) naming the
 * field and its raw value, so a hand-edited settings.yaml is debuggable;
 * the caller falls to the next level. The picker is opened with the TUI
 * long up, so these typically deliver straight to the sink.
 */
function explicitSetting(
  section: ResumeSettingsInput | undefined,
  key: keyof ResumeSettingsInput,
  accept: (value: number) => boolean,
): number | undefined {
  const raw = section?.[key]
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !accept(raw)) {
    emitNotice(
      `settings dsh-tui.resume.${key}: invalid value `
      + `${JSON.stringify(raw)} — falling back to environment/default`,
    )
    return undefined
  }
  return raw
}

/**
 * Resolve the `/resume` display-filter knobs through the same precedence
 * chain as retention (src/retention.ts): an explicit settings.yaml value
 * (`dsh-tui.resume.*`) outranks the environment variables
 * (`DSH_TUI_RESUME_MAX_AGE_DAYS` / `DSH_TUI_RESUME_MIN_BYTES`), which
 * outrank the defaults — settings is what the user deliberately persisted.
 * An invalid settings value emits one notice (shared bridge) and falls to
 * the next level; an invalid env value falls back silently to the
 * default. Validity:
 * the age window must be > 0 (0 would empty the picker), the byte floor
 * must be an integer >= 0 (0 legitimately lifts the floor for stubs) — at
 * BOTH layers. A fractional byte floor like 20480.5 is garbage even though
 * it parses finite and positive: `stat().size` is integral, so a
 * fractional floor would silently bar exactly-at-the-boundary logs
 * (20480 < 20480.5) without the user ever seeing why.
 * Pure; `process.env` and the settings section are passed explicitly so
 * tests can pin them.
 */
export function resolveResumeConfig(
  env: Record<string, string | undefined> = process.env,
  settings?: ResumeSettingsInput,
): ResumeConfig {
  const sMaxAgeDays = explicitSetting(settings, 'maxAgeDays', value => value > 0)
  const sMinBytes = explicitSetting(settings, 'minBytes', value => Number.isInteger(value) && value >= 0)
  const maxAgeDays = sMaxAgeDays ?? finiteEnv(env.DSH_TUI_RESUME_MAX_AGE_DAYS)
  const minBytes = sMinBytes ?? finiteEnv(
    env.DSH_TUI_RESUME_MIN_BYTES,
    value => Number.isInteger(value) && value >= 0,
  )
  return {
    maxAgeDays: maxAgeDays !== undefined && maxAgeDays > 0 ? maxAgeDays : RESUME_MAX_AGE_DAYS,
    minBytes: minBytes ?? RESUME_MIN_BYTES,
  }
}

/** Concurrent `inspect` calls while enriching previews. */
const PREVIEW_CONCURRENCY = 6

/**
 * The jsonl persistence root guess: `$DSH_SESSION_ROOT`, else
 * `$DSH_HOME/sessions`, else `~/.dsh/sessions` — the dsh CLI convention. Only
 * used for the mtime-based last-update enrichment; a mismatched root simply
 * leaves the picker sorted by `createdAt` (the pre-existing behavior).
 * Deliberate contrast with retention's `sessionStoreRoot()`
 * (src/retention.ts), which ignores `$DSH_SESSION_ROOT`: that walk aims
 * `fs.rm` and must resolve exactly the tree the core writer appends to,
 * while this one only enriches/filters picker rows — a wrong root here
 * degrades display, it never deletes anything.
 */
export function sessionLogRoot(): string {
  if (process.env.DSH_SESSION_ROOT !== undefined && process.env.DSH_SESSION_ROOT !== '') {
    return process.env.DSH_SESSION_ROOT
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** How many ms one day holds — same vocabulary as src/retention.ts. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * One session log's stat snapshot from the walk: last write plus the
 * COMPRESSED on-disk size (both from the same `stat` call).
 */
export interface SessionLogStat {
  mtimeMs: number
  size: number
}

/**
 * Best-effort session-id → log-stat map from the jsonl store's files: one
 * walk of `<root>/<project>/<session>/session.jsonl[.zstd]`, one stat per
 * existing log name (mtime + compressed size, zero extra IO; when both
 * names exist the NEWEST mtime wins and carries its own size — retention's
 * walk vocabulary). Session directory names are
 * the path-encoded session ids — UUID ids encode to themselves, so the
 * common case matches by name; an encoded mismatch just misses the map and
 * falls back to `createdAt`. Any failure resolves an empty map (the picker
 * degrades to creation-order sorting and the activity filter fails open).
 */
export async function loadSessionLastUpdates(root: string = sessionLogRoot()): Promise<Map<string, SessionLogStat>> {
  const updates = new Map<string, SessionLogStat>()
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
      // Same last-activity vocabulary as retention's walk: a session's
      // activity is the NEWEST mtime across BOTH log names — the raw and
      // the compressed file may coexist (mid-compression, or a kept raw
      // copy), and breaking on the first existing suffix would hide an
      // active session behind its stale sibling and drop it from /resume
      // via the age filter. The size rides the SAME stat as the winning
      // mtime, so the minBytes filter judges the file that proves the
      // activity.
      let newest: SessionLogStat | undefined
      for (const name of SESSION_LOG_FILE_NAMES) {
        try {
          const info = await stat(join(root, project, dir, name))
          if (newest === undefined || info.mtimeMs > newest.mtimeMs) {
            newest = { mtimeMs: info.mtimeMs, size: info.size }
          }
        } catch {
          // Not this suffix — try the next one.
        }
      }
      if (newest !== undefined && newest.mtimeMs > 0) updates.set(dir, newest)
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
  logStats: ReadonlyMap<string, SessionLogStat>,
): SessionHeader[] {
  return headers.slice().sort((a, b) => {
    const at = logStats.get(String(a.id))?.mtimeMs ?? a.createdAt
    const bt = logStats.get(String(b.id))?.mtimeMs ?? b.createdAt
    if (bt !== at) return bt - at
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
    return String(b.id).localeCompare(String(a.id))
  })
}

/** Knobs of the `/resume` display filter; `now` is injected so it is testable. */
export interface ResumeActivityPolicy {
  /** Keep sessions with activity no older than this many days. */
  maxAgeDays: number
  /** Keep sessions whose compressed on-disk log is at least this many bytes. */
  minBytes: number
  /** Reference time, ms since the epoch. */
  now: number
}

/**
 * The `/resume` display filter: only sessions with RECENT activity and a
 * real log body get a picker row. Age follows the same value the Updated
 * column and the sort show — the walked mtime when known, else the header's
 * `createdAt` — with retention's boundary semantics (exactly `maxAgeDays`
 * old survives; only strictly older is dropped). Size is the compressed
 * on-disk `stat().size`, inclusive at `minBytes` (20480 passes, 20479 does
 * not). A session MISSING from the stat map fails OPEN on size: the walk is
 * best-effort (unknown root, path-encoded id mismatch) and must never empty
 * the picker by itself — but its age still applies through `createdAt`.
 * Pure; the exclusion of the current session and subagent children happens
 * upstream in `pickPersistedSession` and is untouched by this filter.
 */
export function filterSessionsByLastActivity(
  headers: readonly SessionHeader[],
  logStats: ReadonlyMap<string, SessionLogStat>,
  policy: ResumeActivityPolicy,
): SessionHeader[] {
  const ageCutoff = policy.now - policy.maxAgeDays * DAY_MS
  return headers.filter(header => {
    const stat = logStats.get(String(header.id))
    if (stat === undefined) return header.createdAt >= ageCutoff
    return stat.mtimeMs >= ageCutoff && stat.size >= policy.minBytes
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

/**
 * The picker row's SESSION-column label: the first-message preview when one
 * was read, else the header label (cwd basename · short id). `corrupt`
 * prepends the ⚠ marker — the same pre-read `inspect` that harvests previews
 * already diagnosed this log as corrupt, and selecting the row will offer an
 * in-place repair instead of a dead end. Pure so the marker contract is
 * unit-testable without a store.
 */
export function resumeRowTitle(header: SessionHeader, preview: string | undefined, corrupt: boolean): string {
  const base = preview ?? `${basename(header.cwd ?? '?')} · ${clipToWidth(String(header.id), 8)}`
  return corrupt ? `⚠ ${base}` : base
}

/**
 * Best-effort first-message preview per session id; failures map to
 * undefined, and failures matching the corrupt-log fingerprint additionally
 * record the id in `corruptIds` — zero extra IO (the inspect calls already
 * ran for the previews), so the ⚠ rows stay a free byproduct of enrichment.
 */
async function loadSessionPreviews(
  persistence: SessionPersistence,
  ids: readonly SessionId[],
): Promise<{ previews: Map<string, string | undefined>; corruptIds: Set<string> }> {
  const previews = new Map<string, string | undefined>()
  const corruptIds = new Set<string>()
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
      } catch (error) {
        preview = undefined
        const message = error instanceof Error ? error.message : String(error)
        if (isCorruptLogError(message)) corruptIds.add(String(id))
      }
      previews.set(String(id), preview)
    }
  })
  await Promise.all(workers)
  return { previews, corruptIds }
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
  /** The store holds no other resumable session at all. */
  | { kind: 'empty' }
  /**
   * Resumable sessions exist, but the display filter (age window / byte
   * floor) hid every one of them. The effective knobs ride along so the
   * caller can name the window that emptied the list and point at the
   * `dsh-tui.resume.*` knobs that widen it, instead of reporting "no
   * sessions" over a store full of filtered-out ones. `hidden` counts the
   * candidates the filter dropped.
   */
  | { kind: 'empty-filtered'; hidden: number; maxAgeDays: number; minBytes: number }
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
 * `cancelled` when dismissed, `empty` when no other resumable session
 * exists, or `empty-filtered` when resumable sessions exist but the
 * display filter (age/size) hid them all — the two empties read
 * differently to the user (nothing stored vs. adjust the window). Throws
 * when the profile has no persistence backend. Focus returns to
 * `restoreFocus` on close. `resumeSettings` is the explicit
 * `dsh-tui.resume` section from settings.yaml (the user layer, read by the
 * caller through `readSessionManagementExplicit`) — the picker resolves it
 * against the environment and the defaults per open, so a committed
 * settings change applies to the next /resume without a restart.
 */
export async function pickPersistedSession(
  ctx: Context,
  tui: TUI,
  theme: TuiTheme,
  excludeSessionId: string | undefined,
  restoreFocus: () => void,
  resumeSettings?: ResumeSettingsInput,
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
  // Display filter: only sessions active within the age window AND with a
  // log of at least `minBytes` (compressed) get a row — knobs resolved per
  // open through the precedence chain (settings explicit > env > default,
  // `resolveResumeConfig`). Applied between the walk and the sort so both
  // consume the same stats; a list this empties resolves one of the two
  // empties below, so the user can tell "nothing stored" apart from
  // "the window hid them".
  const resumeConfig = resolveResumeConfig(process.env, resumeSettings)
  const visible = filterSessionsByLastActivity(candidates, lastUpdates, {
    maxAgeDays: resumeConfig.maxAgeDays,
    minBytes: resumeConfig.minBytes,
    now: Date.now(),
  })
  const ordered = sortSessionsByLastUpdate(visible, lastUpdates)
  if (ordered.length === 0) {
    return candidates.length === 0
      ? { kind: 'empty' }
      : {
          kind: 'empty-filtered',
          hidden: candidates.length,
          maxAgeDays: resumeConfig.maxAgeDays,
          minBytes: resumeConfig.minBytes,
        }
  }

  // Enrich the most recent candidates with their first-message preview so the
  // rows are distinguishable at a glance; older ones fall back to the header
  // label (cwd + short id). Logs the enrichment inspect diagnosed as corrupt
  // get the ⚠ marker — a free byproduct of the same calls, never a new scan.
  const { previews, corruptIds } = await loadSessionPreviews(
    persistence,
    ordered.slice(0, PREVIEW_SESSION_CAP).map(header => header.id),
  )

  const rows = ordered.map(header => {
    const id = String(header.id)
    const updated = lastUpdates.get(id)?.mtimeMs ?? header.createdAt
    return {
      value: id,
      header,
      session: resumeRowTitle(header, previews.get(id), corruptIds.has(id)),
      when: new Date(updated).toLocaleString(),
      dir: header.cwd ?? 'no cwd',
    }
  })

  return new Promise<PickSessionResult>(resolve => {
    // Auto layout: UPDATED and DIR fit their content, SESSION runs to the
    // edge (previews are often CJK, so it gets the flexible tail). DIR is
    // capped — fitted widths scan EVERY candidate row, so one deep cwd
    // would otherwise eat the session column (see RESUME_DIR_CAP).
    const columns: readonly TableColumn[] = autoColumns(
      [
        { key: 'when', title: 'Updated', cap: 26 },
        { key: 'dir', title: 'Dir', cap: RESUME_DIR_CAP },
        { key: 'session', title: 'Session' },
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
