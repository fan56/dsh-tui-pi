/**
 * Boot-time replacement for the stock `session-projection-cache` bundle row.
 *
 * cordis.patch.yml disables the stock row and inserts an entry mounting this
 * module instead. The alpha.4 schema fail-fasts at storage-open on records
 * written by 0.1.1-rc.2-era hosts, and that happens inside the stock
 * plugin's own Service.init — no later-initializing plugin can intercept it,
 * the loader tears down the whole boot. Module evaluation is the only hook
 * the loader reaches strictly before Service.init, so the migration runs
 * here, at import time, backfilling the legacy records on disk before the
 * stock code opens its storage domain.
 *
 * The stock module itself has no import-time side effects (class and zod
 * schema definitions only), so the hoisted re-export below evaluating first
 * is harmless. Migration is fail-open: any error warns on stderr and leaves
 * the boot exactly where it would have been without the wrapper.
 *
 * Consumers of the stock package's named exports import
 * `@deepseek-ai/dsh-session-projection-cache` directly and share this same
 * module instance; only the loader reaches the plugin through here.
 */
import { preflightProjcache, projcacheSessionsDir } from './preflight-projcache.js'

try {
  preflightProjcache(projcacheSessionsDir())
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`[preflight-projcache] skipped: ${message}\n`)
}

export * from '@deepseek-ai/dsh-session-projection-cache'
export { default } from '@deepseek-ai/dsh-session-projection-cache'
