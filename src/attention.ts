/**
 * Subagent attention ranking — the heuristic base layer (Charter #6:
 * jev-optional). Scores every live child 0–1 for "how much does this need
 * the operator's eye" from structured view facts alone (stall, rounds vs
 * cap, unanswered injections, retries, context occupancy); the jev layer
 * (attention-jev.ts) may REPLACE a heuristic judgment with a semantic one
 * and does nothing when unconfigured — the ranking below is always live and
 * costs nothing but a map walk on the bridge's 600ms reconcile tick.
 *
 * Layer contract (ticket 04): a jev judgment is authoritative UNTIL the
 * child makes progress (rounds or tokens move) — jev judged a snapshot, and
 * progress is new state, so the entry falls back to heuristic until the
 * next jev pass covers it. Heuristic and jev scores share the same 0–1
 * scale and tier cuts, so consumers never branch on the layer beyond the
 * `source` label they may display.
 *
 * This file is pure terminal-free logic; `AttentionBoard` holds the only
 * mutable state (per-child observation + the current info map).
 */

import type { AgentView } from './dsh-events.ts'

export type AttentionTier = 'critical' | 'warn' | 'ok'
export type AttentionSourceKind = 'heuristic' | 'jev'
/**
 * `stalled` / `near-cap` are heuristic signals (the top contributing
 * factor); `spinning` / `deep-work` / `waiting` are jev's semantic tags and
 * never produced here.
 */
export type AttentionTag = 'stalled' | 'near-cap' | 'spinning' | 'deep-work' | 'waiting'

export interface AttentionInfo {
  readonly score: number
  readonly tier: AttentionTier
  readonly source: AttentionSourceKind
  readonly tag?: AttentionTag
}

/**
 * The spin-streak state the early-stop ladder consumes. `lastStrikeAt` is
 * the clock of the MOST RECENT spinning verdict — the ladder's freshness
 * anchor (a strike older than the stale window, or older than a delivered
 * wrap-up, must not stop anything).
 */
export interface SpinState {
  /** Consecutive spinning verdicts (a non-spinning verdict zeroes it). */
  readonly streak: number
  readonly lastStrikeAt: number
}

/** A spinning verdict older than this is stale evidence — three debounce windows. */
export const SPIN_STRIKE_STALE_MS = 90_000

/** One consumer-facing row: the view facts plus the current attention info. */
export interface AttentionRow {
  readonly childId: string
  readonly label: string
  readonly info: AttentionInfo
  /** Ms since the child last made observable progress (rounds/tokens moved). */
  readonly stallMs: number
}

/** Tier cuts — shared by both layers so a jev score and a heuristic score are tier-comparable. */
export const ATTENTION_CRITICAL_AT = 0.6
export const ATTENTION_WARN_AT = 0.35

/** Stall ramp: no penalty under a minute of silence; full weight at ten minutes. */
export const ATTENTION_STALL_FLOOR_MS = 60_000
export const ATTENTION_STALL_CEIL_MS = 600_000

/** Component weights — documented so preview data can tune them deliberately. */
const W_STALL = 0.45
const W_ROUNDS = 0.25
const W_IGNORED = 0.15
const W_RETRIES = 0.1
const W_CONTEXT = 0.05

