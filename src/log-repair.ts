/**
 * Corrupted-resume-log repair orchestration — the /resume safety net.
 *
 * When a persisted session's log was forked by a historical double-writer
 * (two dsh processes appending to one jsonl), the loader refuses it with
 * "corrupt session log: seq gap …" and /resume dead-ends. The offline
 * surgery itself lives in scripts/repair-session-log.mjs (deterministic
 * dedupe + dense renumbering; the original is NEVER modified there). This
 * module is the TUI-free bridge around it: it runs the script, verifies the
 * result, and — only after an explicit user confirmation upstream — swaps
 * the repaired copy in beside a kept backup, under the single-writer lock.
 *
 * Contract of the script (its own header is authoritative):
 *   exit 0 → the log is CLEAN (nothing written), or — with --apply — a
 *            `<stem>.repaired.jsonl[.zstd]` artifact was written BESIDE the
 *            original (the CLEAN verdict line distinguishes the two);
 *   exit 3 → corrupt diagnosed, nothing written (dry-run only by contract);
 *   exit 2 → usage/environment error (missing zstd, torn lines without
 *            --skip-bad-lines, …).
 *
 * Safety invariants (all enforced here, testable without a terminal):
 * - The original log is never edited in place — swapping moves it aside to
 *   `<name>.corrupt-bak` first and only then renames the verified repaired
 *   copy over the canonical name.
 * - A repaired copy that does not itself verify CLEAN is never swapped in.
 * - The writer lock beside the log (<sessionDir>/writer.lock, same file the
 *   cold arms and the feishu guard compete on) is claimed for the whole
 *   apply→verify→swap window and always released, success or not.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { chmodSync, existsSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { SESSION_LOG_FILE_NAMES } from './retention.ts'
import {
  acquireWriterLock,
  projectKeyFor,
  releaseOwnedWriterLock,
  type WriterLockHolder,
} from './writer-lock.ts'

/** The repair script rides the published package (`files` includes scripts/). */
export function repairScriptPath(): string {
  return new URL('../scripts/repair-session-log.mjs', import.meta.url).pathname
}

/** Hard wall-clock budget for one script invocation (big logs still finish; a hung zstd must not freeze /resume). */
export const REPAIR_TIMEOUT_MS = 120_000

/** Injection point for tests: the spawnSync signature runRepair shells out through. */
export type SpawnSyncFn = typeof spawnSync

/** Outcome of one script invocation, mapped from its exit contract. */
export type RepairRunResult =
  /** The log needs no repair (script printed the CLEAN verdict). */
  | { status: 'clean' }
  /** With --apply: the repaired artifact exists beside the (untouched) log. */
  | { status: 'repaired'; repairedPath: string; detail: string }
  | { status: 'failed'; detail: string }

export interface RunRepairOptions {
  /** Write the `<stem>.repaired.*` artifact (dry-run diagnosis otherwise). */
  apply?: boolean
  /** Test seam — defaults to the real child_process.spawnSync. */
  spawnSyncFn?: SpawnSyncFn
}

/**
 * The path the repair script writes its artifact to (mirrors the script's
 * own `<stem>.repaired.jsonl[.zstd]` naming, stem = name minus the jsonl[.zstd]
 * suffix). Exported so tests and callers can predict the artifact location.
 */
export function repairedArtifactPath(logPath: string): string {
  const isZstd = /\.jsonl\.zstd$/.test(logPath)
  const stem = basename(logPath).replace(/\.jsonl(\.zstd)?$/, '')
  return join(dirname(logPath), `${stem}.repaired.jsonl${isZstd ? '.zstd' : ''}`)
}

function firstLine(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l !== '')
  return line ?? ''
}

/**
 * Run scripts/repair-session-log.mjs against one log. Never touches the log
 * itself (the script cannot); classifies the outcome per the exit contract
 * above. A missing zstd binary surfaces as the script's exit 2 — or, should
 * the spawn itself fail with ENOENT, as a failed result with an install hint.
 */
