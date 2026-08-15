/**
 * Terminal-column text utilities — every width decision in this TUI goes
 * through this module, never raw String.length: CJK full-width characters
 * occupy two terminal columns, and surrogate pairs / grapheme clusters
 * (emoji) must never be split.
 *
 * `visibleWidth` is pi-tui's own (east-asian-width aware, grapheme-clustered,
 * ANSI-stripping) — re-exported here so call sites share one width vocabulary.
 */

import { visibleWidth } from '@earendil-works/pi-tui'

export { visibleWidth }

/** Truncation marker; U+2026 is one terminal column wide. */
const ELLIPSIS = '…'

/** Grapheme-clustered iteration (Intl.Segmenter) — never splits a surrogate pair. */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Clip `text` to at most `maxWidth` terminal columns, whole graphemes only.
 *
 * Semantics (content first, ellipsis only when it fits):
 * - visible width ≤ maxWidth → returned unchanged, no ellipsis;
 * - otherwise the longest whole-grapheme prefix that fits is kept, and a
 *   trailing "…" is appended only when it still fits within maxWidth (i.e.
 *   the kept prefix left at least one column free); the result is never
 *   wider than maxWidth.
 */
export function clipToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (visibleWidth(text) <= maxWidth) return text
  let kept = ''
  let keptWidth = 0
  for (const { segment } of segmenter.segment(text)) {
    const width = visibleWidth(segment)
    if (keptWidth + width > maxWidth) break
    kept += segment
    keptWidth += width
  }
  if (kept === '') return ''
  // One column free after the kept prefix → the ellipsis fits (it is width 1).
  return keptWidth + 1 <= maxWidth ? `${kept}${ELLIPSIS}` : kept
}
