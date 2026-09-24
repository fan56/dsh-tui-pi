/**
 * Theme-settings chain tests — the 0.1.7 settings model. The `dsh-tui` entry
 * config is DECLARED as the plugin's static Config schema (every field
 * `.volatile()`); there is no runtime registration anymore. What the tests
 * exercise instead:
 *
 *  - the schema itself: `Config({})` resolves the documented defaults as
 *    volatile references (the declare-is-register contract), and the
 *    serialized schema keeps every field volatile (what the settings surface
 *    and the legacy settings.yaml import validate against);
 *  - the hot-apply chain: a committed write swaps the volatile references in
 *    place and fires `settings/document-updated` — the subscription forwards
 *    the narrowed bundle to the sinks (applyThemeRef / applyPanelHeightRef in
 *    src/index.ts). The fake settings service mirrors the real commit
 *    sequence (mutate → references updated → event) so the chain is driven
 *    end to end without a loader;
 *  - the USER-layer precedence seam: only a field present in the descriptor's
 *    raw `user` layer is an explicit override (settings explicit > env >
 *    default) — the seam readSessionManagementExplicit / readAskUserExplicit
 *    consume, still carried by describe() under 0.1.7;
 *  - the write path: settings.mutate with optimistic concurrency (one retry
 *    on SettingsConflictError) and the settings-less degradation.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile } from '@deepseek-ai/cosmokit'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import {
  Config,
  DEFAULT_CACHE_HIT_MODE,
  DEFAULT_SUBAGENT_LIMITS,
  THEME_SETTINGS_NAMESPACE,
  bindTuiConfig,
  currentCacheHitMode,
  narrowCacheHitMode,
  readAskUserExplicit,
  readFooterHintsPreference,
  readOfficialSubagentLimits,
  readPanelHeightPreference,
  readSessionManagementExplicit,
  readSubagentLimits,
  readThemePreference,
  resolveTuiSettings,
  subscribeThemeSettings,
  writeSubagentLimit,
  writeThemePreference,
} from '../lib/theme-settings.js'
import { DEFAULT_FOOTER_HINTS } from '../lib/footer.js'
import { RETENTION_MAX_AGE_DAYS, resolveRetentionConfig } from '../lib/retention.js'
import { resetNoticeBridge, setNoticeSink } from '../lib/notice-bridge.js'

/**
 * The schema defaults as a PLAIN object (one `.get()` per field) — the seed
 * section of the fake document and the base of every rebind.
 */
function defaultSection() {
  const resolved = resolveTuiSettings({})
  return Object.fromEntries(Object.entries(resolved).map(([key, ref]) => [key, ref.get()]))
}

/**
 * Build a TuiSettings-shaped object of volatile references from a plain
 * (possibly schema-invalid) section, mirroring what the loader's
 * volatile-only commit does: swap the values behind fresh references without
 * remounting. Bypasses schema resolution on purpose — the narrowing readers
 * are the last line of defense against garbage that reached the document
 * through a hand edit, and the tests push that garbage through the same
 * references the real loader would populate.
 */
function refsFromSection(section) {
  const base = resolveTuiSettings({})
  const out = {}
  for (const [key, ref] of Object.entries(base)) {
    out[key] = key in section ? createVolatile(section[key]) : ref
  }
  return out
}

/**
 * Fake of the settings-service surface theme-settings.ts touches, wired to a
 * cordis context: describe()/mutate() plus the REAL commit sequence — a
 * mutate applies the path ops to the fake document, swaps the volatile
 * references (the loader's volatile-only commit, no remount) and emits
 * `settings/document-updated` — exactly what the real host does between the
 * write and the sink. The descriptor carries the USER layer through a
 * getter, so a test can flip `service.user` (an external patch edit) and the
 * next explicit-layer read sees it.
 */
