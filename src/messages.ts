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
 */

import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Loads the SessionEventMap augmentation that adds command/run + command/done.
import type {} from '@deepseek-ai/dsh-commands'
import { ansiFg, RESET, type TuiTheme } from './theme/index.ts'

interface StreamingState {
  turn: number
  step: number
  textComponent?: Text
  text: string
  reasoningComponent?: Text
  reasoning: string
}

interface ToolCard {
  header: Text
  name: string
}

/** First text content of a tool result, truncated to one preview line. */
function toolResultPreview(content: readonly { type: string; text?: string }[], limit = 160): string {
  for (const block of content) {
    if (block.type === 'text' && block.text !== undefined) {
      const flat = block.text.replace(/\s+/g, ' ').trim()
      return flat.length > limit ? flat.slice(0, limit) + '…' : flat
    }
  }
  return ''
}

/** Compact one-line preview of raw tool-call arguments JSON. */
function argsPreview(rawArguments: string, limit = 80): string {
  try {
    const parsed = JSON.parse(rawArguments) as Record<string, unknown>
    for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim() !== '') {
        const flat = value.replace(/\s+/g, ' ')
        return flat.length > limit ? flat.slice(0, limit) + '…' : flat
      }
    }
    const flat = rawArguments.replace(/\s+/g, ' ')
    return flat.length > limit ? flat.slice(0, limit) + '…' : flat
  } catch {
    return ''
  }
}

export class TranscriptRenderer {
  private readonly doc: Container
  private readonly theme: TuiTheme
  private readonly requestRender: () => void
  private streaming: StreamingState | undefined
  private readonly toolCards = new Map<string, ToolCard>()
  private todoContainer: Container | undefined
  /** Text of the prompt echoed locally on submit; the matching session event is deduped. */
  private lastEcho: string | undefined

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
    this.lastEcho = text.trim()
    this.renderUserText(text)
  }

  /** Render one executed slash command line with its outcome. */
  renderCommandEcho(line: string, error?: string, text?: string): void {
    this.appendLine(ansiFg(this.theme.palette.accent) + `⌘ ${line}` + RESET)
    if (error !== undefined) {
      this.appendLine(ansiFg(this.theme.palette.danger) + `✘ ${error}` + RESET)
    } else if (text !== undefined && text.trim() !== '') {
      this.appendLine(ansiFg(this.theme.palette.fgMuted) + text + RESET)
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
      const preview = first.length > 120 ? first.slice(0, 120) + '…' : first
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
      if (state.reasoningComponent === undefined) {
        state.reasoningComponent = new Text('', 1, 0)
        this.doc.addChild(state.reasoningComponent)
      }
      state.reasoning += delta
      const preview = state.reasoning.replace(/\s+/g, ' ')
      const line = preview.length > 200 ? preview.slice(0, 200) + '…' : preview
      state.reasoningComponent.setText(this.theme.chat.thinkingText(`⟡ ${line}`))
    }
    this.requestRender()
  }

  private finalizeStreaming(): void {
    const state = this.streaming
    if (state === undefined) return
    this.streaming = undefined
    if (state.textComponent !== undefined) this.doc.removeChild(state.textComponent)
    if (state.reasoningComponent !== undefined) this.doc.removeChild(state.reasoningComponent)
  }

  /** Keep streaming components as-is but detach state (user message arrived). */
  private dropStreaming(): void {
    this.streaming = undefined
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
        const chars = block.text.length
        this.appendLine(this.theme.chat.thinkingText(`⟡ thinking (${chars} chars)`))
        rendered = true
      }
      // tool-call blocks render through tool/call events — never duplicated here.
    }
    if (rendered) this.doc.addChild(new Spacer(1))
    this.requestRender()
  }

  // ----------------------------------------------------------------- tools --

  private addToolCard(callId: string, name: string, rawArguments: string): void {
    const preview = argsPreview(rawArguments)
    const header = new Text(
      ansiFg(this.theme.palette.fgMuted) + `⚙ ${name}` + RESET +
      (preview === '' ? '' : ansiFg(this.theme.palette.fgSubtle) + `  ${preview}` + RESET),
      1, 0,
    )
    this.doc.addChild(header)
    this.toolCards.set(callId, { header, name })
    this.requestRender()
  }

  private settleToolCard(event: SessionEvent & { type: 'tool/result' }): void {
    const card = this.toolCards.get(event.data.message.content[0]?.toolCallId ?? '')
    if (card === undefined) return
    this.toolCards.delete(event.data.message.content[0]!.toolCallId)

    const block = event.data.message.content[0]
    const isError = event.data.error !== undefined || (block?.isError ?? false)
    const preview = block === undefined ? '' : toolResultPreview(block.content)

    const icon = isError ? '✘' : '✔'
    const color = isError ? this.theme.palette.danger : this.theme.palette.success
    const suffix = isError && event.data.error !== undefined
      ? `  ${event.data.error.name}: ${event.data.error.code}`
      : preview === '' ? '' : `  ${preview}`
    card.header.setText(
      ansiFg(color) + `${icon} ${card.name}` + RESET +
      (suffix === '' ? '' : ansiFg(this.theme.palette.fgSubtle) + suffix + RESET),
    )
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
