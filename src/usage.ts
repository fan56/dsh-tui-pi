/**
 * Slash-command / skill usage memory for frequency-sorted completions.
 *
 * Every successful command execution and every `/name` skill gesture bumps a
 * per-name counter; the generic `/` completion dropdown orders candidates by
 * that count (most used first) instead of plain name order, and the ordering
 * survives the query filter (whatever remains after prefix filtering is still
 * frequency-first).
 *
 * Persistence: `$DSH_HOME/tui-command-usage.json` — a small JSON document the
 * TUI owns outright (it never touches settings.yaml or any other live dsh
 * file). The disk copy is authoritative across restarts AND across /reload:
 * the reload swaps the plugin fiber, a fresh tracker is constructed by the new
 * fiber and simply re-reads the file. Reads never throw (a missing or corrupt
 * file degrades to an empty table); writes are atomic (tmp sibling + rename)
 * and best-effort silent — a failed write must never take the UI down.
 *
 * Write policy: synchronous save on every record, no timer/flush queue.
 * Usage events are inherently low-frequency (one human-invoked command or
 * skill at a time) and the file stays tiny (bounded by MAX_ENTRIES), so the
 * simplicity of write-through beats batching — and avoids teardown hazards
 * for timers across hot-reload. Concurrent dsh processes share one store:
 * each write merges only its own unsaved delta onto a fresh read of the
 * file (baseline+delta, see CommandUsageTracker.persist) instead of
 * clobbering the whole table with this fiber's in-memory view.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './append-system.ts'

/** On-disk schema version; bump only for breaking changes. */
export const USAGE_FILE_VERSION = 1

/** One name's usage record: how often + how recently it was invoked. */
export interface UsageEntry {
  /** Successful invocation count (>= 1 for every stored entry). */
  count: number
  /** Epoch ms of the most recent invocation. */
  lastUsed: number
}

/** Name → count view handed to the completion sort (no recency exposed). */
export type UsageSnapshot = ReadonlyMap<string, number>

/**
 * Structural consumer contract so CommandService stays stub-friendly in
 * tests (and decoupled from the concrete tracker's file concerns).
 */
export interface UsageRecorder {
  /** Count one invocation of `name` (leading slash tolerated, stripped). */
  record(name: string): void
  /** Current name → count table (may be empty). */
  snapshot(): UsageSnapshot
}

/** Storage cap: above this many names, lowest-count entries are evicted. */
export const MAX_USAGE_ENTRIES = 500

/** `$DSH_HOME/tui-command-usage.json` (or an explicit home override). */
export function commandUsagePath(home: string = dshHome()): string {
  return join(home, 'tui-command-usage.json')
}

/** Normalize one usage key: completion-name form (no leading slashes), non-empty. */
function normalizeUsageName(name: string): string | undefined {
  const key = name.replace(/^\/+/, '')
  return key === '' ? undefined : key
}

/**
 * Read + validate a usage file into entries. Never throws: a missing,
 * corrupt, wrong-version or malformed document yields an empty table.
 * Individual bad entries are skipped, good siblings kept.
 */
export function loadUsageEntries(path: string): Map<string, UsageEntry> {
  const empty = new Map<string, UsageEntry>()
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return empty
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return empty
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const doc = raw as { version?: unknown; counts?: unknown }
  if (doc.version !== USAGE_FILE_VERSION) return empty
  const counts = doc.counts
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) return empty
  const entries = new Map<string, UsageEntry>()
  for (const [name, value] of Object.entries(counts as Record<string, unknown>)) {
    const key = normalizeUsageName(name)
    if (key === undefined || value === null || typeof value !== 'object') continue
    const { count, lastUsed } = value as { count?: unknown; lastUsed?: unknown }
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) continue
    entries.set(key, {
      count,
      lastUsed: typeof lastUsed === 'number' && Number.isFinite(lastUsed) && lastUsed >= 0 ? lastUsed : 0,
    })
  }
  return entries
}

/**
 * Atomically persist entries as `{ version, counts }`. Creates the target
 * directory when missing (a fresh DSH_HOME must not silently drop the first
 * record), writes a tmp sibling then renames over the target so a crash
 * never leaves half a file; on any failure the tmp sibling is cleaned up and
 * the error swallowed (the caller treats persistence as best-effort — the
 * in-memory table keeps working). Returns whether the write landed.
 */
