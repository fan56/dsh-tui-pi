/**
 * The jev upgrade layer for attention (ticket 04): batches every dirty
 * live child into ONE System One call — two atomic noul questions per child
 * (`attention_<id8>`: needs-operator-attention, `spin_<id8>`: productive vs
 * circling) over a shared compact state table — and writes the scores back
 * through `AttentionBoard.applyJevScores`. A high-segment `spin` verdict
 * (≥0.75; middle values are uncertainty, never evidence) becomes the
 * `spinning` tag the early-hard-stop ladder later consumes (ticket 05).
 *
 * jev-optional by construction: the source ticks silently when the setting
 * is off, the core probe fails, no key is configured, the debounce window
 * is open, another call is in flight, or nothing is dirty — and a failed
 * call is a silent counter bump, never a warn and never a turned-down
 * ranking (the heuristic layer underneath is always live).
 */

import type { AgentView } from './dsh-events.ts'
import type { AttentionBoard, AttentionTag } from './attention.ts'

/** Structural slice of @aiwayds/dsh-jev-core — type-only import, erased at runtime. */
interface JevCoreModule {
  classify(options: {
    questions: Record<string, { type: 'noul'; criteria: Record<string, string> }>
    state: string
    env?: NodeJS.ProcessEnv
    fetchImpl?: typeof fetch
    timeoutMs?: number
  }): Promise<{
    answers: Record<string, { kind: 'noul'; value: number }>
    model: string
    usage: unknown
    latencyMs: number
  }>
  isConfigured(sources?: { env?: NodeJS.ProcessEnv }): boolean
}

/** Probe the core once per process; a failed import degrades to heuristic-only ranking. */
async function loadJevCore(): Promise<JevCoreModule | null> {
  const specifier = '@aiwayds/dsh-jev-core'
  try {
    const mod = (await import(specifier)) as unknown as Record<string, unknown>
    if (typeof mod['classify'] !== 'function' || typeof mod['isConfigured'] !== 'function') return null
    return mod as unknown as JevCoreModule
  } catch {
    return null
  }
}

/** Minimum gap between jev dispatches (ticket 04: global debounce 30s). */
export const ATTENTION_JEV_MIN_INTERVAL_MS = 30_000
/** Per-call deadline: advisory data, generous but bounded. */
export const ATTENTION_JEV_TIMEOUT_MS = 8_000
/** High-segment line for the spin verdict — middle values are uncertainty, not evidence. */
export const SPINNING_TAG_AT = 0.75
/** State table size guard (ticket 04: ~800 chars; hard cap keeps runaway labels bounded). */
const STATE_MAX_CHARS = 1000
const LABEL_MAX_CHARS = 40

/** The id8 collision map is first-wins by view order; uuid4 id8 collisions are astronomic. */
export function buildAttentionQuestions(id8s: readonly string[]): Record<string, { type: 'noul'; criteria: Record<string, string> }> {
  const questions: Record<string, { type: 'noul'; criteria: Record<string, string> }> = {}
  for (const id8 of id8s) {
    questions[`attention_${id8}`] = {
      type: 'noul',
      criteria: {
        true: 'needs operator attention now — stalled, circling, near its round cap, or ignoring guidance',
        false: 'progressing fine — no intervention warranted',
      },
    }
    questions[`spin_${id8}`] = {
      type: 'noul',
      criteria: {
        true: 'work is UNPRODUCTIVE — repeating the same tools or circling without forward motion',
        false: 'work is productive — measurable forward progress',
      },
    }
  }
  return questions
}

/** The shared state table: one compact line per child, the facts both questions judge. */
export function buildAttentionState(views: readonly AgentView[], cap: number, now: number, stallOf: (childId: string) => number): string {
  const lines = views.map((view) => {
    const flags: string[] = []
    if (view.injectedAt !== undefined) flags.push('injected')
    if (view.retries > 0) flags.push(`retrying ${view.retries}/${view.maxRetries ?? '?'}`)
    const parts = [
      `${view.childId.slice(0, 8)} ${view.label.slice(0, LABEL_MAX_CHARS)}`,
      `rounds ${view.rounds}/${cap > 0 ? cap : '∞'}`,
      `idle ${Math.round(stallOf(view.childId) / 1000)}s`,
      `tok ${view.tokens}`,
      ...(view.contextWindow !== undefined && view.contextWindow > 0
        ? [`ctx ${Math.round((view.contextTokens / view.contextWindow) * 100)}%`]
        : []),
      ...(view.lastTool !== undefined ? [`last=${view.lastTool}`] : []),
      ...(flags.length > 0 ? [`flags: ${flags.join(', ')}`] : []),
    ]
    return `- ${parts.join(' | ')}`
  })
  const head = 'Subagents under supervision; judge each child on the two questions keyed by its id.'
  return `${head}\n${lines.join('\n')}`.slice(0, STATE_MAX_CHARS)
}

