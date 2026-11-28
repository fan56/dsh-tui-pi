/**
 * The everything-stop's bridge legs — `cancelChild` / `cancelAllChildren` /
 * `hasRunningWork` (src/session.ts). The registry-facing cancel idiom must
 * match the maxAgents prune (`ctx.agents.get(id)?.cancel({kind:'user'}, {
 * keepInbox:true})`): the wire `session.cancel` refuses subagent-owned
 * sessions, and background/continuable children survive the parent turn's
 * cancel, so the TUI cancels each child through the in-process registry
 * handle. `hasRunningWork` is the keymap's widened running gate: live
 * children count even after the parent turn went idle.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { DshSessionBridge } from '../lib/session.js'

/** Harness: captured event handlers + a cancel-spying agents registry. */
function makeHarness(registeredChildren = []) {
  const handlers = new Map()
  const cancels = []
  const sessions = { get() { return undefined } }
  const ctx = {
    on(evt, fn) { handlers.set(evt, fn); return () => handlers.delete(evt) },
    get(key) { return key === 'sessions' ? sessions : undefined },
    agents: {
      async create() { return { agent: { id: 'root-agent', session: { id: 'root-session' } }, async dispose() {} } },
      get(id) {
        const child = registeredChildren.find(entry => entry.id === String(id))
        if (child === undefined) return undefined
        return {
          cancel(cause, options) { cancels.push([child.id, cause, options]) },
        }
      },
    },
  }
  return { ctx, handlers, cancels }
}

function makeBridge(ctx) {
  return new DshSessionBridge(ctx, {
    onLive: () => {}, onStatus: () => {}, onEvent: () => {},
  })
}

/** Feed one event through the bridge's captured `session/event` subscription. */
function emit(handlers, session, event) {
  handlers.get('session/event')(session, event)
}

/** Discover a child (workflow start on the parent) and give it one round. */
function discoverChild(handlers, childId) {
  emit(handlers, { id: 'root-session', header: {} }, {
    type: 'tool-workflow/agent-start',
    time: 1,
    data: { runId: 'r1', seq: 0, label: 'workhorse', childId },
  })
}

test('cancelChild cancels a registered live child with keepInbox', async () => {
  const { ctx, cancels } = makeHarness([{ id: 'child-1' }])
  const bridge = makeBridge(ctx)
  await bridge.ensureAgent()
  assert.equal(bridge.cancelChild('child-1'), true)
  assert.deepEqual(cancels, [['child-1', { kind: 'user' }, { keepInbox: true }]])
})

test('cancelChild: an unregistered child is a false, not a throw', async () => {
  const { ctx } = makeHarness([])
  const bridge = makeBridge(ctx)
  await bridge.ensureAgent()
  assert.equal(bridge.cancelChild('ghost'), false)
})

test('cancelChild: a throwing registry degrades to false', async () => {
  const handlers = new Map()
  const ctx = {
    on(evt, fn) { handlers.set(evt, fn); return () => handlers.delete(evt) },
    get() { return undefined },
    agents: {
      // Create works (the bridge boots) but lookups throw — a foreign or
      // partially-mounted registry must read as "nothing to stop".
      async create() { return { agent: { id: 'root-agent', session: { id: 'root-session' } }, async dispose() {} } },
      get() { throw new Error('foreign registry') },
    },
  }
  const bridge = makeBridge(ctx)
  await bridge.ensureAgent()
  assert.equal(bridge.cancelChild('child-1'), false)
})

test('cancelAllChildren stops every live child and skips settled ones', async () => {
  const { ctx, handlers, cancels } = makeHarness([{ id: 'child-1' }, { id: 'child-2' }, { id: 'child-3' }])
  const bridge = makeBridge(ctx)
  await bridge.ensureAgent()
  discoverChild(handlers, 'child-1')
  discoverChild(handlers, 'child-2')
  discoverChild(handlers, 'child-3')
  // child-2 settles: its turn closes (the best-effort outcome fold).
  emit(handlers, { id: 'child-2', header: {} }, { type: 'turn/end', seq: 9, time: 2 })
  assert.equal(bridge.cancelAllChildren(), 2)
  assert.deepEqual(cancels.map(([id]) => id), ['child-1', 'child-3'], 'the settled child is never cancelled')
})

