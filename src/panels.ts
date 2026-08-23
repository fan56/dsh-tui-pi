/**
 * Reusable select-panel framework — the shared building blocks behind every
 * picker/browser overlay in this TUI (the /settings browser, the /model,
 * /resume, /theme, /permission and skill pickers, the agents table, field
 * windows and viewers).
 *
 * Every panel speaks ONE table language (the TodosPanel look, minus the
 * index column): an accent BOLD title, an UPPERCASE subtle header row, a
 * `─┼─` rule under it with junctions exactly under the `│` column
 * separators, width-exact padded cells so rows and columns align, and the
 * ▸ marker + accent BOLD selection.
 *
 * What lives here:
 *
 * - `padCell` / `columnWidths` / `fitColumnWidth` — width-exact table cells
 *   (clip-with-ellipsis + pad by VISIBLE columns, CJK-safe), fixed+flex
 *   column layout, and content-fitted fixed columns. Cells are padded so
 *   columns align even when row content has different widths — the classic
 *   "table rows are misaligned" bug is a missing pad, not a missing clip.
 * - `tableHeaderLine` / `tableRuleLine` — the shared header + rule rows.
 * - `ListController` — pure navigation state (index/scroll/viewport) with
 *   up/down/pageUp/pageDown and viewport clamping; unit-testable, reused by
 *   every panel.
 * - `TablePanel` — a self-drawn table: optional title, header row + rule,
 *   data rows, navigation, scroll info, selection highlight.
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
import { clipToWidth, ELLIPSIS, visibleWidth } from './text.ts'

/** Row marker slot width (▸ or two spaces). */
export const MARKER_W = 2

/** Column separator between table cells (box-drawing, matches the frame). */
export const TABLE_SEP = ' │ '

/** Minimum visible width of the flex column. */
const MIN_FLEX_WIDTH = 8

/**
 * Clip `text` to `width` visible columns, whole graphemes only — a cell that
 * loses content always ends with `…` so the cut is visible (clipToWidth
 * alone fills the full width and drops the ellipsis whenever every column
 * was consumed).
 */
function clipCell(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text
  const clipped = clipToWidth(text, width)
  if (clipped.endsWith(ELLIPSIS)) return clipped
  const shorter = clipToWidth(text, width - 1)
  if (shorter.endsWith(ELLIPSIS)) return shorter
  return shorter === '' ? clipped : shorter + ELLIPSIS
}

/**
 * Clip `text` to `width` visible columns and pad it with spaces to exactly
 * `width` columns — the width-exact cell primitive. `align` controls where
 * the padding goes.
 */
