/**
 * Theme settings: the dsh-tui entry configuration — the user's theme
 * preference, the think/tool panel height, the UI language, the footer-hint
 * selection, the icon-set mode and the subagent concurrency/rounds limits.
 *
 * dsh 0.1.7 model (breaking change from 0.1.5): the runtime
 * namespace-registration API is GONE. A plugin declares its
 * user-facing configuration as a `static Config` schema; the loader projects
 * every `.volatile()` field into the settings surface (describe / update /
 * mutate) and hands the resolved values to `apply(ctx, config)` — volatile
 * fields arrive as live `Volatile<T>` references. Declaration IS
 * registration: there is nothing to register at runtime anymore.
 *
 * Reading: `config.field.get()` — a deep-frozen snapshot, refreshed IN PLACE
 * by the loader on every volatile-only commit (the fiber never remounts, the
 * references stay identical), so a value read is always current.
 *
 * Hot-apply: the plugin subscribes to `settings/document-updated` (the
 * 0.1.5 per-namespace watch-hook replacement) and re-reads the references on
 * every event. The
 * event also fires for this TUI's own writes; every sink downstream is an
 * idempotent no-op on an unchanged value (theme-bundle identity guard, same
 * height, same hints), so the echo is harmless.
 *
 * Session-management sections (`retention`, `resume`, `askUser`) keep their
 * USER-layer precedence seam: only a field the user explicitly wrote into the
 * profile patch (`cordis.patch.yml` → entry `dsh-tui` → `config:`; the 0.1.5
 * `settings.yaml` document is auto-imported there once on first 0.1.7 boot)
 * is an override — the resolved value's baked-in defaults must not shadow the
 * DSH_TUI_RETENTION_* / DSH_TUI_RESUME_* / DSH_TUI_ASK_USER_* environment
 * variables (precedence: settings explicit > env > default). Those readers
 * go through `settings.describe()[].user`, the only channel exposing the raw
 * explicit layer.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import {
  SettingsConflictError,
  type SettingsForms,
  type SettingsPathOp,
} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_FOOTER_HINTS, type FooterHints } from './footer.ts'
import { t } from './i18n/index.ts'
import { DEFAULT_PANEL_HEIGHT, isPanelHeight, type PanelHeight } from './activity.ts'
import { narrowStringList } from './model-list.ts'
import type { IconSet } from './icons.ts'
import { RETENTION_MAX_AGE_DAYS, RETENTION_MAX_COUNT, RETENTION_MIN_IDLE_HOURS } from './retention.ts'
import { RESUME_MAX_AGE_DAYS, RESUME_MIN_BYTES } from './sessions.ts'
import { ASK_USER_ABSOLUTE_MINUTES_DEFAULT, ASK_USER_IDLE_MINUTES_DEFAULT } from './ask-user.ts'
import type { ThemePreference } from './theme/index.ts'

/**
 * Settings entry id carrying the persisted dsh-tui preferences.
 *
 * This is BOTH the profile patch entry id (cordis.patch.yml mounts this
 * package as `- id: dsh-tui`) and the legacy settings.yaml section name —
 * keeping them identical is what lets the 0.1.7 one-time settings.yaml
 * import (`settings.yaml` → renamed `.imported`, sections merged into the
 * matching entry's config) pick up every existing user value without a shim.
 */
export const THEME_SETTINGS_NAMESPACE = 'dsh-tui'

/**
 * Which usage sample the footer's CH segment reports: the LATEST assistant
 * message's own hit rate (the pi-tui / pi-powerline-footer semantics) or the
 * session-cumulative rate over the whole session's input traffic.
 */
export type CacheHitMode = 'lastMessage' | 'session'

/** The footer CH default: per-message, matching the pi-tui footer. */
export const DEFAULT_CACHE_HIT_MODE: CacheHitMode = 'lastMessage'

/** The UI language default: the bundled English catalog. */
export const DEFAULT_LANGUAGE = 'en'

/** Validate an unknown `cacheHitMode` value (anything else narrows to the default). */
export function narrowCacheHitMode(value: unknown): CacheHitMode {
  return value === 'session' ? 'session' : DEFAULT_CACHE_HIT_MODE
}

