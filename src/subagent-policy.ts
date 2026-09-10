/**
 * Subagent policy for the TUI.
 *
 * Three knobs, all read live from the `dsh-tui` settings section at every
 * decision point — no watcher needed (the /settings browser hot-applies, so
 * the next guard execution / turn count reads the new value):
 * - `maxAgents` caps concurrent live children. A `tools.guard` registered on
 *   the plugin root ctx denies model-facing spawn tools once the EFFECTIVE
 *   child count meets the cap. The count is synchronous at the spawn
 *   decision: discovered live children plus an admission ledger of
 *   allowed-but-not-yet-discovered spawns, so a burst of parallel spawn
 *   calls inside one assistant message cannot overshoot while the bridge's
 *   firehose discovery catches up (each allowance enters the ledger the
 *   moment it is granted; each newly discovered child consumes one entry).
 *   The count covers every child in the process, but the DENIAL scope is
 *   "belongs to this TUI": a caller carrying the surface marker, or any
 *   live descendant of a marked root (the ancestor walk closes the
 *   host-created-children hole). Foreign roots fail open. A denial tells
 *   the model to record the task in its todo list and run it once a slot
 *   frees, instead of retrying the spawn. The workflow/ralph fan-out
 *   bypasses the tool pipeline (its worker thread spawns through the
 *   subagent provider directly), so a `subagent/start` listener prunes any
 *   newcomer that slips past the guard — same ownership scope, decided by
 *   the child's parent ancestry.
 * - `disableSubagent` disables the plain native `subagent` tool: its calls
 *   are denied for every TUI-scoped caller (and it is hidden from the main
 *   agent's catalog), so delegation goes through registered agent
 *   definitions (`~/.dsh/agents/*.md` via the registry's `use_agent`).
 *   `subagent_fork`, `workflow` and `ralph` stay available.
 * - `registeredOnly` is the wider fence: EVERY spawn tool except
 *   `use_agent` is denied for TUI-scoped callers, so no child can exist
 *   without a registered agent definition behind it (no ad-hoc
 *   "implement <task>" children). Default off; the fence is read live like
 *   every other knob.
 * - `maxRounds` caps a child's assistant messages (each LLM round-trip is
 *   one "round") through a TWO-STAGE ladder. Stage 1: at the cap — the
 *   per-agent tier when the child's label resolves to an agent .md
 *   `maxRounds` frontmatter key, else the global setting — the policy
 *   injects one plugin-sourced user message telling the child to wrap up
 *   (`steer()` while running, `followup()` when idle). Stage 2: after
 *   `maxRoundsGrace` further rounds, `state.cancelChild` force-stops the
 *   run — code, not persuasion; a one-shot run settles `aborted` with its
 *   partial output in the parent's tool result, a continuable child's
 *   session and inbox survive for resume. `grace: 0` collapses the ladder
 *   to the historical warn-only behavior. Every injection carries a `⚡`
 *   marker in the compact line and the subagent viewer; every hard stop is
 *   reported to the bridge for the `⏻` marker — an ignored wrap-up is
 *   visible, and so is its enforcement.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { readSubagentLimits } from './theme-settings.ts'
import type { SteerableAgent } from './subagent-viewer.ts'

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

/** Structural slice of a session header the ancestor walk reads. */
interface HeaderSlice {
  readonly parentSession?: unknown
}

/** Structural slice of a live agent the ancestor walk reads. */
interface WalkableAgent {
  readonly session?: { readonly header?: HeaderSlice }
}

/**
 * The id string of one live agent, when it exposes one.
 */

