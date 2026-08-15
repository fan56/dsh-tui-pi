/**
 * Startup welcome banner: a pixel-art whale (generated pixel-by-pixel from
 * the user's image) with the "DSH" wordmark to its right, drawn in the same
 * pixel language as the whale. Each letter is a hand-authored 20×20 pixel
 * bitmap (PIXEL_FONT: 20 columns × 20 half-cell rows, '#' a pixel, '.'
 * empty) — an upright glyph sheared into an arcade italic: every 4 pixel
 * rows the stroke shifts 1 pixel right, so the top leans 4 pixels —
 * rendered to the terminal with the whale's own half-block mapping
 * (top and bottom pixel → '█', top only → '▀', bottom only → '▄', neither
 * → ' '), so the letters show the same visible pixel grid: 3-pixel strokes,
 * and D's bowl and S's spine step diagonally in 2-pixel staircase corners
 * instead of meeting at square rectangle corners.
 *
 * The banner is a 94-column × 10-row grid: 28 columns of whale art, a
 * 2-column gap, then the wordmark — D (20) + 2 + S (20) + 2 + H (20) =
 * 64 columns of letters (each letter spans 20 columns — slimmer than the
 * whale's body mass). Below 96 terminal columns the wordmark is
 * dropped — the banner degrades to the 10 whale rows (28 columns each, no
 * gap, no letters), so a narrow terminal never wraps the letter rows; the
 * full banner comes back as soon as the terminal is 96 columns or wider
 * again (the transcript rebuilds on resize). Everything is painted in the
 * whale brand blue. Transparent cells stay unpainted — they show the
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
const WHALE_TITLE_GAP = 2

/** Blank columns between the wordmark's letters. */
const LETTER_GAP = 2

/** The wordmark: D S H, each letter a 28-column glyph, spaced 2 columns apart. */
export const WORDMARK = 'DSH'

/** Whale art width in columns (every row is this wide). */
const WHALE_ART_WIDTH = Math.max(...WHALE_ART.map(row => row.length))

/**
 * Pixel font for the wordmark letters: '#' is a pixel, '.' is empty. Each
 * glyph is a hand-authored 20×20 pixel bitmap: an upright body (16 pixels
 * wide, 17 for D's bowl) with 3-pixel strokes and 2-pixel staircase
 * corners, sheared italic — every 4 pixel rows shift 1 pixel right (the
 * top block leans 4 pixels, ~14°) — so every stroke's edge is a pixel
 * staircase and each letter spans exactly 20 columns, slimmer than the
 * whale's body (21–24). renderPixelGlyph folds every two pixel
 * rows into one terminal row of '█'/'▀'/'▄'/' ' — the exact mapping the
 * whale generator uses — so the letters and the whale share one pixel
 * grid. Strokes render in the whale brand blue; empties fall through to
 * the terminal default background like the whale's spaces.
 */
export const PIXEL_FONT: Record<string, readonly string[]> = {
  D: [
    '....#############...',
    '....#############...',
    '....#############...',
    '....###.........###.',
    '...###.........###..',
    '...###...........###',
    '...###...........###',
    '...###...........###',
    '..###...........###.',
    '..###...........###.',
    '..###...........###.',
    '..###...........###.',
    '.###...........###..',
    '.###...........###..',
    '.###...........###..',
    '.###.........###....',
    '###.........###.....',
    '#############.......',
    '#############.......',
    '#############.......',
  ],
  S: [
    '.......#############',
    '.......#############',
    '.......#############',
    '....###.............',
    '...###..............',
    '...###..............',
    '...###..............',
    '...#############....',
    '..#############.....',
    '..#############.....',
    '..#############.....',
    '...............###..',
    '..............###...',
    '..............###...',
    '..............###...',
    '..............###...',
    '.............###....',
    '############........',
    '############........',
    '############........',
  ],
  H: [
    '....###..........###',
    '....###..........###',
    '....###..........###',
    '....###..........###',
    '...###..........###.',
    '...###..........###.',
    '...###..........###.',
    '...###..........###.',
    '..################..',
    '..################..',
    '..################..',
    '..################..',
    '.###..........###...',
    '.###..........###...',
    '.###..........###...',
    '.###..........###...',
    '###..........###....',
    '###..........###....',
    '###..........###....',
    '###..........###....',
  ],
}