/** Subagent concurrency/rounds/tool knobs read by the subagent policy. */
export interface SubagentLimits {
  /** Concurrent live children allowed; 0 lifts the cap (the guard stays off). */
  maxAgents: number
  /**
   * Assistant messages per child (one per LLM round-trip — the "rounds" unit)
   * before a summary request is injected; 0 disables.
   */
  maxRounds: number
  /**
   * Rounds a child may keep burning AFTER the wrap-up injection before the
   * policy hard-stops it (code-forced cancel — no further consent asked from
   * the child LLM); 0 disables the hard stop (pure-soft mode, the historical
   * wrap-up-only behavior).
   */
  maxRoundsGrace: number
  /**
   * Disable the native `subagent` tool for every agent in the process, so
   * plain ad-hoc delegation goes through a registered agent definition
   * (`~/.dsh/agents/*.md` via `use_agent`) instead. Deliberately narrow:
   * `subagent_fork`, `workflow` and `ralph` stay available (they are not the
   * plain one-shot spawn the TUI's user wants fenced off).
   */
  disableSubagent: boolean
  /**
   * Fence EVERY spawn tool except the registry's `use_agent`: delegation may
   * only create subagents backed by a registered agent definition
   * (`~/.dsh/agents/*.md`), and the ad-hoc paths — native `subagent`,
   * `subagent_fork`, `workflow`, `ralph` — are denied at the guard. This is
   * the "no subagents we did not define" lever: any child whose label is a
   * task description rather than a registered agent's display name is a
   * fence miss this knob closes. Default off (the narrower
   * `disableSubagent` fence stays the out-of-the-box stance).
   */
  registeredOnly: boolean
}

/**
 * Default subagent limits, applied whenever the entry config cannot be read.
 * 4 concurrent children and 75 rounds per child are the documented
 * out-of-the-box behavior (75 rounds = 75 LLM round-trips, headroom for heavy
 * delegated tasks while still capping a runaway child); the native `subagent`
 * tool is disabled by default — the TUI's user delegates through registered
 * agents (toggle it in /agents → l limits when the plain tool is needed again).
 */
export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = Object.freeze({
  maxAgents: 4,
  maxRounds: 75,
  maxRoundsGrace: 7,
  disableSubagent: true,
  registeredOnly: false,
})

/** Grouped session-log retention knobs (see resolveRetentionConfig). */
export interface RetentionSettings {
  maxCount: number
  maxAgeDays: number
  minIdleHours: number
}

/** Grouped /resume display-window knobs. */
export interface ResumeSettings {
  maxAgeDays: number
  minBytes: number
}

/** Grouped ask-user auto-answer timeout knobs. */
export interface AskUserSettings {
  idleMinutes: number
  absoluteMinutes: number
}

/**
 * Runtime face of the `dsh-tui` entry config. Every field is `.volatile()` —
 * user-editable through the settings surface and hot-applied without a
 * plugin remount — so each arrives as a live `Volatile<T>` reference, read
 * with `.get()`.
 */
export interface TuiSettings {
  language: Volatile<string>
  theme: Volatile<ThemePreference>
  panelHeight: Volatile<PanelHeight>
  maxAgents: Volatile<number>
  maxRounds: Volatile<number>
  maxRoundsGrace: Volatile<number>
  disableSubagent: Volatile<boolean>
  registeredOnly: Volatile<boolean>
  footerHints: Volatile<FooterHints>
  cacheHitMode: Volatile<CacheHitMode>
  iconSet: Volatile<IconSet>
  rememberPreset: Volatile<boolean>
  favoriteModels: Volatile<string[]>
  hiddenModels: Volatile<string[]>
  retention: Volatile<RetentionSettings>
  resume: Volatile<ResumeSettings>
  askUser: Volatile<AskUserSettings>
}

