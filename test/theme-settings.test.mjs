/**
 * Theme-settings chain tests: the settings-namespace registration forwards
 * every committed `dsh-tui` change (theme and panel height) through the watch
 * hook — the sinks that hot-apply to the running TUI (applyThemeRef /
 * applyPanelHeightRef in src/index.ts). The settings service is faked with a
 * real cordis Context (stub style, cf. reload.test.mjs); the provider surface
 * used by theme-settings.ts is describe/register/mutate + the registered
 * scope's watch, with `register` validating the stored section through the
 * REAL schema (fail-loud) exactly like @deepseek-ai/dsh-settings does.
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
  readSessionManagementExplicit,
  readSubagentLimits,
  readThemePreference,
  registerThemeSettings,
  writeSubagentLimit,
  writeThemePreference,
} from '../lib/theme-settings.js'
import { DEFAULT_FOOTER_HINTS } from '../lib/footer.js'
import { RETENTION_MAX_AGE_DAYS, resolveRetentionConfig } from '../lib/retention.js'
import { resetNoticeBridge, setNoticeSink } from '../lib/notice-bridge.js'

/**
 * Minimal fake of the settings-provider surface theme-settings.ts touches:
 * describe()/register()/mutate(), plus watcher delivery on commit so the
 * live-apply chain (write → watch → sink) can be exercised. Each
 * descriptor carries the namespace's USER layer through a getter — the
 * real provider re-reads settings.yaml per describe(), so a test can flip
 * `service.user` after registration and the next read sees it (the seam
 * `readSessionManagementExplicit` consumes).
 */
function makeSettings() {
  const descriptors = []
  const watchers = new Map()
  let revision = 0
  const service = {
    /** User-layer section for the registered namespaces (undefined = none). */
    user: undefined,
    describe() {
      return descriptors
    },
    register(ns, schema, options) {
      // Mirror the REAL provider's fail-loud registration
      // (@deepseek-ai/dsh-settings): register resolves the stored section
      // once through `schema(mergeLayers(base, user))`, and a stored
      // section that fails the schema REJECTS the registration itself —
      // no descriptor lands, exactly like a non-object section. Deliberate
      // divergence: `mutate` below stays permissive — write-time
      // validation is a different seam, and the watch-narrowing tests
      // push schema-invalid values through mutate on purpose to lock the
      // narrowing (the real provider would refuse those writes instead).
      if (service.user !== undefined && !isPlainObject(service.user)) {
        throw new TypeError(`settings section "${ns}" must be an object of keys`)
      }
      schema(mergeLayers(options?.base, service.user))
      descriptors.push({
        ns,
        schema,
        revision,
        value: options?.base ?? {},
        applies: options?.applies,
        get user() { return service.user },
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
  return service
}

/** `value === null || typeof value !== 'object' || Array.isArray(value)`. */
const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The real provider's layering, verbatim semantics: plain objects merge
 * recursively, every other value replaces the lower layer wholesale.
 */
function mergeLayers(under, over) {
  if (over === undefined) return under
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = key in merged ? mergeLayers(merged[key], value) : value
  }
  return merged
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

  // Startup read: the base entry resolves to the default height ('1').
  assert.equal(await readPanelHeightPreference(ctx), '1')

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

test('watch narrows unknown or missing panelHeight values to 1', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  const heights = []
  registerThemeSettings(ctx, (pref, height) => { heights.push(height) })
  await settle()

  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['panelHeight'], value: '12' }])
  await settle()
  assert.deepEqual(heights, ['1'], 'unknown height narrows to 1')

  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['panelHeight'], value: '7' }])
  await settle()
  assert.deepEqual(heights, ['1', '7'], 'valid height passes through')

  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['panelHeight'], value: '5' }])
  await settle()
  assert.deepEqual(heights, ['1', '7', '5'], "'5' passes through the watch too")

  // Unsetting the key removes it from the section: narrows back to 1.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'unset', path: ['panelHeight'] }])
  await settle()
  assert.deepEqual(heights, ['1', '7', '5', '1'], 'missing panelHeight key narrows to 1')
})

