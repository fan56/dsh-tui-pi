/**
 * Session log retention — the startup janitor for the jsonl session store.
 *
 * The dsh core only ever APPENDS to `$DSH_HOME/sessions/<project>/<session>/`
 * (one `session.jsonl[.zstd]` per directory); nothing on the write side
 * prunes, so the store grows without bound (1000+ directories measured
 * locally). This module deletes whole session directories that fall outside
 * the retention policy — the UNION of two rules:
 *
 *   age   — the log mtime (≈ last activity: every append fsyncs, and the
 *           header has no updatedAt) is more than `maxAgeDays` old;
 *   count — ranked newest→oldest, the session sits beyond the first
 *           `maxCount` AND has been idle for at least `minIdleMs`.
 *
 * Safety valves (see `selectRetentionDeletions` / `runSessionRetention`):
 * the current session and any in-flight /resume target are never deleted;
 * the count rule's idle guard keeps sessions a concurrent dsh process may
 * still hold open; only session DIRECTORIES are removed — never a project
 * bucket, never a flat bucket file; each removal is individually
 * fault-isolated; and the whole pass is silent and non-fatal so it can
 * never block TUI startup. Every threshold resolves through a
 * three-level chain (`resolveRetentionConfig`): an explicit
 * `dsh-tui.retention` value in settings.yaml > the
 * `DSH_TUI_RETENTION_*` environment variables > the defaults — settings
 * is what the user deliberately persisted, so it outranks the ambient
 * environment. Invalid values at the settings level surface once as a
 * notice (src/notice-bridge.ts) and fall to the next level.
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHome } from './append-system.ts'
import { emitNotice } from './notice-bridge.ts'

/**
 * One session directory discovered by the walk. `id` is the directory
 * name — the path-encoded session id (UUID ids encode to themselves, so
 * the common case matches the live session id by name).
 */
export interface RetentionCandidate {
  id: string
  dir: string
  mtimeMs: number
}

/** Retention knobs; `now` is injected so the pure selector is testable. */
export interface RetentionPolicy {
  /** Keep at most this many sessions (the `maxCount` freshest). */
  maxCount: number
  /** Delete sessions whose last activity is older than this many days. */
  maxAgeDays: number
  /** Count-rule-only idle guard, in ms (see RETENTION_MIN_IDLE_MS). */
  minIdleMs: number
  /** Reference time, ms since the epoch. */
  now: number
}

/** Default cap: at most 100 sessions survive. */
export const RETENTION_MAX_COUNT = 100

/**
 * Default window: sessions untouched for 7 days are deleted. Deliberately
 * coupled in VALUE with `RESUME_MAX_AGE_DAYS` (src/sessions.ts): the two 7s
 * are one product decision ("a week is the working set"), but their SEMANTICS
 * differ — this constant DELETES logs, that one only hides picker rows — so
 * they are separate constants, not one shared number. Note the asymmetry:
 * this one resolves through the settings/env chain
 * (`dsh-tui.retention.maxAgeDays` / `DSH_TUI_RETENTION_MAX_AGE_DAYS`), that
 * one has its own twin knobs (`dsh-tui.resume.maxAgeDays` /
 * `DSH_TUI_RESUME_MAX_AGE_DAYS`).
 */
export const RETENTION_MAX_AGE_DAYS = 7

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * Count-rule-only idle guard (24h), in HOURS: a session ranked beyond the
 * count cap is deleted only when its log has been idle for at least this
 * long. This avoids deleting a session that another concurrent dsh process
 * (feishu remote, headless, a subagent) still holds open but has not
 * written to recently — its mtime predates the 100 fresher sessions, yet
 * removing the directory would destroy the log that process appends to
 * next. The age rule needs no extra guard: 7 idle days are proof enough.
 * Exported as hours because that is the unit the settings field and env
 * knob expose; the selector consumes the ms twin below.
 */
export const RETENTION_MIN_IDLE_HOURS = 24

/** The idle guard in ms — the unit `RetentionPolicy.minIdleMs` consumes. */
export const RETENTION_MIN_IDLE_MS = RETENTION_MIN_IDLE_HOURS * HOUR_MS