/**
 * Whether the caller belongs to THIS TUI, directly (a surface-marked scope)
 * or through descent from a marked root — the ancestor walk.
 *
 * The marker is only provided on the session setups the TUI itself runs
 * (create and resume): child agents are created by the HOST's subagent
 * materialization, whose setup is fixed and carries no marker, so a child
 * delegating further (a `deep >= 1` agent spawning grandchildren, or any
 * spawn tool call made from inside a child) read as unmarked and failed
 * open. The walk closes that hole along live parentage: starting from the
 * caller's `session.header.parentSession`, it steps through the in-process
 * agent registry (`ctx.agents.get`) and checks each ancestor for the
 * marker.
 *
 * Bounded and defensive: at most {@link ANCESTOR_WALK_MAX_DEPTH} hops
 * (real delegation chains are shallow — dsh's own native `maxDepth` default
 * is 3), a visited set guards against corrupt/cyclic headers, and every
 * structural read is try-guarded. Any miss (absent parent header, a parent
 * not live in this process, a thrown registry access) terminates the walk
 * as NOT TUI-owned — fail-open preserved for foreign roots (a feishu-created
 * session and its subtree never became enforceable here).
 */
function callerBelongsToTui(ctx: Context, agent: unknown): boolean {
  if (isTuiSurfaceAgent(agent)) return true
  // The walk needs the caller's session header; read it defensively.
  let header: HeaderSlice | undefined
  try {
    header = (agent as WalkableAgent | undefined)?.session?.header
  } catch {
    return false
  }
  const visited = new Set<string>()
  let parentId = header?.parentSession
  for (let depth = 0; depth < ANCESTOR_WALK_MAX_DEPTH && parentId !== undefined; depth += 1) {
    const key = String(parentId)
    if (visited.has(key)) return false
    visited.add(key)
    let ancestor: WalkableAgent | undefined
    try {
      ancestor = ctx.agents.get(SessionId(parentId as string)) as WalkableAgent | undefined
    } catch {
      return false
    }
    if (ancestor === undefined) return false
    if (isTuiSurfaceAgent(ancestor)) return true
    // Step up: the ancestor's own header (its parentSession is another
    // agent's session id), never the caller's again — the visited set makes
    // that case unreachable anyway.
    let next: unknown
    try {
      next = ancestor.session?.header?.parentSession
    } catch {
      return false
    }
    if (next === undefined || String(next) === key) return false
    parentId = next
  }
  return false
}

/** Walk depth cap: dsh's native depth default is 3; 4 hops cover it with room. */
const ANCESTOR_WALK_MAX_DEPTH = 4

/**
 * How long an allowed-but-never-discovered admission may hold its slot.
 * Discovery normally lands within one bridge reconcile tick (600ms); the
 * TTL only releases the slot of a spawn that errored after the guard
 * allowed it, so one failed spawn cannot shrink the budget forever.
 */
const INFLIGHT_TTL_MS = 30_000

/** Credited-id slack over the live board before stale ids are pruned. */
const CREDITED_SLACK = 64

/**
 * The wrap-up message injected into a child that reached `maxRounds`.
 * English and directive on purpose: it is a policy instruction to the child
 * LLM, and a soft "please summarize" (the earlier one-line Chinese request)
 * was routinely ignored while the child kept calling tools. It names the
 * limit, forbids further tool calls, and demands a final-answer summary —
 * and, with a positive grace window, warns that the run is force-stopped
 * if the summary does not land within it.
 */
export function wrapupMessage(maxRounds: number, grace: number): string {
  const base = `Round limit reached (${maxRounds} LLM round-trips, set by the dsh-tui maxRounds policy). `
    + 'Do NOT call any more tools. Finish this task NOW: summarize what you have accomplished so far, '
    + 'state clearly what remains undone, and return that summary as your final answer.'
  return grace > 0
    ? `${base} You have ${grace} more round${grace === 1 ? '' : 's'} before this run is force-stopped.`
    : base
}

/**
 * One child's cap resolution, cached at the first cap crossing: the
 * effective round cap and the grace window that follows the wrap-up.
 */
interface ResolvedCaps {
  readonly cap: number
  readonly grace: number
}

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
  /**
   * Forcibly stop one live child (the everything-stop's per-child idiom,
   * `cancel({kind:'user'}, {keepInbox:true})`): a one-shot run settles
   * `aborted` (the parent's tool call reports the cancellation with the
   * partial output), a continuable child's run stops while its session and
   * inbox survive for later resume. `false` when nothing live was found.
   */
  cancelChild(childId: string): boolean
}

