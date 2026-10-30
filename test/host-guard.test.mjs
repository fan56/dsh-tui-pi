/**
 * Unit + launcher tests for the fast-path host-package guard
 * (bin/host-guard.mjs, wired in bin/boot.mjs): the HOST_PACKAGES list stays
 * in lockstep with what the compiled plugin imports; a profile-resident copy
 * older than the host's is a plain-language stop with removal commands; the
 * ambiguous states (dev checkout mounts, newer copies, an unreadable host
 * side) only warn; and the launcher itself exits 1 before spawning dsh.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HOST_PACKAGES, checkHostPackages, hostRootFromBin } from '../bin/host-guard.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const selfVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
const HOST_VERSION = '0.2.1-rc.5'
const PLUGIN = '@aiwayds/dsh-tui-pi'

// Resolution and the guard's output use real paths; macOS's tmpdir is a
// symlink (/var → /private/var), so expectations are built from the real one.
function scratch(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writePkg(dir, name, version) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }))
  writeFileSync(join(dir, 'index.js'), '')
}

// A synthetic dsh home: the shared closure tree with every host package at
// HOST_VERSION, and the tui profile with this plugin mounted as a real
// directory (the published-tarball layout, not a dev link).
function makeHome(t, { shared = true } = {}) {
  const home = scratch(t, 'tui-pi-host-guard-')
  const profileRoot = join(home, 'profiles', 'tui')
  const pluginDir = join(profileRoot, 'node_modules', ...PLUGIN.split('/'))
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: PLUGIN, version: selfVersion }))
  writeFileSync(join(profileRoot, 'package.json'), JSON.stringify({
    name: 'dsh-profile-tui',
    private: true,
    dependencies: { [PLUGIN]: selfVersion },
  }))
  if (shared) {
    for (const name of HOST_PACKAGES) {
      writePkg(join(home, 'profiles', 'node_modules', ...name.split('/')), name, HOST_VERSION)
    }
  }
  return { home, profileRoot, pluginDir }
}

function addStray({ profileRoot, pluginDir }, name, version, { nested = false, listed = false } = {}) {
  const base = nested ? join(pluginDir, 'node_modules') : join(profileRoot, 'node_modules')
  const dir = join(base, ...name.split('/'))
  writePkg(dir, name, version)
  if (listed) {
    const manifest = join(profileRoot, 'package.json')
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    pkg.dependencies[name] = version
    writeFileSync(manifest, JSON.stringify(pkg))
  }
  return dir
}

function run(home, extra = {}) {
  const lines = []
  const result = checkHostPackages({
    pluginDir: home.pluginDir,
    dshHome: home.home,
    log: (line) => lines.push(line),
    ...extra,
  })
  return { ...result, text: lines.join('\n') }
}

function* jsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* jsFiles(path)
    else if (entry.name.endsWith('.js')) yield path
  }
}

test('HOST_PACKAGES equals the @deepseek-ai packages the compiled plugin imports at runtime', () => {
  const seen = new Set()
  const spec = /(?:from\s*|import\s*\(\s*)['"](@deepseek-ai\/[a-z0-9-]+)['"]/g
  for (const file of jsFiles(join(repoRoot, 'lib'))) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(spec)) seen.add(match[1])
  }
  assert.deepEqual([...seen].sort(), [...HOST_PACKAGES].sort())
  assert.deepEqual(HOST_PACKAGES, [...HOST_PACKAGES].sort(), 'list is kept sorted for stable output')
})

test('healthy profile: every package resolves to the shared closure copy, no output', (t) => {
  const home = makeHome(t)
  const r = run(home)
  assert.equal(r.ok, true)
  assert.equal(r.fatal.length, 0)
  assert.equal(r.warnings.length, 0)
  assert.equal(r.text, '')
})

test('a 0.0.1 stub shadowing the host copy is a fatal stop naming both copies and the pnpm remove', (t) => {
  const home = makeHome(t)
  const stray = addStray(home, '@deepseek-ai/dsh-llm', '0.0.1-rc.1', { listed: true })
  const r = run(home)
  assert.equal(r.ok, false)
  assert.equal(r.fatal.length, 1)
  assert.equal(r.fatal[0].name, '@deepseek-ai/dsh-llm')
  assert.equal(r.fatal[0].kind, 'shadowed')
  assert.equal(r.fatal[0].ancient, true)
  assert.equal(r.fatal[0].resolved.version, '0.0.1-rc.1')
  assert.equal(r.fatal[0].intended.version, HOST_VERSION)
  assert.match(r.text, /cannot boot cleanly/)
  assert.ok(r.text.includes(stray), 'names the stray copy path')
  assert.match(r.text, /the host ships:\s+0\.2\.1-rc\.5/)
  assert.match(r.text, /`latest` dist-tag at a 0\.0\.1 placeholder/)
  assert.ok(r.text.includes(`cd ${home.profileRoot} && pnpm remove @deepseek-ai/dsh-llm`))
  assert.ok(r.text.includes(`dsh plugin --profile tui add ${PLUGIN}`))
})

test('a stale (not stub) copy that is not a declared dependency gets rm -rf, not the stub explainer', (t) => {
  const home = makeHome(t)
  const stray = addStray(home, '@deepseek-ai/dsh-session', '0.2.1-rc.4')
  const r = run(home)
  assert.equal(r.ok, false)
  assert.equal(r.fatal[0].ancient, false)
  assert.match(r.text, /A stale copy inside the profile shadows the host's own/)
  assert.doesNotMatch(r.text, /placeholder/)
  assert.ok(r.text.includes(`rm -rf ${stray}`))
})

test('a copy nested under the plugin itself is found first and reported the same way', (t) => {
  const home = makeHome(t)
  const stray = addStray(home, '@deepseek-ai/dsh-llm', '0.1.2-rc.1', { nested: true })
  const r = run(home)
  assert.equal(r.ok, false)
  assert.equal(r.fatal[0].resolved.dir, stray)
  assert.ok(r.text.includes(`rm -rf ${stray}`))
})

test('a copy newer than the host only warns and boots', (t) => {
  const home = makeHome(t)
  addStray(home, '@deepseek-ai/dsh-llm', '0.2.2-alpha.2')
  const r = run(home)
  assert.equal(r.ok, true)
  assert.deepEqual(r.warnings.map((w) => [w.name, w.kind]), [['@deepseek-ai/dsh-llm', 'newer']])
  assert.match(r.text, /^dsh-tui-pi: note — @deepseek-ai\/dsh-llm resolves to 0\.2\.2-alpha\.2 .* newer than the host's 0\.2\.1-rc\.5; booting anyway\.$/)
})

test('a package the plugin cannot resolve at all is fatal with the re-mount remedy', (t) => {
  const home = makeHome(t)
  rmSync(join(home.home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm'), { recursive: true })
  const r = run(home)
  assert.equal(r.ok, false)
  assert.deepEqual(r.fatal.map((f) => [f.name, f.kind]), [['@deepseek-ai/dsh-llm', 'unresolved']])
  assert.match(r.text, /not resolvable from the mounted plugin at all/)
  assert.ok(r.text.includes(`dsh plugin --profile tui add ${PLUGIN}`))
})

test('an unreadable host side fails open with a note', (t) => {
  const home = makeHome(t, { shared: false })
  addStray(home, '@deepseek-ai/dsh-llm', '0.2.1-rc.4')
  const r = run(home)
  // the other ten are unresolved (fatal) — but dsh-llm itself, lacking a
  // host copy to compare against, is only noted
  const llm = [...r.fatal, ...r.warnings].find((f) => f.name === '@deepseek-ai/dsh-llm')
  assert.equal(llm.kind, 'unverified')
  assert.equal(llm.severity, 'warn')
  assert.match(r.text, /the host's own copy could not be read to compare/)
})

test('dev checkout mount: an older closure copy is a warning, an equal one is silent', (t) => {
  const home = makeHome(t)
  // re-mount the plugin as a symlink to a checkout outside the dsh home
  const checkout = scratch(t, 'tui-pi-checkout-')
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: PLUGIN, version: selfVersion }))
  for (const name of HOST_PACKAGES) writePkg(join(checkout, 'node_modules', ...name.split('/')), name, '0.2.1-rc.4')
  rmSync(home.pluginDir, { recursive: true })
  symlinkSync(checkout, home.pluginDir, 'dir')

  const older = run(home)
  assert.equal(older.ok, true)
  assert.equal(older.fatal.length, 0)
  assert.equal(older.warnings.length, HOST_PACKAGES.length)
  assert.ok(older.warnings.every((w) => w.kind === 'shadowed' && w.severity === 'warn'))
  assert.match(older.text, /dev mount — @deepseek-ai\/dsh-llm resolves to 0\.2\.1-rc\.4/)

  for (const name of HOST_PACKAGES) writePkg(join(checkout, 'node_modules', ...name.split('/')), name, HOST_VERSION)
  const equal = run(home)
  assert.equal(equal.ok, true)
  assert.equal(equal.text, '')
})

test('hostRootFromBin walks from the bin symlink to the host package; it backs the comparison when the shared tree is absent', (t) => {
  const prefix = scratch(t, 'tui-pi-prefix-')
  const hostRoot = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(hostRoot, 'bin'), { recursive: true })
  writeFileSync(join(hostRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: HOST_VERSION }))
  writeFileSync(join(hostRoot, 'bin', 'dsh.js'), '')
  mkdirSync(join(prefix, 'bin'))
  symlinkSync(join('..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'bin', 'dsh.js'), join(prefix, 'bin', 'dsh'))
  for (const name of HOST_PACKAGES) writePkg(join(hostRoot, 'node_modules', ...name.split('/')), name, HOST_VERSION)

  assert.equal(hostRootFromBin(join(prefix, 'bin', 'dsh')), hostRoot)
  assert.equal(hostRootFromBin(join(prefix, 'nope')), null)

  const home = makeHome(t, { shared: false })
  addStray(home, '@deepseek-ai/dsh-llm', '0.0.1-rc.1', { listed: true })
  // only dsh-llm resolves from the profile (no shared tree); it must still
  // be judged against the host's own copy, found through the bin
  const r = run(home, { dshBin: join(prefix, 'bin', 'dsh') })
  const llm = r.fatal.find((f) => f.name === '@deepseek-ai/dsh-llm')
  assert.equal(llm.kind, 'shadowed')
  assert.equal(llm.intended.dir, join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh-llm'))
})

test('launcher: the guard stops the fast path before dsh is spawned; a healthy profile boots', { skip: process.platform === 'win32' }, (t) => {
  const home = makeHome(t)
  // a fake `dsh` first on PATH: onboard-core resolves it, the guard runs,
  // and only a passing guard ever reaches it
  const fakeBin = join(home.home, 'fake-bin')
  mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, 'dsh'), '#!/bin/sh\necho "FAKE-DSH $*"\n')
  chmodSync(join(fakeBin, 'dsh'), 0o755)
  const env = { ...process.env, DSH_HOME: home.home, PATH: `${fakeBin}${delimiter}${process.env.PATH}` }
  const launch = () => spawnSync(process.execPath, [join(repoRoot, 'bin', 'boot.mjs'), '-V'], { env, encoding: 'utf8' })

  addStray(home, '@deepseek-ai/dsh-llm', '0.0.1-rc.1', { listed: true })
  const blocked = launch()
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /cannot boot cleanly/)
  assert.match(blocked.stderr, /pnpm remove @deepseek-ai\/dsh-llm/)
  assert.doesNotMatch(blocked.stdout, /FAKE-DSH/, 'dsh must not be spawned')

  rmSync(join(home.profileRoot, 'node_modules', '@deepseek-ai'), { recursive: true })
  const booted = launch()
  assert.equal(booted.status, 0, booted.stderr)
  assert.equal(booted.stderr, '')
  assert.match(booted.stdout, /^FAKE-DSH --profile tui -V\n$/)
})
