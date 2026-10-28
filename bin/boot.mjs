#!/usr/bin/env node
/**
 * Launcher entry behind the `dsh-tui-pi` and `dst` bin shims: boot the dsh
 * `tui` profile, running the one-time onboarding first when this machine is
 * missing any of the three pieces (dsh host, pnpm, mounted tui profile).
 *
 * Fast path — host present and profile current: no output, straight to the
 * TUI, exactly like the plain `dsh --profile tui` this replaces.
 *
 * Version follow: after `npm i -g` upgrades this package, the profile still
 * holds the old copy; the next launch (or the package's postinstall) re-runs
 * the add to move the profile to the new version. A profile that is NEWER
 * than the global install (dev-upgraded ahead) is left untouched.
 *
 * See bin/onboard-core.mjs for the setup logic and its failure contract.
 */

import { spawnSync } from 'node:child_process'
import {
  dshBinPath,
  profileBehind,
  profileMounted,
  runOnboard,
} from './onboard-core.mjs'

const args = process.argv.slice(2)

function boot(dsh) {
  const result = spawnSync(dsh, ['--profile', 'tui', ...args], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

const dsh = dshBinPath()

if (dsh && profileMounted() && !profileBehind()) {
  boot(dsh)
}

console.log('dsh-tui-pi setup (first run / upgrade only):')
const setup = runOnboard({ log: (line) => console.log(line) })
if (!setup.ok) {
  console.error(`\ndsh-tui-pi: setup stopped at "${setup.step}".`)
  console.error(`dsh-tui-pi: ${setup.hint}`)
  console.error('dsh-tui-pi: re-run dsh-tui-pi to retry once the missing piece is in place.')
  process.exit(1)
}
console.log('')
boot(setup.dsh)
