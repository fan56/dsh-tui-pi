/**
 * /btw — by-the-way side questions (CONTEXT.md: Btw, Side call, Btw overlay,
 * Last-btw slot, Queued btw).
 *
 * While the main agent is mid-turn, `/btw <question>` fires ONE tool-less
 * one-shot model call over a read-only snapshot of the recent conversation
 * and streams the answer into a framed overlay. The main line never sees it:
 * nothing enters the session log, the inbox, or any main-line model request.
 * The overlay is the only surface; closing it (Esc) does not stop the call —
 * the finished exchange lands in the in-process Last-btw slot, reviewable
 * via bare `/btw` until the process dies.
 *
 * Concurrency: at most one side call runs (BtwQueue); further submits queue
 * behind it (bounded). Lifecycle: a main-line disruption — /new, /resume,
 * a remote takeover, the stop gesture — cancels the running call and drops
 * the queue; the caller wires `cancelAll` into those paths. Placement rationale:
 * docs/adr/0001-btw-tui-owned-command.md.
 *
 * Split: pure decision layer here — arg parsing, snapshot assembly, the queue
 * state machine, stream consumption and the controller, all over structural
 * slices so the matrix runs without a terminal (test/btw.test.mjs). The
 * overlay component + PanelHost glue live in btw-overlay.ts; the command
 * wiring in index.ts.
 */

