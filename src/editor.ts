/**
 * Custom editor that replaces the input's TOP BORDER row with a plain-text
 * info line: cwd + permission badge + git branch (separator "│"), in border
 * color only (no powerline background segments). Ported from
 * pi-powerline-footer's CwdBorderEditor; every other editor row is left
 * untouched.
 */

import { Editor, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from '@earendil-works/pi-tui'

/** Shorten the cwd by replacing the HOME prefix with `~`. */
export function formatCwd(cwd: string): string {
  const home = process.env.HOME
  if (home !== undefined && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`
  }
  return cwd
}

/** History cap for the submitted-message browse (shell-style Up/Down recall). */
export const HISTORY_LIMIT = 500

/**
 * Snapshot of the pi-tui base editor's mid-browse state: the history cursor
 * (`index`, -1 = not browsing, 0 = most recent) plus the editor state that the
 * base captured when the user pressed Up off the newest entry (the pre-browse
 * draft), if any. Used so a theme hot-swap rebuild can restore exactly where
 * the user was — not just the history list.
 */
export interface BrowseState {
  index: number
  draft: { lines: string[]; cursorLine: number; cursorCol: number } | null
}

export class CwdBorderEditor extends Editor {
  private readonly sessionCwd: string
  private readonly infoColor: (str: string) => string
  private branchProvider: () => string | undefined = () => undefined
  private permissionProvider: () => string | undefined = () => undefined

  constructor(
    tui: TUI,
    theme: EditorTheme,
    sessionCwd: string,
    options?: { paddingX?: number; infoColor?: (str: string) => string },
  ) {
    super(tui, theme, { paddingX: options?.paddingX ?? 0 })
    this.sessionCwd = sessionCwd
    // The border dashes stay border-colored, but the cwd/branch info needs a
    // readable foreground (border color is near-invisible on light themes).
    this.infoColor = options?.infoColor ?? theme.borderColor
  }

  /** Live git-branch source (polled outside; the editor only reads it). */
  setBranchProvider(provider: () => string | undefined): void {
    this.branchProvider = provider
  }

  /**
   * Live permission-preset display-name source (e.g. "Full access") — the
   * badge shown right after the cwd; polled outside, the editor only reads it.
   */
  setPermissionProvider(provider: () => string | undefined): void {
    this.permissionProvider = provider
  }

  /**
   * Record a submitted message for Up/Down browsing. Same semantics as the
   * pi-tui base `addToHistory` (trim, skip empty, skip consecutive duplicates,
   * index 0 = most recent) but caps the list at `HISTORY_LIMIT` instead of the
   * base's 100 — the chat editor wants a 500-entry recall, dropping the oldest.
   * Note: the base (0.84.2) declares `history` private in its .d.ts but keeps
   * it as a plain runtime field; we reach it via a type cast. The `override`
   * keyword is fine under this tsconfig.
   */
  override addToHistory(text: string): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    const history = (this as unknown as { history: string[] }).history
    // A bad pi-tui bump must degrade, not throw on every Enter: if the base
    // ever stops exposing `history` as a plain array, fall back to the base
    // implementation (its own 100-cap path) and return.
    if (!Array.isArray(history)) {
      super.addToHistory(text)
      return
    }
    // Don't add consecutive duplicates.
    if (history.length > 0 && history[0] === trimmed) return
    history.unshift(trimmed)
    // Drop the oldest beyond the cap (base caps at 100).
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT
  }

  /**
   * Snapshot of the browse history, newest first (index 0). Returns a copy so
   * callers can reseed another instance (theme-swap rebuild) without mutating
   * this editor's internal list. Returns `[]` when the base no longer exposes
   * the runtime list (a bad pi-tui bump) rather than throwing.
   */
  getHistory(): string[] {
    const history = (this as unknown as { history: string[] }).history
    if (!Array.isArray(history)) return []
    return [...history]
  }

  /**
   * Reseed this editor's browse history from `entries` (newest first, index 0
   * = most recent, matching the base's addToHistory ordering). Adds oldest →
   * newest so the list lands in the same order on a fresh instance. Pinned to
   * HISTORY_LIMIT like any other add.
   */
  reseedHistory(entries: readonly string[]): void {
    for (let i = entries.length - 1; i >= 0; i--) {
      this.addToHistory(entries[i]!)
    }
  }

  /**
   * Snapshot the base's mid-browse state for a rebuild restore. `draft` is
   * `null` when not browsing (historyIndex -1) — `structuredClone`d so the
   * caller can reseed another instance without aliasing this editor's object.
   * Treats a missing/invalid base field as not browsing (a bad pi-tui bump
   * must degrade, not throw).
   */
  getBrowseState(): BrowseState {
    const base = this as unknown as {
      historyIndex?: number
      historyDraft?: { lines?: string[]; cursorLine?: number; cursorCol?: number } | null
    }
    const index = typeof base.historyIndex === 'number' ? base.historyIndex : -1
    const rawDraft = base.historyDraft
    const draft =
      rawDraft !== null && rawDraft !== undefined && Array.isArray(rawDraft.lines)
        ? {
            lines: structuredClone(rawDraft.lines),
            cursorLine: rawDraft.cursorLine ?? 0,
            cursorCol: rawDraft.cursorCol ?? 0,
          }
        : null
    return { index, draft }
  }

  /**
   * Restore a previously-captured browse state (see getBrowseState) onto a
   * fresh editor after a rebuild. `index` is clamped to the reseeded list so a
   * stale snapshot can never read out of bounds; a snapshot whose history was
   * truncated to nothing degrades to not browsing. `draft` is `null` → null,
   * else `structuredClone`d. Skips writes entirely when the base no longer
   * exposes the runtime fields (a bad pi-tui bump degrades silently).
   */
  restoreBrowseState(state: BrowseState): void {
    const base = this as unknown as {
      history: string[]
      historyIndex?: number
      historyDraft?: unknown
    }
    if (!Array.isArray(base.history)) return
    const maxIndex = base.history.length - 1
    const index = maxIndex < 0 ? -1 : Math.max(-1, Math.min(state.index, maxIndex))
    base.historyIndex = index
    base.historyDraft =
      state.draft === null ? null : structuredClone(state.draft)
  }

  render(width: number): string[] {
    const lines = super.render(width)
    if (lines.length < 2 || width < 3) return lines

    // When scrolled, the built-in top border row is a scroll indicator
    // ("─── ↑ N more ─…"); preserve that feedback by appending ↑ N.
    const firstLine = lines[0] ?? ''
    const scrollMatch = /↑\s*(\d+)/u.exec(firstLine)
    const scrollInfo = scrollMatch === null ? '' : ` ↑ ${scrollMatch[1]}`

    const permission = this.permissionProvider()
    const parts = [
      `📁 ${formatCwd(this.sessionCwd)}` +
        (permission !== undefined && permission !== '' ? ` (${permission})` : ''),
    ]
    const branch = this.branchProvider()
    if (branch !== undefined && branch !== '') parts.push(`⎇ ${branch}`)
    const content = parts.join(' │ ') + scrollInfo

    // Reserve 3 fixed columns: "─ " prefix (2) + " " suffix (1).
    const maxContent = Math.max(0, width - 3)
    const contentText = truncateToWidth(content, maxContent, '…')
    const fill = Math.max(0, width - 3 - visibleWidth(contentText))

    lines[0] =
      this.borderColor('─ ') +
      this.infoColor(contentText) +
      this.borderColor(' ') +
      this.borderColor('─'.repeat(fill))
    return lines
  }
}