/**
 * The `dsh-tui` entry Config schema — the whole settings surface. Exported
 * from the plugin root (src/index.ts re-exports it): the loader reads
 * `plugin.Config` off the module namespace and validates + resolves the
 * entry's config against it; every field is `.volatile()`, so the settings
 * browser lists all of them and a legacy settings.yaml `dsh-tui:` section
 * imports wholesale (an import carrying any non-volatile field would be
 * rejected as a whole).
 *
 * Plain z.number() (not z.natural()) inside `retention`/`resume`/`askUser` on
 * purpose, same as the 0.1.5 schema: a range-constrained field lets one
 * hand-edited out-of-range number get the whole volatile-only update refused
 * (the write is rejected and the raw value still lands on disk — see the
 * dsh 0.1.7 "not volatile / validation" semantics), so the per-field range
 * check happens in the readers (resolveRetentionConfig / resolveResumeConfig /
 * resolveAskUserTimeouts), which fall back to env/defaults with one stderr
 * line instead.
 */
export const Config = z.object({
  language: z
    .string()
    .default(DEFAULT_LANGUAGE)
    .volatile()
    .description(t('settings.language.description')),
  theme: z
    .string()
    .default('auto')
    .volatile()
    .description(t('settings.theme.description')),
  panelHeight: z
    .union(['1', '5', '7', '10', 'all'])
    .default(DEFAULT_PANEL_HEIGHT)
    .volatile()
    .description(t('settings.panelHeight.description')),
  // `z.natural()` is schemastery's constraint for a non-negative integer
  // (the `z.number().int().min(0)` intent — no `.int()` chain exists here).
  maxAgents: z
    .natural()
    .default(DEFAULT_SUBAGENT_LIMITS.maxAgents)
    .volatile()
    .description(t('settings.maxAgents.description')),
  maxRounds: z
    .natural()
    .default(DEFAULT_SUBAGENT_LIMITS.maxRounds)
    .volatile()
    .description(t('settings.maxRounds.description')),
  maxRoundsGrace: z
    .natural()
    .default(DEFAULT_SUBAGENT_LIMITS.maxRoundsGrace)
    .volatile()
    .description(t('settings.maxRoundsGrace.description')),
  disableSubagent: z
    .boolean()
    .default(DEFAULT_SUBAGENT_LIMITS.disableSubagent)
    .volatile()
    .description(t('settings.disableSubagent.description')),
  registeredOnly: z
    .boolean()
    .default(DEFAULT_SUBAGENT_LIMITS.registeredOnly)
    .volatile()
    .description(t('settings.registeredOnly.description')),
  footerHints: z
    .object({
      send: z.boolean().default(true).description(t('settings.footerHints.send.description')),
      stop: z.boolean().default(true).description(t('settings.footerHints.stop.description')),
      quit: z.boolean().default(true).description(t('settings.footerHints.quit.description')),
      quitEmpty: z.boolean().default(true).description(t('settings.footerHints.quitEmpty.description')),
      subagents: z.boolean().default(true).description(t('settings.footerHints.subagents.description')),
      search: z.boolean().default(true).description(t('settings.footerHints.search.description')),
      history: z.boolean().default(true).description(t('settings.footerHints.history.description')),
    })
    .default({ ...DEFAULT_FOOTER_HINTS })
    .volatile()
    .description(t('settings.footerHints.description')),
  cacheHitMode: z
    .union(['lastMessage', 'session'])
    .default(DEFAULT_CACHE_HIT_MODE)
    .volatile()
    .description(t('settings.cacheHitMode.description')),
  iconSet: z
    .union(['auto', 'nerdfont', 'plain'])
    .default('auto')
    .volatile()
    .description(t('settings.iconSet.description')),
  rememberPreset: z
    .boolean()
    .default(true)
    .volatile()
    .description(t('settings.rememberPreset.description')),
  favoriteModels: z
    .array(z.string())
    .default([])
    .volatile()
    .description(t('settings.favoriteModels.description')),
  hiddenModels: z
    .array(z.string())
    .default([])
    .volatile()
    .description(t('settings.hiddenModels.description')),
  retention: z
    .object({
      maxCount: z
        .number()
        .default(RETENTION_MAX_COUNT)
        .description(t('settings.retention.maxCount.description')),
      maxAgeDays: z
        .number()
        .default(RETENTION_MAX_AGE_DAYS)
        .description(t('settings.retention.maxAgeDays.description')),
      minIdleHours: z
        .number()
        .default(RETENTION_MIN_IDLE_HOURS)
        .description(t('settings.retention.minIdleHours.description')),
    })
    .default({
      maxCount: RETENTION_MAX_COUNT,
      maxAgeDays: RETENTION_MAX_AGE_DAYS,
      minIdleHours: RETENTION_MIN_IDLE_HOURS,
    })
    .volatile()
    .description(t('settings.retention.description')),
  resume: z
    .object({
      maxAgeDays: z
        .number()
        .default(RESUME_MAX_AGE_DAYS)
        .description(t('settings.resume.maxAgeDays.description')),
      minBytes: z
        .number()
        .default(RESUME_MIN_BYTES)
        .description(t('settings.resume.minBytes.description')),
    })
    .default({ maxAgeDays: RESUME_MAX_AGE_DAYS, minBytes: RESUME_MIN_BYTES })
    .volatile()
    .description(t('settings.resume.description')),
  askUser: z
    .object({
      idleMinutes: z
        .number()
        .default(ASK_USER_IDLE_MINUTES_DEFAULT)
        .description(t('settings.askUser.idleMinutes.description')),
      absoluteMinutes: z
        .number()
        .default(ASK_USER_ABSOLUTE_MINUTES_DEFAULT)
        .description(t('settings.askUser.absoluteMinutes.description')),
    })
    .default({ idleMinutes: ASK_USER_IDLE_MINUTES_DEFAULT, absoluteMinutes: ASK_USER_ABSOLUTE_MINUTES_DEFAULT })
    .volatile()
    .description(t('settings.askUser.description')),
})