/** Retention knobs after env resolution; `now` stays a per-pass input. */
export interface RetentionConfig {
  /** Keep at most this many sessions (the `maxCount` freshest). */
  maxCount: number
  /** Delete sessions whose last activity is older than this many days. */
  maxAgeDays: number
  /** Count-rule-only idle guard, in ms (see RETENTION_MIN_IDLE_MS). */
  minIdleMs: number
  /**
   * False = the whole pass is skipped. Set by a non-positive
   * `DSH_TUI_RETENTION_MAX_COUNT` — the documented way to disable
   * retention entirely.
   */
  enabled: boolean
}

/**
 * One env slot parsed: a finite number passing `accept`, or undefined when
 * absent/garbage (an `accept` rejection is garbage too — it falls to the
 * default just as silently, mirroring the settings layer's per-field check).
 */
function finiteEnv(
  raw: string | undefined,
  accept: (value: number) => boolean = () => true,
): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) && accept(value) ? value : undefined
}

/**
 * Explicit `dsh-tui.retention` overrides from settings.yaml — the USER
 * layer of the settings document (theme-settings.ts hands the raw section
 * through), so every field is `unknown`: a hand-edited file can carry
 * anything. Absent fields are simply not overridden; present-but-invalid
 * ones are rejected by `resolveRetentionConfig` with one notice each.
 */
export interface RetentionSettingsInput {
  maxCount?: unknown
  maxAgeDays?: unknown
  minIdleHours?: unknown
}

/**
 * Narrow one explicit settings field: a finite number passing `accept`, or
 * undefined (absent, or present-but-invalid). An invalid value emits one
 * notice through the shared bridge (src/notice-bridge.ts) naming the
 * field and its raw value so a hand-edited settings.yaml is debuggable;
 * the caller then falls to the next precedence level.
 */
function explicitSetting(
  section: RetentionSettingsInput | undefined,
  key: keyof RetentionSettingsInput,
  accept: (value: number) => boolean,
): number | undefined {
  const raw = section?.[key]
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !accept(raw)) {
    emitNotice(
      `settings dsh-tui.retention.${key}: invalid value `
      + `${JSON.stringify(raw)} — falling back to environment/default`,
    )
    return undefined
  }
  return raw
}

/**
 * Resolve the retention knobs through the precedence chain — explicit
 * settings.yaml values (`dsh-tui.retention`) outrank the environment
 * variables, which outrank the defaults. Settings is what the user
 * deliberately persisted, so it must win over the ambient environment;
 * the env layer stays the escape hatch for deployments the defaults do
 * not fit: a concurrent process (feishu remote, headless cron, a
 * long-lived subagent) may read-ATTACH old sessions for weeks, and the
 * default "100 kept / 7 days" would delete the log under it.
 *
 *   dsh-tui.retention.maxCount      / DSH_TUI_RETENTION_MAX_COUNT
 *     session cap; must be an integer; <= 0 DISABLES retention
 *   dsh-tui.retention.maxAgeDays    / DSH_TUI_RETENTION_MAX_AGE_DAYS
 *     age window; must be > 0
 *   dsh-tui.retention.minIdleHours  / DSH_TUI_RETENTION_MIN_IDLE_HOURS
 *     count-rule idle guard; must be >= 0
 *
 * Invalid settings values emit one notice each (notice bridge) and fall
 * to the next level; invalid env values fall back silently to the
 * defaults — a typo must
 * never silently widen or gut the policy. The env maxCount must
 * additionally be an INTEGER (the settings layer already demands one):
 * a fractional cap like 100.5 is finite and non-positive-checkable, but
 * `ranked[100.5]` is undefined forever, so the count rule would die
 * silently — non-integer env counts are invalid env and fall to the
 * default. Only `maxCount <= 0` disables; that combination is deliberate
 * so a single knob is the one documented off switch. Pure; `process.env`
 * and the settings section are passed explicitly so tests can pin them.
 */
