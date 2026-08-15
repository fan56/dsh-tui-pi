/**
 * Integration tests for /reload (src/reload.ts): the module-cache eviction
 * and plugin-runtime swap run against a REAL cordis registry with a stubbed
 * loader (the real loader internals only exist inside the dsh process).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { reloadPlugin } from '../lib/reload.js'

const ENTRY_URL = 'file:///fake/dsh-tui-pi/lib/index.js'

/** A loader stub: entry module cached in a fake loadCache, import() yields the fresh module. */
function makeLoader(freshModule, { importThrows = false } = {}) {
  const internal = {
    version: 'v2',
    loadCache: new Map(),
  }
  internal.loadCache.set(ENTRY_URL, {
    url: ENTRY_URL,
    linked: Promise.resolve([]),
  })
  return {
    internal,
    import: async () => {
      if (importThrows) throw new Error('import exploded')
      return freshModule
    },
    unwrapExports: exports => exports,
  }
}

test('reload is unavailable without a loader service', async () => {
  const root = new Context()
  const result = await reloadPlugin(root, ENTRY_URL)
  assert.equal(result, 'Reload unavailable: the loader service is not mounted.')
})

test('reload is unavailable without a module loader', async () => {
  const root = new Context()
  root.provide('loader', { internal: undefined })
  const result = await reloadPlugin(root, ENTRY_URL)
  assert.equal(result, 'Reload unavailable: the module loader is not reachable.')
})

test('reload swaps the plugin runtime: old fiber disposed, fresh code applied', async () => {
  const root = new Context()
  let appliedOld = 0
  let disposedOld = 0
  let appliedFresh = 0

  const oldModule = {
    name: 'fake',
    apply(ctx) {
      appliedOld += 1
      ctx.effect(() => () => { disposedOld += 1 })
    },
  }
  const freshModule = {
    name: 'fake',
    apply() { appliedFresh += 1 },
  }
  root.provide('loader', makeLoader(freshModule))

  const fiber = await root.plugin(oldModule)
  assert.equal(appliedOld, 1)

  const result = await reloadPlugin(fiber.ctx, ENTRY_URL)

  assert.ok(result.startsWith('Reloaded'), result)
  assert.equal(disposedOld, 1, 'old fiber effect disposer ran')
  assert.equal(appliedFresh, 1, 'fresh module was applied')
  assert.equal(appliedOld, 1, 'old apply ran exactly once')
  assert.ok(root.registry.has(freshModule), 'fresh runtime registered')
  assert.ok(!root.registry.has(oldModule), 'old runtime removed')
})

test('reload keeps the old TUI when the re-import fails and restores caches', async () => {
  const root = new Context()
  let appliedOld = 0
  let disposedOld = 0
  const oldModule = {
    name: 'fake',
    apply(ctx) {
      appliedOld += 1
      ctx.effect(() => () => { disposedOld += 1 })
    },
  }
  const loader = makeLoader({}, { importThrows: true })
  root.provide('loader', loader)

  const fiber = await root.plugin(oldModule)
  const result = await reloadPlugin(fiber.ctx, ENTRY_URL)

  assert.ok(result.startsWith('Reload failed: import exploded'), result)
  assert.equal(appliedOld, 1, 'old apply untouched')
  assert.equal(disposedOld, 0, 'old fiber still alive')
  assert.ok(root.registry.has(oldModule))
  assert.ok(loader.internal.loadCache.has(ENTRY_URL), 'module cache restored')
})

test('reload rolls back to the previous code when the fresh apply throws', async () => {
  const root = new Context()
  let appliedOld = 0
  let appliedFresh = 0
  const oldModule = {
    name: 'fake',
    apply(ctx) {
      appliedOld += 1
      ctx.effect(() => () => {})
    },
  }
  const freshModule = {
    name: 'fake',
    apply() {
      appliedFresh += 1
      throw new Error('fresh apply broken')
    },
  }
  const loader = makeLoader(freshModule)
  root.provide('loader', loader)

  const fiber = await root.plugin(oldModule)
  const result = await reloadPlugin(fiber.ctx, ENTRY_URL)

  assert.ok(result.startsWith('Reload failed: fresh apply broken'), result)
  assert.equal(appliedFresh, 1, 'fresh apply attempted')
  assert.equal(appliedOld, 2, 'old code restarted as the rollback')
  assert.ok(root.registry.has(oldModule), 'old runtime back')
  assert.ok(!root.registry.has(freshModule), 'failed fresh runtime removed')
  assert.ok(loader.internal.loadCache.has(ENTRY_URL), 'module cache restored')
})