/**
 * The schema's own defaults, resolved ONCE as volatile references — the
 * fallback for every reader while no entry config has been bound (a test
 * driving `apply(ctx)` without a loader, or a read before `apply` ran).
 */
const DEFAULT_TUI_SETTINGS: TuiSettings = Config({}) as unknown as TuiSettings

/** The live entry config handed to `apply` by the loader (undefined = not bound yet). */
let boundConfig: TuiSettings | undefined

/**
 * Bind the loader-resolved entry config (the `config` parameter of
 * `apply(ctx, config)`). Called once per plugin application; a `/reload`
 * re-runs `apply` and re-binds. Volatile-only commits later swap the values
 * behind the SAME references in place, so the bound object stays current
 * without rebinding.
 */
export function bindTuiConfig(config: TuiSettings | undefined): void {
  boundConfig = config
}

/** The config to read: the bound entry config, else the schema defaults. */
function tuiConfig(): TuiSettings {
  return boundConfig ?? DEFAULT_TUI_SETTINGS
}

/** Resolve an export of the Config schema into a `TuiSettings`-shaped object (test helper). */
export function resolveTuiSettings(overrides: Record<string, unknown> = {}): TuiSettings {
  return Config(overrides) as unknown as TuiSettings
}

/** Validate an unknown `footerHints` value into the typed shape (defaults win). */
function narrowFooterHints(value: unknown): FooterHints {
  if (value === null || typeof value !== 'object') return { ...DEFAULT_FOOTER_HINTS }
  const section = value as Partial<Record<keyof FooterHints, unknown>>
  const hints: FooterHints = { ...DEFAULT_FOOTER_HINTS }
  for (const key of Object.keys(DEFAULT_FOOTER_HINTS) as (keyof FooterHints)[]) {
    if (typeof section[key] === 'boolean') hints[key] = section[key]
  }
  return hints
}

/** Validate an unknown `iconSet` value (anything else narrows to 'auto'). */
function narrowIconSet(value: unknown): IconSet {
  return value === 'nerdfont' || value === 'plain' ? value : 'auto'
}

/** Validate an unknown `language` value (anything else narrows to the 'en' fallback). */
export function narrowLanguage(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : DEFAULT_LANGUAGE
}

/** Validate an unknown `rememberPreset` value (anything else narrows to true). */
function narrowRememberPreset(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true
}

/** Validate an unknown `theme` value (custom theme names pass through). */
function narrowTheme(value: unknown): ThemePreference {
  return typeof value === 'string' && value !== '' ? value : 'auto'
}

