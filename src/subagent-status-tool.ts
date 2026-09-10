/**
 * The `subagent_status` model-facing tool: a read-only live board of this
 * TUI's subagent runtime, served straight from the bridge's real-time views
 * and the policy's admission counters.
 *
 * Why a tool: the runtime state already exists in-process (the bridge folds
 * every child's firehose events and reconciles against the host's
 * authoritative descendant listing every 600ms), but before this tool the
 * model had no cheap way to READ it — it had to probe the spawn tool and
 * read denial strings, or re-derive state from transcripts. One call here
 * returns the whole board: cap headroom, per-child progress (rounds,
 * tokens, context, last tool), the recent settles, and the admission
 * counters (admitted / denied / pruned / in-flight). The maxAgents denial
 * message points here, so the reject → check → todo_write → retry-later
 * loop needs no other discovery.
 *
 * Read-only by design: steering and stopping stay on the human surfaces
 * (Ctrl+G viewer, stop-everything dialog) — the model observing the board
 * can plan around it but cannot reach through it.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentView } from './dsh-events.ts'
import type { SubagentPolicyStats } from './subagent-policy.ts'
import { readSubagentLimits } from './theme-settings.ts'

/** The global tool name — deliberately NOT in SPAWN_TOOLS: this spawns nothing. */
export const SUBAGENT_STATUS_TOOL_NAME = 'subagent_status'

/** How many settled rows the board shows after the live rows (most recent first). */
const SETTLED_ROWS = 8

/**
 * Where the board reads from: the bridge's real-time views and the policy's
 * admission counters. Both are plain synchronous reads — the runtime state
 * is maintained continuously, never computed on demand.
 */
export interface SubagentRuntimeSource {
  /** The bridge's child views (live and recently settled). */
  views(): readonly AgentView[]
  /** The policy's admission counters. */
  stats(): SubagentPolicyStats
}

/** Structural slice of the tool registry's registration hook (`@deepseek-ai/dsh-tools`). */
interface ToolsRegistry {
  register(definition: ReturnType<typeof buildSubagentStatusTool>): () => void
}

/** Format one ms duration as a compact `4m02s` / `1h12m` / `37s` stamp. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/** One board row: status, short id, label, progress, activity. */
function renderRow(prefix: string, view: AgentView, now: number): string {
  const id = `#${view.childId.slice(0, 8)}`
  const parts = [
    `${prefix} ${id} ${view.label}`,
    `rounds ${view.rounds}`,
    `tok ${view.tokens}`,
  ]
  if (view.contextWindow !== undefined && view.contextWindow > 0) {
    parts.push(`ctx ${Math.round((view.contextTokens / view.contextWindow) * 100)}%`)
  }
  parts.push(formatDuration(now - view.startedAt))
  if (view.lastTool !== undefined) parts.push(`last=${view.lastTool}`)
  if (view.retries > 0) parts.push(`retry ${view.retries}`)
  if (view.outcome !== undefined) parts.push(`outcome=${view.outcome}`)
  return parts.join('  ')
}

/**
 * Build the tool definition. `parameters` is empty — the board takes no
 * arguments; every call is a full snapshot.
 */
export function buildSubagentStatusTool(ctx: Context, runtime: SubagentRuntimeSource) {
  return defineTool({
    name: SUBAGENT_STATUS_TOOL_NAME,
    description:
      'Live board of this session\'s subagents: who is running, how far each has got '
      + '(rounds, tokens, context, last tool), who settled, and the admission counters '
      + '(admitted / denied by the maxAgents cap). Read-only, zero cost, always current — '
      + 'call this INSTEAD of probing spawn tools or re-reading transcripts. '
      + 'After an "Agent limit reached" denial: check the board, record the pending task '
      + 'with todo_write, and dispatch it once a running agent finishes and frees a slot.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const text = (value as { readonly text?: unknown }).text
        return [{ type: 'text', text: typeof text === 'string' ? text : 'subagent board unavailable' }]
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      const views = runtime.views()
      const stats = runtime.stats()
      const cap = readSubagentLimits(ctx).maxAgents
      const now = Date.now()
      const live = views.filter(view => view.outcome === undefined).sort((a, b) => a.startedAt - b.startedAt)
      const settled = views.filter(view => view.outcome !== undefined)
        .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
        .slice(0, SETTLED_ROWS)
      const head = `subagent board — live ${stats.live}/${cap} (dsh-tui.maxAgents, 0 = unlimited)`
        + ` · admitted ${stats.allowed} · denied ${stats.denied} · pruned ${stats.pruned} · in-flight ${stats.inFlight}`
      const rows = [
        ...live.map(view => renderRow('live', view, now)),
        ...(settled.length > 0 ? ['--- recent settles ---'] : []),
        ...settled.map(view => renderRow('done', view, now)),
      ]
      const text = rows.length === 0
        ? `${head}\n(no children yet — the board is empty)`
        : `${head}\n${rows.join('\n')}`
      return { kind: 'subagent_status', text }
    },
  })
}

/**
 * Register the board tool on the plugin root ctx. Best-effort like the
 * policy's guard wiring: a tools-less deployment skips silently (the TUI's
 * runtime management surfaces — viewer, limits panel — remain).
 *
 * @returns the registration disposer, or `undefined` when there is no tools
 * service to register with.
 */
export function installSubagentStatusTool(ctx: Context, runtime: SubagentRuntimeSource): (() => void) | undefined {
  const tools = ctx.get('tools') as ToolsRegistry | undefined
  if (tools?.register === undefined) return undefined
  return tools.register(buildSubagentStatusTool(ctx, runtime))
}
