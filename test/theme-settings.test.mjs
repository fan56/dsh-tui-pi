/**
 * Theme-settings chain tests: the settings-namespace registration forwards
 * every committed `dsh-tui` theme change through the watch hook — the sink
 * that hot-applies to the running TUI (applyThemeRef in src/index.ts). The
 * settings service is faked with a real cordis Context (stub style, cf.
 * reload.test.mjs); the provider surface used by theme-settings.ts is
 * describe/register/mutate + the registered scope's watch.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import {
  THEME_SETTINGS_NAMESPACE,
  registerThemeSettings,
  readThemePreference,
  writeThemePreference,
} from '../lib/theme-settings.js'

/**
 * Minimal fake of the settings-provider surface theme-settings.ts touches:
 * describe()/register()/mutate(), plus watcher delivery on commit so the
 * live-apply chain (write → watch → sink) can be exercised.
 */
function makeSettings() {
  const descriptors = []
  const watchers = new Map()
  let revision = 0
  return {
    describe() {
      return descriptors
    },
    register(ns, schema, options) {
      descriptors.push({
        ns,
        schema,
        revision,
        value: options?.base ?? {},
        applies: options?.applies,
      })
      const list = []
      watchers.set(ns, list)
      return { watch: cb => { list.push(cb); return () => {} } }
    },
    async mutate(ns, ops, expectedRevision) {
      const descriptor = descriptors.find(d => d.ns === ns)
      if (descriptor === undefined) throw new Error('namespace not registered')
      const value = { ...descriptor.value }
      for (const op of ops) {
        const [key] = op.path
        if (key === undefined) continue
        if (op.op === 'set') value[key] = op.value
        if (op.op === 'unset') delete value[key]
      }
      descriptor.value = value
      revision += 1
      descriptor.revision = revision
      // Commit: fire the namespace watchers like the real provider does.
      for (const cb of watchers.get(ns) ?? []) cb(value, {})
      return undefined
    },
  }
}

/** One tick: the registration rides the inject fiber. */
const settle = () => new Promise(resolve => setImmediate(resolve))

test('committed theme changes flow register → watch → sink with narrowing', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  const sink = []
  registerThemeSettings(ctx, pref => { sink.push(pref) })
  await settle()

  // The namespace registers with the live-apply marker.
  const descriptor = settings.describe().find(d => d.ns === THEME_SETTINGS_NAMESPACE)
  assert.ok(descriptor !== undefined, 'dsh-tui namespace registered')
  assert.equal(descriptor.applies, 'live', 'commits apply live')

  // Startup read: the base entry resolves to auto.
  assert.equal(await readThemePreference(ctx), 'auto')

  // A committed theme change (writeThemePreference → mutate → watch) must
  // reach the sink — the applyThemeRef chain — with the narrowed value.
  assert.equal(await writeThemePreference(ctx, 'dark'), undefined)
  await settle()
  assert.deepEqual(sink, ['dark'], 'watch forwarded the committed preference')

  assert.equal(await writeThemePreference(ctx, 'light'), undefined)
  await settle()
  assert.deepEqual(sink, ['dark', 'light'], 'second commit forwarded too')

  // The live value is readable back from the settings service.
  assert.equal(await readThemePreference(ctx), 'light', 'live value read back')
})

test('watch narrows unknown or missing theme values to auto', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  const sink = []
  registerThemeSettings(ctx, pref => { sink.push(pref) })
  await settle()

  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['theme'], value: 'neon' }])
  await settle()
  assert.deepEqual(sink, ['auto'], 'unknown theme value narrows to auto')

  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['theme'], value: 'dark' }])
  await settle()
  assert.deepEqual(sink, ['auto', 'dark'], 'dark value passes through')

  // Unsetting the theme key removes it from the section: the watch then sees
  // a section without a theme and narrows to auto.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'unset', path: ['theme'] }])
  await settle()
  assert.deepEqual(sink, ['auto', 'dark', 'auto'], 'missing theme key narrows to auto')
})
