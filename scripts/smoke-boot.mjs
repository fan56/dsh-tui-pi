#!/usr/bin/env node
// Boot-smoke: mount the freshly built plugin into a scratch dsh profile
// (bundle patch + packed tarball) and boot it with the real dsh CLI.
//
//   0. tsc build (the tarball must carry a fresh lib/)
//   1. npm pack the repo → tarball
//   2. scratch $DSH_HOME/profiles/smoke with the plugin as a file: dep and a
//      dsh.profile.bundles entry (same shape as the user's real profiles)
//   3. pnpm install
//   4. `dsh --profile smoke --dump-config` must compose the plugin into the
//      tree (mount/patch-layer proof), disable the stock projection-cache
//      row and mount the projcache wrapper in its place
//   5. a legacy session_projcache record (the 0.1.1-rc.2 shape that the
//      alpha.4 schema fail-fasts on) is seeded into the scratch home; the
//      boot below must migrate it, not crash on it
//   6. a real boot under a timeout must load the plugin tree without a
//      loader error (a healthy boot is silent and survives to the kill
//      signal; a broken plugin dies within ~1s with the loader error), and
//      the seeded record must come out backfilled + backed up
//
// The boot runs piped (no TTY). Verified empirically: the TUI plugin's
// apply() tolerates a non-terminal (pi-tui guards raw mode), so the piped
// boot is a valid load proof without dragging a pty shim into CI.
//
// Exit 0 = mounted and boots clean. Temp dir is kept and printed on failure,
// removed on success.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const ownName = pkg.name // @aiwayds/dsh-tui-pi

const work = mkdtempSync(path.join(tmpdir(), 'dsh-tui-pi-smoke-'))
const home = path.join(work, 'dsh-home')
const profile = path.join(home, 'profiles', 'smoke')
mkdirSync(profile, { recursive: true })

function fail(message, output = '') {
  console.error(`smoke-boot: FAIL — ${message}`)
  if (output) console.error(output.split('\n').slice(0, 30).join('\n'))
  console.error(`smoke-boot: scratch kept at ${work}`)
  process.exit(1)
}

// Phase 0 — build: the pack must ship the current source, not a stale lib/.
const build = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8' })
if (build.status !== 0 || build.error) fail('tsc build failed', `${build.stdout}\n${build.stderr}`)

const pack = spawnSync('npm', ['pack', '--pack-destination', work], { cwd: repoRoot, encoding: 'utf8' })
if (pack.status !== 0 || pack.error) fail('npm pack failed', `${pack.stdout}\n${pack.stderr}`)
const tarball = path.join(work, pack.stdout.trim().split('\n').at(-1))

writeFileSync(path.join(profile, 'cordis.yml'), '# dsh profile root — empty; the tree is composed from the bundle patches\n[]\n')
writeFileSync(path.join(profile, 'cordis.patch.yml'), '# scratch smoke profile: no extra patch layer\n[]\n')
writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-smoke',
  private: true,
  dependencies: {
    [ownName]: `file:${tarball}`,
  },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        ownName,
      ],
    },
  },
}, null, 2) + '\n')

const install = spawnSync('pnpm', ['install'], { cwd: profile, encoding: 'utf8' })
if (install.status !== 0 || install.error) fail('pnpm install in the scratch profile failed', `${install.stdout}\n${install.stderr}`)

const dshEnv = { ...process.env, DSH_HOME: home, TERM: process.env.TERM ?? 'xterm-256color' }

