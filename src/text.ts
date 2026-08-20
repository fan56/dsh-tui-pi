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
export const ELLIPSIS = '…'

/**
 * Last non-blank line of `text`, ANSI-stripped, newline-normalized and
 * whitespace-folded onto one row — the "latest visible line" every live
 * status surface shows (think/tool 1-line panels, running-agent tails).
 * Undefined when the text carries no visible line at all.
 */
export function lastNonBlankLine(text: string): string | undefined {
  const body = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = body.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line === '') continue
    return line.replace(/\s+/g, ' ')
  }
  return undefined
}

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
