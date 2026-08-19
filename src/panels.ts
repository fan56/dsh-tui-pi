/**
 * Reusable select-panel framework — the shared building blocks behind every
 * picker/browser overlay in this TUI (agents table, field windows, viewers,
 * the /settings browser, and future migrations of the /model and /resume
 * surfaces).
 *
 * What lives here:
 *
 * - `padCell` / `columnWidths` — width-exact table cells (clip + pad by
 *   VISIBLE columns, CJK-safe) and fixed+flex column layout. Cells are
 *   padded so columns align even when row content has different widths —
 *   the classic "table rows are misaligned" bug is a missing pad, not a
 *   missing clip.
 * - `ListController` — pure navigation state (index/scroll/viewport) with
 *   up/down/pageUp/pageDown and viewport clamping; unit-testable, reused by
 *   every panel.
 * - `TablePanel` — a self-drawn table: header row + data rows + navigation
 *   + scroll info + selection highlight.
 * - `FieldPanel` — a title + read-only content block + editable field rows
 *   (Enter edits the focused row, optional single-key shortcuts).
 * - `ViewerPanel` — a read-only line viewer with a line cap.
 * - `SettingsListPanel` — a searchable settings-list panel (title header,
 *   whole-row selection, optional inline type-to-filter, footer + scroll
 *   info, submenus rendered in place): the FW-native replacement for the
 *   /settings browser's old pi-tui SettingsList.
 * - `PanelHost` — overlay lifecycle: swap to a new overlay (show-new-then-
 *   hide-old, no focus flash), teardown on showOverlay failure, one host
 *   per interactive flow.
 */

import {
  fuzzyFilter,
  getKeybindings,
  matchesKey,
  type Component,
  type OverlayHandle,
  type TUI,
} from '@earendil-works/pi-tui'
import { wrapFramedOverlay } from './frame.ts'
import { ansiFg, BOLD, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth, visibleWidth } from './text.ts'

/** Row marker slot width (▸ or two spaces). */
export const MARKER_W = 2

/** Column separator between table cells (box-drawing, matches the frame). */
export const TABLE_SEP = ' │ '

/** Minimum visible width of the flex column. */
const MIN_FLEX_WIDTH = 8

/**
 * Clip `text` to `width` visible columns and pad it with spaces to exactly
 * `width` columns — the width-exact cell primitive. `align` controls where
 * the padding goes.
 */
export function padCell(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const clipped = clipToWidth(text, width)
  const pad = width - visibleWidth(clipped)
  if (pad <= 0) return clipped
  return align === 'right' ? ' '.repeat(pad) + clipped : clipped + ' '.repeat(pad)
}

/** One table column definition. Exactly one column may be `flex`. */
export interface TableColumn {
  key: string
  title: string
  /** Fixed visible width; ignored on the flex column. */
  width?: number
  align?: 'left' | 'right'
  /** The flex column takes whatever the fixed columns leave over. */
  flex?: boolean
}

/**
 * Resolve visible widths for every column: fixed columns keep their width,
 * the single flex column gets the remainder (with a floor), separators are
 * counted between columns.
 */
export function columnWidths(total: number, columns: readonly TableColumn[]): number[] {
  const seps = Math.max(0, columns.length - 1) * visibleWidth(TABLE_SEP)
  const fixed = columns.reduce((sum, column) => sum + (column.flex === true ? 0 : (column.width ?? 0)), 0)
  const flexWidth = Math.max(MIN_FLEX_WIDTH, total - fixed - seps)
  return columns.map(column => (column.flex === true ? flexWidth : (column.width ?? 0)))
}

/** Pure navigation state shared by all panels (unit-testable). */
export class ListController {
  index = 0
  scroll = 0
  readonly maxVisible: number
  private readonly length: () => number

  constructor(length: () => number, maxVisible = 12) {
    this.length = length
    this.maxVisible = maxVisible
  }

  up(): void {
    if (this.index > 0) this.index--
    this.clampScroll()
  }

  down(): void {
    if (this.index < this.length() - 1) this.index++
    this.clampScroll()
  }

  pageUp(): void {
    this.index = Math.max(0, this.index - this.maxVisible)
    this.clampScroll()
  }

  pageDown(): void {
    this.index = Math.max(0, Math.min(this.length() - 1, this.index + this.maxVisible))
    this.clampScroll()
  }

  setIndex(index: number): void {
    this.index = Math.max(0, Math.min(this.length() - 1, index))
    this.clampScroll()
  }

