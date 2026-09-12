/**
 * Theme picker's live preview pane: a mock chat page rendered with the
 * SELECTED theme's palette, so the user sees what the TUI will look like
 * before committing to a theme. The left list (a TablePanel) owns the
 * keyboard; every selection change calls `setPalette` and the pane repaints
 * in the selected theme. `auto` (no fixed palette) shows a hint instead of
 * a mock page.
 *
 * The pane is a self-drawn component (like ThinkPanel/ToolPanel): every row
 * is painted with a full-width `ansiBg` backdrop, so surfaces (bubbles,
 * think/tool panels, code blocks, the input dock) read as solid blocks in
 * the theme's real colors — the same canvas the live TUI paints.
 */

import type { Component } from '@earendil-works/pi-tui'
import { HStack, VStack } from '@earendil-works/pi-tui'
import { TablePanel } from './panels.ts'
import { ansiBg, ansiFg, BOLD, buildTheme, RESET, type ThemePreference, type TuiTheme } from './theme/index.ts'
import { githubDark, githubLight, type Palette } from './theme/palette.ts'
import { visibleWidth } from './text.ts'

/**
 * Paint one full-width row: `content` (which may carry its own SGR) on the
 * `bg` backdrop, with `bg` re-applied after any mid-line RESET and trailing
 * padding kept on the backdrop (frame.ts fillLine's pattern, but on an
 * arbitrary palette surface).
 */
function fill(bg: string, content: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(content))
  const prefix = ansiBg(bg)
  const guarded = content.replace(/\x1b\[0m/g, `\x1b[0m${prefix}`)
  return prefix + guarded + prefix + ' '.repeat(pad) + RESET
}

/**
 * One mock chat page row. `surface` is the palette surface to paint the row
 * on; `content` is the styled text (already carrying its foreground SGR).
 */
function surfaceRow(surface: string, content: string, width: number): string {
  return fill(surface, content, width)
}

/** A mock chat page built from a palette. Fixed row count for the budget. */
export class ThemePreviewPane implements Component {
  private row: ThemePickerRow | undefined
  private readonly getTheme: () => TuiTheme

  /** `getTheme` is the CURRENT active TuiTheme (used when `auto` is selected). */
  constructor(getTheme: () => TuiTheme) {
    this.getTheme = getTheme
  }

  /** Switch the preview to a theme row; `undefined` (auto) shows the hint. */
  setRow(row: ThemePickerRow | undefined): void {
    this.row = row
  }

  /** The palette the mock page currently renders with (for tests). */
  currentPalette(): Palette | undefined {
    return this.row?.palette
  }

  invalidate(): void {}

  render(width: number): string[] {
    const row = this.row
    if (row === undefined || row.palette === undefined) return this.renderAuto(width)
    const p = buildTheme(row.palette).palette
    const fg = (hex: string, text: string) => ansiFg(hex) + text + RESET
    const bold = (hex: string, text: string) => ansiFg(hex) + BOLD + text + RESET
    const canvas = (content: string) => surfaceRow(p.canvas, content, width)
    const lines: string[] = []

    // Title bar: the theme label + its description, accent-tinted, on the
    // inset surface (the description carries the "GitHub light palette" /
    // "GitHub dark palette" text the e2e suite asserts).
    const title = `${row.label} — ${row.description}`
    lines.push(surfaceRow(p.canvasInset, ` ${bold(p.accent, title)} `, width))
    lines.push(canvas(''))

    // User message bubble (canvasSubtle backdrop + fgDefault text).
    lines.push(canvas(` ${fg(p.fgDefault, '▎帮我分析这段代码')} `))

    // Think panel (its own purple surface + italic thinking text).
    lines.push(surfaceRow(p.thinkingPanelBg, ` ${bold(p.thinking, 'thinking')}`, width))
    lines.push(surfaceRow(p.thinkingPanelBg, ` ${fg(p.fgMuted, '让我看看这段代码……')}`, width))
    lines.push(canvas(''))

    // Tool card (blue surface + accent tool name).
    lines.push(surfaceRow(p.toolPanelBg, ` ${bold(p.accent, '⎿ read_file')}`, width))
    lines.push(surfaceRow(p.toolPanelBg, ` ${fg(p.fgMuted, 'reading src/index.ts (1.2k lines)')}`, width))
    lines.push(canvas(''))

    // Code block (canvasSubtle surface, bordered).
    lines.push(surfaceRow(p.canvasSubtle, ` ${fg(p.fgMuted, '┌─ code ──────────────')}`, width))
    lines.push(surfaceRow(p.canvasSubtle, ` ${fg(p.fgDefault, '│ const x = 42;')}`, width))
    lines.push(surfaceRow(p.canvasSubtle, ` ${fg(p.fgDefault, '│ console.log(x * 2);')}`, width))
    lines.push(surfaceRow(p.canvasSubtle, ` ${fg(p.fgMuted, '└─────────────────────')}`, width))
    lines.push(canvas(''))

    // Assistant reply.
    lines.push(canvas(` ${fg(p.fgDefault, '结果：x * 2 = 84。')} `))
    lines.push(canvas(''))

    // Input dock placeholder (inset surface).
    lines.push(surfaceRow(p.canvasInset, ` ${fg(p.fgMuted, 'Type a message…')}`, width))

    return lines
  }