test('cancelAllChildren counts only children whose cancel succeeded', async () => {
  const { ctx } = makeHarness([{ id: 'child-1' }])
  const bridge = makeBridge(ctx)
  await bridge.ensureAgent()
  // Nothing discovered — zero live children.
  assert.equal(bridge.cancelAllChildren(), 0)
})

test('hasRunningWork: live children keep the gate on after the parent went idle', async () => {
  const { ctx, handlers } = makeHarness([])
  const bridge = makeBridge(ctx)
  await bridge.ensureAgent()
  assert.equal(bridge.hasRunningWork(), false, 'idle parent, no children')

  handlers.get('agent/status')({ agent: { id: 'root-agent' }, status: 'running' })
  assert.equal(bridge.hasRunningWork(), true, 'mid-turn parent')
  handlers.get('agent/status')({ agent: { id: 'root-agent' }, status: 'idle' })
  assert.equal(bridge.hasRunningWork(), false, 'the parent settled again')

  // A background child keeps working after the parent turn ended — the
  // exact scenario the old `isRunning`-only gate went blind in.
  discoverChild(handlers, 'child-bg')
  assert.equal(bridge.hasRunningWork(), true, 'a live child counts as running work')
  emit(handlers, { id: 'child-bg', header: {} }, { type: 'turn/end', seq: 9, time: 2 })
  assert.equal(bridge.hasRunningWork(), false, '…and a settled child does not')
})

// ---------------------------------------------------------------------------
// External stop channel (T25): an external member has no local Agent, so
// cancelChild must branch to the host's `interruptByUser` instead of silently
// returning false. Local children keep the registry cancel path.

function makeExternalStopHarness({ reject = false, registeredChildren = [] } = {}) {
  const base = makeHarness(registeredChildren)
  const interrupts = []
  const externalRows = []
  const subCtx = {
    ...base.ctx,
    get(key) {
      if (key === 'subagents') return {
        listDescendants: async () => externalRows,
        interruptByUser(id) {
          if (reject) throw new Error('gateway/internal')
          interrupts.push(id)
          return { accepted: true }
        },
      }
      return base.ctx.get(key)
    },
  }
  return { ...base, ctx: subCtx, interrupts, externalRows }
}

async function addExternal(harness, id) {
  harness.externalRows.push({ kind: 'child', id, activity: 'inactive', mode: 'external', label: id })
  const bridge = makeBridge(harness.ctx)
  await bridge.ensureAgent()
  await bridge.reconcileLiveWithProjection()
  return bridge
}

test('cancelChild routes an external row to interruptByUser, never the local registry', async () => {
  const harness = makeExternalStopHarness()
  const bridge = await addExternal(harness, 'ext-1')
  assert.equal(bridge.cancelChild('ext-1'), true)
  assert.deepEqual(harness.interrupts, ['ext-1'], 'the host interrupt was called with the child id')
  assert.deepEqual(harness.cancels, [], 'no local Agent cancel was attempted for the external row')
  assert.equal(bridge.cancelChildStatus('ext-1'), 'external-accepted', 'the channel is reported for UI feedback')
  await bridge.dispose()
})

test('a rejected external interrupt reads as false / rejected without throwing', async () => {
  const harness = makeExternalStopHarness({ reject: true })
  const bridge = await addExternal(harness, 'ext-2')
  assert.equal(bridge.cancelChild('ext-2'), false)
  assert.equal(bridge.cancelChildStatus('ext-2'), 'rejected')
  await bridge.dispose()
})

test('cancelAllChildren stops local and external rows through their own channels', async () => {
  const harness = makeExternalStopHarness({ registeredChildren: [{ id: 'child-1' }] })
  const bridge = await addExternal(harness, 'ext-3')
  discoverChild(harness.handlers, 'child-1')
  assert.equal(bridge.cancelAllChildren(), 2, 'both the local and the external row are stopped')
  assert.deepEqual(harness.interrupts, ['ext-3'])
  assert.deepEqual(harness.cancels.map(([id]) => id), ['child-1'])
  await bridge.dispose()
})