  private clampScroll(): void {
    if (this.index < this.scroll) this.scroll = this.index
    else if (this.index >= this.scroll + this.maxVisible) this.scroll = this.index - this.maxVisible + 1
  }
}

/** Render the ▸/spaces row marker for the selected row. */
export function rowMarker(selected: boolean): string {
  return selected ? '▸ ' : '  '
}

/** Scroll info suffix, e.g. ` (3/40)` — only when the list overflows. */
export function scrollInfo(controller: ListController, length: number): string {
  return length > controller.maxVisible ? ` (${controller.index + 1}/${length})` : ''
}

/** Shared theme fns used by every panel (fg color wrappers). */
export interface PanelThemeFns {
  accent(text: string): string
  muted(text: string): string
  subtle(text: string): string
  attention(text: string): string
  /** Success green — e.g. an enabled state in a toggle list. */
  success(text: string): string
}

/** Build the standard fg wrappers from a TuiTheme. */
export function panelThemeFns(theme: TuiTheme): PanelThemeFns {
  const fg = (hex: string) => (text: string) => ansiFg(hex) + text + RESET
  return {
    accent: fg(theme.palette.accent),
    muted: fg(theme.palette.fgMuted),
    subtle: fg(theme.palette.fgSubtle),
    attention: fg(theme.palette.attention),
    success: fg(theme.palette.success),
  }
}

/** Shared navigation keys; returns true when `data` was consumed. */
export function handleListKeys(data: string, controller: ListController, length: number): boolean {
  const kb = getKeybindings()
  if (kb.matches(data, 'tui.select.up')) {
    controller.up()
    return true
  }
  if (kb.matches(data, 'tui.select.down')) {
    controller.down()
    return true
  }
  if (kb.matches(data, 'tui.select.pageUp')) {
    controller.pageUp()
    return true
  }
  if (kb.matches(data, 'tui.select.pageDown')) {
    controller.pageDown()
    return true
  }
  return false
}

/** Options for a TablePanel. */
export interface TablePanelOptions<T> {
  columns: readonly TableColumn[]
  rows: readonly T[]
  /** Cell text for one row/column pair (plain text, clipped+padded by us). */
  renderCell(row: T, column: TableColumn): string
  onSelect(row: T): void
  onCancel(): void
  footer?: string
  preselect?: number
}

/**
 * A self-drawn table panel: header row, aligned data rows, navigation with
 * viewport clamping, selection highlight, scroll info and a footer hint.
 */
export class TablePanel<T> implements Component {
  private readonly theme: TuiTheme
  private readonly options: TablePanelOptions<T>
  private readonly controller: ListController

  constructor(theme: TuiTheme, options: TablePanelOptions<T>) {
    this.theme = theme
    this.options = options
    this.controller = new ListController(() => options.rows.length)
    if (options.preselect !== undefined) this.controller.setIndex(options.preselect)
  }

  invalidate(): void {}

  render(width: number): string[] {
    const fns = panelThemeFns(this.theme)
    const { columns, rows, renderCell, footer } = this.options
    const widths = columnWidths(width, columns)
    const seps = columns.length > 1 ? TABLE_SEP : ''
    const lines: string[] = []

    const header = `${' '.repeat(MARKER_W)}${columns
      .map((column, i) => padCell(column.title, widths[i], column.align))
      .join(seps)}`
    lines.push(fns.subtle(header))

    const controller = this.controller
    for (let i = controller.scroll; i < Math.min(rows.length, controller.scroll + controller.maxVisible); i++) {
      const row = rows[i]
      const selected = i === controller.index
      const cells = columns
        .map((column, j) => padCell(renderCell(row, column), widths[j], column.align))
        .join(seps)
      const line = `${rowMarker(selected)}${cells}`
      lines.push(selected ? fns.accent(BOLD + line + RESET) : fns.muted(line))
    }

    lines.push('')
    lines.push(fns.subtle(clipToWidth(`${footer ?? '↑↓ navigate · Enter select · Esc back'}${scrollInfo(controller, rows.length)}`, width)))
    return lines
  }

  handleInput(data: string): void {
    const controller = this.controller
    if (handleListKeys(data, controller, this.options.rows.length)) return
    const kb = getKeybindings()
    if (kb.matches(data, 'tui.select.confirm')) {
      this.options.onSelect(this.options.rows[controller.index])
    } else if (kb.matches(data, 'tui.select.cancel')) {
      this.options.onCancel()
    }
  }
}

/** One field row of a FieldPanel. */
export interface FieldRow {
  key: string
  value: string
  editable?: boolean
}

