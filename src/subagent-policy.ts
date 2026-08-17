/**
 * Subagent policy for the TUI.
 *
 * Three knobs, all read live from the `dsh-tui` settings section at every
 * decision point — no watcher needed (the /settings browser hot-applies, so
 * the next guard execution / turn count reads the new value):
 * - `maxAgents` caps concurrent live children. A `tools.guard` registered on
 *   the plugin root ctx denies model-facing spawn tools once the bridge's
 *   live child count meets the cap. Registered globally, every agent in the
 *   process obeys — this TUI's session and any delegation nesting. The
 *   workflow/ralph fan-out bypasses the tool pipeline (its worker thread
 *   spawns through the subagent provider directly), so a `subagent/start`
 *   listener prunes any newcomer that slips past the guard.
 * - `registeredOnly` fences delegation to REGISTERED agents: the native
 *   ad-hoc spawn tools (subagent/subagent_fork/workflow/ralph) are denied
 *   for every agent, so children can only be minted through a registered
 *   definition (`~/.dsh/agents/*.md` via the registry's `use_agent`).
 *   Already-running fan-outs started before the toggle are left to finish.
 * - `maxRounds` caps a child's completed turns: on the bridge's `onTurnCount`
 *   the policy injects one plugin-sourced user message telling the child to
 *   wrap up. Queued as the child's next turn, it never interrupts work
 *   already underway.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { readSubagentLimits } from './theme-settings.ts'

/**
 * Tool names the maxAgents guard intercepts: the native subagent tool, the
 * one-shot fork variant, the workflow fan-out entrypoint, its ralph-loop
 * sibling, and registry plugins' `use_agent`.
 */
export const SPAWN_TOOLS: readonly string[] = [
  'subagent',
  'subagent_fork',
  'workflow',
  'ralph',
  'use_agent',
]

/**
 * The NATIVE ad-hoc spawn tools - everything in SPAWN_TOOLS except the
 * registry's `use_agent`. While `registeredOnly` is on, the guard denies
 * these for every agent in the process, so delegation can only go through a
 * registered agent definition (`~/.dsh/agents/*.md` via `use_agent`). The
 * deny-list (not an allow-list of one) is deliberate: it keeps working when
 * the registry's tool is renamed (`toolName` is configurable).
 */
export const NATIVE_SPAWN_TOOLS: readonly string[] = [
  'subagent',
  'subagent_fork',
  'workflow',
  'ralph',
]

/**
 * Hide the native ad-hoc spawn tools from ONE agent's tool catalog
 * (best-effort). The registeredOnly guard DENIES calls at execution; this
 * additionally makes the tools INVISIBLE to the model, so the agent sees a
 * single spawn entry (`use_agent`) and never attempts a fenced tool.
 *
 * `tools.restrict` requires a scoped context (it throws on a plain plugin
 * ctx) - the agent setup passes its scoped `agentCtx`, exactly the surface
 * dsh-subagent uses for `deep: 0` leaves. Best-effort by design: an absent
 * tools service, or a restrict failure (a named tool not loaded in this
 * profile, a transient registration race), degrades silently - the live
 * registeredOnly guard remains the enforcement backstop, so the fence is
 * NEVER weaker for hiding. Restriction is a creation-time snapshot: a
 * registeredOnly toggle takes effect for agents created afterwards (the
 * guard, being live, applies immediately in both directions).
 */
export function installSpawnToolFence(agentCtx: Context): void {
  const tools = agentCtx.get('tools') as { restrict?: (filter: { deny: readonly string[] }) => unknown } | undefined
  if (tools?.restrict === undefined) return
  try {
    tools.restrict({ deny: [...NATIVE_SPAWN_TOOLS] })
  } catch {
    // Cosmetic hide only - never fail the agent setup over it. The guard
    // below still denies the native spawn tools at execution time.
  }
}

/** Injected into a child that reached `maxRounds` — wrap up and report back. */
export const SUMMARY_MESSAGE: string = '总结和结束这个任务，汇报情况。'

/** The `subagent/start` payload's shape — the declaring package is not installed. */
interface SubagentStartInfo {
  /** The child session id, published before the event fires. */
  readonly id: SessionId
}

/** Structural view of the tool registry's guard hook (`@deepseek-ai/dsh-tools`). */
interface ToolsService {
  /** Register a global monotonic guard; the returned disposer unregisters it. */
  guard(execution: (exec: { readonly name: string }) => string | undefined): () => void
}

/** The policy's live backstop — the bridge's per-child accessors. */
export interface SubagentPolicyState {
  /** Current live (not settled) children — the count the `maxAgents` guard caps. */
  getLive(): readonly { childId: string; label: string }[]
  /** Completed turn count of one child (the "rounds" `maxRounds` caps). */
  getTurnCount(childId: string): number
  /** Whether one child already settled — a settled child is never re-awakened. */
  isSettled(childId: string): boolean
}

