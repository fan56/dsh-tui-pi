/**
 * Startup welcome banner: a pixel-art whale (generated pixel-by-pixel from
 * the user's image) with the "DSH" wordmark to its right, drawn in a
 * blocky pixel font (PIXEL_FONT). Each letter is a classic-pixel-ratio
 * glyph — 14 columns × 10 rows (2-column strokes, taller than wide) drawn
 * centered in a 28-column × 10-row block that matches the whale's width
 * and height, so the letters align with the whale. Rendered as the
 * transcript's first component, above every message.
 *
 * The banner is a 120-column × 10-row grid: 28 columns of whale art, a
 * 4-column gap, then 88 columns of pixel letters (3 letters × 28 columns,
 * 2 blank columns between letters). Below 122 terminal columns the
 * wordmark is dropped — the banner degrades to the 10 whale rows (28
 * columns each, no gap, no letters), so a narrow terminal never wraps the
 * letter rows; the full banner comes back as soon as the terminal is 122
 * columns or wider again (the transcript rebuilds on resize). Glyph
 * semantics: '█' is solid in both halves, '▀' is solid in the top half
 * only, '▄' is solid in the bottom half only, ' ' is transparent; the
 * letters map the font's '#' strokes to '█' blocks and its '.' empties to
 * ' '. The letter shapes keep the classic pixel font's ratio (like a 5×7
 * font scaled up ~2.8×: 14 wide × 10 tall, 2-column strokes) instead of
 * filling the whole 28-column block — a full-width 28×10 glyph is wider
 * than tall, so on screen every letter reads as a solid square (D became
 * a block). Everything is painted
 * in the whale brand blue. Transparent cells stay unpainted — they show the
 * terminal default background. This is deliberate: the transcript never
 * paints a canvas background (the TUI startup already sets the terminal
 * background to the theme canvas), so a half-block's transparent half must
 * fall through to the terminal default, not to an explicit theme
 * background. Painting it would mismatch on any terminal whose default
 * background differs from the theme canvas.
 */

import { ansiFg, POWERLINE, RESET } from './theme/index.ts'

/** The whale color — the same brand blue as the powerline 'dsh' segment. */
export const WHALE_COLOR = POWERLINE.brand

/**
 * Whale pixel art, 28 columns × 10 rows, generated pixel-by-pixel from the
 * user's image (regenerate with `node assets/whale-gen.mjs`; see
 * assets/whale-gen.mjs). Only ' ', '█', '▀' and '▄' appear (see the glyph
 * semantics above). Every row carries at least one whale glyph, so the
 * banner text as a whole is never blank — Text.render only skips an
 * entirely blank text, and individual blank rows would render as empty
 * lines either way.
 */
export const WHALE_ART: readonly string[] = [
  '           ▄▄▄▄    █        ',
  '   ▄██████████▄   ████ ▄▄▄█▀',
  ' ▄██████████████▄  ████████ ',
  ' ██▀▀█████████████▄ ▄██▀▀   ',
  '██      ▀▀█████▄▀██████     ',
  '▀██        ▀████▄ ████▀     ',
  ' ███        ▀████████▀      ',
  '  ▀██▄   █▄▄  ▀█████▀       ',
  '   ▀▀███▄▄███▄▄▄█████▄      ',
  '      ▀▀▀████▀▀▀            ',
]

/** Blank columns between the whale and the wordmark column. */
const WHALE_TITLE_GAP = 4

/** The wordmark, rendered from PIXEL_FONT: 3 letters × 28 + 2×2 letter gaps = 88 columns. */
export const WORDMARK = 'DSH'

/** Blank columns between two wordmark letters. */
const LETTER_GAP = 2

/** Whale art width in columns (every row is this wide). */
const WHALE_ART_WIDTH = Math.max(...WHALE_ART.map(row => row.length))

/** One wordmark letter's art width in columns (28 — the whale's width). */
const LETTER_ART_WIDTH = 28

/**
 * Full banner width: whale + gap + letters — derived from the constants so a
 * layout tweak (gap, letter count) cannot silently desync the degradation
 * threshold in `buildWelcomeBanner` from the assembled rows.
 */
export const WELCOME_FULL_WIDTH = WHALE_ART_WIDTH + WHALE_TITLE_GAP + WORDMARK.length * LETTER_ART_WIDTH + (WORDMARK.length - 1) * LETTER_GAP

/**
 * Pixel font for the wordmark letters: '#' is a stroke cell, '.' is empty.
 * Each glyph is a classic-pixel-ratio letter shape, 14 columns × 10 rows
 * (2-column strokes, taller than wide — like a 5×7 font scaled up ~2.8×),
 * centered in its 28-column block (7 blank columns on each side) so the
 * block width and height still match the whale's and the letters stay
 * top-aligned with it. The 28-column block width (not the 14-column glyph
 * width) drives the 120-column layout, so the narrow-terminal degradation
 * threshold is unchanged. A glyph that filled the whole block would be
 * wider than tall and read as a solid square on screen (see the header
 * note); the 14×10 shape keeps every letter legible as a letter. Strokes
 * render as '█' blocks in the whale brand blue; empties fall through to
 * the terminal default background like the whale's spaces.
 */
