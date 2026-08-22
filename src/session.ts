/**
 * Session bridge between the dsh tree and the TUI.
 *
 * Responsibilities:
 * - lazy agent creation on first prompt (openma runner pattern)
 * - prompt delivery via agent.followup()
 * - session-event subscription filtered to the bridge's session
 * - O(1) incremental stats maintained as events arrive (footer reads these —
 *   never re-scans the session log, per the pi-turbo findings)
 * - resume of persisted sessions (log replay into stats + transcript)
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { settingsNamespace, SettingsConflictError, type SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { readAppendSystem } from './append-system.ts'
import type { AgentView } from './dsh-events.ts'
import { isAgentEnd, isAgentStart, isDcpCompactionNotice, isLlmRetry, isSubagentDescriptor } from './dsh-events.ts'
import { installSpawnToolFence } from './subagent-policy.ts'
import { estimateContentTokens, estimateTextTokens } from './tokens.ts'

/**
 * Register the APPEND_SYSTEM.md section on ONE agent's scoped context, so the
 * user's orchestrator identity applies to the TUI's main agent ONLY. A section
 * registered from the TUI plugin's own (unscoped) context lands in the GLOBAL
 * prompt layer, which every assembly merges - including every subagent's -
 * and an "I am an orchestrator, never execute anything yourself" identity
 * riding on child agents defeats its own purpose. Through the agent's scoped
 * ctx (`agentCtx.systemPrompt` is caller-bound via cordis's traceable
 * services) the section lands in that agent's own scope layer, which nothing
 * else merges: subagent scopes are created without a parent binding, so the
 * children never see it. Same mechanism dsh-subagent uses for per-child
 * personas. Disposal is owned by the agent ctx (`ScopedLayers.effect` runs on
 * `ctx.effect`), so the section dies with the agent.
 */
function installAppendSystem(agentCtx: Context): void {
  const appendSystem = readAppendSystem()   // read once at session startup and cache
  agentCtx.systemPrompt.section({
    name: 'dsh-tui-pi:append-system',
    order: 200,
    text: () => appendSystem,
  })
}

export interface BridgeCallbacks {
  /** One session-log event for the bridge's session, in log order. */
  onEvent(event: SessionEvent): void
  /** Whole-agent lifecycle transition. */
  onStatus(status: 'idle' | 'running'): void
  /** Live snapshot of tracked subagent (child session) rows, on any change. */
  onLive(agents: readonly AgentView[]): void
  /**
   * A tracked child produced one more assistant message — the "rounds" the
   * policy caps (round = one assistant message / LLM round-trip, counted on
   * the child's own `assistant/message` events, not on `turn/end`).
   */
  onRoundCount?(childId: string, count: number): void
}

/**
 * Per-child transcript buffer cap. 2000 events covers a long delegated task's
 * assistant/tool/user rows (~a few hundred KB at worst) while bounding a
 * runaway child; the viewer flags truncation instead of dropping silently.
 */
const CHILD_LOG_CAP = 2000

/**
 * Cadence of the per-child round-count reconcile. The TUI's discovery and
 * fold assume child `session/event` streams bubble here, but in some
 * deployments a subagent's own events never reach this plugin — the child
 * shows up only through the parent's `tool-workflow/agent-start`, so
 * "rounds" stays 0 and the `maxRounds` policy never fires. The reconcile
 * re-derives each child's round count from its authoritative session log
 * (`ctx.sessions`) as a fallback; it only ever moves the count UP past what
 * streamed events already recorded, so the two sources never double count.
 * Rounds are counted on `assistant/message` events (one per LLM round-trip) —
 * a one-shot child never advances `turn/end` while it works.
 */
const ROUND_RECONCILE_MS = 600

/** Tail marker for `llm/retry` events (no text content — the row shows it is re-working). */
const RETRY_MARKER = '↻ retry'

/**
 * Estimated tokens of a `tool/result` event's text payload (the tool output
 * that enters the next request). Defensive: reads through an `unknown` shape
 * and never throws. The result body lives in `data.message.content[*].content`
 * as `{ type: 'text', text }` blocks (plus any inline `isError` marker).
 */
function estimateToolResultTokens(data: unknown): number {
  const content = (data as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return 0
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const inner = (block as { content?: unknown }).content
    if (!Array.isArray(inner)) continue
    for (const item of inner) {
      const b = item as { type?: unknown; text?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
  }
  return estimateTextTokens(parts.join('\n'))
}

/**
 * Bound of a child's live streaming buffer (text + reasoning deltas): enough
 * to extract the last content line of any real stream, bounded so a runaway
 * child cannot grow the fold unboundedly. Trimmed at line boundaries.
 */
const CHILD_STREAM_CAP = 16_384

/** Strip ANSI SGR escape sequences (the only escapes collected into assistant text). */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * Last visible text line of an `assistant/message` event's content, or
 * undefined when it carries no text block. Defensive: reads through an
 * `unknown` shape (the declaring package's content model is not imported
 * here) and never throws — a missing/unexpected field simply yields nothing.
 */
function lastTextLine(data: unknown): string | undefined {
  const content = (data as { message?: { content?: unknown } })?.message?.content
  if (!Array.isArray(content)) return undefined
  let blockText: string | undefined
  for (const block of content) {
    const b = block as { type?: string; text?: unknown }
    if (b?.type === 'text' && typeof b.text === 'string' && b.text !== '') {
      blockText = b.text
    }
  }
  if (blockText === undefined) return undefined
  // Last non-blank line of the text body, whitespace-folded so a wrapped/
  // CRLF stream collapses onto one row.
  const body = stripAnsi(blockText).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = body.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line === '') continue
    return line.replace(/\s+/g, ' ')
  }
  return undefined
}

/**
 * Append one delta to a child's bounded streaming buffer, trimming whole head
 * lines past CHILD_STREAM_CAP (amortized O(1) per delta — the trim only
 * fires when the buffer outgrows the cap, and each firing drops at least one
 * whole line). The buffer feeds the live content tail: its last non-blank
 * line is what the compact agent row shows while the child streams.
 */