/**
 * A hard stop the policy executed on one child, surfaced through the policy
 * handle for the bridge to fold into the child's view (the `⏻` marker).
 */
export interface HardStopRecord {
  /** The child session id the stop was issued to. */
  readonly childId: string
  /** Round count at which the stop fired (`cap + grace`). */
  readonly round: number
  /** The cap that was exceeded (per-agent when one resolved, else global). */
  readonly cap: number
  /** The grace window that was exhausted. */
  readonly grace: number
}

/**
 * Cumulative subagent-runtime counters since the policy was installed (this
 * TUI process), served to the model through the `subagent_status` tool and
 * to the operator through the /agents limits panel.
 */
export interface SubagentPolicyStats {
  /** Children currently on the bridge's live board (settled excluded). */
  live: number
  /** Spawn-tool calls the guard admitted. */
  allowed: number
  /** Spawn-tool calls denied at the `maxAgents` cap. */
  denied: number
  /** Fan-out children pruned by the `subagent/start` backstop. */
  pruned: number
  /** Allowed-but-undiscovered spawns currently holding an admission slot. */
  inFlight: number
}

/** The running policy: the bridge's `onRoundCount` sink plus the teardown. */
export interface SubagentPolicy {
  /** Called by the bridge whenever one child produced another assistant message. */
  onRoundCount(childId: string, count: number): void
  /**
   * Report sink for hard stops: wired by the host to the bridge's fold so a
   * force-stopped child shows its `⏻` marker everywhere the view renders.
   */
  onHardStop?(record: HardStopRecord): void
  /** Snapshot of the runtime counters (live / allowed / denied / pruned / inFlight). */
  getStats(): SubagentPolicyStats
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
 * bridge.getRoundCount). The guard and the round ladder read it at every
 * decision — no snapshot, no watch.
 * @param resolveAgentCap - the per-agent round cap lookup (agent .md
 * frontmatter `maxRounds` via the registry contract). `undefined`/throwing
 * resolutions fall back to the global cap, never widen it. Omitted = the
 * global cap always applies.
 * @returns the policy handle wired to the bridge's `onRoundCount`.
 */
