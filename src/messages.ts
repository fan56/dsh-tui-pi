/**
 * Transcript rendering: turns dsh session events into pi-tui components.
 *
 * Incremental by design (pi-turbo lesson): every event does O(event) work —
 * streaming deltas update one Text in place, tool cards are keyed by callId,
 * and nothing ever re-scans the session log.
 *
 * Streaming strategy: during `assistant/chunk` the raw text grows in a plain
 * Text component; on the assembled `assistant/message` the streaming component
 * is replaced by proper Markdown rendering. This keeps per-token cost at
 * O(accumulated text) instead of re-parsing markdown on every delta.
 *
 * Panels: think blocks and tool cards render as fixed PANEL_HEIGHT rows — a
 * full box border (top border + header row + PANEL_BODY_LINES body rows +
 * bottom border). The transcript doc is a plain Container inside the outer
 * ScrollView, so pi-tui 0.84.2 never lays out nested components (a Container
 * without a layout node renders by simple concatenation — verified in
 * dist/layout.js) and an inner ScrollView can never obtain a viewport. The
 * body is therefore a padded tail of the last PANEL_BODY_LINES rows rather
 * than an internal scroll; every row (borders included) carries the panel
 * background.
 *
 * Theme hot-switch: every applied operation is appended to `replay` (O(1)
 * per event — never a render-path scan). `setTheme` is an explicit user
 * action, so it may do a one-off full rebuild: clear the doc and re-apply
 * the buffered operations against the new theme. Streaming, tool cards and
 * todos rebuild exactly as they were applied, so an in-flight stream simply
 * continues `setText` on its rebuilt component.
 */

import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Loads the SessionEventMap augmentation that adds command/run + command/done.
import type {} from '@deepseek-ai/dsh-commands'
import { ansiFg, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth, visibleWidth } from './text.ts'

/** Fixed total height of a think/tool panel: top border + header row + body
 * rows + bottom border.
 */
const PANEL_HEIGHT = 6
/** Body rows inside a panel (PANEL_HEIGHT - top border - header - bottom border). */
const PANEL_BODY_LINES = PANEL_HEIGHT - 3
/** Thinking panel header row content (icon + label), 11 visible columns. */
const THINKING_HEADER = '💭 thinking'
/**
 * Fallback terminal columns when the real width is unknown (non-TTY
 * contexts, e.g. tests): conservative so no sane terminal wraps.
 */
const PANEL_LINE_CAP_FALLBACK = 200

/**
 * Terminal columns a panel body row's CONTENT may occupy so the whole
 * bordered row renders on exactly one physical line: the body Text wraps at
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
 * padded with spaces to the full box width. No trailing RESET — the panel bg
 * function terminates the row and paints the whole width.
 */
function borderedRow(boxWidth: number, borderFg: string, inner: string): string {
  const pad = Math.max(0, boxWidth - 4 - visibleWidth(inner))
  return `${borderFg}│ ${inner}${' '.repeat(pad)}${borderFg} │`
}

/** Top border line (`┌─…─┐`), `boxWidth` columns wide, in `borderFg`. */
function panelTopBorder(boxWidth: number, borderFg: string): string {
  return `${borderFg}┌${'─'.repeat(Math.max(0, boxWidth - 2))}┐`
}

/** Bottom border line (`└─…─┘`), `boxWidth` columns wide, in `borderFg`. */
function panelBottomBorder(boxWidth: number, borderFg: string): string {
  return `${borderFg}└${'─'.repeat(Math.max(0, boxWidth - 2))}┘`
}

/**
 * Clip an unstyled line to one physical panel row. Must run BEFORE styling:
 * clipToWidth counts per grapheme, so the ASCII fragments of an SGR code
 * would count as visible columns (verified against pi-tui 0.84.2) — clipping
 * plain text first, then applying ANSI, keeps the accounting exact.
 * `indent` is the leading content indent the row carries (2 for tool rows).
 * Carriage returns are stripped first: pi-tui's wrapTextWithAnsi splits on
 * `/\r\n|\r|\n/`, so a bare \r (progress bars, CRLF tool output) would break
 * the fixed panel rows just like a wrap would — the panel line is one row,
 * not a line record.
 */