  /** `auto` selected: show a short hint in the current theme instead of a mock. */
  private renderAuto(width: number): string[] {
    const p = this.getTheme().palette
    const fg = (hex: string, text: string) => ansiFg(hex) + text + RESET
    const bold = (hex: string, text: string) => ansiFg(hex) + BOLD + text + RESET
    const lines: string[] = []
    lines.push(surfaceRow(p.canvasInset, ` ${bold(p.accent, 'auto')} `, width))
    lines.push(surfaceRow(p.canvas, '', width))
    lines.push(surfaceRow(p.canvas, ` ${fg(p.fgDefault, 'Theme follows the terminal.')}`, width))
    lines.push(surfaceRow(p.canvas, ` ${fg(p.fgMuted, 'Pick light/dark or a named theme to preview it.')}`, width))
    lines.push(surfaceRow(p.canvas, '', width))
    lines.push(surfaceRow(p.canvasInset, ` ${fg(p.fgMuted, 'Type a message…')}`, width))
    return lines
  }
}

/** A theme picker row: the selectable value, name, description and palette. */
export interface ThemePickerRow {
  value: string
  label: string
  description: string
  palette?: Palette
}

/** Options for the theme picker's registry rows (custom themes). */
export interface PickThemeOptions {
  /**
   * Full theme registry (theme id → palette), as produced by
   * `discoverThemes` — every entry becomes a selectable row after the
   * constant auto/light/dark rows. Absent: the picker shows only those
   * three rows (the historical behavior).
   */
  themes?: ReadonlyMap<string, Palette>
  /**
   * Theme ids that live in the user themes directory. Entries in `themes`
   * whose id appears here are labeled "user theme"; the rest (the bundled
   * themes) are labeled "built-in".
   */
  userNames?: ReadonlySet<string>
}

/**
 * Build the picker rows — a flat two-level list: `auto` first, then every
 * registered theme. The two GitHub defaults lead the theme block (they are
 * the out-of-the-box choices and keep the e2e navigation stable), user
 * themes follow, the remaining built-ins come last. The old `light`/`dark`
 * alias rows are gone — those names stay valid as stored preferences (they
 * resolve through resolveTheme's alias handling) but no longer get their own
 * rows.
 */
export function themePickerRows(options?: PickThemeOptions): ThemePickerRow[] {
  const rows: ThemePickerRow[] = [
    { value: 'auto', label: 'auto', description: 'follow the terminal light/dark signal' },
  ]
  const themes = options?.themes
  if (themes === undefined) {
    // No registry (the legacy no-argument mount): just the two defaults.
    rows.push(
      { value: 'github-light', label: 'github-light', description: 'GitHub light palette', palette: githubLight },
      { value: 'github-dark', label: 'github-dark', description: 'GitHub dark palette', palette: githubDark },
    )
    return rows
  }
  const userNames = options?.userNames
  const row = (name: string, palette: Palette, description: string): ThemePickerRow => ({
    value: name,
    label: name,
    description,
    palette,
  })
  // The two defaults keep their classic descriptions (the e2e suite asserts
  // the "GitHub light/dark palette" texts); other rows just carry their
  // origin — the name is already in the Theme column.
  // A user theme overriding a default id shows its own palette under the
  // default's name (discoverThemes merges user-over-builtin).
  const origin = (name: string): string => userNames?.has(name) === true ? 'user theme' : 'built-in'
  rows.push(
    row('github-light', themes.get('github-light') ?? githubLight, 'GitHub light palette'),
    row('github-dark', themes.get('github-dark') ?? githubDark, 'GitHub dark palette'),
  )
  // Reserved names that resolveTheme handles specially never get rows.
  const reserved = new Set(['auto', 'light', 'dark', 'github-light', 'github-dark'])
  for (const [name, palette] of themes) {
    if (reserved.has(name)) continue
    rows.push(row(name, palette, origin(name)))
  }
  return rows
}

