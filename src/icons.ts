/**
 * Icon handling for dsh-tui-pi (icon-set self-adaptation).
 *
 * Glyph-risk classification for every symbol this TUI renders:
 *
 *   - PUA, must fall back — the ONLY Private Use Area codepoint in the whole
 *     project is the powerline separator U+E0B0 (footer's arrow between
 *     segments). No default terminal font ships it, so a terminal without a
 *     Nerd Font shows a tofu box. `auto`/`plain` swap it for `▸` U+25B8.
 *
 *   - Standard Unicode, weak-terminal-risky — U+23F9 `⏹` (stop) and U+2B58
 *     `⭘` (heavy circle) are standard codepoints, but weak terminals /
 *     emoji-less fonts still render them as boxes. `auto`/`plain` swap them
 *     for `■` U+25A0 and `●` U+25CF.
 *
 *   - Standard Unicode, rely on system fallback — everything else
 *     (⚙ ⚠ ⚡ ✓ ✔ ✗ ✘ ⌘ ⎇ ⓘ ◐ ☑ ☐ ◔ ◑ ◕ ◉ ○ ★ ☁ 🤖 🧠 💬 🔧 ● …). Modern
 *     terminals resolve these via font fallback and they are left untouched
 *     in every mode.
 *
 * Modes (`dsh-tui.iconSet`, persisted in the settings namespace):
 *   - 'nerdfont': use the PUA powerline glyph (assumes a Nerd Font is the
 *     terminal's font).
 *   - 'plain': use the safe standard-Unicode stand-ins for every risky glyph.
 *   - 'auto' (default): nerdfont when a Nerd Font is detected at startup,
 *     plain otherwise (see src/font-detect.ts).
 *
 * The resolved mode lives in module state: `applyIconSet` is called once at
 * TUI startup and again on every hot-applied `iconSet` settings change, so
 * footer/notice/panel accessors return the right glyph at render time. The
 * module defaults to 'nerdfont' — the pre-feature output (`\uE0B0`) is
 * preserved unless the resolution lands on 'plain'.
 */

/** The persisted/`auto` icon-set mode; 'auto' resolves at startup. */
export type IconSet = 'auto' | 'nerdfont' | 'plain'

/** A resolved (non-auto) icon set — the value that drives glyph selection. */
export type ResolvedIconSet = Exclude<IconSet, 'auto'>

/** Glyph pair for one icon: the nerdfont glyph vs its plain fallback. */
type IconGlyphs = Record<ResolvedIconSet, string>

/** PUA — must fall back (see the classification above). */
const ARROW_RIGHT_GLYPHS: IconGlyphs = { nerdfont: '\uE0B0', plain: '\u25B8' }
/** Standard Unicode, weak-terminal-risky: `⏹` → `■`. */
const STOP_GLYPHS: IconGlyphs = { nerdfont: '\u23F9', plain: '\u25A0' }
/** Standard Unicode, weak-terminal-risky: `⭘` → `●`. */
const SUNGLASSES_GLYPHS: IconGlyphs = { nerdfont: '\u2B58', plain: '\u25CF' }

/**
 * Resolve an icon-set mode against the startup font detection: `auto` picks
 * the nerdfont glyphs when a Nerd Font is available and the plain fallbacks
 * otherwise; an explicit `nerdfont`/`plain` pin returns itself unchanged.
 */
export function resolveIconSet(mode: IconSet, nerdfontAvailable: boolean): IconSet {
  if (mode === 'auto') return nerdfontAvailable ? 'nerdfont' : 'plain'
  return mode
}

/**
 * The live resolved icon set. Defaults to 'nerdfont' — the legacy output —
 * so a TUI that renders before the async font detection lands never flickers
 * from a plain glyph to the powerline arrow; only a resolved 'plain' flips it.
 */
let resolvedIconSet: ResolvedIconSet = 'nerdfont'

/** Set the live resolved icon set (startup + hot-apply, src/index.ts). */
export function applyIconSet(set: IconSet): void {
  // 'auto' is resolved at startup (font detection, index.ts); a hot-applied
  // settings 'auto' keeps the current resolved set — never flickers.
  resolvedIconSet = set === 'auto' ? resolvedIconSet : set
}

/** The live resolved icon set (exposed for tests and the /settings UI). */
export function getResolvedIconSet(): ResolvedIconSet {
  return resolvedIconSet
}

/** The powerline segment separator: `\uE0B0` (nerdfont) / `▸` (plain). */
export function arrowRight(set: IconSet = resolvedIconSet): string {
  return ARROW_RIGHT_GLYPHS[set === 'auto' ? resolvedIconSet : set]
}

/** The stop glyph: `⏹` (nerdfont) / `■` (plain). */
export function stopIcon(set: IconSet = resolvedIconSet): string {
  return STOP_GLYPHS[set === 'auto' ? resolvedIconSet : set]
}

/** The subagent glyph: `⭘` (nerdfont) / `●` (plain). */
export function sunglassesIcon(set: IconSet = resolvedIconSet): string {
  return SUNGLASSES_GLYPHS[set === 'auto' ? resolvedIconSet : set]
}
