/**
 * Postinstall linker: point every `node_modules/@deepseek-ai/*` entry at the
 * global dsh closure.
 *
 * Why this exists: dsh-tui-pi is a plugin that runs *inside* the installed
 * dsh CLI, and its source imports the `@deepseek-ai/*` packages (cordis,
 * dsh-session, dsh-settings, schemastery, …). Those packages are **not**
 * resolvable from the public npm registry in a usable way (their rc.6
 * versions live only in the dsh install's own node_modules), so the repo
 * resolves them from the *global dsh closure* —
 * `$(realpath $(which dsh))/node_modules/@deepseek-ai` — via plain symlinks.
 *
 * The contract: ALL `@deepseek-ai/*` resolve to that single closure instance,
 * so there is exactly one `@deepseek-ai/cordis` in the type graph. Declaring
 * any of them in package.json made `pnpm install` create a second local copy
 * in `.pnpm`, which broke the cordis `declare module` augmentation
 * (`Property 'settings' does not exist on type 'Context'`), so they must stay
 * *undeclared*. pnpm then treats the closure links as extraneous — and, as
 * it prunes entries it once managed, the links can still disappear after an
 * install. This script re-creates them on every `pnpm install` (postinstall).
 *
 * It is a no-op (exit 0) when no global dsh install is found — a dev machine
 * without dsh simply cannot typecheck against dsh types.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
// Guard: this postinstall is a dev-machine convenience for THIS repo. A
// published tarball carries scripts/ but no src/, and must never touch a
// consumer's node_modules (it would delete their @deepseek-ai packages and
// replace them with symlinks into their global dsh closure). pnpm ≥10 blocks
// dependency lifecycle scripts by default, but npm would run this — exit
// silently outside the repo.
if (!existsSync(join(repoRoot, 'src'))) {
  process.exit(0)
}
const scopeDir = join(repoRoot, 'node_modules', '@deepseek-ai')

/** The global dsh package's own `node_modules/@deepseek-ai` closure dir. */
function findDshClosure() {
  // 0) Explicit override for dev/typecheck against an unreleased dsh line,
  //    e.g. a scratch closure from: npm i --prefix ~/tmp/dsh-alpha-closure @deepseek-ai/dsh@alpha
  //    DSH_CLOSURE_DIR=~/tmp/dsh-alpha-closure/node_modules/@deepseek-ai node scripts/link-dsh-closure.mjs
  const override = process.env.DSH_CLOSURE_DIR
  if (override !== undefined && override !== "") {
    const dir = realpathSync(override)
    if (existsSync(join(dir, "cordis"))) return dir
    console.warn(`[link-dsh-closure] DSH_CLOSURE_DIR=${override} lacks @deepseek-ai/cordis — ignoring override`)
  }
  // 1) Follow the `dsh` bin — the most faithful pointer to the installed CLI
  //    (`/opt/homebrew/bin/dsh` → …/lib/bin.js → pkg dir → its node_modules).
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
    if (bin !== '') {
      const real = realpathSync(bin)
      const closure = join(dirname(dirname(real)), 'node_modules', '@deepseek-ai')
      if (existsSync(join(closure, 'cordis'))) return closure
    }
  } catch { /* dsh not on PATH */ }
  // 2) Fall back to the global node_modules root — the dsh package's own
  //    nested closure (what current npm produces for a global install).
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    const nested = join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
    if (existsSync(join(nested, 'cordis'))) return nested
    // 3) Last resort: npm's flat global layout, where dsh's @deepseek-ai/*
    //    deps are hoisted straight into <npm root -g>/@deepseek-ai next to
    //    the dsh package itself.
    const flat = join(root, '@deepseek-ai')
    if (existsSync(join(flat, 'cordis'))) return flat
  } catch { /* npm unavailable */ }
  return undefined
}

const closure = findDshClosure()
if (closure === undefined) {
  console.warn('[link-dsh-closure] global dsh not found — skipping @deepseek-ai links (dev without dsh)')
  process.exit(0)
}

mkdirSync(scopeDir, { recursive: true })
let linked = 0
for (const name of readdirSync(closure)) {
  const target = join(scopeDir, name)
  const source = join(closure, name)
  try {
    // Replace any existing entry (stale symlink, or a local .pnpm copy a
    // previous install created) with the closure link.
    rmSync(target, { recursive: true, force: true })
    symlinkSync(source, target, 'junction')
    linked++
  } catch (error) {
    console.warn(`[link-dsh-closure] failed to link ${name}: ${(error instanceof Error ? error.message : String(error))}`)
  }
}
console.log(`[link-dsh-closure] linked ${linked} @deepseek-ai/* packages from ${closure}`)