export function padCell(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const clipped = clipCell(text, width)
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

/**
 * Width for a fixed (non-flex) column fitted to its content: the widest of
 * the uppercased header title and every cell, capped at `cap` (cells clip
 * beyond it). The FW table look for short enumerated columns (providers,
 * dates, state icons) whose width is only known at call time.
 */
export function fitColumnWidth(title: string, cells: readonly string[], cap: number): number {
  const widest = Math.max(
    visibleWidth(title.toUpperCase()),
    ...cells.map(cell => visibleWidth(cell)),
  )
  return Math.min(cap, Math.max(1, widest))
}

/** One column spec of the auto table layout (see `autoColumns`). */
export interface AutoColumnSpec {
  key: string
  title: string
  /** Width cap for this fitted column (the flex last column ignores it). */
  cap?: number
  align?: 'left' | 'right'
}

/**
 * The FW auto table layout: every column EXCEPT the last is fitted to the
 * widest of its uppercase title and all row cells (capped); the last column
 * is flex — it runs to the right edge and clips (never wraps). One policy
 * for every picker table: separators hug the content, the tail column takes
 * the remainder.
 */
export function autoColumns<T>(
  specs: readonly AutoColumnSpec[],
  rows: readonly T[],
  cell: (row: T, key: string) => string,
): TableColumn[] {
  return specs.map((spec, index) => {
    if (index === specs.length - 1) return { key: spec.key, title: spec.title, flex: true }
    const width = fitColumnWidth(
      spec.title,
      rows.map(row => cell(row, spec.key)),
      spec.cap ?? Number.POSITIVE_INFINITY,
    )
    return { key: spec.key, title: spec.title, width, ...(spec.align !== undefined ? { align: spec.align } : {}) }
  })
}

/**
 * The table header line every panel shares: the row-marker slot, then the
 * UPPERCASE column titles padded to their widths and joined by the column
 * separator. Plain text — the caller paints it subtle.
 */
export function tableHeaderLine(columns: readonly TableColumn[], widths: readonly number[]): string {
  return ' '.repeat(MARKER_W) + columns
    .map((column, i) => padCell(column.title.toUpperCase(), widths[i], column.align))
    .join(TABLE_SEP)
}

/**
 * A horizontal table rule: `─` runs per column joined at the separators.
 * The junction character depends on position — `┬` for the TOP rule (the
 * column separators continue down from it), `┼` for the MID rule under the
 * header (separators cross it), `┴` for the BOTTOM rule (separators end
 * into it). Same layout as `tableHeaderLine` (marker slot,
 * separator-spanning junctions), so it must be derived from the same widths.
 */
export function tableRuleLine(widths: readonly number[], junction: '┬' | '┼' | '┴' = '┼'): string {
  return ' '.repeat(MARKER_W) + widths.map(width => '─'.repeat(width)).join(`─${junction}─`)
}

/** Pure navigation state shared by all panels (unit-testable). */
export class ListController {
  index = 0
  scroll = 0
  readonly maxVisible: number
  private readonly length: () => number
  private readonly selectable: ((index: number) => boolean) | undefined

  constructor(
    length: () => number,
    maxVisible = 12,
    selectable?: (index: number) => boolean,
  ) {
    this.length = length
    this.maxVisible = maxVisible
    this.selectable = selectable
  }

  up(): void {
    this.moveTo(this.index - 1, -1)
  }

  down(): void {
    this.moveTo(this.index + 1, 1)
  }

  pageUp(): void {
    this.moveTo(Math.max(0, this.index - this.maxVisible), -1)
  }

  pageDown(): void {
    this.moveTo(Math.min(this.length() - 1, this.index + this.maxVisible), 1)
  }

  setIndex(index: number): void {
    this.moveTo(index, -1)
  }

  /**
   * Move to `target` clamped into range, snapping onto the nearest selectable
   * row: scan from the target toward `fallbackDir`, then the other way. This
   * keeps the cursor off unselectable rows (dividers, section headers) — a
   * list with no selectable row at all keeps the cursor where it is.
   */
  private moveTo(target: number, fallbackDir: 1 | -1): void {
    const len = this.length()
    if (len === 0) {
      this.index = 0
      this.clampScroll()
      return
    }
    const clamped = Math.max(0, Math.min(len - 1, target))
    const otherDir: 1 | -1 = fallbackDir === 1 ? -1 : 1
    this.index = this.scan(clamped, fallbackDir) ?? this.scan(clamped, otherDir) ?? this.index
    this.clampScroll()
  }

  /** Nearest selectable index scanning from `start` toward `dir`; undefined when none. */
  private scan(start: number, dir: 1 | -1): number | undefined {
    const len = this.length()
    for (let i = start; i >= 0 && i < len; i += dir) {
      if (this.selectable?.(i) ?? true) return i
    }
    return undefined
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
  /** Optional accent BOLD title line above the table (the FW panel look). */
  title?: string
  footer?: string
  preselect?: number
  /** Visible rows before scrolling (default 12). */
  maxVisible?: number
  /** Single-key shortcuts mapped to actions (checked after navigation, before confirm/cancel). */
  shortcuts?: Readonly<Record<string, () => void>>
  /** Rows the cursor may rest on (default: every row). Unselectable rows are skipped by navigation. */
  isSelectable?: (row: T) => boolean
  /**
   * Full-width replacement line for structural rows (divider, section header).
   * Returning a string renders exactly that line (clipped); returning
   * undefined falls through to the normal cell rendering.
   */
  specialRow?: (row: T, width: number) => string | undefined
  /** Rows rendered in the dimmer subtle color instead of muted (e.g. hidden models). */
  dimRow?: (row: T) => boolean
  /**
   * Live substring filter owned by the caller: `/` engages a single-line
   * input inside the panel; every keystroke lands in `onQueryChange` (the
   * caller rebuilds `rows`), Enter confirms and leaves input mode, Esc clears
   * the query. The query itself is session-local — the panel never persists it.
   */
  filter?: {
    getQuery(): string
    onQueryChange(query: string): void
  }
  /** Live status line (attention-colored) shown above the footer. */
  status?: () => string | undefined
}

/**
 * A self-drawn table panel: optional title, an uppercase header row with the
 * `─┼─` rule under it, aligned data rows with column separators, navigation
 * with viewport clamping, selection highlight, scroll info and a footer hint.
 */
export class TablePanel<T> implements Component {
  private readonly theme: TuiTheme
  private readonly options: TablePanelOptions<T>
  private readonly controller: ListController
  /** True while the filter input line owns the keyboard (see `options.filter`). */
  private filterInput = false

  constructor(theme: TuiTheme, options: TablePanelOptions<T>) {
    this.theme = theme
    this.options = options
    const isSelectable = options.isSelectable
    this.controller = new ListController(
      () => options.rows.length,
      options.maxVisible ?? 12,
      isSelectable === undefined
        ? undefined
        : (index) => {
            const row = options.rows[index]
            return row !== undefined && isSelectable(row)
          },
    )
    if (options.preselect !== undefined) this.controller.setIndex(options.preselect)
  }

  invalidate(): void {}

  /** The row under the cursor (undefined on an empty table). */
  selectedRow(): T | undefined {
    return this.options.rows[this.controller.index]
  }

  /**
   * Move the cursor onto the first row matching `predicate`. Returns whether
   * a row matched — callers use the miss to fall back to `resyncCursor`
   * (e.g. the toggled row vanished from the rebuilt list).
   */
  focusRow(predicate: (row: T) => boolean): boolean {
    const index = this.options.rows.findIndex(predicate)
    if (index < 0) return false
    this.controller.setIndex(index)
    return true
  }

  /**
   * Re-clamp the cursor after an out-of-band rows swap (the caller reassigns
   * `options.rows`): keeps it in range and on a selectable row.
   */
  resyncCursor(): void {
    this.controller.setIndex(this.controller.index)
  }

  render(width: number): string[] {
    const fns = panelThemeFns(this.theme)
    const { columns, rows, renderCell, footer, title, specialRow, dimRow } = this.options
    // Reserve the row-marker slot so marker + cells never exceed `width`
    // (the old pass-through lost the last 2 columns of right padding).
    const widths = columnWidths(width - MARKER_W, columns)
    const seps = columns.length > 1 ? TABLE_SEP : ''
    const lines: string[] = []
    if (title !== undefined) lines.push(fns.accent(BOLD + clipToWidth(title, width) + RESET))

    // The booktabs trio seals the table: TOP rule (┬) directly under the
    // title, header, MID rule (┼), rows, BOTTOM rule (┴). A single-column
    // table gets the same rules minus the junctions.
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┬'), width)))
    lines.push(fns.subtle(clipToWidth(tableHeaderLine(columns, widths), width)))
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┼'), width)))

    const controller = this.controller
    for (let i = controller.scroll; i < Math.min(rows.length, controller.scroll + controller.maxVisible); i++) {
      const row = rows[i]
      // Structural rows render their full-width replacement line — never a
      // selection marker, never cell columns.
      if (specialRow !== undefined) {
        const special = specialRow(row, width)
        if (special !== undefined) {
          lines.push(fns.subtle(clipToWidth(special, width)))
          continue
        }
      }
      const selected = i === controller.index
      const cells = columns
        .map((column, j) => padCell(renderCell(row, column), widths[j], column.align))
        .join(seps)
      const line = clipToWidth(`${rowMarker(selected)}${cells}`, width)
      lines.push(selected
        ? fns.accent(BOLD + line + RESET)
        : dimRow?.(row) === true ? fns.subtle(line) : fns.muted(line))
    }
    // An empty body (e.g. an applied filter matching nothing) renders a hint
    // row between the rules instead of a blank gap.
    if (rows.length === 0) lines.push(fns.muted(clipToWidth('  No matching models', width)))
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┴'), width)))

    // Filter state: an engaged input line shows the live query; an applied
    // query stays visible as a reminder until cleared.
    const query = this.options.filter?.getQuery() ?? ''
    if (this.filterInput) {
      lines.push(fns.accent(BOLD + clipToWidth(`Filter: ${query}_`, width) + RESET))
    } else if (query !== '') {
      lines.push(fns.attention(clipToWidth(`Filter: ${query}`, width)))
    }
    // Transient status message (e.g. a failed pref write), FieldPanel-style.
    const statusLine = this.options.status?.()
    if (statusLine !== undefined) lines.push(fns.attention(clipToWidth(statusLine, width)))

    lines.push('')
    const footerLine = this.filterInput
      ? 'Enter apply · Esc clear filter'
      : `${footer ?? '↑↓ navigate · Enter select · Esc back'}${scrollInfo(controller, rows.length)}`
    lines.push(fns.subtle(clipToWidth(footerLine, width)))
    return lines
  }

  handleInput(data: string): void {
    const kb = getKeybindings()
    // The engaged filter input owns the keyboard: printable keys accumulate
    // into the live query, Enter confirms and leaves input mode, Esc clears
    // the whole query. Navigation and shortcuts stay suspended meanwhile.
    if (this.filterInput) {
      const query = this.options.filter?.getQuery() ?? ''
      if (kb.matches(data, 'tui.select.confirm')) {
        this.filterInput = false
      } else if (kb.matches(data, 'tui.select.cancel')) {
        this.filterInput = false
        this.options.filter?.onQueryChange('')
      } else if (data === '\x7f' || matchesKey(data, 'backspace')) {
        this.options.filter?.onQueryChange(query.slice(0, -1))
      } else if (isPrintable(data)) {
        this.options.filter?.onQueryChange(query + data)
      }
      return
    }
    const controller = this.controller
    if (handleListKeys(data, controller, this.options.rows.length)) return
    if (this.options.filter !== undefined && data === '/') {
      this.filterInput = true
      return
    }
    if (kb.matches(data, 'tui.select.cancel')) {
      // Esc with an applied filter clears it first (same contract as
      // SettingsListPanel); a second Esc pops the panel.
      const filter = this.options.filter
      if (filter !== undefined && filter.getQuery() !== '') {
        filter.onQueryChange('')
        this.resyncCursor()
        return
      }
      this.options.onCancel()
      return
    }
    const shortcut = this.options.shortcuts?.[data.toLowerCase()]
    if (shortcut !== undefined) {
      shortcut()
      return
    }
    if (kb.matches(data, 'tui.select.confirm')) {
      const row = this.options.rows[controller.index]
      if (row !== undefined) this.options.onSelect(row)
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
      lines.push('')
    }

    // The FW table look: the booktabs trio (TOP ┬ / header / MID ┼ /
    // fields / BOTTOM ┴) with the │ separator on every row; the ✎
    // affordance rides at the head of the value cell.
    const columns: readonly TableColumn[] = [
      { key: 'field', title: 'Field', width: this.keyWidth },
      { key: 'value', title: 'Value', flex: true },
    ]
    const widths = columnWidths(wrap - MARKER_W, columns)
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┬'), wrap)))
    lines.push(fns.subtle(clipToWidth(tableHeaderLine(columns, widths), wrap)))
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┼'), wrap)))

    const controller = this.controller
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]
      const selected = i === controller.index
      const keyCell = padCell(field.key, widths[0])
      const rawValue = field.editable === false ? field.value : `✎ ${field.value}`
      const valueCell = padCell(clipToWidth(rawValue, widths[1]), widths[1])
      const line = clipToWidth(`${rowMarker(selected)}${keyCell}${TABLE_SEP}${valueCell}`, wrap)
      lines.push(selected ? fns.accent(BOLD + line + RESET) : fns.muted(line))
    }
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┴'), wrap)))

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
    ]
    const rows = this.filtered()
    if (rows.length === 0) {
      lines.push(fns.muted('  No matching settings'))
      lines.push('')
      lines.push(fns.subtle(clipToWidth(this.hint(footer, enableSearch === true), wrap)))
      return lines
    }
    // The FW table look: the │ column separator on every row (the old
    // two-space gap made the value column read as floating text) under the
    // AUTO table layout — the SETTING column fits its content, the VALUE
    // column runs to the right edge and clips (never wraps). Rows whose
    // values are ALL empty (menu-only lists) collapse to a single label
    // column — no empty value column, no separator, no junctions.
    const showValue = this.rows.some(row => row.value !== '')
    const usable = wrap - MARKER_W
    const columns: readonly TableColumn[] = showValue
      ? autoColumns(
          [
            // The label may not starve the value column below its flex floor.
            { key: 'label', title: 'Setting', cap: Math.max(4, usable - visibleWidth(TABLE_SEP) - MIN_FLEX_WIDTH) },
            { key: 'value', title: 'Value' },
          ],
          this.rows,
          (row, key) => (key === 'value' ? row.value : row.label),
        )
      : [{ key: 'label', title: 'Setting', flex: true }]
    const widths = columnWidths(wrap - MARKER_W, columns)
    const seps = columns.length > 1 ? TABLE_SEP : ''
    // The booktabs trio seals the table right under the title (no gap row):
    // TOP rule (┬), header, MID rule (┼), rows, BOTTOM rule (┴).
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┬'), wrap)))
    lines.push(fns.subtle(clipToWidth(tableHeaderLine(columns, widths), wrap)))
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┼'), wrap)))

    const controller = this.controller
    for (let i = controller.scroll; i < Math.min(rows.length, controller.scroll + controller.maxVisible); i++) {
      const row = rows[i]
      const selected = i === controller.index
      const cells = columns.map((column, j) =>
        padCell(column.key === 'label' ? row.label : row.value, widths[j]))
      const line = clipToWidth(`${rowMarker(selected)}${cells.join(seps)}`, wrap)
      lines.push(selected ? fns.accent(BOLD + line + RESET) : fns.muted(line))
    }
    lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┴'), wrap)))

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
