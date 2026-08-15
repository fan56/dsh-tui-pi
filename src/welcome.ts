/**
 * Startup welcome banner: a pixel-art whale (generated pixel-by-pixel from
 * the user's image) with the "DSH TUI" wordmark vertically centered against
 * it. Rendered as the transcript's first component, above every message.
 *
 * The art is a 28-column × 10-row grid. Glyph semantics: '█' is solid in
 * both halves, '▀' is solid in the top half only, '▄' is solid in the bottom
 * half only, ' ' is transparent. The transparent half of a half-block stays
 * unpainted — it shows the terminal default background. This is deliberate:
 * the transcript never paints a canvas background (the TUI startup already
 * sets the terminal background to the theme canvas), so a half-block's
 * transparent half must fall through to the terminal default, not to an
 * explicit theme background. Painting it would mismatch on any terminal
 * whose default background differs from the theme canvas.
 */

import { ansiFg, BOLD, POWERLINE, RESET, type TuiTheme } from './theme/index.ts'

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
/** The wordmark itself. */
const TITLE = 'DSH TUI'
/** The wordmark's row: floor((n-1)/2) — the row just above the vertical midpoint of the 10-row art (row 4, 0-based). */
const TITLE_ROW = Math.floor((WHALE_ART.length - 1) / 2)

/**
 * Paint one consecutive run of whale glyphs as a single SGR span, RESET at
 * the end. Runs are painted in the whale blue only — half-block glyphs
 * ('▀'/'▄') are never given a background, so their transparent half shows
 * the terminal default background (see the header note).
 */
function paintWhaleRun(run: string): string {
  return ansiFg(WHALE_COLOR) + run + RESET
}

/**
 * Assemble the welcome banner text. Every row is the styled whale row, the
 * 4-column gap, then the wordmark column: 'DSH TUI' in bold theme fg on the
 * vertically centered row, equal-width spaces on the others. Rows are padded
 * so the whale and the wordmark column line up across the whole banner.
 *
 * Width floor: the banner is 39 columns wide (28 art + 4 gap + 7 wordmark)
 * plus the transcript Text's 1-column left/right padding, so a terminal of
 * 41 columns or more renders it as exactly 10 rows. Below 41 columns the
 * rows wrap (each row's trailing spaces wrap onto the next line) and the
 * 10-row shape breaks — accepted degradation, documented rather than
 * clipped, because a terminal that narrow can't show the whale anyway.
 */
export function buildWelcomeBanner(theme: TuiTheme): string {
  const whaleWidth = Math.max(...WHALE_ART.map(row => row.length))
  return WHALE_ART.map((row, index) => {
    // Split the whale row into consecutive runs of non-space glyphs; the
    // spaces between runs stay unstyled (transparent, terminal background).
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
    const title = index === TITLE_ROW
      ? BOLD + ansiFg(theme.palette.fgDefault) + TITLE + RESET
      : ' '.repeat(TITLE.length)
    return styled + ' '.repeat(WHALE_TITLE_GAP + whaleWidth - row.length) + title
  }).join('\n')
}
