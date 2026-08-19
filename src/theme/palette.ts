/**
 * GitHub palettes for the dsh-tui-pi themes.
 *
 * Design direction (2026-08 redesign, "paper feel"):
 * - Light: near-white canvas with a faint cool-green cast, clear gray-green
 *   surfaces, graphite-green body text and a steel-blue accent — white /
 *   pale green / pale blue / clear gray, no fluorescent hues.
 * - Dark: deep gray-blue canvas (#0d1117 family); every status hue uses the
 *   BRIGHT half of the user's cmux GitHub Dark 16-color palette
 *   (`~/scripts/cmux-theme.sh`: #79c0ff blue, #56d364 green, #e3b341 gold,
 *   #ffa198 red, #d2a8ff violet) so no text role falls into black-on-dark;
 *   muted fills are solid approximations of alpha tints blended over
 *   `canvas` (the terminal can't carry alpha) — same values as `blend()`
 *   below.
 *
 * The TUI paints every rendered row with `canvas` (patched pi-tui
 * `setCanvasBackground`, see src/tui.ts) — the app owns its background, so
 * a theme switch recolors the whole screen and the terminal/multiplexer
 * background never shows through. `canvasSubtle` stays the visible raised
 * surface on top of it. DSH_TUI_TRANSPARENT=1 reverts to the old
 * see-through canvas, where `canvas` is only the semantic base for the dark
 * muted blends and contrast design.
 */

export interface Palette {
  /** Theme id, used by the theme switcher. */
  readonly name: string
  /** True for dark themes — components pick bright/light color variants on it. */
  readonly dark: boolean
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
  /** Think panel surface (distinct pale purple on light / purple tint on dark). */
  readonly thinkingPanelBg: string
  /** Tool card surface (distinct pale blue on light / blue tint on dark). */
  readonly toolPanelBg: string
  /** Panel box border (think/tool boxes), one step stronger than borderDefault. */
  readonly panelBorder: string
  /** FramedOverlay box border — accent-tinted, unifies every select panel / popup chrome with a theme color. */
  readonly panelBoxBorder: string
}

/** #rrggbb hex matcher — shared by blend(), hexToRgb() and hexIsLight(). */
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

export const githubLight: Palette = {
  name: 'github-light',
  dark: false,
  // Main canvas: near-white with a faint cool-green cast (not the harsh
  // pure #fff); paper feel. Painted on every rendered row (see the module
  // header) — the whole screen carries it.
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
  // Default border (editor border, separators): clear gray-green, 3.3:1 on
  // the canvas so panel lines stay clearly visible (was 1.4:1).
  borderDefault: '#829087',
  // Weak border: one step lighter, ~1.8:1 — auxiliary lines only.
  borderMuted: '#b8c1b9',
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
  // Think panel surface: pale lavender, off the green-gray bubble surfaces so
  // the reasoning block reads as its own surface.
  thinkingPanelBg: '#f4effa',
  // Tool card surface: pale ice blue, same family as accentMuted but a touch
  // bluer than the green-gray bubble surface.
  toolPanelBg: '#eef4fb',
  // Panel box border (think/tool boxes): green-gray, ~3.3:1 on canvasSubtle
  // so the box lines read against the raised panel surface.
  panelBorder: '#6f8c72',
  // FramedOverlay box border (every select panel / popup): accent tinted
  // over the canvas at a medium alpha — the whole popup chrome carries the
  // theme color while staying readable (~3.3:1 on canvas). Light needs a
  // stronger tint than dark (0.7 vs 0.55): 0.55 only reaches ~2.5:1 on the
  // near-white canvas.
  panelBoxBorder: blend('#fcfdfc', '#0a60b5', 0.7),
}

