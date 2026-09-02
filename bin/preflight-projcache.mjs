#!/usr/bin/env node
/**
 * Preflight migration for the dsh `session_projcache` storage domain.
 *
 * Background: dsh 0.1.2-alpha.4 extends the session-projection-cache record
 * schema with `identity.isSeeded: boolean` and `identity.inheritedEventCount:
 * number`. The boot plugin tree opens the storage domain (allSettled, no
 * migrate hook) and fail-fast validates those fields — records written by
 * older dsh builds (0.1.1-rc.2 era) lack them, so the whole dsh process dies
 * with a bare stack trace before the TUI ever mounts. This script runs from
 * the launcher (bin/dsh-tui-pi) before `exec dsh` and backfills the two
 * fields on every legacy record under
 *
 *   <DSH_HOME>/storages/session_projcache/sessions/session-*.json
 *
 * - records that already carry both fields are left byte-identical (no IO);
 * - every changed record is backed up next to the original, then rewritten
 *   atomically (tmp file + rename);
 * - the script NEVER blocks startup: any unexpected error is swallowed with
 *   a one-line stderr warning and a 0 exit code.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKFILL = { isSeeded: false, inheritedEventCount: 0 }

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function backupPathFor(file) {
  const stamp = new Date().toISOString()
  let candidate = `${file}.bak-preflight-${stamp}`
  for (let n = 2; fs.existsSync(candidate); n++) {
    candidate = `${file}.bak-preflight-${stamp}-${n}`
  }
  return candidate
}

/**
 * Backfill missing identity fields on every session-*.json record under dir.
 * Returns { checked, fixed } — `fixed` counts records rewritten (or, in
 * check mode, records that would be rewritten). Unparsable records are
 * warned about on stderr and skipped.
 */
export function preflightProjcache(dir, { check = false } = {}) {
  const result = { checked: 0, fixed: 0 }
  if (!fs.existsSync(dir)) return result

  for (const name of fs.readdirSync(dir)) {
    if (!/^session-.*\.json$/.test(name)) continue
    const file = path.join(dir, name)
    if (!fs.statSync(file).isFile()) continue
    result.checked++

    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      process.stderr.write(`[preflight-projcache] unreadable ${name}: ${err?.message ?? err}\n`)
      continue
    }
    let obj
    try {
      obj = JSON.parse(text)
    } catch {
      process.stderr.write(`[preflight-projcache] skipping unparsable ${name}\n`)
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
      process.stderr.write(`[preflight-projcache] failed to rewrite ${name}: ${err?.message ?? err}\n`)
    }
  }
  return result
}

function isMainEntry() {
  try {
    return Boolean(process.argv[1])
      && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

function main() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions')
  const check = process.argv.includes('--check')
  const { fixed } = preflightProjcache(dir, { check })
  if (check) process.stdout.write(`${fixed} session_projcache record(s) need migration\n`)
}

// Run the CLI shell only when executed directly — importing this module
// (from the tests) must have no side effects.
if (isMainEntry()) {
  try {
    main()
  } catch (err) {
    // Never block startup: a preflight failure is a warning, not an error.
    process.stderr.write(`[preflight-projcache] skipped: ${err?.message ?? err}\n`)
  }
  process.exit(0)
}