function bumpChildStream(buffer: string, delta: string): string {
  let next = buffer + delta
  while (next.length > CHILD_STREAM_CAP) {
    const nl = next.indexOf('\n')
    if (nl === -1) {
      next = next.slice(-Math.floor(CHILD_STREAM_CAP / 2))
      break
    }
    next = next.slice(nl + 1)
  }
  return next
}

/** Last visible, whitespace-folded line of a raw streaming buffer (see lastTextLine). */
function lastBufferLine(buffer: string): string | undefined {
  const body = stripAnsi(buffer).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = body.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line === '') continue
    return line.replace(/\s+/g, ' ')
  }
  return undefined
}

/** Incrementally maintained footer statistics (all O(1) reads). */
export interface BridgeStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** User + assistant surface messages observed. */
  msgCount: number
  toolCallCount: number
  /** Whole-log cache-hit rate: cumulative cacheReadTokens ÷ billed input (input + cacheRead + cacheWrite), matching DSH web. */
  cacheHitRate?: number
  /**
   * Current context occupancy estimate — the value the footer's Context
   * segment divides by the model window: the latest assistant/message's
   * billed input + output plus a CJK estimate of every message appended
   * after it (they enter the next request). NOT the cumulative `inputTokens`
   * — that total only grows, while this tracks the current context so the
   * display follows the latest request and drops after a compaction.
   */
  contextTokens: number
}