/** Options for a FieldPanel. */
export interface FieldPanelOptions {
  /** First line (may carry ANSI styling, e.g. a colored title). */
  title: string
  /** Read-only content block between the title and the field rows. */
  content?: readonly string[]
  fields: readonly FieldRow[]
  onEdit(index: number): void
  onCancel(): void
  footer?: string
  /** Single-key shortcuts (e.g. m/t/d) mapped to the same actions. */
  shortcuts?: Readonly<Record<string, () => void>>
  /** Live status line (attention-colored) shown above the footer. */
  status?: () => string | undefined
}

/**
 * A field panel: title, an optional read-only content block, navigable
 * editable field rows (Enter edits the focused row), shortcuts, a status
 * line and a footer hint.
 */
export class FieldPanel implements Component {
  private readonly theme: TuiTheme
  private readonly options: FieldPanelOptions
  private readonly controller: ListController
  private readonly keyWidth: number

  constructor(theme: TuiTheme, options: FieldPanelOptions) {
    this.theme = theme
    this.options = options
    this.controller = new ListController(() => options.fields.length)
    this.keyWidth = Math.max(...options.fields.map(field => visibleWidth(field.key)), 1)
  }

  invalidate(): void {}

  render(width: number): string[] {
    const fns = panelThemeFns(this.theme)
    const { title, content, fields, footer, status } = this.options
    const wrap = Math.max(2, width - 2)
    const lines: string[] = [title]
    if (content !== undefined) {
      lines.push('')
      for (const line of content) {
        lines.push(fns.muted(clipToWidth(line === '' ? ' ' : line, wrap)))
      }
    }
    lines.push('')

    const controller = this.controller
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]
      const selected = i === controller.index
      const marker = rowMarker(selected)
      const key = padCell(field.key, this.keyWidth)
      const value = clipToWidth(field.value, wrap - MARKER_W - this.keyWidth - 3)
      const line = `${marker}${key}${field.editable === false ? '' : ' ✎ '}${value}`
      if (selected) {
        lines.push(fns.accent(BOLD + line + RESET))
      } else {
        const headW = MARKER_W + this.keyWidth + (field.editable === false ? 0 : 3)
        lines.push(`${fns.muted(line.slice(0, headW))}${fns.subtle(line.slice(headW))}`)
      }
    }

    const statusLine = status?.()
    if (statusLine !== undefined) {
      lines.push('')
      lines.push(fns.attention(clipToWidth(statusLine, wrap)))
    }
    lines.push('')
    lines.push(fns.subtle(clipToWidth(footer ?? '↑↓ field · Enter edit · Esc back', wrap)))
    return lines
  }

  handleInput(data: string): void {
    const controller = this.controller
    if (handleListKeys(data, controller, this.options.fields.length)) return
    const shortcut = this.options.shortcuts?.[data.toLowerCase()]
    if (shortcut !== undefined) {
      shortcut()
      return
    }
    const kb = getKeybindings()
    if (kb.matches(data, 'tui.select.confirm')) {
      this.options.onEdit(controller.index)
    } else if (kb.matches(data, 'tui.select.cancel')) {
      this.options.onCancel()
    }
  }
}

/** Options for a ViewerPanel. */
export interface ViewerPanelOptions {
  title: string
  lines: readonly string[]
  /** Maximum rendered lines (default 40); overflow is reported. */
  maxLines?: number
  footer?: string
  onClose(): void
}

/** A read-only line viewer with a line cap (Esc/Enter closes). */
export class ViewerPanel implements Component {
  private readonly theme: TuiTheme
  private readonly options: ViewerPanelOptions

  constructor(theme: TuiTheme, options: ViewerPanelOptions) {
    this.theme = theme
    this.options = options
  }

  invalidate(): void {}

  render(width: number): string[] {
    const fns = panelThemeFns(this.theme)
    const { title, lines, maxLines = 40, footer } = this.options
    const wrap = Math.max(2, width - 2)
    const out: string[] = [
      fns.accent(BOLD + clipToWidth(title, wrap) + RESET),
      '',
    ]
    for (const line of lines.slice(0, maxLines)) {
      out.push(fns.muted(clipToWidth(line === '' ? ' ' : line, wrap)))
    }
    if (lines.length > maxLines) {
      out.push(fns.subtle(clipToWidth(`… ${lines.length - maxLines} more line(s)`, wrap)))
    }
    out.push('')
    out.push(fns.subtle(footer ?? '  Esc to close'))
    return out
  }

