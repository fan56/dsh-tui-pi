/**
 * session_projcache record migration, shared by both mount points:
 *
 * - `bin/preflight-projcache.mjs` — the CLI shell the `dsh-tui-pi` launcher
 *   runs before `exec dsh` (covers users starting through the launcher);
 * - `src/projcache.ts` — the wrapper module the bundle patch mounts in place
 *   of the stock `session-projection-cache` row (covers every `dsh --profile
 *   tui` boot, launcher or not).
 *
 * The dsh 0.1.2-alpha.4 projection-cache schema hard-requires
 * `identity.isSeeded: boolean` and `identity.inheritedEventCount: number`;
 * records written by 0.1.1-rc.2-era hosts lack those fields and fail zod
 * validation at storage-open time (`invalid-record`), which crashes the
 * whole boot. The migration backfills exactly the missing fields, backs up
 * every rewritten file next to the original, and always fails open — any
 * error is a stderr warning, never a startup blocker.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BACKFILL = { isSeeded: false, inheritedEventCount: 0 } as const

export interface PreflightResult {
  checked: number
  fixed: number
}

export interface PreflightOptions {
  /** Report what would change without touching anything. */
  check?: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function warn(message: string): void {
  process.stderr.write(`[preflight-projcache] ${message}\n`)
}

/**
 * The per-record sessions directory the stock plugin's storage domain opens
 * at boot: `<DSH_HOME || ~/.dsh>/storages/session_projcache/sessions`.
 */
export function projcacheSessionsDir(home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')): string {
  return path.join(home, 'storages', 'session_projcache', 'sessions')
}

function backupPathFor(file: string): string {
  const stamp = new Date().toISOString()
  let candidate = `${file}.bak-preflight-${stamp}`
  for (let n = 2; fs.existsSync(candidate); n++) {
    candidate = `${file}.bak-preflight-${stamp}-${n}`
  }
  return candidate
}

/**
 * Backfill missing identity fields on every `session-*.json` record in
 * `dir`. Already-migrated records are left byte-identical (no backup, no
 * rewrite); unparsable or unreadable records are warned about and skipped;
 * rewrite failures roll that record's count back and warn. Never throws for
 * per-record problems — only a catastrophic `dir` scan failure propagates,
 * and both callers catch it.
 */
export function preflightProjcache(dir: string, { check = false }: PreflightOptions = {}): PreflightResult {
  const result = { checked: 0, fixed: 0 }
  if (!fs.existsSync(dir)) return result

  for (const name of fs.readdirSync(dir)) {
    if (!/^session-.*\.json$/.test(name)) continue
    const file = path.join(dir, name)
    if (!fs.statSync(file).isFile()) continue
    result.checked++

    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      warn(`unreadable ${name}: ${errorMessage(err)}`)
      continue
    }
    let obj: unknown
    try {
      obj = JSON.parse(text)
    } catch {
      warn(`skipping unparsable ${name}`)
      continue
    }
    if (!isPlainObject(obj)) continue

    let identity = obj.identity
    if (identity === undefined) {
      identity = {}
      obj.identity = identity
    }
    if (!isPlainObject(identity)) continue

    let changed = false
    for (const [field, value] of Object.entries(BACKFILL)) {
      if (identity[field] === undefined) {
        identity[field] = value
        changed = true
      }
    }
    if (!changed) continue

    result.fixed++
    if (check) continue
    try {
      fs.writeFileSync(backupPathFor(file), text)
      const migrated = JSON.stringify(obj, null, 2) + (text.endsWith('\n') ? '\n' : '')
      const tmp = `${file}.tmp-preflight-${process.pid}`
      fs.writeFileSync(tmp, migrated)
      fs.renameSync(tmp, file)
    } catch (err) {
      result.fixed--
      warn(`failed to rewrite ${name}: ${errorMessage(err)}`)
    }
  }
  return result
}