/**
 * Subscribe the hot-reload sink to committed `dsh-tui` changes — the 0.1.7
 * replacement of the 0.1.5 watch hook (the runtime registration call itself
 * is gone: the static Config schema declares the entry config, the loader
 * owns the projection).
 *
 * `settings/document-updated` carries `(ns, revision)` and fires whenever the
 * entry's raw config changed — the /theme picker, the /settings browser, an
 * external patch edit, or this TUI's own write (the echo). The handler
 * re-reads the live volatile references (the loader updated them in place
 * before the event) and forwards the narrowed bundle to the sink; callers
 * guard re-applies by theme-bundle identity and height change, so an echoed
 * self-write is a no-op. The whole commit → references → event → `.get()`
 * → sink chain is synchronous per event.
 *
 * @param ctx - plugin context; the subscription dies with the plugin fiber.
 * @param onPreferenceChange - hot-reload sink for committed `dsh-tui` theme,
 * panel-height, footer-hints, icon-set and language changes; `undefined`
 * registers nothing.
 */
export function subscribeThemeSettings(
  ctx: Context,
  onPreferenceChange?: (pref: ThemePreference, panelHeight: PanelHeight, footerHints: FooterHints, iconSet: IconSet, language: string) => void,
): void {
  if (onPreferenceChange === undefined) return
  ctx.on('settings/document-updated', (ns) => {
    if (ns !== THEME_SETTINGS_NAMESPACE) return
    const section = tuiConfig()
    onPreferenceChange(
      narrowTheme(section.theme.get()),
      isPanelHeight(section.panelHeight.get()) ? section.panelHeight.get() : DEFAULT_PANEL_HEIGHT,
      narrowFooterHints(section.footerHints.get()),
      narrowIconSet(section.iconSet.get()),
      narrowLanguage(section.language.get()),
    )
  })
}

/**
 * Read the persisted theme preference (the startup snapshot).
 *
 * @returns the live `dsh-tui` theme value, or `'auto'` when the entry config
 * is not bound (a `Config`-less deployment always has the schema default).
 */
export function readThemePreference(_ctx: Context): ThemePreference {
  return narrowTheme(tuiConfig().theme.get())
}

/**
 * Read the persisted think/tool panel height (the startup snapshot).
 *
 * @returns the live `dsh-tui` panelHeight value, or DEFAULT_PANEL_HEIGHT when
 * the entry config is not bound.
 */
export function readPanelHeightPreference(_ctx: Context): PanelHeight {
  const height = tuiConfig().panelHeight.get()
  return isPanelHeight(height) ? height : DEFAULT_PANEL_HEIGHT
}

/**
 * Read the persisted footer-hint selection (the startup snapshot).
 *
 * @returns the live `dsh-tui` footerHints object, or DEFAULT_FOOTER_HINTS
 * when the entry config is not bound.
 */
export function readFooterHintsPreference(_ctx: Context): FooterHints {
  return narrowFooterHints(tuiConfig().footerHints.get())
}

/**
 * Read the persisted icon-set mode (the startup snapshot).
 *
 * @returns the live `dsh-tui` iconSet value, or `'auto'` when the entry
 * config is not bound.
 */
export function readIconSetPreference(_ctx: Context): IconSet {
  return narrowIconSet(tuiConfig().iconSet.get())
}

/**
 * Read the persisted UI language (the startup snapshot).
 *
 * @returns the live `dsh-tui` language value, or DEFAULT_LANGUAGE ('en') when
 * the entry config is not bound. Whether the id is actually installed is
 * decided by the i18n registry (initI18n degrades unknown ids to 'en').
 */
export function readLanguagePreference(_ctx: Context): string {
  return narrowLanguage(tuiConfig().language.get())
}

/**
 * Read the persisted preset-memory toggle (the startup snapshot). Default
 * TRUE: remembering is the out-of-the-box behavior; only an explicit
 * `rememberPreset: false` turns it off.
 *
 * @returns the live boolean, or `true` when the entry config is not bound.
 */
export function readRememberPreset(_ctx: Context): boolean {
  return narrowRememberPreset(tuiConfig().rememberPreset.get())
}