function makeHarness(ctx) {
  const section = defaultSection()
  const service = {
    /** User-layer section of the entry (undefined = nothing explicit). */
    user: undefined,
    /** Pending SettingsConflictError injections (optimistic-concurrency tests). */
    conflicts: 0,
    revision: 0,
    describe() {
      return descriptors
    },
    async mutate(ns, ops, expectedRevision) {
      const descriptor = descriptors.find(d => d.ns === ns)
      if (descriptor === undefined) throw new Error('entry not found')
      if (service.conflicts > 0) {
        service.conflicts -= 1
        throw new SettingsConflictError(ns, expectedRevision ?? 0, (expectedRevision ?? 0) + 1)
      }
      for (const op of ops) {
        const [key] = op.path
        if (key === undefined) continue
        if (op.op === 'set') section[key] = op.value
        if (op.op === 'unset') delete section[key]
      }
      service.revision += 1
      // The loader's volatile-only commit: references swapped, event fired.
      bindTuiConfig(refsFromSection(section))
      ctx.emit('settings/document-updated', ns, service.revision)
      return undefined
    },
  }
  const descriptors = [{
    ns: THEME_SETTINGS_NAMESPACE,
    get revision() { return service.revision },
    get user() { return service.user },
    value: section,
  }]
  return service
}

/** Wire a context with a bound default config + fake service + subscription. */
function boot(sink) {
  const ctx = new Context()
  bindTuiConfig(resolveTuiSettings({}))
  const settings = makeHarness(ctx)
  ctx.provide('settings', settings)
  subscribeThemeSettings(ctx, sink)
  return { ctx, settings }
}

test('Config resolves the documented defaults as volatile references', () => {
  // Declare-is-register: the schema itself is the settings surface. `Config({})`
  // resolves every defaulted field; volatile fields come back as live
  // references (`.get()`), the 0.1.7 spelling of "the base entry".
  const config = resolveTuiSettings({})
  assert.equal(config.theme.get(), 'auto')
  assert.equal(config.language.get(), 'en')
  assert.equal(config.panelHeight.get(), '1')
  assert.equal(config.maxAgents.get(), DEFAULT_SUBAGENT_LIMITS.maxAgents)
  assert.equal(config.maxRounds.get(), DEFAULT_SUBAGENT_LIMITS.maxRounds)
  assert.equal(config.maxRoundsGrace.get(), DEFAULT_SUBAGENT_LIMITS.maxRoundsGrace)
  assert.equal(config.disableSubagent.get(), true)
  assert.equal(config.registeredOnly.get(), false)
  assert.deepEqual(config.footerHints.get(), { ...DEFAULT_FOOTER_HINTS })
  assert.equal(config.cacheHitMode.get(), DEFAULT_CACHE_HIT_MODE)
  assert.equal(config.iconSet.get(), 'auto')
  assert.equal(config.rememberPreset.get(), true)
  assert.deepEqual(config.favoriteModels.get(), [])
  assert.deepEqual(config.hiddenModels.get(), [])
  assert.equal(config.retention.get().maxCount, 100)
  assert.equal(config.resume.get().minBytes, 1024)
  assert.equal(config.askUser.get().idleMinutes, 5)

  // Every field of the schema is volatile: the settings browser lists them
  // all, and a legacy settings.yaml `dsh-tui:` section imports wholesale (an
  // import carrying any non-volatile field would be rejected as a whole).
  const meta = Config.toJSON()
  for (const [key, node] of Object.entries(meta.dict ?? {})) {
    assert.equal(node.meta?.volatile, true, `Config.${key} must be volatile`)
  }
})

test('Config accepts and resolves explicit overrides through the schema', () => {
  // The real loader resolves the entry config through this schema before
  // apply runs; a profile patch value lands in the reference.
  const config = resolveTuiSettings({ theme: 'dark', maxRounds: 120 })
  assert.equal(config.theme.get(), 'dark')
  assert.equal(config.maxRounds.get(), 120)
  assert.equal(config.panelHeight.get(), '1', 'unset fields keep the defaults')
})

test('committed theme changes flow mutate → references → event → sink', async () => {
  const sink = []
  const { ctx, settings } = boot((pref) => { sink.push(pref) })

  // Startup read: the schema default resolves to auto.
  assert.equal(await readThemePreference(ctx), 'auto')

  // A committed theme change (writeThemePreference → mutate → references →
  // event) must reach the sink — the applyThemeRef chain — with the narrowed
  // value.
  assert.equal(await writeThemePreference(ctx, 'dark'), undefined)
  assert.deepEqual(sink, ['dark'], 'the commit forwarded the preference')

  assert.equal(await writeThemePreference(ctx, 'light'), undefined)
  assert.deepEqual(sink, ['dark', 'light'], 'second commit forwarded too')

  // The live value is readable back through the references.
  assert.equal(await readThemePreference(ctx), 'light', 'live value read back')

  // The write landed as a path mutation on the entry, not a whole-file rewrite.
  assert.deepEqual(settings.describe()[0].value.theme, 'light')
})