/** The running policy: the bridge's `onTurnCount` sink plus the teardown. */
export interface SubagentPolicy {
  /** Called by the bridge whenever one child completed a turn. */
  onTurnCount(childId: string, count: number): void
  /** Unwind the guard and event listeners. */
  dispose(): void
}

/**
 * Install the subagent policy on the plugin root ctx.
 *
 * @param ctx - plugin context. The settings-service lookup inside the helpers
 * is defensive: a settings-less deployment resolves the defaults, so the
 * policy still enforces its documented caps.
 * @param state - the host's live view (bridge.getLiveChildren /
 * bridge.getTurnCount). The guard and the round injection read it at every
 * decision — no snapshot, no watch.
 * @returns the policy handle wired to the bridge's `onTurnCount`.
 */
export function applySubagentPolicy(ctx: Context, state: SubagentPolicyState): SubagentPolicy {
  const disposers: Array<() => void> = []
  const injected = new Set<string>()

  // maxAgents guard: global (plugin root ctx), every spawn-tool call is
  // denied while live children are at the cap. Zero disables the guard.
  // The cap is approximate, not a hard admission lock: a burst of parallel
  // spawn calls can briefly overshoot before the bridge's firehose discovery
  // counts the newcomers — the subagent/start backstop below prunes the
  // overshoot, and the next spawn's guard reads the caught-up count.
  //
  // registeredOnly fence: the native ad-hoc spawn tools are denied outright
  // (checked before the cap — a roster violation is the reason even when the
  // cap would also deny). `use_agent` and every non-spawn tool pass through
  // to the cap check below.
  const tools = ctx.get('tools') as ToolsService | undefined
  if (tools?.guard !== undefined) {
    disposers.push(tools.guard((exec) => {
      if (!SPAWN_TOOLS.includes(exec.name)) return undefined
      if (readSubagentLimits(ctx).registeredOnly && NATIVE_SPAWN_TOOLS.includes(exec.name)) {
        return `Tool "${exec.name}" is disabled here: only registered agents are callable. `
          + 'Dispatch the work through the use_agent tool with one of the registered agent names instead.'
      }
      const maxAgents = readSubagentLimits(ctx).maxAgents
      if (maxAgents <= 0) return undefined
      const live = state.getLive()
      if (live.length < maxAgents) return undefined
      const running = live.map((agent) => agent.label).join(', ')
      return `Agent limit reached (${live.length}/${maxAgents}): ${running} still running — wait for one to finish or use list_agents before spawning more.`
    }))
  }

  // Workflow/ralph backstop: the worker thread fans children out through the
  // subagent provider, never through the tool pipeline — the only leak past
  // the guard. Prune a newcomer whose start overshoots the cap. The event is
  // foreign to this bundle's type environment (`@deepseek-ai/dsh-subagent` is
  // not installed), so the subscription rides the base event bus rather than
  // the typed `ctx.on`.
  const eventDisposer = ctx.events.on('subagent/start', (info: SubagentStartInfo) => {
    if (info?.id === undefined) return
    const maxAgents = readSubagentLimits(ctx).maxAgents
    if (maxAgents <= 0) return
    // Exclude the newcomer itself: whether or not its own session events
    // have reached the bridge's count yet (the subagent/start notification
    // and the child's first firehose event race), the child is pruned only
    // when the OTHER live children already fill the cap — a legitimate
    // Nth-at-cap child is never cancelled on either ordering.
    const live = state.getLive().filter(view => view.childId !== String(info.id))
    if (live.length < maxAgents) return
    ctx.agents.get(info.id)?.cancel({
      kind: 'hook',
      reason: 'over the dsh-tui maxAgents policy cap — prune a fan-out child',
    })
  })
  disposers.push(eventDisposer)

  /**
   * Bridge turn-count sink: inject the summary message exactly once per
   * child, at the first turn that reaches a positive `maxRounds`. A missing
   * agent (cold, or transiently unregistered) is skipped silently; a settled
   * child is skipped too — injecting into a finished one would wake it for a
   * pointless wrap-up round (continuable children that resume later get their
   * chance on the next counted turn). Repeated injections are impossible by
   * construction (the set is only written on success).
   */
  function onTurnCount(childId: string, count: number): void {
    if (injected.has(childId)) return
    const maxRounds = readSubagentLimits(ctx).maxRounds
    if (maxRounds <= 0) return
    if (count < maxRounds) return
    if (state.isSettled(childId)) return
    const agent = ctx.agents.get(SessionId(childId))
    if (agent === undefined) return
    injected.add(childId)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: SUMMARY_MESSAGE }],
      source: { kind: 'plugin', plugin: 'dsh-tui-pi' },
    }))
  }

  return {
    onTurnCount,
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* contained */ }
      }
    },
  }
}