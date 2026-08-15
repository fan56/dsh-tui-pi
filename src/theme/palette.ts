/**
 * GitHub palettes for the dsh-tui-pi themes.
 *
 * Design direction (2026-08 redesign, "paper feel"):
 * - Light: near-white canvas with a faint cool-green cast, clear gray-green
 *   surfaces, graphite-green body text and a steel-blue accent — white /
 *   pale green / pale blue / clear gray, no fluorescent hues.
 * - Dark: deep gray-blue canvas (#0d1117 family), accent/success/thinking
 *   hues mirror the light theme's families (brightened for dark), muted
 *   fills are solid approximations of alpha tints blended over `canvas`
 *   (the terminal can't carry alpha) — same values as `blend()` below.
 *
 * The TUI never paints the main canvas (the terminal background shows
 * through), so `canvas` is the semantic base used by the dark muted blends
 * and by contrast design; `canvasSubtle` is the visible raised surface.
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
  // Main canvas: near-white with a faint cool-green cast (not the harsh
  // pure #fff); paper feel. The TUI never paints it — the terminal
  // background (#f6f8fa) shows through; kept as the semantic base for the
  // dark muted blends and contrast design.
  canvas: '#fcfdfc',
  // Raised surface (message bubbles, think/tool panels, overlays, code
  // blocks): one step darker than the canvas, clear gray-green.
  canvasSubtle: '#eef3ee',
  // Inset surface (editor border row, footer background): one more step.
  canvasInset: '#e5ebe5',
  // Body text graphite-green (cool gray-green): 14.6:1 on canvas, 13.2:1
  // on canvasSubtle.
  fgDefault: '#1f2a24',
  // Secondary text (tool details, hints): clear gray-green, ~6:1.
  fgMuted: '#5a6b60',
  // De-emphasized text (link URLs, unstarted todos, panel ellipsis rows):
  // clear gray-green, ~4.5:1 on canvasSubtle (WCAG AA for small text).
  fgSubtle: '#637269',
  // Default border (editor border, separators): soft clear gray, derived
  // from GitHub #d0d7de.
  borderDefault: '#ccd6cc',
  // Weak border: lighter clear gray.
  borderMuted: '#d9e1d9',
  // Primary accent (selection, links, arrows, session status): soft steel
  // blue, 5.6:1 on canvasSubtle.
  accent: '#0a60b5',
  // Accent tint (pale ice blue): weak blue fill.
  accentMuted: '#e2eff8',
  // Success (completed todos, ✔ tool cards): soft green, 4.7:1 on canvas,
  // 4.1:1 on successMuted.
  success: '#1e843b',
  // Success tint (successful tool cards): soft green fill.
  successMuted: '#e2f1df',
  // Danger (errors, ✘ tool cards): low-saturation rose, 5.2:1 on canvas,
  // 4.4:1 on dangerMuted.
  danger: '#b64550',
  // Danger tint (failed tool cards): soft rose fill.
  dangerMuted: '#f9e7e4',
  // Attention (in-progress todos, token limit): soft amber, 4.8:1 on canvas.
  attention: '#9a6700',
  // Attention tint: soft amber fill.
  attentionMuted: '#f6edd8',
  // Thinking text (think panel, italic): soft violet, 5.2:1 on canvasSubtle.
  thinking: '#7b4fae',
}

const HEX6 = /^#[0-9a-fA-F]{6}$/

/** Alpha tint of `over` on `base`, as a solid hex approximation of an alpha blend. */
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
  // Main canvas: deep gray-blue (the GitHub dark family).
  canvas: '#0d1117',
  // Raised surface (bubbles, panels, overlays): one step lighter gray-blue.
  canvasSubtle: '#161b22',
  // Inset surface: deepest near-black gray-blue.
  canvasInset: '#010409',
  // Body text: cool off-white, 16:1 on canvas.
  fgDefault: '#e6edf3',
  // Secondary text: gray-blue, ~6:1.
  fgMuted: '#8b949e',
  // De-emphasized text: brightened from the original #6e7681, 4.5:1 on
  // canvas (low emphasis must still be legible).
  fgSubtle: '#737d87',
  // Default border: gray-blue.
  borderDefault: '#30363d',
  // Weak border: deeper gray-blue.
  borderMuted: '#21262d',
  // Primary accent: same blue family as the light accent, brightened for
  // dark, 7.5:1 on canvas.
  accent: '#58a6ff',
  // Accent tint: 25% blue tint over canvas, one step brighter than
  // canvasSubtle for card faces.
  accentMuted: blend('#0d1117', '#58a6ff', 0.25),
  // Success: same green family as the light success, brightened, 4.9:1 on
  // successMuted.
  success: '#3fb950',
  // Success tint (successful tool cards): 25% green tint over canvas.
  successMuted: blend('#0d1117', '#3fb950', 0.25),
  // Danger: same red family as the light danger, brightened, 4.9:1 on
  // dangerMuted.
  danger: '#ff7b72',
  // Danger tint (failed tool cards): 25% red tint over canvas.
  dangerMuted: blend('#0d1117', '#ff7b72', 0.25),
  // Attention: same amber family as the light attention, brightened, 4.9:1
  // on attentionMuted.
  attention: '#d29922',
  // Attention tint: 25% amber tint over canvas.
  attentionMuted: blend('#0d1117', '#d29922', 0.25),
  // Thinking text: same violet family as the light thinking, brightened,
  // 6.9:1 on canvasSubtle.
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