  handleInput(data: string): void {
    const kb = getKeybindings()
    if (kb.matches(data, 'tui.select.cancel') || kb.matches(data, 'tui.select.confirm')) {
      this.options.onClose()
    }
  }
}

/** One row of a SettingsListPanel. */
export interface SettingsRow {
  id: string
  /** Display label (left side; also the search text). */
  label: string
  /** Current value to display (right side). */
  value: string
  /** Optional description shown under the selected row. */
  description?: string
  /** Cycle-eligible rows: Enter advances to the next value, then onChange. */
  values?: string[]
  /** Rows with an action: Enter opens the submenu (rendered in place). */
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component
}

/** Options for a SettingsListPanel. */
export interface SettingsListPanelOptions {
  /** Header line, rendered accent BOLD. */
  title: string
  rows: readonly SettingsRow[]
  /** Called when a cycle row advances (id + new value). */
  onChange?: (id: string, newValue: string) => void
  onCancel(): void
  footer?: string
  /** Inline type-to-filter on the label; Esc clears the filter before popping. */
  enableSearch?: boolean
  /** Visible rows before scrolling (default 10). */
  maxVisible?: number
}

/**
 * Filter settings rows by a fuzzy query on the label — the same matching the
 * old pi-tui SettingsList used, so search behavior is preserved (case-
 * insensitive, whitespace/slash-separated tokens, best-match-first order).
 * An empty query returns all rows unchanged.
 */
export function filterSettingsRows(rows: readonly SettingsRow[], query: string): SettingsRow[] {
  return fuzzyFilter([...rows], query, row => row.label)
}

/** Single printable keystroke (filter accumulation); excludes DEL/control. */
function isPrintable(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 0x20 && data.charCodeAt(0) !== 0x7f
}

/**
 * A searchable list panel in the FW style — the native replacement for the
 * /settings browser's pi-tui SettingsList. Renders an accent BOLD title, then
 * aligned label/value rows with whole-row selection (accent BOLD when
 * selected, muted otherwise), an optional inline type-to-filter (like the
 * Skills panel), the selected row's description and a footer with scroll
 * info. Submenus render in place (the same nested-overlay model as the old
 * SettingsList), so the browser keeps a single framed overlay for the whole
 * flow. Rows never paint their own background — the FramedOverlay fills the
 * canvasSubtle backdrop.
 */
export class SettingsListPanel implements Component {
  private readonly theme: TuiTheme
  private readonly options: SettingsListPanelOptions
  private readonly controller: ListController
  private readonly rows: SettingsRow[]
  private filterQuery = ''
  private submenu: Component | undefined
  private submenuIndex = 0

  constructor(theme: TuiTheme, options: SettingsListPanelOptions) {
    this.theme = theme
    this.options = options
    this.rows = [...options.rows]
    this.controller = new ListController(() => this.filtered().length, options.maxVisible ?? 10)
  }

  invalidate(): void {
    this.submenu?.invalidate()
  }

  /** Update one row's displayed value by id (the browser refreshes after writes). */
  updateValue(id: string, newValue: string): void {
    const row = this.rows.find(row => row.id === id)
    if (row !== undefined) row.value = newValue
  }

  /** The rows after the active filter query (label-only fuzzy match). */
  private filtered(): SettingsRow[] {
    return filterSettingsRows(this.rows, this.options.enableSearch === true ? this.filterQuery : '')
  }

  render(width: number): string[] {
    if (this.submenu !== undefined) return this.submenu.render(width)
    const fns = panelThemeFns(this.theme)
    const { title, footer, enableSearch } = this.options
    const wrap = Math.max(2, width - 2)
    const lines: string[] = [
      fns.accent(BOLD + clipToWidth(title, wrap) + RESET),
      '',
    ]
    const rows = this.filtered()
    if (rows.length === 0) {
      lines.push(fns.muted('  No matching settings'))
      lines.push('')
      lines.push(fns.subtle(clipToWidth(this.hint(footer, enableSearch === true), wrap)))
      return lines
    }

    const controller = this.controller
    // Align the value column across all rows (stable under filtering); the
    // label column takes what the marker, value and separator leave over.
    const valueWidth = Math.min(28, Math.max(...this.rows.map(row => visibleWidth(row.value)), 0))
    const labelWidth = Math.max(4, wrap - MARKER_W - valueWidth - 2)
    for (let i = controller.scroll; i < Math.min(rows.length, controller.scroll + controller.maxVisible); i++) {
      const row = rows[i]
      const selected = i === controller.index
      const line = clipToWidth(
        `${rowMarker(selected)}${padCell(row.label, labelWidth)}  ${padCell(row.value, valueWidth)}`,
        wrap,
      )
      lines.push(selected ? fns.accent(BOLD + line + RESET) : fns.muted(line))
    }

    const selectedRow = rows[controller.index]
    if (selectedRow?.description !== undefined && selectedRow.description !== '') {
      lines.push(fns.subtle(clipToWidth(`  ${selectedRow.description}`, wrap)))
    }
    lines.push('')
    lines.push(fns.subtle(clipToWidth(
      this.hint(footer, enableSearch === true) + scrollInfo(controller, rows.length),
      wrap,
    )))
    return lines
  }

