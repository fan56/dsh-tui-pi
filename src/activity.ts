/**
 * Live activity panels — the single fixed think/tool status surfaces pinned
 * ABOVE the chat input (live-widgets.ts mounts them; index.ts routes session
 * events through LiveWidgets.applyEvent). One ThinkPanel and one ToolPanel
 * instance exist for the whole TUI run: think/tool activity NEVER creates
 * transcript blocks — every event refreshes the same panel in place, and a
 * panel with no content renders zero rows (hidden until the next burst).
 *
 * Height modes (`dsh-tui.panelHeight`):
 *  - '1' (default): ONE borderless row — block identifier + elapsed time +
 *    the last content line (live-refreshed), right-truncated at the terminal
 *    width, never wrapped.
 *  - '5'/'7'/'10': the boxed panel (top border + header row + content rows +
 *    bottom border) at the configured displayed-row budget.
 *  - 'all': the boxed panel without a row cap (a streaming reasoning burst
 *    still boxes only a bounded live tail; settled tool results cap at
 *    ALL_TOOL_RESULT_LINES with a drop marker).
 *
 * Panels are self-drawing Components (render(width) per frame, no cached
 * rows — the TodosPanel pattern): a terminal resize re-lays the box out
 * automatically and a theme hot-switch needs only a repaint, never a replay.
 * Plain text is clipped BEFORE styling everywhere (clipToWidth counts SGR
 * fragments as visible columns — see clipRow's contract).
 */

import type { Component } from '@earendil-works/pi-tui'
import { ansiBg, ansiFg, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth, lastNonBlankLine, visibleWidth } from './text.ts'

/**
 * Configurable think/tool panel height. '1' is a single borderless row;
 * fixed values count the DISPLAYED rows of the box — the header line plus
 * the content rows (the two box borders are not counted); 'all' prints the
 * full body with no row cap.
 */
export type PanelHeight = '1' | '5' | '7' | '10' | 'all'

/**
 * Default think/tool panel height: ONE row — block identifier, elapsed time
 * and the last content line. The single default for every '1' fallback (the
 * settings schema default/entry/narrowing, the LiveWidgets constructor);
 * other heights are set through the `panelHeight` setting.
 */
export const DEFAULT_PANEL_HEIGHT: PanelHeight = '1'

/**
 * Type guard narrowing an unknown value to a `PanelHeight`: the single
 * narrowing shared by every settings-path consumer (the watch hook and the
 * startup reader in theme-settings.ts) so the accepted literal set cannot
 * drift between them again.
 */
export function isPanelHeight(value: unknown): value is PanelHeight {
  return value === '1' || value === '5' || value === '7' || value === '10' || value === 'all'
}
/** Content rows inside the default boxed panel (a '5' box minus the header row). */
const PANEL_BODY_LINES = 4

/**
 * 'all' streaming cap: while a reasoning stream is in flight, the boxed panel
 * keeps only this many trailing rows (per-frame cost stays O(tail), never
 * O(accumulated)). Fixed heights are tail-bounded by their row budget.
 */
export const STREAMING_TAIL_LINES = 200

/**
 * 'all' settle cap: a settled tool panel keeps at most this many body rows,
 * with a `… (+N lines)` marker for the drop.
 */
export const ALL_TOOL_RESULT_LINES = 2000

/** Thinking panel identifier (icon + label), 11 visible columns. */
const THINKING_HEADER = '💭 thinking'

/**
 * Fallback terminal columns when the real width is unknown (non-TTY
 * contexts, e.g. tests): conservative so no sane terminal wraps.
 */
const PANEL_LINE_CAP_FALLBACK = 200

/**
 * Bound of the accumulated reasoning tail a ThinkPanel keeps — enough for
 * the 'all' live tail (STREAMING_TAIL_LINES rows) plus slack, so a runaway
 * stream cannot grow the panel state unboundedly. Trimmed at line
 * boundaries; each delta does amortized O(1) trim work.
 */
const THINK_TAIL_CAP = 32_768

/**
 * Terminal columns a panel body row's CONTENT may occupy so the whole
 * bordered row renders on exactly one physical line: the body wraps at
 * `width - paddingX*2` (paddingX = 1), every row carries 4 columns of box
 * chrome (`│ ` … ` │`), and tool rows add a 2-column indent — hence the -6
 * (think) and -8 (tool, indent = 2) headroom.
 */
