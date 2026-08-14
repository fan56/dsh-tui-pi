/**
 * Session bridge between the dsh tree and the TUI.
 *
 * Responsibilities:
 * - lazy agent creation on first prompt (openma runner pattern)
 * - prompt delivery via agent.followup()
 * - session-event subscription filtered to the bridge's session
 * - O(1) incremental stats maintained as events arrive (footer reads these —
 *   never re-scans the session log, per the pi-turbo findings)
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'

export interface BridgeCallbacks {
  /** One session-log event for the bridge's session, in log order. */
  onEvent(event: SessionEvent): void
  /** Whole-agent lifecycle transition. */
  onStatus(status: 'idle' | 'running'): void
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
  /** Cache-hit rate of the latest assistant message with usage, when known. */
  latestCacheHitRate?: number
}

export class DshSessionBridge {
  private readonly ctx: Context
  private readonly callbacks: BridgeCallbacks
  private handle: AgentHandle | undefined
  private creating: Promise<AgentHandle> | undefined
  private readonly disposers: Array<() => void> = []
  private sessionId: SessionId | undefined
  private selection: ModelSelection | undefined
  /** Mutable live selection installed into the agent; `/model` mutates `current`. */
  private readonly selectionRef: ModelSelectionRef = { current: undefined, assembled: undefined }
  private readonly stats: BridgeStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    msgCount: 0,
    toolCallCount: 0,
  }

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
      if (this.sessionId === undefined || session.id !== this.sessionId) return
      this.applyEvent(event)
      this.callbacks.onEvent(event)
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }: { agent: { id: string }; status: 'idle' | 'running' }) => {
      if (this.handle === undefined || agent.id !== this.handle.agent.id) return
      this.callbacks.onStatus(status)
    }))
  }

  /** Snapshot of the incremental stats (footer reads this O(1)). */
  getStats(): BridgeStats {
    return { ...this.stats }
  }

  /** Current session id, when one exists. */
  getSessionId(): SessionId | undefined {
    return this.sessionId
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

  /** Dispose the live agent (if any) and stop event subscriptions. */
  async dispose(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) {
      try { dispose() } catch { /* contained */ }
    }
    const handle = this.handle
    this.handle = undefined
    this.sessionId = undefined
    if (handle !== undefined) await handle.dispose()
  }

  /** Update incremental stats from one event — one pass over the event only. */
  private applyEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'user/message':
        this.stats.msgCount += 1
        break
      case 'assistant/message': {
        this.stats.msgCount += 1
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') this.stats.toolCallCount += 1
        }
        const usage: TokenUsage | undefined = event.data.usage
        if (usage === undefined) break
        this.stats.inputTokens += usage.inputTokens
        this.stats.outputTokens += usage.outputTokens
        this.stats.cacheReadTokens += usage.cacheReadTokens ?? 0
        this.stats.cacheWriteTokens += usage.cacheWriteTokens ?? 0
        const promptTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        this.stats.latestCacheHitRate = promptTokens > 0
          ? ((usage.cacheReadTokens ?? 0) / promptTokens) * 100
          : undefined
        break
      }
      default:
        break
    }
  }

  private async ensureSession(): Promise<AgentHandle> {
    if (this.handle !== undefined) return this.handle
    if (this.creating !== undefined) return this.creating
    const creation = this.createSession()
    this.creating = creation
    try {
      this.handle = await creation
      this.sessionId = this.handle.agent.session.id
      return this.handle
    } finally {
      this.creating = undefined
    }
  }

  /** Create the agent with the composed default model selection. */
  private async createSession(): Promise<AgentHandle> {
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
    return this.ctx.agents.create({
      sessionId: SessionId(crypto.randomUUID()),
      meta: { cwd: process.cwd() },
      agentOptions: this.selection ?? {},
      // Install the mutable selection so `/model` can live-switch the route.
      setup: async agentCtx => {
        installModelSelection(agentCtx, this.selectionRef)
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
}