test('subscription filters events by namespace and echoes are harmless', async () => {
  const sink = []
  const { ctx } = boot((pref) => { sink.push(pref) })

  // An event for another entry is ignored.
  ctx.emit('settings/document-updated', 'llm-pi-ai', 1)
  assert.deepEqual(sink, [], 'foreign namespace ignored')

  // The echo of the TUI's own write (same ns) re-applies the SAME value —
  // the sinks' identity guards make it an idempotent no-op downstream; the
  // narrowing is what the test locks here.
  bindTuiConfig(refsFromSection({ theme: 'dark' }))
  ctx.emit('settings/document-updated', THEME_SETTINGS_NAMESPACE, 2)
  ctx.emit('settings/document-updated', THEME_SETTINGS_NAMESPACE, 2)
  assert.deepEqual(sink, ['dark', 'dark'], 'echo re-forwards the same narrowed value')
})

test('subscription forwards custom theme names and narrows a missing key to auto', async () => {
  const sink = []
  const { ctx, settings } = boot((pref) => { sink.push(pref) })

  // A custom theme name is a valid theme preference — it passes through
  // untouched so resolveTheme can look it up in the registry.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['theme'], value: 'neon' }])
  assert.deepEqual(sink, ['neon'], 'custom theme name passes through')

  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['theme'], value: 'dark' }])
  assert.deepEqual(sink, ['neon', 'dark'], 'light/dark pass through')

  // Unsetting the theme key removes it from the section: the re-applied
  // references then narrow to auto.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'unset', path: ['theme'] }])
  assert.deepEqual(sink, ['neon', 'dark', 'auto'], 'missing theme key narrows to auto')
})

test('committed panelHeight changes flow the same chain, narrowed', async () => {
  const sink = []
  const { ctx, settings } = boot((pref, height) => { sink.push({ pref, height }) })

  // Startup read: the schema default resolves to the default height ('1').
  assert.equal(await readPanelHeightPreference(ctx), '1')

  // A committed height change (a settings write → mutate → references →
  // event) reaches the sink alongside the (unchanged, narrowed) theme value.
  // There is no dedicated height writer: the /settings browser and external
  // edits mutate the path directly.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['panelHeight'], value: '10' }])
  assert.deepEqual(sink, [{ pref: 'auto', height: '10' }], 'the commit forwarded the height')

  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['panelHeight'], value: 'all' }])
  assert.deepEqual(sink, [{ pref: 'auto', height: '10' }, { pref: 'auto', height: 'all' }],
    'second commit forwarded too')

  assert.equal(await readPanelHeightPreference(ctx), 'all', 'live value read back')
})

test('persisted panelHeight survives the startup reader for every schema literal', async () => {
  const { ctx, settings } = boot()

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

test('a single commit of both fields forwards both narrowed values in one callback', async () => {
  const sink = []
  const { ctx, settings } = boot((pref, height) => { sink.push({ pref, height }) })

  // A config reset / external edit commits BOTH fields in one mutate: the
  // event fires once and the sink sees both values — the index.ts sink then
  // applies the height first and the theme second (one replay rebuild at the
  // new height), never a double replay.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [
    { op: 'set', path: ['theme'], value: 'dark' },
    { op: 'set', path: ['panelHeight'], value: '10' },
  ])
  assert.deepEqual(sink, [{ pref: 'dark', height: '10' }], 'one callback carries both fields')

  // The references carry both values for the startup readers.
  assert.equal(await readThemePreference(ctx), 'dark', 'theme read back')
  assert.equal(await readPanelHeightPreference(ctx), '10', 'height read back')
})

