/**
 * executeCommand compat-helper tests.
 *
 * Regression: dsh-commands rc.8 inserted an `images` parameter before
 * `signal` in CommandRuntime.execute().  The TUI's old call
 *   commands.execute(agent, line, signal)
 * passed `signal` into the `images` slot and left the real signal
 * undefined, crashing every slash command with
 *   "Cannot read properties of undefined (reading 'aborted')".
 *
 * executeCommand() normalises the call so the TUI always passes
 * (commands, agent, line, signal) and the helper routes to the correct
 * argument count for the installed dsh-commands version.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { executeCommand } from '../lib/commands.js'

const STUB_AGENT = /** @type {any} */ ({})
const STUB_LINE = '/model'
const NO_IMAGES = []

// ---------------------------------------------------------------------------
// rc.7 path: execute(agent, line, signal) — 3 args
// ---------------------------------------------------------------------------

test('executeCommand passes signal as 3rd arg for rc.7-style execute (3-arg)', async () => {
  const ac = new AbortController()
  const received = []

  const commands = {
    // Named 3 parameters exactly like rc.7's execute — .length === 3, so the
    // arity probe takes the true rc.7 branch (a rest-param mock would have
    // .length === 0 and only reach this branch by accident).
    execute(agent, line, signal) {
      received.push(agent, line, signal)
      return Promise.resolve(undefined)
    },
  }

  await executeCommand(commands, STUB_AGENT, STUB_LINE, ac.signal)

  assert.equal(received.length, 3, 'rc.7 execute should receive exactly 3 arguments')
  assert.equal(received[0], STUB_AGENT)
  assert.equal(received[1], STUB_LINE)
  assert.equal(received[2], ac.signal, '3rd arg must be the AbortSignal, not an images array')
  assert.equal(commands.execute.length, 3, 'mock must be a precise rc.7 shape')
})

test('executeCommand 3-arg path: signal is never undefined', async () => {
  const ac = new AbortController()
  /** @type {AbortSignal | undefined} */
  let capturedSignal

  const commands = {
    execute(_agent, _line, signal) {
      capturedSignal = signal
      return Promise.resolve(undefined)
    },
  }

  await executeCommand(commands, STUB_AGENT, STUB_LINE, ac.signal)

  assert.notEqual(capturedSignal, undefined, 'signal must not be undefined')
  assert.equal(capturedSignal.aborted, false)
})

test('executeCommand 3-arg path: aborted signal propagates .aborted = true', async () => {
  const ac = new AbortController()
  ac.abort()

  /** @type {AbortSignal | undefined} */
  let capturedSignal

  const commands = {
    execute(_agent, _line, signal) {
      capturedSignal = signal
      return Promise.resolve(undefined)
    },
  }

  await executeCommand(commands, STUB_AGENT, STUB_LINE, ac.signal)

  assert.equal(capturedSignal.aborted, true, 'aborted signal must propagate')
})

// ---------------------------------------------------------------------------
// rc.8 path: execute(agent, line, images, signal) — 4 args
// ---------------------------------------------------------------------------

test('executeCommand passes images + signal as 3rd/4th args for rc.8-style execute (4-arg)', async () => {
  const ac = new AbortController()
  const images = [{ mediaType: 'image/png', data: 'iVBOR...' }]
  let receivedArgs = []

  const commands = {
    execute(...args) {
      receivedArgs = args
      return Promise.resolve(undefined)
    },
  }

  await executeCommand(commands, STUB_AGENT, STUB_LINE, images, ac.signal)

  assert.equal(receivedArgs.length, 4, 'rc.8 execute should receive exactly 4 arguments')
  assert.equal(receivedArgs[0], STUB_AGENT)
  assert.equal(receivedArgs[1], STUB_LINE)
  assert.equal(receivedArgs[2], images, '3rd arg must be the images array')
  assert.equal(receivedArgs[3], ac.signal, '4th arg must be the AbortSignal')
})

test('executeCommand 4-arg path: signal is never undefined', async () => {
  const ac = new AbortController()
  /** @type {AbortSignal | undefined} */
  let capturedSignal

  const commands = {
    execute(_agent, _line, _images, signal) {
      capturedSignal = signal
      return Promise.resolve(undefined)
    },
  }

  await executeCommand(commands, STUB_AGENT, STUB_LINE, NO_IMAGES, ac.signal)

  assert.notEqual(capturedSignal, undefined, 'signal must not be undefined')
  assert.equal(capturedSignal.aborted, false)
})

// ---------------------------------------------------------------------------
// Return-value forwarding
// ---------------------------------------------------------------------------

test('executeCommand forwards the CommandExecution result', async () => {
  const ac = new AbortController()
  const fakeExecution = {
    commandId: 'test-id',
    result: { kind: 'success', text: 'done' },
  }

  const commands = {
    execute() { return Promise.resolve(fakeExecution) },
  }

  const result = await executeCommand(commands, STUB_AGENT, STUB_LINE, ac.signal)
  assert.equal(result, fakeExecution)
})

test('executeCommand forwards undefined (unknown command)', async () => {
  const ac = new AbortController()

  const commands = {
    execute() { return Promise.resolve(undefined) },
  }

  const result = await executeCommand(commands, STUB_AGENT, STUB_LINE, ac.signal)
  assert.equal(result, undefined)
})

test('executeCommand arity probe: 3-arg call against length-4 execute inserts [] and places signal 4th', async () => {
  const ac = new AbortController()
  const received = []

  const commands = {
    // Named 4 parameters exactly like rc.8's execute — .length === 4.
    execute(agent, line, images, signal) {
      received.push(agent, line, images, signal)
      return Promise.resolve(undefined)
    },
  }

  await executeCommand(commands, STUB_AGENT, STUB_LINE, ac.signal)

  assert.equal(commands.execute.length, 4, 'mock must be a precise rc.8 shape')
  assert.equal(received.length, 4)
  assert.equal(received[0], STUB_AGENT)
  assert.equal(received[1], STUB_LINE)
  assert.deepEqual(received[2], [], '3rd arg must be an empty images array (plain invocation)')
  assert.equal(received[3], ac.signal, '4th arg must be the AbortSignal')
})

// ---------------------------------------------------------------------------
// Crash repro: the exact scenario that broke in rc.8
// ---------------------------------------------------------------------------

test('rc.8 crash repro: calling 3-arg execute with signal must not leave signal undefined', async () => {
  const ac = new AbortController()

  // Simulate rc.8 handler that reads invocation.signal.aborted
  const commands = {
    execute(_agent, _line, images, signal) {
      // This is what rc.8 command handlers do — if signal is undefined
      // this throws "Cannot read properties of undefined (reading 'aborted')"
      const aborted = signal.aborted
      return Promise.resolve({ commandId: 'x', result: { kind: 'success' } })
    },
  }

  // Before the fix, this would crash because the TUI called
  // commands.execute(agent, line, signal) — passing signal as images,
  // leaving the real signal param undefined.
  // After the fix, executeCommand routes to the 4-arg form with [] as images.
  await assert.doesNotReject(
    () => executeCommand(commands, STUB_AGENT, STUB_LINE, ac.signal),
    'executeCommand must not crash when the underlying execute expects 4 args',
  )
})