/**
 * Explicit session-management overrides as the user wrote them into the
 * profile patch (entry `dsh-tui` → `config:`) — the raw `user` layer of the
 * settings descriptor, NOT the resolved value. This distinction is the
 * precedence seam: the resolved value bakes the schema defaults in (a missing
 * `retention.maxCount` resolves to 100), so reading it would make the
 * defaults outrank the DSH_TUI_RETENTION and DSH_TUI_RESUME environment
 * variables; only a field PRESENT in the user layer is an explicit override
 * (`settings explicit > env > default`, honored by `resolveRetentionConfig` /
 * `resolveResumeConfig`). Fields stay `unknown` — a hand-edited document can
 * carry anything, and the resolvers narrow per field with one stderr line on
 * garbage. The user layer rides `settings.describe()` — the only public
 * channel for the raw explicit layer (volatile `.get()` reads expose the
 * RESOLVED value only).
 */
export interface SessionManagementExplicit {
  retention?: { maxCount?: unknown; maxAgeDays?: unknown; minIdleHours?: unknown }
  resume?: { maxAgeDays?: unknown; minBytes?: unknown }
}

/**
 * Read the explicit `dsh-tui.retention` / `dsh-tui.resume` sections from the
 * settings document's user layer (see `SessionManagementExplicit`).
 *
 * @param ctx - plugin context.
 * @returns ALWAYS the two-key shape — a section absent from the user
 * layer (or the whole service/entry missing) reads as
 * `{ retention: undefined, resume: undefined }`, never a bare
 * `undefined`, so callers destructure one stable shape. "Nothing
 * explicitly configured" (env/defaults govern) and "nothing to read at
 * all" are the same outcome for every consumer.
 */
export function readSessionManagementExplicit(ctx: Context): SessionManagementExplicit {
  const settings = ctx.get('settings') as SettingsForms | undefined
  const user = settings?.describe().find((descriptor) => descriptor.ns === THEME_SETTINGS_NAMESPACE)?.user
  if (user === null || typeof user !== 'object') {
    return { retention: undefined, resume: undefined }
  }
  const section = user as { retention?: unknown; resume?: unknown }
  const retention = section.retention
  const resume = section.resume
  return {
    retention: retention !== null && typeof retention === 'object' && retention !== undefined
      ? retention as SessionManagementExplicit['retention']
      : undefined,
    resume: resume !== null && typeof resume === 'object' && resume !== undefined
      ? resume as SessionManagementExplicit['resume']
      : undefined,
  }
}

/**
 * Raw user-layer `dsh-tui.askUser` section — the explicit ask-user timeout
 * overrides as written into the profile patch (see
 * `readSessionManagementExplicit` for why the USER layer, not the resolved
 * value, is the precedence seam: the resolved value's schema defaults must
 * not shadow the DSH_TUI_ASK_USER_* environment variables). `undefined` =
 * nothing explicitly configured (env/defaults govern).
 */
export interface AskUserTimeoutExplicit {
  idleMinutes?: unknown
  absoluteMinutes?: unknown
}

/**
 * Read the explicit `dsh-tui.askUser` section from the settings document's
 * user layer. Returns `undefined` when the section, the user layer, the
 * entry, or the whole service is absent — "nothing explicitly configured"
 * for the ask-user resolver.
 */
export function readAskUserExplicit(ctx: Context): AskUserTimeoutExplicit | undefined {
  const settings = ctx.get('settings') as SettingsForms | undefined
  const user = settings?.describe().find((descriptor) => descriptor.ns === THEME_SETTINGS_NAMESPACE)?.user
  if (user === null || typeof user !== 'object') return undefined
  const section = (user as { askUser?: unknown }).askUser
  return section !== null && typeof section === 'object'
    ? section as AskUserTimeoutExplicit
    : undefined
}

/**
 * Read the currently persisted footer-hint selection, synchronously — the
 * live volatile reference, so a committed change applies on the next read.
 * @returns DEFAULT_FOOTER_HINTS when the entry config is not bound.
 */
export function currentFooterHints(_ctx: Context): FooterHints {
  return narrowFooterHints(tuiConfig().footerHints.get())
}

/**
 * Read the currently persisted footer CH mode, synchronously — the footer
 * calls it on every render, so a committed change applies on the next repaint.
 * @returns DEFAULT_CACHE_HIT_MODE when the entry config is not bound.
 */
export function currentCacheHitMode(_ctx: Context): CacheHitMode {
  return narrowCacheHitMode(tuiConfig().cacheHitMode.get())
}