export function applySubagentPolicy(
  ctx: Context,
  state: SubagentPolicyState,
  resolveAgentCap?: (label: string) => number | undefined,
): SubagentPolicy {
  const disposers: Array<() => void> = []
  const injected = new Set<string>()
  /** Set by dispose: a pending deferred injection must not fire afterwards. */
  let disposed = false

  // ---- synchronous admission ledger -------------------------------------
  //
  // The maxAgents admission decision must not depend on discovery timing.
  // Every allowance is recorded here the moment it is granted; every child
  // the bridge later discovers consumes exactly one record (it is then
  // counted in `live` directly). The next guard execution therefore always
  // reads `live.length + inFlight.length`, so a burst of parallel spawn
  // calls inside ONE assistant message sees itself: with cap 2 the calls
  // read 0+0, 0+1, then deny at 0+2 — never six "Started" results.
  const stats: SubagentPolicyStats = { live: 0, allowed: 0, denied: 0, pruned: 0, inFlight: 0 }
  /** Live child ids already folded into the ledger (each consumed one in-flight). */
  const creditedIds = new Set<string>()
  /** Admission timestamps of allowed spawns not yet discovered in `getLive()`. */
  const inFlightAt: number[] = []

  /**
   * Fold the bridge's current live board into the admission ledger and
   * return the effective child count the `maxAgents` cap compares against:
   * discovered children plus allowed-but-undiscovered admissions.
   *
   * Each live child absent from `creditedIds` is a fresh discovery and
   * consumes exactly one in-flight entry. A child the guard never admitted
   * (workflow/ralph provider spawns, foreign surfaces) consumes a phantom
   * entry at worst — shifting an empty list is a no-op — which can only
   * make the estimate MORE conservative, never higher. Entries older than
   * {@link INFLIGHT_TTL_MS} expire so a spawn that failed after the guard
   * allowed it releases its slot instead of holding it forever.
   */
  function reconcileAdmission(live: readonly { readonly childId: string }[]): number {
    let discovered = 0
    for (const view of live) {
      const id = view.childId
      if (typeof id !== 'string' || id === '') continue
      if (!creditedIds.has(id)) {
        creditedIds.add(id)
        discovered += 1
      }
    }
    for (let i = 0; i < discovered; i += 1) inFlightAt.shift()
    const now = Date.now()
    while (inFlightAt.length > 0 && now - inFlightAt[0] > INFLIGHT_TTL_MS) inFlightAt.shift()
    if (creditedIds.size > live.length + CREDITED_SLACK) {
      const liveIds = new Set(live.map(view => view.childId))
      for (const id of creditedIds) {
        if (!liveIds.has(id)) creditedIds.delete(id)
      }
    }
    stats.inFlight = inFlightAt.length
    stats.live = live.length
    return live.length + inFlightAt.length
  }

  // maxAgents guard: the effective child count is global (the bridge counts
  // every child it discovers; the admission ledger adds the
  // allowed-but-undiscovered spawns so a same-step burst cannot overshoot),
  // but the DENIAL — like the disableSubagent fence — only fires for agents
  // this bridge created or resumed (the surface marker; unmarked callers
  // fail open). Zero disables the guard. The subagent/start backstop below
  // still covers the workflow/ralph provider path, which never reaches this
  // guard at all.
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
      // Enforcement scope: the caller carries the surface marker OR descends
      // from a marked root (the ancestor walk closes the child-delegation
      // hole — host-created children carry no marker of their own). Foreign
      // roots still fail open.
      if (!callerBelongsToTui(ctx, exec.agent)) return undefined
      // registeredOnly fence: EVERY spawn tool except the registry's
      // use_agent is denied — a child may only ever be backed by a
      // registered agent definition (~/.dsh/agents/*.md). Stricter than the
      // disableSubagent fence: subagent_fork/workflow/ralph are fenced too,
      // so the model cannot sidestep the roster with ad-hoc or forked
      // spawns (the "实现 <task description>" label shape is exactly the
      // leak this closes).
      if (readSubagentLimits(ctx).registeredOnly && exec.name !== 'use_agent') {
        return `Ad-hoc subagents are disabled here — the "${exec.name}" tool is not available. `
          + 'Delegation goes through the use_agent tool with one of the REGISTERED agent names '
          + '(~/.dsh/agents/*.md) only — it covers the same ground: background:true for a durable '
          + 'background child, resume/fresh for continuation, parallel use_agent calls for fan-out. '
          + 'If no registered agent fits this task, do it yourself or record it with todo_write and '
          + 'surface it to the operator.'
      }
      if (readSubagentLimits(ctx).disableSubagent && NATIVE_SPAWN_TOOLS.includes(exec.name)) {
        return `Tool "subagent" is disabled here - delegation goes through registered agents. `
          + 'Dispatch the work through the use_agent tool with one of the registered agent names instead.'
      }
      const maxAgents = readSubagentLimits(ctx).maxAgents
      if (maxAgents <= 0) return undefined
      const live = state.getLive()
      // SYNCHRONOUS admission: the effective count folds in the ledger of
      // spawns this guard already allowed but the bridge has not discovered
      // yet — the burst window that let six parallel use_agent calls through
      // a cap of two (2026-09-10 session 9c777e88).
      const effective = reconcileAdmission(live)
      if (effective < maxAgents) {
        inFlightAt.push(Date.now())
        stats.allowed += 1
        return undefined
      }
      stats.denied += 1
      const running = live.map((agent) => agent.label).join(', ')
      return `Agent limit reached (${effective}/${maxAgents}): ${running} still running — do NOT retry the spawn now. `
        + 'Call subagent_status for the live board, record this task in the todo list (todo_write, status pending), '
        + 'and execute it after a running agent finishes and frees a slot.'
    }))
  }

  // Workflow/ralph backstop: the worker thread fans children out through the
  // subagent provider, never through the tool pipeline — the only leak past
  // the guard. Prune a newcomer whose start overshoots the cap. The event is
  // foreign to this bundle's type environment (`@deepseek-ai/dsh-subagent` is
  // not installed), so the subscription rides the base event bus rather than
  // the typed `ctx.on`.
  //
  // Scope: the event payload names only the child, no caller, so TUI
  // ownership is decided by the child's own ancestry — a child whose live
  // parent chain roots at a marked TUI session is prunable; a foreign root
  // (feishu, web) never is. The walk runs on the child's PARENT, which is
  // exactly the surface the guard caller would have been — one hop saved.
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
    // Ownership check AFTER the cheap count gate: only an overshooting
    // newcomer whose tree roots here gets cancelled.
    const child = ctx.agents.get(info.id) as WalkableAgent | undefined
    const parentSession = child?.session?.header?.parentSession
    const parent = typeof parentSession !== 'string' || parentSession === ''
      ? undefined
      : (ctx.agents.get(SessionId(parentSession)) as WalkableAgent | undefined)
    if (parent === undefined || !callerBelongsToTui(ctx, parent)) return
    const newcomerAgent = ctx.agents.get(info.id)
    if (newcomerAgent === undefined) return
    stats.pruned += 1
    newcomerAgent.cancel({
      kind: 'hook',
      reason: 'over the dsh-tui maxAgents policy cap — prune a fan-out child',
    })
  })
  disposers.push(eventDisposer)

  /**
   * Bridge round-count sink, driving the two-stage ladder:
   *
   * Stage 1 — wrap-up injection at the first count reaching the cap
   * (per-agent when one resolves for this child's label, else the global
   * `maxRounds`): exactly one plugin-sourced message telling the child to
   * finish now. Most children comply here; the ladder ends for them.
   *
   * Stage 2 — hard stop at `cap + grace` when the child kept burning rounds
   * past the wrap-up: `state.cancelChild` force-stops the run (code, not
   * persuasion), the stop is reported through `onHardStop` for the `⏻`
   * marker, and the child's stage state is cleared (a continuable child
   * resumed later re-enters the ladder at its next counted round).
   *
   * `grace: 0` collapses the ladder to stage 1 only — the historical
   * pure-soft behavior.
   *
   * Delivery is ROUTED by the child's live status (the same split the Ctrl+G
   * steer flow uses): a RUNNING child takes `steer()` — consumed at the next
   * STEP boundary, i.e. the very next LLM round-trip — while `followup()`
   * would queue a whole next TURN and the child could burn many more rounds
   * inside the current turn before seeing the wrap-up (the original bug: the
   * cap visibly never bit). An idle-but-unsettled child takes `followup()`
   * (its own ordinary turn).
   */
  function onRoundCount(childId: string, count: number): void {
    if (disposed) return
    const label = state.getLive().find(view => view.childId === childId)?.label
      ?? injectedLabel.get(childId)
    const caps = resolveCaps(childId, label)
    if (caps === undefined) return
    const { cap, grace } = caps
    if (count < cap) return
    // Stage 2: grace exhausted past a delivered wrap-up — force-stop.
    if (injected.has(childId)) {
      if (grace <= 0) return // pure-soft mode: warn only, never stop
      if (count < cap + grace) return
      // Already stopped for this stage (the stop's own settlement events
      // can re-enter onRoundCount before the view settles): no-op.
      if (hardStopped.has(childId)) return
      if (state.isSettled(childId)) return // self-completed in time: leave it
      hardStopped.add(childId)
      const stopped = state.cancelChild(childId)
      if (stopped) {
        try {
          onHardStopSink?.({ childId, round: count, cap, grace })
        } catch {
          // A reporting failure must not touch the stop itself.
        }
      } else {
        // Nothing live to stop (a raced settle/vanished handle) — keep the
        // stage marker so later counts of the same ladder cannot re-arm.
      }
      return
    }
    // Stage 1 gate order: settle check BEFORE agent lookup (a finished child
    // must not be woken for a pointless wrap-up), agent lookup before the
    // defer (a missing handle is skipped silently — cold or transiently
    // unregistered).
    if (state.isSettled(childId)) return
    const agent = ctx.agents.get(SessionId(childId)) as SteerableAgent | undefined
    if (agent === undefined) return
    // Defer out of the caller's append publication window. onRoundCount runs
    // synchronously inside a child `session/event` observer; a steer/followup
    // here splices the child's inbox, whose durable append reenters the append
    // that is being published right now and throws ("session append cannot
    // reenter...") — an error the contained observer dispatch swallows, so
    // the wrap-up would be lost. Do NOT switch to inject instead: it rides
    // the same inbox splice → session.append path and hits the same guard. A
    // microtask runs once the stack unwinds, after the window's finally block
    // resets the flag.
    queueMicrotask(() => {
      if (disposed || injected.has(childId)) return
      // Re-check liveness at flush time: the child may have settled while
      // this task sat queued, or its agent may have been replaced or torn
      // down — never inject into a stale handle.
      if (ctx.agents.get(SessionId(childId)) !== agent || state.isSettled(childId)) return
      try {
        const message = createUserMessage({
          content: [{ type: 'text', text: wrapupMessage(cap, grace) }],
          source: { kind: 'plugin', plugin: 'dsh-tui-pi' },
        })
        if (agent.status === 'running') agent.steer(message)
        else agent.followup(message)
      } catch {
        // Leave `injected` unset: a failed attempt stays eligible, so the
        // next counted round retries instead of the cap being silently
        // abandoned for this child forever.
        return
      }
      injected.add(childId)
      // Remember the label the cap was resolved from: stage 2 counts arrive
      // after the child may have dropped off the live board.
      if (label !== undefined) injectedLabel.set(childId, label)
    })
  }

  /** Per-child resolved caps, frozen at the first crossing (stage 1 or 2). */
  const resolvedCaps = new Map<string, ResolvedCaps>()
  /** Labels remembered at wrap-up time, for stage-2 resolution after settle-off. */
  const injectedLabel = new Map<string, string>()
  /** Children whose stage-2 hard stop already fired (or found nothing to stop). */
  const hardStopped = new Set<string>()
  /** Optional host sink for hard-stop records (the `⏻` marker fold). */
  let onHardStopSink: ((record: HardStopRecord) => void) | undefined

  /**
   * Resolve one child's effective caps. Per-agent first (the label→cap
   * lookup through the registry contract — an agent without a frontmatter
   * `maxRounds`, an ambiguous display name, or any lookup failure falls
   * back to the global cap), grace always from the live settings. Resolved
   * once per child and cached: the ladder's stage 2 must not shift its cap
   * mid-flight (a settings edit mid-run would otherwise move the goalposts
   * between warn and stop).
   */
  function resolveCaps(childId: string, label: string | undefined): ResolvedCaps | undefined {
    const cached = resolvedCaps.get(childId)
    if (cached !== undefined) return cached
    const limits = readSubagentLimits(ctx)
    const globalCap = limits.maxRounds
    if (globalCap <= 0) return undefined
    let cap = globalCap
    if (label !== undefined && resolveAgentCap !== undefined) {
      try {
        const perAgent = resolveAgentCap(label)
        if (perAgent !== undefined && perAgent > 0) cap = perAgent
      } catch {
        // A throwing lookup is a global-cap lookup.
      }
    }
    const caps: ResolvedCaps = { cap, grace: limits.maxRoundsGrace }
    resolvedCaps.set(childId, caps)
    return caps
  }

  return {
    onRoundCount,
    get onHardStop(): ((record: HardStopRecord) => void) | undefined {
      return onHardStopSink
    },
    set onHardStop(sink: ((record: HardStopRecord) => void) | undefined) {
      onHardStopSink = sink
    },
    getStats(): SubagentPolicyStats {
      return {
        ...stats,
        live: state.getLive().length,
        inFlight: inFlightAt.length,
      }
    },
    dispose() {
      disposed = true
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* contained */ }
      }
    },
  }
}