export function runRepair(logPath: string, options: RunRepairOptions = {}): RepairRunResult {
  const apply = options.apply ?? false
  const spawn = options.spawnSyncFn ?? spawnSync
  let proc: SpawnSyncReturns<string>
  try {
    proc = spawn(
      process.execPath,
      [repairScriptPath(), logPath, ...(apply ? ['--apply'] : [])],
      { encoding: 'utf8', timeout: REPAIR_TIMEOUT_MS, maxBuffer: 1 << 26 },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'failed', detail: `cannot run the repair script: ${message}` }
  }
  if (proc.error !== undefined) {
    const code = (proc.error as NodeJS.ErrnoException).code
    const hint = code === 'ENOENT' ? ' — is zstd installed and on PATH?' : ''
    return {
      status: 'failed',
      detail: `cannot run the repair script: ${proc.error.message}${hint}`,
    }
  }
  const out = proc.stdout ?? ''
  const err = proc.stderr ?? ''
  if (proc.status === 0) {
    // Exit 0 is ambiguous by contract (CLEAN vs. repaired+written); the
    // CLEAN verdict line disambiguates without guessing at files.
    if (out.includes('verdict: CLEAN')) return { status: 'clean' }
    const repairedPath = repairedArtifactPath(logPath)
    if (existsSync(repairedPath)) {
      return { status: 'repaired', repairedPath, detail: firstLine(out) }
    }
    return {
      status: 'failed',
      detail: 'repair script exited 0 but wrote no repaired artifact beside the log',
    }
  }
  if (proc.status === 3) {
    // By the script's contract exit 3 means "corrupt, dry-run, nothing
    // written" — with --apply this is a contract violation, but either way
    // there is nothing to swap in, so it is a failure for our caller.
    return {
      status: 'failed',
      detail: firstLine(out) || 'log is corrupt — the script diagnosed it without writing a repair',
    }
  }
  return {
    status: 'failed',
    detail: firstLine(err) || `repair script exited ${proc.status ?? 'by signal'}`,
  }
}

/** Result of a dry-run verification pass over any log file. */
export type VerifyResult = { ok: true } | { ok: false; detail: string }

/**
 * Verify one log loads clean (dry-run diagnosis, never writes). Used on the
 * repaired artifact BEFORE it replaces the canonical log.
 */
export function verifyClean(logPath: string, options: RunRepairOptions = {}): VerifyResult {
  const run = runRepair(logPath, { ...options, apply: false })
  return run.status === 'clean' ? { ok: true } : { ok: false, detail: run.detail }
}

export interface SwapOptions {
  /** Test seam — defaults to the real fs.chmodSync. */
  chmodFn?: typeof chmodSync
}

/**
 * Swap the verified repaired copy in over the canonical log name: the
 * original moves aside to `<name>.corrupt-bak` (suffixed with the epoch
 * millisecond when that name is taken — never overwritten), the repaired
 * copy takes its place with owner-only permissions, matching the store's
 * private-file hygiene. Synchronous on purpose: the swap window sits under
 * the writer lock and must be a tight rename-rename pair. A failed swap-in
 * restores the original best-effort (mirroring the feishu surface) before
 * rethrowing, so the session is never stranded without its canonical log.
 */
export function swapRepaired(logPath: string, repairedPath: string, options: SwapOptions = {}): { backupPath: string } {
  let backupPath = `${logPath}.corrupt-bak`
  try {
    statSync(backupPath)
    backupPath = `${backupPath}.${Date.now()}`
  } catch {
    // Free — the plain .corrupt-bak name is ours.
  }
  renameSync(logPath, backupPath)
  try {
    renameSync(repairedPath, logPath)
  } catch (error) {
    // Best-effort restore first — the canonical name must not stay missing
    // with the original parked in the backup; the rethrow is the signal.
    try {
      renameSync(backupPath, logPath)
    } catch {
      // Nothing further is recoverable here; the caller reports the swap
      // failure and the .corrupt-bak copy still holds the original.
    }
    throw error
  }
  try {
    ;(options.chmodFn ?? chmodSync)(logPath, 0o600)
  } catch {
    // Permissions are store hygiene, not log integrity: the swap already
    // succeeded, so a chmod failure never flips the outcome. A later
    // successful repair (or any manual chmod) fixes the mode.
  }
  return { backupPath }
}

/** Outcome of the guarded end-to-end repair of one session log. */
export type RepairSessionResult =
  /** The verified repaired copy replaced the corrupt log; the original is at `backupPath`. */
  | { kind: 'repaired'; backupPath: string }
  /** The log turned out to need no repair (e.g. the corruption self-healed) — nothing was swapped. */
  | { kind: 'clean' }
  /** Another live process drives this session; nothing was touched. */
  | { kind: 'locked'; holder: WriterLockHolder }
  | { kind: 'failed'; detail: string }

export interface RepairSessionOptions {
  /** Test seam handed down to runRepair/verifyClean. */
  spawnSyncFn?: SpawnSyncFn
  /** Test seam handed down to swapRepaired. */
  chmodFn?: typeof chmodSync
}

