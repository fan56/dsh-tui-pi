/**
 * Custom editor that replaces the input's TOP BORDER row with a plain-text
 * info line: cwd + git branch (separator "│"), in border color only (no
 * powerline background segments). Ported from pi-powerline-footer's
 * CwdBorderEditor; every other editor row is left untouched.
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

export class CwdBorderEditor extends Editor {
  private readonly sessionCwd: string
  private readonly infoColor: (str: string) => string
  private branchProvider: () => string | undefined = () => undefined

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

  render(width: number): string[] {
    const lines = super.render(width)
    if (lines.length < 2 || width < 3) return lines

    // When scrolled, the built-in top border row is a scroll indicator
    // ("─── ↑ N more ─…"); preserve that feedback by appending ↑ N.
    const firstLine = lines[0] ?? ''
    const scrollMatch = /↑\s*(\d+)/u.exec(firstLine)
    const scrollInfo = scrollMatch === null ? '' : ` ↑ ${scrollMatch[1]}`

    const parts = [`📁 ${formatCwd(this.sessionCwd)}`]
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