/** Read the verdict map back onto child ids; the spinning tag rides the high segment only. */
export function parseAttentionAnswers(
  answers: Record<string, { value: number }>,
  id8ToChild: ReadonlyMap<string, string>,
): [childId: string, score: number, tag: AttentionTag | undefined][] {
  const out: [string, number, AttentionTag | undefined][] = []
  for (const [id8, childId] of id8ToChild) {
    const attention = answers[`attention_${id8}`]
    if (attention === undefined) continue
    const spin = answers[`spin_${id8}`]
    const tag: AttentionTag | undefined = spin !== undefined && spin.value >= SPINNING_TAG_AT ? 'spinning' : undefined
    out.push([childId, attention.value, tag])
  }
  return out
}

export interface AttentionJevOptions {
  /** Live settings read — hot-applies the `jevAttention` toggle with no restart. */
  modeReader: () => 'auto' | 'off'
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  now?: () => number
  minIntervalMs?: number
  /** Test seam: inject the core module directly, skipping the runtime probe. */
  module?: JevCoreModule
}

export interface AttentionJevSource {
  /**
   * Driven from the bridge's reconcile tick after `board.update(...)`;
   * `cap` is the settings-resolved maxRounds (0 = unlimited) for the state
   * table. Fire-and-forget, self-serializing.
   */
  tick(board: AttentionBoard, views: readonly AgentView[], cap: number): void
  /** Failed-call counter (diagnostics; the ranking itself never surfaces errors). */
  failures(): number
}

export function createJevAttentionSource(options: AttentionJevOptions): AttentionJevSource {
  const now = options.now ?? Date.now
  const minIntervalMs = options.minIntervalMs ?? ATTENTION_JEV_MIN_INTERVAL_MS
  const env = options.env ?? process.env
  let core: JevCoreModule | null | undefined
  let loading: Promise<JevCoreModule | null> | undefined
  let lastDispatchAt = -Infinity
  let inFlight = false
  let failureCount = 0

  const ensureLoaded = (): Promise<JevCoreModule | null> => {
    if (options.module !== undefined) return Promise.resolve(options.module)
    if (core !== undefined) return Promise.resolve(core)
    loading ??= loadJevCore().then((mod) => {
      core = mod
      return mod
    })
    return loading
  }

  return {
    failures: () => failureCount,
    tick(board, views, cap) {
      if (inFlight) return
      if (options.modeReader() !== 'auto') return
      const live = views.filter(view => view.outcome === undefined)
      const dirty = board.dirtyChildren().filter(childId => live.some(view => view.childId === childId))
      if (dirty.length === 0) return
      const at = now()
      if (at - lastDispatchAt < minIntervalMs) return
      void ensureLoaded().then((mod) => {
        if (mod === null) return
        if (!mod.isConfigured({ env })) return
        const id8ToChild = new Map(live.map(view => [view.childId.slice(0, 8), view.childId]))
        const questions = buildAttentionQuestions([...id8ToChild.keys()])
        const state = buildAttentionState(live, cap, at, childId => board.rows().find(row => row.childId === childId)?.stallMs ?? 0)
        inFlight = true
        lastDispatchAt = at
        mod
          .classify({ questions, state, env, fetchImpl: options.fetchImpl, timeoutMs: ATTENTION_JEV_TIMEOUT_MS })
          .then(result => board.applyJevScores(parseAttentionAnswers(result.answers, id8ToChild)))
          .catch(() => {
            failureCount += 1
          })
          .finally(() => {
            inFlight = false
          })
      })
    },
  }
}
