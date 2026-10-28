/**
 * One-time onboarding for the `dsh-tui-pi` / `dst` launcher, shared by two
 * entry points:
 *   - scripts/postinstall.mjs — runs at `npm i -g @aiwayds/dsh-tui-pi` time,
 *     so the package is usable the moment the install prints "added 1 package";
 *   - bin/boot.mjs — runs on the first `dsh-tui-pi` invocation, catching up
 *     anything the postinstall could not finish (offline install, pnpm that
 *     does not run postinstall scripts, non-global context, …).
 *
 * Contract:
 *   - idempotent: every step checks before it acts, so a re-run only prints
 *     "found" lines and the launcher fast-paths to a silent boot;
 *   - the dsh host is installed globally WITH NPM when missing (largest
 *     step); npm itself is a prerequisite — when it is not on PATH we print
 *     what to install and stop instead of guessing;
 *   - all functions are synchronous and never throw past the boundary:
 *     failures come back as { ok: false, step, hint }.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = '@aiwayds/dsh-tui-pi'
const HOST = '@deepseek-ai/dsh'
const PROFILE = 'tui'
const INSTALL_TIMEOUT_MS = 10 * 60_000

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function readSelfPackage() {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
}

export function selfVersion() {
  try {
    return readSelfPackage().version ?? null
  } catch {
    return null
  }
}

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

// The profile counts as set up once this package is resolvable inside it.
export function profileMounted() {
  return existsSync(join(dshHome(), 'profiles', PROFILE, 'node_modules', PKG, 'package.json'))
}

export function profileVersion() {
  try {
    return JSON.parse(
      readFileSync(join(dshHome(), 'profiles', PROFILE, 'node_modules', PKG, 'package.json'), 'utf8'),
    ).version ?? null
  } catch {
    return null
  }
}

// Companion plugins ship as npm dependencies of this package and land in the
// profile's node_modules together with it when `dsh plugin add` runs.
export function companions() {
  try {
    const deps = readSelfPackage().dependencies ?? {}
    return Object.keys(deps).filter((name) => name.startsWith('@aiwayds/') && name !== PKG)
  } catch {
    return []
  }
}

export function which(cmd) {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean)
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, cmd + suffix)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        /* keep scanning */
      }
    }
  }
  return null
}

function queryVersion(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() || null
  } catch {
    return null
  }
}

