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
import { isImageBlock, renderImageAttachments, type ImageBlockLike } from './attachments.ts'
import { buildWelcomeBanner } from './welcome.ts'
import { formatStartupInfoLines, type StartupSummary } from './startup-info.ts'
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
  | {
    kind: 'promptEcho'
    text: string
    sessionEcho?: string
    marker?: string
    badge?: PendingBadge
    terminal?: PendingTerminal
    /** Delivered message identity of a pending (badged) echo. */
    messageId?: unknown
  }
  | { kind: 'commandEcho'; line: string; error?: string; text?: string }
  | { kind: 'notice'; text: string; level: 'error' | 'info' | 'warning' }

/**
 * Pending-route badge of a locally echoed prompt that was routed while the
 * agent ran (docs/design-steer-followup.md §三). Display-only vocabulary
 * (English-only per AGENTS.md): the badge prefixes the bubble until the
 * message is claimed by the agent's inbox, then the bubble returns to the
 * ordinary style IN PLACE. The badge never enters the persisted text.
 */
export type PendingBadge = 'queued' | 'steer'

/**
 * Terminal state of a pending routed echo (review B1): a badge must never be
 * a ghost. Revoking the message (`d` in the queue panel) cancels its echo;
 * a delivery that failed for good fails it; an abort prunes echoes whose
 * messages no longer exist anywhere. Both terminal styles are explicit and
 * durable (they survive theme rebuilds via the replay op).
 */
export type PendingTerminal = 'canceled' | 'failed'

/** Badge prefix rendered on the bubble's first line. */
export const PENDING_BADGE_LABELS: Record<PendingBadge, string> = {
  queued: '⏳ queued',
  steer: '↪ steer',
}

/** Prefix rendered on the first line of a terminal-state bubble. */
export const PENDING_TERMINAL_LABELS: Record<PendingTerminal, string> = {
  canceled: '✕ canceled',
  failed: '✘ not delivered',
}

/** SGR strikethrough — the faded "undone" look of a canceled echo. */
const STRIKE = '\x1b[9m'
const STRIKE_OFF = '\x1b[29m'

/** Everything needed to find one pending echo (id primary, text fallback). */
export interface PendingEchoMatch {
  /** The delivered message id (`message.id` of the routed prompt). */
  readonly id?: unknown
  /** The trimmed echo text — fallback when no id was recorded. */
  readonly text?: string
}