  handleInput(data: string): void {
    if (this.submenu !== undefined) {
      this.submenu.handleInput?.(data)
      return
    }
    const kb = getKeybindings()
    if (kb.matches(data, 'tui.select.cancel')) {
      // Esc with an active filter clears it first; a second Esc pops back.
      if (this.filterQuery !== '') {
        this.filterQuery = ''
        this.controller.setIndex(0)
        return
      }
      this.options.onCancel()
      return
    }
    if (handleListKeys(data, this.controller, this.filtered().length)) return
    if (kb.matches(data, 'tui.select.confirm')) {
      this.activateRow()
      return
    }
    // Space confirms like Enter, unless it continues an active search query.
    if (data === ' ') {
      if (this.options.enableSearch === true && this.filterQuery !== '') {
        this.filterQuery += ' '
        this.controller.setIndex(0)
        return
      }
      this.activateRow()
      return
    }
    if (this.options.enableSearch !== true) return
    if (data === '\x7f' || matchesKey(data, 'backspace')) {
      if (this.filterQuery !== '') {
        this.filterQuery = this.filterQuery.slice(0, -1)
        this.controller.setIndex(0)
      }
      return
    }
    if (isPrintable(data)) {
      this.filterQuery += data
      this.controller.setIndex(0)
    }
  }

  /** Open a row's submenu in place, or advance a cycle row. */
  private activateRow(): void {
    const rows = this.filtered()
    const row = rows[this.controller.index]
    if (row === undefined) return
    if (row.submenu !== undefined) {
      this.submenuIndex = this.controller.index
      this.submenu = row.submenu(row.value, selectedValue => {
        if (selectedValue !== undefined) {
          row.value = selectedValue
          this.options.onChange?.(row.id, selectedValue)
        }
        this.closeSubmenu()
      })
      return
    }
    if (row.values !== undefined && row.values.length > 0) {
      const current = row.values.indexOf(row.value)
      const next = (current + 1) % row.values.length
      row.value = row.values[next]
      this.options.onChange?.(row.id, row.value)
    }
  }

  private closeSubmenu(): void {
    this.submenu = undefined
    this.controller.setIndex(this.submenuIndex)
  }

  /** Base footer hint; swaps to the filter hint while a query is active. */
  private hint(footer: string | undefined, searchable: boolean): string {
    if (this.filterQuery !== '') return `Filter: ${this.filterQuery} · Backspace clear · Esc clear filter`
    return footer ?? (searchable
      ? '↑↓ navigate · Enter select · Type to search · Esc back'
      : '↑↓ navigate · Enter select · Esc back')
  }
}

/** Overlay size literal accepted by `TUI.showOverlay`. */
export type PanelSize = number | `${number}%`

/**
 * Overlay lifecycle for one interactive flow: swap overlays (show the next
 * before hiding the previous — no focus flash), tear down cleanly on a
 * showOverlay failure, and hand the keyboard back through `onError` when a
 * half-mounted overlay must not strand it.
 */
export class PanelHost {
  private readonly tui: TUI
  private readonly theme: TuiTheme
  private readonly onError: ((message: string) => void) | undefined
  private current: OverlayHandle | undefined

  constructor(tui: TUI, theme: TuiTheme, onError?: (message: string) => void) {
    this.tui = tui
    this.theme = theme
    this.onError = onError
  }

  /** Show `component`, hiding the previous overlay. Returns undefined on failure. */
  open(component: Component, width: PanelSize = '80%', maxHeight: PanelSize = '80%'): OverlayHandle | undefined {
    let next: OverlayHandle
    try {
      next = this.tui.showOverlay(wrapFramedOverlay(this.theme, component), { width, maxHeight })
    } catch (error) {
      this.close()
      this.onError?.(error instanceof Error ? error.message : String(error))
      return undefined
    }
    this.current?.hide()
    this.current = next
    return next
  }

  close(): void {
    this.current?.hide()
    this.current = undefined
  }
}