export function saveUsageEntries(path: string, entries: ReadonlyMap<string, UsageEntry>): boolean {
  const doc = {
    version: USAGE_FILE_VERSION,
    counts: Object.fromEntries(entries),
  }
  const dir = dirname(path)
  const pathBase = path.split('/').pop() ?? 'tui-command-usage.json'
  const tmp = join(dir, `.${pathBase}.tmp-${process.pid}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(doc))
    renameSync(tmp, path)
    return true
  } catch {
    // A failed write/rename can leave the `.…tmp-<pid>` sibling behind; clean
    // up so no stray dotfile accumulates next to the store.
    try {
      rmSync(tmp, { force: true })
    } catch {
      // Best-effort — persistence failures stay silent by design.
    }
    return false
  }
}

/**
 * Evict entries beyond `maxEntries`, lowest count first, oldest use first
 * among equal counts. A freshly recorded entry always survives within its
 * count tier (its lastUsed is the newest of that tier).
 */
export function pruneUsageEntries(
  entries: Map<string, UsageEntry>,
  maxEntries: number = MAX_USAGE_ENTRIES,
): void {
  if (entries.size <= maxEntries) return
  const ordered = [...entries.entries()].sort(
    (a, b) => a[1].count - b[1].count || a[1].lastUsed - b[1].lastUsed,
  )
  for (let i = 0; i < ordered.length - maxEntries; i++) entries.delete(ordered[i][0])
}

/**
 * In-memory usage table persisted through `path`. Constructed once per
 * plugin fiber (so a /reload re-reads the authoritative disk state) and
 * shared by the CommandService for both recording and completion sorting.
 *
 * Several dsh processes can run concurrently against the same $DSH_HOME, so
 * persistence is baseline+delta instead of whole-table clobber: the tracker
 * remembers what the file looked like at its last synchronization and each
 * write folds only its own unsaved increments on top of a fresh read of the
 * file (see `persist`).
 */
export class CommandUsageTracker implements UsageRecorder {
  private readonly path: string
  private readonly maxEntries: number
  private readonly now: () => number
  /** Working table, including this fiber's not-yet-flushed increments. */
  private entries: Map<string, UsageEntry>
  /** Per-name counts the file had at the last successful sync — the delta zero-point. */
  private baseline: Map<string, UsageEntry>

  constructor(path: string, options?: { maxEntries?: number; now?: () => number }) {
    this.path = path
    this.maxEntries = Math.max(1, options?.maxEntries ?? MAX_USAGE_ENTRIES)
    this.now = options?.now ?? Date.now
    const loaded = loadUsageEntries(path)
    // Deep-copy into `entries`: record() mutates entry objects in place and
    // must never disturb the frozen baseline. A hand-edited or pre-cap file
    // may exceed the cap — normalize the working set on load.
    this.entries = new Map([...loaded].map(([key, entry]) => [key, { ...entry }]))
    this.baseline = loaded
    pruneUsageEntries(this.entries, this.maxEntries)
  }

  /** Count one invocation of `name` and persist synchronously (best-effort). */
  record(name: string): void {
    const key = normalizeUsageName(name)
    if (key === undefined) return
    const entry = this.entries.get(key) ?? { count: 0, lastUsed: 0 }
    entry.count += 1
    entry.lastUsed = this.now()
    this.entries.set(key, entry)
    this.persist()
  }

  /** Current name → count table for the completion sort. */
  snapshot(): UsageSnapshot {
    return new Map([...this.entries].map(([name, entry]) => [name, entry.count]))
  }

  /**
   * Fold this fiber's unsaved delta onto a fresh read of the file and write
   * the union back atomically.
   *
   * Per-name arithmetic is `file_count + (memory_count - baseline_count)`
   * clamped at zero: plain max() would drop this fiber's unsaved increments,
   * blind summing would double-count what this fiber already flushed. An
   * entry this fiber pruned away contributes a zero delta, so peer-process
   * counts survive untouched.
   *
   * Loss model: the read-modify-write below is deliberately not locked —
   * another process writing between our read and our rename loses exactly
   * that one concurrent record (bounded, single-record granularity; accepted
   * for a UX-ordering hint). If the file is unreadable/corrupt at read time,
   * the merge degrades to this fiber's own table for that pass.
   */
  private persist(): void {
    const disk = loadUsageEntries(this.path)
    const merged = new Map<string, UsageEntry>()
    for (const key of new Set([...disk.keys(), ...this.entries.keys()])) {
      const mine = this.entries.get(key)
      const baseCount = this.baseline.get(key)?.count ?? 0
      const delta = Math.max(0, (mine?.count ?? 0) - baseCount)
      const theirs = disk.get(key)
      if (theirs === undefined && delta === 0) continue
      merged.set(key, {
        count: (theirs?.count ?? 0) + delta,
        lastUsed: Math.max(theirs?.lastUsed ?? 0, mine?.lastUsed ?? 0),
      })
    }
    pruneUsageEntries(merged, this.maxEntries)
    if (!saveUsageEntries(this.path, merged)) return
    // Success: the written table becomes both the working set and the new
    // delta zero-point. `entries` gets its own copies so later in-place
    // record mutations leave the frozen baseline intact.
    this.baseline = merged
    this.entries = new Map([...merged].map(([key, entry]) => [key, { ...entry }]))
  }
}
