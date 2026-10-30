/**
 * Idle lock release (the lock half of the takeover contract): after
 * `idleReleaseSec` of silence the bridge disposes its write handle so other
 * surfaces (the phone's /resume, a second TUI) can take the session; the
 * next prompt or command re-takes the SAME session id through
 * `onReattached` (resume + display rebuild). A lease meanwhile won by
 * another surface keeps the released state (retry on a later send) and
 * fails the prompt with an actionable error. Live children block the
 * release; 0 disables it.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { DshSessionBridge } from '../lib/session.js'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'

/** Durable log the "other surface" appended while the TUI slept. */
const PERSISTED = [
  { type: 'session', id: 's1', seq: 0 },
  { type: 'user/message', seq: 1, data: {} },
  { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'phone turn' }] } } },
]
/** What the TUI had seen when it released. */
const SEEN_AT_RELEASE = 1

function makeHarness({ idleReleaseSec = 0.05 } = {}) {
  const handlers = new Map()
  let failNextResumeOwned = false
  const creates = []
  const resumes = []
  const handles = []
  let agentSeq = 0
  const ctx = {
    on(evt, fn) { handlers.set(evt, fn); return () => handlers.delete(evt) },
    get(key) { return undefined },
    agents: {
      async create(options) {
        creates.push(String(options.sessionId))
        const agent = {
          id: `agent-${++agentSeq}`,
          session: { id: String(options.sessionId), snapshotEvents: () => PERSISTED.slice(0, SEEN_AT_RELEASE) },
          status: 'idle',
          followup() {},
          steer() {},
        }
        const handle = { agent, disposed: false, dispose: async () => { handle.disposed = true } }
        handles.push(handle)
        return handle
      },
      async resume(options) {
        const id = String(options.resumeSessionId)
        if (failNextResumeOwned) {
          failNextResumeOwned = false
          throw new SessionAlreadyOwnedError(String(options.resumeSessionId))
        }
        resumes.push(id)
        const agent = {
          id: `agent-${++agentSeq}`,
          session: { id, snapshotEvents: () => PERSISTED.slice() },
          status: 'idle',
          followup() {},
          steer() {},
        }
        const handle = { agent, disposed: false, dispose: async () => { handle.disposed = true } }
        handles.push(handle)
        return handle
      },
      get() { return undefined },
    },
  }
  const setOwned = () => { failNextResumeOwned = true }
  return { ctx, handlers, creates, resumes, handles, setOwned }
}

function makeBridge(ctx, { idleReleaseSec = 0.05 } = {}) {
  const reattached = []
  let bridgeRef
  const bridge = new DshSessionBridge(ctx, {
    onLive: () => {},
    onStatus: () => {},
    onEvent: () => {},
    // mirrors index.ts's onReattached: the UI rebinds via bridge.resume()
    onReattached: async (id) => {
      await bridgeRef.resume(id)
      reattached.push(id)
    },
  }, { idleReleaseSec: () => idleReleaseSec, remoteTailOptions: { intervalMs: 60_000 } })
  bridgeRef = bridge
  return { bridge, reattached }
}

/** Drive one turn to completion: prompt, then the running→idle transition
 * that settles it (and arms the idle timer). */
async function runTurn(bridge, env, text) {
  const pending = bridge.prompt(text)
  await new Promise(resolve => setTimeout(resolve, 0))
  const agent = bridge.getAgent()
  // the host delivers agent/status as ONE payload object ({agent, status})
  env.handlers.get('agent/status')({ agent: { id: agent.id }, status: 'running' })
  env.handlers.get('agent/status')({ agent: { id: agent.id }, status: 'idle' })
  await pending
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('idle release frees the handle; the next prompt re-takes the SAME session id', async () => {
  const env = makeHarness()
  const { bridge, reattached } = makeBridge(env.ctx)
  await runTurn(bridge, env, 'first')
  const firstId = env.creates[0]
  assert.equal(env.handles[0].disposed, false)
  await sleep(200)
  assert.equal(env.handles[0].disposed, true, 'the write handle was released after the quiet window')
  assert.equal(bridge.getAgent(), undefined)
  // the next prompt wakes: same id, through the registered onReattached
  await bridge.prompt('second')
  assert.deepEqual(reattached, [firstId])
  assert.deepEqual(env.resumes, [firstId])
  assert.equal(bridge.getAgent().session.id, firstId)
})

test('a lease owned elsewhere fails the wake and keeps the released id for a retry', async () => {
  const env = makeHarness()
  const { bridge, reattached } = makeBridge(env.ctx)
  await runTurn(bridge, env, 'first')
  await sleep(200)
  env.setOwned()
  await assert.rejects(() => bridge.prompt('second'), /another process/)
  assert.deepEqual(reattached, [], 'the failed wake never reports success')
  // the released id survived the refusal — a later send re-takes it
  await bridge.prompt('third')
  assert.deepEqual(env.resumes, [env.creates[0]])
  assert.equal(bridge.getAgent().session.id, env.creates[0])
})

test('a command path (ensureAgent) also wakes instead of minting a fresh session', async () => {
  const env = makeHarness()
  const { bridge } = makeBridge(env.ctx)
  await runTurn(bridge, env, 'first')
  await sleep(200)
  await bridge.ensureAgent()
  assert.deepEqual(env.resumes, [env.creates[0]], 'the released session was re-taken, not replaced')
  assert.equal(env.creates.length, 1, 'no fresh session was created behind the command')
})

test('a running child blocks the release', async () => {
  const env = makeHarness()
  const { bridge } = makeBridge(env.ctx)
  await runTurn(bridge, env, 'first')
  // discover a live child (workflow start on the parent) that never ends
  env.handlers.get('session/event')({ id: env.creates[0], header: {} }, {
    type: 'tool-workflow/agent-start',
    time: 1,
    data: { runId: 'r1', seq: 0, label: 'workhorse', childId: 'child-1' },
  })
  await sleep(200)
  assert.equal(env.handles[0].disposed, false, 'live work keeps the lock')
})

test('idleReleaseSec 0 disables the release', async () => {
  const env = makeHarness()
  const { bridge } = makeBridge(env.ctx, { idleReleaseSec: 0 })
  await runTurn(bridge, env, 'first')
  await sleep(200)
  assert.equal(env.handles[0].disposed, false)
})

test('a session switch abandons the released id', async () => {
  const env = makeHarness()
  const { bridge, reattached } = makeBridge(env.ctx)
  await runTurn(bridge, env, 'first')
  await sleep(200)
  await bridge.resume('picked-history')
  await bridge.prompt('second')
  assert.deepEqual(reattached, [], 'the released id did not survive the switch')
  assert.deepEqual(env.resumes, ['picked-history'])
  assert.equal(env.creates.length, 1)
})