export class DshSessionBridge {
  private readonly ctx: Context
  private readonly callbacks: BridgeCallbacks
  private handle: AgentHandle | undefined
  private creating: Promise<AgentHandle> | undefined
  private resuming: Promise<AgentHandle> | undefined
  private readonly disposers: Array<() => void> = []
  private sessionId: SessionId | undefined
  /** Agent preset id to pass to `meta.agentPreset` on the next `createSession`. */
  private agentPreset: string | undefined
  private selection: ModelSelection | undefined
  /** Mutable live selection installed into the agent; `/model` mutates `current`. */
  private readonly selectionRef: ModelSelectionRef = { current: undefined, assembled: undefined }
  /** Mirror of the agent's `agent/status`; `isRunning()` reads this. */
  private running = false
  private readonly stats: BridgeStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    msgCount: 0,
    toolCallCount: 0,
    contextTokens: 0,
  }
  /**
   * Usage snapshot of the LATEST assistant/message — the exact billed context
   * of the last request (input = uncached, cache read/write billed on top;
   * output = that request's own output). The footer's context segment prices
   * this plus `pendingTokens` (see BridgeStats.contextTokens). `undefined`
   * until the first assistant/message arrives.
   */
  private lastUsage: TokenUsage | undefined
  /**
   * CJK-estimated tokens of every message appended AFTER the latest
   * assistant/message (user prompts, tool results, streamed text deltas) —
   * they enter the next request. Reset to 0 by the next assistant/message,
   * whose usage snapshot then covers them exactly.
   */
  private pendingTokens = 0
  /** Live subagent rows keyed by child session id. */
  private readonly agentViews = new Map<string, AgentView>()
  /** Child session ids whose own events we fold into the agent views. */
  private readonly childSessions = new Set<string>()
  /**
   * Per-child event ring buffer — the raw transcript the subagent viewer
   * renders. Capped so a runaway child cannot grow the process unboundedly;
   * the oldest events drop off (the viewer shows a "history truncated" hint
   * when the cap is hit).
   */
  private readonly childLogs = new Map<string, SessionEvent[]>()
  /**
   * Per-child bounded streaming buffer (text + reasoning deltas) — the live
   * content tail the compact agent row shows while the child streams. The
   * assembled `assistant/message` replaces it with the authoritative last
   * line and deletes the entry.
   */
  private readonly childStreams = new Map<string, string>()
  /**
   * Per-child assistant-message count — the "rounds" the policy caps. One
   * increment per `assistant/message` (an LLM round-trip), counted on the
   * child's OWN events. Settled children keep counting (a continuable child
   * resumes later), so the count stays authoritative for the viewer and the
   * wrap-up policy.
   */
  private readonly roundCounts = new Map<string, number>()
  /**
   * The EVENT path's own absolute per-child assistant-message count — its
   * ledger of streamed `assistant/message` events it has actually received.
   * The reconcile derives its own count from the session log; the displayed
   * "rounds" is `max(streamed, reconciled)` (see foldTracked). Keeping the
   * two ledgers separate is what makes a message the reconcile already
   * counted immune to a second count when its streamed event arrives late.
   */
  private readonly streamedRoundCounts = new Map<string, number>()
  /**
   * Per-child usage snapshot of the latest assistant/message (see
   * `lastUsage` for the main session) — the exact billed context of the
   * child's last request, the `contextTokens` baseline.
   */
  private readonly childUsage = new Map<string, TokenUsage>()
  /**
   * Per-child CJK-estimated tokens of messages appended after the latest
   * assistant/message (see `pendingTokens` for the main session) — the
   * `contextTokens` increment that makes the compact `X/Y` follow live.
   */
  private readonly childPending = new Map<string, number>()
  /**
   * Per-child dsh-dcp compaction count — one per `user/message` notice whose
   * source is `{ kind: 'plugin', plugin: 'dsh-dcp', form: 'notice' }`. The
   * viewer's picker rows read this via `getChildCompactionCount` so the user
   * sees at a glance whether DCP actually compacted inside a child.
   */
  private readonly childCompactionCounts = new Map<string, number>()
  /**
   * Per-child session-log length already reconciled (see
   * reconcileChildRounds). Incremental high-water, so the reconcile scans
   * only newly-appended events.
   */
  private readonly reconciledLen = new Map<string, number>()
  /** Per-child round count derived from the session log by the reconcile. */
  private readonly reconciledCount = new Map<string, number>()
  /**
   * Session ids that can own tracked children (this session first, then every
   * tracked child — delegation nests). Used to match `parentSession` headers
   * and to fold workflow events of the parent log.
   */
  private readonly trackedSessions = new Set<string>()
  /** `${runId}:${seq}` → childId, for `tool-workflow/agent-end` pairing. */
  private readonly runSeqToChild = new Map<string, string>()

  constructor(ctx: Context, callbacks: BridgeCallbacks) {
    this.ctx = ctx
    this.callbacks = callbacks
    // Footer shows provider/model from the very first frame — read the
    // composed default selection eagerly; a session created later refreshes it.
    const defaultModel = ctx.get('agentDefaultModel')
    const sel = defaultModel?.currentSelection()
    this.selection = sel === undefined
      ? undefined
      : {
          provider: sel.provider,
          model: sel.model,
          ...sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort },
        }
    this.disposers.push(ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const sessionKey = String(session.id)
      // Discover subagent children by session header — the deployment may
      // never emit tool-workflow events (the firehose is not scope-filtered,
      // so child sessions arrive here too). A session whose parent is a
      // tracked session AND is marked as delegated is a child; the descriptor
      // event later refines the label/provider.
      //
      // Guard: a child is `origin: 'subagent'` OR a delegation budget
      // `delegationDepth > 0`. Both markers are written together by dsh's
      // childSessionMeta (spawn AND in-process fork children alike), so in
      // practice the origin alone carries the decision; the budget clause
      // only future-proofs the gate against a child that carries the budget
      // without the origin. The budget test MUST be a VALUE test, not a
      // field-presence test: the jsonl persistence backend materialises
      // `delegationDepth: 0` on every restored header (write `?? 0`, read
      // unconditionally), so a presence test would pull user-facing
      // `Session.fork` conversations and other non-child restored sessions
      // onto the live board / Ctrl+G.
      const header = session.header
      if (header?.parentSession !== undefined
        && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)
        && this.trackedSessions.has(String(header.parentSession))
        && !this.agentViews.has(sessionKey)) {
        this.agentViews.set(sessionKey, {
          childId: sessionKey,
          parentSession: String(header.parentSession),
          // Current dsh children always carry the origin, so in practice the
          // label is `subagent <id8>`; the `fork` label only fires for the
          // defensive budget-without-origin shape above.
          label: header.origin === undefined
            ? `fork ${sessionKey.slice(0, 8)}`
            : `subagent ${sessionKey.slice(0, 8)}`,
          startedAt: event.time,
          tokens: 0,
          rounds: 0,
          retries: 0,
          contextTokens: 0,
        })
        this.childSessions.add(sessionKey)
        this.trackedSessions.add(sessionKey)
        this.emitLive()
      }
      // Fold workflow + child events for every tracked session.
      if (this.trackedSessions.has(sessionKey)) {
        this.foldTracked(sessionKey, event)
      }
      // Buffer the child's OWN log for the viewer (not the parent's workflow
      // rows, which carry no child transcript). The buffer is capped; the
      // viewer reports truncation when the head dropped off.
      if (this.childSessions.has(sessionKey)) {
        this.appendChildLog(sessionKey, event)
      }
      if (this.sessionId !== undefined && session.id === this.sessionId) {
        this.applyEvent(event)
        this.callbacks.onEvent(event)
      }
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }: { agent: { id: string }; status: 'idle' | 'running' }) => {
      if (this.handle === undefined || agent.id !== this.handle.agent.id) return
      this.running = status === 'running'
      this.callbacks.onStatus(status)
    }))
    // Round-count reconcile fallback: keep "rounds" and the maxRounds policy
    // live even when a child's own events never bubble to this plugin (see
    // ROUND_RECONCILE_MS). Runs regardless of whether the viewer is open — the
    // cap must still fire while the child works in the background.
    const reconcile = setInterval(() => {
      try {
        this.reconcileChildRounds()
      } catch {
        // A throwing reconcile must never take the process down.
      }
    }, ROUND_RECONCILE_MS)
    reconcile.unref?.()
    this.disposers.push(() => clearInterval(reconcile))
  }

  /**
   * Re-derive each tracked child's round count from its own session log
   * (`ctx.sessions`), the authoritative append-only facts. The firehose
   * assumption behind discovery/fold is unreliable in some deployments — a
   * child is listed from the parent's `tool-workflow/agent-start` but its own
   * `assistant/message` events never arrive, which leaves both the rounds
   * display and the `maxRounds` policy dead at 0. This corrects the count UP
   * past whatever the streamed events already recorded (never down, never
   * re-adding what events counted), and fires `onRoundCount` so the cap still
   * guards a child whose events were never delivered. Rounds are counted on
   * `assistant/message` (one per LLM round-trip — `turn/end` is structurally
   * inert for a one-shot child that never leaves its single turn). Scans only
   * newly-appended events per child.
   */
  private reconcileChildRounds(): void {
    const sessions = (this.ctx as Context & { sessions?: { get(id: SessionId): Session | undefined } }).sessions
    if (sessions === undefined) return
    for (const childId of this.childSessions) {
      const session = sessions.get(SessionId(childId))
      if (session === undefined) continue
      const events = session.events
      const len = events.length
      let from = this.reconciledLen.get(childId) ?? 0
      // A torn-down / re-seeded child session restarts its log — recount it.
      if (from > len) {
        this.reconciledLen.set(childId, 0)
        this.reconciledCount.set(childId, 0)
        from = 0
      }
      if (from >= len) continue
      let added = 0
      for (let i = from; i < len; i++) {
        if (events[i]!.type === 'assistant/message') added += 1
      }
      const absolute = (this.reconciledCount.get(childId) ?? 0) + added
      this.reconciledLen.set(childId, len)
      this.reconciledCount.set(childId, absolute)
      const current = this.roundCounts.get(childId) ?? 0
      if (absolute > current) {
        this.roundCounts.set(childId, absolute)
        this.callbacks.onRoundCount?.(childId, absolute)
      }
    }
  }

  /** Snapshot of the incremental stats (footer reads this O(1)). */
  getStats(): BridgeStats {
    return { ...this.stats }
  }

  /** Current session id, when one exists. */
  getSessionId(): SessionId | undefined {
    return this.sessionId
  }

  /** Sorted snapshot of every tracked child (running and settled). */
  getAgentViews(): readonly AgentView[] {
    return [...this.agentViews.values()].sort(
      (a, b) => a.startedAt - b.startedAt || a.childId.localeCompare(b.childId),
    )
  }

  /** Children still running (`outcome` unset) — the live count the guard caps. */
  getLiveChildren(): readonly AgentView[] {
    return this.getAgentViews().filter(view => view.outcome === undefined)
  }

  /** The buffered transcript of one child, in log order (capped, maybe truncated). */
  getChildLog(childId: string): readonly SessionEvent[] {
    return this.childLogs.get(childId) ?? []
  }

  /** Assistant-message count of one child ("rounds" — the policy cap unit). */
  getRoundCount(childId: string): number {
    return this.roundCounts.get(childId) ?? 0
  }

  /** dsh-dcp compaction count of one child (viewer picker rows). */
  getChildCompactionCount(childId: string): number {
    return this.childCompactionCounts.get(childId) ?? 0
  }

  /** Whether one child settled (a continuable child may resume later). */
  isChildSettled(childId: string): boolean {
    return this.agentViews.get(childId)?.outcome !== undefined
  }

  /** True when the child's buffered transcript dropped its oldest events. */
  isChildLogTruncated(childId: string): boolean {
    return (this.childLogs.get(childId)?.length ?? 0) >= CHILD_LOG_CAP
  }

  /** Queue one user prompt, creating the session lazily on first use. */
  async prompt(text: string): Promise<void> {
    const handle = await this.ensureSession()
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    handle.agent.followup(message)
  }

  /** The live agent, creating the session lazily when needed. */
  async ensureAgent(): Promise<Agent> {
    const handle = await this.ensureSession()
    return handle.agent
  }

  /** The live agent when a session already exists (no creation side effect). */
  getAgent(): Agent | undefined {
    return this.handle?.agent
  }

  /** Whether the bridge's agent is mid-turn (mirror of `agent/status`). */
  isRunning(): boolean {
    return this.running
  }

  /**
   * Abort the bridge's agent mid-turn, mirroring the web client's stop
   * button: the host-side `session.cancel` handler calls
   * `agent.cancel({ kind: 'user' }, { keepInbox: true })`
   * (dsh-host-apiproxy), and that is exactly what the agent's public
   * synchronous `cancel(cause, options)` API takes. `keepInbox` preserves
   * queued prompts for a later turn; the active driver's AbortSignal fires
   * and status converges to `idle` via the existing subscription. The API
   * is fire-and-forget — the returned promise resolves once the call is
   * made, not when the turn settles.
   * @returns false when there is no agent or it is not running; true once
   *   the cancellation was issued.
   */
  async cancelActiveTurn(): Promise<boolean> {
    const agent = this.handle?.agent
    if (agent === undefined || !this.running) return false
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      return true
    } catch {
      // Cancellation must never take the input path down with it.
      return false
    }
  }

  /** Dispose the live agent (if any) and stop event subscriptions. */
  async dispose(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) {
      try { dispose() } catch { /* contained */ }
    }
    const handle = this.handle
    this.handle = undefined
    this.sessionId = undefined
    this.running = false
    this.agentViews.clear()
    this.childSessions.clear()
    this.childLogs.clear()
    this.childStreams.clear()
    this.roundCounts.clear()
    this.streamedRoundCounts.clear()
    this.childUsage.clear()
    this.childPending.clear()
    this.childCompactionCounts.clear()
    this.reconciledLen.clear()
    this.reconciledCount.clear()
    this.trackedSessions.clear()
    this.runSeqToChild.clear()
    if (handle !== undefined) await handle.dispose()
  }

  /**
   * Detach the live agent WITHOUT tearing down the event subscriptions —
   * `/new` wants a fresh session while the renderer keeps receiving events.
   * The agent handle is disposed, the session id cleared, and the
   * incremental stats zeroed (the footer must not carry the old session's
   * numbers); the disposers stay installed, and the session-id filter
   * re-binds on the next lazy creation. The subagent tracker is cleared and
   * an empty `onLive` is emitted so the renderer drops the agents block.
   */
  async detachCurrent(): Promise<void> {
    const handle = this.handle
    this.handle = undefined
    this.sessionId = undefined
    this.running = false
    this.stats.inputTokens = 0
    this.stats.outputTokens = 0
    this.stats.cacheReadTokens = 0
    this.stats.cacheWriteTokens = 0
    this.stats.msgCount = 0
    this.stats.toolCallCount = 0
    this.stats.cacheHitRate = undefined
    this.stats.contextTokens = 0
    this.lastUsage = undefined
    this.pendingTokens = 0
    this.agentViews.clear()
    this.childSessions.clear()
    this.childLogs.clear()
    this.childStreams.clear()
    this.roundCounts.clear()
    this.streamedRoundCounts.clear()
    this.childUsage.clear()
    this.childPending.clear()
    this.childCompactionCounts.clear()
    this.reconciledLen.clear()
    this.reconciledCount.clear()
    this.trackedSessions.clear()
    this.runSeqToChild.clear()
    this.emitLive()
    if (handle !== undefined) await handle.dispose()
  }

  /**
   * Resume a persisted session: tear down the live agent (disposers are kept —
   * the session-id filter re-binds to the resumed id) and load the persisted
   * session in its place. The caller replays `handle.agent.session.events`
   * through `replay()` to rebuild stats/transcript — clear the transcript
   * BEFORE replaying (the renderer's echo dedupe must not see replayed user
   * messages next to a stale local echo). Serialized: concurrent calls share
   * the single in-flight resume.
   */
  async resume(sessionId: SessionId): Promise<AgentHandle> {
    if (this.resuming !== undefined) return this.resuming
    const task = (async () => {
      const handle = this.handle
      this.handle = undefined
      this.sessionId = undefined
      this.running = false
      this.agentViews.clear()
      this.childSessions.clear()
      this.trackedSessions.clear()
      this.runSeqToChild.clear()
      // The renderer keeps its live snapshot across the resume teardown (it
      // must survive theme-switch rebuilds), so an empty emit is required to
      // drop the previous session's agents block before the resumed log's
      // workflow events rebuild it.
      this.emitLive()
      if (handle !== undefined) await handle.dispose()
      // Same seeding rule as createSession: a live /model or /think choice
      // survives the resume; otherwise the composed default applies.
      this.seedSelectionFromDefault()
      const resumed = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.selection ?? {},
        // Install the mutable selection so `/model` can live-switch the route,
        // the APPEND_SYSTEM.md section on this agent ONLY (never its
        // subagents), and the spawn-tool hide so the agent sees a single
        // `use_agent` delegation entry.
        setup: async agentCtx => {
          installModelSelection(agentCtx, this.selectionRef)
          installAppendSystem(agentCtx)
          installSpawnToolFence(agentCtx)
        },
      })
      this.handle = resumed
      this.sessionId = sessionId
      this.trackedSessions.add(String(sessionId))
      return resumed
    })()
    this.resuming = task
    try {
      return await task
    } finally {
      this.resuming = undefined
    }
  }

  /**
   * Replay a persisted session log into the transcript and stats — the second
   * half of a resume (call after `resume()`). Stats are rebuilt from zero so
   * the footer reflects the resumed session only; replaying the same log
   * twice is idempotent. `assistant/chunk` events are skipped: the finalized
   * `assistant/message` carries the full text, and replaying chunks would
   * re-run the quadratic streaming assembly for every historical step.
   */
  replay(events: readonly SessionEvent[]): void {
    this.stats.inputTokens = 0
    this.stats.outputTokens = 0
    this.stats.cacheReadTokens = 0
    this.stats.cacheWriteTokens = 0
    this.stats.msgCount = 0
    this.stats.toolCallCount = 0
    this.stats.cacheHitRate = undefined
    this.stats.contextTokens = 0
    this.lastUsage = undefined
    this.pendingTokens = 0
    const sessionId = this.sessionId
    for (const event of events) {
      if (event.type === 'assistant/chunk') continue
      // Replay feeds the parent log only — fold its persisted workflow events
      // through the same tracking logic so the agents view is rebuilt; child
      // live events arrive via the subscription after resume.
      if (sessionId !== undefined && this.trackedSessions.has(String(sessionId))) {
        this.foldTracked(String(sessionId), event)
      }
      this.applyEvent(event)
      this.callbacks.onEvent(event)
    }
  }

  /** Update incremental stats from one event — one pass over the event only. */
  private applyEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'user/message':
        this.stats.msgCount += 1
        // The prompt enters the NEXT request — priced into the occupancy now.
        this.pendingTokens += estimateContentTokens((event.data as { content?: unknown }).content)
        this.stats.contextTokens = this.contextTokens()
        break
      case 'assistant/message': {
        this.stats.msgCount += 1
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') this.stats.toolCallCount += 1
        }
        const usage: TokenUsage | undefined = event.data.usage
        if (usage !== undefined) {
          // The assembled message finalizes the request: its usage snapshot is
          // now the exact billed context (input + cache + output) and the
          // pending estimate restarts from what follows it. A usage-less
          // message (adapter reported none) leaves the baseline untouched —
          // pending already holds the streamed chunk estimate accumulated for
          // this message, a reasonable stand-in until the next billed message.
          this.lastUsage = usage
          this.pendingTokens = 0
          this.stats.inputTokens += usage.inputTokens
          this.stats.outputTokens += usage.outputTokens
          this.stats.cacheReadTokens += usage.cacheReadTokens ?? 0
          this.stats.cacheWriteTokens += usage.cacheWriteTokens ?? 0
          const billedInput = this.stats.inputTokens + this.stats.cacheReadTokens + this.stats.cacheWriteTokens
          this.stats.cacheHitRate = billedInput > 0
            ? (this.stats.cacheReadTokens / billedInput) * 100
            : undefined
        }
        this.stats.contextTokens = this.contextTokens()
        break
      }
      case 'assistant/chunk': {
        // Streamed output of the in-flight request — the next request's
        // context grows with it, so the occupancy follows the stream live.
        // Both text and reasoning deltas are priced: usage.outputTokens
        // includes reasoning tokens at snapshot time, so the live estimate
        // must count reasoning too to match that accounting (the next billed
        // assistant/message corrects the final value anyway).
        const chunk = (event.data as { chunk?: { type?: string; text?: string } }).chunk
        if ((chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') && chunk.text !== '') {
          this.pendingTokens += estimateTextTokens(chunk.text ?? '')
          this.stats.contextTokens = this.contextTokens()
        }
        break
      }
      case 'tool/result':
        // Tool results enter the next request — priced into the occupancy.
        this.pendingTokens += estimateToolResultTokens(event.data)
        this.stats.contextTokens = this.contextTokens()
        break
      default:
        break
    }
  }

  /**
   * The current context-occupancy estimate: the latest assistant/message's
   * billed input (uncached + cache read + cache write) and output, plus the
   * CJK estimate of every message appended after it. Before the first
   * assistant/message the pending estimate alone stands in for the whole
   * current context.
   */
  private contextTokens(): number {
    if (this.lastUsage === undefined) return this.pendingTokens
    return this.lastUsage.inputTokens
      + (this.lastUsage.cacheReadTokens ?? 0)
      + (this.lastUsage.cacheWriteTokens ?? 0)
      + this.lastUsage.outputTokens
      + this.pendingTokens
  }

  /**
   * The current context-occupancy estimate of one child (the `X` in the
   * compact line's `X/Y`): the child's latest assistant/message billed input
   * + output plus the CJK estimate of messages appended after it. Before the
   * child's first assistant/message the pending estimate alone stands in.
   */
  private childContextTokens(childId: string): number {
    const usage = this.childUsage.get(childId)
    const pending = this.childPending.get(childId) ?? 0
    if (usage === undefined) return pending
    return usage.inputTokens
      + (usage.cacheReadTokens ?? 0)
      + (usage.cacheWriteTokens ?? 0)
      + usage.outputTokens
      + pending
  }

  /**
   * Fold one event of a tracked session into the agent views (workflow events
   * of the parent log + the child's own log). O(1) per event — Maps/Sets only,
   * never a session-log scan. Emits `onLive` when a view actually changed.
   * @returns whether a view changed (and `onLive` was emitted).
   */
  private foldTracked(sessionId: string, event: SessionEvent): boolean {
    let changed = false
    if (isAgentStart(event)) {
      // Workflow member: register with the workflow label + start time.
      if (!this.agentViews.has(event.data.childId)) {
        this.agentViews.set(event.data.childId, {
          childId: event.data.childId,
          label: event.data.label,
          startedAt: event.time,
          tokens: 0,
          rounds: 0,
          retries: 0,
          contextTokens: 0,
        })
        this.runSeqToChild.set(`${event.data.runId}:${event.data.seq}`, event.data.childId)
        this.childSessions.add(event.data.childId)
        this.trackedSessions.add(event.data.childId)
        changed = true
      }
    } else if (isAgentEnd(event)) {
      const childId = this.runSeqToChild.get(`${event.data.runId}:${event.data.seq}`)
      const existing = childId === undefined ? undefined : this.agentViews.get(childId)
      if (childId !== undefined && existing !== undefined && existing.outcome === undefined) {
        this.agentViews.set(childId, {
          ...existing,
          outcome: event.data.outcome,
          endedAt: event.time,
        })
        changed = true
      }
    }
    if (this.childSessions.has(sessionId)) {
      const view = this.agentViews.get(sessionId)
      if (view !== undefined) {
        if (isSubagentDescriptor(event)) {
          if (view.provider !== event.data.provider
            || view.mode !== event.data.mode
            || (event.data.label !== undefined && view.label !== event.data.label)) {
            this.agentViews.set(sessionId, {
              ...view,
              provider: event.data.provider,
              mode: event.data.mode,
              ...(event.data.label === undefined ? {} : { label: event.data.label }),
            })
            changed = true
          }
        } else if (event.type === 'assistant/message') {
          // Round counting is view-independent: every assistant message of the
          // child is one round (one LLM round-trip), counted even once the
          // view settled — continuable children resume. `turn/end` is NOT the
          // round unit: a one-shot child never leaves its single turn, so its
          // rounds would stay frozen at 0 while it works.
          // The event path keeps its OWN absolute streamed count and merges
          // it with the reconcile's log-derived count by max() — the two
          // ledgers never double count. A message the reconcile already
          // counted (its `assistant/message` reached the session log first)
          // must not be counted AGAIN when that same event arrives late here:
          // the reconcile only moves the count up, so a naive `current + 1`
          // would inflate it permanently. Caveat: "absolute" holds only while
          // the firehose delivers each event at most once — there is no seq
          // de-dup, so a redelivered `assistant/message` inflates the
          // streamed ledger permanently (the previous `current + 1` counter
          // had the same exposure).
          const streamed = (this.streamedRoundCounts.get(sessionId) ?? 0) + 1
          this.streamedRoundCounts.set(sessionId, streamed)
          const count = Math.max(streamed, this.roundCounts.get(sessionId) ?? 0)
          if (count !== (this.roundCounts.get(sessionId) ?? 0)) {
            this.roundCounts.set(sessionId, count)
            this.callbacks.onRoundCount?.(sessionId, count)
          }
          const usage = event.data.usage
          const delta = usage === undefined
            ? 0
            : usage.inputTokens + usage.outputTokens
              + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
          // The assembled message finalizes the child's request: its usage is
          // now the exact billed context baseline and the pending estimate
          // restarts from what follows it. A usage-less message leaves both
          // untouched — pending still holds the streamed chunk estimate
          // accumulated for this message, a reasonable approximation until the
          // next billed message replaces it.
          if (usage !== undefined) {
            this.childUsage.set(sessionId, usage)
            this.childPending.set(sessionId, 0)
          }
          const lastLine = lastTextLine(event.data)
          const tokensChanged = delta > 0
          const lineChanged = lastLine !== undefined && lastLine !== view.lastLine
          const roundsChanged = count !== view.rounds
          const contextTokens = this.childContextTokens(sessionId)
          const contextChanged = contextTokens !== view.contextTokens
          if (tokensChanged || lineChanged || roundsChanged || contextChanged) {
            // One set: neither delta nor lastLine nor rounds nor contextTokens
            // may clobber the others. The assembled message is authoritative
            // for the content tail — its streaming buffer is spent.
            this.agentViews.set(sessionId, {
              ...view,
              ...(tokensChanged ? { tokens: view.tokens + delta } : {}),
              ...(lineChanged ? { lastLine } : {}),
              ...(roundsChanged ? { rounds: count } : {}),
              ...(contextChanged ? { contextTokens } : {}),
            })
            changed = true
          }
          this.childStreams.delete(sessionId)
        } else if (event.type === 'assistant/chunk') {
          // Live content tail: fold the child's streaming deltas (text AND
          // reasoning) so the compact row's last line refreshes while the
          // child works — never a tool name, always its own output. The
          // assembled assistant/message later replaces it with the
          // authoritative last line.
          const chunk = (event.data as { chunk?: { type?: string; text?: string } }).chunk
          if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') {
            const delta = chunk.text ?? ''
            if (delta !== '') {
              const buffer = bumpChildStream(this.childStreams.get(sessionId) ?? '', delta)
              this.childStreams.set(sessionId, buffer)
              const lastLine = lastBufferLine(buffer)
              // Streamed output (text AND reasoning) grows the child's current
              // context too — usage.outputTokens includes reasoning tokens at
              // snapshot, so the live estimate prices both; the compact X/Y
              // follows live.
              const wasPending = this.childPending.get(sessionId) ?? 0
              const lineChanged = lastLine !== undefined && lastLine !== view.lastLine
              // The outer guard already narrowed to text/reasoning deltas, so
              // this branch is unconditional.
              this.childPending.set(sessionId, wasPending + estimateTextTokens(delta))
              const contextTokens = this.childContextTokens(sessionId)
              const contextChanged = contextTokens !== view.contextTokens
              if (lineChanged || contextChanged) {
                this.agentViews.set(sessionId, {
                  ...view,
                  ...(lineChanged ? { lastLine } : {}),
                  ...(contextChanged ? { contextTokens } : {}),
                })
                changed = true
              }
            }
          }
        } else if (event.type === 'user/message') {
          // The child's own prompts/injects enter its next request — the
          // occupancy follows (the content tail is never touched here). A
          // dsh-dcp compaction notice (plugin `notice` form) also tallies the
          // per-child compaction count the viewer's picker rows read.
          if (isDcpCompactionNotice(event)) {
            this.childCompactionCounts.set(
              sessionId,
              (this.childCompactionCounts.get(sessionId) ?? 0) + 1,
            )
          }
          this.childPending.set(
            sessionId,
            (this.childPending.get(sessionId) ?? 0)
              + estimateContentTokens((event.data as { content?: unknown }).content),
          )
          const contextTokens = this.childContextTokens(sessionId)
          if (contextTokens !== view.contextTokens) {
            this.agentViews.set(sessionId, { ...view, contextTokens })
            changed = true
          }
        } else if (event.type === 'tool/result') {
          // Tool results enter the child's next request — the occupancy
          // follows (the content tail shows the child's own output only).
          this.childPending.set(
            sessionId,
            (this.childPending.get(sessionId) ?? 0) + estimateToolResultTokens(event.data),
          )
          const contextTokens = this.childContextTokens(sessionId)
          if (contextTokens !== view.contextTokens) {
            this.agentViews.set(sessionId, { ...view, contextTokens })
            changed = true
          }
        } else if (isLlmRetry(event)) {
          // No text content — surface a fixed marker so the row shows the
          // child is (re)working. Merged into one set so the retry counters
          // and the marker can't clobber each other.
          const retryChanged = view.retries !== event.data.retry || view.maxRetries !== event.data.maxRetries
          const lineChanged = view.lastLine !== RETRY_MARKER
          if (retryChanged || lineChanged) {
            this.agentViews.set(sessionId, {
              ...view,
              ...(retryChanged
                ? { retries: event.data.retry, maxRetries: event.data.maxRetries }
                : {}),
              ...(lineChanged ? { lastLine: RETRY_MARKER } : {}),
            })
            changed = true
          }
        } else if (event.type === 'tool/call') {
          // Tool invocations do NOT touch the content tail: the compact row
          // shows the child's own output (assistant text/reasoning), never a
          // tool name. Only the lastTool activity marker is maintained.
          if (view.lastTool !== event.data.name) {
            this.agentViews.set(sessionId, { ...view, lastTool: event.data.name })
            changed = true
          }
        } else if (event.type === 'request/context') {
          const contextWindow = event.data.contextWindow
          if (typeof contextWindow === 'number' && view.contextWindow !== contextWindow) {
            this.agentViews.set(sessionId, { ...view, contextWindow })
            changed = true
          }
        } else if (event.type === 'turn/end' && view.outcome === undefined) {
          // Best-effort settle for header-discovered children (no workflow
          // outcome event): the child's turn closed — the widget drops it.
          this.agentViews.set(sessionId, { ...view, outcome: 'completed', endedAt: event.time })
          changed = true
        } else if (event.type === 'turn/start' && view.outcome !== undefined) {
          // A continuable child resumed: mark it running again.
          this.agentViews.set(sessionId, { ...view, outcome: undefined, endedAt: undefined })
          changed = true
        }
      }
    }
    if (changed) this.emitLive()
    return changed
  }

  /** Push the current agent views (stable order) to the renderer. */
  private emitLive(): void {
    this.callbacks.onLive(this.getAgentViews())
  }

  /** Append one child-session event to its transcript buffer, dropping the oldest at the cap. */
  private appendChildLog(childId: string, event: SessionEvent): void {
    let log = this.childLogs.get(childId)
    if (log === undefined) {
      log = []
      this.childLogs.set(childId, log)
    }
    if (log.length >= CHILD_LOG_CAP) log.shift()
    log.push(event)
  }

  private async ensureSession(): Promise<AgentHandle> {
    // A resume in flight would otherwise race this check: the handle is only
    // set when resume completes, so a prompt fired mid-resume must not start
    // a second agent creation. Await it — on success the handle is ready for
    // reuse; on failure fall through to the normal creation path.
    if (this.resuming !== undefined) {
      try {
        await this.resuming
      } catch {
        // Resume failed — fall through to create a fresh session.
      }
    }
    if (this.handle !== undefined) return this.handle
    if (this.creating !== undefined) return this.creating
    const creation = this.createSession()
    this.creating = creation
    try {
      this.handle = await creation
      this.sessionId = this.handle.agent.session.id
      this.trackedSessions.add(String(this.sessionId))
      return this.handle
    } finally {
      this.creating = undefined
    }
  }

  /**
   * Seed `selection`/`selectionRef` from the composed default — without
   * clobbering a live user choice: `/model`/`/think` before the first prompt
   * write the ref, and that choice must survive session creation.
   */
  private seedSelectionFromDefault(): void {
    if (this.selectionRef.current !== undefined) {
      this.selection = { ...this.selectionRef.current }
      return
    }
    const defaultModel = this.ctx.get('agentDefaultModel')
    const selection = defaultModel?.currentSelection()
    this.selection = selection === undefined
      ? undefined
      : {
          provider: selection.provider,
          model: selection.model,
          ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        }
    this.selectionRef.current = this.selection === undefined ? undefined : { ...this.selection }
  }

  /** Create the agent with the composed default model selection. */
  private createSession(): Promise<AgentHandle> {
    this.seedSelectionFromDefault()
    return this.ctx.agents.create({
      sessionId: SessionId(crypto.randomUUID()),
      meta: {
        cwd: process.cwd(),
        ...this.agentPreset !== undefined ? { agentPreset: this.agentPreset } : {},
      },
      agentOptions: this.selection ?? {},
      // Install the mutable selection so `/model` can live-switch the route,
      // the APPEND_SYSTEM.md section on this agent ONLY (never its
      // subagents), and the spawn-tool hide so the agent sees a single
      // `use_agent` delegation entry.
      setup: async agentCtx => {
        installModelSelection(agentCtx, this.selectionRef)
        installAppendSystem(agentCtx)
        installSpawnToolFence(agentCtx)
      },
    })
  }

  /** The model selection shown in the footer (live value after `/model`). */
  getSelection(): ModelSelection | undefined {
    return this.selectionRef.current ?? this.selection
  }

  /** Apply a live model switch (`/model` selector outcome). */
  setSelection(next: ModelSelection): void {
    this.selectionRef.current = { ...next }
    this.selection = { ...next }
  }

  /** Set the agent preset for the next session creation. */
  setAgentPreset(presetId: string | undefined): void {
    this.agentPreset = presetId
  }

  /** Whether the current session has any turns (blank = preset can be changed). */
  isSessionBlank(): boolean {
    if (this.sessionId === undefined) return true
    const agent = this.getAgent()
    return agent === undefined || agent.session.events.length === 0
  }
}