export interface HeuristicInput {
  /** Ms since observable progress (rounds or tokens moved). */
  stallMs: number
  /** Assistant-message count; the "rounds" the maxRounds ladder caps. */
  rounds: number
  /** The effective maxRounds cap; 0 = unlimited (the rounds component drops out). */
  cap: number
  /** A plugin injection (wrap-up / steer) landed and NO progress followed it. */
  ignoredInjection: boolean
  retries: number
  /** Current context occupancy as a 0–1 ratio, when the window is known. */
  contextRatio?: number
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function stallFactor(stallMs: number): number {
  if (stallMs <= ATTENTION_STALL_FLOOR_MS) return 0
  return clamp01((stallMs - ATTENTION_STALL_FLOOR_MS) / (ATTENTION_STALL_CEIL_MS - ATTENTION_STALL_FLOOR_MS))
}

export function tierFor(score: number): AttentionTier {
  if (score >= ATTENTION_CRITICAL_AT) return 'critical'
  if (score >= ATTENTION_WARN_AT) return 'warn'
  return 'ok'
}

/** The heuristic score: weighted view facts, 0–1, two decimals. */
export function heuristicAttentionScore(input: HeuristicInput): number {
  const stall = W_STALL * stallFactor(input.stallMs)
  const rounds = input.cap > 0 ? W_ROUNDS * clamp01(input.rounds / input.cap) : 0
  const ignored = input.ignoredInjection ? W_IGNORED : 0
  const retries = W_RETRIES * clamp01(input.retries / 3)
  const context = input.contextRatio !== undefined ? W_CONTEXT * clamp01(input.contextRatio) : 0
  return Math.round((stall + rounds + ignored + retries + context) * 100) / 100
}

/** Heuristic tag: the one strong signal worth naming, else unnamed. */
export function heuristicTag(input: HeuristicInput, score: number): AttentionTag | undefined {
  if (input.cap > 0 && input.rounds / input.cap >= 0.85) return 'near-cap'
  if (stallFactor(input.stallMs) >= 0.5) return 'stalled'
  // A score that reached warn/critical without a dominant single factor is
  // still worth flagging as stalled-ish for consumers that filter on tags.
  if (score >= ATTENTION_WARN_AT) return 'stalled'
  return undefined
}

interface ChildObservation {
  label: string
  lastProgressAt: number
  lastRounds: number
  lastTokens: number
  info: AttentionInfo
  /** Set on progress; cleared when a jev pass covers the child. */
  dirtyForJev: boolean
  /**
   * Consecutive jev passes whose spin verdict cleared the high segment
   * (≥0.75). Zeroed by a non-spinning verdict — but NOT by progress: a
   * circling child's rounds/tokens keep growing (that IS the circling), so
   * progress-based clearing would zero the streak every second on exactly
   * the children it exists to catch. Staleness is handled by the ladder via
   * `lastStrikeAt`, not by clearing here.
   */
  spinStreak: number
  /** Clock of the most recent spinning verdict. */
  lastStrikeAt: number
}

/** Heuristic inputs derived from one live view + the board's own observation of it. */
function inputsFor(view: AgentView, observation: ChildObservation, now: number): HeuristicInput {
  return {
    stallMs: Math.max(0, now - observation.lastProgressAt),
    rounds: view.rounds,
    cap: 0, // substituted by the board (settings-resolved)
    ignoredInjection: view.injectedAt !== undefined && observation.lastProgressAt <= view.injectedAt,
    retries: view.retries,
    contextRatio:
      view.contextWindow !== undefined && view.contextWindow > 0
        ? view.contextTokens / view.contextWindow
        : undefined,
  }
}

/**
 * The mutable ranking. One instance per bridge; `update()` on the reconcile
 * tick is the only required driver. `now` is injectable for tests.
 */
export class AttentionBoard {
  private readonly observations = new Map<string, ChildObservation>()
  private now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  setClock(now: () => number): void {
    this.now = now
  }