// Load-time validation: a wordmark letter without a font glyph, or a glyph
// that cannot fold into the whale's 10 terminal rows, is a programming
// error — fail at module load, not at some later resize when the full
// banner is first assembled (a narrow terminal would defer the crash into
// the resize handler).
for (const ch of WORDMARK) {
  if (ch !== ' ' && PIXEL_FONT[ch] === undefined) {
    throw new Error(`PIXEL_FONT lacks glyph for '${ch}' in WORDMARK`)
  }
}
for (const [ch, glyph] of Object.entries(PIXEL_FONT)) {
  if (glyph.length !== 2 * WHALE_ART.length) {
    throw new Error(`PIXEL_FONT['${ch}'] has ${glyph.length} pixel rows — need ${2 * WHALE_ART.length} (two per banner row)`)
  }
  const widths = [...new Set(glyph.map(row => row.length))]
  if (widths.length !== 1) {
    throw new Error(`PIXEL_FONT['${ch}'] has ragged pixel rows: widths ${widths.join(', ')}`)
  }
}

/**
 * The wordmark letters' total width in columns — the glyphs' widths
 * summed: 20 (D) + 20 (S) + 20 (H) = 60. The 2-column gaps between
 * letters are added separately in WELCOME_FULL_WIDTH (2 gaps × 2 columns
 * → the wordmark block spans 64).
 */
const WORDMARK_WIDTH = [...WORDMARK].reduce((width, ch) => width + (ch === ' ' ? 1 : PIXEL_FONT[ch][0].length), 0)

/**
 * Full banner width: whale + gap + wordmark block — derived from the
 * constants so a layout tweak (gap, glyph widths) cannot silently desync
 * the degradation threshold in `buildWelcomeBanner` from the assembled
 * rows: 28 + 2 + 20 + 2 + 20 + 2 + 20 = 94 columns.
 */
export const WELCOME_FULL_WIDTH =
  WHALE_ART_WIDTH + WHALE_TITLE_GAP + WORDMARK_WIDTH + LETTER_GAP * (WORDMARK.length - 1)

/**
 * Fold a 20×20 pixel bitmap into its 10 terminal rows with the whale's own
 * half-block mapping: both pixel rows on → '█', top only → '▀', bottom
 * only → '▄', neither → ' '. Two pixels vertically per cell is what makes
 * the pixels square on screen — one column wide, one half-cell tall — the
 * same grid the whale art lives on.
 */
export function renderPixelGlyph(px: readonly string[]): readonly string[] {
  const rows: string[] = []
  for (let i = 0; i < px.length / 2; i++) {
    let row = ''
    for (let c = 0; c < px[0].length; c++) {
      const top = px[2 * i][c] === '#'
      const bottom = px[2 * i + 1][c] === '#'
      row += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    rows.push(row)
  }
  return rows
}

/**
 * Lay out the wordmark's 10 letter rows, 64 columns each: the D, S and H
 * glyphs with a 2-column gap between letters (20 + 2 + 20 + 2 + 20
 * columns). The pixel bitmaps are folded by renderPixelGlyph into the same
 * '█'/'▀'/'▄'/' ' glyphs the whale uses, so the rows paint exactly like
 * whale rows (see the header note). Wordmark glyph coverage and shape are
 * validated at module load.
 */
function wordmarkRows(): readonly string[] {
  const glyphRows = [...WORDMARK].map(ch => renderPixelGlyph(PIXEL_FONT[ch]))
  const rows = Array.from({ length: WHALE_ART.length }, () => '')
  for (let i = 0; i < glyphRows.length; i++) {
    for (let r = 0; r < rows.length; r++) {
      rows[r] += glyphRows[i][r]
      if (i < glyphRows.length - 1) rows[r] += ' '.repeat(LETTER_GAP)
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
 * Width floor: the full banner is 94 columns wide plus the transcript
 * Text's 1-column left/right padding (the renderer passes its Text paddingX
 * — currently 1 — so the threshold is 96). Below it the banner degrades
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
