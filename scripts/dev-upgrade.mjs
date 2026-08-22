#!/usr/bin/env node
/**
 * Dev loop after a release: upgrade the pinned `@aiwayds/dsh-tui-pi` version
 * in a dsh profile — the same flow a real user gets from the npm registry.
 *
 * History: this used to be scripts/dev-install.mjs (build → pack → install a
 * file: tarball into the profile). Since 2026-08-21 the tui profile installs
 * from the npm REGISTRY — its package.json pins
 * `"@aiwayds/dsh-tui-pi": "<version>"` and pnpm resolves it like any other
 * dependency. The tarball flow is dead (its guard errors out before touching
 * anything), so this script replaces it with the flow that actually matters:
 * bumping the pin.
 *
 * Usage:
 *   node scripts/dev-upgrade.mjs [version|latest] [--profile <name>] [--dry-run]
 *   (version defaults to "latest", profile defaults to "tui")
 *
 * Steps:
 *   1. Resolve the target version via `npm view @aiwayds/dsh-tui-pi version`
 *      (for "latest") or `npm view @aiwayds/dsh-tui-pi@<version> version`
 *      (for a pinned request) — the version must exist on the registry
 *      BEFORE anything is written.
 *   2. Update ONLY the `"@aiwayds/dsh-tui-pi"` key in the profile's
 *      package.json, as a read-modify-write that preserves the file's
 *      formatting (targeted value replacement + JSON round-trip check that
 *      nothing else changed).
 *   3. Run `pnpm install` in the profile directory.
 *   4. Verify the installed copy under node_modules reports the target
 *      version.
 *
 * With `--dry-run` the script prints the full plan (file, old → new pin,
 * commands) and exits without writing or installing anything.
 *
 * Safety: the script NEVER touches `~/.dsh/settings.yaml` or
 * `~/.dsh/.credentials.yaml` (live user configuration) and never mutates any
 * other dependency entry in the profile manifest.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG_NAME = '@aiwayds/dsh-tui-pi'
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Parse CLI args: [version] [--profile <name>] [--dry-run]. */
export function parseArgs(argv) {
  let version = 'latest'
  let profile = 'tui'
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--profile') {
      profile = argv[++i]
      if (!profile) throw new Error('--profile requires a value')
    } else if (arg === '-h' || arg === '--help') {
      return { help: true }
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`)
    } else {
      if (version !== 'latest') throw new Error(`unexpected extra argument: ${arg}`)
      version = arg
    }
  }
  return { version, profile, dryRun }
}

/**
 * Rewrite ONLY the pinned version of `pkgName` inside a package.json source
 * string, preserving all surrounding formatting byte-for-byte. Throws when
 * the dependency is missing or is not a plain pinned version (file:, link:,
 * ranges and dist-tags are refused — this script only flips exact pins).
 */
export function bumpDependencyText(source, pkgName, nextVersion) {
  const manifest = JSON.parse(source)
  const current = manifest.dependencies?.[pkgName]
  if (typeof current !== 'string') {
    throw new Error(
      `dependencies["${pkgName}"] not found in the profile package.json — ` +
      `add it first (e.g. "pnpm --dir <profile> add ${pkgName}").`,
    )
  }
  const plainVersion =
    typeof current === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][\w.-]+)?$/.test(current)
  if (!plainVersion) {
    throw new Error(
      `dependencies["${pkgName}"] is "${current}", not a plain pinned version — ` +
      `refusing to rewrite non-pin refs (file:/link:/range/tag).`,
    )
  }
  const needle = `"${pkgName}": "${current}"`
  if (!source.includes(needle)) {
    // Formatting differs (extra spaces etc.) — refuse rather than guess.
    throw new Error(
      `could not find \`"${pkgName}": "${current}"\` verbatim in the profile ` +
      `package.json; fix the formatting or edit the pin by hand.`,
    )
  }
  return source.replace(needle, `"${pkgName}": "${nextVersion}"`)
}

/**
 * Verify that rewriting produced EXACTLY one change: the named dependency's
 * value became expectedNext and everything else is untouched.
 */