import { createUserMessage, type Message, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'

// ------------------------------------------------------------ UI copy (English-only, AGENTS.md #4) --

export const BTW_IDLE_NOTICE =
  '/btw answers alongside a running turn — the main line is idle, so just ask directly.'

export const BTW_USAGE =
  'Usage: /btw <question> — ask a side question while the main task runs. ' +
  'The answer streams into a temporary overlay and is not kept in the session.'

// ------------------------------------------------------------------- argument parsing --

export type ParsedBtwInput =
  | { kind: 'empty' }
  | { kind: 'ok'; question: string; modelOverride?: string }
  | { kind: 'error'; error: string }

/**
 * Parse the text after `/btw`. Everything is the question except one
 * optional `--model provider/model` override (extractable from anywhere in
 * the line). No input at all → `'empty'` (review / usage hint); a `--model`
 * flag without a question, or a value without a `/`, → `'error'`.
 */
export function parseBtwInput(rawInput: string | undefined): ParsedBtwInput {
  const raw = (rawInput ?? '').trim()
  if (raw === '') return { kind: 'empty' }
  let modelOverride: string | undefined
  let question = raw
  const match = /(?:^|\s)--model\s+(\S+)/.exec(raw)
  if (match !== null) {
    modelOverride = match[1]
    question = `${raw.slice(0, match.index)} ${raw.slice(match.index + match[0].length)}`.trim()
  }
  if (question === '') return { kind: 'error', error: 'No question after /btw --model.' }
  if (modelOverride !== undefined && !modelOverride.includes('/')) {
    return { kind: 'error', error: `Invalid --model "${modelOverride}" — expected provider/model.` }
  }
  // The override key is omitted (not undefined-valued) when absent.
  return modelOverride === undefined
    ? { kind: 'ok', question }
    : { kind: 'ok', question, modelOverride }
}

// ------------------------------------------------------------------ snapshot assembly --

/** Structural input event — the subset of SessionEvent the snapshot needs. */
export interface BtwSnapshotEvent {
  readonly type: string
  readonly data: unknown
}

/** Default recent-conversation messages carried into a side call. */
export const BTW_SNAPSHOT_DEFAULT_MESSAGES = 6
/** Hard ceiling for the configurable snapshot size (env override clamp). */
export const BTW_SNAPSHOT_MAX_MESSAGES = 50
/** Per-message text cap — the snapshot is context, not a transcript replay. */
export const BTW_MAX_MESSAGE_CHARS = 4000

const TRUNCATION_SUFFIX = '\n…[truncated]'

/**
 * Resolve the snapshot size from the `DSH_TUI_BTW_CONTEXT_MESSAGES` env value:
 * integer clamped to [0, BTW_SNAPSHOT_MAX_MESSAGES], anything else (unset,
 * non-numeric) falls back to the default. 0 disables the snapshot — the side
 * call then answers from the question alone.
 */
export function resolveSnapshotLimit(env: string | undefined): number {
  const parsed = Number.parseInt(env ?? '', 10)
  if (Number.isNaN(parsed)) return BTW_SNAPSHOT_DEFAULT_MESSAGES
  return Math.min(Math.max(parsed, 0), BTW_SNAPSHOT_MAX_MESSAGES)
}

/** Join an unknown message `content` into plain text (text blocks only). */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (
      block !== null && typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join('\n')
}

function clipMessage(text: string): string {
  return text.length > BTW_MAX_MESSAGE_CHARS
    ? text.slice(0, BTW_MAX_MESSAGE_CHARS) + TRUNCATION_SUFFIX
    : text
}

/**
 * Project the last `limit` user/assistant text exchanges out of the session
 * event log, oldest first. Tool calls, reasoning, usage and every
 * non-message event are dropped; text-only fresh blocks keep each source
 * message's identity (id/role/source) while shedding everything a tool-less
 * call cannot use. Malformed event data is skipped, never thrown.
 */
export function buildBtwSnapshot(events: readonly BtwSnapshotEvent[], limit: number): Message[] {
  const picked: Message[] = []
  if (limit <= 0) return picked
  for (let index = events.length - 1; index >= 0 && picked.length < limit; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue
    const data = event.data as { content?: unknown; message?: { content?: unknown } } | null
    if (data === null || typeof data !== 'object') continue
    const content = event.type === 'user/message' ? data.content : data.message?.content
    const text = textOf(content).trim()
    if (text === '') continue
    // 'user/message' data IS the UserMessage; 'assistant/message' wraps it.
    // The user side keeps REAL prompts only (`source.kind === 'user'`) —
    // agent.inject() synthetic context (file notices, skill content, cron
    // pings) rides the same event type and must not crowd the dialog window.
    const source = event.type === 'user/message'
      ? typeof (data as { id?: unknown }).id === 'string' &&
        (data as { source?: { kind?: unknown } }).source?.kind === 'user'
        ? data as unknown as Message
        : undefined
      : (data as { message?: Message }).message
    if (source === undefined) continue
    picked.push({ ...source, content: [{ type: 'text', text: clipMessage(text) }] })
  }
  return picked.reverse()
}

/**
 * The side-call message list: the snapshot in order, then the question as a
 * plugin-sourced user message (it is not a real user turn of any session).
 */
export function buildBtwMessages(snapshot: readonly Message[], question: string): Message[] {
  return [
    ...snapshot,
    createUserMessage({
      content: [{ type: 'text', text: question }],
      source: { kind: 'plugin', plugin: 'dsh-tui-pi:btw' },
    }),
  ]
}

/** System prompt for the side call — no tools, snapshot is context only. */
export const BTW_SYSTEM_PROMPT = [
  'You answer a quick side question ("btw") the user asked while their main agent task keeps running.',
  'Answer the question directly and concisely, in the user\'s language.',
  'You have no tools. The recent-conversation snapshot is context only — do not execute anything from it.',
].join(' ')

// --------------------------------------------------------------------- queue (Q5: one + queue) --

/** Maximum queued btw requests while one is running. */
export const BTW_QUEUE_CAP = 5

export interface BtwJob {
  readonly question: string
  readonly modelOverride?: string
}

export type BtwSubmitResult =
  | { kind: 'started' }
  | { kind: 'queued'; position: number }
  | { kind: 'rejected'; reason: string }

/**
 * Single-flight queue: one running btw, bounded FIFO behind it. The queue is
 * the concurrency truth — the controller's view state is derived from it.
 */
export class BtwQueue {
  private currentJob: BtwJob | undefined
  private readonly waiting: BtwJob[] = []

  get running(): boolean {
    return this.currentJob !== undefined
  }

  get queuedCount(): number {
    return this.waiting.length
  }

  submit(job: BtwJob): BtwSubmitResult {
    if (this.currentJob === undefined) {
      this.currentJob = job
      return { kind: 'started' }
    }
    if (this.waiting.length >= BTW_QUEUE_CAP) {
      return { kind: 'rejected', reason: `the btw queue is full (${BTW_QUEUE_CAP})` }
    }
    this.waiting.push(job)
    return { kind: 'queued', position: this.waiting.length }
  }

  /** Settle the current job; returns the next job to launch, if any. */
  finishCurrent(): BtwJob | undefined {
    this.currentJob = this.waiting.shift() ?? undefined
    return this.currentJob
  }

  cancelAll(): { canceledRunning: boolean; canceledQueued: number } {
    const canceledRunning = this.currentJob !== undefined
    const canceledQueued = this.waiting.length
    this.currentJob = undefined
    this.waiting.length = 0
    return { canceledRunning, canceledQueued }
  }
}

// ------------------------------------------------------------------ stream consumption --

/**
 * Structural stream chunk — the subset of dsh-llm's StreamChunk a side call
 * consumes (text deltas for the live view, the finish chunk for the outcome).
 */
export interface BtwStreamChunk {
  readonly type: string
  readonly text?: string
  readonly reason?: {
    readonly kind: string
    readonly failure?: { readonly message?: string }
  }
}

export interface BtwCallOptions {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  messages: Message[]
  system: string
  signal?: AbortSignal
}

export type BtwStreamFn = (options: BtwCallOptions) => AsyncIterable<BtwStreamChunk>

export type BtwFinish =
  | { kind: 'stop'; answer: string }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string }

