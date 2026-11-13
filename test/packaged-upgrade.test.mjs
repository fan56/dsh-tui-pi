// npm packaged upgrade regression. The `postinstall` hook is intentional here
// (a self-guarding dev closure linker plus one-shot onboarding for global
// installs; it never fails the install) — unlike the sibling plugin repos,
// where pnpm 11's strictDepBuilds validation refuses a dependency whose
// install script is not approved (ERR_PNPM_IGNORED_BUILDS) and the published
// package therefore carries no install hook at all. This test pins the npm
// upgrade path with the hook in place: install the published baseline, then
// replace it with the locally packed tarball and assert the new package still
// declares the hook, still ships its script and entry points, and still
// leaves the consumer tree alone. See dsh-subagent-registry#10 for the pnpm
// 11 background.
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
// The install hook that pnpm 11 gates and that this package keeps on purpose.
const intentionalHook = 'postinstall'
const absentHooks = ['preinstall', 'install']

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
  //    dev mirror does not decide the fixture. The baseline must already
  //    carry the intentional postinstall — it is the hook this test protects.
  const baseline = spawnSync(
    npm,
    [...npmArgs, 'install', `${pkgName}@${baselineVersion}`, '--prefix', consumer, '--no-audit', '--no-fund', '--loglevel=error', `--registry=${registry}`],
    { cwd: scratch, encoding: 'utf8' },
  )
  assert.equal(baseline.status, 0, `baseline ${baselineVersion} install failed:\n${baseline.stdout}\n${baseline.stderr}`)
  const base = installedManifest()
  assert.equal(base.version, baselineVersion, `baseline fixture is ${baselineVersion}`)
  assert.equal(
    base.scripts[intentionalHook],
    'node scripts/postinstall.mjs',
    `baseline ${baselineVersion} carries the intentional postinstall hook (fixture)`,
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

  // 3. Tarball contents: the hook target and the bin entries ship, and the
  //    manifest keeps the intentional postinstall while carrying no other
  //    install hook.
  const contents = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split(/\r?\n/)
  assert.ok(contents.includes('package/scripts/postinstall.mjs'), 'postinstall target ships in the tarball')
  for (const bin of repoBins) {
    assert.ok(contents.includes(`package/${bin}`), `bin entry ${bin} ships in the tarball`)
  }
  const tarManifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  assert.equal(tarManifest.version, repoVersion, `packed version is the repo version (${repoVersion})`)
  assert.equal(
    typeof tarManifest.scripts[intentionalHook],
    'string',
    'tarball manifest keeps the intentional postinstall hook',
  )
  assert.equal(tarManifest.scripts[intentionalHook], 'node scripts/postinstall.mjs', 'postinstall points at scripts/postinstall.mjs')
  for (const key of absentHooks) {
    assert.ok(!Object.hasOwn(tarManifest.scripts, key), `tarball manifest carries no ${key} script`)
  }
  assert.deepEqual(tarManifest.bin, repoManifest.bin, 'bin map is carried unchanged')
  assert.equal(tarManifest.dsh.bundle.patch, './cordis.patch.yml', 'bundle patch still declared')

  // 4. Replace the baseline with the packed build, lifecycle scripts enabled.
  //    npm does not gate install hooks (pnpm 11 does), so postinstall runs;
  //    it must exit clean and must not report an unapproved-build gate.
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
  assert.equal(
    typeof upgraded.scripts[intentionalHook],
    'string',
    'installed manifest keeps the intentional postinstall hook',
  )
  for (const key of absentHooks) {
    assert.ok(!Object.hasOwn(upgraded.scripts, key), `installed manifest carries no ${key} script`)
  }
  assert.ok(existsSync(join(installedDir, 'scripts', 'postinstall.mjs')), 'installed package carries the hook target')
  for (const bin of repoBins) {
    assert.ok(existsSync(join(installedDir, bin)), `installed package carries the bin entry ${bin}`)
  }
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
    `packaged-upgrade: ${baselineVersion} → packed ${repoVersion} installs cleanly with the intentional postinstall preserved`,
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