export function clipPanelLine(text: string, indent = 0): string {
  return clipToWidth(text.replace(/\r/g, ''), panelLineCap(process.stdout.columns, indent))
}

interface StreamingState {
  turn: number
  step: number
  textComponent?: Text
  text: string
  /** Fixed 6-row thinking panel; setBody() is the only per-chunk update. */
  reasoningPanel?: ThinkingPanel
  reasoning: string
}

interface ToolCard {
  header: Text
  body: Text
  name: string
  /** Styled detail lines captured at creation, rebuilt into the body on settle. */
  detailLines: string[]
}

/**
 * One applied transcript operation, buffered for the theme-switch rebuild.
 * Events cover the session flow; prompt/command echoes and notices are direct
 * renders (no matching session event) and are buffered alongside so a rebuild
 * reproduces the transcript exactly as it stood.
 */
type ReplayOp =
  | { kind: 'event'; event: SessionEvent }
  | { kind: 'promptEcho'; text: string }
  | { kind: 'commandEcho'; line: string; error?: string; text?: string }
  | { kind: 'notice'; text: string; level: 'error' | 'info' }

/** A fixed PANEL_HEIGHT-row panel: header Text + body Text stacked in a Container. */
interface ThinkingPanel {
  readonly container: Container
  /** Replace the body rows in place — O(1), no rebuild. */
  setBody(text: string): void
}

/**
 * Compose the bordered body Text content (PANEL_BODY_LINES boxed rows plus
 * the bottom border) from already-styled, already-clipped lines: keep the
 * tail (newest rows win), pad short content with empty boxed rows. Every
 * row is one `boxWidth`-wide boxed line (`│ ` … ` │`, see borderedRow);
 * `borderFg` is the panelBorder SGR prefix (no trailing RESET — the panel
 * bg function terminates the row). Pad rows carry the box characters, so
 * they survive Text's `text.trim() === ''` fast path, which would otherwise
 * drop a body of only empty rows; the border SGR does not touch the
 * background, so the panel bg function still paints the full row width.
 * Callers clip each line with `clipPanelLine` BEFORE styling — otherwise a
 * styled line that outgrows `width - paddingX*2` wraps and the panel
 * exceeds its fixed 6 rows.
 */
export function panelBodyText(lines: readonly string[], boxWidth: number, borderFg: string): string {
  const visible = lines.length > PANEL_BODY_LINES ? lines.slice(-PANEL_BODY_LINES) : [...lines]
  while (visible.length < PANEL_BODY_LINES) visible.push('')
  return [...visible.map(line => borderedRow(boxWidth, borderFg, line)), panelBottomBorder(boxWidth, borderFg)].join('\n')
}

/** First text content of a tool result, raw lines. */
function resultTextLines(content: readonly { type: string; text?: string }[]): string[] {
  for (const block of content) {
    if (block.type === 'text' && block.text !== undefined) {
      return block.text.replace(/\s+$/u, '').split('\n')
    }
  }
  return []
}

