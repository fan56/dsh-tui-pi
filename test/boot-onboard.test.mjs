/**
 * bin/boot.mjs + bin/onboard-core.mjs first-launch onboarding tests. Since
 * the postinstall hook was removed (ADR 0004 — pnpm 11 strictDepBuilds
 * refuses dependency install scripts), the bin's first launch is the only
 * onboarding entry point; these tests pin its contract with fake `dsh`,
 * `npm` and `pnpm` shims on a scratch PATH and an isolated DSH_HOME under
 * /private/tmp (a fake host must never touch the real ~/.dsh).
 *
 * Scenarios:
 *   1. profile missing (dsh present)  → runOnboard calls `dsh plugin --profile
 *      tui add` exactly once, then reports ready
 *   2. dsh missing + host install fails → three plain-language lines on
 *      stderr, exit 1, no stack trace (driven through the real bin/boot.mjs)
 *   3. npm missing                     → the Node.js install hint, exit 1
 *   4. pnpm missing + install fails    → the step hint, no profile work
 *   5. profile behind                  → profile updated exactly once
 *   6. profile current                 → profile left untouched ("already set
 *      up", zero add invocations)
 *   7. fast path (dsh + profile ready) → real bin path boots with no setup
 *      banner (scenario 7 goes through the actual bin/boot.mjs)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runOnboard } from '../bin/onboard-core.mjs'

const repoRoot = join(import.meta.dirname, '..')
const repoManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const selfVersion = repoManifest.version
const PKG = '@aiwayds/dsh-tui-pi'
const HOST = '@deepseek-ai/dsh'

// ---------------------------------------------------------------------------
// fake toolchain
// ---------------------------------------------------------------------------

let scratch

// Minimal, machine-independent PATH: the fake bins under test, this Node's
// bin dir (the fake shims exec the exact interpreter), and the base system
// dirs. Deliberately NOT the ambient ${PATH} — a dev/CI machine may carry a
// real `pnpm`/`npm`/`dsh`, which would silently break a "X missing" premise.
function testPath(...fakeDirs) {
  return [...fakeDirs, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
}

// The fake `dsh`: `-V` prints a host version; `plugin --profile tui add`
// mounts the plugin (writes/updates the profile's package.json) and records
// the invocation; anything else is a boot and exits 0.
const FAKE_DSH = `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (process.env.DSH_FAKE_LOG) appendFileSync(process.env.DSH_FAKE_LOG, JSON.stringify({ tool: 'dsh', args }) + '\\n')
if (args[0] === '-V') { console.log(process.env.DSH_FAKE_DSH_VERSION ?? '0.2.2-rc.2'); process.exit(0) }
if (args[0] === 'plugin') {
  const dir = join(process.env.DSH_HOME, 'profiles', 'tui', 'node_modules', ${JSON.stringify(PKG)})
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: ${JSON.stringify(PKG)}, version: ${JSON.stringify(selfVersion)} }))
  process.exit(0)
}
process.exit(0)
`

// The fake `npm`: `view <pkg> dist-tags --json` prints a dist-tag map;
// `install -g <pkg>` fails when DSH_FAKE_FAIL_INSTALL names that package or
// is `*`; everything else (e.g. `prefix -g`) fails so the dsh-lookup
// fallback stands down.
const FAKE_NPM = `#!${process.execPath}
const args = process.argv.slice(2)
const fail = process.env.DSH_FAKE_FAIL_INSTALL ?? ''
if (args[0] === 'install') {
  const bare = (args[2] ?? '').replace(/@[^@]+$/, '')
  if (fail === '*' || fail === bare) process.exit(1)
  process.exit(0)
}
if (args[0] === 'view') {
  console.log(JSON.stringify({ latest: '0.2.2-rc.2', next: '0.2.2-rc.2' }))
  process.exit(0)
}
process.exit(1)
`

// The fake `pnpm`: `-v` prints a version.
const FAKE_PNPM = `#!${process.execPath}
import { appendFileSync } from 'node:fs'
if (process.env.DSH_FAKE_LOG) appendFileSync(process.env.DSH_FAKE_LOG, JSON.stringify({ tool: 'pnpm', args: process.argv.slice(2) }) + '\\n')
if (process.argv[2] === '-v') { console.log('9.0.0'); process.exit(0) }
process.exit(0)
`

// `dir` is explicit (never an implicit module-level scratch) so call order
// between newScratch() and writeFakeTools() cannot matter.
function writeFakeTools(dir, { failInstall = '' } = {}) {
  const base = join(dir, `bin-${Math.random().toString(36).slice(2, 8)}`)
  const bins = { dshBin: join(base, 'dsh'), npmBin: join(base, 'npm'), pnpmBin: join(base, 'pnpm') }
  for (const [name, body] of [['dsh', FAKE_DSH], ['npm', FAKE_NPM], ['pnpm', FAKE_PNPM]]) {
    const dir = bins[`${name}Bin`]
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), body, { mode: 0o755 })
  }
  return { ...bins, failInstall }
}

// Fresh isolated scratch home under /private/tmp (never the real ~/.dsh).
function newScratch() {
  scratch = mkdtempSync('/private/tmp/tui-pi-boot-onboard-')
  mkdirSync(join(scratch, 'home'), { recursive: true })
  return scratch
}

function fakeLog() {
  const file = join(scratch, 'fake-log.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function pluginAdds() {
  return fakeLog().filter((e) => e.tool === 'dsh' && e.args[0] === 'plugin')
}

function profileManifestPath() {
  return join(scratch, 'home', 'profiles', 'tui', 'node_modules', PKG, 'package.json')
}

function mountProfile(version) {
  const dir = join(scratch, 'home', 'profiles', 'tui', 'node_modules', PKG)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PKG, version }))
}

// Mount a dev-style profile: the plugin dir is a symlink to a source outside
// DSH_HOME, so host-guard's dev-mount rule (warn, never fatal) applies and
// the fast path proceeds to boot.
function mountProfileAsDevLink() {
  const src = join(scratch, 'plugin-src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: PKG, version: selfVersion }))
  const dir = join(scratch, 'home', 'profiles', 'tui', 'node_modules', PKG)
  mkdirSync(join(dir, '..'), { recursive: true })
  symlinkSync(src, dir, 'dir')
}

// Save/restore the ambient env the direct-runOnboard scenarios mutate.
const ENV_KEYS = ['PATH', 'DSH_HOME', 'DSH_FAKE_LOG', 'DSH_FAKE_FAIL_INSTALL', 'DSH_FAKE_DSH_VERSION']
function saveEnv() {
  const saved = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  return saved
}
function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

test('boot-onboard: profile missing (dsh present) — plugin add called exactly once, then ready', () => {
  const saved = saveEnv()
  try {
    newScratch()
    const { dshBin, npmBin, pnpmBin } = writeFakeTools(scratch)
    process.env.DSH_HOME = join(scratch, 'home')
    process.env.PATH = testPath(dshBin, npmBin, pnpmBin)
    process.env.DSH_FAKE_LOG = join(scratch, 'fake-log.jsonl')

    const lines = []
    const setup = runOnboard({ log: (line) => lines.push(line) })

    assert.equal(setup.ok, true, `onboard failed: ${JSON.stringify(setup)}`)
    const adds = pluginAdds()
    assert.equal(adds.length, 1, `expected exactly one plugin add, got ${JSON.stringify(fakeLog())}`)
    assert.deepEqual(adds[0].args, ['plugin', '--profile', 'tui', 'add', PKG])
    assert.ok(lines.some((l) => l.includes('[1/3] dsh host') && l.includes('found')), `step 1 line: ${lines.join('\n')}`)
    assert.ok(lines.some((l) => l.includes('[3/3] tui profile') && l.includes('done')), `step 3 line: ${lines.join('\n')}`)
  } finally {
    restoreEnv(saved)
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('boot-onboard: dsh missing + host install fails — three plain lines on stderr, exit 1, no stack', () => {
  try {
    newScratch()
    const { npmBin } = writeFakeTools(scratch)
    const result = spawnSync(process.execPath, [join(repoRoot, 'bin', 'boot.mjs')], {
      encoding: 'utf8',
      env: {
        PATH: testPath(npmBin), // npm only — no dsh, no pnpm
        DSH_HOME: join(scratch, 'home'),
        DSH_FAKE_LOG: join(scratch, 'fake-log.jsonl'),
        DSH_FAKE_FAIL_INSTALL: '*',
      },
      timeout: 60_000,
    })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    assert.equal(result.status, 1, `exit ${result.status}, output:\n${output}`)
    const errLines = (result.stderr ?? '').split('\n').filter((l) => l.trim())
    assert.equal(errLines.length, 3, `expected exactly three plain lines on stderr, got:\n${result.stderr}`)
    assert.ok(output.includes('setup stopped at "dsh host install"'), `output:\n${output}`)
    assert.ok(output.includes('npm install -g'), `hint line missing:\n${output}`)
    assert.ok(!/Error:\s/.test(output), `stack/error leaked:\n${output}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('boot-onboard: npm missing — Node.js hint, exit 1', () => {
  try {
    newScratch()
    const emptyBin = join(scratch, 'empty-bin')
    mkdirSync(emptyBin)
    const result = spawnSync(process.execPath, [join(repoRoot, 'bin', 'boot.mjs')], {
      encoding: 'utf8',
      env: { PATH: emptyBin, DSH_HOME: join(scratch, 'home') },
      timeout: 60_000,
    })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    assert.equal(result.status, 1, `exit ${result.status}, output:\n${output}`)
    assert.ok(output.includes('setup stopped at "npm"'), `output:\n${output}`)
    assert.ok(output.includes('install Node.js'), `Node.js hint missing:\n${output}`)
    assert.ok(!/Error:\s/.test(output), `stack/error leaked:\n${output}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('boot-onboard: pnpm missing + install fails — step hint, no profile work', () => {
  const saved = saveEnv()
  try {
    newScratch()
    const { dshBin, npmBin } = writeFakeTools(scratch)
    process.env.DSH_HOME = join(scratch, 'home')
    process.env.PATH = testPath(dshBin, npmBin)
    process.env.DSH_FAKE_LOG = join(scratch, 'fake-log.jsonl')
    process.env.DSH_FAKE_FAIL_INSTALL = 'pnpm'

    const setup = runOnboard()

    assert.equal(setup.ok, false)
    assert.equal(setup.step, 'pnpm install')
    assert.ok(setup.hint.includes('npm install -g pnpm'), `hint: ${setup.hint}`)
    assert.equal(pluginAdds().length, 0, 'no profile work may happen after pnpm fails')
  } finally {
    restoreEnv(saved)
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('boot-onboard: profile behind — profile updated exactly once', () => {
  const saved = saveEnv()
  try {
    newScratch()
    const { dshBin, npmBin, pnpmBin } = writeFakeTools(scratch)
    mountProfile('0.0.1') // older than the running package
    process.env.DSH_HOME = join(scratch, 'home')
    process.env.PATH = testPath(dshBin, npmBin, pnpmBin)
    process.env.DSH_FAKE_LOG = join(scratch, 'fake-log.jsonl')

    const setup = runOnboard()

    assert.equal(setup.ok, true, `onboard failed: ${JSON.stringify(setup)}`)
    const adds = pluginAdds()
    assert.equal(adds.length, 1, `expected exactly one update add, got ${JSON.stringify(fakeLog())}`)
    assert.equal(JSON.parse(readFileSync(profileManifestPath(), 'utf8')).version, selfVersion, 'mounted profile moved to the running version')
  } finally {
    restoreEnv(saved)
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('boot-onboard: profile current — untouched, zero add invocations', () => {
  const saved = saveEnv()
  try {
    newScratch()
    const { dshBin, npmBin, pnpmBin } = writeFakeTools(scratch)
    mountProfile(selfVersion)
    process.env.DSH_HOME = join(scratch, 'home')
    process.env.PATH = testPath(dshBin, npmBin, pnpmBin)
    process.env.DSH_FAKE_LOG = join(scratch, 'fake-log.jsonl')

    const lines = []
    const setup = runOnboard({ log: (line) => lines.push(line) })

    assert.equal(setup.ok, true)
    assert.equal(pluginAdds().length, 0, `profile must not be touched, got ${JSON.stringify(fakeLog())}`)
    assert.ok(lines.some((l) => l.includes('[3/3] tui profile') && l.includes('already set up')), `step 3 line: ${lines.join('\n')}`)
  } finally {
    restoreEnv(saved)
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('boot-onboard: fast path (dsh + profile ready) — real bin boots with no setup banner', () => {
  try {
    newScratch()
    mountProfileAsDevLink()
    const { dshBin, npmBin, pnpmBin } = writeFakeTools(scratch)
    const bootLog = join(scratch, 'boot-log.jsonl')
    const result = spawnSync(process.execPath, [join(repoRoot, 'bin', 'boot.mjs')], {
      encoding: 'utf8',
      env: {
        PATH: testPath(dshBin, npmBin, pnpmBin),
        DSH_HOME: join(scratch, 'home'),
        DSH_FAKE_LOG: bootLog,
      },
      timeout: 60_000,
    })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    assert.equal(result.status, 0, `exit ${result.status}, output:\n${output}`)
    assert.ok(!output.includes('setup (first run'), `setup banner on the fast path:\n${output}`)
    const events = readFileSync(bootLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const boots = events.filter((e) => e.tool === 'dsh' && e.args[0] !== 'plugin' && e.args[0] !== '-V')
    assert.ok(boots.length >= 1, `the fake dsh never booted: ${bootLog}`)
    assert.deepEqual(boots[0].args, ['--profile', 'tui'], `boot args: ${JSON.stringify(boots[0].args)}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
