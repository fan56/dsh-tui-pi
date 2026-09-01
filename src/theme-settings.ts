/**
 * Theme settings: persists the user's theme preference, the think/tool panel
 * height, and the subagent concurrency/rounds limits under the `dsh-tui`
 * settings namespace, surfaced by the /settings browser and the /theme
 * command. The theme and panel-height preferences are read once at TUI
 * startup (`readThemePreference` / `readPanelHeightPreference`); the subagent
 * limits are read live at every policy decision (`readSubagentLimits`). The
 * namespace is marked `applies: 'live'`: a committed change (the /theme
 * picker, the /settings browser, an external edit) is pushed through the
 * watch hook, so the running TUI repaints without a restart.
 *
 * The session-management sections (`retention`, `resume`) ride the same
 * namespace but are read from the descriptor's USER layer
 * (`readSessionManagementExplicit`), not the resolved value: only a field
 * the user explicitly wrote to settings.yaml is an override — the resolved
 * value's baked-in defaults must not shadow the DSH_TUI_RETENTION_* /
 * DSH_TUI_RESUME_* environment variables (precedence: settings explicit >
 * env > default; the janitor consumes its values at next startup, the
 * /resume filter at every picker open).
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  SettingsConflictError,
  type SettingsDescriptor,
  type SettingsPathOp,
  type SettingsProvider,
} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_FOOTER_HINTS, type FooterHints } from './footer.ts'
import { DEFAULT_PANEL_HEIGHT, isPanelHeight, type PanelHeight } from './activity.ts'
import { narrowStringList } from './model-list.ts'
import type { IconSet } from './icons.ts'
import { RETENTION_MAX_AGE_DAYS, RETENTION_MAX_COUNT, RETENTION_MIN_IDLE_HOURS } from './retention.ts'
import { RESUME_MAX_AGE_DAYS, RESUME_MIN_BYTES } from './sessions.ts'
import { emitNotice } from './notice-bridge.ts'
import type { ThemePreference } from './theme/index.ts'

/**
 * Settings namespace carrying the persisted dsh-tui preferences.
 *
 * dsh-settings 0.1.2-alpha.3 removed the runtime settingsNamespace() helper
 * (and the SettingsNamespace constructor it returned): a plain literal is the
 * supported spelling — register() brand-checks it at the type level
 * (SettingsNamespaceInput) and validates the same lowercase-hyphenated pattern
 * at runtime (parseSettingsNamespace). Comparisons against a descriptor's
 * branded `ns` stay exact string equality.
 */
export const THEME_SETTINGS_NAMESPACE = 'dsh-tui'

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
   * Disable the native `subagent` tool for every agent in the process, so
   * plain ad-hoc delegation goes through a registered agent definition
   * (`~/.dsh/agents/*.md` via `use_agent`) instead. Deliberately narrow:
   * `subagent_fork`, `workflow` and `ralph` stay available (they are not the
   * plain one-shot spawn the TUI's user wants fenced off).
   */
  disableSubagent: boolean
}

/**
 * Default subagent limits, applied whenever the settings service, namespace,
 * or a field cannot be read. 4 concurrent children and 75 rounds per child
 * are the documented out-of-the-box behavior (75 rounds = 75 LLM
 * round-trips, headroom for heavy delegated tasks while still capping a
 * runaway child); the native `subagent` tool is disabled by default — the
 * TUI's user delegates through registered agents (toggle it in /agents → l
 * limits when the plain tool is needed again).
 */
export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = Object.freeze({
  maxAgents: 4,
  maxRounds: 75,
  disableSubagent: true,
})

