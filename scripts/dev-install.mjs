#!/usr/bin/env node
/**
 * Dev loop: build → pack → install into a dsh profile — the same flow a real
 * user gets (`dsh plugin add <tarball>`), no `link:` mount, no live-repo
 * resolution at runtime.
 *
 * Usage:  node scripts/dev-install.mjs [profile]
 *         (profile defaults to "tui")
 *
 * Steps:
 *   1. `pnpm build`  — emit lib/ from src/.
 *   2. `pnpm pack`   — produce <name>-<version>.tgz in the repo root.
 *   3. In ~/.dsh/profiles/<profile>: remove the two installed copies of the
 *      plugin (bundle name `dsh-tui-pi` + scoped `@aiwayds/dsh-tui-pi`), then
 *      `pnpm install`. The file: tarball deps are reinstalled from the fresh
 *      tarball (pnpm does NOT re-read a changed tarball while the node_modules
 *      entry exists — the remove is what forces the refresh).
 *
 * The profile's package.json must declare BOTH keys pointing at the tarball:
 *   "dsh-tui-pi":        "file:<repo>/<name>-<version>.tgz"   (bundle resolution)
 *   "@aiwayds/dsh-tui-pi": "file:<repo>/<name>-<version>.tgz" (loader import)
 * and pnpm-workspace.yaml must carry the pi-tui patchedDependencies (see
 * ~/.dsh/profiles/tui/pnpm-workspace.yaml).
 *
 * After installing: restart dsh (or /reload inside the TUI) to load the new
 * copy.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const profileName = process.argv[2] ?? 'tui'
const profileDir = join(homedir(), '.dsh', 'profiles', profileName)

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}

if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`[dev-install] profile not found: ${profileDir}`)
  process.exit(1)
}

// 1. build
run('pnpm', ['build'], repoRoot)

// 2. pack
run('pnpm', ['pack'], repoRoot)
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
// pnpm packs scoped packages as <scope>-<name>-<version>.tgz (@aiwayds/dsh-tui-pi
// → aiwayds-dsh-tui-pi-0.2.0.tgz).
const tarballName = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`
const tarball = join(repoRoot, tarballName)
if (!existsSync(tarball)) {
  console.error(`[dev-install] tarball not produced: ${tarball}`)
  process.exit(1)
}
console.log(`[dev-install] tarball: ${tarball}`)

// 3. refresh the profile's installed copies (remove forces reinstall of the
//    changed file: tarball — pnpm skips re-reading it while the entry exists)
for (const dir of ['dsh-tui-pi', join('@aiwayds', 'dsh-tui-pi')]) {
  rmSync(join(profileDir, 'node_modules', dir), { recursive: true, force: true })
}
run('pnpm', ['install'], profileDir)

console.log(`[dev-install] installed into ${profileName} — restart dsh (or /reload) to load the new copy.`)