test('persisted panelHeight survives the startup reader for every schema literal', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  registerThemeSettings(ctx)
  await settle()

  // Every schema literal must round-trip through readPanelHeightPreference.
  // A persisted '5' used to come back as '1' after a restart: the startup
  // reader only accepted '7'/'10'/'all' while the schema and the watch
  // narrowing already accepted all five (regression for commit fa7d206,
  // which changed the default to '1' but missed this narrowing).
  for (const height of ['1', '5', '7', '10', 'all']) {
    await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['panelHeight'], value: height }])
    assert.equal(await readPanelHeightPreference(ctx), height, `persisted '${height}' survives the startup read`)
  }
})

test('subagent limits resolve to defaults and round-trip through a committed write', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  registerThemeSettings(ctx)
  await settle()

  // Base entry seeds the documented defaults (disableSubagent on).
  const defaults = {
    maxAgents: DEFAULT_SUBAGENT_LIMITS.maxAgents,
    maxRounds: DEFAULT_SUBAGENT_LIMITS.maxRounds,
    disableSubagent: DEFAULT_SUBAGENT_LIMITS.disableSubagent,
  }
  assert.deepEqual(readSubagentLimits(ctx), defaults, 'base entry resolves to the defaults')

  // A committed write mutates the section; the live reader reflects it.
  assert.equal(await writeSubagentLimit(ctx, 'maxAgents', 2), undefined)
  assert.equal(await writeSubagentLimit(ctx, 'maxRounds', 10), undefined)
  assert.equal(await writeSubagentLimit(ctx, 'disableSubagent', false), undefined)
  assert.deepEqual(readSubagentLimits(ctx), { maxAgents: 2, maxRounds: 10, disableSubagent: false }, 'committed limits read back')
})

test('maxRounds defaults to 75 and is configurable through the settings chain', async () => {
  // Lock the documented default (the user picked 75 — headroom for heavy
  // delegated tasks under the assistant-message round count, still a runaway
  // guard). Any future bump must update this assertion deliberately.
  assert.equal(DEFAULT_SUBAGENT_LIMITS.maxRounds, 75, 'documented maxRounds default is 75')

  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  registerThemeSettings(ctx)
  await settle()

  // The schema default seeds the resolved section (no user value configured).
  assert.equal(readSubagentLimits(ctx).maxRounds, 75, 'settings-less resolved default is 75')

  // A configured value round-trips through the live reader — both the
  // `/agents → l` limits panel and the `/settings` browser write through
  // `writeSubagentLimit` → settings.mutate, and the policy re-reads it at
  // every decision point.
  assert.equal(await writeSubagentLimit(ctx, 'maxRounds', 120), undefined)
  assert.equal(readSubagentLimits(ctx).maxRounds, 120, 'configured maxRounds read back')
  assert.equal(await writeSubagentLimit(ctx, 'maxRounds', 75), undefined)
  assert.equal(readSubagentLimits(ctx).maxRounds, 75, 'back to the default')

  // A malformed (non-natural) value narrows back to the default per-key.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['maxRounds'], value: -1 }])
  assert.equal(readSubagentLimits(ctx).maxRounds, 75, 'negative maxRounds falls back to the default')
})

