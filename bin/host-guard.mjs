/**
 * Fast-path guard for the launcher (bin/boot.mjs): the plugin mounted in the
 * profile must resolve every `@deepseek-ai/*` package it imports to the same
 * copy the running host ships.
 *
 * Why this exists: plugins live in `~/.dsh/profiles/<name>/node_modules` and
 * resolve host packages by walking up to the host's shared closure tree
 * (`~/.dsh/profiles/node_modules`, links into the global host install). Any
 * stray `@deepseek-ai/*` copy sitting closer to the plugin — a bare-name
 * `pnpm add @deepseek-ai/dsh-llm` is the classic — shadows the host's copy.
 * The failure then surfaces as a raw loader SyntaxError ("does not provide
 * an export named …") that hides both the version conflict and its fix.
 *
 * Official dsh packages keep their npm `latest` dist-tag at a 0.0.1 stub
 * (as of 2026-10: `@deepseek-ai/dsh-llm@latest` = 0.0.1-rc.1), so the stub
 * lacks APIs introduced in the 0.1.3+ line. This guard turns that state
 * into a plain-language stop with the removal commands, before `dsh` boots.
 *
 * Contract:
 *   - healthy profile: no output, returns { ok: true } — the fast path
 *     stays silent;
 *   - a profile-resident copy older than the host's: fatal stop with the
 *     two paths, the versions, and the exact removal commands;
 *   - ambiguous states (dev `link:` mounts, copies newer than the host,
 *     an unverifiable host side): one stderr line, boot continues — the
 *     guard never blocks a working setup on a guess.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { compareVersions } from './onboard-core.mjs'

// Every `@deepseek-ai/*` package the compiled plugin imports at runtime
// (type-only imports in src/ are erased by tsc and do not count). Kept in
// lockstep with lib/ by test/host-guard.test.mjs; a drifted list fails CI.
export const HOST_PACKAGES = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-attachment-local',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-permission-presets',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-session-projection-cache',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
]

const HOST_NAME = '@deepseek-ai/dsh'

// Oldest host line this suite supports (the baked-in floor of
// onboard-core.mjs minHostVersion). Anything older inside a profile is not a
// release of anything — it is the npm `latest` stub.
const ANCIENT_FLOOR = '0.2.1-rc.2'

const PKG = '@aiwayds/dsh-tui-pi'

function readPackageAt(pkgPath) {
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return null
  }
}

// The nearest package root around a resolved file: version of the copy the
// plugin would actually load.
function packageInfoFromFile(file) {
  let dir = dirname(file)
  for (let i = 0; i < 8; i += 1) {
    const pkg = readPackageAt(join(dir, 'package.json'))
    if (pkg?.name) return { dir, version: pkg.version ?? null }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

// The global host install root, from the `dsh` bin the launcher is about to
// spawn — `<root>/node_modules` is where its closure copies live.
export function hostRootFromBin(dshBin) {
  try {
    let dir = dirname(realpathSync(dshBin))
    for (let i = 0; i < 6; i += 1) {
      const pkg = readPackageAt(join(dir, 'package.json'))
      if (pkg?.name === HOST_NAME) return dir
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  } catch {
    /* not a file, or unreadable */
  }
  return null
}

// True when the mounted plugin is a symlink pointing outside the dsh home —
// the dev `link:` checkout layout, where the checkout's own closure copy is
// legitimate and a version delta is a warning, not a stop.
function isDevMount(pluginDir, dshHome) {
  let target
  try {
    target = readlinkSync(pluginDir)
    if (!target) return false
  } catch {
    return false
  }
  const resolved = isAbsolute(target) ? target : join(dirname(pluginDir), target)
  try {
    return !realpathSync(resolved).startsWith(realpathSync(dshHome))
  } catch {
    return true
  }
}

function resolveFrom(pluginDir, name) {
  try {
    const req = createRequire(join(pluginDir, 'package.json'))
    return req.resolve(name)
  } catch {
    return null
  }
}

// Version the host intends plugins to see: the shared closure tree first
// (what walk-up resolution is supposed to land on), then the host's own
// node_modules. Null when neither can be read — the guard then fails open.
function intendedInfo(name, { sharedTree, hostRoot }) {
  const candidates = []
  if (sharedTree) candidates.push(join(sharedTree, name))
  if (hostRoot) candidates.push(join(hostRoot, 'node_modules', name))
  for (const dir of candidates) {
    const pkg = readPackageAt(join(dir, 'package.json'))
    if (pkg?.name) return { dir, version: pkg.version ?? null }
  }
  return null
}

// The install root a resolved copy lives in (`…/<root>/node_modules/<name>`),
// used to shape the removal commands.
function installRootOf(resolvedPath) {
  const marker = `${sep}node_modules${sep}`
  const idx = resolvedPath.lastIndexOf(marker)
  return idx === -1 ? null : resolvedPath.slice(0, idx)
}