export const PIXEL_FONT: Record<string, readonly string[]> = {
  D: [
    '.......##############.......',
    '.......##############.......',
    '.......##..........##.......',
    '.......##..........##.......',
    '.......##..........##.......',
    '.......##..........##.......',
    '.......##..........##.......',
    '.......##..........##.......',
    '.......##############.......',
    '.......##############.......',
  ],
  S: [
    '.......##############.......',
    '.......##############.......',
    '.......##...................',
    '.......##...................',
    '.......##############.......',
    '.......##############.......',
    '...................##.......',
    '...................##.......',
    '.......##############.......',
    '.......##############.......',
  ],
  H: [
    '.......##..........##.......',
    '.......##..........##.......',
    '.......##..........##.......',
    '.......##..........##.......',
    '.......##############.......',
    '.......##############.......',
    '.......##..........##.......',
    '.......##..........##.......',
    '.......##..........##.......',
    '.......##..........##.......',
  ],
}

// Load-time validation: a wordmark letter without a font glyph is a
// programming error — fail at module load, not at some later resize when
// the full banner is first assembled (a narrow terminal would defer the
// crash into the resize handler).
for (const ch of WORDMARK) {
  if (ch !== ' ' && PIXEL_FONT[ch] === undefined) {
    throw new Error(`PIXEL_FONT lacks glyph for '${ch}' in WORDMARK`)
  }
}

/**
 * Lay out the wordmark's 10 letter rows, 88 columns each: 28 per letter,
 * 2 blank columns between letters. The font's '#' strokes map to '█' and
 * '.' empties to ' ', so the rows paint exactly like whale rows (see the
 * header note). Wordmark glyph coverage is validated at module load.
 */
function wordmarkRows(): readonly string[] {
  const rows = Array.from({ length: WHALE_ART.length }, () => '')
  for (let i = 0; i < WORDMARK.length; i++) {
    const glyph = PIXEL_FONT[WORDMARK[i]]
    // Two blank columns after a letter that is not the last one.
    const tail = i + 1 < WORDMARK.length ? ' '.repeat(LETTER_GAP) : ''
    for (let r = 0; r < rows.length; r++) {
      rows[r] += glyph[r].replaceAll('#', '█').replaceAll('.', ' ') + tail
    }
  }
  return rows
}

/**
 * Paint one consecutive run of brand-blue glyphs as a single SGR span,
 * RESET at the end. Runs are painted in the whale blue only — half-block
 * glyphs ('▀'/'▄') are never given a background, so their transparent half
 * shows the terminal default background (see the header note).
 */
function paintWhaleRun(run: string): string {
  return ansiFg(WHALE_COLOR) + run + RESET
}

/**
 * Paint one row's consecutive runs of non-space glyphs as whale-blue spans,
 * RESET after each. The spaces between runs stay unstyled (transparent,
 * terminal background). Used for whale rows and the wordmark's letter rows
 * alike.
 */
function paintRowRuns(row: string): string {
  let styled = ''
  let run = ''
  for (const ch of row) {
    if (ch === ' ') {
      if (run !== '') {
        styled += paintWhaleRun(run)
        run = ''
      }
      styled += ' '
    } else {
      run += ch
    }
  }
  if (run !== '') styled += paintWhaleRun(run)
  return styled
}

/**
 * Assemble the welcome banner text. Every row is the styled whale row, the
 * 4-column gap, then the 88-column pixel-letter row — all painted in the
 * whale brand blue. The banner is theme-independent: no theme colors, no
 * bold, nothing to repaint on a theme switch.
 *
 * Width floor: the full banner is 120 columns wide plus the transcript
 * Text's 1-column left/right padding (the renderer passes its Text paddingX
 * — currently 1 — so the threshold is 122). Below it the banner degrades to
 * the whale alone: the 10 art rows, 28 columns each, no gap and no letters,
 * which needs only 30 columns with the padding. A terminal narrower than
 * that wraps the whale rows onto extra lines (accepted degradation,
 * documented rather than clipped, because a terminal that narrow can't show
 * the whale either way). `undefined` (non-TTY contexts, e.g. tests) counts
 * as wide — the full banner, conservative like PANEL_LINE_CAP_FALLBACK.
 */
export function buildWelcomeBanner(columns: number | undefined): string {
  // 2 = the transcript Text's paddingX on each side (messages.ts renders the
  // banner with `new Text(..., 1, 0)`).
  if (columns !== undefined && columns < WELCOME_FULL_WIDTH + 2) {
    // Narrow terminal: whale-only, the 10 art rows (28 columns each) — no
    // gap, no letters. Wraps only below the 30-column floor.
    return WHALE_ART.map(row => paintRowRuns(row)).join('\n')
  }
  const letters = wordmarkRows()
  return WHALE_ART.map((row, r) => {
    return paintRowRuns(row) + ' '.repeat(WHALE_TITLE_GAP + WHALE_ART_WIDTH - row.length) + paintRowRuns(letters[r])
  }).join('\n')
}