/**
 * Read the currently persisted theme preference, synchronously — the /theme
 * picker preselects the live value.
 * @returns 'auto' when the entry config is not bound.
 */
export function currentThemePreference(_ctx: Context): ThemePreference {
  return narrowTheme(tuiConfig().theme.get())
}

/**
 * Read the currently persisted preset-memory toggle, synchronously — the
 * /preset switch path calls it at every commit, so a `/settings` toggle
 * applies immediately.
 * @returns `true` when the entry config is not bound.
 */
export function currentRememberPreset(_ctx: Context): boolean {
  return narrowRememberPreset(tuiConfig().rememberPreset.get())
}

/**
 * Persist one `dsh-tui` preference (theme, panelHeight, or a subagent limit)
 * through `settings.mutate` (the 0.1.7 spell of the same 0.1.5 write — the
 * signature is unchanged). The write is volatile-only, so the loader commits
 * it into the running references without remounting the plugin, and the
 * `settings/document-updated` event hot-applies it to the TUI. Best-effort:
 * a deployment without the settings service reports the failure; a failed
 * write returns its error message for the caller to surface. A concurrent
 * writer moving the entry rejects with `SettingsConflictError` — retried
 * once against a fresh revision; a second conflict surfaces a friendly
 * message instead of the raw error.
 * @returns undefined on success, the failure message otherwise.
 */