/** Schema of the `dsh-tui` settings section. */
const THEME_SETTINGS_SCHEMA = z.object({
  theme: z
    .union(['auto', 'light', 'dark'])
    .default('auto')
    .description('Terminal color scheme (applies immediately)'),
  panelHeight: z
    .union(['1', '5', '7', '10', 'all'])
    .default(DEFAULT_PANEL_HEIGHT)
    .description(
      "Think/tool panel height ('1' = one row: identifier + elapsed + last line, "
      + "right-truncated; '5'/'7'/'10' = boxed header + content rows, borders add 2 more; "
      + "'all' = full content — streaming reasoning shows a 200-line live tail, "
      + 'tool results cap at 2000 lines)',
    ),
  // `z.natural()` is schemastery's constraint for a non-negative integer
  // (the `z.number().int().min(0)` intent — no `.int()` chain exists here).
  maxAgents: z
    .natural()
    .default(DEFAULT_SUBAGENT_LIMITS.maxAgents)
    .description('Max concurrently running subagents (0 = unlimited)'),
  maxRounds: z
    .natural()
    .default(DEFAULT_SUBAGENT_LIMITS.maxRounds)
    .description('Max assistant messages per subagent before the TUI sends a summary request (0 = unlimited)'),
  disableSubagent: z
    .boolean()
    .default(DEFAULT_SUBAGENT_LIMITS.disableSubagent)
    .description(
      'Disable the native subagent tool (delegation goes through registered '
      + 'agents, ~/.dsh/agents/*.md via use_agent); subagent_fork/workflow/'
      + 'ralph stay available',
    ),
  footerHints: z
    .object({
      send: z.boolean().default(true).description('Show "Enter: send" in the footer hint bar'),
      stop: z.boolean().default(true).description('Show "Esc ×2: stop" in the footer hint bar'),
      quit: z.boolean().default(true).description('Show "Ctrl+C ×2: quit" in the footer hint bar'),
      quitEmpty: z.boolean().default(true).description('Show "Ctrl+D: quit (empty)" in the footer hint bar'),
      subagents: z.boolean().default(true).description('Show "Ctrl+G: subagents" in the footer hint bar'),
      search: z.boolean().default(true).description('Show "Ctrl+Shift+F: search" in the footer hint bar'),
      history: z.boolean().default(true).description('Show "↑↓: history" in the footer hint bar'),
    })
    .default({ ...DEFAULT_FOOTER_HINTS })
    .description('Footer shortcut hints to display (toggle each one on/off)'),
  iconSet: z
    .union(['auto', 'nerdfont', 'plain'])
    .default('auto')
    .description(
      "Icon set for the risky glyphs ('auto' = pick nerdfont when a Nerd Font "
      + "is detected at startup, plain otherwise; 'nerdfont' = powerline PUA "
      + 'glyphs (U+E0B0 separator, stop, heavy circle); plain = safe Unicode '
      + 'stand-ins (▸ ■ ●) — auto is the recommended default)',
    ),
  favoriteModels: z
    .array(z.string())
    .default([])
    .description('Favorite models (provider/id keys) pinned to the top of the /model picker'),
  hiddenModels: z
    .array(z.string())
    .default([])
    .description('Hidden models (provider/id keys) moved to the Hidden section of the /model picker'),
  // Plain z.number() (not z.natural()) on purpose: the settings service
  // validates the stored section against this schema at registration and
  // fails LOUD, so a range-constrained schema would let one hand-edited
  // out-of-range number take the whole dsh-tui namespace (theme, panel
  // height, everything) down with it. The per-field range check happens in
  // the readers (resolveRetentionConfig / resolveResumeConfig), which fall
  // back to env/defaults with one stderr line instead.
  retention: z
    .object({
      maxCount: z
        .number()
        .default(RETENTION_MAX_COUNT)
        .description(
          'Session log retention: keep at most this many sessions (<= 0 disables the janitor); '
          + 'outranks DSH_TUI_RETENTION_MAX_COUNT; applies at next startup',
        ),
      maxAgeDays: z
        .number()
        .default(RETENTION_MAX_AGE_DAYS)
        .description(
          'Session log retention: delete logs untouched for more than this many days (> 0); '
          + 'outranks DSH_TUI_RETENTION_MAX_AGE_DAYS; applies at next startup',
        ),
      minIdleHours: z
        .number()
        .default(RETENTION_MIN_IDLE_HOURS)
        .description(
          'Session log retention: count-rule-only idle guard in hours (>= 0); '
          + 'outranks DSH_TUI_RETENTION_MIN_IDLE_HOURS; applies at next startup',
        ),
    })
    .default({
      maxCount: RETENTION_MAX_COUNT,
      maxAgeDays: RETENTION_MAX_AGE_DAYS,
      minIdleHours: RETENTION_MIN_IDLE_HOURS,
    })
    .description('Startup session-log janitor for ~/.dsh/sessions (explicit values here outrank the DSH_TUI_RETENTION_* env vars)'),
  resume: z
    .object({
      maxAgeDays: z
        .number()
        .default(RESUME_MAX_AGE_DAYS)
        .description(
          'Resume picker: only sessions with log activity inside this window get a row (> 0); '
          + 'outranks DSH_TUI_RESUME_MAX_AGE_DAYS',
        ),
      minBytes: z
        .number()
        .default(RESUME_MIN_BYTES)
        .description(
          'Resume picker: minimum compressed log size for a row (>= 0); '
          + 'outranks DSH_TUI_RESUME_MIN_BYTES',
        ),
    })
    .default({ maxAgeDays: RESUME_MAX_AGE_DAYS, minBytes: RESUME_MIN_BYTES })
    .description('Resume picker display filter (explicit values here outrank the DSH_TUI_RESUME_* env vars)'),
})

