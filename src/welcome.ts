/**
 * Startup welcome banner: a pixel-art whale (generated pixel-by-pixel from
 * the user's image) with the "DSH TUI" wordmark to its right, drawn in a
 * blocky 5-column × 10-row pixel font (PIXEL_FONT) so the letters match the
 * whale's height. Rendered as the transcript's first component, above every
 * message.
 *
 * The banner is a 68-column × 10-row grid: 28 columns of whale art, a
 * 4-column gap, then 36 columns of pixel letters (6 letters × 5 columns,
 * 1 blank between letters, 2 between words). Below 70 terminal columns the
 * wordmark is dropped — the banner degrades to the 10 whale rows (28
 * columns each, no gap, no letters), so a narrow terminal never wraps the
 * letter rows; the full banner comes back as soon as the terminal is 70
 * columns or wider again (the transcript rebuilds on resize). Glyph
 * semantics: '█' is solid in both halves, '▀' is solid in the top half
 * only, '▄' is solid in the bottom half only, ' ' is transparent; the
 * letters map the font's '#' strokes to '█' blocks and its '.' empties to
 * ' '. Everything is painted
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

/** The wordmark, rendered from PIXEL_FONT: 6 letters × 5 + 4×1 letter gaps + 1×2 word gap = 36 columns. */
export const WORDMARK = 'DSH TUI'

/**
 * Blocky 5-column × 10-row pixel font for the wordmark letters: '#' is a
 * stroke cell, '.' is empty. The 10 rows match the whale's height, so the
 * letters and the whale are naturally top-aligned in the banner. Strokes
 * render as '█' blocks in the whale brand blue; empties fall through to the
 * terminal default background like the whale's spaces.
 */
export const PIXEL_FONT: Record<string, readonly string[]> = {
  D: [
    '#####',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#####',
  ],
  S: [
    '#####',
    '#....',
    '#....',
    '#####',
    '....#',
    '....#',
    '....#',
    '....#',
    '#....',
    '#####',
  ],
  H: [
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#####',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
  ],
  T: [
    '#####',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
  ],
  U: [
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#...#',
    '#####',
  ],
  I: [
    '#####',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '#####',
  ],
}

/**
 * Lay out the wordmark's 10 letter rows, 36 columns each: 5 per letter,
 * 1 blank column between letters, 2 between words. The font's '#' strokes
 * map to '█' and '.' empties to ' ', so the rows paint exactly like whale
 * rows (see the header note). A wordmark letter without a font glyph is a
 * programming error — fail loudly at startup instead of crashing later on
 * the undefined glyph.
 */
function wordmarkRows(): readonly string[] {
  const rows = Array.from({ length: WHALE_ART.length }, () => '')
  for (let i = 0; i < WORDMARK.length; i++) {
    const ch = WORDMARK[i]
    const isLetter = ch !== ' '
    if (isLetter && PIXEL_FONT[ch] === undefined) {
      throw new Error(`PIXEL_FONT lacks glyph for '${ch}' in WORDMARK`)
    }
    // One blank column after a letter when the next char is another letter.
    const tail = isLetter && i + 1 < WORDMARK.length && WORDMARK[i + 1] !== ' ' ? ' ' : ''
    for (let r = 0; r < rows.length; r++) {
      rows[r] += (isLetter ? PIXEL_FONT[ch][r] : '  ').replaceAll('#', '█').replaceAll('.', ' ') + tail
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
 * 4-column gap, then the 36-column pixel-letter row — all painted in the
 * whale brand blue. The banner is theme-independent: no theme colors, no
 * bold, nothing to repaint on a theme switch.
 *
 * Width floor: the full banner is 68 columns wide (28 art + 4 gap + 36
 * letters) plus the transcript Text's 1-column left/right padding, so a
 * terminal of 70 columns or more renders it as exactly 10 rows. Below 70
 * columns (the width `columns` was read from — renderWelcome passes
 * process.stdout.columns) the banner degrades to the whale alone: the 10
 * art rows, 28 columns each, no gap and no letters, which needs only 30
 * columns with the padding. A terminal narrower than that wraps the whale
 * rows onto extra lines (accepted degradation, documented rather than
 * clipped, because a terminal that narrow can't show the whale either
 * way). `undefined` (non-TTY contexts, e.g. tests) counts as wide — the
 * full banner, conservative like PANEL_LINE_CAP_FALLBACK.
 */
export function buildWelcomeBanner(columns: number | undefined): string {
  if (columns !== undefined && columns < 70) {
    // Narrow terminal: whale-only, the 10 art rows (28 columns each) — no
    // gap, no letters. Wraps only below the 30-column floor.
    return WHALE_ART.map(row => paintRowRuns(row)).join('\n')
  }
  const whaleWidth = Math.max(...WHALE_ART.map(row => row.length))
  const letters = wordmarkRows()
  return WHALE_ART.map((row, r) => {
    return paintRowRuns(row) + ' '.repeat(WHALE_TITLE_GAP + whaleWidth - row.length) + paintRowRuns(letters[r])
  }).join('\n')
}