// Phase 1 — mount proof: the composed tree must include the plugin, disable
// the stock projection-cache row and mount the projcache wrapper instead.
const dump = spawnSync('dsh', ['--profile', 'smoke', '--dump-config'], { cwd: profile, encoding: 'utf8', env: dshEnv })
if (dump.status !== 0 || dump.error) fail('dsh --dump-config failed on the scratch profile', `${dump.stdout}\n${dump.stderr}`)
if (!dump.stdout.includes(ownName)) {
  fail(`the composed profile tree does not contain ${ownName} — the bundle patch insert is broken`, dump.stdout)
}
if (!/id: session-projection-cache[\s\S]*?disabled: true/.test(dump.stdout)) {
  fail('the stock session-projection-cache row is not disabled — the wrapper would race a second mount', dump.stdout)
}
if (!dump.stdout.includes('tui-pi-projcache')) {
  fail('the projcache wrapper entry is missing from the composed tree — legacy records would crash the boot', dump.stdout)
}

// Phase 1.5 — seed a legacy projection-cache record: the 0.1.1-rc.2 shape
// lacks the identity fields the alpha.4 schema requires. The boot in phase 2
// must migrate it (lib/projcache.js, module-evaluation time) instead of
// dying on it at storage-open.
const sessionsDir = path.join(home, 'storages', 'session_projcache', 'sessions')
mkdirSync(sessionsDir, { recursive: true })
const legacyName = 'session-smoke-legacy.json'
const legacyOriginal = JSON.stringify({
  identity: { createdAt: 1756000000000, cwd: '/tmp/smoke' },
  events: [{ seq: 1 }],
}, null, 2)
writeFileSync(path.join(sessionsDir, legacyName), legacyOriginal)

// Phase 2 — boot proof: the plugin tree must LOAD without a loader error.
const bootSeconds = 25
const boot = spawnSync('dsh', ['--profile', 'smoke'], {
  cwd: profile,
  encoding: 'utf8',
  timeout: bootSeconds * 1000,
  killSignal: 'SIGKILL',
  env: dshEnv,
})
const output = `${boot.stdout ?? ''}\n${boot.stderr ?? ''}`
const loaderErrors = [
  /plugin tree failed to load/,
  /failed to apply loader entry/,
  /does not match its schema/,
  /cannot get property ".*" without inject/,
  /cannot get required service/,
  /Cannot find (package|module)/,
]
const hit = loaderErrors.filter((re) => re.test(output))
if (hit.length > 0) {
  fail('the real host failed to load the plugin tree:', output.split('\n').filter((line) => hit.some((re) => re.test(line)) || /Error/.test(line)).slice(0, 15).join('\n'))
}
if (boot.error !== undefined && boot.error.code !== 'ETIMEDOUT') {
  fail(`boot runner failed to start: ${boot.error.message}`)
}
// Timed out with the process still alive (SIGKILL delivered) is the healthy
// outcome alongside a clean exit 0.
const survived = boot.signal === 'SIGKILL' || boot.error?.code === 'ETIMEDOUT'
if (!survived && boot.status !== 0) {
  fail(`dsh exited early with code ${boot.status} and no loader error — unexpected`, output)
}

// Phase 3 — rescue proof: the seeded legacy record must have been backfilled
// by the wrapper before the stock plugin could open the domain, with the
// original bytes backed up next to it.
const legacyNow = path.join(sessionsDir, legacyName)
const backups = (() => {
  try {
    return readdirSync(sessionsDir).filter((n) => n.startsWith(`${legacyName}.bak-preflight-`))
  } catch {
    return []
  }
})()
if (!backups.length) {
  fail('the seeded legacy record was never migrated — the wrapper did not run at module-evaluation time', output)
}
let migrated
try {
  migrated = JSON.parse(readFileSync(legacyNow, 'utf8'))
} catch (err) {
  fail(`the migrated legacy record is unparsable: ${err.message}`)
}
if (migrated.identity?.isSeeded !== false || migrated.identity?.inheritedEventCount !== 0) {
  fail('the seeded legacy record survived the boot without being backfilled', JSON.stringify(migrated.identity))
}

console.log(`smoke-boot: PASS — ${ownName} composed into the scratch profile tree and booted clean in real dsh (${survived ? `survived the ${bootSeconds}s boot window` : `exited ${boot.status}`}); the seeded legacy projection-cache record was migrated with a backup`)
rmSync(work, { recursive: true, force: true })