test('the readers narrow garbage that reached the references', async () => {
  // Under 0.1.7 a validated volatile-only update cannot carry garbage into
  // the references — but the narrowing stays the last line of defense (a
  // future host bug, a hand-rolled rebind). Bind raw garbage directly and
  // lock the readers' contract.
  bindTuiConfig(refsFromSection({
    theme: 42,
    panelHeight: '12',
    footerHints: 'garbage',
    iconSet: 'neon',
    language: '',
    rememberPreset: 'yes',
    maxAgents: 2.5,
    maxRounds: -1,
    disableSubagent: 'yes',
    registeredOnly: null,
    favoriteModels: ['ok', 42, null, {}, 'also-ok'],
    hiddenModels: 'garbage',
  }))
  const ctx = new Context()
  assert.equal(await readThemePreference(ctx), 'auto', 'non-string theme narrows to auto')
  assert.equal(await readPanelHeightPreference(ctx), '1', 'unknown height narrows to 1')
  assert.deepEqual(await readFooterHintsPreference(ctx), { ...DEFAULT_FOOTER_HINTS }, 'garbage hints narrow to all-on')
  assert.equal(readFooterHintsPreference(ctx).send, true)
  assert.equal(currentCacheHitMode(ctx), 'lastMessage', 'missing cacheHitMode narrows to the default')

  const limits = readSubagentLimits(ctx)
  assert.deepEqual(limits, {
    maxAgents: DEFAULT_SUBAGENT_LIMITS.maxAgents,
    maxRounds: DEFAULT_SUBAGENT_LIMITS.maxRounds,
    maxRoundsGrace: DEFAULT_SUBAGENT_LIMITS.maxRoundsGrace,
    disableSubagent: DEFAULT_SUBAGENT_LIMITS.disableSubagent,
    registeredOnly: DEFAULT_SUBAGENT_LIMITS.registeredOnly,
  }, 'malformed limits narrow to the documented defaults per-key')

  const prefs = await import('../lib/theme-settings.js').then(m => m.readModelPrefs(ctx))
  assert.deepEqual(prefs, { favoriteModels: ['ok', 'also-ok'], hiddenModels: [] },
    'model pref lists narrow per entry')

  // The narrow helpers keep their pure contracts too.
  assert.equal(narrowCacheHitMode('session'), 'session')
  assert.equal(narrowCacheHitMode('bogus'), 'lastMessage')
  assert.equal(narrowCacheHitMode(undefined), 'lastMessage')
  assert.equal(narrowCacheHitMode(42), 'lastMessage')
})

test('subagent limits resolve to defaults and round-trip through a committed write', async () => {
  const { ctx } = boot()

  // Schema defaults seed the documented caps (disableSubagent on).
  const defaults = {
    maxAgents: DEFAULT_SUBAGENT_LIMITS.maxAgents,
    maxRounds: DEFAULT_SUBAGENT_LIMITS.maxRounds,
    maxRoundsGrace: DEFAULT_SUBAGENT_LIMITS.maxRoundsGrace,
    disableSubagent: DEFAULT_SUBAGENT_LIMITS.disableSubagent,
    registeredOnly: DEFAULT_SUBAGENT_LIMITS.registeredOnly,
  }
  assert.deepEqual(readSubagentLimits(ctx), defaults, 'defaults resolve out of the box')

  // A committed write swaps the references; the live reader reflects it.
  assert.equal(await writeSubagentLimit(ctx, 'maxAgents', 2), undefined)
  assert.equal(await writeSubagentLimit(ctx, 'maxRounds', 10), undefined)
  assert.equal(await writeSubagentLimit(ctx, 'disableSubagent', false), undefined)
  assert.equal(await writeSubagentLimit(ctx, 'registeredOnly', true), undefined)
  assert.deepEqual(readSubagentLimits(ctx), { maxAgents: 2, maxRounds: 10, maxRoundsGrace: DEFAULT_SUBAGENT_LIMITS.maxRoundsGrace, disableSubagent: false, registeredOnly: true }, 'committed limits read back')
})