export function resolveRetentionConfig(
  env: Record<string, string | undefined> = process.env,
  settings?: RetentionSettingsInput,
): RetentionConfig {
  // Level 1: explicit settings values (validated per field, warn+skip on
  // garbage). Level 2: the environment. Level 3 happens per knob below.
  const sMaxCount = explicitSetting(settings, 'maxCount', value => Number.isInteger(value))
  const sMaxAgeDays = explicitSetting(settings, 'maxAgeDays', value => value > 0)
  const sMinIdleHours = explicitSetting(settings, 'minIdleHours', value => value >= 0)
  const maxCount = sMaxCount ?? finiteEnv(env.DSH_TUI_RETENTION_MAX_COUNT, Number.isInteger)
  const maxAgeDays = sMaxAgeDays ?? finiteEnv(env.DSH_TUI_RETENTION_MAX_AGE_DAYS)
  const minIdleHours = sMinIdleHours ?? finiteEnv(env.DSH_TUI_RETENTION_MIN_IDLE_HOURS)
  return {
    maxCount: maxCount ?? RETENTION_MAX_COUNT,
    maxAgeDays: maxAgeDays !== undefined && maxAgeDays > 0 ? maxAgeDays : RETENTION_MAX_AGE_DAYS,
    minIdleMs: minIdleHours !== undefined && minIdleHours >= 0 ? minIdleHours * HOUR_MS : RETENTION_MIN_IDLE_MS,
    enabled: !(maxCount !== undefined && maxCount <= 0),
  }
}

/**
 * The session store root by the CORE convention: `$DSH_HOME/sessions`
 * (default `~/.dsh/sessions`). Deliberately NOT `$DSH_SESSION_ROOT` — the
 * core writer only resolves `$DSH_HOME`, so honoring the other variable
 * here could prune (or miss) the wrong tree. The /resume picker's walk
 * (`sessionLogRoot`, src/sessions.ts) is the deliberate contrast: it DOES
 * honor `$DSH_SESSION_ROOT`, because a mismatched root there only
 * degrades the picker's ordering/filtering (never deletes anything),
 * while here it would aim `fs.rm` at the wrong tree.
 */
export function sessionStoreRoot(): string {
  return join(dshHome(), 'sessions')
}

/**
 * Physical log file names the jsonl backend writes (`logSuffix`). Single
 * source of truth for every walk of the store — the /resume mtime walk
 * (src/sessions.ts) imports this; two private copies already drifted once.
 */
export const SESSION_LOG_FILE_NAMES = ['session.jsonl', 'session.jsonl.zstd'] as const

/**
 * Walk `<root>/<project>/<sessionId>/` and stat each session's log. Only
 * DIRECTORIES at the session level are visited: a flat file at the bucket
 * level, an empty session directory, or a non-directory project entry has
 * no log mtime to judge and is skipped entirely (never counted, never
 * deleted). A session's "last activity" is the NEWEST mtime across the
 * log files that exist (the raw and the compressed name may coexist).
 * Any failure resolves a partial list — the janitor must never throw.
 */
