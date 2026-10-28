#!/usr/bin/env node
/**
 * npm postinstall for `@aiwayds/dsh-tui-pi` — two jobs, in order:
 *
 * 1. The repo's dev linker (link-dsh-closure.mjs). It self-guards: on a
 *    published tarball (no src/) it exits 0 without touching anything, so
 *    this is a no-op for consumers and the dev-machine behavior is
 *    unchanged.
 *
 * 2. Global installs then run the one-time onboarding — dsh host, pnpm and
 *    the `tui` profile are in place by the time npm prints "added 1
 *    package", so the first `dsh-tui-pi` (or `dst`) boots straight into the
 *    TUI. Anything this cannot finish (offline machine, no npm on PATH, a
 *    package manager that skips lifecycle scripts) is deferred to the
 *    launcher's first run, which re-runs the same idempotent onboarding.
 *
 * Guards:
 *   - local/dev installs (`npm i` inside a project, `pnpm link`, CI
 *     checkouts) skip the onboarding silently — it is only meaningful for a
 *     user-wide install;
 *   - this script NEVER fails the install: every failure path exits 0.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))

// 1) dev closure linker — self-guarding, always safe to run
const linker = spawnSync(process.execPath, [join(scriptDir, 'link-dsh-closure.mjs')], {
  stdio: 'inherit',
})
if (linker.error) {
  console.warn(`[postinstall] closure linker skipped: ${linker.error.message}`)
}

// 2) onboarding — global installs only, never fails the install
if (process.env.npm_config_global !== 'true') process.exit(0)

console.log('dsh-tui-pi: preparing the dsh host, pnpm and the "tui" profile…')
try {
  const { runOnboard } = await import('../bin/onboard-core.mjs')
  const setup = runOnboard({ log: (line) => console.log(line) })
  if (!setup.ok) {
    console.log(`dsh-tui-pi: setup stopped at "${setup.step}" — ${setup.hint}`)
    console.log('dsh-tui-pi: it will complete automatically on first launch.')
  } else {
    console.log('dsh-tui-pi: ready — launch with `dsh-tui-pi` (short: `dst`).')
  }
} catch (error) {
  console.log(`dsh-tui-pi: setup skipped (${error?.message ?? error}) — it will run on first launch.`)
}
process.exit(0)
