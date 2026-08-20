/**
 * Session TUI overlays: the `/session` info panel and the `/resume`
 * persisted-session picker — terminal counterparts of the web surface's
 * session management. The picker is the FW table (TablePanel in a framed
 * overlay + `restoreFocus` on close); the info panel is a one-shot
 * read-only component in the style of settings' ReadOnlyViewer.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { getKeybindings, type Component, type TUI } from '@earendil-works/pi-tui'
import { basename } from 'node:path'
import { wrapFramedOverlay } from './frame.ts'
import { autoColumns, TablePanel, type TableColumn } from './panels.ts'
import { ansiFg, BOLD, RESET, type TuiTheme } from './theme/index.ts'
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
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  status: 'idle' | 'running' | 'none'
  eventCount: number | undefined
  parentSession: string | undefined
}

/** Label column width for the key-value rows (longest: "cache read/write"). */
const LABEL_WIDTH = 12

/** One-shot read-only panel; Esc/Enter hides the overlay and resolves. */
class SessionInfoPanel implements Component {
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
    const fg = (hex: string) => (text: string) => ansiFg(hex) + text + RESET
    const p = this.theme.palette
    const lines: string[] = [
      fg(p.accent)(BOLD + 'ⓘ session' + RESET),
      '',
    ]
    const id = this.data.id
    if (id === undefined) {
      lines.push(fg(p.fgDefault)('  no active session — send a prompt or /resume one'))
    } else {
      const max = Math.max(2, width - LABEL_WIDTH - 4)
      const clip = (text: string): string => clipToWidth(text, max)
      const row = (label: string, value: string): void => {
        lines.push(fg(p.fgMuted)(label.padEnd(LABEL_WIDTH)) + fg(p.fgDefault)(clip(value)))
      }
      const shortId = clipToWidth(id, 8)
      row('session', shortId)
      if (visibleWidth(id) > 8) {
        lines.push('  ' + ' '.repeat(LABEL_WIDTH) + fg(p.fgSubtle)(clip(id)))
      }
      row('cwd', this.data.cwd ?? '—')
      row('created', this.data.createdAt === undefined ? '—' : new Date(this.data.createdAt).toLocaleString())
      row('model', this.data.model ?? '—')
      row('think', this.data.effort ?? '—')
      row('status', this.data.status === 'running' ? fg(p.accent)(this.data.status) : this.data.status)
      row('messages', String(this.data.msgCount))
      row('tool calls', String(this.data.toolCallCount))
      row('tokens in', String(this.data.inputTokens))
      row('tokens out', String(this.data.outputTokens))
      row('cache read', String(this.data.cacheReadTokens))
      row('cache write', String(this.data.cacheWriteTokens))
      row('events', this.data.eventCount === undefined ? '—' : String(this.data.eventCount))
      const parent = this.data.parentSession
      row('parent', parent === undefined ? '—' : clipToWidth(parent, 8))
    }
    lines.push('')
    lines.push(fg(p.fgSubtle)('  Esc to close'))
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
    // survives on small terminals (24 rows: 19 panel rows + 4 frame rows).
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
    .sort((a, b) => b.createdAt - a.createdAt)
  if (candidates.length === 0) return { kind: 'empty' }

  // Enrich the most recent candidates with their first-message preview so the
  // rows are distinguishable at a glance; older ones fall back to the header
  // label (cwd + short id).
  const previews = await loadSessionPreviews(persistence, candidates.slice(0, PREVIEW_SESSION_CAP).map(header => header.id))

  const rows = candidates.map(header => {
    const id = String(header.id)
    const preview = previews.get(id)
    return {
      value: id,
      header,
      session: preview ?? `${basename(header.cwd ?? '?')} · ${clipToWidth(id, 8)}`,
      when: new Date(header.createdAt).toLocaleString(),
      dir: header.cwd ?? 'no cwd',
    }
  })

  return new Promise<PickSessionResult>(resolve => {
    // Auto layout: SESSION and WHEN fit their content, DIR runs to the edge
    // (previews are often CJK, so SESSION gets a wider cap).
    const columns: readonly TableColumn[] = autoColumns(
      [
        { key: 'session', title: 'Session', cap: 36 },
        { key: 'when', title: 'When', cap: 26 },
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
