/**
 * Startup welcome banner: a pixel-art whale (generated pixel-by-pixel from
 * the user's image) with the "DSH" wordmark to its right, drawn in the
 * classic Adafruit GFX 5×7 bitmap font (PIXEL_FONT, glcdfont.c, public
 * domain — the same glyphs as the user's reference example). Each letter
 * is rendered at the whale's own size — 28 columns wide × 10 rows tall
 * (4-column strokes, 2-row horizontal bars, the 5×7 grid scaled up 4×) —
 * and the three glyphs sit 2 columns apart, so the letters align with the
 * whale. Rendered as the transcript's first component, above every
 * message.
 *
 * The banner is a 118-column × 10-row grid: 28 columns of whale art, a
 * 2-column gap, then the wordmark — D (28) + 2 + S (28) + 2 + H (28) =
 * 88 columns of letters. Below 120 terminal columns the wordmark is
 * dropped — the banner degrades to the 10 whale rows (28 columns each, no
 * gap, no letters), so a narrow terminal never wraps the letter rows; the
 * full banner comes back as soon as the terminal is 120 columns or wider
 * again (the transcript rebuilds on resize). Glyph semantics: '█' is solid
 * in both halves, '▀' is solid in the top half only, '▄' is solid in the
 * bottom half only, ' ' is transparent; the letters map the font's '#'
 * strokes to '█' blocks and its '.' empties to ' '. The letter shapes keep
 * the classic 5×7 font's proportions (strokes 4 columns thick, bars 2 rows
 * tall — the whale's 28-column width × 10-row height), and the wordmark as
 * a whole spans 88 columns of the banner. Everything is painted in the
 * whale brand blue. Transparent
 * cells stay unpainted — they show the terminal default background. This
 * is deliberate: the transcript never paints a canvas background (the TUI
 * startup already sets the terminal background to the theme canvas), so a
 * half-block's transparent half must fall through to the terminal default,
 * not to an explicit theme background. Painting it would mismatch on any
 * terminal whose default background differs from the theme canvas.
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
const WHALE_TITLE_GAP = 2

/** Blank columns between the wordmark's letters. */
const LETTER_GAP = 2

/** The wordmark: D S H, each letter a 28-column glyph, spaced 2 columns apart. */
export const WORDMARK = 'DSH'

/** Whale art width in columns (every row is this wide). */
const WHALE_ART_WIDTH = Math.max(...WHALE_ART.map(row => row.length))

/**
 * Pixel font for the wordmark letters: '#' is a stroke cell, '.' is empty.
 * Each glyph is a letter from the classic Adafruit GFX 5×7 bitmap font
 * (glcdfont.c, public domain — the user's reference example), rendered at
 * the whale's own 28 columns wide × 10 rows tall (4-column strokes,
 * horizontal bars 2 rows thick — the 5×7 grid scaled up 4×), with a
 * 2-cell padding column on each side of the glyph. The glyphs are spaced 2
 * columns apart into the wordmark block, which spans 28 + 2 + 28 + 2 + 28
 * = 88 columns. The 88-column wordmark width (not the individual glyph
 * widths) drives the 118-column layout and its degradation threshold.
 * Strokes render as '█' blocks in the whale brand blue; empties fall
 * through to the terminal default background like the whale's spaces.
 */
export const PIXEL_FONT: Record<string, readonly string[]> = {
  D: [
    '..########################..',
    '..########################..',
    '..####................####..',
    '..####................####..',
    '..####................####..',
    '..####................####..',
    '..####................####..',
    '..####................####..',
    '..########################..',
    '..########################..',
  ],
  S: [
    '..########################..',
    '..########################..',
    '..####......................',
    '..####......................',
    '..########################..',
    '..########################..',
    '......................####..',
    '......................####..',
    '..########################..',
    '..########################..',
  ],
  H: [
    '..####................####..',
    '..####................####..',
    '..####................####..',
    '..####................####..',
    '..########################..',
    '..########################..',
    '..####................####..',
    '..####................####..',
    '..####................####..',
    '..####................####..',
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
 * The wordmark letters' total width in columns — the glyphs' widths
 * summed: 28 (D) + 28 (S) + 28 (H) = 84. The 2-column gaps between
 * letters are added separately in WELCOME_FULL_WIDTH (2 gaps × 2 columns
 * → the wordmark block spans 88).
 */
const WORDMARK_WIDTH = [...WORDMARK].reduce((width, ch) => width + (ch === ' ' ? 1 : PIXEL_FONT[ch][0].length), 0)

/**
 * Full banner width: whale + gap + wordmark block — derived from the
 * constants so a layout tweak (gap, glyph widths) cannot silently desync
 * the degradation threshold in `buildWelcomeBanner` from the assembled
 * rows: 28 + 2 + 28 + 2 + 28 + 2 + 28 = 118 columns.
 */
export const WELCOME_FULL_WIDTH =
  WHALE_ART_WIDTH + WHALE_TITLE_GAP + WORDMARK_WIDTH + LETTER_GAP * (WORDMARK.length - 1)

/**
 * Lay out the wordmark's 10 letter rows, 88 columns each: the D, S and H
 * glyphs with a 2-column gap between letters (28 + 2 + 28 + 2 + 28
 * columns). The font's '#' strokes map to '█' and '.' empties to ' ', so
 * the rows paint exactly like whale rows (see the header note). Wordmark
 * glyph coverage is validated at module load.
 */
function wordmarkRows(): readonly string[] {
  const rows = Array.from({ length: WHALE_ART.length }, () => '')
  for (let i = 0; i < WORDMARK.length; i++) {
    const glyph = PIXEL_FONT[WORDMARK[i]]
    for (let r = 0; r < rows.length; r++) {
      rows[r] += glyph[r].replaceAll('#', '█').replaceAll('.', ' ')
      if (i < WORDMARK.length - 1) rows[r] += ' '.repeat(LETTER_GAP)
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
 * 2-column gap, then the 88-column pixel-letter row (letters 2 columns
 * apart) — all painted in the whale brand blue. The banner is
 * theme-independent: no theme colors, no bold, nothing to repaint on a
 * theme switch.
 *
 * Width floor: the full banner is 118 columns wide plus the transcript
 * Text's 1-column left/right padding (the renderer passes its Text paddingX
 * — currently 1 — so the threshold is 120). Below it the banner degrades
 * to the whale alone: the 10 art rows, 28 columns each, no gap and no
 * letters, which needs only 30 columns with the padding. A terminal
 * narrower than that wraps the whale rows onto extra lines (accepted
 * degradation, documented rather than clipped, because a terminal that
 * narrow can't show the whale either way). `undefined` (non-TTY contexts,
 * e.g. tests) counts as wide — the full banner, conservative like
 * PANEL_LINE_CAP_FALLBACK.
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
