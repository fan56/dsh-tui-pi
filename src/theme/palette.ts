/**
 * GitHub palettes for the dsh-tui-pi themes, aligned with the user's terminal
 * themes in ~/scripts/cmux-theme.sh ("GitHub Light" / "GitHub Dark" entries):
 * the light canvas is the terminal background #f6f8fa (not pure white), and
 * the 16-color roles (red/green/yellow/blue/purple) come from that palette.
 *
 * Terminal truecolor cannot carry the alpha channel Primer uses for muted
 * fills, so dark-mode muted backgrounds are pre-blended at 20% tint over
 * `canvas` (solid approximations of the primer `-muted` tokens).
 */

export interface Palette {
  /** Theme id, used by the theme switcher. */
  readonly name: string
  /** Main background (chat canvas). */
  readonly canvas: string
  /** Slightly offset surface (message bubbles, code blocks, tool cards). */
  readonly canvasSubtle: string
  /** Inset surface (editor border row, footer background). */
  readonly canvasInset: string
  readonly fgDefault: string
  readonly fgMuted: string
  readonly fgSubtle: string
  readonly borderDefault: string
  readonly borderMuted: string
  readonly accent: string
  /** Solid approximation of Primer `accent.muted` (light fills on accent). */
  readonly accentMuted: string
  readonly success: string
  readonly successMuted: string
  readonly danger: string
  readonly dangerMuted: string
  readonly attention: string
  readonly attentionMuted: string
  /** Thinking/reasoning block text. */
  readonly thinking: string
}

export const githubLight: Palette = {
  name: 'github-light',
  // Terminal background per cmux-theme.sh; white reads as the raised surface.
  canvas: '#f6f8fa',
  canvasSubtle: '#ffffff',
  canvasInset: '#ffffff',
  fgDefault: '#24292f',
  fgMuted: '#57606a',
  fgSubtle: '#6a737d',
  borderDefault: '#d0d7de',
  borderMuted: '#d8dee4',
  accent: '#0366d6',
  accentMuted: '#dbedff',
  success: '#22863a',
  successMuted: '#dafbe1',
  danger: '#d73a49',
  dangerMuted: '#ffebe9',
  attention: '#b08800',
  attentionMuted: '#fff5b1',
  thinking: '#6f42c1',
}

const HEX6 = /^#[0-9a-fA-F]{6}$/

/** 20% tint of `over` on `base`, as a solid hex approximation of an alpha blend. */
function blend(base: string, over: string, alpha: number): string {
  if (!HEX6.test(base) || !HEX6.test(over)) {
    throw new TypeError(`blend(): expected #rrggbb hex colors, got "${base}" and "${over}"`)
  }
  const b = [1, 3, 5].map(i => parseInt(base.slice(i, i + 2), 16))
  const o = [1, 3, 5].map(i => parseInt(over.slice(i, i + 2), 16))
  const mixed = b.map((v, i) => Math.round(v * (1 - alpha) + o[i]! * alpha))
  return `#${mixed.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

export const githubDark: Palette = {
  name: 'github-dark',
  canvas: '#0d1117',
  canvasSubtle: '#161b22',
  canvasInset: '#010409',
  fgDefault: '#e6edf3',
  fgMuted: '#8b949e',
  fgSubtle: '#6e7681',
  borderDefault: '#30363d',
  borderMuted: '#21262d',
  accent: '#58a6ff',
  accentMuted: blend('#0d1117', '#2f81f7', 0.2),
  success: '#3fb950',
  successMuted: blend('#0d1117', '#3fb950', 0.2),
  danger: '#ff7b72',
  dangerMuted: blend('#0d1117', '#ff7b72', 0.2),
  attention: '#d29922',
  attentionMuted: blend('#0d1117', '#d29922', 0.2),
  thinking: '#bc8cff',
}

/**
 * Detect whether the terminal background is dark.
 * `resolveTheme` handles the explicit DSH_TUI_THEME override before calling
 * this, so this only inspects terminal environment signals.
 */
export function detectDarkPalette(env: NodeJS.ProcessEnv = process.env): boolean {
  // COLORFGBG (xterm family): "fg;bg". In the standard 16-color set, 7 (white)
  // and 15 (bright white) are the light backgrounds; everything else is dark.
  const colorFgBg = env.COLORFGBG
  if (colorFgBg !== undefined) {
    const bg = parseInt(colorFgBg.split(';')[1] ?? '', 10)
    if (!Number.isNaN(bg)) return !(bg === 7 || bg === 15)
  }
  // Default to dark — GitHub's terminal default and the safer contrast choice.
  return true
}
