#!/usr/bin/env node
/**
 * Launcher entry behind the `dsh-tui-pi` and `dst` bin shims: boot the dsh
 * `tui` profile, running the one-time onboarding first when this machine is
 * missing any of the three pieces (dsh host, pnpm, mounted tui profile).
 *
 * Fast path — host present and profile current: no output, straight to the
 * TUI, exactly like the plain `dsh --profile tui` this replaces. One check
 * runs first (bin/host-guard.mjs): the mounted plugin must resolve the host
 * packages it imports to the running host's own copies — a stray copy inside
 * the profile would otherwise die at loader time with an unactionable
 * SyntaxError, so the guard stops with the paths and the removal commands.
 *
 * Version follow: after `npm i -g` upgrades this package, the profile still
 * holds the old copy; the next launch (or the package's postinstall) re-runs
 * the add to move the profile to the new version. A profile that is NEWER
 * than the global install (dev-upgraded ahead) is left untouched.
 *
 * See bin/onboard-core.mjs for the setup logic and its failure contract.
 */

import { spawnSync } from 'node:child_process'
import { checkHostPackages } from './host-guard.mjs'
import {
  dshBinPath,
  dshHome,
  profileBehind,
  profileMounted,
  profilePluginDir,
  runOnboard,
} from './onboard-core.mjs'

const args = process.argv.slice(2)

function boot(dsh) {
  const result = spawnSync(dsh, ['--profile', 'tui', ...args], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

const dsh = dshBinPath()

if (dsh && profileMounted() && !profileBehind()) {
  const guard = checkHostPackages({
    pluginDir: profilePluginDir(),
    dshBin: dsh,
    dshHome: dshHome(),
    log: (line) => console.error(line),
  })
  if (!guard.ok) process.exit(1)
  boot(dsh)
}

console.log('dsh-tui-pi setup (first run / upgrade only):')
const setup = runOnboard({ log: (line) => console.log(line) })
if (!setup.ok) {
  console.error(`\ndsh-tui-pi: setup stopped at "${setup.step}".`)
  console.error(`dsh-tui-pi: ${setup.hint}`)
  process.exit(1)
}
console.log('')
boot(setup.dsh)