/**
 * Persist the default model selection. Preferred path: the
 * `agent-default-model` service's `saveSelection`, the official API (a
 * settings.replace, last-write-wins). The namespace is read live by that
 * service — the change takes effect on the next lazy session creation
 * (`/new` or the next prompt) and survives restarts. Without the service,
 * fall back to a direct settings mutate (with one optimistic-concurrency
 * retry). Best-effort: a deployment without a settings provider is skipped
 * silently; a failed write returns its error message for the caller to
 * surface.
 * @returns undefined on success, the failure message otherwise.
 */
export async function persistDefaultModel(ctx: Context, selection: ModelSelection): Promise<string | undefined> {
  const service = ctx.get('agentDefaultModel') as
    | { saveSelection?: (next: ModelSelection) => unknown }
    | undefined
  if (service?.saveSelection !== undefined) {
    try {
      // The service API takes the whole selection and writes through
      // settings.replace (last-write-wins, no revision check). It may be
      // sync or async — awaiting covers both.
      await service.saveSelection(selection)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  const settings = ctx.get('settings')
  if (settings === undefined) return undefined
  const ns = settingsNamespace('agent-default-model')
  // The descriptor carries the namespace's revision (optimistic-concurrency
  // token for mutate) and proves the schema registration that validates the
  // field names below; the write itself rejects when the namespace is
  // unregistered (no descriptor either).
  const ops: SettingsPathOp[] = [
    { op: 'set', path: ['provider'], value: selection.provider },
    { op: 'set', path: ['model'], value: selection.model },
  ]
  if (selection.reasoningEffort === undefined) {
    // Unset so a stale override is dropped from the stored yaml document too.
    ops.push({ op: 'unset', path: ['reasoningEffort'] })
  } else {
    ops.push({ op: 'set', path: ['reasoningEffort'], value: selection.reasoningEffort })
  }
  // One retry after a concurrent writer moved the namespace (fresh revision);
  // a second conflict surfaces the raw error for the caller.
  for (let attempt = 0; ; attempt++) {
    const descriptor = settings.describe().find(d => d.ns === ns)
    try {
      await settings.mutate(ns, ops, descriptor?.revision)
      return undefined
    } catch (error) {
      if (attempt === 0 && error instanceof SettingsConflictError) continue
      return error instanceof Error ? error.message : String(error)
    }
  }
}

// Reload survival for the current session. `/reload` evicts this plugin's
// entire user-code module closure from the ESM/CJS caches, so module-level
// state does not survive — but the reload happens in the SAME dsh process, so
// process-global state does. These two helpers stash the current session id on
// `globalThis` before a reload tears this fiber down, and the freshly re-imported
// module consumes it in the new fiber so the TUI resumes the previously current
// session instead of lazily creating a fresh one on the next prompt. A real dsh
// process restart resets the stash, so a fresh start still lazily creates a new
// session. The stash is one-shot: `takeStashedSessionId` reads and deletes.

const LAST_SESSION_ID_KEY = Symbol.for('dsh-tui-pi.lastSessionId')

/**
 * Stash the current session id on the process-global store so a subsequent
 * hot-reload in the same process can resume it. Pass undefined to clear the
 * stash (no session current).
 */
export function stashSessionIdForReload(id: SessionId | undefined): void {
  const store = globalThis as Record<symbol, unknown>
  if (id === undefined) {
    delete store[LAST_SESSION_ID_KEY]
  } else {
    store[LAST_SESSION_ID_KEY] = String(id)
  }
}

/**
 * Consume (read-and-delete) a previously stashed session id, or undefined when
 * none was stashed. One-shot: a second call returns undefined.
 */
export function takeStashedSessionId(): SessionId | undefined {
  const store = globalThis as Record<symbol, unknown>
  const raw = store[LAST_SESSION_ID_KEY]
  delete store[LAST_SESSION_ID_KEY]
  return typeof raw === 'string' ? SessionId(raw) : undefined
}