export function panelLineCap(columns: number | undefined, indent = 0): number {
  return Math.max(1, (columns === undefined ? PANEL_LINE_CAP_FALLBACK : columns) - 6 - indent)
}

/** Full visible width of one bordered panel row, box chrome included. */
export function panelBoxWidth(columns: number | undefined): number {
  return panelLineCap(columns) + 4
}

/**
 * One bordered panel row of exactly `boxWidth` visible columns: side borders
 * in `borderFg`, `inner` (already styled, already clipped) left-aligned and
 * padded with spaces to the full box width. No trailing RESET — the caller
 * wraps the row in the panel background SGR and terminates it.
 */
export function borderedRow(boxWidth: number, borderFg: string, inner: string): string {
  const pad = Math.max(0, boxWidth - 4 - visibleWidth(inner))
  return `${borderFg}│ ${inner}${' '.repeat(pad)}${borderFg} │`
}

/** Top border line (`┌─…─┐`), `boxWidth` columns wide, in `borderFg`. */
export function panelTopBorder(boxWidth: number, borderFg: string): string {
  return `${borderFg}┌${'─'.repeat(Math.max(0, boxWidth - 2))}┐`
}

/** Bottom border line (`└─…─┘`), `boxWidth` columns wide, in `borderFg`. */
export function panelBottomBorder(boxWidth: number, borderFg: string): string {
  return `${borderFg}└${'─'.repeat(Math.max(0, boxWidth - 2))}┘`
}

/**
 * Clip an unstyled line to one physical panel row at the CURRENT render
 * width. Must run BEFORE styling: clipToWidth counts per grapheme, so the
 * ASCII fragments of an SGR code would count as visible columns — clipping
 * plain text first, then applying ANSI, keeps the accounting exact.
 * `indent` is the leading content indent the row carries (2 for tool rows).
 * Carriage returns are stripped first: a bare \r (progress bars, CRLF tool
 * output) would break the fixed panel rows just like a wrap would — the
 * panel line is one row, not a line record.
 */
export function clipRow(text: string, width: number, indent = 0): string {
  return clipToWidth(text.replace(/\r/g, ''), panelLineCap(width, indent))
}

/**
 * Clip an unstyled line against the process terminal width (the historical
 * clipPanelLine contract — kept for callers outside a render(width) frame,
 * e.g. the running-agent line's label).
 */
export function clipPanelLine(text: string, indent = 0): string {
  return clipToWidth(text.replace(/\r/g, ''), panelLineCap(process.stdout.columns, indent))
}

/**
 * Compose the bordered body rows (plus the bottom border) from
 * already-styled, already-clipped lines: keep the tail — newest rows win —
 * pad short content with empty boxed rows, then append the bottom border.
 * `bodyRows` is the panel's body-row budget or 'all': with 'all' every line
 * is kept verbatim, nothing is padded. Pad rows carry the box characters so
 * they survive Text's empty-row fast path. Callers clip each line BEFORE
 * styling — otherwise a styled line that outgrows its budget wraps and the
 * panel exceeds its configured rows.
 */
export function panelBodyText(
  lines: readonly string[],
  boxWidth: number,
  borderFg: string,
  bodyRows: number | 'all' = PANEL_BODY_LINES,
): string {
  const visible = bodyRows === 'all'
    ? [...lines]
    : lines.length > bodyRows ? lines.slice(-bodyRows) : [...lines]
  if (bodyRows !== 'all') {
    while (visible.length < bodyRows) visible.push('')
  }
  return [...visible.map(line => borderedRow(boxWidth, borderFg, line)), panelBottomBorder(boxWidth, borderFg)].join('\n')
}

// ------------------------------------------------------------ tool summary --

/**
 * The tool header's subject word: the file path for read/write-style tools,
 * the command's first word for cli-style tools ('git', 'python') — the first
 * whitespace token of the highest-priority string argument (same key
 * priority as callDetail's summary). '' when the arguments carry no usable
 * string (the header then shows the bare tool name).
 */
