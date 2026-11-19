/**
 * bin/boot.mjs + bin/onboard-core.mjs companion-latest onboarding tests.
 * Same fake-toolchain pattern as boot-onboard.test.mjs: fake `dsh`, `npm`,
 * `pnpm` on a scratch PATH with an isolated DSH_HOME (never the real ~/.dsh).
 *
 * Scenarios:
 *   1. fresh install, default enabled → plugin add carries `pkg@<exact>` specs
 *   2. dist-tag query failure         → no exact specs, declared-range path
 *   3. DSH_TUI_COMPANION_LATEST=0     → zero dist-tag queries (through boot.mjs)
 *   4. spec add rejected by preflight → one declared-range retry, onboard OK
 *   5. self-check version mismatch    → fallback rewrites declared spec + re-checks
 *   6. fallback manifest not rewritten → re-check inconclusive, counted as fallback
 *   7. v-prefixed dist-tag             → normalized to a bare pin, no spurious self-check
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { runOnboard } from '../bin/onboard-core.mjs'

const repoRoot = join(import.meta.dirname, '..')
const repoManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const selfVersion = repoManifest.version
const PKG = '@aiwayds/dsh-tui-pi'
const COMPANIONS = Object.keys(repoManifest.dependencies).filter((name) => name.startsWith('@aiwayds/') && name !== PKG)

function testPath(...fakeDirs) {
  return [...fakeDirs, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
}

// fake npm: a `dist-tags.latest` query is logged and, by default, answered
// with DSH_FAKE_COMPANION_VERSION; the host's `dist-tags` query keeps the
// original {latest,next} shape. A failed companion query exits non-zero.
const FAKE_NPM = `#!${process.execPath}
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === 'view') {
  const pkg = args[1] ?? ''
  const field = args[2] ?? ''
  if (field === 'dist-tags.latest') {
    if (process.env.DSH_FAKE_LOG) appendFileSync(process.env.DSH_FAKE_LOG, JSON.stringify({ tool: 'npm-query', args, pkg }) + '\\n')
    if (process.env.DSH_FAKE_FAIL_COMPANION_QUERY === '1') process.exit(1)
    console.log(JSON.stringify(process.env.DSH_FAKE_COMPANION_VERSION ?? '0.21.0'))
    process.exit(0)
  }
  if (field === 'dist-tags') {
    console.log(JSON.stringify({ latest: '0.2.2-rc.2', next: '0.2.2-rc.2' }))
    process.exit(0)
  }
}
if (args[0] === 'install') process.exit(0)
if (args[0] === 'prefix') process.exit(1)
process.exit(1)
`

// fake dsh: `plugin add` writes the mounted package and, for every named spec,
// a companion manifest (so the self-check can read the version back) AND the
// matching dependency line in the profile's own package.json (so a fallback
// can be verified to have actually rewritten the pin). Every invocation is
// logged. Two failure switches:
//   DSH_FAKE_FAIL_ADD=1    — first spec add is rejected by preflight (P1-1)
//   DSH_FAKE_PIN_VERSION=X — first add installs version X regardless of spec,
//                            forcing a self-check mismatch (P1-2)
//   DSH_FAKE_FALLBACK_SPEC=X — on a fallback (re)add, write X (not the declared
//                            range) into the profile dependency line, so the
//                            value changes but the declared spec still did not
//                            land and the re-check must stay inconclusive
const FAKE_DSH = `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (process.env.DSH_FAKE_LOG) appendFileSync(process.env.DSH_FAKE_LOG, JSON.stringify({ tool: 'dsh', args }) + '\\n')
if (args[0] === '-V') { console.log(process.env.DSH_FAKE_DSH_VERSION ?? '0.2.2-rc.2'); process.exit(0) }
if (args[0] === 'plugin') {
  const at = args.indexOf('add')
  const specs = at >= 0 ? args.slice(at + 1) : []
  const profileDir = join(process.env.DSH_HOME, 'profiles', 'tui')
  const root = join(profileDir, 'node_modules')

  // Count adds so a switch can target the first (spec) add vs. a later retry.
  const stateFile = process.env.DSH_FAKE_STATE
  let count = 0
  if (stateFile && existsSync(stateFile)) count = Number(readFileSync(stateFile, 'utf8')) || 0
  count += 1
  if (stateFile) writeFileSync(stateFile, String(count))
  const first = count === 1

  // (a) host preflight compatibility rejection: install nothing, exit non-zero.
  if (first && specs.length > 0 && process.env.DSH_FAKE_FAIL_ADD === '1') {
    console.error('fake dsh: named-spec preflight rejected the install')
    process.exit(1)
  }

  const selfDir = join(root, ${JSON.stringify(PKG)})
  mkdirSync(selfDir, { recursive: true })
  writeFileSync(join(selfDir, 'package.json'), JSON.stringify({ name: ${JSON.stringify(PKG)}, version: ${JSON.stringify(selfVersion)} }))

  // Mirror pnpm: a named spec is written verbatim into the profile's
  // dependencies line. That is the pin a fallback must actually rewrite.
  const manifestPath = join(profileDir, 'package.json')
  let manifest = {}
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch {}
  if (!manifest.dependencies) manifest.dependencies = {}

  for (const spec of specs) {
    const split = spec.lastIndexOf('@')
    if (split <= 0) continue
    const name = spec.slice(0, split)
    const requested = spec.slice(split + 1)
    // On a fallback add the switch writes a DIFFERENT, non-declared value into
    // the profile dependency line. The line changes from the bad pin (which the
    // old "value changed" criterion called verified) but the declared spec
    // still did not land — the re-check must report inconclusive.
    if (!first && process.env.DSH_FAKE_FALLBACK_SPEC) {
      manifest.dependencies[name] = process.env.DSH_FAKE_FALLBACK_SPEC
    } else {
      manifest.dependencies[name] = requested
    }
    let version = requested
    if (first && process.env.DSH_FAKE_PIN_VERSION) version = process.env.DSH_FAKE_PIN_VERSION
    else if (!/^\\d/.test(version)) version = version.replace(/^[\\^~]/, '')
    if (!/^\\d/.test(version)) continue
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  process.exit(0)
}
process.exit(0)
`

const FAKE_PNPM = `#!${process.execPath}
import { appendFileSync } from 'node:fs'
if (process.env.DSH_FAKE_LOG) appendFileSync(process.env.DSH_FAKE_LOG, JSON.stringify({ tool: 'pnpm', args: process.argv.slice(2) }) + '\\n')
if (process.argv[2] === '-v') { console.log('9.0.0'); process.exit(0) }
process.exit(0)
`

let scratch

function writeFakeTools(dir) {
  const base = join(dir, `bin-${Math.random().toString(36).slice(2, 8)}`)
  const bins = { dshBin: join(base, 'dsh'), npmBin: join(base, 'npm'), pnpmBin: join(base, 'pnpm') }
  for (const [name, body] of [['dsh', FAKE_DSH], ['npm', FAKE_NPM], ['pnpm', FAKE_PNPM]]) {
    const binDir = bins[`${name}Bin`]
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, name), body, { mode: 0o755 })
  }
  return bins
}

function newScratch() {
  scratch = mkdtempSync(join(os.tmpdir(), 'tui-pi-companion-latest-'))
  mkdirSync(join(scratch, 'home'), { recursive: true })
  return scratch
}

function events() {
  const file = join(scratch, 'fake-log.jsonl')
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function pluginAdds() {
  return events().filter((e) => e.tool === 'dsh' && e.args[0] === 'plugin')
}

function queries() {
  return events().filter((e) => e.tool === 'npm-query')
}

const ENV_KEYS = [
  'PATH', 'DSH_HOME', 'DSH_FAKE_LOG', 'DSH_FAKE_COMPANION_VERSION',
  'DSH_FAKE_FAIL_COMPANION_QUERY', 'DSH_FAKE_DSH_VERSION',
  'DSH_FAKE_STATE', 'DSH_FAKE_FAIL_ADD', 'DSH_FAKE_PIN_VERSION',
  'DSH_FAKE_FALLBACK_SPEC', 'DSH_TUI_COMPANION_LATEST',
]
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

test('companion-latest: fresh install passes exact pkg@version specs to plugin add', () => {
  const saved = saveEnv()
  try {
    newScratch()
    const { dshBin, npmBin, pnpmBin } = writeFakeTools(scratch)
    process.env.DSH_HOME = join(scratch, 'home')
    process.env.PATH = testPath(dshBin, npmBin, pnpmBin)
    process.env.DSH_FAKE_LOG = join(scratch, 'fake-log.jsonl')
    process.env.DSH_FAKE_COMPANION_VERSION = '0.21.0'
    delete process.env.DSH_TUI_COMPANION_LATEST
    delete process.env.DSH_FAKE_FAIL_COMPANION_QUERY

    const lines = []
    const setup = runOnboard({ log: (line) => lines.push(line) })

    assert.equal(setup.ok, true, `onboard failed: ${JSON.stringify(setup)}`)
    const adds = pluginAdds()
    assert.equal(adds.length, 1, `expected one plugin add, got ${JSON.stringify(events())}`)
    for (const name of COMPANIONS) {
      assert.ok(adds[0].args.includes(`${name}@0.21.0`), `missing exact spec for ${name}: ${JSON.stringify(adds[0].args)}`)
      assert.ok(!adds[0].args.some((a) => a.includes('@latest')), `literal @latest must never be passed: ${JSON.stringify(adds[0].args)}`)
    }
    assert.equal(queries().length, COMPANIONS.length, 'one dist-tag query per companion')
    assert.ok(lines.some((l) => l.includes('→ 0.21.0 (latest)')), `latest line: ${lines.join('\n')}`)
    assert.ok(lines.some((l) => l.includes(`companions: ${COMPANIONS.length} latest, 0 fallback, 0 skipped`)), `summary: ${lines.join('\n')}`)
  } finally {
    restoreEnv(saved)
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('companion-latest: dist-tag query failure falls back to declared range', () => {
  const saved = saveEnv()
  try {
    newScratch()
    const { dshBin, npmBin, pnpmBin } = writeFakeTools(scratch)
    process.env.DSH_HOME = join(scratch, 'home')
    process.env.PATH = testPath(dshBin, npmBin, pnpmBin)
    process.env.DSH_FAKE_LOG = join(scratch, 'fake-log.jsonl')
    process.env.DSH_FAKE_COMPANION_VERSION = '0.21.0'
    process.env.DSH_FAKE_FAIL_COMPANION_QUERY = '1'
    delete process.env.DSH_TUI_COMPANION_LATEST

    const lines = []
    const setup = runOnboard({ log: (line) => lines.push(line) })

    assert.equal(setup.ok, true, `onboard failed: ${JSON.stringify(setup)}`)
    const adds = pluginAdds()
    assert.equal(adds.length, 1, `expected one plugin add, got ${JSON.stringify(events())}`)
    assert.deepEqual(adds[0].args, ['plugin', '--profile', 'tui', 'add', PKG], 'no exact specs on query failure')
    assert.ok(lines.some((l) => l.includes('fallback') && l.includes('(unresolved)')), `fallback line: ${lines.join('\n')}`)
    assert.ok(lines.some((l) => l.includes(`companions: 0 latest, ${COMPANIONS.length} fallback, 0 skipped`)), `summary: ${lines.join('\n')}`)
  } finally {
    restoreEnv(saved)
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('companion-latest: DSH_TUI_COMPANION_LATEST=0 sends no dist-tag query', () => {
  try {
    newScratch()
    const { dshBin, npmBin, pnpmBin } = writeFakeTools(scratch)
    const result = spawnSync(process.execPath, [join(repoRoot, 'bin', 'boot.mjs')], {
      encoding: 'utf8',
      env: {
        PATH: testPath(dshBin, npmBin, pnpmBin),
        DSH_HOME: join(scratch, 'home'),
        DSH_FAKE_LOG: join(scratch, 'fake-log.jsonl'),
        DSH_FAKE_COMPANION_VERSION: '0.21.0',
        DSH_TUI_COMPANION_LATEST: '0',
      },
      timeout: 60_000,
    })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    assert.equal(result.status, 0, `exit ${result.status}, output:\n${output}`)
    assert.equal(queries().length, 0, `no registry query expected when disabled: ${JSON.stringify(events())}`)
    const adds = pluginAdds()
    assert.equal(adds.length, 1, `expected one plugin add, got ${JSON.stringify(events())}`)
    assert.deepEqual(adds[0].args, ['plugin', '--profile', 'tui', 'add', PKG], 'declared-range path when disabled')
    assert.ok(output.includes('(disabled)'), `disabled reason on stdout: ${output}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('companion-latest: spec add rejected by preflight falls back to declared range once', () => {
  const saved = saveEnv()
  try {
    newScratch()
    const { dshBin, npmBin, pnpmBin } = writeFakeTools(scratch)
    process.env.DSH_HOME = join(scratch, 'home')
    process.env.PATH = testPath(dshBin, npmBin, pnpmBin)
    process.env.DSH_FAKE_LOG = join(scratch, 'fake-log.jsonl')
    process.env.DSH_FAKE_STATE = join(scratch, 'add-count')
    process.env.DSH_FAKE_COMPANION_VERSION = '0.21.0'
    process.env.DSH_FAKE_FAIL_ADD = '1'
    delete process.env.DSH_FAKE_PIN_VERSION
    delete process.env.DSH_FAKE_FAIL_COMPANION_QUERY
    delete process.env.DSH_TUI_COMPANION_LATEST

    const lines = []
    const setup = runOnboard({ log: (line) => lines.push(line) })

    assert.equal(setup.ok, true, `onboard should recover via declared range: ${JSON.stringify(setup)}`)
    const adds = pluginAdds()
    assert.equal(adds.length, 2, `expected spec add + declared-range retry, got ${JSON.stringify(adds)}`)
    // First add carried the exact specs — that is what got rejected.
    assert.ok(adds[0].args.includes(`${COMPANIONS[0]}@0.21.0`), `first add must carry exact specs: ${JSON.stringify(adds[0].args)}`)
    // Second add is the declared-range fallback: PKG only, no exact specs.
    assert.deepEqual(adds[1].args, ['plugin', '--profile', 'tui', 'add', PKG], `fallback must be a declared-range add: ${JSON.stringify(adds[1].args)}`)
    assert.ok(!adds[1].args.some((a) => a.includes('@0.21.0')), 'fallback must not repeat the rejected exact spec')
    assert.ok(lines.some((l) => l.includes('companion spec add failed') && l.includes('retrying declared range')), `fallback log: ${lines.join('\n')}`)
    assert.ok(lines.some((l) => l.includes(`companions: 0 latest, ${COMPANIONS.length} fallback, 0 skipped`)), `summary: ${lines.join('\n')}`)
  } finally {
    restoreEnv(saved)
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('companion-latest: self-check mismatch rewrites declared spec and re-checks', () => {
  const saved = saveEnv()
  try {
    newScratch()
    const { dshBin, npmBin, pnpmBin } = writeFakeTools(scratch)
    process.env.DSH_HOME = join(scratch, 'home')
    process.env.PATH = testPath(dshBin, npmBin, pnpmBin)
    process.env.DSH_FAKE_LOG = join(scratch, 'fake-log.jsonl')
    process.env.DSH_FAKE_STATE = join(scratch, 'add-count')
    process.env.DSH_FAKE_COMPANION_VERSION = '0.21.0'
    // First add installs 0.20.1 even though the exact spec asked for 0.21.0,
    // so the post-install self-check must fail for every companion.
    process.env.DSH_FAKE_PIN_VERSION = '0.20.1'
    delete process.env.DSH_FAKE_FAIL_ADD
    delete process.env.DSH_FAKE_FAIL_COMPANION_QUERY
    delete process.env.DSH_TUI_COMPANION_LATEST

    const lines = []
    const setup = runOnboard({ log: (line) => lines.push(line) })

    assert.equal(setup.ok, true, `onboard failed: ${JSON.stringify(setup)}`)
    const adds = pluginAdds()
    assert.equal(adds.length, 2, `expected exact add + explicit declared-spec fallback, got ${JSON.stringify(adds)}`)
    // First add: exact specs.
    for (const name of COMPANIONS) {
      assert.ok(adds[0].args.includes(`${name}@0.21.0`), `first add missing exact spec for ${name}: ${JSON.stringify(adds[0].args)}`)
    }
    // Fallback: explicit pkg@<declared range> per broken companion, not a bare add,
    // and never the bad exact pin again.
    for (const name of COMPANIONS) {
      const expected = `${name}@${repoManifest.dependencies[name]}`
      assert.ok(adds[1].args.includes(expected), `fallback must explicitly write back ${expected}: ${JSON.stringify(adds[1].args)}`)
    }
    assert.ok(!adds[1].args.some((a) => a.includes('@0.21.0')), 'fallback must not repeat the bad exact pin')
    // The profile dependency line was actually rewritten, not merely claimed.
    const profileManifest = JSON.parse(readFileSync(join(scratch, 'home', 'profiles', 'tui', 'package.json'), 'utf8'))
    for (const name of COMPANIONS) {
      assert.equal(profileManifest.dependencies[name], repoManifest.dependencies[name], `${name} dependency line must hold the declared range after fallback`)
    }
    assert.ok(lines.some((l) => l.includes('self-check failed') && l.includes('reinstalling declared range with explicit specs')), `self-check log: ${lines.join('\n')}`)
    assert.ok(lines.some((l) => l.includes('declared spec restored and verified')), `re-check log: ${lines.join('\n')}`)
    assert.ok(lines.some((l) => l.includes(`companions: 0 latest, ${COMPANIONS.length} fallback, 0 skipped`)), `summary: ${lines.join('\n')}`)
  } finally {
    restoreEnv(saved)
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('companion-latest: fallback that changes but misses declared spec is inconclusive', () => {
  const saved = saveEnv()
  try {
    newScratch()
    const { dshBin, npmBin, pnpmBin } = writeFakeTools(scratch)
    process.env.DSH_HOME = join(scratch, 'home')
    process.env.PATH = testPath(dshBin, npmBin, pnpmBin)
    process.env.DSH_FAKE_LOG = join(scratch, 'fake-log.jsonl')
    process.env.DSH_FAKE_STATE = join(scratch, 'add-count')
    process.env.DSH_FAKE_COMPANION_VERSION = '0.21.0'
    // Force a self-check mismatch so a fallback add runs.
    process.env.DSH_FAKE_PIN_VERSION = '0.20.1'
    // The fallback add succeeds and REWRITES the dependency line, but to a
    // value that is neither the bad pin (0.21.0) nor the declared range. The
    // old "value changed" criterion would wrongly call this verified.
    process.env.DSH_FAKE_FALLBACK_SPEC = '0.99.9'
    delete process.env.DSH_FAKE_FAIL_ADD
    delete process.env.DSH_FAKE_FAIL_COMPANION_QUERY
    delete process.env.DSH_TUI_COMPANION_LATEST

    const lines = []
    const setup = runOnboard({ log: (line) => lines.push(line) })

    assert.equal(setup.ok, true, `onboard failed: ${JSON.stringify(setup)}`)
    const adds = pluginAdds()
    assert.equal(adds.length, 2, `expected exact add + declared-spec fallback, got ${JSON.stringify(adds)}`)
    for (const name of COMPANIONS) {
      const expected = `${name}@${repoManifest.dependencies[name]}`
      assert.ok(adds[1].args.includes(expected), `fallback must pass ${expected}: ${JSON.stringify(adds[1].args)}`)
    }
    // The value changed (0.21.0 → 0.99.9) but is not the declared range, so
    // the re-check must NOT claim success.
    const profileManifest = JSON.parse(readFileSync(join(scratch, 'home', 'profiles', 'tui', 'package.json'), 'utf8'))
    for (const name of COMPANIONS) {
      assert.equal(profileManifest.dependencies[name], '0.99.9', `${name} fallback spec should be the non-declared value from the shim`)
      assert.notEqual(profileManifest.dependencies[name], repoManifest.dependencies[name], `${name} declared spec should be absent from manifest`)
    }
    assert.ok(lines.some((l) => l.includes('fallback re-check inconclusive') && l.includes('declared spec not reflected in profile manifest')), `inconclusive log: ${lines.join('\n')}`)
    assert.ok(!lines.some((l) => l.includes('declared spec restored and verified')), `must not claim verified: ${lines.join('\n')}`)
    assert.ok(lines.some((l) => l.includes(`companions: 0 latest, ${COMPANIONS.length} fallback, 0 skipped`)), `summary: ${lines.join('\n')}`)
  } finally {
    restoreEnv(saved)
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('companion-latest: v-prefixed dist-tag normalized to bare pin without spurious self-check', () => {
  const saved = saveEnv()
  try {
    newScratch()
    const { dshBin, npmBin, pnpmBin } = writeFakeTools(scratch)
    process.env.DSH_HOME = join(scratch, 'home')
    process.env.PATH = testPath(dshBin, npmBin, pnpmBin)
    process.env.DSH_FAKE_LOG = join(scratch, 'fake-log.jsonl')
    // Registry hands back a v-prefixed dist-tag; onboarding must strip the v.
    process.env.DSH_FAKE_COMPANION_VERSION = 'v0.21.0'
    delete process.env.DSH_FAKE_PIN_VERSION
    delete process.env.DSH_FAKE_SKIP_MANIFEST
    delete process.env.DSH_FAKE_FAIL_ADD
    delete process.env.DSH_FAKE_FAIL_COMPANION_QUERY
    delete process.env.DSH_TUI_COMPANION_LATEST

    const lines = []
    const setup = runOnboard({ log: (line) => lines.push(line) })

    assert.equal(setup.ok, true, `onboard failed: ${JSON.stringify(setup)}`)
    assert.equal(queries().length, COMPANIONS.length, 'one dist-tag query per companion')
    const adds = pluginAdds()
    assert.equal(adds.length, 1, `normalized version must not trigger a fallback re-add: ${JSON.stringify(adds)}`)
    for (const name of COMPANIONS) {
      assert.ok(adds[0].args.includes(`${name}@0.21.0`), `spec must be bare 0.21.0 for ${name}: ${JSON.stringify(adds[0].args)}`)
      assert.ok(!adds[0].args.some((a) => a === `${name}@v0.21.0`), `spec must not carry the v prefix for ${name}`)
    }
    assert.ok(lines.some((l) => l.includes('→ 0.21.0 (latest)')), `normalized latest line: ${lines.join('\n')}`)
    assert.ok(!lines.some((l) => l.includes('self-check failed')), `v prefix must not cause a spurious self-check failure: ${lines.join('\n')}`)
    assert.ok(!lines.some((l) => l.includes('inconclusive')), `no inconclusive expected: ${lines.join('\n')}`)
    // Final profile: both installed version and manifest spec are the bare pin.
    const profileManifest = JSON.parse(readFileSync(join(scratch, 'home', 'profiles', 'tui', 'package.json'), 'utf8'))
    for (const name of COMPANIONS) {
      const installed = JSON.parse(readFileSync(join(scratch, 'home', 'profiles', 'tui', 'node_modules', name, 'package.json'), 'utf8'))
      assert.equal(installed.version, '0.21.0', `${name} installed version must be bare 0.21.0`)
      assert.equal(profileManifest.dependencies[name], '0.21.0', `${name} manifest spec must be bare 0.21.0`)
    }
    assert.ok(lines.some((l) => l.includes(`companions: ${COMPANIONS.length} latest, 0 fallback, 0 skipped`)), `summary: ${lines.join('\n')}`)
  } finally {
    restoreEnv(saved)
    rmSync(scratch, { recursive: true, force: true })
  }
})
