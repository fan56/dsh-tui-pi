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
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  SettingsConflictError,
  settingsNamespace,
  type SettingsNamespace,
  type SettingsPathOp,
  type SettingsProvider,
} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_FOOTER_HINTS, type FooterHints } from './footer.ts'
import { DEFAULT_PANEL_HEIGHT, type PanelHeight } from './messages.ts'
import type { ThemePreference } from './theme/index.ts'

/** Settings namespace carrying the persisted dsh-tui preferences. */
export const THEME_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('dsh-tui')

/** Subagent concurrency/rounds/roster knobs read by the subagent policy. */
export interface SubagentLimits {
  /** Concurrent live children allowed; 0 lifts the cap (the guard stays off). */
  maxAgents: number
  /** Completed turns per child before a summary request is injected; 0 disables. */
  maxRounds: number
  /**
   * Only registered agents (the dsh-subagent-registry `use_agent` roster,
   * `~/.dsh/agents/*.md`) may be spawned. The native ad-hoc spawn tools
   * (`subagent`, `subagent_fork`, `workflow`, `ralph`) are denied for every
   * agent in the process, so delegation always goes through a registered
   * definition.
   */
  registeredOnly: boolean
}

/**
 * Default subagent limits, applied whenever the settings service, namespace,
 * or a field cannot be read. 4 concurrent children and 50 rounds per child are
 * the documented out-of-the-box behavior; registeredOnly is on by default —
 * this TUI's user runs the registry plugin and wants ad-hoc spawns fenced off
 * (toggle it in /settings → dsh-tui when a workflow/ralph fan-out is
 * genuinely needed).
 */
export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = Object.freeze({
  maxAgents: 4,
  maxRounds: 50,
  registeredOnly: true,
})