export async function collectRetentionCandidates(root: string): Promise<RetentionCandidate[]> {
  const candidates: RetentionCandidate[] = []
  let projects: string[]
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return candidates
  }
  for (const project of projects) {
    let sessionDirs: string[]
    try {
      sessionDirs = (await readdir(join(root, project), { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      // Unreadable bucket — leave it alone, keep walking.
      continue
    }
    for (const dir of sessionDirs) {
      let mtimeMs = 0
      for (const name of SESSION_LOG_FILE_NAMES) {
        try {
          const info = await stat(join(root, project, dir, name))
          if (info.mtimeMs > mtimeMs) mtimeMs = info.mtimeMs
        } catch {
          // Not this suffix — try the next one.
        }
      }
      if (mtimeMs > 0) candidates.push({ id: dir, dir: join(root, project, dir), mtimeMs })
    }
  }
  return candidates
}

/**
 * Pure policy: which candidates fall outside the retention window. Both
 * rules fire on the pool AFTER the protected sessions are excluded — a
 * protected session (the live one, or the target of an in-flight /resume)
 * is never deleted and never consumes one of the `maxCount` slots (dropping
 * it can only pull other sessions back inside the cap, never push one
 * out). The output keeps the input order, so removal runs deterministically.
 */
export function selectRetentionDeletions(
  candidates: readonly RetentionCandidate[],
  policy: RetentionPolicy,
  protectedSessionIds?: Iterable<string>,
): RetentionCandidate[] {
  // LOAD-BEARING assumption: a session directory's name equals the RAW
  // session id, which holds only for UUID ids — the store path-encodes
  // segment names and `encodeSegment` passes UUID characters through
  // verbatim. A future non-UUID id scheme would break this silently: the
  // encoded directory name would not match the live id, and the "protected"
  // session would compete for cap slots (and deletion) like any other. If
  // ids ever stop being UUIDs, the walk must decode directory names back
  // to ids instead of comparing raw.
  const protectedIds = new Set(
    [...(protectedSessionIds ?? [])].filter(id => id !== ''),
  )
  const pool = protectedIds.size === 0 ? candidates : candidates.filter(candidate => !protectedIds.has(candidate.id))
  const doomed = new Set<RetentionCandidate>()
  // Age rule: strictly older than the window (mtime == cutoff survives).
  const ageCutoff = policy.now - policy.maxAgeDays * DAY_MS
  for (const candidate of pool) {
    if (candidate.mtimeMs < ageCutoff) doomed.add(candidate)
  }
  // Count rule: everything past the first `maxCount` (newest first) that
  // also passes the idle guard. Ties break by id so tests are deterministic.
  const idleCutoff = policy.now - policy.minIdleMs
  const ranked = pool.slice().sort(
    (a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  for (let i = Math.max(0, policy.maxCount); i < ranked.length; i++) {
    const candidate = ranked[i]
    if (candidate !== undefined && candidate.mtimeMs < idleCutoff) doomed.add(candidate)
  }
  return pool.filter(candidate => doomed.has(candidate))
}

/** One retention pass result, for the startup log line and tests. */
export interface RetentionResult {
  removed: number
  failed: number
}

/** Injectable seams for `runSessionRetention` (tests override them). */
export interface SessionRetentionDeps {
  /** Store root; defaults to `sessionStoreRoot()`. */
  root?: string
  /**
   * Live session id getter — re-polled immediately before every removal.
   * Combined with `getResumingSessionId` into the protected set.
   */
  getSessionId?: () => string | undefined
  /**
   * Target id of an in-flight `/resume`, when one is running (bridge
   * getter of the same name). A mid-load resume reads the target's log
   * directory for its whole duration, so the target is exactly as
   * load-bearing as the current session — unioned into the protected set
   * at selection time and again before every removal.
   */
  getResumingSessionId?: () => string | undefined
  /**
   * Explicit `dsh-tui.retention` settings (the user layer of
   * settings.yaml), read once before the pass resolves its config —
   * precedence: settings > env > defaults (see `resolveRetentionConfig`).
   * An async thunk because the settings service mounts asynchronously: the
   * startup fire-and-forget awaits it (bounded inside the reader) without
   * blocking the first frame. A missing service resolves undefined and the
   * pass proceeds on env/defaults; a throwing thunk is treated the same
   * (the janitor must never fail startup over a config read).
   */
  readSettings?: () => Promise<RetentionSettingsInput | undefined>
  /** Count cap override; precedence: dep > settings > env > RETENTION_MAX_COUNT. */
  maxCount?: number
  /** Age window override (days); precedence: dep > settings > env > RETENTION_MAX_AGE_DAYS. */
  maxAgeDays?: number
  /** Idle guard override (ms); precedence: dep > settings > env > RETENTION_MIN_IDLE_MS. */
  minIdleMs?: number
  /** Clock override; defaults to Date.now(). */
  now?: number
}

/**
 * Run one retention pass: walk the store, select the doomed session
 * directories, remove each one (`fs.rm` recursive force). The deletion
 * unit is strictly `<project>/<sessionId>/` — a project bucket, a flat
 * bucket file, or anything the walk skipped is never touched. Every
 * removal is its own try/catch (one failure does not stop the rest), and
 * the protected set — current session ∪ in-flight resume target — is
 * re-polled right before each removal so a session created or resumed
 * while the walk was running is never collected. The pass is a no-op when
 * retention is disabled via env, silent and non-fatal otherwise — it must
 * never block or crash startup. When it deleted anything, the result
 * surfaces exactly once through the shared notice bridge
 * (`emitNotice`, src/notice-bridge.ts): delivered immediately if a TUI
 * has registered its sink, held pending until one does, silently dropped
 * if none ever does (headless). It is never written to the terminal
 * directly — raw bytes would scribble over the alt-screen frame.
 */
export async function runSessionRetention(deps: SessionRetentionDeps = {}): Promise<RetentionResult> {
  const result: RetentionResult = { removed: 0, failed: 0 }
  try {
    // Explicit settings first (bounded wait, best-effort): the user layer
    // of settings.yaml outranks the environment, and the service mounts
    // asynchronously — the await rides inside the fire-and-forget pass,
    // never on the startup critical path.
    let settings: RetentionSettingsInput | undefined
    try {
      settings = await deps.readSettings?.()
    } catch {
      settings = undefined
    }
    const config = resolveRetentionConfig(process.env, settings)
    if (!config.enabled) return result
    const root = deps.root ?? sessionStoreRoot()
    const candidates = await collectRetentionCandidates(root)
    const policy: RetentionPolicy = {
      maxCount: deps.maxCount ?? config.maxCount,
      maxAgeDays: deps.maxAgeDays ?? config.maxAgeDays,
      minIdleMs: deps.minIdleMs ?? config.minIdleMs,
      now: deps.now ?? Date.now(),
    }
    const protectedNow = (): Set<string> => {
      const ids = new Set<string>()
      const current = deps.getSessionId?.()
      if (current !== undefined && current !== '') ids.add(current)
      const resuming = deps.getResumingSessionId?.()
      if (resuming !== undefined && resuming !== '') ids.add(resuming)
      return ids
    }
    const doomed = selectRetentionDeletions(candidates, policy, protectedNow())
    for (const candidate of doomed) {
      // Re-poll right before the removal: the live session id or a resume
      // target may have landed while the walk ran (lazy create, /resume,
      // reload stash).
      if (protectedNow().has(candidate.id)) continue
      try {
        await rm(candidate.dir, { recursive: true, force: true })
        result.removed += 1
      } catch {
        result.failed += 1
        // Terminal state, accepted as-is: a failed `rm` (recursive force)
        // may have already unlinked the log, leaving a half-deleted orphan
        // directory behind. The walk only candidates directories with a
        // readable log mtime, so an orphan without its log is never
        // revisited or retried — inert, never fatal, costs one dir entry.
      }
    }
    if (result.removed + result.failed > 0) {
      reportRetentionResult(result)
    }
  } catch {
    // Silent by contract — never block startup.
  }
  return result
}

// ------------------------------------------------------------ reporting --
// The result rides the SHARED notice bridge (src/notice-bridge.ts): the
// TUI registers its sink once it is ready, and the pass delivers the
// message immediately if the sink already exists, holds it pending until
// one registers, or lets it die silently when none ever does (headless /
// a failed startup). The sink/pending/at-most-once machinery lives in the
// bridge module — this only keeps the retention-specific message format.

/** Format and deliver one result line through the notice bridge. */
function reportRetentionResult(result: RetentionResult): void {
  emitNotice(result.failed > 0
    ? `Session retention: removed ${result.removed}, failed ${result.failed}`
    : `Session retention: removed ${result.removed}`)
}

// One-shot per PROCESS, not per plugin load: `/reload` re-runs apply() in
// the same dsh process (module state is evicted, process globals survive —
// the same property the reload stash relies on), and a second pass right
// after the first would only re-walk the same store.
const RETENTION_RAN_KEY = Symbol.for('dsh-tui-pi.sessionRetentionRan')

/**
 * `runSessionRetention` guarded against re-entry across `/reload`: the
 * flag is set synchronously before any await, so a reload landing
 * mid-pass cannot start a second concurrent walk. Consequence of that
 * one-shot: a `/reload` that interrupts a pass (the plugin fiber is torn
 * down while the process lives on) leaves the flag set, so the pass is
 * NEVER re-run in this process — the next cold start is what re-arms the
 * janitor. Accepted by design: re-walking the same store a second later
 * would find nothing the first pass already collected.
 */
export async function runSessionRetentionOnce(deps: SessionRetentionDeps = {}): Promise<RetentionResult> {
  const store = globalThis as Record<symbol, unknown>
  if (store[RETENTION_RAN_KEY] === true) return { removed: 0, failed: 0 }
  store[RETENTION_RAN_KEY] = true
  return runSessionRetention(deps)
}
