/**
 * Icon-set self-adaptation tests — src/icons.ts (icon-set
 * self-adaptation). Covers the resolveIconSet pure function, the plain-mode
 * glyph fallbacks for the only three risky glyphs (U+E0B0 → ▸, ⏹ → ■, ⭘ → ●),
 * the module default ('nerdfont' — the legacy output is preserved until a
 * resolution lands on 'plain'), and the `dsh-tui.iconSet` settings default
 * ('auto', narrowed from the settings namespace).
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyIconSet,
  arrowRight,
  getResolvedIconSet,
  resolveIconSet,
  stopIcon,
  sunglassesIcon,
} from '../lib/icons.js'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile } from '@deepseek-ai/cosmokit'
import {
  bindTuiConfig,
  readIconSetPreference,
  resolveTuiSettings,
  subscribeThemeSettings,
  THEME_SETTINGS_NAMESPACE,
} from '../lib/theme-settings.js'

test('resolveIconSet resolves auto from the font snapshot; pins pass through', () => {
  assert.equal(resolveIconSet('auto', true), 'nerdfont', 'auto + font available → nerdfont')
  assert.equal(resolveIconSet('auto', false), 'plain', 'auto + no font → plain')
  assert.equal(resolveIconSet('nerdfont', false), 'nerdfont', 'explicit nerdfont ignores detection')
  assert.equal(resolveIconSet('plain', true), 'plain', 'explicit plain ignores detection')
})

test('readIconSetPreference degrades to auto without a settings service', async () => {
  const ctx = new Context() // no 'settings' provided
  assert.equal(await readIconSetPreference(ctx), 'auto')
})

test('module default is nerdfont — legacy output preserved before any apply', () => {
  assert.equal(getResolvedIconSet(), 'nerdfont', 'resolved set starts as nerdfont')
  assert.equal(arrowRight(), '\uE0B0', 'default separator is the powerline arrow')
  assert.equal(stopIcon(), '\u23F9', 'default stop is ⏹')
  assert.equal(sunglassesIcon(), '\u2B58', 'default subagent glyph is ⭘')
})

test('plain mode swaps the risky glyphs; nerdfont keeps them', () => {
  applyIconSet('plain')
  assert.equal(getResolvedIconSet(), 'plain')
  assert.equal(arrowRight(), '\u25B8', 'plain separator is ▸')
  assert.equal(stopIcon(), '\u25A0', 'plain stop is ■')
  assert.equal(sunglassesIcon(), '\u25CF', 'plain subagent glyph is ●')

  applyIconSet('nerdfont')
  assert.equal(getResolvedIconSet(), 'nerdfont')
  assert.equal(arrowRight(), '\uE0B0', 'nerdfont separator is the PUA arrow')
  assert.equal(stopIcon(), '\u23F9', 'nerdfont stop is ⏹')
  assert.equal(sunglassesIcon(), '\u2B58', 'nerdfont subagent glyph is ⭘')
})

test("applyIconSet('auto') keeps the current resolved set (no render flicker)", () => {
  applyIconSet('plain')
  assert.equal(getResolvedIconSet(), 'plain')
  // A hot-applied settings 'auto' must not flip the live glyphs — it resolves
  // against the startup snapshot that already produced the current set.
  applyIconSet('auto')
  assert.equal(getResolvedIconSet(), 'plain', "auto keeps the current resolved set")
  // An explicit pin still switches.
  applyIconSet('nerdfont')
  assert.equal(getResolvedIconSet(), 'nerdfont')
})

test('accessors honor an explicit set argument over the resolved set', () => {
  applyIconSet('nerdfont')
  assert.equal(arrowRight('plain'), '\u25B8', 'explicit plain arg wins')
  assert.equal(arrowRight('auto'), '\uE0B0', 'auto arg resolves to the current set')
  assert.equal(stopIcon('plain'), '\u25A0')
  assert.equal(sunglassesIcon('plain'), '\u25CF')
})

// ------------------------------------------------------- settings chain (iconSet) --

/**
 * Fake of the settings-service surface (mirroring test/theme-settings.test.mjs,
 * which owns the chain cases; this harness only covers the iconSet field):
 * a mutate applies the path ops, swaps the volatile references (the loader's
 * volatile-only commit) and emits `settings/document-updated` — the real
 * commit sequence between the write and the sink.
 */
function makeHarness(ctx) {
  const section = {}
  let revision = 0
  return {
    describe() {
      return [{ ns: THEME_SETTINGS_NAMESPACE, revision, value: section, user: undefined }]
    },
    async mutate(ns, ops) {
      for (const op of ops) {
        const [key] = op.path
        if (key === undefined) continue
        if (op.op === 'set') section[key] = op.value
        if (op.op === 'unset') delete section[key]
      }
      revision += 1
      bindTuiConfig(configFrom(section))
      ctx.emit('settings/document-updated', ns, revision)
      return undefined
    },
  }
}

/** Volatile references over the committed section (defaults fill the rest). */
function configFrom(section) {
  const base = resolveTuiSettings({})
  const out = {}
  for (const [key, ref] of Object.entries(base)) {
    out[key] = key in section ? createVolatile(section[key]) : ref
  }
  return out
}

test('dsh-tui.iconSet defaults to auto and narrows unknown values', async () => {
  const ctx = new Context()
  bindTuiConfig(resolveTuiSettings({}))
  const settings = makeHarness(ctx)
  ctx.provide('settings', settings)
  const sink = []
  subscribeThemeSettings(ctx, (pref, height, hints, iconSet) => { sink.push(iconSet) })

  // Schema default is 'auto'.
  assert.equal(await readIconSetPreference(ctx), 'auto', 'unset iconSet resolves to auto')

  // Unknown values narrow to 'auto' (both in the read and the hot-apply sink).
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['iconSet'], value: 'neon' }])
  assert.deepEqual(sink, ['auto'], 'unknown iconSet narrows to auto in the sink')
  assert.equal(await readIconSetPreference(ctx), 'auto')

  // Valid pins pass through and reach the sink.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['iconSet'], value: 'plain' }])
  assert.deepEqual(sink, ['auto', 'plain'])
  assert.equal(await readIconSetPreference(ctx), 'plain')

  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['iconSet'], value: 'nerdfont' }])
  assert.deepEqual(sink, ['auto', 'plain', 'nerdfont'])
  assert.equal(await readIconSetPreference(ctx), 'nerdfont')

  // Unsetting the field falls back to 'auto'.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'unset', path: ['iconSet'] }])
  assert.equal(await readIconSetPreference(ctx), 'auto')
})