async function writeDshTuiPreference(
  ctx: Context,
  key: 'theme' | 'panelHeight' | 'maxAgents' | 'maxRounds' | 'maxRoundsGrace' | 'disableSubagent'
    | 'registeredOnly'
    | 'language'
    | 'favoriteModels' | 'hiddenModels',
  value: string | number | boolean | string[],
): Promise<string | undefined> {
  const settings = ctx.get('settings') as SettingsForms | undefined
  if (settings === undefined) return 'Settings service is not available.'
  // The descriptor carries the entry's revision (optimistic-concurrency
  // token for mutate) and proves the entry is live; the write rejects when
  // it is not.
  const ops: SettingsPathOp[] = [{ op: 'set', path: [key], value }]
  for (let attempt = 0; ; attempt++) {
    const descriptor = settings.describe().find((d) => d.ns === THEME_SETTINGS_NAMESPACE)
    try {
      await settings.mutate(THEME_SETTINGS_NAMESPACE, ops, descriptor?.revision)
      return undefined
    } catch (error) {
      if (attempt === 0 && error instanceof SettingsConflictError) continue
      return error instanceof SettingsConflictError
        ? 'Settings changed concurrently — please retry.'
        : error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Persist the theme preference to the `dsh-tui` entry config. Volatile-only
 * write: the commit hot-applies to the running TUI through the
 * `settings/document-updated` subscription.
 * @returns undefined on success, the failure message otherwise.
 */
export async function writeThemePreference(ctx: Context, pref: ThemePreference): Promise<string | undefined> {
  return writeDshTuiPreference(ctx, 'theme', pref)
}

/**
 * Persist the UI language to the `dsh-tui` entry config. Volatile-only
 * write: the commit hot-applies to the running TUI.
 * @returns undefined on success, the failure message otherwise.
 */
export async function writeLanguagePreference(ctx: Context, id: string): Promise<string | undefined> {
  return writeDshTuiPreference(ctx, 'language', id)
}

/**
 * Read the currently resolved subagent limits, synchronously — the live
 * volatile references, so every policy decision (the guard at each spawn,
 * `onRoundCount` at each child assistant message) reflects the latest
 * committed value without a watcher. An unbound entry config or a
 * non-integer/negative field degrades to the defaults — a config-less
 * deployment keeps the documented caps.
 */
export function readSubagentLimits(_ctx: Context): SubagentLimits {
  const section = tuiConfig()
  const natural = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
  return {
    maxAgents: natural(section.maxAgents.get(), DEFAULT_SUBAGENT_LIMITS.maxAgents),
    maxRounds: natural(section.maxRounds.get(), DEFAULT_SUBAGENT_LIMITS.maxRounds),
    maxRoundsGrace: natural(section.maxRoundsGrace.get(), DEFAULT_SUBAGENT_LIMITS.maxRoundsGrace),
    disableSubagent: typeof section.disableSubagent.get() === 'boolean'
      ? section.disableSubagent.get()
      : DEFAULT_SUBAGENT_LIMITS.disableSubagent,
    registeredOnly: typeof section.registeredOnly.get() === 'boolean'
      ? section.registeredOnly.get()
      : DEFAULT_SUBAGENT_LIMITS.registeredOnly,
  }
}

/**
 * The OFFICIAL dsh-subagent plugin's own caps (dsh 0.1.7: `static Config`
 * with volatile `maxActiveSubagents` — concurrent continuable children,
 * default 8 — and `maxDepth` — default delegation depth, default 1). These
 * are the host-side concurrency/depth limits that compose with — and are
 * independent of — this TUI's own maxAgents/maxRounds policy knobs. This
 * reader is DISPLAY-ONLY (the /agents limits panel shows the currently
 * effective official caps; editing them belongs to /settings, which owns
 * the `subagent` entry).
 */
export interface OfficialSubagentLimits {
  /** Live official concurrent-children cap; undefined = entry not readable. */
  maxActiveSubagents: number | undefined
  /** Live official delegation depth; undefined = entry not readable. */
  maxDepth: number | undefined
}

/**
 * Read the official `subagent` entry's resolved config through the settings
 * forms descriptor (the only public channel for ANOTHER entry's live
 * values). Best-effort: no settings service, no such entry, or a malformed
 * value reads as `undefined` per field — the panel then annotates the row
 * instead of showing a number it cannot vouch for.
 */
export function readOfficialSubagentLimits(ctx: Context): OfficialSubagentLimits {
  const settings = ctx.get('settings') as SettingsForms | undefined
  const value = settings?.describe().find((d) => d.ns === 'subagent')?.value
  const natural = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
  if (value === null || typeof value !== 'object') {
    return { maxActiveSubagents: undefined, maxDepth: undefined }
  }
  const section = value as { maxActiveSubagents?: unknown; maxDepth?: unknown }
  return {
    maxActiveSubagents: natural(section.maxActiveSubagents),
    maxDepth: natural(section.maxDepth),
  }
}

/**
 * Persist one subagent policy knob (maxAgents, maxRounds, or disableSubagent)
 * to the `dsh-tui` entry config. Volatile-only write: the commit hot-applies
 * without a restart — the policy reads `readSubagentLimits` at the next
 * decision point. Never throws: a deployment without the settings service
 * surfaces a failure message for the caller.
 * @returns undefined on success, the failure message otherwise.
 */
export async function writeSubagentLimit(
  ctx: Context,
  key: 'maxAgents' | 'maxRounds' | 'maxRoundsGrace' | 'disableSubagent' | 'registeredOnly',
  value: number | boolean,
): Promise<string | undefined> {
  return writeDshTuiPreference(ctx, key, value)
}

/** Persisted favorite/hidden model keys (`provider/id` composites). */
export interface ModelPrefs {
  /** Models pinned to the top of the /model picker, in join order. */
  favoriteModels: string[]
  /** Models moved into the picker's dim Hidden section. */
  hiddenModels: string[]
}

/**
 * Read the persisted model favorites/hiddens. Both lists narrow through
 * `narrowStringList` — a malformed field degrades to an empty list.
 */
export function readModelPrefs(_ctx: Context): ModelPrefs {
  const section = tuiConfig()
  return {
    favoriteModels: narrowStringList(section.favoriteModels.get()),
    hiddenModels: narrowStringList(section.hiddenModels.get()),
  }
}

/**
 * Persist one model pref list (favoriteModels or hiddenModels) to the
 * `dsh-tui` entry config via `settings.mutate` (optimistic concurrency, one
 * retry on `SettingsConflictError`) — never a whole-file rewrite. The caller
 * invokes this on every f/h toggle, so each press lands immediately.
 * Best-effort: a deployment without the settings service surfaces the
 * failure message; the in-panel state stays session-local either way.
 * @returns undefined on success, the failure message otherwise.
 */
export async function writeModelPref(
  ctx: Context,
  key: 'favoriteModels' | 'hiddenModels',
  value: readonly string[],
): Promise<string | undefined> {
  return writeDshTuiPreference(ctx, key, [...value])
}