  /**
   * Re-observe every live child: detect progress, recompute heuristic info,
   * apply any still-fresh jev judgment, prune settled/gone children. Idempotent
   * and O(n) — safe on every tick.
   */
  update(views: readonly AgentView[], cap: number): void {
    const now = this.now()
    // The board ranks LIVE children only: a child that settled this pass is
    // pruned with the same stroke (its observation must not linger stale).
    const live = new Set(views.filter(view => view.outcome === undefined).map(view => view.childId))
    for (const childId of [...this.observations.keys()]) {
      if (!live.has(childId)) this.observations.delete(childId)
    }
    for (const view of views) {
      if (view.outcome !== undefined || !live.has(view.childId)) continue
      const previous = this.observations.get(view.childId)
      const progressed =
        previous === undefined ||
        view.rounds !== previous.lastRounds ||
        view.tokens !== previous.lastTokens
      const observation: ChildObservation = previous ?? {
        label: view.label,
        lastProgressAt: now,
        lastRounds: view.rounds,
        lastTokens: view.tokens,
        info: { score: 0, tier: 'ok', source: 'heuristic' },
        dirtyForJev: true,
        spinStreak: 0,
        lastStrikeAt: 0,
      }
      observation.label = view.label
      if (progressed) {
        observation.lastProgressAt = now
        observation.lastRounds = view.rounds
        observation.lastTokens = view.tokens
        observation.dirtyForJev = true
        // A jev judgment judged the state BEFORE this progress — the info
        // falls back to heuristic (below). The spin streak is deliberately
        // NOT cleared: a circling child makes "progress" (rounds grow) by
        // definition, and freshness is the ladder's job (lastStrikeAt).
      }
      const input = { ...inputsFor(view, observation, now), cap }
      const score = heuristicAttentionScore(input)
      observation.info = {
        score,
        tier: tierFor(score),
        source: 'heuristic',
        tag: heuristicTag(input, score),
      }
      this.observations.set(view.childId, observation)
    }
  }

  /**
   * The jev layer's write-in: replaces the heuristic judgment for the named
   * children (same scale, same tiers — ticket 04 "替代非融合"). Children the
   * board no longer tracks are ignored; covered children lose their dirty flag.
   */
  applyJevScores(scores: readonly (readonly [childId: string, score: number, tag: AttentionTag | undefined])[]): void {
    const now = this.now()
    for (const [childId, score, tag] of scores) {
      const observation = this.observations.get(childId)
      if (observation === undefined) continue
      const clamped = clamp01(score)
      observation.info = { score: clamped, tier: tierFor(clamped), source: 'jev', ...(tag !== undefined ? { tag } : {}) }
      observation.dirtyForJev = false
      if (tag === 'spinning') {
        observation.spinStreak += 1
        observation.lastStrikeAt = now
      } else {
        observation.spinStreak = 0
        observation.lastStrikeAt = 0
      }
    }
  }

  /**
   * The early-stop ladder's input: consecutive spinning verdicts plus the
   * clock of the most recent one (the freshness anchor). Absent children
   * report zeroed state.
   */
  spinState(childId: string): SpinState {
    const observation = this.observations.get(childId)
    return observation === undefined
      ? { streak: 0, lastStrikeAt: 0 }
      : { streak: observation.spinStreak, lastStrikeAt: observation.lastStrikeAt }
  }

  /** Children whose state changed since their last jev judgment (the refresh's work list). */
  dirtyChildren(): string[] {
    return [...this.observations.entries()].filter(([, observation]) => observation.dirtyForJev).map(([childId]) => childId)
  }

  /** One child's current info, when ranked. */
  get(childId: string): AttentionInfo | undefined {
    return this.observations.get(childId)?.info
  }

  /** All rows, highest attention first — the picker/status/guard read side. */
  rows(): AttentionRow[] {
    const now = this.now()
    return [...this.observations.entries()]
      .map(([childId, observation]) => ({
        childId,
        label: observation.label,
        info: observation.info,
        stallMs: Math.max(0, now - observation.lastProgressAt),
      }))
      .sort((a, b) => b.info.score - a.info.score)
  }

  /**
   * The guard's deny-copy hint: the most attention-worthy live child that is
   * actually worth acting on (tier above ok), or undefined when the ranking
   * has nothing to say.
   */
  topHint(): { label: string; detail: string } | undefined {
    const row = this.rows().find(row => row.info.tier !== 'ok')
    if (row === undefined) return undefined
    const tag = row.info.tag !== undefined ? `, ${row.info.tag}` : ''
    return {
      label: row.label,
      detail: `${row.info.source} score ${row.info.score.toFixed(2)}${tag}, idle ${Math.round(row.stallMs / 1000)}s`,
    }
  }
}