export function toolSubject(rawArguments: string): string {
  const firstWord = (value: string): string => value.trim().split(/\s+/u)[0] ?? ''
  try {
    const parsed = JSON.parse(rawArguments) as Record<string, unknown>
    for (const key of ['command', 'file_path', 'path', 'query', 'url', 'pattern', 'description']) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim() !== '') return firstWord(value)
    }
    for (const value of Object.values(parsed)) {
      if (typeof value === 'string' && value.trim() !== '') return firstWord(value)
    }
  } catch {
    // Model-controlled rawArguments; non-JSON yields no subject.
  }
  return ''
}

/** One-line summary of the call arguments, per common tool shape. */
export function callDetail(rawArguments: string, limit = 120): string {
  try {
    const parsed = JSON.parse(rawArguments) as Record<string, unknown>
    const parts: string[] = []
    if (typeof parsed.command === 'string') parts.push(`$ ${parsed.command}`)
    if (typeof parsed.file_path === 'string') parts.push(parsed.file_path)
    if (typeof parsed.path === 'string' && parts.length === 0) parts.push(parsed.path)
    if (typeof parsed.pattern === 'string') parts.push(`pattern: ${parsed.pattern}`)
    if (typeof parsed.query === 'string') parts.push(`query: ${parsed.query}`)
    if (typeof parsed.url === 'string') parts.push(parsed.url)
    if (typeof parsed.description === 'string' && parts.length === 0) parts.push(parsed.description)
    if (parts.length === 0) {
      const flat = rawArguments.replace(/\s+/g, ' ')
      parts.push(flat)
    }
    const joined = parts.join('  ').replace(/\n/g, ' ⏎ ')
    return clipToWidth(joined, limit)
  } catch {
    return ''
  }
}

/** First text content of a tool result, raw lines. */
export function resultTextLines(content: readonly { type: string; text?: string }[]): string[] {
  for (const block of content) {
    if (block.type === 'text' && block.text !== undefined) {
      return block.text.replace(/\s+$/u, '').split('\n')
    }
  }
  return []
}

// ------------------------------------------------------------ panel pieces --

/**
 * Append `delta` to the bounded tail buffer, trimming whole head lines past
 * THINK_TAIL_CAP (amortized O(1) per delta — the trim only fires when the
 * buffer outgrows the cap, and each firing drops at least one whole line).
 */
function boundTail(buffer: string, delta: string): string {
  let next = buffer + delta
  while (next.length > THINK_TAIL_CAP) {
    const nl = next.indexOf('\n')
    if (nl === -1) {
      next = next.slice(-Math.floor(THINK_TAIL_CAP / 2))
      break
    }
    next = next.slice(nl + 1)
  }
  return next
}

/**
 * Assemble one borderless status row from plain pieces: identifier, meta
 * (elapsed), and an optional ` · <tail>` suffix. The tail gets whatever the
 * row has left and is truncated at the right edge (never wrapped); when the
 * pieces do not fit even without a tail, the assembled plain row is clipped
 * and returned in a single muted style so no styled segment can push past
 * the width. Pieces are styled only after every clip — the repo rule.
 */
function statusRow(
  width: number,
  theme: TuiTheme,
  id: string,
  meta: string,
  tail: string | undefined,
  idStyle: (text: string) => string,
): string {
  const p = theme.palette
  const subtle = (text: string) => ansiFg(p.fgSubtle) + text + RESET
  const muted = (text: string) => ansiFg(p.fgMuted) + text + RESET
  const idW = visibleWidth(id)
  const metaW = visibleWidth(meta)
  let tailText = ''
  if (tail !== undefined && tail !== '') {
    const tailBudget = width - idW - metaW - 3
    if (tailBudget >= 4) tailText = ` · ${clipToWidth(tail, tailBudget - 3)}`
  }
  const plain = id + meta + tailText
  if (visibleWidth(plain) > width) {
    return muted(clipToWidth(plain, width))
  }
  return idStyle(id) + subtle(meta) + muted(tailText)
}

/** Panel background wrapper: prefixes the bg SGR, terminates with RESET. */
function bgRow(bgPrefix: string, row: string): string {
  return bgPrefix + row + RESET
}

// ------------------------------------------------------------- ThinkPanel --

/**
 * The live thinking panel: one fixed surface for the WHOLE run, refreshed in
 * place by every reasoning delta. Visible while a reasoning burst streams
 * (feed); hidden by the next phase event (text delta, tool call, message
 * assembly, turn end — LiveWidgets.applyEvent drives those).
 */