export function dshBinPath() {
  const onPath = which('dsh')
  if (onPath) return onPath
  // A host installed moments ago can be missing from this shell's PATH cache;
  // fall back to the npm global prefix the installer just wrote to.
  try {
    const prefix = execFileSync('npm', ['prefix', '-g'], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const candidate = join(prefix, 'bin', 'dsh')
    if (existsSync(candidate)) return candidate
  } catch {
    /* no npm, no fallback */
  }
  return null
}

// Global installs always go through npm — one predictable path, regardless
// of which package manager pulled this package in.
function installGlobal(name) {
  const result = spawnSync('npm', ['install', '-g', name], {
    stdio: 'inherit',
    timeout: INSTALL_TIMEOUT_MS,
    shell: process.platform === 'win32',
  })
  return result.status === 0
}

// True when the mounted profile copy is OLDER than this package. Prerelease
// tags compare numerically per dot segment (rc.10 > rc.4); a profile that is
// NEWER (dev-upgraded ahead of the global install) is left alone.
export function profileBehind() {
  const mounted = profileVersion()
  const self = selfVersion()
  if (!mounted || !self) return false
  if (mounted === self) return false
  return compareVersions(mounted, self) < 0
}

export function compareVersions(a, b) {
  const parse = (version) => {
    const [core, pre = ''] = String(version).replace(/^v/, '').split(/[-+]/, 2)
    return { core: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ? pre.split('.') : [] }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i]
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = Number.parseInt(x, 10)
    const yn = Number.parseInt(y, 10)
    if (!Number.isNaN(xn) && !Number.isNaN(yn) && xn !== yn) return xn - yn
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// pnpm ≥10 fails a fresh `add` with ERR_PNPM_IGNORED_BUILDS when the added
// packages carry lifecycle scripts, and writes an allowBuilds skeleton into
// the profile's pnpm-workspace.yaml with a per-package "set this to true or
// false" placeholder. The only scripts our packages ship are the closure
// linker postinstalls, which no-op on published tarballs (they guard on the
// repo's src/), so approving them is safe and is what `pnpm approve-builds`
// would do interactively. Fills ONLY placeholder values — a decision the
// user already wrote (true/false) is left untouched. Returns whether any
// placeholder was found and approved.
function approvePrintedBuilds() {
  const workspace = join(dshHome(), 'profiles', PROFILE, 'pnpm-workspace.yaml')
  try {
    const text = readFileSync(workspace, 'utf8')
    if (!text.includes('set this to true or false')) return false
    writeFileSync(workspace, text.replaceAll('set this to true or false', 'true'))
    return true
  } catch {
    return false
  }
}

/**
 * Bring the machine to a bootable state, printing one progress line per step.
 * Steps:
 *   1/3 dsh host    — installed globally with npm when missing; when npm
 *                     itself is not on PATH, print what to install and stop
 *   2/3 pnpm        — the host's plugin manager shells out to it; installed
 *                     globally when missing
 *   3/3 tui profile — `dsh plugin --profile tui add` this package (+ companions)
 * Returns { ok: true, dsh } or { ok: false, step, hint }.
 */
export function runOnboard({ log = () => {} } = {}) {
  let dsh = dshBinPath()
  if (dsh) {
    log(`  [1/3] dsh host              found ${queryVersion(dsh, ['-V']) ?? '(version unknown)'}`)
  } else if (!which('npm')) {
    log(`  [1/3] dsh host              not found, and npm is not on PATH either`)
    return {
      ok: false,
      step: 'npm',
      hint: 'install Node.js (ships with npm) first: https://nodejs.org — then re-run dsh-tui-pi',
    }
  } else {
    log(`  [1/3] dsh host              not found — installing ${HOST} globally with npm (largest step, a few minutes)…`)
    if (!installGlobal(HOST)) {
      return { ok: false, step: 'dsh host install', hint: `install it with: npm install -g ${HOST} — then re-run dsh-tui-pi` }
    }
    dsh = dshBinPath()
    if (!dsh) {
      return { ok: false, step: 'dsh host lookup', hint: `installed, but still not found — run: npm install -g ${HOST}` }
    }
    log(`  [1/3] dsh host              installed ${queryVersion(dsh, ['-V']) ?? ''}`)
  }

  const pnpm = which('pnpm')
  if (pnpm) {
    log(`  [2/3] pnpm                  found ${queryVersion(pnpm, ['-v']) ?? ''}`)
  } else {
    log('  [2/3] pnpm                  not found — installing globally…')
    if (!installGlobal('pnpm')) {
      return { ok: false, step: 'pnpm install', hint: 'install it with: npm install -g pnpm — then re-run dsh-tui-pi' }
    }
    log(`  [2/3] pnpm                  installed ${queryVersion('pnpm', ['-v']) ?? ''}`)
  }

  if (profileMounted() && !profileBehind()) {
    log('  [3/3] tui profile           already set up')
  } else {
    const verb = profileMounted() ? 'updating' : 'creating'
    const list = companions()
    log(`  [3/3] tui profile           ${verb}: installing ${PKG}${list.length ? ` + ${list.length} bundled companions` : ''}…`)
    if (list.length) log(`        ${list.join(', ')}`)
    const result = spawnSync(dsh, ['plugin', '--profile', PROFILE, 'add', PKG], {
      stdio: 'inherit',
      timeout: INSTALL_TIMEOUT_MS,
    })
    if (result.status !== 0) {
      if (!approvePrintedBuilds()) {
        return { ok: false, step: 'tui profile setup', hint: `run it manually with: dsh plugin --profile ${PROFILE} add ${PKG} — then re-run dsh-tui-pi` }
      }
      // pnpm's skeleton is filled; the same idempotent add now succeeds
      // (everything is already downloaded).
      log('  [3/3] tui profile           approved the printed build scripts (our closure-linker no-ops) — retrying…')
      const retry = spawnSync(dsh, ['plugin', '--profile', PROFILE, 'add', PKG], {
        stdio: 'inherit',
        timeout: INSTALL_TIMEOUT_MS,
      })
      if (retry.status !== 0) {
        return { ok: false, step: 'tui profile setup', hint: `run it manually with: dsh plugin --profile ${PROFILE} add ${PKG} — then re-run dsh-tui-pi` }
      }
    }
    log(`  [3/3] tui profile           ${verb === 'updating' ? 'updated' : 'done'}`)
  }

  return { ok: true, dsh }
}