/**
 * End-to-end repair of one session log, under the single-writer lock beside
 * it: claim → apply → verify the repaired copy → swap → release. ANY failure
 * leaves the canonical log untouched, releases the lock, and reports
 * {kind:'failed'}; only a verified artifact is ever swapped in. The lock dir
 * is the log's own directory — the same `<sessionDir>/writer.lock` the cold
 * arms and the feishu guard compete on.
 */
export async function repairSessionLog(
  logPath: string,
  options: RepairSessionOptions = {},
): Promise<RepairSessionResult> {
  const dir = dirname(logPath)
  let claim: { ok: true } | { ok: false; holder: WriterLockHolder }
  try {
    claim = await acquireWriterLock(dir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'failed', detail: `cannot claim the writer lock: ${message}` }
  }
  if (!claim.ok) return { kind: 'locked', holder: claim.holder }
  try {
    const run = runRepair(logPath, { apply: true, spawnSyncFn: options.spawnSyncFn })
    if (run.status === 'failed') return { kind: 'failed', detail: run.detail }
    if (run.status === 'clean') return { kind: 'clean' }
    const verdict = verifyClean(run.repairedPath, options)
    if (!verdict.ok) {
      return {
        kind: 'failed',
        detail: `the repaired copy still fails verification: ${verdict.detail}`,
      }
    }
    return {
      kind: 'repaired',
      backupPath: swapRepaired(logPath, run.repairedPath, options).backupPath,
    }
  } catch (error) {
    // swapRepaired restored the original best-effort before rethrowing; map
    // the residue to a plain failure so no exception ever escapes toward the
    // command dispatch — this module's contract is results, not throws.
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'failed', detail: `swap failed: ${message}` }
  } finally {
    await releaseOwnedWriterLock(dir)
  }
}

/**
 * The /resume corrupt-log fingerprint: the loader's "corrupt session log:
 * seq gap …" refusal, plus the raw-decompression twin ("corrupt zstandard
 * log"). Case-insensitive; anything else (locked session, missing
 * persistence, network) must NOT route into the repair flow.
 */
const CORRUPT_LOG_PATTERN = /corrupt .*(session|zstandard) log/i

export function isCorruptLogError(message: string): boolean {
  return CORRUPT_LOG_PATTERN.test(message)
}

/**
 * User-facing notice for a repair attempt that did NOT swap anything;
 * undefined when the flow should proceed to resume ('repaired' | 'clean').
 * Pure so the wording is testable without a terminal (English-only).
 */
export function repairFailureNotice(result: RepairSessionResult): string | undefined {
  if (result.kind === 'locked') {
    return `session is driven by pid ${result.holder.pid} — close it on the other side first`
  }
  if (result.kind === 'failed') {
    return `repair failed: ${result.detail} — log untouched`
  }
  return undefined
}

/** Minimal structural view of the persistence seam (headers only). */
interface PersistenceHeadersSeam {
  list?: () => Promise<Array<{ id: unknown; cwd?: unknown }>>
}

/**
 * Locate one session's canonical log file on disk the same way the
 * single-writer guard derives it: `<root>/<projectKeyFor(cwd)>/<sessionId>/<name>`,
 * with the cwd taken from the persisted header list (the log lives under
 * THAT project key). Best-effort: no header, no cwd, or no log file under
 * the derived dir yields undefined — the caller reports a failure instead
 * of repairing a decoy. When both suffixes coexist (a kept raw copy beside
 * the compressed log) the compressed name wins: it is what the writer
 * appends to and what the loader reads.
 */
export async function locateSessionLog(
  persistence: PersistenceHeadersSeam | undefined,
  sessionId: string,
  root: string,
): Promise<string | undefined> {
  let cwd: string | undefined
  try {
    const stored = (await persistence?.list?.().catch(() => [])) ?? []
    const header = stored.find(candidate => String(candidate.id) === sessionId)
    if (typeof header?.cwd === 'string' && header.cwd !== '') cwd = header.cwd
  } catch {
    return undefined
  }
  if (cwd === undefined) return undefined
  const dir = join(root, projectKeyFor(cwd), sessionId)
  for (const name of SESSION_LOG_FILE_NAMES.slice().reverse()) {
    const file = join(dir, name)
    try {
      statSync(file)
      return file
    } catch {
      // Not this suffix — try the next one.
    }
  }
  return undefined
}
