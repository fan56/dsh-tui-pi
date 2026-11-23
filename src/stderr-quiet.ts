/**
 * In-process quieting of the periodic model-listing SUCCESS line.
 *
 * The dsh core writes that line straight to `process.stderr` via
 * `console.error(tag, message)` (dsh-llm-deepseek `host.ts`), on the same
 * process as this plugin and every 10 minutes. A raw stderr write paints over
 * the pi-tui alt-screen frame; it never goes through this plugin's notice
 * bridge. The only reachable interception point is the stderr exit itself.
 *
 * Policy: ONLY a write whose ENTIRE text matches {@link MODEL_LISTING_SUCCESS}
 * is swallowed. Half lines, chunks without a trailing newline, multi-line
 * blocks and every other byte stream are forwarded unchanged — miss a noisy
 * line rather than eat a real signal. Failure lines (`failed (…)`,
 * `refresh failed`, `change notification failed`) do not match and stay
 * visible.
 *
 * Patch state lives on a globalThis symbol singleton: `/reload` evicts the
 * ESM module but not the symbol, so a fresh module instance reuses the same
 * patch and only flips `enabled`. The patch closure reads `enabled` from the
 * shared state on EVERY write (never a captured module local), which avoids
 * orphan closures holding a stale value. `resetStderrQuiet()` is a test seam
 * only — production never unpatches; `enabled = false` is already a no-op and
 * the patch dies with the process.
 */

/** One complete model-listing success line, including its trailing newline. */
export const MODEL_LISTING_SUCCESS =
  /^\[[^\]\r\n]+\] model listing from \S+ loaded \d+ model\(s\), skipped \d+ row\(s\)\r?\n$/

interface StderrQuietState {
  installed: boolean
  enabled: boolean
  originalWrite?: typeof process.stderr.write
  patchedWrite?: typeof process.stderr.write
}

/** Survives ESM module eviction on `/reload` — the single source of truth. */
const STATE_KEY = Symbol.for('dsh-tui-pi.stderrQuiet')

function quietState(): StderrQuietState {
  const holder = globalThis as unknown as Record<symbol, StderrQuietState | undefined>
  let state = holder[STATE_KEY]
  if (state === undefined) {
    state = { installed: false, enabled: true }
    holder[STATE_KEY] = state
  }
  return state
}

/** Flip the shared switch. Safe before install; the patch reads it per write. */
export function setStderrQuietEnabled(enabled: boolean): void {
  quietState().enabled = enabled
}

/**
 * Install the stderr wrapper once per process. Idempotent: a second call
 * (notably after `/reload`) leaves the existing patch in place instead of
 * stacking wrappers. Whatever `write` is installed at call time is captured
 * as the passthrough target, which is also the DI seam used by the tests.
 */
export function installStderrQuiet(): void {
  const state = quietState()
  if (state.installed && state.patchedWrite !== undefined && process.stderr.write === state.patchedWrite) return

  const originalWrite = process.stderr.write
  const patched = function (
    this: NodeJS.WriteStream,
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    if (quietState().enabled && (typeof chunk === 'string' || chunk instanceof Uint8Array)) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      if (MODEL_LISTING_SUCCESS.test(text)) {
        const cb = typeof encoding === 'function' ? encoding : callback
        if (cb !== undefined) process.nextTick(cb)
        return true
      }
    }
    // Reflect.apply hands the ORIGINAL arguments object to the original
    // write: same `this`, same (chunk, cb) / (chunk, enc, cb) shape, same
    // bytes, same backpressure return value. Nothing is decoded or rebuilt.
    return Reflect.apply(originalWrite, process.stderr, arguments as unknown as unknown[])
  }
  state.originalWrite = originalWrite
  state.patchedWrite = patched as unknown as typeof process.stderr.write
  state.installed = true
  process.stderr.write = state.patchedWrite
}

/** Test seam: restore the write captured at install time and clear the state. */
export function resetStderrQuiet(): void {
  const state = quietState()
  if (state.installed && state.originalWrite !== undefined && process.stderr.write === state.patchedWrite) {
    process.stderr.write = state.originalWrite
  }
  state.installed = false
  state.originalWrite = undefined
  state.patchedWrite = undefined
  state.enabled = true
}
