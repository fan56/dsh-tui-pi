/**
 * `/skills-manager` panel — standalone skill browser listing all public
 * skills from `~/.agents/skills/`. Shows which are already symlinked to
 * `~/.dsh/skills/`. Space toggles pending state, Enter applies all
 * pending changes (batch create/delete symlinks), ESC discards.
 *
 * Extracted from the old `/settings` Skills category so the management
 * surface is independent of the settings browser.
 */

import { readdir, symlink, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
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
   * The overlay renders at `maxHeight` of terminal rows; FramedOverlay adds
   * 4 chrome rows (top border + spacer + bottom spacer + border); the child
   * adds 8 rows around the skill list (title + top rule + header + mid rule
   * above, bottom rule + description + spacer + footer below).
   */
  private static readonly FRAME_OVERHEAD = 4
  private static readonly TAIL_ROWS = 8

  /** Path to the public skills directory (~/.agents/skills). */
  private static readonly PUBLIC_SKILLS_DIR = resolve(join(homedir(), '.agents', 'skills'))
  /** Path to the curated skills directory (~/.dsh/skills). */
  private static readonly CURATED_SKILLS_DIR = resolve(join(homedir(), '.dsh', 'skills'))

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
    return Math.max(1,
      Math.floor(this.tui.terminal.rows * 0.8) - SkillsManagerPanel.FRAME_OVERHEAD - SkillsManagerPanel.TAIL_ROWS)
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
    // Space — toggle pending state.
    if (data === ' ') {
      this.togglePending()
      return
    }
    // Enter — apply pending changes if any, otherwise toggle current.
    if (kb.matches(data, 'tui.select.confirm')) {
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

  /** Apply all pending changes (batch create/delete symlinks). */
  private async applyPendingChanges(): Promise<void> {
    const curatedDir = SkillsManagerPanel.CURATED_SKILLS_DIR
    try {
      await mkdir(curatedDir, { recursive: true })
    } catch {
      // Directory exists or could not be created — proceed.
    }
    for (const [name, targetState] of this.pendingChanges) {
      const srcMd = join(SkillsManagerPanel.PUBLIC_SKILLS_DIR, `${name}.md`)
      const srcBundle = join(SkillsManagerPanel.PUBLIC_SKILLS_DIR, name)
      const destMd = join(curatedDir, `${name}.md`)
      const destBundle = join(curatedDir, name)
      if (targetState) {
        // Install
        try {
          if (existsSync(srcMd)) {
            await symlink(srcMd, destMd)
          } else if (existsSync(srcBundle)) {
            await symlink(srcBundle, destBundle)
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          this.setStatus(`Cannot install "${name}": ${message}`)
          return
        }
      } else {
        // Uninstall
        try {
          if (existsSync(destMd)) {
            await unlink(destMd)
          } else if (existsSync(destBundle)) {
            await unlink(destBundle)
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          this.setStatus(`Cannot uninstall "${name}": ${message}`)
          return
        }
      }
      // Update the entry
      const entry = this.availableEntries.find(e => e.name === name)
      if (entry !== undefined) {
        entry.installed = targetState
      }
    }
    this.pendingChanges.clear()
    this.confirming = false
    this.loadAvailableSkills()
  }

  /** Discard pending changes without applying. */
  private discardPendingChanges(): void {
    this.pendingChanges.clear()
    this.confirming = false
    this.tui.requestRender()
  }

  /** Load the available public skills from `~/.agents/skills/`. */
  loadAvailableSkills(): void {
    this.setStatus('Scanning public skills…')
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

  /** Symlink a public skill into `~/.dsh/skills/`. */
  private async installAvailableSkill(name: string): Promise<void> {
    const curatedDir = SkillsManagerPanel.CURATED_SKILLS_DIR
    // Ensure ~/.dsh/skills/ exists.
    try {
      await mkdir(curatedDir, { recursive: true })
    } catch {
      // Directory exists or could not be created — proceed.
    }

    // Try flat file first, then directory bundle.
    const srcMd = join(SkillsManagerPanel.PUBLIC_SKILLS_DIR, `${name}.md`)
    const srcBundle = join(SkillsManagerPanel.PUBLIC_SKILLS_DIR, name)
    const destMd = join(curatedDir, `${name}.md`)
    const destBundle = join(curatedDir, name)

    try {
      if (existsSync(srcMd)) {
        await symlink(srcMd, destMd)
      } else if (existsSync(srcBundle)) {
        await symlink(srcBundle, destBundle)
      } else {
        this.setStatus(`Skill "${name}" not found in source.`)
        return
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.setStatus(`Cannot install "${name}": ${message}`)
      return
    }
    // Update the row in-place so the cursor stays where it is.
    const row = this.rows.find(r => r.name === name)
    if (row !== undefined) {
      row.enabled = true
    }
    const entry = this.availableEntries.find(e => e.name === name)
    if (entry !== undefined) {
      entry.installed = true
    }
    this.tui.requestRender()
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
 * Open the /skills-manager panel as a framed overlay.
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