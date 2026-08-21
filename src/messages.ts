/**
 * Transcript rendering: turns dsh session events into pi-tui components.
 *
 * Incremental by design (pi-turbo lesson): every event does O(event) work —
 * streaming deltas update one Text in place, and nothing ever re-scans the
 * session log.
 *
 * Streaming strategy: during `assistant/chunk` the raw text grows in a plain
 * Text component; on the assembled `assistant/message` the streaming component
 * is replaced by proper Markdown rendering. This keeps per-token cost at
 * O(accumulated text) instead of re-parsing markdown on every delta.
 *
 * Chat-clean transcript: think blocks and tool calls do NOT render here —
 * they live in the fixed ThinkPanel/ToolPanel above the chat input
 * (src/activity.ts, mounted by live-widgets.ts). The transcript carries the
 * conversation only: user bubbles, streamed/final assistant text, turn-end
 * notices, echoes. Todos likewise render in the live widget.
 *
 * Theme hot-switch: every applied operation is appended to `replay` (O(1)
 * per event — never a render-path scan). `setTheme` is an explicit user
 * action, so it may do a one-off full rebuild: clear the doc and re-apply
 * the buffered operations against the new theme. Streaming rebuilds exactly
 * as it was applied, so an in-flight stream simply continues `setText` on
 * its rebuilt component. (The live widgets live outside the transcript —
 * see live-widgets.ts.)
 *
 * Welcome banner: the first replay op, pushed at construction (the doc is
 * cleared first, replacing tui.ts's startup placeholder). It stays at the
 * top of the doc — the event flow appends below it, and every rebuild
 * (relayout/setTheme) reproduces it first with the current theme.
 */

import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Loads the SessionEventMap augmentation that adds command/run + command/done.
import type {} from '@deepseek-ai/dsh-commands'
import { ansiFg, RESET, type TuiTheme } from './theme/index.ts'
import { stopIcon } from './icons.ts'
import { clipToWidth } from './text.ts'
import { buildWelcomeBanner } from './welcome.ts'
import { formatDailyQuote, pickDailyQuote } from './quotes.ts'

interface StreamingState {
  turn: number
  step: number
  textComponent?: Text
  text: string
}

/**
 * One applied transcript operation, buffered for the theme-switch rebuild.
 * Events cover the session flow; prompt/command echoes and notices are direct
 * renders (no matching session event) and are buffered alongside so a rebuild
 * reproduces the transcript exactly as it stood. The welcome banner is the
 * first op, pushed at construction, so every rebuild starts with it and the
 * event flow always appends below it.
 */
type ReplayOp =
  | { kind: 'welcome' }
  | { kind: 'event'; event: SessionEvent }
  | { kind: 'promptEcho'; text: string; sessionEcho?: string; marker?: string }
  | { kind: 'commandEcho'; line: string; error?: string; text?: string }
  | { kind: 'notice'; text: string; level: 'error' | 'info' }

export class TranscriptRenderer {
  private readonly doc: Container
  private theme: TuiTheme
  private readonly requestRender: () => void
  private streaming: StreamingState | undefined
  /**
   * Text of the prompt echoed locally on submit; the matching session event is deduped.
   */
  private lastEcho: string | undefined
  /**
   * Append-only buffer of every applied operation (O(1) per event). The
   * render path never scans it; `setTheme` — an explicit user action — is
   * the only reader, replaying it once against the new theme.
   */
  private readonly replay: ReplayOp[] = []
  /**
   * The session's daily quote — rolled once here, so every rebuild
   * (relayout/setTheme replay) re-renders the same line and only a fresh
   * session rolls a new one (see quotes.ts).
   */
  private readonly dailyQuote: string = pickDailyQuote()

