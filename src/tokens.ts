/**
 * CJK-aware token estimation for the TUI's context-occupancy display.
 *
 * Ported from @aiwayds/dsh-dcp (`lib/summarizer.js`, `estimateTextTokens`).
 * CJK scripts and full-width forms are priced denser than ASCII: Han (中文),
 * kana (日文), hangul (韩文), plus CJK punctuation and full-width variants.
 * A CJK character encodes roughly one token in real tokenizers, while ASCII
 * runs ~4 chars/token, so the estimate is:
 *
 *   tokens = ceil(cjkCount / 2 + (length - cjkCount) / 4)
 *
 * The default `cjk` mode prices CJK near reality while staying identical to a
 * flat 4-chars/token meter for pure-ASCII text; `ascii` is that flat meter.
 * `Math.ceil` mirrors the host meter's per-character rounding. Used for the
 * "current occupancy" numerator (the footer's Context segment and the
 * subagent compact rows' `X/Y`), where messages appended after the last
 * billed request have no exact usage yet — this estimate fills the gap.
 */

/** CJK scripts + full-width forms (Han, kana, hangul, CJK punctuation, full-width). */
const CJK_CHAR = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g

/**
 * Estimate the token count of a text under a pricing mode (see the header).
 *
 * @param text - the text to price.
 * @param mode - `'cjk'` (default) prices CJK at ~2 chars/token and ASCII at 4;
 *   `'ascii'` is a flat 4 chars/token for every character.
 * @returns the estimated token count.
 */
export function estimateTextTokens(text: string, mode: 'cjk' | 'ascii' = 'cjk'): number {
  const source = String(text)
  if (mode === 'ascii') return Math.ceil(source.length / 4)
  const cjk = (source.match(CJK_CHAR) ?? []).length
  return Math.ceil(cjk / 2 + (source.length - cjk) / 4)
}

/**
 * CJK-aware token estimate of a text block list (the content shape shared by
 * `user/message`, `assistant/message` and `tool/result` inner blocks).
 *
 * @param blocks - unknown-shaped content blocks; text blocks are counted,
 *   everything else (tool-call, tool-result, reasoning, …) contributes the
 *   text strings it carries, ignoring structural overhead.
 * @param mode - pricing mode, see {@link estimateTextTokens}.
 * @returns the estimated token count of the joined text.
 */
export function estimateContentTokens(blocks: unknown, mode: 'cjk' | 'ascii' = 'cjk'): number {
  if (!Array.isArray(blocks)) return 0
  const parts: string[] = []
  const collect = (block: unknown): void => {
    if (block === null || typeof block !== 'object') return
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'tool-call' && typeof (b as { arguments?: unknown }).arguments === 'string') {
      parts.push((b as { arguments: string }).arguments)
    } else if (b.type === 'tool-result') {
      const inner = (b as { content?: unknown }).content
      if (Array.isArray(inner)) inner.forEach(collect)
    }
  }
  blocks.forEach(collect)
  return estimateTextTokens(parts.join('\n'), mode)
}