/** One-line summary of the call arguments, per common tool shape. */
function callDetail(rawArguments: string, limit = 120): string {
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

export class TranscriptRenderer {
  private readonly doc: Container
  private theme: TuiTheme
  private readonly requestRender: () => void
  private streaming: StreamingState | undefined
  private readonly toolCards = new Map<string, ToolCard>()
  private todoContainer: Container | undefined
  /** Text of the prompt echoed locally on submit; the matching session event is deduped. */
  private lastEcho: string | undefined
  /**
   * Append-only buffer of every applied operation (O(1) per event). The
   * render path never scans it; `setTheme` — an explicit user action — is
   * the only reader, replaying it once against the new theme.
   */
  private readonly replay: ReplayOp[] = []

  constructor(
    doc: Container,
    theme: TuiTheme,
    requestRender: () => void,
  ) {
    this.doc = doc
    this.theme = theme
    this.requestRender = requestRender
  }

  applyEvent(event: SessionEvent): void {
    this.replay.push({ kind: 'event', event })
    switch (event.type) {
      case 'user/message':
        this.dropStreaming()
        this.renderUserMessage(event)
        break
      case 'assistant/chunk':
        this.applyChunk(event.data.turn, event.data.step, event.data.chunk)
        break
      case 'assistant/message':
        this.finalizeStreaming()
        this.renderAssistantMessage(event)
        break
      case 'tool/call':
        this.addToolCard(event.data.callId, event.data.name, event.data.arguments)
        break
      case 'tool/result':
        this.settleToolCard(event)
        break
      case 'todo/write':
        this.renderTodos(event.data.todos)
        break
      case 'turn/end':
        this.renderTurnEnd(event.data.reason)
        break
      case 'command/run':
      case 'command/done':
        // Command flow nodes: rendered once the slash-command phase lands.
        break
      default:
        break
    }
  }

  /** Render a submitted prompt immediately, before the session echoes it back. */
  renderPromptEcho(text: string): void {
    // Buffer the raw text: the echo bubble renders it verbatim, while the
    // session-echo dedup key is the trimmed form (lastEcho in renderUserText).
    this.replay.push({ kind: 'promptEcho', text })
    this.lastEcho = text.trim()
    this.renderUserText(text)
  }

  /** Render one executed slash command line with its outcome. */
  renderCommandEcho(line: string, error?: string, text?: string): void {
    this.replay.push({ kind: 'commandEcho', line, error, text })
    this.appendLine(ansiFg(this.theme.palette.accent) + `⌘ ${line}` + RESET)
    if (error !== undefined) {
      this.appendLine(ansiFg(this.theme.palette.danger) + `✘ ${error}` + RESET)
    } else if (text !== undefined && text.trim() !== '') {
      this.appendLine(ansiFg(this.theme.palette.fgMuted) + text + RESET)
    }
  }

  /**
   * Append a transcript line that has no matching session event (a
   * transient status notice or the sole on-screen record of an error).
   * Buffered as a replay op like echoes, so a theme-switch rebuild keeps it.
   * `error` lines get the ✘ danger treatment; `info` lines the attention
   * color (the Ctrl+C cancel hint) without a prefix.
   */
  renderNotice(text: string, level: 'error' | 'info' = 'error'): void {
    this.replay.push({ kind: 'notice', text, level })
    if (level === 'error') {
      this.appendLine(ansiFg(this.theme.palette.danger) + `✘ ${text}` + RESET)
    } else {
      this.appendLine(ansiFg(this.theme.palette.attention) + text + RESET)
    }
  }

  /**
   * Repaint the whole transcript against a new theme: clear the doc and
   * replay the buffered operations. Per-op requestRenders coalesce into a
   * single pi-tui frame (requestRender is nextTick-throttled), so the switch
   * repaints once, with no intermediate flicker. An in-flight stream keeps
   * its accumulated text — the replay rebuilds its Text and later chunks
   * continue setText on it. No-op when the theme bundle is unchanged
   * (themes are module singletons; the settings watcher may echo our own
   * write).
   */
  setTheme(theme: TuiTheme): void {
    if (theme === this.theme) return
    this.theme = theme
    const ops = [...this.replay]
    this.clear()
    for (const op of ops) this.applyOp(op)
    this.requestRender()
  }

  /**
   * Repaint the whole transcript at the current terminal width — the resize
   * counterpart of `setTheme`. On stdout `resize` pi-tui re-renders every
   * component with the new columns, but bordered panel rows were padded to
   * the OLD box width, so a narrowing terminal wraps every row and shatters
   * the fixed 6-row panels. Clear and re-apply the buffered operations
   * exactly like a theme switch: an in-flight stream keeps its accumulated
   * text (the replay rebuilds its Text and later chunks continue setText on
   * it), tool cards keep their settle state, todos reappear. No-op when
   * nothing was rendered — the startup placeholder stays untouched.
   */
  relayout(): void {
    if (this.replay.length === 0) return
    const ops = [...this.replay]
    this.clear()
    for (const op of ops) this.applyOp(op)
    this.requestRender()
  }

  /** Drop everything rendered so far (`/new`). The next prompt opens a fresh agent. */
  clear(): void {
    this.streaming = undefined
    this.toolCards.clear()
    this.todoContainer = undefined
    this.lastEcho = undefined
    this.replay.length = 0
    this.doc.clear()
  }

  /** Re-apply one buffered operation against the current theme. */
  private applyOp(op: ReplayOp): void {
    switch (op.kind) {
      case 'event':
        this.applyEvent(op.event)
        break
      case 'promptEcho':
        this.renderPromptEcho(op.text)
        break
      case 'commandEcho':
        this.renderCommandEcho(op.line, op.error, op.text)
        break
      case 'notice':
        this.renderNotice(op.text, op.level)
        break
    }
  }

  // ------------------------------------------------------------------ user --

  private renderUserMessage(event: SessionEvent & { type: 'user/message' }): void {
    const message = event.data
    const textParts = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
    const text = textParts.join('\n').trim()
    if (text === '') return
    const kind = message.source.kind
    if (kind === 'user') {
      // Dedup the session echo of a prompt we already rendered locally on submit.
      if (this.lastEcho === text) {
        this.lastEcho = undefined
        return
      }
      this.lastEcho = undefined
      this.renderUserText(text)
    } else {
      // Injected context (agent.inject): file-change notices, skill content, …
      const first = text.split('\n')[0] ?? ''
      const preview = clipToWidth(first, 120)
      this.appendLine(ansiFg(this.theme.palette.fgSubtle) + `ⓘ ${preview}` + RESET)
    }
  }

  private renderUserText(text: string): void {
    const prefixed = text.split('\n').map(line => `▎ ${line}`).join('\n')
    const bubble = new Text(prefixed, 1, 0, this.theme.chat.userMessageBg)
    this.doc.addChild(bubble)
    this.doc.addChild(new Spacer(1))
    this.requestRender()
  }

  // ------------------------------------------------------------- streaming --

  private applyChunk(turn: number, step: number, chunk: { type: string; text?: string }): void {
    if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return
    const delta = chunk.text ?? ''
    if (delta === '') return

    if (this.streaming === undefined || this.streaming.turn !== turn || this.streaming.step !== step) {
      this.finalizeStreaming()
      this.streaming = { turn, step, text: '', reasoning: '' }
    }
    const state = this.streaming

    if (chunk.type === 'text-delta') {
      if (state.textComponent === undefined) {
        state.textComponent = new Text('', 1, 0)
        this.doc.addChild(state.textComponent)
      }
      state.text += delta
      state.textComponent.setText(ansiFg(this.theme.palette.fgDefault) + state.text + RESET)
    } else {
      if (state.reasoningPanel === undefined) {
        state.reasoningPanel = this.createThinkingPanel()
        this.doc.addChild(state.reasoningPanel.container)
      }
      state.reasoning += delta
      // Live tail: replace only the body text of the existing panel — O(1),
      // never rebuild the block.
      state.reasoningPanel.setBody(this.thinkingBody(state.reasoning))
    }
    this.requestRender()
  }

  private finalizeStreaming(): void {
    const state = this.streaming
    if (state === undefined) return
    this.streaming = undefined
    if (state.textComponent !== undefined) this.doc.removeChild(state.textComponent)
    if (state.reasoningPanel !== undefined) this.doc.removeChild(state.reasoningPanel.container)
  }

  /** Keep streaming components as-is but detach state (user message arrived). */
  private dropStreaming(): void {
    this.streaming = undefined
  }

  // --------------------------------------------------------------- panels --

  /** Full box width and panelBorder SGR prefix for one panel, per current theme. */
  private panelBox(): { boxWidth: number; borderFg: string } {
    return {
      boxWidth: panelBoxWidth(process.stdout.columns),
      borderFg: ansiFg(this.theme.palette.panelBorder),
    }
  }

  /** Top border line plus bordered header row — the header Text's two lines. */
  private panelTop(boxWidth: number, borderFg: string, headerInner: string): string {
    return `${panelTopBorder(boxWidth, borderFg)}\n${borderedRow(boxWidth, borderFg, headerInner)}`
  }

  /**
   * Thinking color style, italic-on. The style terminates with a targeted
   * italic-off (`\x1b[23m`) — NOT a full RESET: the panel bg function paints
   * the whole row width, and a `\x1b[0m` here would clear the background and
   * leave the row's right side unpainted. Without the italic-off the leak is
   * visible in the box chrome: wrapTextWithAnsi carries ANSI state across
   * lines within one Text, so the row's right border, the following body
   * rows and the bottom border would all render italic.
   */
  private thinkStyle(text: string): string {
    return `\x1b[3m${ansiFg(this.theme.palette.thinking)}${text}\x1b[23m`
  }

  /** Styled, boxed PANEL_BODY_LINES tail of a reasoning text (bottom border included). */
  private thinkingBody(reasoning: string): string {
    const { boxWidth, borderFg } = this.panelBox()
    // Tail slice before styling: lines dropped by the panel are never styled
    // (or clipped). Clip BEFORE styling — see clipPanelLine's contract.
    const tail = reasoning.trim().split('\n').slice(-PANEL_BODY_LINES)
    return panelBodyText(tail.map(line => this.thinkStyle(clipPanelLine(line))), boxWidth, borderFg)
  }

  /**
   * Build the fixed 6-row thinking panel: top border + header row + 3-row
   * body + bottom border, all on the thinking panel background.
   * Header icon: '⟡' (U+27E1) renders as a tofu box on the user's terminal;
   * emoji render fine there (footer ⚙✔✘⏹ all verified), so '💭' is used.
   * The fixed header text is clipped at the plain-text stage like every
   * other panel line — below 17 terminal columns it would otherwise outgrow
   * the header row's budget and wrap, breaking the 6-row shape.
   */
  private createThinkingPanel(): ThinkingPanel {
    const { boxWidth, borderFg } = this.panelBox()
    const header = new Text(
      this.panelTop(boxWidth, borderFg, this.thinkStyle(clipPanelLine(THINKING_HEADER))),
      1, 0,
      this.theme.chat.thinkingPanelBg,
    )
    const body = new Text('', 1, 0, this.theme.chat.thinkingPanelBg)
    const container = new Container()
    container.addChild(header)
    container.addChild(body)
    return {
      container,
      setBody: (text: string) => { body.setText(text) },
    }
  }

  // ------------------------------------------------------------- assistant --

  private renderAssistantMessage(event: SessionEvent & { type: 'assistant/message' }): void {
    const message = event.data.message
    let rendered = false
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim() !== '') {
        const md = new Markdown(block.text, 1, 0, this.theme.markdown, {
          color: text => ansiFg(this.theme.palette.fgDefault) + text + RESET,
        })
        this.doc.addChild(md)
        rendered = true
      } else if (block.type === 'reasoning' && block.text.trim() !== '') {
        // Final thinking: full reasoning through the same fixed 6-row panel
        // (the body shows the 3-row tail, padded rows keep the panel shape).
        const panel = this.createThinkingPanel()
        panel.setBody(this.thinkingBody(block.text))
        this.doc.addChild(panel.container)
        rendered = true
      }
      // tool-call blocks render through tool/call events — never duplicated here.
    }
    if (rendered) this.doc.addChild(new Spacer(1))
    this.requestRender()
  }

  // ----------------------------------------------------------------- tools --

  /** Styled tool header content (icon + name, no box chrome, no trailing RESET). */
  private toolHeader(status: 'pending' | 'success' | 'error', name: string): string {
    const icon = status === 'pending' ? '⚙' : status === 'success' ? '✔' : '✘'
    const color = status === 'pending'
      ? this.theme.palette.fgMuted
      : status === 'success'
        ? this.theme.palette.success
        : this.theme.palette.danger
    // Clip the model-controlled name at the plain-text stage before styling
    // (indent 2 = the icon + space): an unbounded name would outgrow the
    // header row's budget and wrap, breaking the fixed 6-row panel.
    const clipped = clipPanelLine(name, 2)
    // No trailing RESET: the card bg function terminates the row so the
    // background covers the full header width.
    return ansiFg(color) + `${icon} ${clipped}`
  }

  private addToolCard(callId: string, name: string, rawArguments: string): void {
    const { boxWidth, borderFg } = this.panelBox()
    const header = new Text(this.panelTop(boxWidth, borderFg, this.toolHeader('pending', name)), 1, 0, this.theme.chat.toolPendingBg)
    const body = new Text('', 1, 0, this.theme.chat.toolBodyBg)
    const container = new Container()
    container.addChild(header)
    container.addChild(body)
    const detail = callDetail(rawArguments)
    // callDetail already clipped to 120; clip again to the panel cap so the
    // row never wraps on a narrow terminal.
    const detailLines = detail === '' ? [] : [ansiFg(this.theme.palette.fgMuted) + `  ${clipPanelLine(detail, 2)}`]
    body.setText(panelBodyText(detailLines, boxWidth, borderFg))
    this.doc.addChild(container)
    this.toolCards.set(callId, { header, body, name, detailLines })
    this.requestRender()
  }

  private settleToolCard(event: SessionEvent & { type: 'tool/result' }): void {
    const block = event.data.message.content[0]
    const callId = block?.toolCallId ?? ''
    const card = this.toolCards.get(callId)
    if (card === undefined) return
    this.toolCards.delete(callId)

    const { boxWidth, borderFg } = this.panelBox()
    const isError = event.data.error !== undefined || (block?.isError ?? false)
    // Rebuild both header Text lines: the top border (unchanged chrome) and
    // the swapped-status header row; the status bg fn repaints the border
    // row too, so the whole box top takes the success/error tint.
    card.header.setText(this.panelTop(boxWidth, borderFg, this.toolHeader(isError ? 'error' : 'success', card.name)))
    card.header.setCustomBgFn(isError ? this.theme.chat.toolErrorBg : this.theme.chat.toolSuccessBg)

    const bodyLines: string[] = [...card.detailLines]
    if (event.data.error !== undefined) {
      bodyLines.push(ansiFg(this.theme.palette.danger)
        + `  ${clipPanelLine(`${event.data.error.name}: ${event.data.error.code}`, 2)}`)
    }
    if (block !== undefined) {
      for (const line of resultTextLines(block.content)) {
        bodyLines.push(ansiFg(this.theme.palette.fgMuted) + `  ${clipPanelLine(line, 2)}`)
      }
    }
    // Body keeps the 3-row tail; when lines are dropped, the first visible
    // row reports the count so the newest result lines stay on screen. The
    // marker is clipped at the plain-text stage (indent 2, like every tool
    // row): on a narrow terminal a 3-digit dropped count exceeds the row's
    // budget and would wrap, breaking the fixed 6-row panel.
    if (bodyLines.length > PANEL_BODY_LINES) {
      const dropped = bodyLines.length - PANEL_BODY_LINES
      bodyLines.splice(0, dropped)
      bodyLines[0] = ansiFg(this.theme.palette.fgSubtle) + clipPanelLine(`  … (+${dropped} lines)`, 2)
    }
    card.body.setText(panelBodyText(bodyLines, boxWidth, borderFg))
    this.requestRender()
  }

  // ----------------------------------------------------------------- todos --

  private renderTodos(todos: readonly { content: string; status: string }[]): void {
    if (this.todoContainer !== undefined) this.doc.removeChild(this.todoContainer)
    const container = new Container()
    for (const todo of todos) {
      const line = todo.status === 'completed'
        ? this.theme.chat.todoDone(todo.content)
        : todo.status === 'in_progress'
          ? ansiFg(this.theme.palette.attention) + `▶ ${todo.content}` + RESET
          : this.theme.chat.todoOpen(todo.content)
      container.addChild(new Text(line, 1, 0))
    }
    this.doc.addChild(container)
    this.todoContainer = container
    this.requestRender()
  }

  // -------------------------------------------------------------- turn end --

  private renderTurnEnd(reason: { kind: string; error?: { message: string } }): void {
    if (reason.kind === 'error') {
      this.appendLine(ansiFg(this.theme.palette.danger) + `✘ ${reason.error?.message ?? 'turn failed'}` + RESET)
    } else if (reason.kind === 'aborted') {
      this.appendLine(ansiFg(this.theme.palette.fgSubtle) + '⏹ interrupted' + RESET)
    } else if (reason.kind === 'max-tokens') {
      this.appendLine(ansiFg(this.theme.palette.attention) + '⚠ output token limit reached' + RESET)
    }
  }

  // --------------------------------------------------------------- helpers --

  private appendLine(line: string): void {
    this.doc.addChild(new Text(line, 1, 0))
    this.requestRender()
  }
}
