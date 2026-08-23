/**
 * Framed overlay chrome — the shared full box (`┌─┐`) every pi SelectList /
 * SettingsList overlay gets, so a popup reads as one bounded surface instead
 * of panel rows floating directly on the chat canvas.
 *
 * Replaces pi agent's DynamicBorder (bare `─` lines) with a complete box:
 * `┌───┐` top, `│   │` side-bordered content rows, `└───┘` bottom. Width
 * passed to `showOverlay` is unchanged — the box is self-contained within it
 * (child renders at width − 2).
 *
 * The frame also paints the panel backdrop: every row (borders, spacers, and
 * each child line — including the raw separator/search rows pi's SettingsList
 * pushes without any theme call) is laid on a full-width canvasSubtle
 * background, so the popup reads as one solid rectangle instead of stripes
 * of text-width highlight.
 */

import type { Component } from '@earendil-works/pi-tui'
import { ansiBg, ansiFg, RESET, type TuiTheme } from './theme/index.ts'
import { visibleWidth } from './text.ts'

/**
 * Paint one overlay row on the panel backdrop: `line` (which may carry its
 * own SGR styling) is laid on a canvasSubtle background running the full
 * overlay width. Theme fns nest RESETs (bold → fg → bg wrappers each append
 * one), and a row can reset mid-line too (SettingsList's label/value split
 * emits an empty styled value), so the backdrop is re-applied after every
 * RESET — then the right-side padding is painted on the backdrop as well.
 * Empty separator rows become plain full-width backdrop.
 */
function fillLine(theme: TuiTheme, line: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(line))
  const bg = ansiBg(theme.palette.canvasSubtle)
  const content = line.replace(/\x1b\[0m/g, `\x1b[0m${bg}`)
  return bg + content + bg + ' '.repeat(pad) + RESET
}

/**
 * Full-box wrapper for one overlay component: `┌─┐` top border, `│`-bordered
 * content rows, `└─┘` bottom border — each with a blank spacer row inside
 * the box for breathing room, colored `palette.panelBoxBorder` (accent-tinted
 * so every popup reads as the theme color) on the panel's canvasSubtle
 * backdrop. Every row spans the full overlay width on that backdrop (see
 * fillLine); the child renders at width − 2.
 */
export class FramedOverlay implements Component {
  private readonly getTheme: () => TuiTheme
  private readonly child: Component

  /** A theme is either a fixed palette or a live getter (re-read per render). */
  constructor(theme: TuiTheme | (() => TuiTheme), child: Component) {
    this.getTheme = typeof theme === 'function' ? theme : () => theme
    this.child = child
  }

  invalidate(): void {
    this.child.invalidate()
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2)
    // Live read: a mid-overlay theme hot-swap applies to the frame too.
    const theme = this.getTheme()
    const borderFg = ansiFg(theme.palette.panelBoxBorder)
    const border = (chars: string) => borderFg + chars + RESET
    // Side-bordered content row: the child's own styling runs between the
    // two `│`s; fillLine re-applies the backdrop after any mid-line RESETs.
    const content = (line: string) => `${borderFg}│${line}${borderFg}│`
    const blankRow = `${borderFg}│${' '.repeat(contentWidth)}│`
    return [
      fillLine(theme, border(`┌${'─'.repeat(contentWidth)}┐`), width),
      fillLine(theme, blankRow, width),
      ...this.child.render(contentWidth).map(line => fillLine(theme, content(line), width)),
      fillLine(theme, blankRow, width),
      fillLine(theme, border(`└${'─'.repeat(contentWidth)}┘`), width),
    ]
  }

  handleInput(data: string): void {
    this.child.handleInput?.(data)
  }
}

/** Build the framed wrapper for `child` (see FramedOverlay). */
export function wrapFramedOverlay(theme: TuiTheme | (() => TuiTheme), child: Component): Component {
  return new FramedOverlay(theme, child)
}