/** Terminal width at which the picker switches from stacked to side-by-side. */
export const DUAL_PANE_MIN_COLUMNS = 100

/** Floor of the left list pane in dual-pane mode. */
export const LEFT_PANE_MIN_COLUMNS = 30

/**
 * A one-column divider between the theme list and the preview pane, so the
 * two panes read as distinct surfaces instead of abutting columns.
 */
class Divider implements Component {
  render(): string[] {
    return ['│']
  }
  invalidate(): void {}
}

/**
 * Content-row budget inside the framed overlay: the overlay is capped at 75%
 * of the terminal, the FramedOverlay adds 4 chrome rows (top/bottom borders +
 * a blank spacer each), and the preview pane renders exactly its own height.
 * Testable; `rows` injected.
 */
export function overlayContentBudget(rows: number | undefined = process.stdout.rows): number {
  return Math.max(6, Math.floor((rows ?? 24) * 0.85) - 4)
}

/**
 * The theme picker overlay: a left TablePanel of themes + a right preview
 * pane that repaints with the SELECTED theme's palette on every cursor move
 * (history.ts's pattern — compare selectedRow before/after handleInput, an
 * explicit action, never the render path). Side-by-side on wide terminals
 * (HStack), stacked on narrow ones (VStack). Renders exactly
 * `overlayContentBudget()` rows.
 */
export class ThemePickerOverlay implements Component {
  private readonly list: TablePanel<ThemePickerRow>
  private readonly preview: ThemePreviewPane
  private readonly rows: readonly ThemePickerRow[]
  private readonly onPick: (value: string | undefined) => void
  private readonly footer: string
  private closed = false

  constructor(
    theme: TuiTheme,
    rows: readonly ThemePickerRow[],
    preselect: number,
    onPick: (value: string | undefined) => void,
    getTheme: () => TuiTheme,
  ) {
    this.rows = rows
    this.onPick = onPick
    this.footer = '↑↓ navigate · Enter select · Esc back'
    this.preview = new ThemePreviewPane(getTheme)
    this.preview.setRow(rows[Math.max(0, preselect)])
    this.list = new TablePanel(theme, {
      title: '● Theme',
      columns: [
        { key: 'theme', title: 'Theme', width: Math.max(5, ...rows.map(row => row.label.length)) },
        { key: 'description', title: 'Description', flex: true },
      ],
      rows,
      renderCell: (row, column) => column.key === 'description' ? row.description : row.label,
      preselect,
      onSelect: row => this.finish(row.value),
      onCancel: () => this.finish(undefined),
      footer: this.footer,
      maxVisible: 12,
    })
  }

  invalidate(): void {
    this.list.invalidate()
    this.preview.invalidate()
  }

  render(width: number): string[] {
    const budget = overlayContentBudget()
    let lines: string[]
    if (width >= DUAL_PANE_MIN_COLUMNS) {
      // Left pane keeps a ~40% column floor (same as the history browser);
      // a one-column divider separates the panes; the preview grows into
      // the rest.
      const leftWidth = Math.max(LEFT_PANE_MIN_COLUMNS, Math.floor(width * 0.4))
      const stack = new HStack([
        { component: this.list, basis: leftWidth, shrink: 1, minSize: LEFT_PANE_MIN_COLUMNS },
        { component: new Divider(), basis: 1, grow: 0, shrink: 0 },
        { component: this.preview, basis: 0, grow: 1, minSize: 24 },
      ])
      lines = stack.render(width)
    } else {
      // Stacked: the list keeps its intrinsic height; the preview pane gets
      // the remaining budget rows so its mock page stays visible (a fixed
      // basis would overflow the budget on short terminals).
      const listRows = Math.min(12, Math.max(3, budget - 10))
      const stack = new VStack([
        { component: this.list, basis: listRows, grow: 0, shrink: 0 },
        { component: this.preview, basis: Math.max(6, budget - listRows), grow: 0, shrink: 0 },
      ])
      lines = stack.render(width)
    }
    if (lines.length > budget) return lines.slice(0, budget)
    while (lines.length < budget) lines.push('')
    return lines
  }

  handleInput(data: string): void {
    if (this.closed) return
    const before = this.list.selectedRow()
    this.list.handleInput(data)
    const selected = this.list.selectedRow()
    if (selected !== undefined && selected.value !== before?.value) {
      this.preview.setRow(selected)
    }
  }

  private finish(value: string | undefined): void {
    if (this.closed) return
    this.closed = true
    this.onPick(value)
  }

  /** The currently selected row (test seam). */
  selectedValue(): ThemePreference | undefined {
    return this.list.selectedRow()?.value
  }
}
