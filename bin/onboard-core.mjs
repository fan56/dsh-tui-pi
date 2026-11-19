/**
 * One-time onboarding for the `dsh-tui-pi` / `dst` launcher. The package
 * carries no install hook — the historical `scripts/postinstall.mjs` was
 * removed because pnpm 11's strictDepBuilds validation gates dependencies'
 * install scripts (see docs/adr/0004-onboarding-first-launch-not-postinstall.md)
 * — so `bin/boot.mjs` is the single entry point: it runs on the first
 * `dsh-tui-pi` invocation and on any later one that finds the machine
 * missing a piece (fresh machine, offline first run, profile behind after
 * an upgrade, …).
 *
 * Contract:
 *   - idempotent: every step checks before it acts, so a re-run only prints
 *     "found" lines and the launcher fast-paths to a silent boot;
 *   - the dsh host is installed globally WITH NPM when missing (largest
 *     step); npm itself is a prerequisite — when it is not on PATH we print
 *     what to install and stop instead of guessing;
 *   - all functions are synchronous and never throw past the boundary:
 *     failures come back as { ok: false, step, hint, detail } where detail
 *     carries how the underlying process died (exit code / signal / spawn
 *     error) — never swallowed behind a bare "stopped".
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideCompanionInstall, normalizeVersion } from './companion-policy.mjs'
import { queryDistTagLatest } from './registry-dist-tag.mjs'

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

// Where `dsh plugin add` mounts this package inside the tui profile.
export function profilePluginDir() {
  return join(dshHome(), 'profiles', PROFILE, 'node_modules', PKG)
}

// The profile counts as set up once this package is resolvable inside it.
export function profileMounted() {
  return existsSync(join(profilePluginDir(), 'package.json'))
}

export function profileVersion() {
  try {
    return JSON.parse(readFileSync(join(profilePluginDir(), 'package.json'), 'utf8')).version ?? null
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

// Same companions, but with their declared caret ranges — the policy guard
// needs the range to reject a cross-major latest. The declaration is read
// from this package, never from the profile (which only holds resolved pins).
export function companionRanges() {
  try {
    const deps = readSelfPackage().dependencies ?? {}
    const ranges = {}
    for (const [name, range] of Object.entries(deps)) {
      if (name.startsWith('@aiwayds/') && name !== PKG) ranges[name] = range
    }
    return ranges
  } catch {
    return {}
  }
}

function profileCompanionDir(name) {
  return join(dshHome(), 'profiles', PROFILE, 'node_modules', name)
}

// The version currently mounted in the profile, or null when absent. Used
// only for the idempotent / no-downgrade guard, never to change a user pin.
export function profileCompanionVersion(name) {
  try {
    return JSON.parse(readFileSync(join(profileCompanionDir(name), 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

// The spec recorded for a companion in the profile's own package.json
// `dependencies`. `dsh plugin add pkg@<spec>` writes that line verbatim, so
// re-reading it is how the fallback verifies an exact pin was really replaced
// by the declared range (a bare add leaves the exact pin untouched).
export function profileCompanionSpec(name) {
  try {
    const manifest = JSON.parse(readFileSync(join(dshHome(), 'profiles', PROFILE, 'package.json'), 'utf8'))
    return manifest.dependencies?.[name] ?? null
  } catch {
    return null
  }
}

// Post-install self-check: resolve the freshly installed companion from the
// profile and compare its package.json version with the exact spec we asked
// for. A load failure or a version mismatch means the pin did not land and
// the caller must fall back to the declared range (today's path).
function companionSelfCheck(name, expectedVersion) {
  try {
    const req = createRequire(join(profileCompanionDir(name), 'noop.js'))
    let manifest
    try {
      manifest = req.resolve(`${name}/package.json`)
    } catch {
      // Some companions do not export ./package.json; fall back to the
      // profile's physical path, which is where `dsh plugin add` mounts it.
      manifest = join(profileCompanionDir(name), 'package.json')
    }
    return JSON.parse(readFileSync(manifest, 'utf8')).version === expectedVersion
  } catch {
    return false
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
// of which package manager pulled this package in. Returns { ok, detail }:
// on failure detail carries exactly how the npm child died (spawn error,
// signal, exit code). npm can die without ever printing an error — the
// kernel OOM killer SIGKILLs it under memory pressure (observed: exit 137
// installing @deepseek-ai/dsh on a 2 GiB podman VM) and a spawnSync timeout
// surfaces as a signal too — so a bare boolean would leave the launcher
// reporting "setup stopped" with no actionable cause.
function installGlobal(name) {
  const result = spawnSync('npm', ['install', '-g', name], {
    stdio: 'inherit',
    timeout: INSTALL_TIMEOUT_MS,
    shell: process.platform === 'win32',
  })
  if (result.status === 0) return { ok: true, detail: null }
  const parts = []
  if (result.error) {
    parts.push(result.error.code ? `${result.error.code} (${result.error.message})` : result.error.message)
  }
  if (result.signal) parts.push(`killed by signal ${result.signal}`)
  if (result.status !== null) parts.push(`exit code ${result.status}`)
  if (parts.length === 0) parts.push('npm exited without an exit code or signal')
  return { ok: false, detail: parts.join(', ') }
}

// Newest of the `latest` (stable) and `next` (rc) dist-tags — the same
// resolution rule as ci.yml / e2e/run-e2e.sh; the alpha tag is retired.
// The host's `latest` dist-tag lags the rc line this plugin targets
// (2026-10: latest=0.2.1-rc.2 while the plugin needs the rc.3 subagent
// APIs), so the host must never be installed from the bare package name.
// Returns a concrete version, or null when npm cannot be reached.
export function resolveHostVersion() {
  try {
    const out = execFileSync('npm', ['view', HOST, 'dist-tags', '--json'], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const tags = JSON.parse(out)
    const stable = tags?.latest
    const rc = tags?.next
    if (stable && rc) return compareVersions(rc, stable) > 0 ? rc : stable
    return stable ?? rc ?? null
  } catch {
    return null
  }
}

// The oldest host this plugin supports. Compatibility window: >=
// 0.2.2-rc.1 (the rc/stable line; older hosts are rejected by the
// startup guard and upgraded by the onboarding, not kept). Read from the
// manifest's own peerDependencies when declared, so declaration and
// check stay one decision — note the floor must NOT move into
// peerDependencies itself: npm ≥7 auto-installs peers on global installs
// and would pull the 834MB host at its stale `latest` tag.
export function minHostVersion() {
  try {
    const peer = readSelfPackage().peerDependencies?.[HOST]
    const match = typeof peer === 'string' ? peer.match(/>=\s*(\S+)/) : null
    if (match) return match[1]
  } catch {
    /* fall through to the baked-in floor */
  }
  return '0.2.2-rc.1'
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
// packages carry lifecycle scripts. The packages this suite ships declare
// none (the dev-tree closure linker is not wired as a hook in any published
// tarball), so filling the allowBuilds block approves nothing that can run
// unvetted — it is what `pnpm approve-builds` would do interactively, and it
// stays safe as companions evolve. pnpm sometimes records an
// allowBuilds skeleton in the profile's pnpm-workspace.yaml with a
// "set this to true or false" placeholder — fill those placeholders; when
// it does not (behavior varies by pnpm build and environment), write the
// allowBuilds block ourselves for exactly the packages this suite ships.
// A user-written true/false decision is never overwritten. Returns whether
// the workspace file was updated.
function approvePrintedBuilds() {
  const workspace = join(dshHome(), 'profiles', PROFILE, 'pnpm-workspace.yaml')
  try {
    const text = readFileSync(workspace, 'utf8')
    if (text.includes('set this to true or false')) {
      writeFileSync(workspace, text.replaceAll('set this to true or false', 'true'))
      return true
    }
    if (text.includes('allowBuilds:')) return false
    const names = [PKG, ...companions()]
    const block = ['allowBuilds:', ...names.map((name) => `  '${name}': true`)].join('\n')
    writeFileSync(workspace, `${text.replace(/\n*$/, '\n')}${block}\n`)
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
 *   3/3 tui profile — `dsh plugin --profile tui add` this package (+ companions).
 *       With companion latest enabled (the default), each companion's
 *       `dist-tags.latest` is resolved and guarded before the add, so the
 *       exact version is pinned; a failed query/guard falls back to the
 *       declared range (today's path) without blocking onboard.
 * Returns { ok: true, dsh } or { ok: false, step, hint, detail }.
 *
 * `companionLatest` comes from the bin-layer DSH_TUI_COMPANION_LATEST switch;
 * it is an explicit parameter, not an env read here, so the decision stays
 * testable and the TUI Config layer never gets a second source of truth.
 */
export function runOnboard({ log = () => {}, companionLatest = true } = {}) {
  let dsh = dshBinPath()
  const wanted = resolveHostVersion()
  const hostSpec = wanted ? `${HOST}@${wanted}` : HOST
  const foundVersion = dsh ? queryVersion(dsh, ['-V']) : null
  const tooOld = foundVersion ? compareVersions(foundVersion, minHostVersion()) < 0 : false
  if (dsh && !tooOld) {
    log(`  [1/3] dsh host              found ${foundVersion ?? '(version unknown)'}`)
  } else if (!dsh && !which('npm')) {
    log('  [1/3] dsh host              not found, and npm is not on PATH either')
    return {
      ok: false,
      step: 'npm',
      hint: 'install Node.js (ships with npm) first: https://nodejs.org — then re-run dsh-tui-pi',
    }
  } else {
    const reason = dsh
      ? `${foundVersion} is older than this plugin requires (>= ${minHostVersion()})`
      : 'not found'
    log(`  [1/3] dsh host              ${reason} — installing ${hostSpec} globally with npm (largest step, a few minutes)…`)
    const hostInstall = installGlobal(hostSpec)
    if (!hostInstall.ok) {
      return { ok: false, step: 'dsh host install', hint: `install it with: npm install -g ${hostSpec} — then re-run dsh-tui-pi`, detail: hostInstall.detail }
    }
    dsh = dshBinPath()
    if (!dsh) {
      return { ok: false, step: 'dsh host lookup', hint: `installed, but still not found — run: npm install -g ${hostSpec}` }
    }
    log(`  [1/3] dsh host              installed ${queryVersion(dsh, ['-V']) ?? ''}`)
  }

  const pnpm = which('pnpm')
  if (pnpm) {
    log(`  [2/3] pnpm                  found ${queryVersion(pnpm, ['-v']) ?? ''}`)
  } else {
    log('  [2/3] pnpm                  not found — installing globally…')
    const pnpmInstall = installGlobal('pnpm')
    if (!pnpmInstall.ok) {
      return { ok: false, step: 'pnpm install', hint: 'install it with: npm install -g pnpm — then re-run dsh-tui-pi', detail: pnpmInstall.detail }
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

    // Resolve → guard → decide, one line per companion. The registry query
    // inherits the install's env and runs from the profile dir when present,
    // so a profile-level .npmrc (private registry) is seen by both sides.
    const profileDir = join(dshHome(), 'profiles', PROFILE)
    const registryCwd = existsSync(profileDir) ? profileDir : process.cwd()
    const ranges = companionRanges()
    const decisions = list.map((name) => {
      const declaredRange = ranges[name] ?? null
      const queried = companionLatest && declaredRange
        ? queryDistTagLatest(name, { cwd: registryCwd, env: process.env })
        : null
      // Normalise once so the spec handed to plugin add and the version the
      // self-check expects are the same string (a `v`-prefixed dist-tag would
      // otherwise make the installed manifest compare unequal to the spec).
      const resolved = queried ? normalizeVersion(queried) : null
      const currentPin = profileCompanionVersion(name)
      const decision = decideCompanionInstall({ packageName: name, declaredRange, resolved, currentPin, enabled: companionLatest })
      if (decision.action === 'latest') {
        log(`        ${name}: ${declaredRange} → ${resolved} (latest)`)
      } else if (decision.action === 'skip') {
        log(`        ${name}: skip ${declaredRange ?? '(no range)'} (${decision.reason})`)
      } else {
        log(`        ${name}: fallback ${declaredRange ?? '(no range)'} (${decision.reason})`)
      }
      return { name, resolved, decision }
    })

    // Only guarded, resolved companions get an explicit exact spec; every
    // fallback / skip leaves the declared-range resolution to the host, which
    // is byte-for-byte today's `dsh plugin add PKG` behaviour.
    const specDecisions = decisions.filter((entry) => entry.decision.action === 'latest')
    const declaredArgs = ['plugin', '--profile', PROFILE, 'add', PKG]
    const addArgs = [...declaredArgs, ...specDecisions.map((entry) => entry.decision.spec)]
    const profileFail = {
      ok: false,
      step: 'tui profile setup',
      hint: `run it manually with: dsh plugin --profile ${PROFILE} add ${PKG} — then re-run dsh-tui-pi`,
    }

    // One add attempt, keeping the existing build-approval retry: pnpm ≥10 can
    // fail a fresh add with ERR_PNPM_IGNORED_BUILDS, which filling its
    // allowBuilds skeleton fixes. When approvePrintedBuilds changes nothing we
    // do not retry — that is today's behaviour. Returns the final spawn result.
    function pluginAdd(args) {
      let res = spawnSync(dsh, args, { stdio: 'inherit', timeout: INSTALL_TIMEOUT_MS })
      if (res.status !== 0) {
        if (!approvePrintedBuilds()) return res
        log('  [3/3] tui profile           approved the printed build scripts (our closure-linker no-ops) — retrying…')
        res = spawnSync(dsh, args, { stdio: 'inherit', timeout: INSTALL_TIMEOUT_MS })
      }
      return res
    }

    let result = pluginAdd(addArgs)

    // An exact-spec add can be rejected for reasons the build-approval retry
    // does not address: the host's pre-install compatibility preflight, a
    // dist-tag that moved between query and add, or its post-install rollback
    // (all exit 1). Downgrade to the declared range once; only a second failure
    // falls into today's abort semantics. The log states the observed exit and
    // the likely causes so this retry is distinguishable from the one above.
    let specAddFellBack = false
    if (result.status !== 0 && specDecisions.length > 0) {
      const cause = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? 'unknown'}`
      log(`        companion spec add failed (${cause}; e.g. host compatibility preflight / dist-tag moved / post-install rollback) — retrying declared range`)
      specAddFellBack = true
      result = pluginAdd(declaredArgs)
    }
    if (result.status !== 0) return profileFail

    // Post-install self-check on the exact specs only. When a pinned companion
    // did not land at the requested version, reinstall its declared range with
    // an EXPLICIT spec — a bare add would leave the bad exact pin in the
    // profile's package.json (P1-2). Read that line back after the fallback and
    // report only what actually happened. Skipped entirely if the add already
    // fell back.
    const broken = specAddFellBack
      ? []
      : specDecisions.filter((entry) => !companionSelfCheck(entry.name, entry.resolved))
    if (broken.length) {
      log(`        ${broken.map((entry) => entry.name).join(', ')}: self-check failed — reinstalling declared range with explicit specs`)
      const fallbackSpecs = broken.map((entry) => `${entry.name}@${ranges[entry.name]}`)
      const fallback = pluginAdd([...declaredArgs, ...fallbackSpecs])
      if (fallback.status !== 0) return profileFail
      // Verified only when the line now holds exactly the declared range we
      // asked for — not merely a value that changed from the bad pin.
      const verified = broken.filter((entry) => profileCompanionSpec(entry.name) === ranges[entry.name])
      if (verified.length) {
        log(`        ${verified.map((entry) => entry.name).join(', ')}: declared spec restored and verified in profile manifest`)
      }
      const unverified = broken.filter((entry) => !verified.includes(entry))
      if (unverified.length) {
        log(`        ${unverified.map((entry) => entry.name).join(', ')}: fallback re-check inconclusive — declared spec not reflected in profile manifest`)
      }
    }

    const latestCount = specAddFellBack ? 0 : specDecisions.length - broken.length
    const fallbackCount = decisions.filter((entry) => entry.decision.action === 'fallback').length
      + (specAddFellBack ? specDecisions.length : broken.length)
    const skipCount = decisions.filter((entry) => entry.decision.action === 'skip').length
    log(`        companions: ${latestCount} latest, ${fallbackCount} fallback, ${skipCount} skipped`)
    log(`  [3/3] tui profile           ${verb === 'updating' ? 'updated' : 'done'}`)
  }

  return { ok: true, dsh }
}