export class ThinkPanel implements Component {
  private state: { startedAt: number; tail: string } | undefined
  private height: PanelHeight = DEFAULT_PANEL_HEIGHT
  private readonly getTheme: () => TuiTheme

  constructor(getTheme: () => TuiTheme) {
    this.getTheme = getTheme
  }

  invalidate(): void { /* stateless between renders — the theme comes via getTheme */ }

  /** Whether the panel currently has content (drives the live tick). */
  isVisible(): boolean {
    return this.state !== undefined
  }

  setHeight(height: PanelHeight): void {
    this.height = height
  }

  /** One reasoning delta; the first delta of a burst opens the panel. */
  feed(delta: string): void {
    if (delta === '') return
    const state = this.state
    if (state === undefined) {
      this.state = { startedAt: Date.now(), tail: boundTail('', delta) }
    } else {
      state.tail = boundTail(state.tail, delta)
    }
  }

  hide(): void {
    this.state = undefined
  }

  render(width: number): string[] {
    const state = this.state
    if (state === undefined) return []
    const theme = this.getTheme()
    const p = theme.palette
    const elapsed = `${((Date.now() - state.startedAt) / 1000).toFixed(1)}s`

    if (this.height === '1') {
      const id = THINKING_HEADER
      const row = statusRow(
        width,
        theme,
        id,
        ` · ${elapsed}`,
        lastNonBlankLine(state.tail),
        text => `\x1b[3m${ansiFg(p.thinking)}${text}\x1b[23m`,
      )
      return [row]
    }

    // Boxed panel: top border + header + content rows + bottom border, every
    // row on the thinking panel background.
    const boxWidth = panelBoxWidth(width)
    const borderFg = ansiFg(p.panelBorder)
    const bgPrefix = ansiBg(p.thinkingPanelBg)
    const bodyRows: number | 'all' = this.height === 'all' ? 'all' : Number(this.height) - 1
    const thinkStyle = (text: string): string => `\x1b[3m${ansiFg(p.thinking)}${text}\x1b[23m`
    const headerInner = thinkStyle(clipRow(`${THINKING_HEADER} · ${elapsed}`, width))
    let lines = state.tail.trim().split('\n')
    // Bounded live tail while streaming in 'all' mode — per-frame cost stays
    // O(tail), never O(accumulated).
    if (bodyRows === 'all' && lines.length > STREAMING_TAIL_LINES) {
      lines = lines.slice(-STREAMING_TAIL_LINES)
    }
    const body = panelBodyText(lines.map(line => thinkStyle(clipRow(line, width))), boxWidth, borderFg, bodyRows)
    return [
      bgRow(bgPrefix, panelTopBorder(boxWidth, borderFg)),
      bgRow(bgPrefix, borderedRow(boxWidth, borderFg, headerInner)),
      ...body.split('\n').map(row => bgRow(bgPrefix, row)),
    ]
  }
}

// -------------------------------------------------------------- ToolPanel --

/** Live state of the one tool the panel currently tracks. */
interface ToolState {
  callId: string
  name: string
  subject: string
  startedAt: number
  status: 'pending' | 'success' | 'error'
  /** Settle timestamp; elapsed freezes here once the tool settles. */
  endedAt?: number
  /** Plain, unstyled body lines (args detail, error line, result lines). */
  bodyLines: string[]
}

/** The settle payload ToolPanel.settle accepts (structural, event-shape). */
export interface ToolSettleData {
  error?: { name: string; code?: string }
  block?: { isError?: boolean; content: readonly { type: string; text?: string }[] }
}

/**
 * The live tool panel: one fixed surface refreshed by every tool call — a
 * new call replaces the tracked tool (sequential/parallel calls all refresh
 * this same panel), a matching result settles it (icon/status/time freeze,
 * body shows the result tail), and any later phase event hides it.
 */
export class ToolPanel implements Component {
  private state: ToolState | undefined
  private height: PanelHeight = DEFAULT_PANEL_HEIGHT
  private readonly getTheme: () => TuiTheme

  constructor(getTheme: () => TuiTheme) {
    this.getTheme = getTheme
  }