test('subagent limits fall back to defaults when the service or a field is missing', async () => {
  const defaults = {
    maxAgents: DEFAULT_SUBAGENT_LIMITS.maxAgents,
    maxRounds: DEFAULT_SUBAGENT_LIMITS.maxRounds,
    disableSubagent: DEFAULT_SUBAGENT_LIMITS.disableSubagent,
  }

  // No settings service: read degrades, write reports the failure (no throw).
  const bare = new Context()
  assert.deepEqual(readSubagentLimits(bare), defaults, 'settings-less read degrades to defaults')
  const writeError = await writeSubagentLimit(bare, 'maxAgents', 1)
  assert.equal(writeError, 'Settings service is not available.', 'settings-less write surfaces the failure')

  // Malformed fields (non-integer, negative, absent, non-boolean) narrow to
  // the defaults per-key.
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  registerThemeSettings(ctx)
  await settle()
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [
    { op: 'set', path: ['maxAgents'], value: 2.5 },
    { op: 'set', path: ['maxRounds'], value: -1 },
    { op: 'set', path: ['disableSubagent'], value: 'yes' },
  ])
  assert.deepEqual(readSubagentLimits(ctx), defaults, 'malformed fields narrow to the defaults')
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'unset', path: ['maxAgents'] }])
  assert.deepEqual(readSubagentLimits(ctx), defaults, 'missing field falls back per-key')

  // A committed boolean toggle round-trips through the live reader.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['disableSubagent'], value: false }])
  assert.equal(readSubagentLimits(ctx).disableSubagent, false, 'committed disableSubagent read back')
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

// ------------------------------------------------- session-management user layer --
// `readSessionManagementExplicit` is the precedence seam for the retention
// and resume knobs: ONLY a field present in the settings document's USER
// layer is an explicit override. The resolved value bakes the schema
// defaults in (a missing retention.maxCount resolves to 100), so reading it
// would make the defaults outrank the DSH_TUI_RETENTION_* / DSH_TUI_RESUME_*
// env vars. Fields stay raw/unknown — narrowing is the resolvers' job.
// Garbage reaches that narrowing through exactly ONE path: an external
// settings.yaml edit AFTER registration (the provider keeps the last good
// resolved value and warns, but describe() still reports the raw user
// section). Garbage present AT registration fails the whole namespace
// registration instead — locked by the last test of this section.

test('readSessionManagementExplicit returns the raw user-layer retention/resume fields', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  registerThemeSettings(ctx)
  await settle()

  // UNIT-LEVEL narrowing only: the user layer is flipped AFTER
  // registration — the one path where the real provider still exposes it
  // raw (an external edit that fails the schema keeps the last good
  // resolved value but describe() reports the raw section anyway). The
  // values pass through UNNARROWED; one notice per field happens later,
  // inside resolveRetentionConfig / resolveResumeConfig. The same garbage
  // sitting in settings.yaml at startup would instead fail the
  // registration outright (see the registration-failure test below).
  settings.user = {
    retention: { maxCount: 42, maxAgeDays: 'later' },
    resume: { minBytes: 4096, maxAgeDays: null },
  }
  assert.deepEqual(await readSessionManagementExplicit(ctx), {
    retention: { maxCount: 42, maxAgeDays: 'later' },
    resume: { minBytes: 4096, maxAgeDays: null },
  }, 'raw fields through, nothing narrowed')

  // A later external edit of settings.yaml is visible on the next read
  // (the descriptor's user layer is re-read per describe, not snapshotted).
  settings.user = { resume: { minBytes: 8192 } }
  assert.deepEqual(await readSessionManagementExplicit(ctx), {
    retention: undefined,
    resume: { minBytes: 8192 },
  }, 'fresh user layer read back')
})

test('readSessionManagementExplicit ignores the resolved section — schema defaults are not overrides', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  registerThemeSettings(ctx)
  await settle()

  // Sanity: the RESOLVED descriptor value carries the baked-in defaults
  // (base entry: retention 100/7d/24h, resume 7d/20KB).
  const descriptor = settings.describe().find(d => d.ns === THEME_SETTINGS_NAMESPACE)
  assert.ok(descriptor.value.retention !== undefined, 'resolved section has the retention defaults')
  assert.ok(descriptor.value.resume !== undefined, 'resolved section has the resume defaults')
  // But no user layer exists: nothing is explicit — the stable empty
  // shape, and env/defaults stay in charge.
  const absent = { retention: undefined, resume: undefined }
  settings.user = undefined
  assert.deepEqual(await readSessionManagementExplicit(ctx), absent, 'no user layer = nothing explicit')
  // A null user layer (an empty document) is the same "nothing explicit".
  settings.user = null
  assert.deepEqual(await readSessionManagementExplicit(ctx), absent, 'null user layer = nothing explicit')
})

