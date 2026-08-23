/**
 * Subagent policy for the TUI.
 *
 * Three knobs, all read live from the `dsh-tui` settings section at every
 * decision point — no watcher needed (the /settings browser hot-applies, so
 * the next guard execution / turn count reads the new value):
 * - `maxAgents` caps concurrent live children. A `tools.guard` registered on
 *   the plugin root ctx denies model-facing spawn tools once the bridge's
 *   live child count meets the cap. The live-child COUNT covers every child
 *   in the process, but like `disableSubagent` the DENIAL is scoped to
 *   sessions this bridge created or resumed (`TUI_SURFACE_KEY`): unmarked
 *   callers fail open. The workflow/ralph fan-out bypasses the tool pipeline (its worker thread
 *   spawns through the subagent provider directly), so a `subagent/start`
 *   listener prunes any newcomer that slips past the guard.
 * - `disableSubagent` disables the plain native `subagent` tool: its calls
 *   are denied for every TUI session (and it is hidden from the main
 *   agent's catalog), so delegation goes through registered agent
 *   definitions (`~/.dsh/agents/*.md` via the registry's `use_agent`).
 *   `subagent_fork`, `workflow` and `ralph` stay available. Enforcement is
 *   scoped to sessions this bridge created or resumed (see
 *   `TUI_SURFACE_KEY`): the guard reads the calling agent's surface marker
 *   and FAILS OPEN for everything else, so a future web-profile deployment
 *   of this plugin never disables the native tool inside Web UI sessions.
 * - `maxRounds` caps a child's assistant messages (each LLM round-trip is
 *   one "round"): on the bridge's `onRoundCount` the policy injects one
 *   plugin-sourced user message telling the child to wrap up. Queued as the
 *   child's next turn, it never interrupts work already underway.
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
 * The native plain one-shot spawn tool - the only spawn tool `disableSubagent`
 * fences. Deliberately a single name: the TUI's user delegates through
 * registered agents (`~/.dsh/agents/*.md` via `use_agent`) and wants ONLY the
 * plain `subagent` tool off; `subagent_fork` (fork a running session),
 * `workflow` and `ralph` (fan-out loops) stay available.
 */
export const NATIVE_SPAWN_TOOLS: readonly string[] = [
  'subagent',
]

/**
 * Hide the plain `subagent` tool from ONE agent's tool catalog (best-effort).
 * The disableSubagent guard DENIES calls at execution; this additionally
 * makes the tool INVISIBLE to the model, so the agent sees the registered
 * `use_agent` as its delegation entry and never attempts the fenced tool.
 *
 * `tools.restrict` requires a scoped context (it throws on a plain plugin
 * ctx) - the agent setup passes its scoped `agentCtx`, exactly the surface
 * dsh-subagent uses for `deep: 0` leaves. Best-effort by design: an absent
 * tools service, or a restrict failure (an unknown tool name in this
 * profile, a transient registration race), degrades silently - the live
 * disableSubagent guard remains the enforcement backstop, so the fence is
 * NEVER weaker for hiding. Restriction is a creation-time snapshot: a
 * disableSubagent toggle takes effect for agents created afterwards (the
 * guard, being live, applies immediately in both directions).
 */
export function installSpawnToolFence(agentCtx: Context): void {
  const tools = agentCtx.get('tools') as { restrict?: (filter: { deny: readonly string[] }) => unknown } | undefined
  if (tools?.restrict === undefined) return
  try {
    tools.restrict({ deny: [...NATIVE_SPAWN_TOOLS] })
  } catch {
    // Cosmetic hide only - never fail the agent setup over it. The guard
    // below still denies the subagent tool at execution time.
  }
}

/**
 * Cordis context key marking an agent scope as owned by this TUI: set on the
 * bridge's `agentCtx` in BOTH session setups (create and resume — dsh runs
 * the setup callback on the resume path too), read by BOTH enforcement
 * branches of the global guard (the disableSubagent fence AND the maxAgents
 * cap). Session meta is NOT usable for this: dsh's
 * session store folds only its known header fields (`cwd`, `parentSession`,
 * `seedLength`, `origin`, `delegationDepth`, `agentPreset`) into the durable
 * `SessionHeader`, so any custom field would be silently dropped at create
 * AND absent on resume. An in-process scope marker survives neither concern:
 * it exists exactly while the TUI-owned agent lives, re-installed by every
 * resume setup, and never leaks into persistence or other processes.
 */
export const TUI_SURFACE_KEY = 'dshTuiSurface'

/**
 * Mark ONE agent scope as created/resumed by this TUI bridge. Call from the
 * bridge's agent setup; pairs with the guard's surface check below.
 *
 * Must be `provide`, never `set`: on a real cordis Context, `set` of a name
 * that was not provided first throws (`cannot set property ... without
 * provide`) — and this runs inside the session setups, where a throw rolls
 * back the whole session create/resume. `provide` defines the property on
 * the scope and reads back through plain `get` (regression-tested against a
 * real Context).
 */
export function markTuiSurface(agentCtx: Context): void {
  agentCtx.provide(TUI_SURFACE_KEY, true)
}

/**
 * Whether the agent a spawn-tool call runs on behalf of carries the TUI
 * surface marker. Defensive end to end: `exec.agent` may be undefined, lack
 * a ctx, or its get may throw (foreign service shapes) — anything but a
 * confirmed marker reads as NOT TUI-owned, so BOTH enforcement branches
 * (the disableSubagent denial and the maxAgents cap) fail open outside this
 * plugin's own sessions.
 */
