/**
 * Local structural types for session events whose declaring packages
 * (`@deepseek-ai/dsh-tool-workflow`, `@deepseek-ai/dsh-subagent`,
 * `@deepseek-ai/dsh-llm-retry`) are not installed in this plugin. The TUI
 * receives these events on the `session/event` firehose regardless (the
 * firehose is not scope-filtered — see dsh-scope's generated subject
 * resolvers), so the bridge folds them through these minimal, dependency-free
 * shapes instead of importing the augmenting packages.
 *
 * `SessionEvent` is a closed discriminated union over the core event map, so
 * `switch (event.type)` falls through these types; the guards narrow them
 * explicitly.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

// The declaring packages normally extend `SessionEventMap` with their event
// types via module augmentation, which is what makes `SessionEvent`'s
// discriminated union include them. Those packages are not installed in this
// plugin's type environment, so merge the four foreign event types into the
// core map ourselves — otherwise the guards below would narrow to `never`
// (the union has no member with these `type` literals) and every call site
// would see a dead branch. Adding members to the union is inert for
// `switch (event.type)` consumers: existing cases stay, unknown types fall to
// `default`.
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'tool-workflow/agent-start': ToolWorkflowAgentStartData
    'tool-workflow/agent-end': ToolWorkflowAgentEndData
    'subagent/descriptor': SubagentDescriptorData
    'llm/retry': LlmRetryData
  }
}

/** `tool-workflow/agent-start`: one workflow member, after its child Session is published. */
export interface ToolWorkflowAgentStartData {
  readonly runId: string
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly childId: string
}

/** `tool-workflow/agent-end`: one workflow member settlement. */
export interface ToolWorkflowAgentEndData {
  readonly runId: string
  readonly seq: number
  readonly outcome: 'completed' | 'failed' | 'cancelled'
}

/** `subagent/descriptor`: durable identity of a session-backed subagent child. */
export interface SubagentDescriptorData {
  readonly version: number
  readonly mode: 'one-shot' | 'continuable'
  readonly provider: string
  readonly label?: string
}

/** `llm/retry`: one provider-routed retry scheduled after a failed request attempt. */
export interface LlmRetryData {
  readonly retry: number
  /** Absent for the `mode: 'always'` arm of the real event. */
  readonly maxRetries?: number
}

/** Type guard for `tool-workflow/agent-start` events. */
export function isAgentStart(event: SessionEvent): event is SessionEvent & { type: 'tool-workflow/agent-start'; data: ToolWorkflowAgentStartData } {
  return event.type === 'tool-workflow/agent-start'
}

/** Type guard for `tool-workflow/agent-end` events. */
export function isAgentEnd(event: SessionEvent): event is SessionEvent & { type: 'tool-workflow/agent-end'; data: ToolWorkflowAgentEndData } {
  return event.type === 'tool-workflow/agent-end'
}

/** Type guard for `subagent/descriptor` events (written to the CHILD session's log). */
export function isSubagentDescriptor(event: SessionEvent): event is SessionEvent & { type: 'subagent/descriptor'; data: SubagentDescriptorData } {
  return event.type === 'subagent/descriptor'
}

/** Type guard for `llm/retry` events. */
export function isLlmRetry(event: SessionEvent): event is SessionEvent & { type: 'llm/retry'; data: LlmRetryData } {
  return event.type === 'llm/retry'
}

/**
 * One live subagent row the TUI renders: the bridge's per-child fold of
 * workflow events (parent log) and the child's own session events. Children
 * are keyed by their session id — discovered either from
 * `tool-workflow/agent-start` or, when the deployment never emits workflow
 * events, from the child session's header (`origin: 'subagent'` +
 * `parentSession`). All fields are O(1)-maintained — never a session-log
 * scan on the render path.
 */
export interface AgentView {
  /** The child session id (raw string) — the stable identity key. */
  readonly childId: string
  /** The delegating parent session id, when known (header discovery). */
  readonly parentSession?: string
  /** Delegation mode from the child's `subagent/descriptor`, when known. */
  readonly mode?: 'one-shot' | 'continuable'
  /** Subagent type name from the child's `subagent/descriptor.provider`, when known. */
  readonly provider?: string
  /** Delegation label from `tool-workflow/agent-start` or the child's descriptor. */
  readonly label: string
  /** Unix epoch ms when the child was first observed — the elapsed baseline. */
  readonly startedAt: number
  /**
   * Settled marker: set by `tool-workflow/agent-end` (real outcome) or,
   * for header-discovered children, best-effort on the child's `turn/end`.
   * A settled child drops off the live board (clear-when-done).
   */
  readonly outcome?: 'completed' | 'failed' | 'cancelled'
  /** Unix epoch ms of the settle event, when settled. */
  readonly endedAt?: number
  /** Cumulative tokens: input + output + cacheRead + cacheWrite. */
  readonly tokens: number
  /**
   * Current context occupancy estimate — the `X` in the compact line's
   * `X/Y`: the child's latest assistant/message billed input + output plus a
   * CJK estimate of messages appended after it. NOT the cumulative `tokens`
   * (that total only grows and stays the viewer/session-panel spend): this
   * tracks the child's current context so the display follows the latest
   * request and drops after a compaction. Before the first assistant/message
   * it is the pending estimate alone.
   */
  readonly contextTokens: number
  /**
   * Assistant-message count — one per LLM round-trip, i.e. the child's
   * "rounds" the compact line shows against the policy cap. Maintained O(1)
   * on the child's own `assistant/message` events (NOT `turn/end`): a
   * one-shot child spends its whole life in a single turn, so turns never
   * progress while the child works — messages do.
   */
  readonly rounds: number
  /** Latest `llm/retry` attempt number (0 = none retried). */
  readonly retries: number
  /** Latest `llm/retry` maxRetries, when the policy reported one. */
  readonly maxRetries?: number
  /** Last tool name the child invoked (the activity line), when any. */
  readonly lastTool?: string
  /** Context window from the child's `request/context`, for the % column. */
  readonly contextWindow?: number
  /**
   * Latest visible last line of the child's own CONTENT output (the tail the
   * compact activity row shows so the user knows it is alive). Maintained
   * O(1) as child events arrive: streaming chunks (text AND reasoning
   * deltas, through a bounded per-child buffer) → their last non-blank line,
   * `assistant/message` → the authoritative last text line, `llm/retry` →
   * `↻ retry`. Tool invocations never overwrite it — the row shows the
   * child's output, not tool names. ANSI-stripped and whitespace-folded;
   * absent when the child has produced no such output yet.
   */
  readonly lastLine?: string
}
