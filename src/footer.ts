/**
 * Powerline-style status footer, ported from pi-powerline-footer.
 *
 * Segments (left → right): fixed brand "dsh" · provider · model+thinking ·
 * context usage · cache-hit rate · message count · tool count, then a
 * right-aligned 24h clock. Segment backgrounds are the pi-powerline-footer
 * palette; separators are the powerline arrow from src/icons.ts (U+E0B0 in
 * nerdfont/auto-with-font, ▸ in the plain icon set), tinted by the
 * neighbouring segment colours.
 *
 * Render cost is O(segments): every statistic is read from the bridge's
 * incrementally maintained counters (never a session-log scan). The 1s clock
 * tick only re-renders this component's single line.
 */

import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui'
import type { BridgeStats } from './session.ts'
import { ansiBg, ansiFg, BOLD, POWERLINE, RESET, type TuiTheme } from './theme/index.ts'
import { hexIsLight } from './theme/palette.ts'
import { clipToWidth } from './text.ts'
import { arrowRight } from './icons.ts'

/**
 * The footer keybinding hint, assembled from the user's `dsh-tui.footerHints`
 * selection (see buildFooterHint) - the pre-feature full string is what the
 * all-true default produces, and stays exactly 103 visible columns. The
 * no-wrap rendering lives in `FooterHint` (a width-clipping component, not a
 * word-wrapping Text). The unit test in test/history.test.mjs guards the
 * default against future length regressions (a longer hint word-wraps on
 * 105-118-column terminals and hides its suffix on <=104).
 */
export const FOOTER_HINT =
  '⌨ Enter: send · Esc ×2: stop · Ctrl+C ×2: quit · Ctrl+D: quit (empty) · Ctrl+G: subagents · Tab: preset · ↑↓: history'

/** The toggleable footer hint segments, keyed as in the `dsh-tui` settings. */
export interface FooterHints {
  send: boolean
  stop: boolean
  quit: boolean
  quitEmpty: boolean
  subagents: boolean
  preset: boolean
  history: boolean
}

/** Every hint off - the footer hint bar renders nothing. */
export const DEFAULT_FOOTER_HINTS: FooterHints = Object.freeze({
  send: true,
  stop: true,
  quit: true,
  quitEmpty: true,
  subagents: true,
  preset: true,
  history: true,
})

/** The hint segments in display order, each without the `⌨ ` lead. */
export const FOOTER_HINT_ITEMS: ReadonlyArray<{ id: keyof FooterHints; label: string }> = [
  { id: 'send', label: 'Enter: send' },
  { id: 'stop', label: 'Esc ×2: stop' },
  { id: 'quit', label: 'Ctrl+C ×2: quit' },
  { id: 'quitEmpty', label: 'Ctrl+D: quit (empty)' },
  { id: 'subagents', label: 'Ctrl+G: subagents' },
  { id: 'preset', label: 'Tab: preset' },
  { id: 'history', label: '↑↓: history' },
]

/**
 * Assemble the footer hint from the user's per-segment on/off selection, in
 * the fixed display order. `''` when every segment is off.
 */
export function buildFooterHint(shown: FooterHints): string {
  const parts = FOOTER_HINT_ITEMS.filter(item => shown[item.id]).map(item => item.label)
  if (parts.length === 0) return ''
  return `⌨ ${parts.join(' · ')}`
}

/**
 * The footer hint bar - a single width-clipped row, never word-wrapped. The
 * old `Text` wrapped the 103-column hint on narrow terminals; this component
 * clips it to the current width every frame (and re-reads the live hints
 * selection through the getter, so a /settings change applies on the next
 * repaint). Renders zero rows when the user turned every hint off.
 */
export class FooterHint implements Component {
  private readonly getTheme: () => TuiTheme
  private readonly getHints: () => FooterHints

  constructor(getTheme: () => TuiTheme, getHints: () => FooterHints) {
    this.getTheme = getTheme
    this.getHints = getHints
  }

  invalidate(): void { /* stateless between renders - both sources are live getters */ }

  render(width: number): string[] {
    const hint = buildFooterHint(this.getHints())
    if (hint === '') return []
    // paddingX 1 on each side, matching the powerline segments' leading space.
    const inner = Math.max(1, width - 2)
    const clipped = clipToWidth(hint, inner)
    const styled = ansiFg(this.getTheme().palette.fgSubtle) + clipped + RESET
    const pad = ' '.repeat(Math.max(0, width - visibleWidth(clipped) - 2))
    return [` ${styled}${pad} `]
  }
}

const WHITE = ansiFg('#FFFFFF')
/** Segment text on bright fills (e.g. amber #FFC107): white is unreadable there. */
const DARK_TEXT = ansiFg('#1f2328')

/** Segment label text: white bold on dark fills, near-black on bright ones. */
function segmentText(bgHex: string): string {
  return hexIsLight(bgHex) ? DARK_TEXT : WHITE
}

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
  /** Current agent preset short label (e.g. "Standard"), or undefined. */
  getPreset(): string | undefined
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
    out += `${ansiBg(s.bgHex)}${BOLD}${segmentText(s.bgHex)} ${s.label} `
    if (i + 1 < segs.length) {
      out += `${ansiBg(segs[i + 1]!.bgHex)}${ansiFg(s.bgHex)}${arrowRight()}`
    } else {
      out += RESET + ansiFg(s.bgHex) + arrowRight() + RESET
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
  private readonly getTheme: () => TuiTheme

  constructor(source: FooterDataSource, getTheme: () => TuiTheme) {
    this.source = source
    this.getTheme = getTheme
  }

  invalidate(): void { /* stateless between renders - the theme comes via getTheme */ }

  render(width: number): string[] {
    const stats = this.source.getStats()
    const selection = this.source.getSelection()

    const presetLabel = this.source.getPreset()
    const brandLabel = presetLabel ? `dsh(${presetLabel})` : 'dsh'
    const segs: Segment[] = [{ label: brandLabel, bgHex: POWERLINE.brand }]
    if (selection !== undefined) {
      segs.push({ label: `☁️ ${selection.provider}`, bgHex: POWERLINE.provider })
      const model = clipToWidth(selection.model.split('/').pop()!, 24)
      const effort = selection.reasoningEffort ?? 'off'
      segs.push({
        label: `🤖 ${model} ${thinkingIcon(effort)} ${effort}`,
        bgHex: thinkingBg(effort),
      })
    }

    // Context usage: the current occupancy estimate (latest request's billed
    // input + output + a CJK estimate of messages after it) vs. the model's
    // window — NOT the cumulative inputTokens, which only grows. Percent is
    // capped at 100 (the window is a hard ceiling; the estimate can overshoot
    // while it prices pending messages that a compaction will drop).
    const window = this.source.getContextWindow()
    // Defensive `?? 0`: a stats source without the field (any object missing
    // contextTokens) degrades to an empty context instead of rendering
    // `undefined`/`NaN` in the segment.
    const used = stats.contextTokens ?? 0
    if (window !== undefined && window > 0) {
      const percent = Math.min(100, (used / window) * 100)
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

    // The clock must carry the palette foreground: the app paints the canvas
    // background itself, so unstyled text would fall back to the terminal's
    // default fg (black on many dark profiles) and vanish on the dark canvas.
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false })
    const clock = ansiFg(this.getTheme().palette.fgDefault) + time + RESET
    const clockWidth = visibleWidth(clock)
    const pad = Math.max(1, width - leftWidth - clockWidth)

    return [truncateToWidth(left + ' '.repeat(pad) + clock, width)]
  }
}
