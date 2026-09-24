/**
 * Footer cold-start seed tests (src/session.ts): the bridge constructor must
 * NOT read the composed default (`agentDefaultModel`) eagerly, and the late
 * re-seeds must converge on the imported value under every host ordering.
 * On a host first boot the legacy settings.yaml import lands asynchronously;
 * an eager read (or an early document-updated seed) freezes the BUILT-IN
 * default into `selectionRef.current`, which seedSelectionFromDefault then
 * treats as a live user choice. The contract under test:
 * - Construction seeds ONLY the cwd `.dsh-profile` pin; without one the
 *   selection stays undefined (the footer renders its empty-model branch).
 * - An early document-updated (pre-import, still the built-in value) may
 *   seed — but the import's own event FORCE re-seeds over that stale seed
 *   while no session exists and the user has not chosen.
 * - A live user choice (`/model`) is never clobbered by any re-seed.
 * - A cwd pin outranks every re-seed (it is re-applied, not replaced).
 * - A live session pins its creation-time selection (no re-seed).
 * - The one-shot late timer converges the footer when no event arrives.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshSessionBridge } from '../lib/session.js'

/** The host built-in default the pre-import reads would return. */
const BUILTIN = { provider: 'builtin', model: 'builtin-model' }

/**
 * Harness: captured event handlers + an `agentDefaultModel` service whose
 * `currentSelection()` the test can flip (the import "landing" flips it).
 */
function makeHarness(initialDefault) {
  const handlers = new Map()
  let defaultSelection = initialDefault
  const ctx = {
    on(evt, fn) { handlers.set(evt, fn); return () => handlers.delete(evt) },
    get(key) {
      return key === 'agentDefaultModel'
        ? { currentSelection: () => defaultSelection }
        : undefined
    },
    agents: {
      async create() { return { agent: { session: { id: 'root-session' } }, async dispose() {} } },
    },
  }
  return {
    ctx, handlers,
    /** Simulate the first-boot import landing: the composed default changes. */
    landImport(next) { defaultSelection = next },
    emitUpdated() { handlers.get('settings/document-updated')('agent-default-model', 2) },
  }
}

function makeBridge(ctx, options = {}) {
  return new DshSessionBridge(ctx, { onLive: () => {}, onStatus: () => {}, onEvent: () => {} }, options)
}

test('constructor: no pin leaves the selection undefined (footer waits)', () => {
  const h = makeHarness(BUILTIN)
  const bridge = makeBridge(h.ctx, { lateSeedMs: 3600_000 })
  assert.equal(bridge.getSelection(), undefined, 'the composed default is NOT read eagerly')
})

test('an early pre-import seed is force re-seeded once the import lands', async () => {
  const h = makeHarness(BUILTIN)
  const bridge = makeBridge(h.ctx, { lateSeedMs: 3600_000 })
  // The host's first describe pass fires BEFORE the settings import has
  // landed — the seed captures the built-in default.
  h.emitUpdated()
  assert.deepEqual(bridge.getSelection(), BUILTIN)
  // The import lands; its own document-updated must REPLACE the stale seed.
  h.landImport({ provider: 'imported', model: 'imported-model', reasoningEffort: 'high' })
  h.emitUpdated()
  assert.deepEqual(bridge.getSelection(), { provider: 'imported', model: 'imported-model', reasoningEffort: 'high' })
  // Idempotent: repeated events re-derive the same value, nothing drifts.
  h.emitUpdated()
  assert.deepEqual(bridge.getSelection(), { provider: 'imported', model: 'imported-model', reasoningEffort: 'high' })
})

test('a live user choice survives document-updated (the refresh never clobbers)', () => {
  const h = makeHarness(undefined)
  const bridge = makeBridge(h.ctx, { lateSeedMs: 3600_000 })
  bridge.setSelection({ provider: 'user', model: 'user-model' })
  h.landImport({ provider: 'imported', model: 'imported-model' })
  h.emitUpdated()
  assert.deepEqual(bridge.getSelection(), { provider: 'user', model: 'user-model' })
})

test('a live session pins its creation-time selection (no re-seed under a handle)', async () => {
  const h = makeHarness(undefined)
  const bridge = makeBridge(h.ctx, { lateSeedMs: 3600_000 })
  await bridge.ensureAgent()
  // Created while the default had not landed: the session owns undefined.
  assert.equal(bridge.getSelection(), undefined)
  h.landImport({ provider: 'imported', model: 'imported-model' })
  h.emitUpdated()
  assert.equal(bridge.getSelection(), undefined, 'a session is bound to the selection it was created under')
})

test('late timer leg: converges the footer when no event ever arrives', async () => {
  const h = makeHarness(undefined)
  const bridge = makeBridge(h.ctx, { lateSeedMs: 15 })
  assert.equal(bridge.getSelection(), undefined)
  h.landImport({ provider: 'imported', model: 'imported-model' })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(bridge.getSelection(), { provider: 'imported', model: 'imported-model' })
})

test('a cwd pin wins construction and is re-applied, not clobbered, on refresh', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-seed-home-'))
  const work = mkdtempSync(join(tmpdir(), 'dsh-seed-work-'))
  const prevHome = process.env.DSH_HOME
  const prevCwd = process.cwd()
  try {
    writeFileSync(join(home, 'model-profiles.json'), JSON.stringify({
      version: 1,
      profiles: [{ name: 'pinned-pro', defaultModel: { provider: 'pin-provider', model: 'pin-model' }, agents: {} }],
    }))
    writeFileSync(join(work, '.dsh-profile'), 'pinned-pro\n')
    process.env.DSH_HOME = home
    process.chdir(work)
    const h = makeHarness({ provider: 'composed', model: 'composed-model' })
    const bridge = makeBridge(h.ctx, { lateSeedMs: 3600_000 })
    // The pin is file-backed, so it is available from the very first frame.
    assert.deepEqual(bridge.getSelection(), { provider: 'pin-provider', model: 'pin-model' })
    h.emitUpdated()
    // seedSelectionFromDefault re-applies the pin; the composed default never wins.
    assert.deepEqual(bridge.getSelection(), { provider: 'pin-provider', model: 'pin-model' })
  } finally {
    process.chdir(prevCwd)
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})
