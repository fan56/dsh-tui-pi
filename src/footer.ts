/**
 * Powerline-style status footer, ported from pi-powerline-footer.
 *
 * Segments (left → right): fixed brand "dsh" · provider · model+thinking ·
 * context usage · cache-hit rate · message count · tool count, then a
 * right-aligned 24h clock. Segment backgrounds are the pi-powerline-footer
 * palette; separators are U+E0B0 powerline arrows tinted by the neighbouring
 * segment colours.
 *
 * Render cost is O(segments): every statistic is read from the bridge's
 * incrementally maintained counters (never a session-log scan). The 1s clock
 * tick only re-renders this component's single line.
 */

import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui'
import type { BridgeStats } from './session.ts'
import { ansiBg, ansiFg, BOLD, POWERLINE, RESET } from './theme/index.ts'
import { clipToWidth } from './text.ts'

/**
 * The footer keybinding hint — plain text (no ANSI), exactly 103 visible
 * columns. This is the pre-feature README-documented width; the ANSI wrapping
 * lives in `paintFooterHint` (index.ts). The unit test in test/history.test.mjs
 * guards it against future length regressions (a longer hint word-wraps on
 * 105–118-column terminals and hides its suffix on ≤104).
 */
export const FOOTER_HINT =
  '⌨ Enter: send · Esc ×2: stop · Ctrl+C ×2: quit · Ctrl+D: quit (empty) · Ctrl+G: subagents · ↑↓: history'

const ARROW_RIGHT = '\uE0B0'
const WHITE = ansiFg('#FFFFFF')

interface Segment {
  label: string
  bgHex: string
}

export interface FooterDataSource {
  /** O(1) incremental counters. */
  getStats(): BridgeStats
  /** Current model selection (provider, model, reasoning effort). */
  getSelection(): { provider: string; model: string; reasoningEffort?: string } | undefined
  /** Model context window in tokens, when known. */
  getContextWindow(): number | undefined
  /** Git branch of the session cwd, when known. */
  getBranch(): string | undefined
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

function buildSegments(segs: readonly Segment[]): string {
  if (segs.length === 0) return ''
  let out = ''
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    out += `${ansiBg(s.bgHex)}${BOLD}${WHITE} ${s.label} `
    if (i + 1 < segs.length) {
      out += `${ansiBg(segs[i + 1]!.bgHex)}${ansiFg(s.bgHex)}${ARROW_RIGHT}`
    } else {
      out += RESET + ansiFg(s.bgHex) + ARROW_RIGHT + RESET
    }
  }
  return out
}

/** Thinking-level → segment background (pi-powerline-footer mapping). */
function thinkingBg(level: string | undefined): string {
  const key = (level ?? 'off') as keyof typeof POWERLINE.thinking
  return POWERLINE.thinking[key] ?? POWERLINE.thinking.off
}

function thinkingIcon(level: string | undefined): string {
  switch (level ?? 'off') {
    case 'minimal': return '◔'
    case 'low': return '◑'
    case 'medium': return '◕'
    case 'high': return '●'
    case 'xhigh': return '◉'
    case 'max': return '★'
    default: return '○'
  }
}

function contextBg(percent: number): string {
  if (percent >= 90) return POWERLINE.contextDanger
  if (percent >= 70) return POWERLINE.contextOrange
  if (percent >= 50) return POWERLINE.contextWarn
  return POWERLINE.contextOk
}

export class PowerlineFooter implements Component {
  private readonly source: FooterDataSource

  constructor(source: FooterDataSource) {
    this.source = source
  }

  invalidate(): void { /* stateless between renders */ }

  render(width: number): string[] {
    const stats = this.source.getStats()
    const selection = this.source.getSelection()

    const segs: Segment[] = [{ label: 'dsh', bgHex: POWERLINE.brand }]
    if (selection !== undefined) {
      segs.push({ label: `☁️ ${selection.provider}`, bgHex: POWERLINE.provider })
      const model = clipToWidth(selection.model.split('/').pop()!, 24)
      const effort = selection.reasoningEffort ?? 'off'
      segs.push({
        label: `🤖 ${model} ${thinkingIcon(effort)} ${effort}`,
        bgHex: thinkingBg(effort),
      })
    }

    // Context usage: latest request's input tokens vs. the model's window.
    const window = this.source.getContextWindow()
    const used = stats.inputTokens
    if (window !== undefined && window > 0) {
      const percent = (used / window) * 100
      segs.push({
        label: `🧠 ${fmtNum(used)}/${fmtNum(window)}(${percent.toFixed(1)}%)`,
        bgHex: contextBg(percent),
      })
    } else {
      segs.push({ label: `🧠 ${fmtNum(used)}`, bgHex: POWERLINE.contextOk })
    }

    if ((stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0) && stats.cacheHitRate !== undefined) {
      segs.push({ label: `⚡ CH${stats.cacheHitRate.toFixed(1)}%`, bgHex: POWERLINE.cache })
    }
    segs.push({ label: `💬 ${stats.msgCount} msgs`, bgHex: POWERLINE.messages })
    segs.push({ label: `🔧 ${stats.toolCallCount} tools`, bgHex: POWERLINE.tools })

    const left = buildSegments(segs)
    const leftWidth = visibleWidth(left)

    const clock = new Date().toLocaleTimeString('en-GB', { hour12: false })
    const clockWidth = visibleWidth(clock)
    const pad = Math.max(1, width - leftWidth - clockWidth)

    return [truncateToWidth(left + ' '.repeat(pad) + clock, width)]
  }
}