test('readSessionManagementExplicit: non-object sections read as absent, never throw', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  registerThemeSettings(ctx)
  await settle()

  // User layer without any session-management section: both keys absent.
  settings.user = { theme: 'dark', maxAgents: 2 }
  assert.deepEqual(
    await readSessionManagementExplicit(ctx),
    { retention: undefined, resume: undefined },
    'no session sections → both undefined',
  )
  // Hand-edited scalars where sections belong: not objects, not overrides.
  settings.user = { retention: 'nope', resume: 7 }
  assert.deepEqual(
    await readSessionManagementExplicit(ctx),
    { retention: undefined, resume: undefined },
    'scalar sections narrow to undefined',
  )
  // Array-shaped sections are objects typeof-wise but pass through raw —
  // reachable ONLY via the post-registration external-edit path (the
  // registration itself would reject them: z.object refuses a non-object
  // member). Harmless downstream: the resolvers' per-field narrowing
  // finds no fields on an array, so nothing overrides.
  settings.user = { resume: ['not', 'a', 'section'] }
  const explicit = await readSessionManagementExplicit(ctx)
  assert.ok(Array.isArray(explicit.resume), 'object-typed section passes through raw')
})

test('readSessionManagementExplicit degrades to the empty shape without a service or the namespace', async () => {
  // No settings service at all (settings-less deployment): the stable
  // empty shape, never a throw — the retention janitor and the /resume
  // picker proceed on env/defaults.
  const bare = new Context()
  assert.deepEqual(
    await readSessionManagementExplicit(bare),
    { retention: undefined, resume: undefined },
  )

  // A settings service that never registered the dsh-tui namespace
  // (fresh provider): no descriptor → the same empty shape.
  const stranger = new Context()
  const strangerSettings = makeSettings()
  stranger.provide('settings', strangerSettings)
  assert.deepEqual(
    await readSessionManagementExplicit(stranger),
    { retention: undefined, resume: undefined },
  )
})

test('a schema-invalid stored section fails the registration — retention/resume fall to env', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  // Garbage already in settings.yaml when the namespace registers: the
  // provider (real and fake alike) resolves schema(base ∪ user) once at
  // register time, the string maxAgeDays fails z.number(), and the whole
  // dsh-tui registration fails loud — theme, panelHeight and the session
  // knobs go down together. This blast radius is the documented reason
  // the schema keeps plain z.number() fields and pushes range checks to
  // the resolvers (theme-settings.ts schema comment).
  settings.user = { retention: { maxAgeDays: 'later' } }
  ctx.provide('settings', settings)
  const notices = []
  resetNoticeBridge()
  setNoticeSink(message => { notices.push(message) })
  try {
    registerThemeSettings(ctx)
    await settle()
    // registerThemeSettings degrades instead of throwing: one operator
    // trace through the notice bridge, and NO descriptor ever lands.
    assert.equal(
      settings.describe().find(d => d.ns === THEME_SETTINGS_NAMESPACE),
      undefined,
      'the failed registration left no descriptor',
    )
    assert.equal(notices.length, 1, 'exactly one registration-failure notice')
    assert.match(notices[0], /^settings namespace registration failed/)
    // The explicit reader therefore reports nothing configured, and the
    // janitor's knobs resolve from the environment alone — the rejected
    // section (and its schema defaults) never reach the resolvers.
    const explicit = await readSessionManagementExplicit(ctx)
    assert.deepEqual(explicit, { retention: undefined, resume: undefined })
    assert.deepEqual(
      resolveRetentionConfig({ DSH_TUI_RETENTION_MAX_COUNT: '7' }, explicit),
      {
        maxCount: 7,
        maxAgeDays: RETENTION_MAX_AGE_DAYS,
        minIdleMs: 24 * 60 * 60 * 1000,
        enabled: true,
      },
      'retention knobs come from env, not from the rejected section',
    )
  } finally {
    resetNoticeBridge()
  }
})
