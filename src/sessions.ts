/**
 * Session TUI overlays: the `/session` info panel and the `/resume`
 * persisted-session picker — terminal counterparts of the web surface's
 * session management. Both follow the pi SelectList overlay pattern
 * (`showOverlay` + `restoreFocus` on close); the info panel is a one-shot
 * read-only component in the style of settings' ReadOnlyViewer.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  getKeybindings,
  SelectList,
  type Component,
  type SelectItem,
  type TUI,
} from '@earendil-works/pi-tui'
import { basename } from 'node:path'
import { ansiFg, BOLD, RESET, type TuiTheme } from './theme/index.ts'

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
      const clip = (text: string): string => text.length > max ? text.slice(0, max - 1) + '…' : text
      const row = (label: string, value: string): void => {
        lines.push(fg(p.fgMuted)(label.padEnd(LABEL_WIDTH)) + fg(p.fgDefault)(clip(value)))
      }
      const shortId = id.slice(0, 8)
      row('session', shortId)
      if (id.length > 8) {
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
      row('parent', parent === undefined ? '—' : parent.slice(0, 8))
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

/** Open the `/session` info panel; resolves when the user closes it. */
export async function showSessionInfo(tui: TUI, theme: TuiTheme, data: SessionPanelData): Promise<void> {
  await new Promise<void>(resolve => {
    const panel = new SessionInfoPanel(theme, data, () => {
      overlay.hide()
      resolve()
    })
    const overlay = tui.showOverlay(panel, { width: '70%', maxHeight: '60%' })
  })
}

// ------------------------------------------------------------- `/resume` picker --

/** The `sessionPersistence` service surface we use (registered by the profile). */
interface SessionPersistence {
  /** Lightweight read of persisted session metadata (headers only). */
  list(signal?: AbortSignal): Promise<SessionHeader[]>
  /** Full event log of one persisted session (damaged tails repaired on load). */
  inspect(id: SessionId, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>
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
    // Subagent children carry a persisted delegation depth — resuming one as
    // this TUI's main conversation would misplace it in the recursion budget.
    .filter(header => header.origin !== 'subagent')
    .filter(header => String(header.id) !== excludeSessionId)
    .sort((a, b) => b.createdAt - a.createdAt)
  if (candidates.length === 0) return { kind: 'empty' }

  const items: SelectItem[] = candidates.map(header => ({
    value: String(header.id),
    label: `${basename(header.cwd ?? '?')} · ${String(header.id).slice(0, 8)}`,
    description: `${new Date(header.createdAt).toLocaleString()} · ${header.cwd ?? 'no cwd'}`,
  }))

  return new Promise<PickSessionResult>(resolve => {
    const list = new SelectList(items, 12, theme.selectList)
    list.setSelectedIndex(0)

    const overlay = tui.showOverlay(list, { width: '80%', maxHeight: '60%' })

    const finish = (picked: SessionHeader | undefined): void => {
      overlay.hide()
      restoreFocus()
      resolve(picked === undefined
        ? { kind: 'cancelled' }
        : { kind: 'picked', id: picked.id, header: picked })
    }

    list.onSelect = item => {
      finish(candidates.find(header => String(header.id) === item.value))
    }
    list.onCancel = () => finish(undefined)
  })
}
