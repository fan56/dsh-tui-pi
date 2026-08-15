/**
 * Framed overlay chrome — the shared top/bottom border every pi SelectList /
 * SettingsList overlay gets, so a popup reads as one bounded surface instead
 * of panel rows floating directly on the chat canvas.
 *
 * Mirrors pi agent's DynamicBorder (full-width `─` lines in the palette
 * border color) but wraps the whole overlay root, so SettingsList submenus
 * stay framed too: the submenu swaps the list's own render while the frame
 * keeps both border rows in place. Width/height passed to `showOverlay`
 * are unaffected — the border lines simply follow the resolved overlay
 * width.
 */

import type { Component } from '@earendil-works/pi-tui'
import { ansiFg, RESET, type TuiTheme } from './theme/index.ts'

/**
 * Border wrapper for one overlay component: one `─` line above and below
 * the child's content (each with a blank spacer row), colored
 * `palette.borderDefault` to sit on the panel's canvasSubtle backdrop.
 */
export class FramedOverlay implements Component {
  private readonly theme: TuiTheme
  private readonly child: Component

  constructor(theme: TuiTheme, child: Component) {
    this.theme = theme
    this.child = child
  }

  invalidate(): void {
    this.child.invalidate()
  }

  render(width: number): string[] {
    const border = ansiFg(this.theme.palette.borderDefault) + '─'.repeat(Math.max(1, width)) + RESET
    return [border, '', ...this.child.render(width), '', border]
  }

  handleInput(data: string): void {
    this.child.handleInput?.(data)
  }
}

/** Build the framed wrapper for `child` (see FramedOverlay). */
export function wrapFramedOverlay(theme: TuiTheme, child: Component): Component {
  return new FramedOverlay(theme, child)
}