test('readOfficialSubagentLimits mirrors the official subagent entry (0.1.7 panel alignment)', async () => {
  const officialWith = (value) => {
    const ctx = new Context()
    ctx.provide('settings', {
      describe: () => [
        { ns: THEME_SETTINGS_NAMESPACE, revision: 1, value: {} },
        { ns: 'subagent', revision: 1, value },
      ],
    })
    return ctx
  }

  // A live official entry with resolved volatile values reads both caps.
  const live = officialWith({ maxActiveSubagents: 8, maxDepth: 1 })
  assert.deepEqual(readOfficialSubagentLimits(live), { maxActiveSubagents: 8, maxDepth: 1 },
    'the official entry mirrors through the forms descriptor')

  // A deployment without the subagent entry (or the service) reads
  // undefined/undefined — the panel annotates n/a instead of guessing.
  const absent = new Context()
  assert.deepEqual(readOfficialSubagentLimits(absent), { maxActiveSubagents: undefined, maxDepth: undefined },
    'no settings service -> unreadable')
  const missing = officialWith(undefined)
  assert.deepEqual(readOfficialSubagentLimits(missing), { maxActiveSubagents: undefined, maxDepth: undefined },
    'no subagent entry -> unreadable')

  // Malformed values degrade per-field (display-only reader, best-effort).
  const garbage = officialWith({ maxActiveSubagents: 'many', maxDepth: -3 })
  assert.deepEqual(readOfficialSubagentLimits(garbage), { maxActiveSubagents: undefined, maxDepth: undefined },
    'garbage values read as unreadable, never a number')
})

test('maxRounds defaults to 75 and is configurable through the settings chain', async () => {
  // Lock the documented default (the user picked 75 — headroom for heavy
  // delegated tasks under the assistant-message round count, still a runaway
  // guard). Any future bump must update this assertion deliberately.
  assert.equal(DEFAULT_SUBAGENT_LIMITS.maxRounds, 75, 'documented maxRounds default is 75')

  const { ctx } = boot()

  // The schema default seeds the references (no user value configured).
  assert.equal(readSubagentLimits(ctx).maxRounds, 75, 'resolved default is 75')

  // A configured value round-trips through the live reader — both the
  // `/agents → l` limits panel and the `/settings` browser write through
  // `writeSubagentLimit` → settings.mutate, and the policy re-reads it at
  // every decision point.
  assert.equal(await writeSubagentLimit(ctx, 'maxRounds', 120), undefined)
  assert.equal(readSubagentLimits(ctx).maxRounds, 120, 'configured maxRounds read back')
  assert.equal(await writeSubagentLimit(ctx, 'maxRounds', 75), undefined)
  assert.equal(readSubagentLimits(ctx).maxRounds, 75, 'back to the default')
})

test('subagent-limit writes retry once on SettingsConflictError, then surface it', async () => {
  const { ctx, settings } = boot()

  // One concurrent writer: the first attempt conflicts, the retry (fresh
  // revision) succeeds.
  settings.conflicts = 1
  assert.equal(await writeSubagentLimit(ctx, 'maxAgents', 2), undefined, 'the retry lands')
  assert.equal(readSubagentLimits(ctx).maxAgents, 2)

  // Two concurrent writers: even the retry conflicts — the raw conflict
  // surfaces as the friendly message instead of throwing.
  settings.conflicts = 2
  assert.equal(
    await writeSubagentLimit(ctx, 'maxAgents', 8),
    'Settings changed concurrently — please retry.',
    'a second conflict surfaces the friendly message',
  )
})

test('subagent limits fall back to defaults when the config or a field is missing', async () => {
  const defaults = {
    maxAgents: DEFAULT_SUBAGENT_LIMITS.maxAgents,
    maxRounds: DEFAULT_SUBAGENT_LIMITS.maxRounds,
    maxRoundsGrace: DEFAULT_SUBAGENT_LIMITS.maxRoundsGrace,
    disableSubagent: DEFAULT_SUBAGENT_LIMITS.disableSubagent,
    registeredOnly: DEFAULT_SUBAGENT_LIMITS.registeredOnly,
  }

  // No bound entry config (apply not yet run): reads degrade to the schema
  // defaults; writes report instead of throwing (no settings service either).
  const bare = new Context()
  bindTuiConfig(undefined)
  assert.deepEqual(readSubagentLimits(bare), defaults, 'unbound read degrades to defaults')
  const writeError = await writeSubagentLimit(bare, 'maxAgents', 1)
  assert.equal(writeError, 'Settings service is not available.', 'settings-less write surfaces the failure')

  // A committed boolean toggle round-trips through the live reader.
  const { ctx, settings } = boot()
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['disableSubagent'], value: false }])
  assert.equal(readSubagentLimits(ctx).disableSubagent, false, 'committed disableSubagent read back')

  // Unsetting the field falls back to the schema default.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'unset', path: ['disableSubagent'] }])
  assert.equal(readSubagentLimits(ctx).disableSubagent, true, 'missing field falls back per-key')
})

