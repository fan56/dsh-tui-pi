/**
 * Single-writer guard — a vendored, zero-dependency per-session pid-file
 * lock, byte-for-byte the same contract the feishu plugin's guard uses so
 * both surfaces compete on one file.
 *
 * Why it exists: two dsh processes pointed at the same profile each keep
 * their own agent registry; `agents.get` cannot see the other process's
 * live agent. A cold resume there therefore forks the log: two agents
 * append to one jsonl and the interleaved seq numbers make the loader
 * reject the session ("corrupt session log"). The lock sits NEXT to the
 * log (`<sessionDir>/writer.lock`), derived with the exact path encoding
 * upstream's jsonl backend uses, so every process about to create or
 * cold-resume competes on the same file.
 *
 * Claiming protocol (concurrency-critical):
 * - The payload is written FULLY to `<lock>.tmp-<pid>-<uniq>` first, then
 *   claimed with `link(2)` — atomic at the kernel level, never writable
 *   half-way, so no observer can read an empty/partial lock file.
 * - Two processes that both judge the same residue dead cannot both win:
 *   they race ONE link(); the loser sees EEXIST and re-evaluates against
 *   the WINNER's fresh live pid, then refuses. Stealing (renaming the dead
 *   residue aside) is merely garbage collection of readable history — the
 *   exclusive right is granted by link(), not by who cleared what.
 * - PID reuse can misreport a dead lock as alive; removing such a residual
 *   stays an explicit manual act (delete the file), never automatic.
 */

import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'

/** Who holds the lock, as recorded inside the file. */
export interface WriterLockHolder {
  readonly pid: number
  /** ISO timestamp written at creation time (informational). */
  readonly createdAt: string
  /** Logical owner label (`'tui'` here; `'feishu'` in the mirror module). */
  readonly holder: string
}

export type WriterLockAcquisition =
  | { ok: true }
  | { ok: false; holder: WriterLockHolder }

/** Thrown when a cold arm refused to open a second writer for a session. */
export class WriterLockedError extends Error {
  readonly holder: WriterLockHolder

  constructor(holder: WriterLockHolder) {
    super(
      `session is locked by a live process (pid ${holder.pid}`
      + `${holder.createdAt !== '' ? `, since ${holder.createdAt}` : ''})`
      + ' — refusing to fork the log',
    )
    this.name = 'WriterLockedError'
    this.holder = holder
  }
}

const LOCK_HOLDER = 'tui'
/** Contention budget across residue-clearing rounds before giving up loudly. */
const MAX_CLAIM_ROUNDS = 4

/**
 * Dirs where THIS process established (created or stole) the lock. Only an
 * establishing acquisition may release the file: a cooperative re-acquire
 * (same pid already recorded) inherits it without removal rights.
 */
const established = new Set<string>()

export function writerLockPath(dir: string): string {
  return join(dir, 'writer.lock')
}

/**
 * Project-directory name under which the jsonl backend groups a cwd's
 * sessions — byte-identical port of upstream `projectKey()` in
 * @deepseek-ai/dsh-session-persistence-jsonl (also mirrored by the feishu
 * plugin's guard). The derived session dir additionally relies on upstream's
 * `encodeSegment(sessionId)` being the IDENTITY for dsh ids — true while ids
 * are UUIDs (safe charset ⊇ UUID charset). If upstream ever introduces
 * non-UUID ids, port encodeSegment too or locks land beside decoy paths;
 * update only in lockstep with upstream either way.
 */
export function projectKeyFor(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user — alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readHolder(path: string): Promise<WriterLockHolder | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WriterLockHolder>
    if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0) return undefined
    return {
      pid: parsed.pid as number,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      holder: typeof parsed.holder === 'string' ? parsed.holder : LOCK_HOLDER,
    }
  } catch {
    return undefined
  }
}

/**
 * Fully write the payload to a private temp file, then CLAIM the lock name
 * with link() — atomic: exactly one contender wins; everyone else gets
 * EEXIST and re-reads whoever actually holds the name. Returns true iff WE
 * claimed it (and thus own its release).
 */
async function claimFresh(path: string): Promise<boolean> {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  await writeFile(tmp, JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    holder: LOCK_HOLDER,
  } satisfies WriterLockHolder))
  try {
    try {
      await link(tmp, path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

async function clearResidue(path: string): Promise<void> {
  try {
    await rename(path, `${path}.stale-${Date.now()}-${randomBytes(3).toString('hex')}`)
  } catch (error) {
    // Another contender cleared (or replaced) it already — harmless; the
    // caller simply loops and re-reads the CURRENT state of the name.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * Acquire the single-writer lock for `dir`. Fresh creation or a cleared
 * residue establishes ownership (releasable later); a same-pid token is a
 * cooperative re-acquire — success WITHOUT rewriting the existing file and
 * without release rights. A lock held by another LIVE process refuses with
 * its holder info.
 */
export async function acquireWriterLock(dir: string): Promise<WriterLockAcquisition> {
  await mkdir(dir, { recursive: true })
  const path = writerLockPath(dir)
  for (let round = 0; round < MAX_CLAIM_ROUNDS; round++) {
    if (await claimFresh(path)) {
      established.add(resolve(dir))
      return { ok: true }
    }
    const holder = await readHolder(path)
    if (holder !== undefined && holder.pid === process.pid) {
      // Cooperative re-acquire: inherit, do not rewrite, never releasable.
      return { ok: true }
    }
    if (holder !== undefined && processAlive(holder.pid)) {
      return { ok: false, holder }
    }
    // Dead-or-corrupt-or-raced-away holder: collect the residue and re-try
    // the atomic claim; any live winner introduced meanwhile is re-read and
    // respected on the next round.
    await clearResidue(path)
  }
  fail(`writer.lock contention did not settle after ${MAX_CLAIM_ROUNDS} rounds: ${path}`)
}

function fail(message: string): never {
  throw new Error(message)
}

/**
 * Release the lock on `dir`, but ONLY when this process established it.
 * A cooperative/inherited token — or a dir we never touched — is untouched.
 */
export async function releaseOwnedWriterLock(dir: string): Promise<void> {
  const key = resolve(dir)
  if (!established.delete(key)) return
  try {
    await unlink(writerLockPath(dir))
  } catch {
    // Already gone (or raced away) — nothing left to clean.
  }
}
