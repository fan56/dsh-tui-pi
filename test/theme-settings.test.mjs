/**
 * Theme-settings chain tests: the settings-namespace registration forwards
 * every committed `dsh-tui` change (theme and panel height) through the watch
 * hook — the sinks that hot-apply to the running TUI (applyThemeRef /
 * applyPanelHeightRef in src/index.ts). The settings service is faked with a
 * real cordis Context (stub style, cf. reload.test.mjs); the provider surface
 * used by theme-settings.ts is describe/register/mutate + the registered
 * scope's watch.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_SUBAGENT_LIMITS,
  THEME_SETTINGS_NAMESPACE,
  readFooterHintsPreference,
  readPanelHeightPreference,
  readSubagentLimits,
  readThemePreference,
  registerThemeSettings,
  writeSubagentLimit,
  writeThemePreference,
} from '../lib/theme-settings.js'
import { DEFAULT_FOOTER_HINTS } from '../lib/footer.js'

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

test('committed panelHeight changes flow register → watch → sink with narrowing', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  const sink = []
  registerThemeSettings(ctx, (pref, height) => { sink.push({ pref, height }) })
  await settle()

  // Startup read: the base entry resolves to the default height.
  assert.equal(await readPanelHeightPreference(ctx), '5')

  // A committed height change (a settings write → mutate → watch) must reach
  // the sink alongside the (unchanged, narrowed) theme value — the
  // applyPanelHeightRef chain. There is no dedicated height writer anymore:
  // the /settings browser and external edits mutate the path directly.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['panelHeight'], value: '10' }])
  await settle()
  assert.deepEqual(sink, [{ pref: 'auto', height: '10' }], 'watch forwarded the committed height')

  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['panelHeight'], value: 'all' }])
  await settle()
  assert.deepEqual(sink, [{ pref: 'auto', height: '10' }, { pref: 'auto', height: 'all' }],
    'second commit forwarded too')

  // The live value is readable back from the settings service.
  assert.equal(await readPanelHeightPreference(ctx), 'all', 'live value read back')
})

test('a single commit of both fields forwards both narrowed values in one callback', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  const sink = []
  registerThemeSettings(ctx, (pref, height) => { sink.push({ pref, height }) })
  await settle()

  // A namespace-level reset / external edit commits BOTH fields in one
  // mutate: the watch must fire exactly once with both narrowed values —
  // the index.ts sink then applies the height first and the theme second
  // (one replay rebuild at the new height), never a double replay.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [
    { op: 'set', path: ['theme'], value: 'dark' },
    { op: 'set', path: ['panelHeight'], value: '10' },
  ])
  await settle()
  assert.deepEqual(sink, [{ pref: 'dark', height: '10' }], 'one callback carries both fields')

  // The resolved section carries both values for the startup readers.
  assert.equal(await readThemePreference(ctx), 'dark', 'theme read back')
  assert.equal(await readPanelHeightPreference(ctx), '10', 'height read back')
})

test('watch narrows unknown or missing panelHeight values to 5', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  const heights = []
  registerThemeSettings(ctx, (pref, height) => { heights.push(height) })
  await settle()

  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['panelHeight'], value: '12' }])
  await settle()
  assert.deepEqual(heights, ['5'], 'unknown height narrows to 5')

  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['panelHeight'], value: '7' }])
  await settle()
  assert.deepEqual(heights, ['5', '7'], 'valid height passes through')

  // Unsetting the key removes it from the section: narrows back to 5.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'unset', path: ['panelHeight'] }])
  await settle()
  assert.deepEqual(heights, ['5', '7', '5'], 'missing panelHeight key narrows to 5')
})

test('subagent limits resolve to defaults and round-trip through a committed write', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  registerThemeSettings(ctx)
  await settle()

  // Base entry seeds the documented defaults.
  const defaults = { maxAgents: DEFAULT_SUBAGENT_LIMITS.maxAgents, maxRounds: DEFAULT_SUBAGENT_LIMITS.maxRounds }
  assert.deepEqual(readSubagentLimits(ctx), defaults, 'base entry resolves to the defaults')

  // A committed write mutates the section; the live reader reflects it.
  assert.equal(await writeSubagentLimit(ctx, 'maxAgents', 2), undefined)
  assert.equal(await writeSubagentLimit(ctx, 'maxRounds', 10), undefined)
  assert.deepEqual(readSubagentLimits(ctx), { maxAgents: 2, maxRounds: 10 }, 'committed limits read back')
})

test('subagent limits fall back to defaults when the service or a field is missing', async () => {
  const defaults = { maxAgents: DEFAULT_SUBAGENT_LIMITS.maxAgents, maxRounds: DEFAULT_SUBAGENT_LIMITS.maxRounds }

  // No settings service: read degrades, write reports the failure (no throw).
  const bare = new Context()
  assert.deepEqual(readSubagentLimits(bare), defaults, 'settings-less read degrades to defaults')
  const writeError = await writeSubagentLimit(bare, 'maxAgents', 1)
  assert.equal(writeError, 'Settings service is not available.', 'settings-less write surfaces the failure')

  // Malformed fields (non-integer, negative, absent) narrow to the defaults.
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  registerThemeSettings(ctx)
  await settle()
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [
    { op: 'set', path: ['maxAgents'], value: 2.5 },
    { op: 'set', path: ['maxRounds'], value: -1 },
  ])
  assert.deepEqual(readSubagentLimits(ctx), defaults, 'non-natural fields narrow to the defaults')
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'unset', path: ['maxAgents'] }])
  assert.deepEqual(readSubagentLimits(ctx), defaults, 'missing field falls back per-key')
})

test('committed footerHints changes flow register → watch → sink with per-key narrowing', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  const sink = []
  registerThemeSettings(ctx, (_pref, _height, hints) => { sink.push(hints) })
  await settle()

  // Base entry seeds every hint on.
  assert.deepEqual(await readFooterHintsPreference(ctx), { ...DEFAULT_FOOTER_HINTS }, 'base entry = all on')

  // A committed footerHints change (a /settings toggle → mutate → watch)
  // reaches the sink — the applyFooterHintsRef chain — with the narrowed map.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [
    { op: 'set', path: ['footerHints'], value: { ...DEFAULT_FOOTER_HINTS, quit: false, history: false } },
  ])
  await settle()
  assert.deepEqual(sink, [{ ...DEFAULT_FOOTER_HINTS, quit: false, history: false }], 'watch forwarded the hints')

  // Partial / malformed sections narrow per-key back to the defaults.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['footerHints'], value: { send: false } }])
  await settle()
  assert.deepEqual(sink[1], { ...DEFAULT_FOOTER_HINTS, send: false }, 'missing keys default on, send off')

  // Unset → the whole section is missing → all defaults.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'unset', path: ['footerHints'] }])
  await settle()
  assert.deepEqual(sink[2], { ...DEFAULT_FOOTER_HINTS }, 'missing footerHints key narrows to all-on')

  // The live value is readable back through the startup reader.
  assert.deepEqual(await readFooterHintsPreference(ctx), { ...DEFAULT_FOOTER_HINTS }, 'live value read back')
})