test('committed footerHints changes flow mutate → references → event → sink', async () => {
  const sink = []
  const { ctx, settings } = boot((_pref, _height, hints) => { sink.push(hints) })

  // Schema defaults seed every hint on.
  assert.deepEqual(await readFooterHintsPreference(ctx), { ...DEFAULT_FOOTER_HINTS }, 'defaults = all on')

  // A committed footerHints change (a /settings toggle → mutate → event)
  // reaches the sink — the applyFooterHintsRef chain — with the narrowed map.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [
    { op: 'set', path: ['footerHints'], value: { ...DEFAULT_FOOTER_HINTS, quit: false, history: false } },
  ])
  assert.deepEqual(sink, [{ ...DEFAULT_FOOTER_HINTS, quit: false, history: false }], 'the commit forwarded the hints')

  // Partial / malformed sections narrow per-key back to the defaults.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'set', path: ['footerHints'], value: { send: false } }])
  assert.deepEqual(sink[1], { ...DEFAULT_FOOTER_HINTS, send: false }, 'missing keys default on, send off')

  // Unset → the whole section falls back to the schema default.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'unset', path: ['footerHints'] }])
  assert.deepEqual(sink[2], { ...DEFAULT_FOOTER_HINTS }, 'missing footerHints key narrows to all-on')

  // The live value is readable back through the readers.
  assert.deepEqual(await readFooterHintsPreference(ctx), { ...DEFAULT_FOOTER_HINTS }, 'live value read back')
})

test('cacheHitMode defaults to lastMessage, round-trips, and narrows garbage', async () => {
  const { ctx, settings } = boot()

  // The schema default seeds the pi-tui-compatible default.
  assert.equal(DEFAULT_CACHE_HIT_MODE, 'lastMessage')
  assert.equal(currentCacheHitMode(ctx), 'lastMessage', 'default = per-message CH')

  // A committed change (a /settings browser write → mutate) is readable back
  // synchronously — the footer re-reads this on every render.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [
    { op: 'set', path: ['cacheHitMode'], value: 'session' },
  ])
  assert.equal(currentCacheHitMode(ctx), 'session', 'committed session mode read back')

  // An out-of-union value narrows the same way.
  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'unset', path: ['cacheHitMode'] }])
  assert.equal(currentCacheHitMode(ctx), 'lastMessage', 'missing key narrows to the default')
})

// ------------------------------------------------- session-management user layer --
// `readSessionManagementExplicit` is the precedence seam for the retention
// and resume knobs: ONLY a field present in the settings document's USER
// layer is an explicit override. The resolved references bake the schema
// defaults in (a missing retention.maxCount resolves to 100), so reading them
// would make the defaults outrank the DSH_TUI_RETENTION_* / DSH_TUI_RESUME_*
// env vars. Under 0.1.7 the user layer is the volatile-projected override of
// the profile patch (the imported settings.yaml section lands there too) and
// rides describe() — the values pass through UNNARROWED; one notice per field
// happens later, inside resolveRetentionConfig / resolveResumeConfig.

test('readSessionManagementExplicit returns the raw user-layer retention/resume fields', async () => {
  const { ctx, settings } = boot()

  // The user layer is flipped AFTER the references were bound — the one path
  // where the raw section is exposed (an external patch edit). The values
  // pass through UNNARROWED.
  settings.user = {
    retention: { maxCount: 42, maxAgeDays: 'later' },
    resume: { minBytes: 4096, maxAgeDays: null },
  }
  assert.deepEqual(await readSessionManagementExplicit(ctx), {
    retention: { maxCount: 42, maxAgeDays: 'later' },
    resume: { minBytes: 4096, maxAgeDays: null },
  }, 'raw fields through, nothing narrowed')

  // A later external edit is visible on the next read (the user layer is
  // re-read per describe, not snapshotted).
  settings.user = { resume: { minBytes: 8192 } }
  assert.deepEqual(await readSessionManagementExplicit(ctx), {
    retention: undefined,
    resume: { minBytes: 8192 },
  }, 'fresh user layer read back')
})