export const githubDark: Palette = {
  name: 'github-dark',
  dark: true,
  // Main canvas: deep gray-blue (the GitHub dark family).
  canvas: '#0d1117',
  // Raised surface (bubbles, panels, overlays): one step lighter gray-blue.
  canvasSubtle: '#161b22',
  // Inset surface: deepest near-black gray-blue.
  canvasInset: '#010409',
  // Body text: cool off-white, 16:1 on canvas.
  fgDefault: '#e6edf3',
  // Secondary text: bright gray (cmux GitHub Dark bright-black #b1bac4),
  // 9.6:1 on canvas — secondary must read clearly on the dark canvas.
  fgMuted: '#b1bac4',
  // De-emphasized text (unstarted todos, panel ellipsis rows): 6.2:1 on
  // canvas (low emphasis must still be legible, never near-black).
  fgSubtle: '#8b949e',
  // Default border: gray-blue, 4.1:1 on the canvas so panel lines stay
  // clearly visible (was 1.5:1, nearly black-on-black).
  borderDefault: '#6e7681',
  // Weak border: one step up from the canvas, ~1.9:1 — auxiliary lines only.
  borderMuted: '#3d444d',
  // Primary accent: bright blue (cmux bright-blue), 9.7:1 on canvas.
  accent: '#79c0ff',
  // Accent tint: 25% blue tint over canvas, one step brighter than
  // canvasSubtle for card faces.
  accentMuted: blend('#0d1117', '#79c0ff', 0.25),
  // Success: same green family as the light success, brightened, 4.9:1 on
  // successMuted.
  success: '#56d364',
  // Success tint (successful tool cards): 25% green tint over canvas.
  successMuted: blend('#0d1117', '#56d364', 0.25),
  // Danger (errors, ✘ tool cards): bright red (cmux bright-red), 9.7:1 on
  // canvas, 5.8:1 on dangerMuted.
  danger: '#ffa198',
  // Danger tint (failed tool cards): 25% red tint over canvas.
  dangerMuted: blend('#0d1117', '#ffa198', 0.25),
  // Attention (in-progress todos, token limit): bright gold (cmux
  // bright-yellow), 9.7:1 on canvas, 5.8:1 on attentionMuted.
  attention: '#e3b341',
  // Attention tint: 25% gold tint over canvas.
  attentionMuted: blend('#0d1117', '#e3b341', 0.25),
  // Thinking text: bright violet (cmux bright-purple), 9.7:1 on canvas,
  // 5.8:1 on thinkingPanelBg.
  thinking: '#d2a8ff',
  // Think panel surface: 25% violet tint over canvas (same blend convention
  // as the other dark muted fills).
  thinkingPanelBg: blend('#0d1117', '#d2a8ff', 0.25),
  // Tool card surface: same 25% blue tint as accentMuted (the two surfaces
  // are one family; the blue reads as "tool" next to the purple "think").
  toolPanelBg: blend('#0d1117', '#79c0ff', 0.25),
  // Panel box border (think/tool boxes): green-gray, ~3.6:1 on canvasSubtle
  // so the box lines read against the raised panel surface.
  panelBorder: '#64766b',
  // FramedOverlay box border (every select panel / popup): accent tinted
  // over the canvasSubtle backdrop — 0.70 blend gives ~5:1 contrast, a
  // clearly blue border that reads as the theme color (not dim gray).
  panelBoxBorder: blend('#0d1117', '#79c0ff', 0.70),
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

/** RGB triple as reported by pi-tui's OSC 11 background query. */
export interface Rgb {
  r: number
  g: number
  b: number
}

/** WCAG relative luminance of an RGB triple (0 = black, 1 = white). */
function rgbLuminance({ r, g, b }: Rgb): number {
  const toLinear = (channel: number): number => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/**
 * True when an OSC 11 background color reads as a light terminal (the same
 * 0.5 luminance threshold pi uses for its terminal detection). Structural
 * match for pi-tui's `RgbColor`, so the query result passes through as-is.
 */
export function rgbIsLight(rgb: Rgb): boolean {
  return rgbLuminance(rgb) >= 0.5
}

/** Parse a #rrggbb hex string into an RGB triple. */
function hexToRgb(hex: string): Rgb {
  if (!HEX6.test(hex)) {
    throw new TypeError(`hexToRgb(): expected #rrggbb hex color, got "${hex}"`)
  }
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  }
}

/**
 * True when a #rrggbb hex background reads as light — used to pick dark
 * segment text on bright powerline fills (white text only on dark fills).
 */
export function hexIsLight(hex: string): boolean {
  return rgbIsLight(hexToRgb(hex))
}

/**
 * WCAG contrast ratio (1..21) between two #rrggbb colors — lets the theme
 * tests gate border/surface visibility (UI components target ≥3:1).
 */
export function hexContrast(fg: string, bg: string): number {
  const l1 = rgbLuminance(hexToRgb(fg))
  const l2 = rgbLuminance(hexToRgb(bg))
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (lighter + 0.05) / (darker + 0.05)
}