/** Composition entry below the user layer: fall back to the defaults. */
const THEME_SETTINGS_ENTRY: {
  theme: ThemePreference
  panelHeight: PanelHeight
  maxAgents: number
  maxRounds: number
  disableSubagent: boolean
  footerHints: FooterHints
  iconSet: IconSet
  favoriteModels: string[]
  hiddenModels: string[]
  retention: { maxCount: number; maxAgeDays: number; minIdleHours: number }
  resume: { maxAgeDays: number; minBytes: number }
} = {
  theme: 'auto',
  panelHeight: DEFAULT_PANEL_HEIGHT,
  maxAgents: DEFAULT_SUBAGENT_LIMITS.maxAgents,
  maxRounds: DEFAULT_SUBAGENT_LIMITS.maxRounds,
  disableSubagent: DEFAULT_SUBAGENT_LIMITS.disableSubagent,
  footerHints: { ...DEFAULT_FOOTER_HINTS },
  iconSet: 'auto',
  favoriteModels: [],
  hiddenModels: [],
  retention: {
    maxCount: RETENTION_MAX_COUNT,
    maxAgeDays: RETENTION_MAX_AGE_DAYS,
    minIdleHours: RETENTION_MIN_IDLE_HOURS,
  },
  resume: { maxAgeDays: RESUME_MAX_AGE_DAYS, minBytes: RESUME_MIN_BYTES },
}

/**
 * In-flight namespace registration. The registration rides the settings
 * injection fiber, so a read issued right after `registerThemeSettings`
 * would not see the namespace yet; `readThemePreference` awaits this promise
 * (bounded) before describing. `undefined` until the first registration.
 */
let registrationPromise: Promise<void> | undefined

/**
 * Register the `dsh-tui` settings namespace with the settings provider.
 *
 * This registers directly through the provider (not through a
 * section-install helper): the registration rides the scoped injection fiber
 * and disappears with the settings service. `onPreferenceChange`, when given,
 * receives every committed change (including this TUI's own writes) through
 * the scope's watch hook; callers guard re-applies by theme-bundle identity
 * and height change, so an echoed self-write is a no-op. No source thunk is
 * needed — the read helpers read the resolved values on demand at TUI
 * startup.
 *
 * @param ctx - plugin context; does nothing while no settings service is mounted.
 * @param onPreferenceChange - hot-reload sink for committed `dsh-tui` theme,
 * panel-height, footer-hints and icon-set changes; `undefined` when the
 * namespace is already registered (a reloaded plugin instance, a second mount
 * of this bundle) or registration fails.
 */