  invalidate(): void { /* stateless between renders — the theme comes via getTheme */ }

  /** Whether the panel currently has content (drives the live tick). */
  isVisible(): boolean {
    return this.state !== undefined
  }

  setHeight(height: PanelHeight): void {
    this.height = height
  }

  /** A new tool call: replaces the tracked tool with a pending one. */
  begin(callId: string, name: string, rawArguments: string): void {
    const detail = callDetail(rawArguments)
    this.state = {
      callId,
      name,
      subject: toolSubject(rawArguments),
      startedAt: Date.now(),
      status: 'pending',
      bodyLines: detail === '' ? [] : [detail],
    }
  }

  /**
   * Settle the tracked tool. Results for a callId other than the tracked
   * one (parallel calls; a result racing a newer begin) are ignored.
   * @returns whether the tracked tool settled.
   */
  settle(callId: string, data: ToolSettleData): boolean {
    const state = this.state
    if (state === undefined || state.callId !== callId || state.status !== 'pending') return false
    const isError = data.error !== undefined || (data.block?.isError ?? false)
    state.status = isError ? 'error' : 'success'
    state.endedAt = Date.now()
    const body = [...state.bodyLines]
    if (data.error !== undefined) {
      body.push(`${data.error.name}: ${data.error.code ?? ''}`.replace(/: $/, ''))
    }
    if (data.block !== undefined) {
      for (const line of resultTextLines(data.block.content)) body.push(line)
    }
    state.bodyLines = body
    return true
  }

  hide(): void {
    this.state = undefined
  }

  render(width: number): string[] {
    const state = this.state
    if (state === undefined) return []
    const theme = this.getTheme()
    const p = theme.palette
    const icon = state.status === 'pending' ? '⚙' : state.status === 'success' ? '✔' : '✘'
    const statusColor = state.status === 'pending'
      ? p.fgMuted
      : state.status === 'success' ? p.success : p.danger
    const end = state.endedAt ?? Date.now()
    const elapsed = `${((end - state.startedAt) / 1000).toFixed(1)}s`
    const idPlain = clipRow(state.subject === '' ? state.name : `${state.name} ${state.subject}`, width, 2)

    if (this.height === '1') {
      const row = statusRow(
        width,
        theme,
        `${icon} ${idPlain}`,
        ` · ${elapsed}`,
        lastNonBlankLine(state.bodyLines.join('\n')),
        text => ansiFg(statusColor) + text + RESET,
      )
      return [row]
    }

    // Boxed panel: top border + status-colored header + body tail + bottom
    // border, on the pending/success/error tool surface.
    const boxWidth = panelBoxWidth(width)
    const borderFg = ansiFg(p.panelBorder)
    const bg = state.status === 'pending'
      ? p.toolPanelBg
      : state.status === 'success' ? p.successMuted : p.dangerMuted
    const bgPrefix = ansiBg(bg)
    const bodyRows: number | 'all' = this.height === 'all' ? 'all' : Number(this.height) - 1
    const headerText = state.subject === '' ? `${state.name} · ${elapsed}` : `${state.name} ${state.subject} · ${elapsed}`
    const headerInner = ansiFg(statusColor) + `${icon} ${clipRow(headerText, width, 2)}`
    // Body tail + drop marker at the row budget ('all' keeps up to
    // ALL_TOOL_RESULT_LINES rows); the marker replaces the first visible row.
    const cap = bodyRows === 'all' ? ALL_TOOL_RESULT_LINES : bodyRows
    let lines = state.bodyLines
    let marker = false
    if (lines.length > cap) {
      const dropped = lines.length - cap
      lines = lines.slice(-cap)
      lines[0] = `… (+${dropped} lines)`
      marker = true
    }
    const styled = lines.map((line, i) => ansiFg(marker && i === 0 ? p.fgSubtle : p.fgMuted) + `  ${clipRow(line, width, 2)}`)
    const body = panelBodyText(styled, boxWidth, borderFg, bodyRows)
    return [
      bgRow(bgPrefix, panelTopBorder(boxWidth, borderFg)),
      bgRow(bgPrefix, borderedRow(boxWidth, borderFg, headerInner)),
      ...body.split('\n').map(row => bgRow(bgPrefix, row)),
    ]
  }
}