function isTuiSurfaceAgent(agent: unknown): boolean {
  if (agent === null || typeof agent !== 'object') return false
  const ctx = (agent as { readonly ctx?: unknown }).ctx
  if (ctx === null || typeof ctx !== 'object' || typeof (ctx as { get?: unknown }).get !== 'function') return false
  try {
    return (ctx as { get(name: string): unknown }).get(TUI_SURFACE_KEY) === true
  } catch {
    return false
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
  guard(execution: (exec: { readonly name: string; readonly agent?: unknown }) => string | undefined): () => void
}

/** The policy's live backstop — the bridge's per-child accessors. */
export interface SubagentPolicyState {
  /** Current live (not settled) children — the count the `maxAgents` guard caps. */
  getLive(): readonly { childId: string; label: string }[]
  /** Assistant-message count of one child (the "rounds" `maxRounds` caps). */
  getRoundCount(childId: string): number
  /** Whether one child already settled — a settled child is never re-awakened. */
  isSettled(childId: string): boolean
}

/** The running policy: the bridge's `onRoundCount` sink plus the teardown. */
export interface SubagentPolicy {
  /** Called by the bridge whenever one child produced another assistant message. */
  onRoundCount(childId: string, count: number): void
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
 * bridge.getRoundCount). The guard and the round injection read it at every
 * decision — no snapshot, no watch.
 * @returns the policy handle wired to the bridge's `onRoundCount`.
 */
export function applySubagentPolicy(ctx: Context, state: SubagentPolicyState): SubagentPolicy {
  const disposers: Array<() => void> = []
  const injected = new Set<string>()
  /** Set by dispose: a pending deferred injection must not fire afterwards. */
  let disposed = false

  // maxAgents guard: the live-child count is global (the bridge counts every
  // child it discovers), but the DENIAL — like the disableSubagent fence —
  // only fires for agents this bridge created or resumed (the surface
  // marker; unmarked callers fail open). Zero disables the guard.
  // The cap is approximate, not a hard admission lock: a burst of parallel
  // spawn calls can briefly overshoot before the bridge's firehose discovery
  // counts the newcomers — the subagent/start backstop below prunes the
  // overshoot, and the next spawn's guard reads the caught-up count.
  //
  // disableSubagent fence: the plain native `subagent` tool is denied —
  // but ONLY for agents this bridge created or resumed (the surface marker
  // set by `markTuiSurface` in the session setups; checked before the cap -
  // a tool violation is the reason even when the cap would also deny).
  // Fail-open by design: an unmarked agent (a Web UI session in a shared
  // process, a foreign caller, an absent exec.agent) passes through to the
  // cap check below, so the fence never disables the native tool outside
  // the TUI's own sessions. `use_agent`, the fork/workflow/ralph variants
  // and every non-spawn tool pass through to the cap check too.
  //
  // maxAgents cap: SAME surface scoping as the fence — only a marked TUI
  // session's spawn calls are denied at the cap. The live-children COUNT is
  // still global (the bridge counts every child it discovers), but the
  // denial fires only for marked callers, so foreign sessions sharing this
  // process keep spawning freely while the TUI's own budget is enforced.
  const tools = ctx.get('tools') as ToolsService | undefined
  if (tools?.guard !== undefined) {
    disposers.push(tools.guard((exec) => {
      if (!SPAWN_TOOLS.includes(exec.name)) return undefined
      if (!isTuiSurfaceAgent(exec.agent)) return undefined
      if (readSubagentLimits(ctx).disableSubagent && NATIVE_SPAWN_TOOLS.includes(exec.name)) {
        return `Tool "subagent" is disabled here - delegation goes through registered agents. `
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
   * Bridge round-count sink: inject the summary message exactly once per
   * child, at the first message count that reaches a positive `maxRounds`. A
   * missing agent (cold, or transiently unregistered) is skipped silently; a
   * settled child is skipped too — injecting into a finished one would wake
   * it for a pointless wrap-up round (continuable children that resume later
   * get their chance on the next counted round). Repeated injections are
   * impossible by construction (the `injected` set is only written once per
   * child, and only after a successful followup) — including the wrap-up's
   * OWN assistant message, which pushes the count past `maxRounds` and must
   * not re-trigger.
   */
  function onRoundCount(childId: string, count: number): void {
    if (injected.has(childId)) return
    const maxRounds = readSubagentLimits(ctx).maxRounds
    if (maxRounds <= 0) return
    if (count < maxRounds) return
    if (state.isSettled(childId)) return
    const agent = ctx.agents.get(SessionId(childId))
    if (agent === undefined) return
    // Defer out of the caller's append publication window. onRoundCount runs
    // synchronously inside a child `session/event` observer; a followup here
    // splices the child's inbox, whose durable append reenters the append
    // that is being published right now and throws ("session append cannot
    // reenter...") — an error the contained observer dispatch swallows, so
    // the wrap-up would be lost. Do NOT switch to steer/inject instead: they
    // ride the same inbox splice → session.append path and hit the same
    // guard. A microtask runs once the stack unwinds, after the window's
    // finally block resets the flag.
    queueMicrotask(() => {
      if (disposed || injected.has(childId)) return
      // Re-check liveness at flush time: the child may have settled while
      // this task sat queued, or its agent may have been replaced or torn
      // down — never inject into a stale handle.
      if (ctx.agents.get(SessionId(childId)) !== agent || state.isSettled(childId)) return
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: SUMMARY_MESSAGE }],
          source: { kind: 'plugin', plugin: 'dsh-tui-pi' },
        }))
      } catch {
        // Leave `injected` unset: a failed attempt stays eligible, so the
        // next counted round retries instead of the cap being silently
        // abandoned for this child forever.
        return
      }
      injected.add(childId)
    })
  }

  return {
    onRoundCount,
    dispose() {
      disposed = true
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* contained */ }
      }
    },
  }
}