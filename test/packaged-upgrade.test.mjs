// npm packaged upgrade regression. The package carries NO install hook at
// all — the historical `postinstall` was removed because pnpm 11's
// strictDepBuilds validation refuses a dependency whose install script is
// not approved (ERR_PNPM_IGNORED_BUILDS), rolling back the user's update;
// onboarding is carried entirely by the bin's first launch instead (see
// docs/adr/0004-onboarding-first-launch-not-postinstall.md, same background
// as the sibling plugin repos in dsh-subagent-registry#10). The published
// 2.38.0 baseline still carries the hook (historical fixture) — this test
// installs that baseline, then replaces it with the locally packed tarball
// and asserts the new package declares no install hook, ships no hook
// script, still carries its bin entry points, upgrades with exit 0 and no
// unapproved-build report, and leaves the consumer tree alone.
// Run: node test/packaged-upgrade.test.mjs  (after `npm run build`; needs
// network access to registry.npmjs.org for the baseline)
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
// Windows needs cmd.exe to launch npm's .cmd shim; keep paths as separate arguments.
const npm = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm'
const npmArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd'] : []
const pkgName = '@aiwayds/dsh-tui-pi'
const registry = 'https://registry.npmjs.org'
const baselineVersion = '2.38.0'
// Install hooks pnpm 11 gates; the stripped package must declare none of them.
const absentHooks = ['preinstall', 'install', 'postinstall']

if (!existsSync(join(repoRoot, 'lib', 'index.js'))) {
  throw new Error('lib/index.js missing — run `npm run build` before the test chain')
}

const repoManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const repoVersion = repoManifest.version
const repoBins = Object.values(repoManifest.bin ?? {})

const scratch = mkdtempSync(join(tmpdir(), 'tui-pi packaged upgrade-'))
try {
  const consumer = join(scratch, 'consumer')
  const installedDir = join(consumer, 'node_modules', '@aiwayds', 'dsh-tui-pi')
  const installedManifest = () => JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))

  // 1. Baseline: the published release, pinned to the official registry so a
  //    dev mirror does not decide the fixture. 2.38.0 still carries the
  //    historical postinstall — that hook predates the pnpm 11 strip (ADR 0004).
  const baseline = spawnSync(
    npm,
    [...npmArgs, 'install', `${pkgName}@${baselineVersion}`, '--prefix', consumer, '--no-audit', '--no-fund', '--loglevel=error', `--registry=${registry}`],
    { cwd: scratch, encoding: 'utf8' },
  )
  assert.equal(baseline.status, 0, `baseline ${baselineVersion} install failed:\n${baseline.stdout}\n${baseline.stderr}`)
  const base = installedManifest()
  assert.equal(base.version, baselineVersion, `baseline fixture is ${baselineVersion}`)
  assert.equal(
    base.scripts.postinstall,
    'node scripts/postinstall.mjs',
    `baseline ${baselineVersion} carries the historical postinstall hook (fixture)`,
  )

  // 2. Pack the repo the way CI's release job does. The tarball name comes
  //    from the filesystem, not stdout: a lifecycle hook's log line would
  //    corrupt `--json` output. A dedicated empty directory keeps the result
  //    unambiguous.
  const packDir = join(scratch, 'pack')
  mkdirSync(packDir)
  execFileSync(npm, [...npmArgs, 'pack', '--pack-destination', packDir], { cwd: repoRoot, encoding: 'utf8' })
  const tarballs = readdirSync(packDir).filter((f) => f.endsWith('.tgz'))
  assert.equal(tarballs.length, 1, `pack emitted exactly one tarball, got ${tarballs.join(', ') || 'none'}`)
  const tarball = join(packDir, tarballs[0])

  // 3. Tarball contents: the bin entries ship, the hook script does not, and
  //    the manifest declares no install hook at all.
  const contents = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split(/\r?\n/)
  assert.ok(!contents.includes('package/scripts/postinstall.mjs'), 'postinstall script ships in no tarball path')
  for (const bin of repoBins) {
    assert.ok(contents.includes(`package/${bin}`), `bin entry ${bin} ships in the tarball`)
  }
  const tarManifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  assert.equal(tarManifest.version, repoVersion, `packed version is the repo version (${repoVersion})`)
  for (const key of absentHooks) {
    assert.ok(!Object.hasOwn(tarManifest.scripts, key), `tarball manifest carries no ${key} script`)
  }
  assert.deepEqual(tarManifest.bin, repoManifest.bin, 'bin map is carried unchanged')
  assert.equal(tarManifest.dsh.bundle.patch, './cordis.patch.yml', 'bundle patch still declared')

  // 4. Replace the baseline with the packed build, lifecycle scripts enabled.
  //    npm still runs whatever hooks the manifest declares — there are none,
  //    so nothing can report an unapproved-build gate; the upgrade must exit
  //    clean with no pnpm-11 style report in the output.
  const upgrade = spawnSync(
    npm,
    [...npmArgs, 'install', tarball, '--prefix', consumer, '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: scratch, encoding: 'utf8' },
  )
  const output = `${upgrade.stdout ?? ''}\n${upgrade.stderr ?? ''}`
  assert.equal(upgrade.status, 0, `installing the packed ${repoVersion} over ${baselineVersion} failed:\n${output}`)
  assert.ok(
    !/ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(output),
    `install output carries a pnpm-11 unapproved-build report:\n${output}`,
  )

  const upgraded = installedManifest()
  assert.equal(upgraded.version, repoVersion, `tarball install landed ${repoVersion}`)
  for (const key of absentHooks) {
    assert.ok(!Object.hasOwn(upgraded.scripts, key), `installed manifest carries no ${key} script`)
  }
  assert.ok(!existsSync(join(installedDir, 'scripts', 'postinstall.mjs')), 'installed package ships no hook script')
  for (const bin of repoBins) {
    assert.ok(existsSync(join(installedDir, bin)), `installed package carries the bin entry ${bin}`)
  }
  assert.ok(existsSync(join(installedDir, 'bin', 'onboard-core.mjs')), 'installed package ships the shared onboarding core (first-launch onboarding, ADR 0004)')
  assert.ok(existsSync(join(installedDir, 'cordis.patch.yml')), 'bundle patch ships')
  assert.ok(existsSync(join(installedDir, 'lib', 'index.js')), 'plugin entry ships')

  // 5. Consumer safety: the self-guarding linker stood down (a published
  //    tarball has no src/), and no optional host SDK peer materialized a
  //    second copy.
  assert.ok(
    !existsSync(join(installedDir, 'node_modules', '@deepseek-ai')),
    'linker did not touch the consumer tree (guard markers held)',
  )
  assert.ok(
    !existsSync(join(consumer, 'node_modules', '@deepseek-ai')),
    'optional host SDK peers did not install a consumer-side copy',
  )
  console.log(
    `packaged-upgrade: ${baselineVersion} → packed ${repoVersion} installs cleanly with no install hook (onboarding carried by first launch, ADR 0004)`,
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