/** Schema of the `dsh-tui` settings section. */
const THEME_SETTINGS_SCHEMA = z.object({
  theme: z
    .union(['auto', 'light', 'dark'])
    .default('auto')
    .description('Terminal color scheme (applies immediately)'),
  panelHeight: z
    .union(['5', '7', '10', 'all'])
    .default(DEFAULT_PANEL_HEIGHT)
    .description(
      "Think/tool panel height in displayed rows ('5'/'7'/'10' — header + content lines; "
      + "box borders add 2 more) or 'all' to print the full content — a streaming "
      + 'reasoning panel shows a 200-line live tail and tool results cap at 2000 lines',
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
    .description('Max rounds per subagent before the TUI sends a summary request (0 = unlimited)'),
  registeredOnly: z
    .boolean()
    .default(DEFAULT_SUBAGENT_LIMITS.registeredOnly)
    .description(
      'Only registered agents (~/.dsh/agents/*.md via use_agent) may spawn - '
      + 'the native subagent/subagent_fork/workflow/ralph tools are denied '
      + 'and hidden from the main agent (hide is per-session; the deny applies '
      + 'immediately)',
    ),
  footerHints: z
    .object({
      send: z.boolean().default(true).description('Show "Enter: send" in the footer hint bar'),
      stop: z.boolean().default(true).description('Show "Esc ×2: stop" in the footer hint bar'),
      quit: z.boolean().default(true).description('Show "Ctrl+C ×2: quit" in the footer hint bar'),
      quitEmpty: z.boolean().default(true).description('Show "Ctrl+D: quit (empty)" in the footer hint bar'),
      subagents: z.boolean().default(true).description('Show "Ctrl+G: subagents" in the footer hint bar'),
      history: z.boolean().default(true).description('Show "↑↓: history" in the footer hint bar'),
    })
    .default({ ...DEFAULT_FOOTER_HINTS })
    .description('Footer shortcut hints to display (toggle each one on/off)'),
})

/** Composition entry below the user layer: fall back to the defaults. */
const THEME_SETTINGS_ENTRY: {
  theme: ThemePreference
  panelHeight: PanelHeight
  maxAgents: number
  maxRounds: number
  registeredOnly: boolean
  footerHints: FooterHints
} = {
  theme: 'auto',
  panelHeight: DEFAULT_PANEL_HEIGHT,
  maxAgents: DEFAULT_SUBAGENT_LIMITS.maxAgents,
  maxRounds: DEFAULT_SUBAGENT_LIMITS.maxRounds,
  registeredOnly: DEFAULT_SUBAGENT_LIMITS.registeredOnly,
  footerHints: { ...DEFAULT_FOOTER_HINTS },
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
 * `installSettingsSection` cannot express the `applies` marker (its hooks
 * carry no options, and the registration's applies is fixed at `register`
 * time), so this registers directly through the provider, mirroring that
 * helper's wiring: the registration rides the scoped injection fiber and
 * disappears with the settings service. `onPreferenceChange`, when given,
 * receives every committed change (including this TUI's own writes) through
 * the scope's watch hook; callers guard re-applies by theme-bundle identity
 * and height change, so an echoed self-write is a no-op. No source thunk is
 * needed — the read helpers read the resolved values on demand at TUI
 * startup.
 *
 * @param ctx - plugin context; does nothing while no settings service is mounted.
 * @param onPreferenceChange - hot-reload sink for committed `dsh-tui` theme,
 * panel-height and footer-hints changes; `undefined` when the namespace is
 * already registered (a reloaded plugin instance, a second mount of this
 * bundle) or registration fails.
 */
export function registerThemeSettings(
  ctx: Context,
  onPreferenceChange?: (pref: ThemePreference, panelHeight: PanelHeight, footerHints: FooterHints) => void,
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
            // footerHints: {...} }` — narrow the unknown to the observed fields.
            const section = next as { theme?: unknown; panelHeight?: unknown; footerHints?: unknown }
            const theme = section.theme
            const panelHeight = section.panelHeight
            onPreferenceChange(
              theme === 'light' || theme === 'dark' ? theme : 'auto',
              panelHeight === '7' || panelHeight === '10' || panelHeight === 'all' ? panelHeight : DEFAULT_PANEL_HEIGHT,
              narrowFooterHints(section.footerHints),
            )
          })
        }
      } catch (error) {
        // TUI startup awaits `registrationPromise` — it must settle no matter
        // what, so a failed registration degrades to 'auto' instead of
        // hanging. Leave a trace for operators.
        console.warn(
          `[dsh-tui-pi] settings namespace registration failed: ${error instanceof Error ? error.message : String(error)}`,
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

/**
 * The resolved `dsh-tui` section as read from the settings provider, after
 * waiting for the in-flight registration.
 *
 * The registration is delivered through the settings injection fiber, so the
 * value may not be visible synchronously right after `registerThemeSettings`:
 * the settings service mounts asynchronously (its init sets up the provider,
 * a file watcher, ...), a tick after the registration request in the dsh
 * profile. Wait for the registration to land before describing — bounded, so
 * a settings-less deployment degrades to the defaults instead of hanging TUI
 * startup. Without a registration request there is nothing to wait for.
 *
 * @returns the resolved section, or `undefined` when no registration is in
 * flight, the settings service is absent, or the namespace has not landed.
 */
async function readResolvedSection(ctx: Context): Promise<{ theme?: unknown; panelHeight?: unknown; footerHints?: unknown } | undefined> {
  if (registrationPromise === undefined) return undefined
  let fallback: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    registrationPromise,
    new Promise<void>(resolve => { fallback = setTimeout(resolve, 2000) }),
  ])
  if (fallback !== undefined) clearTimeout(fallback)
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) return undefined
  // The descriptor's `value` is the whole resolved section
  // (`{ theme: ..., panelHeight: ..., footerHints: {...} }`), not the field
  // itself — narrow the unknown to the three observed fields.
  return settings
    .describe()
    .find((descriptor) => descriptor.ns === THEME_SETTINGS_NAMESPACE)?.value as
    | { theme?: unknown; panelHeight?: unknown; footerHints?: unknown }
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
  if (height === '7' || height === '10' || height === 'all') return height
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
  key: 'theme' | 'panelHeight' | 'maxAgents' | 'maxRounds',
  value: string | number,
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
 * policy decision (the guard at each spawn, `onTurnCount` at each child turn)
 * reflects the latest committed value without a watcher. Missing settings
 * service or namespace, or a non-integer/negative field, degrades to the
 * defaults — a settings-less deployment keeps the documented caps.
 */
export function readSubagentLimits(ctx: Context): SubagentLimits {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) return { ...DEFAULT_SUBAGENT_LIMITS }
  // The descriptor's `value` is the whole resolved section
  // (`{ theme: ..., panelHeight: ..., maxAgents: ..., maxRounds: ...,
  // registeredOnly: ... }`) — narrow the unknown to the observed fields.
  const section = settings
    .describe()
    .find((descriptor) => descriptor.ns === THEME_SETTINGS_NAMESPACE)?.value as
    | { maxAgents?: unknown; maxRounds?: unknown; registeredOnly?: unknown }
    | undefined
  const natural = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
  return {
    maxAgents: natural(section?.maxAgents, DEFAULT_SUBAGENT_LIMITS.maxAgents),
    maxRounds: natural(section?.maxRounds, DEFAULT_SUBAGENT_LIMITS.maxRounds),
    registeredOnly: typeof section?.registeredOnly === 'boolean'
      ? section.registeredOnly
      : DEFAULT_SUBAGENT_LIMITS.registeredOnly,
  }
}

/**
 * Persist one subagent limit (maxAgents or maxRounds) to the `dsh-tui`
 * settings namespace. The namespace is `applies: 'live'`, so the commit
 * hot-applies without a restart — the policy reads `readSubagentLimits` at
 * the next decision point. Never throws: a deployment without the settings
 * provider, or an unregistered namespace, surfaces a failure message for the
 * caller.
 * @returns undefined on success, the failure message otherwise.
 */
export async function writeSubagentLimit(
  ctx: Context,
  key: 'maxAgents' | 'maxRounds',
  value: number,
): Promise<string | undefined> {
  return writeDshTuiPreference(ctx, key, value)
}
