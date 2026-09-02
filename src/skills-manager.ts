/**
 * `/skills` panel — standalone skill browser listing all public
 * skills from `~/.agents/skills/`. Shows which are already symlinked to
 * `~/.dsh/skills/`. Space toggles pending state, Enter applies all
 * pending changes (batch create/delete symlinks), ESC discards.
 *
 * Extracted from the old `/settings` Skills category so the management
 * surface is independent of the settings browser.
 */

import { readdir, symlink, mkdir, unlink, lstat, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { dshHome } from './append-system.ts'
import type { Context } from '@deepseek-ai/cordis'
import {
  getKeybindings,
  matchesKey,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui'
import {
  columnWidths,
  MARKER_W,
  padCell,
  panelThemeFns,
  type TableColumn,
  TABLE_SEP,
  tableHeaderLine,
  tableRuleLine,
  PanelHost,
} from './panels.ts'
import { BOLD, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'
import {
  clampScrollOffset,
  clampSkillCursor,
  filterSkillRows,
  isPrintableInput,
  skillJumpCursor,
  skillPanelRowLine,
  type SkillJump,
  type SkillPanelRow,
} from './skills.ts'

// ------------------------------------------------------------ public types --

/**
 * The couplet the Skills manager needs off an agent: its session cwd for
 * project-relative skill discovery.
 */
export interface SkillScopeAgent {
  session: { header: { cwd?: string } }
}

// ----------------------------------------------------------- panel constants --

/** Fixed page size for the panel's paged navigation (PgUp/PgDn). */
const SKILL_PAGE_SIZE = 10

/** Cap for a skill row's description line (columns; width-safe). */
const SKILL_DESC_MAX = 60

// --------------------------------------------------- symlink application --

/** Result of applying one pending skill change. */
export interface SkillApplyResult {
  name: string
  /** Failure reason; undefined when the change applied or already held. */
  error: string | undefined
}

/**
 * Resolve the (src, dest) symlink pair for a skill name: the flat
 * `<name>.md` file first, then the `<name>/` directory bundle. Return
 * undefined when neither source form exists.
 */
export function skillSymlinkPaths(
  publicDir: string,
  curatedDir: string,
  name: string,
): { src: string; dest: string } | undefined {
  const srcMd = join(publicDir, `${name}.md`)
  if (existsSync(srcMd)) {
    return { src: srcMd, dest: join(curatedDir, `${name}.md`) }
  }
  const srcBundle = join(publicDir, name)
  if (existsSync(srcBundle)) {
    return { src: srcBundle, dest: join(curatedDir, name) }
  }
  return undefined
}

/**
 * Create the `dest` symlink pointing at `src`, idempotently:
 *
 * - dest absent → plain symlink creation;
 * - dest is a symlink whose realpath matches the source → no-op success
 *   (re-installing an installed skill must not raise EEXIST);
 * - dest is a symlink to a different source → error, never overwrite;
 * - dest is a physical file or directory (user content) → error, never
 *   overwrite or pierce it;
 * - dest is a dangling symlink → unlink it and recreate (repairable).
 */
export async function installSkillSymlink(src: string, dest: string): Promise<void> {
  const srcReal = await realpath(src).catch((error: unknown) => {
    // Race window: the source vanished between the scan and the apply —
    // surface a readable cause instead of a raw errno message.
    const code = (error as NodeJS.ErrnoException).code
    throw new Error(`skill source vanished: "${src}"${code === undefined ? '' : ` (${code})`}`)
  })
  const destStat = await lstat(dest).catch(() => undefined)
  if (destStat === undefined) {
    await symlink(src, dest)
    return
  }
  if (!destStat.isSymbolicLink()) {
    throw new Error(`refusing to overwrite "${dest}": not a symlink`)
  }
  const destReal = await realpath(dest).catch((error: unknown) => {
    // Only a missing target (ENOENT) or a link loop (ELOOP) counts as a
    // repairable dead link; any other failure (EACCES, EIO, …) is a real
    // error and must not be silently paved over with a recreate.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ELOOP') {
      return undefined
    }
    throw error
  })
  if (destReal === undefined) {
    // Dangling symlink: drop the dead link and recreate it.
    await unlink(dest)
    await symlink(src, dest)
    return
  }
  if (destReal === srcReal) {
    return
  }
  throw new Error(
    `already installed from a different source: "${dest}" points to "${destReal}", expected "${srcReal}"`,
  )
}

/**
 * Apply one pending install/uninstall. Return an error message instead of
 * throwing so a batch can continue past broken items.
 */
export async function applyOneSkillChange(
  name: string,
  targetState: boolean,
  publicDir: string,
  curatedDir: string,
): Promise<string | undefined> {
  if (targetState) {
    const paths = skillSymlinkPaths(publicDir, curatedDir, name)
    if (paths === undefined) {
      return `cannot install: skill not found in "${publicDir}"`
    }
    try {
      await installSkillSymlink(paths.src, paths.dest)
      return undefined
    } catch (error: unknown) {
      return `cannot install: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  // Uninstall: mirror the install-side protection — only ever remove a
  // symlink we own. A physical file or directory at dest is user content
  // and must be refused, never silently deleted.
  try {
    const destMd = join(curatedDir, `${name}.md`)
    const destBundle = join(curatedDir, name)
    const mdStat = await lstat(destMd).catch(() => undefined)
    if (mdStat !== undefined) {
      if (!mdStat.isSymbolicLink()) {
        throw new Error(`refusing to remove "${destMd}": not a symlink`)
      }
      await unlink(destMd)
      return undefined
    }
    const bundleStat = await lstat(destBundle).catch(() => undefined)
    if (bundleStat !== undefined) {
      if (!bundleStat.isSymbolicLink()) {
        throw new Error(`refusing to remove "${destBundle}": not a symlink`)
      }
      await unlink(destBundle)
    }
    return undefined
  } catch (error: unknown) {
    return `cannot uninstall: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Max items itemized per list (ok / failed) in the one-line summary; beyond that, "+N more". */
const SKILL_SUMMARY_MAX_ITEMS = 3

/**
 * Collapse a per-item error into a short reason for the one-line summary.
 * Full paths and raw errno details stay out of the clipped status line —
 * they only bloat it past what the panel can show.
 */
export function skillApplyShortReason(error: string): string {
  if (error.includes('not a symlink')) return 'not a symlink'
  if (error.includes('different source')) return 'different source'
  if (error.includes('skill not found') || error.includes('source vanished')) return 'source missing'
  // No current producer emits "dest missing" — defensive mapping kept so a
  // future dest-existence check still collapses to a short reason.
  if (error.includes('dest missing')) return 'dest missing'
  return 'failed'
}

/**
 * Compose the one-line summary for a finished batch. Empty when everything
 * applied (the rescan speaks for itself); otherwise name the successes and
 * itemize failures as `name (short reason)`. Both lists are capped at
 * SKILL_SUMMARY_MAX_ITEMS entries plus a `+N more` tail: a large ok list
 * must never fill the line and let clipToWidth cut away the failed
 * segment behind it — the failures are what the user needs to see.
 */
export function skillApplySummary(results: readonly SkillApplyResult[]): string {
  const failures = results.filter(r => r.error !== undefined)
  if (failures.length === 0) {
    return ''
  }
  const okNames = results.filter(r => r.error === undefined).map(r => r.name)
  const failed = failures
    .slice(0, SKILL_SUMMARY_MAX_ITEMS)
    .map(r => `${r.name} (${skillApplyShortReason(r.error ?? '')})`)
    .join(', ')
  const failedExtra = failures.length - SKILL_SUMMARY_MAX_ITEMS
  const failedMore = failedExtra > 0 ? ` +${failedExtra} more` : ''
  const okShown = okNames.slice(0, SKILL_SUMMARY_MAX_ITEMS).join(', ')
  const okExtra = okNames.length - SKILL_SUMMARY_MAX_ITEMS
  const okMore = okExtra > 0 ? ` +${okExtra} more` : ''
  const okPart = okNames.length > 0 ? `ok: ${okShown}${okMore} · ` : ''
  return `Applied ${okNames.length}/${results.length} — ${okPart}failed: ${failed}${failedMore}`
}

// ------------------------------------------------------- SkillsManagerPanel --

/**
 * Self-drawn Skills Manager panel — single view listing all public skills
 * from `~/.agents/skills/`. Shows which are already symlinked to
 * `~/.dsh/skills/`. Space toggles pending state, Enter applies all
 * pending changes (batch create/delete symlinks), ESC discards.
 */
export class SkillsManagerPanel implements Component {
  private readonly ctx: Context
  private readonly tui: TUI
  private readonly theme: TuiTheme
  private readonly onExit: () => void
  private readonly agent: SkillScopeAgent | undefined
  private rows: SkillPanelRow[] = []
  private cursor = 0
  private scrollOffset = 0
  private status: string | undefined
  private filterQuery = ''
  /** Raw available skill entries (name + already-installed flag). */
  private availableEntries: AvailableSkillEntry[] = []
  /** Pending changes: name → target state (true=install, false=uninstall). */
  private pendingChanges: Map<string, boolean> = new Map()
  /** Whether the ESC confirmation prompt is active. */
  private confirming = false
  /**
   * Whether a batch apply is in flight. Blocks Space/Enter while set so a
   * concurrent apply cannot be kicked off and pending changes cannot be
   * toggled mid-batch (they would be silently dropped by the apply loop).
   */
  private applying = false

  /**
   * The overlay renders at `maxHeight` of terminal rows; FramedOverlay adds
   * 4 chrome rows (top border + spacer + bottom spacer + border); the child
   * adds 8 rows around the skill list (title + top rule + header + mid rule
   * above, bottom rule + description + spacer + footer below) plus one more
   * when a batch summary notice rides above the table.
   */
  private static readonly FRAME_OVERHEAD = 4
  private static readonly TAIL_ROWS = 8

  /** Path to the public skills directory (~/.agents/skills). */
  private static readonly PUBLIC_SKILLS_DIR = resolve(join(homedir(), '.agents', 'skills'))
  /** Path to the curated skills directory ($DSH_HOME/skills). */
  private static readonly CURATED_SKILLS_DIR = resolve(join(dshHome(), 'skills'))

  constructor(
    ctx: Context,
    tui: TUI,
    theme: TuiTheme,
    onExit: () => void,
    agent: SkillScopeAgent | undefined,
  ) {
    this.ctx = ctx
    this.tui = tui
    this.theme = theme
    this.onExit = onExit
    this.agent = agent
  }

  invalidate(): void {
    this.tui.requestRender()
  }

  /** Replace the whole list (keeps the cursor clamped to the filtered length). */
  setRows(rows: readonly SkillPanelRow[]): void {
    this.rows = [...rows]
    this.status = undefined
    this.cursor = clampSkillCursor(this.cursor, this.getFilteredRows().length)
    this.scrollToCursor()
    this.tui.requestRender()
  }

  /** Show a one-line notice in place of the list. */
  setStatus(text: string | undefined): void {
    this.status = text
    this.rows = []
    this.cursor = 0
    this.scrollOffset = 0
    this.tui.requestRender()
  }

  render(width: number): string[] {
    const fns = panelThemeFns(this.theme)
    const wrap = Math.max(2, width - 2)
    let title = '⚙ Skills Manager'
    if (this.hasUnsavedChanges) {
      title += ` (${this.pendingChanges.size} unsaved)`
    }
    const lines: string[] = [
      fns.accent(BOLD + clipToWidth(title, wrap) + RESET),
    ]
    if (this.rows.length === 0) {
      lines.push(fns.muted(clipToWidth(this.status ?? '', wrap)))
      lines.push('')
      lines.push(fns.subtle(clipToWidth(this.footer, wrap)))
      return lines
    }

    const filtered = this.getFilteredRows()
    if (filtered.length === 0) {
      lines.push(fns.muted(clipToWidth(`No matches for '${this.filterQuery}'`, wrap)))
      lines.push('')
      lines.push(fns.subtle(clipToWidth(this.footer, wrap)))
      return lines
    }

    const maxVisibleRows = this.maxVisibleRows()
    this.scrollToCursor(maxVisibleRows, filtered.length)

    // A preserved batch summary (or other notice) rides above the table.
    if (this.status !== undefined) {
      lines.push(fns.muted(clipToWidth(this.status, wrap)))
    }

    const visibleRows = filtered.slice(this.scrollOffset, this.scrollOffset + maxVisibleRows)

    // Column layout: On icon (●/○) | Skill name (flex)
    const columns: readonly TableColumn[] = [
      { key: 'on', title: 'On', width: 2 },
      { key: 'name', title: 'Skill', flex: true },
    ]
    const widths = columnWidths(wrap - MARKER_W, columns)
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┬'), wrap)))
    lines.push(fns.subtle(clipToWidth(tableHeaderLine(columns, widths), wrap)))
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┼'), wrap)))
    const prefixCols = 2 + 2
    for (let vi = 0; vi < visibleRows.length; vi++) {
      const i = this.scrollOffset + vi
      const row = filtered[i]
      const selected = i === this.cursor
      const effectiveEnabled = this.getEffectiveStateForRow(row)
      const plain = clipToWidth(
        skillPanelRowLine(selected, effectiveEnabled, padCell(row.name, widths[1])),
        width,
      )
      if (selected) {
        lines.push(fns.accent(BOLD + plain + RESET))
      } else {
        lines.push(
          fns[effectiveEnabled ? 'success' : 'subtle'](plain.slice(0, prefixCols))
          + fns.muted(plain.slice(prefixCols)),
        )
      }
    }
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┴'), wrap)))
    const sel = filtered[this.cursor]
    if (sel !== undefined && sel.description !== '') {
      lines.push(fns.subtle(clipToWidth(`  ${sel.description}`, wrap)))
    }
    lines.push('')
    lines.push(fns.subtle(clipToWidth(this.footer, wrap)))
    return lines
  }

  /** Rows that fit under the framed overlay on this terminal. */
  private maxVisibleRows(): number {
    const tail = SkillsManagerPanel.TAIL_ROWS + (this.status !== undefined ? 1 : 0)
    return Math.max(1,
      Math.floor(this.tui.terminal.rows * 0.8) - SkillsManagerPanel.FRAME_OVERHEAD - tail)
  }

  /** Scroll suffix ` (x/y)` — only when the list overflows the viewport. */
  private scrollText(filtered: readonly SkillPanelRow[]): string {
    return filtered.length > this.maxVisibleRows() ? ` (${this.cursor + 1}/${filtered.length})` : ''
  }

  handleInput(data: string): void {
    const kb = getKeybindings()
    // If confirming discard, handle Y/N.
    if (this.confirming) {
      if (data === 'y' || data === 'Y') {
        this.discardPendingChanges()
        this.onExit()
        return
      }
      if (data === 'n' || data === 'N' || kb.matches(data, 'tui.select.cancel')) {
        this.confirming = false
        this.tui.requestRender()
        return
      }
      return
    }
    if (kb.matches(data, 'tui.select.cancel')) {
      if (this.filterQuery !== '') {
        this.filterQuery = ''
        this.cursor = 0
        this.scrollOffset = 0
        this.tui.requestRender()
        return
      }
      // If there are unsaved changes, ask for confirmation.
      if (this.hasUnsavedChanges) {
        this.confirming = true
        this.tui.requestRender()
        return
      }
      this.onExit()
      return
    }
    if (kb.matches(data, 'tui.select.up')) {
      this.move('up')
      return
    }
    if (kb.matches(data, 'tui.select.down')) {
      this.move('down')
      return
    }
    if (kb.matches(data, 'tui.select.pageUp')) {
      this.move('pageUp')
      return
    }
    if (kb.matches(data, 'tui.select.pageDown')) {
      this.move('pageDown')
      return
    }
    if (matchesKey(data, 'home')) {
      this.move('home')
      return
    }
    if (matchesKey(data, 'end')) {
      this.move('end')
      return
    }
    // Space — toggle pending state (blocked while a batch is applying).
    if (data === ' ') {
      if (this.applying) return
      this.togglePending()
      return
    }
    // Enter — apply pending changes if any, otherwise toggle current
    // (blocked while a batch is applying).
    if (kb.matches(data, 'tui.select.confirm')) {
      if (this.applying) return
      if (this.hasUnsavedChanges) {
        void this.applyPendingChanges()
      } else {
        this.togglePending()
      }
      return
    }
    if (data === '\x7f' || matchesKey(data, 'backspace')) {
      if (this.filterQuery !== '') {
        this.filterQuery = this.filterQuery.slice(0, -1)
        this.cursor = 0
        this.scrollOffset = 0
        this.tui.requestRender()
      }
      return
    }
    if (isPrintableInput(data)) {
      this.filterQuery += data
      this.cursor = 0
      this.scrollOffset = 0
      this.tui.requestRender()
    }
  }

  /** Move the cursor by a jump kind, then scroll into view and repaint. */
  private move(jump: SkillJump): void {
    const filtered = this.getFilteredRows()
    this.cursor = skillJumpCursor(this.cursor, filtered.length, jump)
    this.tui.requestRender()
  }

  /** Adjust scrollOffset so the cursor is within `[offset, offset+visibleRows)`. */
  private scrollToCursor(visibleRows?: number, length?: number): void {
    const vr = visibleRows ?? this.maxVisibleRows()
    const len = length ?? this.getFilteredRows().length
    this.scrollOffset = clampScrollOffset(this.cursor, vr, len, this.scrollOffset)
  }

  /** The rows after applying the current filter query. */
  private getFilteredRows(): SkillPanelRow[] {
    return filterSkillRows(this.rows, this.filterQuery)
  }

  /** Footer hint changes when a filter is active. */
  private get footer(): string {
    let hint: string
    if (this.confirming) {
      hint = 'Discard unsaved changes? Y/N'
    } else if (this.filterQuery !== '') {
      hint = `Filter: ${this.filterQuery} · Backspace clear · Esc clear filter`
    } else if (this.hasUnsavedChanges) {
      hint = '↑↓ nav · Space toggle · Enter apply · Esc discard'
    } else {
      hint = '↑↓ nav · PgUp/PgDn page · Home/End jump · Space toggle · Enter apply · Esc back'
    }
    const scroll = this.scrollText(this.getFilteredRows())
    return hint + scroll
  }

  /** Whether there are unsaved pending changes in Available view. */
  private get hasUnsavedChanges(): boolean {
    return this.pendingChanges.size > 0
  }

  /** Toggle pending state for the current skill in Available view. */
  private togglePending(): void {
    const filtered = this.getFilteredRows()
    const row = filtered[this.cursor]
    if (row === undefined) return
    const currentState = this.getEffectiveStateForRow(row)
    this.pendingChanges.set(row.name, !currentState)
    this.tui.requestRender()
  }

  /** Get effective state (original + pending) for a row. */
  private getEffectiveStateForRow(row: SkillPanelRow): boolean {
    const pending = this.pendingChanges.get(row.name)
    if (pending !== undefined) {
      return pending
    }
    return row.enabled
  }

  /**
   * Apply all pending changes (batch create/delete symlinks). Items run one
   * by one; a failure is collected and reported in an end-of-batch summary
   * instead of aborting the remaining items. The list is rescanned either
   * way — a failed batch must not leave a dead panel: the rows come back
   * with the failure summary riding above them, ready for retry.
   */
  private async applyPendingChanges(): Promise<void> {
    this.applying = true
    try {
      const curatedDir = SkillsManagerPanel.CURATED_SKILLS_DIR
      try {
        await mkdir(curatedDir, { recursive: true })
      } catch {
        // Directory exists or could not be created — proceed.
      }
      const results: SkillApplyResult[] = []
      for (const [name, targetState] of this.pendingChanges) {
        const error = await applyOneSkillChange(
          name,
          targetState,
          SkillsManagerPanel.PUBLIC_SKILLS_DIR,
          curatedDir,
        )
        results.push({ name, error })
        if (error === undefined) {
          const entry = this.availableEntries.find(e => e.name === name)
          if (entry !== undefined) {
            entry.installed = targetState
          }
        }
      }
      this.pendingChanges.clear()
      this.confirming = false
      const summary = skillApplySummary(results)
      this.loadAvailableSkills(summary === '' ? undefined : summary)
    } finally {
      this.applying = false
    }
  }

  /** Discard pending changes without applying. */
  private discardPendingChanges(): void {
    this.pendingChanges.clear()
    this.confirming = false
    this.tui.requestRender()
  }

  /**
   * Load the available public skills from `~/.agents/skills/`. An optional
   * `notice` survives the rescan: it shows while scanning and is restored
   * above the rebuilt rows (used to keep a batch failure summary visible
   * after the list comes back).
   */
  loadAvailableSkills(notice?: string): void {
    this.setStatus(notice ?? 'Scanning public skills…')
    void this.scanPublicSkills()
      .then(entries => {
        this.availableEntries = entries
        if (entries.length === 0) {
          this.setStatus('No public skills found in ~/.agents/skills/.')
        } else {
          this.setRows(entries.map(e => ({
            name: e.name,
            description: e.description,
            enabled: e.installed,
          })))
          if (notice !== undefined) {
            this.status = notice
            this.tui.requestRender()
          }
        }
      })
      .catch(() => {
        this.setStatus('Could not read ~/.agents/skills/.')
      })
  }

  /**
   * Read the available skills from `~/.agents/skills/` and check which are
   * already symlinked into `~/.dsh/skills/`.
   */
  private async scanPublicSkills(): Promise<AvailableSkillEntry[]> {
    let entries: string[]
    try {
      entries = await readdir(SkillsManagerPanel.PUBLIC_SKILLS_DIR, { encoding: 'utf8' })
    } catch {
      return []
    }
    // Filter to skill names: foo.md and foo/ directory bundles.
    const skillNames = new Set<string>()
    for (const name of entries) {
      if (name.endsWith('.md')) {
        skillNames.add(name.slice(0, -3))
      } else if (!name.startsWith('.')) {
        // Could be a directory bundle — check if it has a SKILL.md inside.
        skillNames.add(name)
      }
    }
    const result: AvailableSkillEntry[] = []
    for (const name of skillNames) {
      const mdPath = join(SkillsManagerPanel.PUBLIC_SKILLS_DIR, `${name}.md`)
      const bundlePath = join(SkillsManagerPanel.PUBLIC_SKILLS_DIR, name, 'SKILL.md')
      const installed = existsSync(join(SkillsManagerPanel.CURATED_SKILLS_DIR, `${name}.md`))
        || existsSync(join(SkillsManagerPanel.CURATED_SKILLS_DIR, name))
      let description = ''
      // Try to read description from frontmatter.
      const desc = await this.readSkillDescription(mdPath, bundlePath)
      if (desc !== undefined) description = desc
      result.push({ name, description, installed })
    }
    result.sort((a, b) => a.name.localeCompare(b.name))
    return result
  }

  /** Try to extract `description` from a skill's SKILL.md frontmatter. */
  private async readSkillDescription(mdPath: string, bundlePath: string): Promise<string | undefined> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) return undefined
    for (const p of [mdPath, bundlePath]) {
      try {
        const target = await fs.resolve(p)
        const content = await fs.readFile(target)
        const text = content.toString('utf8')
        const m = text.match(/^---\n([\s\S]*?)\n---/)
        if (m === null) continue
        const descMatch = m[1].match(/^description:\s*(.+)$/m)
        if (descMatch !== undefined) return clipToWidth(descMatch[1].trim(), SKILL_DESC_MAX)
      } catch {
        continue
      }
    }
    return undefined
  }
}

// -------------------------------------------------------- helper types --

interface AvailableSkillEntry {
  name: string
  description: string
  installed: boolean
}

// -------------------------------------------------------- public entry point --

/**
 * Open the /skills panel as a framed overlay.
 * The panel manages its own lifecycle through the PanelHost.
 */
export function openSkillsManagerPanel(
  ctx: Context,
  tui: TUI,
  theme: TuiTheme,
  restoreFocus: () => void,
  agent: SkillScopeAgent | undefined,
  onClose: () => void,
): void {
  const host = new PanelHost(tui, theme)
  const panel = new SkillsManagerPanel(ctx, tui, theme, () => {
    host.close()
    restoreFocus()
    onClose()
  }, agent)
  host.open(panel)
  panel.loadAvailableSkills()
}