function realOr(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function profileRemedy(name, resolvedPath, dshHome) {
  const root = installRootOf(resolvedPath)
  if (!root || !dshHome || !realOr(root).startsWith(realOr(dshHome))) {
    return `remove the stray copy at ${resolvedPath}, then re-mount:\n    dsh plugin --profile tui add ${PKG}`
  }
  const deps = readPackageAt(join(root, 'package.json'))?.dependencies ?? {}
  const rm = name in deps
    ? `cd ${root} && pnpm remove ${name}`
    : `rm -rf ${resolvedPath}`
  return `${rm}\n    dsh plugin --profile tui add ${PKG}`
}

/**
 * Check the mounted plugin's view of the host closure. Returns { ok, fatal,
 * warnings }; prints nothing itself — pass a log to emit the diagnostics.
 * All inputs optional except pluginDir; anything unresolvable degrades to
 * warn, so an exotic install layout never blocks a working boot.
 */
export function checkHostPackages({ pluginDir, dshBin, dshHome, log = () => {} } = {}) {
  const fatal = []
  const warnings = []
  if (!pluginDir || !existsSync(join(pluginDir, 'package.json'))) {
    return { ok: true, fatal, warnings }
  }
  const home = dshHome ?? ''
  const sharedTree = join(home, 'profiles', 'node_modules')
  const hostRoot = dshBin ? hostRootFromBin(dshBin) : null
  const dev = home ? isDevMount(pluginDir, home) : false

  for (const name of HOST_PACKAGES) {
    const resolvedFile = resolveFrom(pluginDir, name)
    const resolved = resolvedFile ? packageInfoFromFile(resolvedFile) : null
    const intended = intendedInfo(name, { sharedTree: home ? sharedTree : null, hostRoot })

    if (!resolved) {
      // The plugin statically imports every package in the list; nothing
      // resolvable means the loader is about to die on it.
      const finding = {
        name,
        kind: 'unresolved',
        severity: dev ? 'warn' : 'fatal',
        resolved: null,
        intended,
      }
      ;(finding.severity === 'fatal' ? fatal : warnings).push(finding)
      continue
    }
    if (!intended?.version || !resolved.version) {
      warnings.push({ name, kind: 'unverified', severity: 'warn', resolved, intended })
      continue
    }
    const cmp = compareVersions(resolved.version, intended.version)
    if (cmp === 0) continue
    if (cmp < 0) {
      const finding = {
        name,
        kind: 'shadowed',
        severity: dev ? 'warn' : 'fatal',
        ancient: compareVersions(resolved.version, ANCIENT_FLOOR) < 0,
        resolved,
        intended,
      }
      ;(finding.severity === 'fatal' ? fatal : warnings).push(finding)
    } else {
      warnings.push({ name, kind: 'newer', severity: 'warn', resolved, intended })
    }
  }

  for (const f of warnings) {
    if (f.kind === 'newer') {
      log(`dsh-tui-pi: note — ${f.name} resolves to ${f.resolved.version} (${f.resolved.dir}), newer than the host's ${f.intended?.version ?? '(unreadable)'}; booting anyway.`)
    } else if (f.kind === 'unverified') {
      log(`dsh-tui-pi: note — ${f.name} resolves to ${f.resolved.version ?? '(unknown version)'} (${f.resolved.dir}); the host's own copy could not be read to compare.`)
    } else if (f.kind === 'unresolved') {
      log(`dsh-tui-pi: note — ${f.name} is not resolvable from the dev checkout; if the TUI fails to load it, run \`pnpm install\` in the checkout.`)
    } else {
      log(`dsh-tui-pi: dev mount — ${f.name} resolves to ${f.resolved.version} (${f.resolved.dir}), older than the host's ${f.intended?.version}; if the TUI fails to load, refresh the checkout's closure (\`pnpm install\`).`)
    }
  }

  if (fatal.length) {
    log('dsh-tui-pi: cannot boot cleanly — the profile resolves a dsh host package to a copy that is not the running host\'s.')
    for (const f of fatal) {
      if (f.kind === 'unresolved') {
        log(`\n  ${f.name}\n    not resolvable from the mounted plugin at all.`)
        log(`\n  Fix — re-mount the suite and boot once so the host links its closure:\n    dsh plugin --profile tui add ${PKG}\n    dsh-tui-pi`)
        continue
      }
      log(`\n  ${f.name}`)
      log(`    the plugin resolves: ${f.resolved.version ?? '(unknown)'}`)
      log(`      ← ${f.resolved.dir}`)
      log(`    the host ships:      ${f.intended?.version ?? '(unreadable)'}`)
      log(`      ← ${f.intended ? realOr(f.intended.dir) : '(shared closure link missing)'}`)
      if (f.ancient) {
        log('\n  Versions before 0.2.1-rc.2 are stubs, not releases: official dsh packages keep their npm `latest` dist-tag at a 0.0.1 placeholder, so installing by bare package name (`pnpm add @deepseek-ai/dsh-llm`) lands a stub in the profile and breaks every plugin import. Install with an explicit version instead (e.g. @deepseek-ai/dsh-llm@0.2.1-rc.5).')
      } else {
        log('\n  A stale copy inside the profile shadows the host\'s own.')
      }
      log(`\n  Fix — ${profileRemedy(f.name, f.resolved.dir, home)}`)
    }
  }

  return { ok: fatal.length === 0, fatal, warnings }
}
