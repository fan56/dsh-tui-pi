/**
 * Hard-exit helper — the tail of every self-initiated process exit.
 *
 * `process.exit()` is not unconditional: Node drains the libuv threadpool
 * before dying, and a threadpool request completing at exactly that moment
 * (observed live: the session log's file close delivering its completion
 * callback while the Ctrl+C×2 quit path exits) can leave
 * `uv__threadpool_cleanup` joining a worker forever. The process then hangs
 * AFTER the goodbye line printed — alive, holding the terminal with cooked
 * mode restored but no shell in the foreground, deaf to every key (`sample`
 * showed the main thread parked in `pthread_join` for 30+ minutes while
 * every libuv worker sat idle; the user's only way out was `kill -9`).
 *
 * Two defenses, because nothing on the main thread can run while that exit
 * is blocked (JS timers never fire there):
 *
 * 1. the exit is deferred one turn of the event loop (`setImmediate`) —
 *    the observed hang was triggered by calling `process.exit` from inside
 *    a threadpool completion callback, and exiting from the check phase
 *    starts the threadpool drain from a quiet stack instead;
 * 2. a Worker-thread watchdog arms a one-shot SIGKILL at `watchdogMs` —
 *    workers run their own event loop on a separate thread, so the timer
 *    fires even with the main thread stuck inside `process.exit`. Normal
 *    quits never feel it: the exit lands in microseconds and the worker
 *    dies with the process; the pathological case is bounded to the
 *    watchdog delay (the shell comes back, exit code 137 instead of an
 *    eternal hang).
 */

import { Worker } from 'node:worker_threads'

/** Grace period before the watchdog SIGKILLs a stuck exit. */
export const EXIT_WATCHDOG_MS = 3_000

function exitNow(code: number, watchdogMs: number): void {
  try {
    const source = `
      // Ref'd on purpose: the timer is the only thing keeping this worker's
      // event loop alive, and an unref'd one would let the worker exit
      // before it ever fires. The worker itself is unref'd from the main
      // side below — that is what keeps it from holding the process open.
      setTimeout(() => { process.kill(process.pid, 'SIGKILL') }, ${watchdogMs});
    `
    const watchdog = new Worker(source, { eval: true })
    // The watchdog must not keep the process alive on its own account — it
    // only matters while the main thread is stuck inside process.exit, and
    // on every clean path the process (and with it the worker) is long gone
    // before the timer runs.
    watchdog.unref()
  } catch {
    // No worker support (exotic embeddings): exit unguarded rather than
    // not at all — the deferred exit below is still the normal path.
  }
  // One loop turn off the caller's stack: never exit from inside a
  // threadpool completion callback (see the module doc).
  setImmediate(() => process.exit(code))
}

/**
 * Exit the process after `code`, guarded against the threadpool-drain hang.
 * Every self-initiated exit (Ctrl+C×2 quit, Ctrl+D, smoke fallback, boot
 * guard) goes through here instead of calling `process.exit` directly.
 */
export function hardExit(code: number, watchdogMs: number = EXIT_WATCHDOG_MS): void {
  exitNow(code, watchdogMs)
}
