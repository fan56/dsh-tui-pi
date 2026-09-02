#!/usr/bin/env node
/**
 * Preflight migration for the dsh `session_projcache` storage domain — CLI
 * shell around the shared core (lib/preflight-projcache.js, built from
 * src/preflight-projcache.ts). The `dsh-tui-pi` launcher (bin/dsh-tui-pi)
 * runs this before `exec dsh`. This is one of two mount points for the
 * migration; the other is lib/projcache.js, the wrapper module the bundle
 * patch mounts in place of the stock session-projection-cache row, so plain
 * `dsh --profile tui` boots are covered without the launcher.
 *
 * Contract (unchanged since 2.0.1):
 *   - scans <DSH_HOME||~/.dsh>/storages/session_projcache/sessions/session-*.json
 *   - backfills identity.isSeeded:false / identity.inheritedEventCount:0
 *   - records that already carry both fields are left byte-identical (no IO);
 *   - every changed record is backed up next to the original, then rewritten
 *     atomically (tmp file + rename);
 *   - per-record problems warn on stderr and never abort the scan;
 *   - ALWAYS exits 0: a preflight failure must never block startup.
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { preflightProjcache, projcacheSessionsDir } from '../lib/preflight-projcache.js'

function isMainEntry() {
  try {
    return Boolean(process.argv[1])
      && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

// Run the CLI shell only when executed directly — importing this module
// must have no side effects.
if (isMainEntry()) {
  try {
    const check = process.argv.includes('--check')
    const { fixed } = preflightProjcache(projcacheSessionsDir(), { check })
    if (check) process.stdout.write(`${fixed} session_projcache record(s) need migration\n`)
  } catch (err) {
    // Never block startup: a preflight failure is a warning, not an error.
    process.stderr.write(`[preflight-projcache] skipped: ${err?.message ?? err}\n`)
  }
  process.exit(0)
}