test('readSessionManagementExplicit ignores the resolved references — schema defaults are not overrides', async () => {
  const { ctx, settings } = boot()

  // Sanity: the RESOLVED references carry the baked-in defaults
  // (retention 100/30d/24h, resume 30d/1KB).
  assert.equal(readThemePreference(ctx) !== undefined, true, 'references are live')
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
  const { ctx, settings } = boot()

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
  // reachable ONLY via the external-edit path (a settings write would be
  // schema-refused). Harmless downstream: the resolvers' per-field narrowing
  // finds no fields on an array, so nothing overrides.
  settings.user = { resume: ['not', 'a', 'section'] }
  const explicit = await readSessionManagementExplicit(ctx)
  assert.ok(Array.isArray(explicit.resume), 'object-typed section passes through raw')
})

test('readSessionManagementExplicit degrades to the empty shape without a service or the entry', async () => {
  // No settings service at all: the stable empty shape, never a throw — the
  // retention janitor and the /resume picker proceed on env/defaults.
  const bare = new Context()
  assert.deepEqual(
    await readSessionManagementExplicit(bare),
    { retention: undefined, resume: undefined },
  )

  // A settings service that carries no dsh-tui entry (fresh profile): no
  // descriptor → the same empty shape.
  const stranger = new Context()
  stranger.provide('settings', { describe: () => [] })
  assert.deepEqual(
    await readSessionManagementExplicit(stranger),
    { retention: undefined, resume: undefined },
  )
})

test('readAskUserExplicit passes the raw askUser section through and degrades cleanly', async () => {
  const { ctx, settings } = boot()

  assert.equal(await readAskUserExplicit(ctx), undefined, 'no user layer = nothing explicit')

  settings.user = { askUser: { idleMinutes: 1, absoluteMinutes: 3 } }
  assert.deepEqual(await readAskUserExplicit(ctx), { idleMinutes: 1, absoluteMinutes: 3 }, 'raw section through')

  settings.user = { askUser: 'garbage' }
  assert.equal(await readAskUserExplicit(ctx), undefined, 'scalar section narrows to undefined')

  const bare = new Context()
  assert.equal(await readAskUserExplicit(bare), undefined, 'service-less read degrades')
})

test('a garbage user layer never reaches the retention knobs — env wins alone', async () => {
  // The 0.1.5 registration-failure test's successor: garbage sitting in the
  // document at boot no longer fails a registration (there is none) — the
  // host's legacy-settings import rejects the section with a warning and the
  // values stay in settings.yaml.imported. Either way the resolvers see
  // "nothing explicit" and the environment alone governs.
  resetNoticeBridge()
  const notices = []
  setNoticeSink(message => { notices.push(message) })
  try {
    const { ctx, settings } = boot()
    settings.user = { retention: { maxAgeDays: 'later' } }
    const explicit = await readSessionManagementExplicit(ctx)
    // The raw garbage passes through the seam (the resolvers narrow it), so
    // lock THAT seam's downstream contract instead: with an explicit section
    // that fails per-field narrowing, the env fallback still fills the rest.
    assert.equal(explicit.retention?.maxAgeDays, 'later')
    assert.deepEqual(
      resolveRetentionConfig({ DSH_TUI_RETENTION_MAX_COUNT: '7' }, { retention: undefined, resume: undefined }),
      {
        maxCount: 7,
        maxAgeDays: RETENTION_MAX_AGE_DAYS,
        minIdleMs: 24 * 60 * 60 * 1000,
        enabled: true,
      },
      'retention knobs come from env when nothing explicit survives',
    )
    assert.equal(notices.length, 0, 'the seam itself stays silent (notices are the resolvers job)')
  } finally {
    resetNoticeBridge()
  }
})
