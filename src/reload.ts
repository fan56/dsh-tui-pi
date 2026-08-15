/**
 * Manual hot-reload for the dsh-tui-pi plugin.
 *
 * Mirrors @deepseek-ai/cordis-plugin-hmr's partial reload: evict the plugin
 * entry and its user-code dependency closure from the module caches, re-import
 * the entry fresh, then swap the plugin runtime in the registry so a new fiber
 * re-runs `apply` with the new code. A `/reload` after editing `src/` and
 * running `pnpm build` picks the change up without restarting dsh.
 *
 * The swap disposes the old fiber — the TUI, its timers, and the live agent
 * bridge are torn down (the session log persists and can be rejoined with
 * /resume). Failures before the swap leave the old TUI untouched; failures
 * during the swap roll the caches back and restart the previous code.
 */

import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ------------------------------------------------------------------- shapes --
// Minimal structural views of the loader internals; the real types live in
// @deepseek-ai/cordis-plugin-loader, which is not a dependency of this plugin.

/** Minimal Node internal ModuleJob surface. */
interface ModuleJobLike {
  url: string
  linked: Promise<ModuleJobLike[]>
}

/** Minimal Node internal ESM loader surface (Node 22 v1 / Node 24+ v2). */
interface InternalLoaderLike {
  version?: 'v1' | 'v2'
  loadCache: Map<string, unknown>
}

/** Minimal Loader service surface (EntryTree). */
interface LoaderLike {
  internal?: InternalLoaderLike
  import(specifier: string, getOuterStack?: () => string[]): Promise<unknown>
  unwrapExports(exports: unknown): unknown
}

/** Loader entry bookkeeping attached to plugin fibers by the loader. */
interface EntryLike {
  options: { name: string }
  fiber?: FiberLike
}

type FiberLike = Fiber & { entry?: EntryLike }

const require = createRequire(import.meta.url)

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Skip node: builtins and anything under node_modules (shared, stable). */
function isUserCode(url: string): boolean {
  return !url.startsWith('node:') && !url.includes('/node_modules/')
}

/** Recursively collect the user-code dependency closure of a module job. */
async function collectDependencies(job: ModuleJobLike, out: Set<string>): Promise<void> {
  if (out.has(job.url) || !isUserCode(job.url)) return
  out.add(job.url)
  for (const child of await job.linked) await collectDependencies(child, out)
}

/**
 * The entry URL the loader recorded equals `import.meta.url` of the entry
 * module, modulo symlink resolution — try both against the module cache.
 */
function resolveEntryUrl(fallbackUrl: string, internal: InternalLoaderLike): string {
  const candidates = [fallbackUrl]
  try {
    candidates.push(pathToFileURL(realpathSync(fileURLToPath(fallbackUrl))).href)
  } catch { /* non-file URL → fallbackUrl stands */ }
  for (const url of candidates) {
    if (Map.prototype.has.call(internal.loadCache, url)) return url
  }
  return candidates[0]!
}

// ------------------------------------------------------------------- reload --

let reloading: Promise<string> | undefined

/**
 * Reload the dsh-tui-pi plugin from the current source.
 *
 * @param ctx — the plugin context (the fiber being reloaded).
 * @param entryUrl — `import.meta.url` of the plugin entry module.
 * @returns a human-readable outcome; the plugin fiber is swapped on success.
 */
export function reloadPlugin(ctx: Context, entryUrl: string): Promise<string> {
  // Re-entrancy guard: a second /reload while one is in flight joins it.
  reloading ??= performReload(ctx, entryUrl).finally(() => { reloading = undefined })
  return reloading
}

async function performReload(ctx: Context, fallbackUrl: string): Promise<string> {
  const loader = ctx.get('loader') as LoaderLike | undefined
  const internal = loader?.internal
  if (loader === undefined) return 'Reload unavailable: the loader service is not mounted.'
  if (internal === undefined) return 'Reload unavailable: the module loader is not reachable.'

  const runtime = ctx.fiber.runtime
  if (runtime === null || runtime === undefined) return 'Reload unavailable: no plugin runtime.'

  const url = resolveEntryUrl(fallbackUrl, internal)
  const job = internal.loadCache.get(url) as ModuleJobLike | undefined
  if (job === undefined) return `Reload failed: the plugin entry is not loaded (${url}).`

  // Dependency closure of the entry: our lib/*.js only. node: builtins and
  // node_modules are shared with the rest of dsh and stay cached.
  const files = new Set<string>()
  try {
    await collectDependencies(job, files)
  } catch (error) {
    return `Reload failed: cannot walk the module graph (${messageOf(error)}).`
  }

  // Evict ESM loadCache + CJS Module._cache so the re-import re-reads source.
  // Map.prototype methods bypass Node 24+'s typed LoadCache overrides (its
  // `.delete` only nulls a type slot; a raw delete removes the entry).
  const esmBackup = new Map<string, unknown>()
  const cjsBackup = new Map<string, NodeModule>()
  for (const filename of files) {
    esmBackup.set(filename, Map.prototype.get.call(internal.loadCache, filename))
    Map.prototype.delete.call(internal.loadCache, filename)
    try {
      const filepath = fileURLToPath(filename)
      const cached = require.cache[filepath]
      if (cached) {
        cjsBackup.set(filepath, cached)
        delete require.cache[filepath]
      }
    } catch { /* not a file URL */ }
  }
  const restoreCaches = () => {
    for (const [filename, entry] of esmBackup) {
      if (entry === undefined) Map.prototype.delete.call(internal.loadCache, filename)
      else Map.prototype.set.call(internal.loadCache, filename, entry)
    }
    for (const [filepath, module] of cjsBackup) require.cache[filepath] = module
  }

  // Re-import the entry fresh; on failure restore the caches and keep the old
  // TUI untouched.
  let fresh: unknown
  try {
    fresh = loader.unwrapExports(await loader.import(url, () => []))
  } catch (error) {
    restoreCaches()
    return `Reload failed: ${messageOf(error)}`
  }

  const oldFibers = [...runtime.fibers]
  const oldCallback = runtime.callback
  try {
    // Remove the runtime first: the loader's internal/plugin handler checks
    // registry.has(callback) on disposal and must not mark the entry disabled,
    // and the fiber disposers then skip their own registry bookkeeping.
    ctx.registry.delete(oldCallback)
    // Await the old fiber's full unload (TUI stopped, terminal released)
    // before the fresh fiber starts its own TUI.
    await Promise.allSettled(oldFibers.map(fiber => Promise.resolve(fiber.dispose())))
    for (const oldFiber of oldFibers as FiberLike[]) {
      const next = oldFiber.parent.registry.plugin(fresh as Plugin, oldFiber._config, () => []) as FiberLike
      next.entry = oldFiber.entry
      if (next.entry) next.entry.fiber = next
      await next
    }
  } catch (error) {
    // Roll back: drop the failed fresh runtime, restore caches, and restart
    // the previous code so the TUI comes back.
    const message = messageOf(error)
    try { ctx.registry.delete(fresh as Plugin) } catch { /* contained */ }
    restoreCaches()
    try {
      for (const oldFiber of oldFibers) {
        await oldFiber.parent.registry.plugin(oldCallback, oldFiber._config, () => [])
      }
    } catch { /* contained */ }
    return `Reload failed: ${message}`
  }
  return 'Reloaded — the TUI restarted from the current source.'
}