export function assertOnlyDependencyChanged(beforeText, afterText, pkgName, expectedNext) {
  const before = JSON.parse(beforeText)
  const after = JSON.parse(afterText)
  before.dependencies[pkgName] = expectedNext
  const prune = (m) => {
    const copy = { ...m }
    delete copy.dependencies
    return copy
  }
  if (JSON.stringify(prune(before)) !== JSON.stringify(prune(after))) {
    throw new Error('safety check failed: something other than the target dependency changed')
  }
  if (afterText === beforeText) {
    throw new Error('nothing was rewritten')
  }
  if (after.dependencies[pkgName] !== expectedNext) {
    throw new Error(`dependencies["${pkgName}"] did not become "${expectedNext}"`)
  }
}

/** Look up a version on the npm registry; returns the resolved semver. */
function resolveRegistryVersion(request) {
  const spec = request === 'latest' ? `${PKG_NAME}@latest` : `${PKG_NAME}@${request}`
  const out = execFileSync('npm', ['view', spec, 'version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (!/^\d+\.\d+\.\d+/.test(out)) {
    throw new Error(`registry returned an unexpected version for ${spec}: ${out}`)
  }
  return out
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[dev-upgrade] ${err.message}`)
    console.error('usage: node scripts/dev-upgrade.mjs [version|latest] [--profile <name>] [--dry-run]')
    process.exit(1)
  }
  if (args.help) {
    console.log('usage: node scripts/dev-upgrade.mjs [version|latest] [--profile <name>] [--dry-run]')
    return
  }

  const profileDir = join(homedir(), '.dsh', 'profiles', args.profile)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    console.error(`[dev-upgrade] profile not found: ${profileDir}`)
    process.exit(1)
  }

  // 1. Resolve + verify the target on the registry before touching anything.
  let target
  try {
    target = resolveRegistryVersion(args.version)
  } catch (err) {
    console.error(
      `[dev-upgrade] version lookup failed for "${args.version}": ${err.message.split('\n')[0]}`,
    )
    process.exit(1)
  }

  const source = readFileSync(manifestPath, 'utf8')
  let current
  try {
    current = JSON.parse(source).dependencies?.[PKG_NAME]
  } catch {
    console.error(`[dev-upgrade] profile package.json is not valid JSON: ${manifestPath}`)
    process.exit(1)
  }

  if (current === target) {
    console.log(`[dev-upgrade] already pinned to ${target} — nothing to do.`)
    return
  }

  console.log(`[dev-upgrade] plan (${args.dryRun ? 'DRY RUN' : 'apply'}):`)
  console.log(`  1. ${manifestPath}`)
  console.log(`     dependencies["${PKG_NAME}"]: ${current ?? '(missing)'} → ${target}`)
  console.log(`  2. $ pnpm install          (cwd: ${profileDir})`)
  console.log(`  3. verify node_modules/${PKG_NAME}/package.json version === ${target}`)
  console.log('  (settings.yaml / .credentials.yaml are never touched)')
  if (args.dryRun) {
    console.log('[dev-upgrade] dry run — no files written, nothing installed.')
    return
  }

  if (typeof current !== 'string') {
    console.error(
      `[dev-upgrade] dependencies["${PKG_NAME}"] missing in ${manifestPath}; ` +
      `run \`dsh plugin --profile ${args.profile} add ${PKG_NAME}\` first.`,
    )
    process.exit(1)
  }

  // 2. Read-modify-write, preserving formatting; verify the result changed
  //    exactly one thing.
  let updated
  try {
    updated = bumpDependencyText(source, PKG_NAME, target)
    assertOnlyDependencyChanged(source, updated, PKG_NAME, target)
  } catch (err) {
    console.error(`[dev-upgrade] refusing to write: ${err.message}`)
    process.exit(1)
  }
  writeFileSync(manifestPath, updated)

  // 3. Install in the profile.
  run('pnpm', ['install'], profileDir)

  // 4. Verify the installed copy.
  const installedPkg = join(profileDir, 'node_modules', ...PKG_NAME.split('/'), 'package.json')
  const installed = JSON.parse(readFileSync(installedPkg, 'utf8')).version
  if (installed !== target) {
    console.error(`[dev-upgrade] installed version mismatch: expected ${target}, got ${installed}`)
    process.exit(1)
  }

  console.log(`[dev-upgrade] ${args.profile} upgraded to ${PKG_NAME}@${target}.`)
  console.log('[dev-upgrade] restart dsh (or /reload inside the TUI) to load the new copy.')
}

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[dev-upgrade] ${err?.message ?? err}`)
    process.exit(1)
  })
}