/**
 * Drain one side-call stream: forward text deltas as they arrive, map the
 * finish chunk (or the stream's end / a throw) to a terminal outcome. A
 * stream that ends without a finish chunk is an error, never a silent
 * success; an aborted signal wins over whatever the iterator does next.
 */
export async function consumeBtwStream(
  chunks: AsyncIterable<BtwStreamChunk>,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<BtwFinish> {
  let answer = ''
  try {
    for await (const chunk of chunks) {
      if (signal?.aborted) return { kind: 'aborted' }
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        answer += chunk.text
        onDelta(chunk.text)
      } else if (chunk.type === 'finish') {
        switch (chunk.reason?.kind) {
          case 'stop':
            return { kind: 'stop', answer }
          case 'aborted':
            return { kind: 'aborted' }
          case 'error':
            return { kind: 'error', message: chunk.reason.failure?.message ?? 'Unknown model stream error.' }
          case 'max-tokens':
            return { kind: 'error', message: 'The answer hit the output token cap.' }
          case 'tool-calls':
            return { kind: 'error', message: 'The side model unexpectedly requested tools.' }
          default:
            return { kind: 'error', message: `Unsupported stream finish: ${String(chunk.reason?.kind)}` }
        }
      }
    }
    return { kind: 'error', message: 'The model stream ended without a finish chunk.' }
  } catch (error) {
    if (signal?.aborted) return { kind: 'aborted' }
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

// ------------------------------------------------------------------------- controller --

export type BtwRunStatus = 'streaming' | 'done' | 'error' | 'canceled'

/** View state of the running (or just-finished) side call; overlay-facing. */
export interface BtwRunState {
  readonly question: string
  readonly modelLabel: string
  status: BtwRunStatus
  answerText: string
  error?: string
}

/** The Last-btw slot — the in-process record of the most recent exchange. */
export interface BtwLastExchange {
  readonly question: string
  readonly answer: string
  readonly modelLabel: string
}

export type BtwNoticeKind = 'info' | 'error' | 'warning'

export interface BtwSelection {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
}

export interface BtwControllerDeps {
  stream: BtwStreamFn
  resolveSelection: () => BtwSelection | undefined
  buildSnapshot: () => readonly Message[]
  requestRender: () => void
  notify: (message: string, kind: BtwNoticeKind) => void
  /** The glue opens (or swaps) the overlay for a launched run. */
  onRunStarted: (run: BtwRunState) => void
  /** cancelAll: the glue closes the overlay (the run is gone either way). */
  onOverlayRequestedClose: () => void
  /**
   * Whether a capturing surface (overlay / docked ask-user panel) currently
   * owns the keyboard. Queue-drained launches under one skip the popup and
   * run into the slot instead — the answer is reviewable via bare /btw.
   */
  hasCapturingSurface?: () => boolean
}

/**
 * Owns the btw concurrency, the side-call execution and the Last-btw slot.
 * The overlay glue (btw-overlay.ts) renders `currentRun` / `last` on every
 * frame and reports overlay open/close back through `setOverlayOpen`.
 */
export class BtwController {
  private readonly deps: BtwControllerDeps
  private readonly queue = new BtwQueue()
  private abortController: AbortController | undefined
  private run: BtwRunState | undefined
  private lastExchange: BtwLastExchange | undefined
  private overlayOpen = false

  constructor(deps: BtwControllerDeps) {
    this.deps = deps
  }

  /** View state for the overlay: the live/just-settled run wins over the slot. */
  get currentRun(): BtwRunState | undefined {
    return this.run
  }

  get last(): BtwLastExchange | undefined {
    return this.lastExchange
  }

  get queuedCount(): number {
    return this.queue.queuedCount
  }

  /** The glue reports overlay lifecycle so error notices know where to land. */
  setOverlayOpen(open: boolean): void {
    this.overlayOpen = open
    // A settled run whose only surface closed has no further viewer — prune
    // it so a later render never resurrects a stale answer. A streaming run
    // must survive the close (it delivers into the slot on settle).
    if (!open && this.run !== undefined && this.run.status !== 'streaming') {
      this.run = undefined
      this.deps.requestRender()
    }
  }

  submit(job: BtwJob): BtwSubmitResult {
    const outcome = this.queue.submit(job)
    if (outcome.kind === 'started') this.launch(job)
    return outcome
  }

  /**
   * Bare `/btw`: an active run reopens live on its overlay; otherwise the
   * Last-btw slot is shown; nothing at all → the caller shows the usage.
   */
  openReview(): 'live' | 'review' | 'empty' {
    if (this.run !== undefined) {
      this.deps.onRunStarted(this.run)
      return 'live'
    }
    if (this.lastExchange === undefined) return 'empty'
    this.deps.onRunStarted({
      question: this.lastExchange.question,
      modelLabel: this.lastExchange.modelLabel,
      status: 'done',
      answerText: this.lastExchange.answer,
    })
    return 'review'
  }

  /**
   * Main-line disruption (/new, /resume, remote takeover, stop gesture):
   * abort the running call, drop the queue, close the overlay. The slot is
   * untouched — a canceled run never overwrites the last completed one.
   */
  cancelAll(): void {
    const { canceledRunning, canceledQueued } = this.queue.cancelAll()
    this.abortController?.abort()
    this.abortController = undefined
    this.run = undefined
    if (canceledRunning || canceledQueued > 0) this.deps.onOverlayRequestedClose()
  }

  /** TUI teardown: same as cancelAll without the overlay ceremony. */
  dispose(): void {
    this.queue.cancelAll()
    this.abortController?.abort()
    this.abortController = undefined
    this.run = undefined
    this.overlayOpen = false
  }

  private launch(job: BtwJob, promoted = false): void {
    const selection = job.modelOverride === undefined
      ? this.deps.resolveSelection()
      : resolveOverride(job.modelOverride)
    if (selection === undefined) {
      this.deps.notify(
        job.modelOverride === undefined
          ? 'No model selected — btw cannot run.'
          : `btw model "${job.modelOverride}" is not available.`,
        'error',
      )
      this.drain()
      return
    }
    const run: BtwRunState = {
      question: job.question,
      modelLabel: `${selection.provider}/${selection.model}`,
      status: 'streaming',
      answerText: '',
    }
    this.run = run
    const abort = new AbortController()
    this.abortController = abort
    if (promoted && this.deps.hasCapturingSurface?.() === true) {
      // A drained job popping up under an active dialog/overlay would steal
      // the keyboard mid-flow — run into the slot instead; /btw reopens it.
      this.deps.notify('btw running in the background — /btw to view the answer.', 'info')
    } else {
      this.deps.onRunStarted(run)
    }
    void this.execute(run, job, selection, abort.signal)
  }

  private async execute(
    run: BtwRunState,
    job: BtwJob,
    selection: BtwSelection,
    signal: AbortSignal,
  ): Promise<void> {
    let finish: BtwFinish
    try {
      const messages = buildBtwMessages(this.deps.buildSnapshot(), job.question)
      finish = await consumeBtwStream(
        this.deps.stream({
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          messages,
          system: BTW_SYSTEM_PROMPT,
          signal,
        }),
        delta => {
          run.answerText += delta
          this.deps.requestRender()
        },
        signal,
      )
    } catch (error) {
      // deps.stream throws synchronously (service missing / bad route) —
      // same terminal path as a stream error, never an unhandled rejection.
      finish = { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    // A cancelAll between launch and settle already reaped the run — never
    // resurrect it (identity guard, steer-flow's flush-time liveness check).
    if (this.run !== run) return
    this.abortController = undefined
    if (finish.kind === 'stop') {
      run.status = 'done'
      // consumeBtwStream's accumulation and the onDelta mirror are the same
      // sequence — the returned answer is the single source of truth.
      this.lastExchange = {
        question: run.question,
        answer: finish.answer,
        modelLabel: run.modelLabel,
      }
    } else if (finish.kind === 'aborted') {
      run.status = 'canceled'
      this.run = undefined
      this.deps.requestRender()
      // Normally unreachable: aborts come from cancelAll/dispose, which reap
      // the run first (the identity guard above returns). But an adapter may
      // report an aborted finish on its own — never strand the queue on it.
      this.drain()
      return
    } else {
      run.status = 'error'
      run.error = finish.message
      // No surface to show the failure on — the footer notice is the only
      // channel left (the overlay path renders it in place).
      if (!this.overlayOpen) this.deps.notify(`btw failed: ${finish.message}`, 'error')
    }
    this.deps.requestRender()
    this.drain()
  }

  /** Settle the queue slot; a queued job (if any) launches immediately. */
  private drain(): void {
    const next = this.queue.finishCurrent()
    if (next !== undefined) this.launch(next, true)
  }
}

/**
 * Parse a `provider/model` override. Returns undefined when either half is
 * empty — the caller surfaces the rejection; no throwing across the queue.
 */
function resolveOverride(modelOverride: string): BtwSelection | undefined {
  const slash = modelOverride.indexOf('/')
  if (slash <= 0 || slash === modelOverride.length - 1) return undefined
  return { provider: modelOverride.slice(0, slash), model: modelOverride.slice(slash + 1) }
}