/** One pending local echo awaiting its claim event or a terminal state. */
interface PendingEcho {
  /** Dedupe key — the trimmed echo text the session will echo back. */
  key: string
  /** The delivered message identity, when known (primary lookup). */
  messageId?: unknown
  /** Original echo text (untrimmed) — re-rendered on resolve. */
  text: string
  /** The live bubble component, restyled in place on claim/resolve. */
  component: Text
  /** The buffered replay op — mutated in place so rebuilds reflect the state. */
  op: { kind: 'promptEcho'; text: string; sessionEcho?: string; marker?: string; badge?: PendingBadge; terminal?: PendingTerminal }
}

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
   * Pending routed echoes (badge bubbles) awaiting the claim `user/message`
   * event. Keyed lookup happens BEFORE the legacy `lastEcho` check so a
   * claimed message restyles its bubble in place instead of being skipped.
   */
  private readonly pendingEchoes: PendingEcho[] = []
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
  /**
   * The startup configuration summary (mcp/skills/plugins readout, see
   * startup-info.ts) rendered between the banner and the quote — a snapshot
   * of the TUI run, held for the whole life so every rebuild (theme switch,
   * resize relayout) re-renders the same lines at the current width.
   */
  private readonly startupInfo: StartupSummary | undefined

  constructor(
    doc: Container,
    theme: TuiTheme,
    requestRender: () => void,
    startupInfo?: StartupSummary,
  ) {
    this.doc = doc
    this.theme = theme
    this.requestRender = requestRender
    this.startupInfo = startupInfo
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

  /**
   * Render a routed prompt echo with its pending badge (`⏳ queued` /
   * `↪ steer`, design §三). The bubble registers as pending: when the agent's
   * inbox claims the message (a matching `user/message` event arrives), the
   * SAME component is restyled back to the ordinary bubble — no new line,
   * and the buffered replay op loses its badge so theme rebuilds reflect the
   * consumed state. `messageId` (the delivered message's id) makes every
   * later resolution — claim, revoke, failure, rebadge — exact even when the
   * echo text was folded or edited. The badge is display-only.
   */
  renderPendingEcho(text: string, badge: PendingBadge, messageId?: unknown): void {
    const op: ReplayOp = { kind: 'promptEcho', text, badge }
    if (messageId !== undefined) op.messageId = messageId
    this.replay.push(op)
    const component = new Text(
      this.theme.chat.userMessageText(this.bubbleBody(text, badge)),
      1,
      0,
      this.theme.chat.userMessageBg,
    )
    this.doc.addChild(component)
    this.doc.addChild(new Spacer(1))
    this.pendingEchoes.push({
      key: text.trim(),
      text,
      ...(messageId !== undefined ? { messageId } : {}),
      component,
      op,
    })
    this.requestRender()
  }

  /**
   * Flip a pending echo's route badge in place (review S3): a steer that
   * degraded to a queued follow-up must not keep advertising `↪ steer` —
   * the bubble and its replay op both become `⏳ queued`, so a later claim
   * still consumes them normally. No-op (returns false) without a match.
   */
  rebadgePendingEcho(match: PendingEchoMatch, badge: PendingBadge): boolean {
    const entry = this.findPendingEcho(match)
    if (entry === undefined) return false
    entry.op.badge = badge
    entry.op.terminal = undefined
    entry.component.setText(this.theme.chat.userMessageText(this.bubbleBody(entry.text, badge)))
    this.requestRender()
    return true
  }

  /**
   * Retire a pending echo with an explicit terminal style (review B1):
   * `'canceled'` after a user revoke (`d`), `'failed'` after a delivery that
   * can no longer succeed. The SAME bubble restyles in place — faded struck-
   * through for canceled, danger for failed — never a lingering ⏳/↪ ghost,
   * and the replay op records the terminal state so theme rebuilds agree.
   * @returns true when a pending echo was resolved.
   */
  resolvePendingEcho(match: PendingEchoMatch, terminal: PendingTerminal): boolean {
    const index = this.pendingEchoes.findIndex(entry => this.matchesPending(entry, match))
    if (index < 0) return false
    const [entry] = this.pendingEchoes.splice(index, 1)
    entry!.op.badge = undefined
    entry!.op.terminal = terminal
    entry!.component.setText(this.terminalBubbleBody(entry!.text, terminal))
    this.requestRender()
    return true
  }

  /**
   * Resolve EVERY pending echo that is no longer alive (review B1, abort
   * path): after a turn aborted/failed, badges whose messages vanished from
   * the inbox become explicit canceled bubbles instead of ghosts; entries
   * still queued stay pending. Entries without any known identity are
   * treated as dead (they could never be claimed exactly).
   * @returns the number of echoes resolved as canceled.
   */
  prunePendingEchoes(isAlive: (messageId: unknown, key: string) => boolean): number {
    let pruned = 0
    for (let i = this.pendingEchoes.length - 1; i >= 0; i--) {
      const entry = this.pendingEchoes[i]!
      if (entry.messageId !== undefined && isAlive(entry.messageId, entry.key)) continue
      this.pendingEchoes.splice(i, 1)
      entry.op.badge = undefined
      entry.op.terminal = 'canceled'
      entry.component.setText(this.terminalBubbleBody(entry.text, 'canceled'))
      pruned++
    }
    if (pruned > 0) this.requestRender()
    return pruned
  }

  /** Locate one pending echo: id equality first, trimmed-text fallback. */
  private findPendingEcho(match: PendingEchoMatch): PendingEcho | undefined {
    const index = this.pendingEchoes.findIndex(entry => this.matchesPending(entry, match))
    return index < 0 ? undefined : this.pendingEchoes[index]
  }

  private matchesPending(entry: PendingEcho, match: PendingEchoMatch): boolean {
    if (match.id !== undefined && entry.messageId !== undefined) {
      return String(entry.messageId) === String(match.id)
    }
    return match.text !== undefined && entry.key === match.text.trim()
  }

  /**
   * Consume the first pending echo whose identity matches a claimed message:
   * restyle its bubble to the ordinary style in place and retire the entry.
   * @returns true when a pending echo was consumed (caller skips rendering).
   */
  private consumePendingEcho(key: string, messageId?: unknown): boolean {
    const match: PendingEchoMatch = { text: key, ...(messageId !== undefined ? { id: messageId } : {}) }
    const index = this.pendingEchoes.findIndex(entry => this.matchesPending(entry, match))
    if (index < 0) return false
    const entry = this.pendingEchoes.splice(index, 1)[0]!
    entry.op.badge = undefined
    entry.component.setText(this.theme.chat.userMessageText(this.bubbleBody(entry.text)))
    this.requestRender()
    return true
  }

  /** Bubble body for an echo text, with the optional badge on the first line. */
  private bubbleBody(text: string, badge?: PendingBadge): string {
    const body = badge === undefined ? text : `${PENDING_BADGE_LABELS[badge]} · ${text}`
    return body.split('\n').map(line => `▎ ${line}`).join('\n')
  }

  /**
   * Bubble body of a terminal-state echo: the label rides the first line so
   * multi-line drafts stay fully visible under it.
   */
  private terminalBubbleBody(text: string, terminal: PendingTerminal): string {
    const lines = text.split('\n')
    const head = `▎ ${PENDING_TERMINAL_LABELS[terminal]} · ${lines[0] ?? ''}`
    const rest = lines.slice(1).map(line => `▎ ${line}`)
    return [head, ...rest].join('\n')
  }

  /** Style + append a terminal-state bubble (faded strike vs danger). */
  private renderTerminalEcho(text: string, terminal: PendingTerminal): void {
    // Mirror the badge path's own push: the mutated replay op re-registers a
    // plain terminal op so repeated rebuilds stay 1:1 (never duplicate).
    this.replay.push({ kind: 'promptEcho', text, terminal })
    const body = this.terminalBubbleBody(text, terminal)
    const styled = terminal === 'canceled'
      ? STRIKE + ansiFg(this.theme.palette.fgSubtle) + body + STRIKE_OFF + RESET
      : ansiFg(this.theme.palette.danger) + body + RESET
    this.doc.addChild(new Text(styled, 1, 0))
    this.doc.addChild(new Spacer(1))
    this.requestRender()
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
   * `error` lines get the ✘ danger treatment; `warning` lines the ⚠
   * attention treatment (degraded but not fatal, e.g. a stale queue panel);
   * `info` lines the attention color (the Ctrl+C cancel hint) without a
   * prefix.
   */
  renderNotice(text: string, level: 'error' | 'info' | 'warning' = 'error'): void {
    this.replay.push({ kind: 'notice', text, level })
    if (level === 'error') {
      this.appendLine(ansiFg(this.theme.palette.danger) + `✘ ${text}` + RESET)
    } else if (level === 'warning') {
      this.appendLine(ansiFg(this.theme.palette.attention) + `⚠ ${text}` + RESET)
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
    this.pendingEchoes.length = 0
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
        // Mirror each render path's own push so repeated rebuilds stay 1:1:
        // a pending echo re-registers its entry (fresh Text component) so a
        // later claim/resolve still restyles it; a terminal echo renders its
        // explicit end state without re-registering.
        if (op.badge !== undefined) this.renderPendingEcho(op.text, op.badge, op.messageId)
        else if (op.terminal !== undefined) this.renderTerminalEcho(op.text, op.terminal)
        else this.renderPromptEcho(op.text, op.sessionEcho, op.marker)
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
   * with the configuration summary and the daily quote caption beneath it,
   * as the doc's first content: a leading spacer, the banner Text, a
   * spacer, the summary lines, a spacer, the quote Text, then the trailing
   * spacer that matches the message-block rhythm. The leading spacer keeps
   * the banner from pressing against the top of the transcript (the startup
   * placeholder line it replaces sat flush at row 0). The whale and the
   * letters keep their brand blue across themes — the banner is
   * theme-independent (gaps stay transparent over the terminal default
   * background — see welcome.ts); the summary and the quote are the
   * theme-tinted lines (fgSubtle, rebuilt with the live theme by the
   * replay). The banner and the summary are built at the current terminal
   * width: below 96 columns the banner degrades to the whale alone, every
   * line clips instead of wrapping, and every rebuild (relayout/setTheme
   * replay) reads the width afresh. The quote line — whale-prefixed
   * (`🐳 「…」`, the same 🐳 icon that speaks inline for the assistant in
   * chat) — is clipped to the terminal width before styling (the repo rule
   * — ANSI never goes through the clipper), so it never wraps.
   */
  private renderWelcome(): void {
    this.doc.addChild(new Spacer(1))
    this.doc.addChild(new Text(buildWelcomeBanner(process.stdout.columns), 1, 0))
    this.doc.addChild(new Spacer(1))
    // The config summary (mcp/skills/plugins) when the startup snapshot
    // resolved: same fgSubtle treatment and width budget as the quote below
    // — plain text clipped BEFORE styling (formatStartupInfoLines clips).
    if (this.startupInfo !== undefined) {
      for (const line of formatStartupInfoLines(this.startupInfo, process.stdout.columns)) {
        this.doc.addChild(new Text(ansiFg(this.theme.palette.fgSubtle) + line + RESET, 1, 0))
      }
      this.doc.addChild(new Spacer(1))
    }
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
    // Structural image-block pick: dsh's branded AttachmentId defeats the
    // S-extends-ContentBlock narrowing, so filter over the erased view.
    const imageBlocks = (message.content as readonly unknown[]).filter(isImageBlock)
    const textParts = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
    const text = textParts.join('\n').trim()
    const kind = message.source.kind
    if (kind === 'user') {
      // A claimed pending echo restyles its badge bubble in place instead of
      // rendering (design §三: claimed → back to the ordinary bubble). The
      // event's message id is the primary key — the trimmed text only backs
      // it up for echoes registered before ids were threaded through.
      const claimedId = (message as { id?: unknown }).id
      const claimed = text === '' ? false : this.consumePendingEcho(text, claimedId)
      // Dedup the session echo of a prompt we already rendered locally on submit.
      const deduped = text !== '' && this.lastEcho === text
      if (deduped) this.lastEcho = undefined
      // The local echo never carries attachments (the TUI has no attach UI),
      // so claimed/deduped messages still render their image blocks here —
      // they arrived from another surface (web / feishu) together with the
      // prompt text already on screen.
      if (claimed || deduped) {
        this.renderImages(imageBlocks)
        return
      }
      this.lastEcho = undefined
      if (text !== '') this.renderUserText(text)
      this.renderImages(imageBlocks)
    } else {
      if (text === '' && imageBlocks.length === 0) return
      // Injected context (agent.inject): file-change notices, skill content, …
      const first = text.split('\n')[0] ?? ''
      const preview = clipToWidth(first, 120)
      this.appendLine(ansiFg(this.theme.palette.fgSubtle) + `ⓘ ${preview}` + RESET)
    }
  }

  /** Render a message's image-attachment slots (placeholder → bitmap / note). */
  private renderImages(blocks: readonly ImageBlockLike[]): void {
    if (blocks.length === 0) return
    renderImageAttachments(this.doc, blocks, this.theme, { requestRender: () => this.requestRender() })
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