  constructor(
    doc: Container,
    theme: TuiTheme,
    requestRender: () => void,
  ) {
    this.doc = doc
    this.theme = theme
    this.requestRender = requestRender
    // The welcome banner is the first operation: render it now (replacing the
    // startup placeholder line startTui added — the banner is the new startup
    // screen) and buffer it as the first replay op, so relayout/setTheme
    // rebuild it at the top of the doc while events keep appending after it.
    this.replay.push({ kind: 'welcome' })
    this.doc.clear()
    this.renderWelcome()
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
      case 'tool/result':
        // Tool activity renders in the fixed ToolPanel above the chat input
        // (live-widgets.ts routes these); the transcript never grows blocks.
        break
      case 'todo/write':
        // Todos render in the fixed live widget (LiveWidgets), not the
        // transcript; index.ts routes the event there.
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

  /**
   * Render a submitted prompt immediately, before the session echoes it back.
   * `sessionEcho` overrides the dedup key when the session will echo a
   * different string than the rendered text (e.g. a translated gesture whose
   * own echo would otherwise show twice).
   * `marker` appends a light `ⓘ …` caption under the echo; an absent marker
   * renders nothing.
   */
  renderPromptEcho(text: string, sessionEcho?: string, marker?: string): void {
    // Buffer the raw text: the echo bubble renders it verbatim, while the
    // session-echo dedup key is the trimmed form (lastEcho in renderUserText).
    this.replay.push({ kind: 'promptEcho', text, sessionEcho, marker })
    this.lastEcho = (sessionEcho ?? text).trim()
    this.renderUserText(text)
    if (marker !== undefined) {
      this.appendLine(ansiFg(this.theme.palette.fgSubtle) + `ⓘ ${marker}` + RESET)
    }
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
   * component with the new columns, but the welcome banner degrades by
   * width, so clear and re-apply the buffered operations exactly like a
   * theme switch: an in-flight stream keeps its accumulated text, todos
   * reappear. No-op when the replay is empty — that guards the doc emptied
   * by /new (clear()), which must stay empty until the next prompt: the
   * welcome banner is the startup screen of a TUI run and must not
   * resurrect here.
   */
  relayout(): void {
    if (this.replay.length === 0) return
    const ops = [...this.replay]
    this.clear()
    for (const op of ops) this.applyOp(op)
    this.requestRender()
  }

  /**
   * Drop everything rendered so far (`/new`). The next prompt opens a fresh
   * agent; the welcome banner goes with the rest — it is the startup screen
   * of a TUI run, not persistent transcript chrome.
   */
  clear(): void {
    this.streaming = undefined
    this.lastEcho = undefined
    this.replay.length = 0
    this.doc.clear()
  }

  /** Re-apply one buffered operation against the current theme. */
  private applyOp(op: ReplayOp): void {
    switch (op.kind) {
      case 'welcome':
        // Mirror applyEvent's self-push: relayout/setTheme replay would
        // otherwise consume the welcome op on the first rebuild and freeze
        // the banner at this width (it is width-dependent since the pixel
        // letters — a narrowing resize would degrade, a widening one never
        // restore, and later theme switches could not repaint it either).
        this.replay.push({ kind: 'welcome' })
        this.renderWelcome()
        break
      case 'event':
        this.applyEvent(op.event)
        break
      case 'promptEcho':
        this.renderPromptEcho(op.text, op.sessionEcho, op.marker)
        break
      case 'commandEcho':
        this.renderCommandEcho(op.line, op.error, op.text)
        break
      case 'notice':
        this.renderNotice(op.text, op.level)
        break
    }
  }

  // ---------------------------------------------------------------- banner --

  /**
   * The startup welcome banner (whale pixel art + pixel-letter wordmark)
   * with the daily quote caption beneath it, as the doc's first content:
   * a leading spacer, the banner Text, a spacer, the quote Text, then the
   * trailing spacer that matches the message-block rhythm. The leading
   * spacer keeps the banner from pressing against the top of the transcript
   * (the startup placeholder line it replaces sat flush at row 0). The
   * whale and the letters keep their brand blue across themes — the banner
   * is theme-independent (gaps stay transparent over the terminal default
   * background — see welcome.ts); the quote is the one theme-tinted line
   * (fgSubtle, rebuilt with the live theme by the replay). The banner is
   * built at the current terminal width: below 96 columns it degrades to
   * the whale alone, and every rebuild (relayout/setTheme replay) reads the
   * width afresh, so narrowing drops the wordmark and widening restores it.
   * The quote line — whale-prefixed (`🐳 「…」`, the same 🐳 icon that
   * speaks inline for the assistant in chat) — is clipped to the terminal
   * width before styling (the repo rule — ANSI never goes through the
   * clipper), so it never wraps.
   */
  private renderWelcome(): void {
    this.doc.addChild(new Spacer(1))
    this.doc.addChild(new Text(buildWelcomeBanner(process.stdout.columns), 1, 0))
    this.doc.addChild(new Spacer(1))
    // (columns ?? Infinity): non-TTY contexts (tests) get the full line.
    // 🐳 「…」: whale-prefix the caption (same icon that speaks inline in
    // chat) before clipping so the clip is width-safe over the full plain
    // text (🐳 is 2 visible columns, plus the one separating space).
    const quote = clipToWidth(`🐳 ${formatDailyQuote(this.dailyQuote)}`, (process.stdout.columns ?? Infinity) - 2)
    this.doc.addChild(new Text(ansiFg(this.theme.palette.fgSubtle) + quote + RESET, 1, 0))
    this.doc.addChild(new Spacer(1))
    this.requestRender()
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
    // userMessageText paints the text with the theme foreground (dark themes:
    // light text) — without it the bubble text falls to the terminal default
    // foreground, invisible on the dark canvas.
    const bubble = new Text(this.theme.chat.userMessageText(prefixed), 1, 0, this.theme.chat.userMessageBg)
    this.doc.addChild(bubble)
    this.doc.addChild(new Spacer(1))
    this.requestRender()
  }

  // ------------------------------------------------------------- streaming --

  private applyChunk(turn: number, step: number, chunk: { type: string; text?: string }): void {
    if (chunk.type !== 'text-delta') return
    const delta = chunk.text ?? ''
    if (delta === '') return

    if (this.streaming === undefined || this.streaming.turn !== turn || this.streaming.step !== step) {
      this.finalizeStreaming()
      this.streaming = { turn, step, text: '' }
    }
    const state = this.streaming

    if (state.textComponent === undefined) {
      state.textComponent = new Text('', 1, 0)
      this.doc.addChild(state.textComponent)
    }
    state.text += delta
    state.textComponent.setText(ansiFg(this.theme.palette.fgDefault) + state.text + RESET)
    this.requestRender()
  }

  private finalizeStreaming(): void {
    const state = this.streaming
    if (state === undefined) return
    this.streaming = undefined
    if (state.textComponent !== undefined) this.doc.removeChild(state.textComponent)
  }

  /** Keep streaming components as-is but detach state (user message arrived). */
  private dropStreaming(): void {
    this.streaming = undefined
  }

  // ------------------------------------------------------------- assistant --

  private renderAssistantMessage(event: SessionEvent & { type: 'assistant/message' }): void {
    const message = event.data.message
    let rendered = false
    // The whale speaks: the first text block is prefixed inline (`🐳: text`)
    // instead of taking its own avatar line — later text blocks render plain.
    // Reasoning blocks render nothing here: the fixed ThinkPanel already
    // showed the burst live (activity.ts).
    let whaleShown = false
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim() !== '') {
        // trimStart keeps the prefix on the same line as the reply when the
        // block opens with a newline.
        const text = whaleShown ? block.text : `🐳: ${block.text.trimStart()}`
        whaleShown = true
        const md = new Markdown(text, 1, 0, this.theme.markdown, {
          color: text => ansiFg(this.theme.palette.fgDefault) + text + RESET,
        })
        this.doc.addChild(md)
        rendered = true
      }
      // tool-call blocks render through the fixed ToolPanel — never here.
    }
    if (rendered) this.doc.addChild(new Spacer(1))
    this.requestRender()
  }

  // -------------------------------------------------------------- turn end --

  private renderTurnEnd(reason: { kind: string; error?: { message: string } }): void {
    if (reason.kind === 'error') {
      this.appendLine(ansiFg(this.theme.palette.danger) + `✘ ${reason.error?.message ?? 'turn failed'}` + RESET)
    } else if (reason.kind === 'aborted') {
      this.appendLine(ansiFg(this.theme.palette.fgSubtle) + `${stopIcon()} interrupted` + RESET)
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
