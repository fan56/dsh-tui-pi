/**
 * `subagent_status` tool tests: the model-facing live board. The tool is a
 * pure projection of its inputs — fake bridge views plus fake policy stats —
 * so every test asserts what the MODEL sees: the head line (cap headroom and
 * admission counters), the live rows with per-child progress, the recent
 * settles, and the registration contract (disposer, tools-less no-op, and
 * never mistaken for a spawn tool by the maxAgents guard). Runs against the
 * built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { SUBAGENT_STATUS_TOOL_NAME, buildSubagentStatusTool, installSubagentStatusTool } from '../lib/subagent-status-tool.js'
import { SPAWN_TOOLS, applySubagentPolicy } from '../lib/subagent-policy.js'
import { TUI_SURFACE_KEY } from '../lib/subagent-policy.js'

/** Fake settings provider: one `dsh-tui` section with the given limits. */
function makeSettings(limits) {
  return { describe: () => [{ ns: 'dsh-tui', value: { disableSubagent: false, ...limits } }] }
}

/** Fake plugin ctx carrying only what the tool reads: settings + tools. */
function makeCtx({ settings, capturedRegistry } = {}) {
  return {
    get(name) {
      if (name === 'settings') return settings
      if (name === 'tools') {
        return {
          register(definition) {
            capturedRegistry?.push(definition)
            return () => {}
          },
        }
      }
      return undefined
    },
  }
}

/** A child view shaped like the bridge's AgentView (only the fields the board renders). */
function childView(overrides = {}) {
  return {
    childId: 'abcdef1234567890',
    label: '🐴牛马狗',
    startedAt: 1_000,
    tokens: 0,
    contextTokens: 0,
    rounds: 0,
    retries: 0,
    ...overrides,
  }
}

function makeRuntime({ views = [], stats } = {}) {
  return {
    views: () => views,
    stats: () => stats ?? { live: 0, allowed: 0, denied: 0, pruned: 0, inFlight: 0 },
  }
}

async function boardText(ctx, runtime) {
  const tool = buildSubagentStatusTool(ctx, runtime)
  const value = await tool.execute({}, {})
  assert.equal(value.kind, 'subagent_status')
  return value.text
}

test('the board head names the cap headroom and the admission counters', async () => {
  const ctx = makeCtx({ settings: makeSettings({ maxAgents: 2, maxRounds: 50 }) })
  const text = await boardText(ctx, makeRuntime({
    stats: { live: 2, allowed: 6, denied: 4, pruned: 1, inFlight: 0 },
  }))
  assert.ok(text.includes('live 2/2'), 'the head shows live against the cap')
  assert.ok(text.includes('admitted 6'), 'admitted counter')
  assert.ok(text.includes('denied 4'), 'denied counter')
  assert.ok(text.includes('pruned 1'), 'pruned counter')
  assert.ok(text.includes('in-flight 0'), 'in-flight counter')
})

test('live rows carry per-child progress; settled rows list their outcome', async () => {
  const ctx = makeCtx({ settings: makeSettings({ maxAgents: 2, maxRounds: 50 }) })
  const text = await boardText(ctx, makeRuntime({
    views: [
      childView({ childId: 'abcdef1234567890', label: '🐴牛马狗', rounds: 12, tokens: 3200, lastTool: 'bash' }),
      childView({ childId: '98765432fedcba00', label: 'oldfox', rounds: 4, outcome: 'cancelled', endedAt: 5_000 }),
    ],
    stats: { live: 1, allowed: 2, denied: 0, pruned: 0, inFlight: 0 },
  }))
  assert.ok(text.includes('#abcdef12'), 'live row shows the short id')
  assert.ok(text.includes('🐴牛马狗'), 'live row shows the label')
  assert.ok(text.includes('rounds 12'), 'live row shows the round count')
  assert.ok(text.includes('last=bash'), 'live row shows the last tool')
  assert.ok(text.includes('#98765432'), 'settled row shows its short id')
  assert.ok(text.includes('outcome=cancelled'), 'settled row shows the outcome')
  assert.ok(text.includes('recent settles'), 'settles are separated from live rows')
})

test('an empty board says so instead of printing an empty table', async () => {
  const ctx = makeCtx({ settings: makeSettings({ maxAgents: 2, maxRounds: 50 }) })
  const text = await boardText(ctx, makeRuntime())
  assert.ok(text.includes('no children yet'), 'the empty board is stated')
  assert.ok(text.includes('live 0/2'), 'the head still names the cap')
})

test('installSubagentStatusTool registers through the tools service and returns its disposer', () => {
  const registered = []
  const disposed = []
  const ctxDisposer = () => disposed.push('ctx')
  const ctx = {
    get(name) {
      if (name === 'settings') return makeSettings({ maxAgents: 2, maxRounds: 50 })
      if (name === 'tools') {
        return {
          register(definition) {
            registered.push(definition)
            return ctxDisposer
          },
        }
      }
      return undefined
    },
  }
  const disposer = installSubagentStatusTool(ctx, makeRuntime())
  assert.equal(disposer, ctxDisposer, 'the tools service disposer is forwarded')
  assert.equal(registered.length, 1, 'exactly one tool registered')
  assert.equal(registered[0].name, SUBAGENT_STATUS_TOOL_NAME)
})

test('installSubagentStatusTool is a silent no-op without a tools service', () => {
  const ctx = { get() { return undefined } }
  assert.equal(installSubagentStatusTool(ctx, makeRuntime()), undefined, 'no tools service: undefined, never a throw')
})

test('subagent_status is not a spawn tool: the maxAgents guard never intercepts it', () => {
  assert.ok(!SPAWN_TOOLS.includes(SUBAGENT_STATUS_TOOL_NAME), 'not in SPAWN_TOOLS')
  // Behavioral: even AT the cap, a marked caller reading the board passes.
  const { ctx, captured } = makeCtxSettings()
  const policy = applySubagentPolicy(ctx, {
    getLive: () => [{ childId: 'a', label: 'a' }, { childId: 'b', label: 'b' }],
    getRoundCount: () => 0,
    isSettled: () => false,
  })
  const marked = { ctx: { get(name) { return name === TUI_SURFACE_KEY ? true : undefined } } }
  assert.equal(captured.guard({ name: SUBAGENT_STATUS_TOOL_NAME, agent: marked }), undefined, 'readable at the cap')
  policy.dispose()
})

function makeCtxSettings() {
  const captured = { guard: undefined }
  const ctx = {
    get(name) {
      if (name === 'settings') return makeSettings({ maxAgents: 2, maxRounds: 50 })
      if (name === 'tools') {
        return { guard(guard) { captured.guard = guard; return () => {} } }
      }
      return undefined
    },
    agents: { get() { return undefined } },
    events: { on() { return () => {} } },
  }
  return { ctx, captured }
}