export function registerThemeSettings(
  ctx: Context,
  onPreferenceChange?: (pref: ThemePreference, panelHeight: PanelHeight, footerHints: FooterHints, iconSet: IconSet) => void,
): void {
  registrationPromise = new Promise<void>(resolve => {
    ctx.inject(['settings'], (sctx) => {
      try {
        // The namespace may already be registered (a reloaded plugin instance,
        // a second mount of this bundle): `register` throws on duplicates, and
        // the existing registration already serves the same schema — skip.
        if (sctx.settings.describe().some((descriptor) => descriptor.ns === THEME_SETTINGS_NAMESPACE)) {
          resolve()
          return
        }
        const scope = sctx.settings.register(THEME_SETTINGS_NAMESPACE, THEME_SETTINGS_SCHEMA, {
          base: THEME_SETTINGS_ENTRY,
          // 'live': a committed change takes effect immediately — the TUI
          // hot-applies the theme bundle and the panel height via the watch
          // hook below. 'restart' was the old contract, when every component
          // baked its theme at startup.
          applies: 'live',
        })
        if (onPreferenceChange !== undefined) {
          scope.watch((next) => {
            // The resolved section is `{ theme: ..., panelHeight: ...,
            // footerHints: {...}, iconSet: ... }` — narrow the unknown to the
            // observed fields.
            const section = next as { theme?: unknown; panelHeight?: unknown; footerHints?: unknown; iconSet?: unknown }
            const theme = section.theme
            const panelHeight = section.panelHeight
            onPreferenceChange(
              theme === 'light' || theme === 'dark' ? theme : 'auto',
              isPanelHeight(panelHeight) ? panelHeight : DEFAULT_PANEL_HEIGHT,
              narrowFooterHints(section.footerHints),
              narrowIconSet(section.iconSet),
            )
          })
        }
      } catch (error) {
        // TUI startup awaits `registrationPromise` — it must settle no matter
        // what, so a failed registration degrades to 'auto' instead of
        // hanging. Leave a trace for the operator: this fires during
        // apply(), before the TUI's notice sink exists, so the message goes
        // through the shared bridge and surfaces above the footer once the
        // first frame lands (never raw stderr — the alt-screen owns the
        // terminal by then).
        emitNotice(
          `settings namespace registration failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      resolve()
    })
  })
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

/**
 * The `dsh-tui` namespace descriptor, after waiting for the in-flight
 * registration — the shared plumbing of every async reader below.
 *
 * The registration is delivered through the settings injection fiber, so the
 * value may not be visible synchronously right after `registerThemeSettings`:
 * the settings service mounts asynchronously (its init sets up the provider,
 * a file watcher, ...), a tick after the registration request in the dsh
 * profile. Wait for the registration to land before describing — bounded, so
 * a settings-less deployment degrades to the defaults instead of hanging TUI
 * startup. Without a registration request there is nothing to wait for.
 *
 * @returns the descriptor, or `undefined` when no registration is in
 * flight, the settings service is absent, or the namespace has not landed.
 */
async function registeredDescriptor(ctx: Context): Promise<SettingsDescriptor | undefined> {
  if (registrationPromise === undefined) return undefined
  let fallback: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    registrationPromise,
    new Promise<void>(resolve => { fallback = setTimeout(resolve, 2000) }),
  ])
  if (fallback !== undefined) clearTimeout(fallback)
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) return undefined
  return settings.describe().find((descriptor) => descriptor.ns === THEME_SETTINGS_NAMESPACE)
}

/**
 * The resolved `dsh-tui` section as read from the settings provider, after
 * waiting for the in-flight registration (see `registeredDescriptor`).
 *
 * @returns the resolved section, or `undefined` when no registration is in
 * flight, the settings service is absent, or the namespace has not landed.
 */
async function readResolvedSection(ctx: Context): Promise<{
  theme?: unknown
  panelHeight?: unknown
  footerHints?: unknown
  iconSet?: unknown
  favoriteModels?: unknown
  hiddenModels?: unknown
} | undefined> {
  // The descriptor's `value` is the whole resolved section
  // (`{ theme: ..., panelHeight: ..., footerHints: {...}, iconSet: ... }`), not
  // the field itself — narrow the unknown to the observed fields.
  return (await registeredDescriptor(ctx))?.value as
    | {
        theme?: unknown
        panelHeight?: unknown
        footerHints?: unknown
        iconSet?: unknown
        favoriteModels?: unknown
        hiddenModels?: unknown
      }
    | undefined
}

/**
 * Read the persisted theme preference (the startup snapshot).
 *
 * @param ctx - plugin context.
 * @returns the resolved `dsh-tui` theme value, or `'auto'` when the settings
 * service is absent or the namespace/value cannot be read.
 */
export async function readThemePreference(ctx: Context): Promise<ThemePreference> {
  const pref = (await readResolvedSection(ctx))?.theme
  if (pref === 'light' || pref === 'dark') return pref
  return 'auto'
}

/**
 * Read the persisted think/tool panel height (the startup snapshot).
 *
 * @param ctx - plugin context.
 * @returns the resolved `dsh-tui` panelHeight value, or DEFAULT_PANEL_HEIGHT
 * when the settings service is absent or the namespace/value cannot be read.
 */
export async function readPanelHeightPreference(ctx: Context): Promise<PanelHeight> {
  const height = (await readResolvedSection(ctx))?.panelHeight
  if (isPanelHeight(height)) return height
  return DEFAULT_PANEL_HEIGHT
}

/**
 * Read the persisted footer-hint selection (the startup snapshot).
 *
 * @param ctx - plugin context.
 * @returns the resolved `dsh-tui` footerHints object, or DEFAULT_FOOTER_HINTS
 * when the settings service is absent or the namespace/value cannot be read.
 */
export async function readFooterHintsPreference(ctx: Context): Promise<FooterHints> {
  return narrowFooterHints((await readResolvedSection(ctx))?.footerHints)
}

/**
 * Read the persisted icon-set mode (the startup snapshot).
 *
 * @param ctx - plugin context.
 * @returns the resolved `dsh-tui` iconSet value, or `'auto'` when the settings
 * service is absent or the namespace/value cannot be read.
 */
export async function readIconSetPreference(ctx: Context): Promise<IconSet> {
  return narrowIconSet((await readResolvedSection(ctx))?.iconSet)
}

/**
 * Explicit session-management overrides as the user wrote them in
 * settings.yaml — the raw `user` layer of the descriptor, NOT the resolved
 * value. This distinction is the precedence seam: the resolved value bakes
 * the schema defaults in (a missing `retention.maxCount` resolves to 100),
 * so reading it would make the defaults outrank the DSH_TUI_RETENTION and
 * DSH_TUI_RESUME environment variables; only a
 * field PRESENT in the user layer is an explicit override
 * (`settings.yaml explicit > env > default`, honored by
 * `resolveRetentionConfig` / `resolveResumeConfig`). Fields stay `unknown`
 * — a hand-edited document can carry anything, and the resolvers narrow
 * per field with one stderr line on garbage.
 */
export interface SessionManagementExplicit {
  retention?: { maxCount?: unknown; maxAgeDays?: unknown; minIdleHours?: unknown }
  resume?: { maxAgeDays?: unknown; minBytes?: unknown }
}

/**
 * Read the explicit `dsh-tui.retention` / `dsh-tui.resume` sections from
 * the settings document's user layer (see `SessionManagementExplicit`).
 * Awaits the namespace registration bounded (same plumbing as the theme
 * readers), so the startup retention pass can call it without hanging a
 * settings-less deployment.
 *
 * @returns ALWAYS the two-key shape — a section absent from the user
 * layer (or the whole service/namespace missing) reads as
 * `{ retention: undefined, resume: undefined }`, never a bare
 * `undefined`, so callers destructure one stable shape. "Nothing
 * explicitly configured" (env/defaults govern) and "nothing to read at
 * all" are the same outcome for every consumer.
 */
export async function readSessionManagementExplicit(
  ctx: Context,
): Promise<SessionManagementExplicit> {
  const user = (await registeredDescriptor(ctx))?.user
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
 * Read the currently persisted footer-hint selection, synchronously.
 * Unlike `readFooterHintsPreference` (the startup snapshot), this does not
 * wait for the namespace registration - it describes whatever the settings
 * service exposes right now, so a caller can honor a live change immediately.
 * @returns DEFAULT_FOOTER_HINTS when the service, namespace, or value is absent.
 */
export function currentFooterHints(ctx: Context): FooterHints {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) return { ...DEFAULT_FOOTER_HINTS }
  const hints = (settings
    .describe()
    .find((descriptor) => descriptor.ns === THEME_SETTINGS_NAMESPACE)?.value as
    | { footerHints?: unknown }
    | undefined)?.footerHints
  return narrowFooterHints(hints)
}

/**
 * Read the currently persisted theme preference, synchronously.
 * Unlike `readThemePreference` (the startup snapshot), this does not wait for
 * the namespace registration — it describes whatever the settings service
 * exposes right now, so the `/theme` picker preselects the live value, which
 * may have changed since startup (e.g. through the /settings browser).
 * @returns 'auto' when the service, namespace, or value cannot be read.
 */
export function currentThemePreference(ctx: Context): ThemePreference {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) return 'auto'
  const pref = (settings
    .describe()
    .find((descriptor) => descriptor.ns === THEME_SETTINGS_NAMESPACE)?.value as
    | { theme?: unknown }
    | undefined)?.theme
  if (pref === 'light' || pref === 'dark') return pref
  return 'auto'
}

/**
 * Persist one `dsh-tui` preference (theme, panelHeight, or a subagent limit)
 * to the settings namespace. The namespace is `applies: 'live'`, so the
 * commit (observed through the registration's watch hook) hot-applies the
 * change to the running TUI. Best-effort: a deployment without a settings
 * provider reports the failure; a failed write returns its error message for
 * the caller to surface. A concurrent writer moving the namespace rejects
 * with `SettingsConflictError` — retried once against a fresh revision; a
 * second conflict surfaces a friendly message instead of the raw error.
 * @returns undefined on success, the failure message otherwise.
 */
async function writeDshTuiPreference(
  ctx: Context,
  key: 'theme' | 'panelHeight' | 'maxAgents' | 'maxRounds' | 'disableSubagent'
    | 'favoriteModels' | 'hiddenModels',
  value: string | number | boolean | string[],
): Promise<string | undefined> {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) return 'Settings service is not available.'
  // The descriptor carries the namespace's revision (optimistic-concurrency
  // token for mutate) and proves the schema registration that validates the
  // path below; the write rejects when the namespace is unregistered.
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
 * Persist the theme preference to the `dsh-tui` settings namespace. The
 * namespace is `applies: 'live'`, so the commit (observed through the
 * registration's watch hook) hot-applies the change to the running TUI.
 * @returns undefined on success, the failure message otherwise.
 */
export async function writeThemePreference(ctx: Context, pref: ThemePreference): Promise<string | undefined> {
  return writeDshTuiPreference(ctx, 'theme', pref)
}

/**
 * Read the currently resolved subagent limits, synchronously. Unlike the
 * startup-snapshot readers, this does not wait for the namespace registration
 * — it describes whatever the settings service exposes right now, so every
 * policy decision (the guard at each spawn, `onRoundCount` at each child
 * assistant message)
 * reflects the latest committed value without a watcher. Missing settings
 * service or namespace, or a non-integer/negative field, degrades to the
 * defaults — a settings-less deployment keeps the documented caps.
 */
export function readSubagentLimits(ctx: Context): SubagentLimits {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) return { ...DEFAULT_SUBAGENT_LIMITS }
  // The descriptor's `value` is the whole resolved section
  // (`{ theme: ..., panelHeight: ..., maxAgents: ..., maxRounds: ...,
  // disableSubagent: ... }`) — narrow the unknown to the observed fields.
  const section = settings
    .describe()
    .find((descriptor) => descriptor.ns === THEME_SETTINGS_NAMESPACE)?.value as
    | { maxAgents?: unknown; maxRounds?: unknown; disableSubagent?: unknown }
    | undefined
  const natural = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
  return {
    maxAgents: natural(section?.maxAgents, DEFAULT_SUBAGENT_LIMITS.maxAgents),
    maxRounds: natural(section?.maxRounds, DEFAULT_SUBAGENT_LIMITS.maxRounds),
    disableSubagent: typeof section?.disableSubagent === 'boolean'
      ? section.disableSubagent
      : DEFAULT_SUBAGENT_LIMITS.disableSubagent,
  }
}

/**
 * Persist one subagent policy knob (maxAgents, maxRounds, or disableSubagent)
 * to the `dsh-tui` settings namespace. The namespace is `applies: 'live'`, so
 * the commit hot-applies without a restart — the policy reads
 * `readSubagentLimits` at the next decision point. Never throws: a deployment
 * without the settings provider, or an unregistered namespace, surfaces a
 * failure message for the caller.
 * @returns undefined on success, the failure message otherwise.
 */
export async function writeSubagentLimit(
  ctx: Context,
  key: 'maxAgents' | 'maxRounds' | 'disableSubagent',
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
 * Read the persisted model favorites/hiddens (the startup snapshot). Both
 * lists narrow through `narrowStringList` — a malformed or missing field
 * degrades to an empty list.
 */
export async function readModelPrefs(ctx: Context): Promise<ModelPrefs> {
  const section = await readResolvedSection(ctx)
  return {
    favoriteModels: narrowStringList(section?.favoriteModels),
    hiddenModels: narrowStringList(section?.hiddenModels),
  }
}

/**
 * Persist one model pref list (favoriteModels or hiddenModels) to the
 * `dsh-tui` settings namespace via `settings.mutate` (optimistic concurrency,
 * one retry on `SettingsConflictError`) — never a whole-file rewrite. The
 * caller invokes this on every f/h toggle, so each press lands immediately.
 * Best-effort: a deployment without the settings provider surfaces the
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
