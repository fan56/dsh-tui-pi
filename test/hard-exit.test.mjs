/**
 * hard-exit tests — the guarded process-exit tail (deferred process.exit +
 * the Worker-thread SIGKILL watchdog against the libuv threadpool-drain
 * hang). Runs against the built lib/ (pnpm build && pnpm test).
 *
 * The watchdog cannot be observed from inside the process under test (the
 * whole point is that nothing on the stuck main thread runs), so each case
 * spawns a child node that calls hardExit and reports its exit through the
 * process boundary.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LIB = fileURLToPath(new URL('../lib/hard-exit.js', import.meta.url))

/** Spawn `node -e BODY` importing the built module; resolve on exit. */
function runChild(body) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', body], {
      env: { ...process.env, HARD_EXIT_LIB: LIB },
      stdio: 'ignore',
    })
    const startedAt = Date.now()
    child.on('close', (code, signal) => resolve({ code, signal, elapsedMs: Date.now() - startedAt }))
  })
}

const importAndExit = (code, watchdogMs) => `
  const { hardExit } = await import(process.env.HARD_EXIT_LIB);
  hardExit(${code}, ${watchdogMs});
`

test('hardExit exits with the given code and never trips the watchdog', async () => {
  const run = await runChild(importAndExit(3, 60_000))
  assert.equal(run.code, 3)
  assert.equal(run.signal, null)
  // The watchdog is armed for a minute but the graceful exit must land in
  // microseconds — a slow exit here would mean the defer/worker machinery
  // is interfering with the normal path.
  assert.ok(run.elapsedMs < 10_000, `exit took ${run.elapsedMs}ms`)
})

test('hardExit defaults the watchdog when called with only a code', async () => {
  const run = await runChild(`
    const { hardExit } = await import(process.env.HARD_EXIT_LIB);
    hardExit(0);
  `)
  assert.equal(run.code, 0)
  assert.equal(run.signal, null)
})

test('watchdog SIGKILLs the process when the main thread is stuck after hardExit', async () => {
  // Simulate the libuv threadpool-drain hang: the exit is armed but the
  // main thread never reaches (or never returns from) it. Atomics.wait
  // freezes the main thread without touching libuv, so only the watchdog
  // worker can still act.
  const run = await runChild(`
    const { hardExit } = await import(process.env.HARD_EXIT_LIB);
    const lock = new Int32Array(new SharedArrayBuffer(4));
    hardExit(0, 400);
    Atomics.wait(lock, 0, 0); // blocked forever — the watchdog is the only way out
  `)
  assert.equal(run.signal, 'SIGKILL', `expected SIGKILL, got code=${run.code} signal=${run.signal}`)
  // Fired at ~400ms; allow generous scheduler slack but catch a missing watchdog.
  assert.ok(run.elapsedMs < 15_000, `watchdog took ${run.elapsedMs}ms`)
})
