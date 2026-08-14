/**
 * Theme settings: persists the user's theme preference under the `dsh-tui`
 * settings namespace, surfaced by the /settings browser and the /theme
 * command. The preference is read once at TUI startup
 * (`readThemePreference`); the namespace is marked `applies: 'restart'`
 * because every component holds the theme bundle built at startup, so a
 * change cannot take effect in a running session.
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
import type { ThemePreference } from './theme/index.ts'

/** Settings namespace carrying the persisted theme preference. */
export const THEME_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('dsh-tui')

/** Schema of the `dsh-tui` settings section. */
const THEME_SETTINGS_SCHEMA = z.object({
  theme: z
    .union(['auto', 'light', 'dark'])
    .default('auto')
    .description('Terminal color scheme (applies after restart)'),
})

/** Composition entry below the user layer: fall back to terminal detection. */
const THEME_SETTINGS_ENTRY: { theme: ThemePreference } = { theme: 'auto' }

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
 * `installSettingsSection` cannot express the `applies: 'restart'` marker
 * (its hooks carry no options, and the registration's applies is fixed at
 * `register` time), so this registers directly through the provider,
 * mirroring that helper's wiring: the registration rides the scoped
 * injection fiber and disappears with the settings service. No source thunk
 * or change hook is needed — `readThemePreference` reads the resolved value
 * on demand at TUI startup.
 *
 * @param ctx - plugin context; does nothing while no settings service is mounted.
 */
export function registerThemeSettings(ctx: Context): void {
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
        sctx.settings.register(THEME_SETTINGS_NAMESPACE, THEME_SETTINGS_SCHEMA, {
          base: THEME_SETTINGS_ENTRY,
          applies: 'restart',
        })
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

/**
 * Read the persisted theme preference.
 *
 * The registration is delivered through the settings injection fiber, so the
 * value may not be visible synchronously right after `registerThemeSettings`:
 * the settings service mounts asynchronously (its init sets up the provider,
 * a file watcher, ...), a tick after the registration request in the dsh
 * profile. Wait for the registration to land before describing — bounded, so
 * a settings-less deployment degrades to `'auto'` instead of hanging TUI
 * startup. Without a registration request there is nothing to wait for —
 * return `'auto'` immediately.
 *
 * @param ctx - plugin context.
 * @returns the resolved `dsh-tui` theme value, or `'auto'` when the settings
 * service is absent or the namespace/value cannot be read.
 */
export async function readThemePreference(ctx: Context): Promise<ThemePreference> {
  // No registration in flight and no settings service: nothing can ever
  // appear — degrade without waiting (a settings-less deployment must not
  // stall startup). With a registration in flight the settings service may
  // still be mounting; the race below resolves as soon as it lands.
  if (registrationPromise === undefined) return 'auto'
  let fallback: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    registrationPromise,
    new Promise<void>(resolve => { fallback = setTimeout(resolve, 2000) }),
  ])
  if (fallback !== undefined) clearTimeout(fallback)
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) return 'auto'
  // The descriptor's `value` is the whole resolved section (`{ theme: ... }`),
  // not the theme itself — narrow the unknown to the field we read.
  const pref = (settings
    .describe()
    .find((descriptor) => descriptor.ns === THEME_SETTINGS_NAMESPACE)?.value as
    | { theme?: unknown }
    | undefined)?.theme
  if (pref === 'light' || pref === 'dark') return pref
  return 'auto'
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
 * Persist the theme preference to the `dsh-tui` settings namespace (effective
 * after restart, matching the namespace's `applies: 'restart'` marker).
 * Best-effort: a deployment without a settings provider reports the failure;
 * a failed write returns its error message for the caller to surface. A
 * concurrent writer moving the namespace rejects with `SettingsConflictError`
 * — retried once against a fresh revision; a second conflict surfaces a
 * friendly message instead of the raw error.
 * @returns undefined on success, the failure message otherwise.
 */
export async function writeThemePreference(ctx: Context, pref: ThemePreference): Promise<string | undefined> {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) return 'Settings service is not available.'
  // The descriptor carries the namespace's revision (optimistic-concurrency
  // token for mutate) and proves the schema registration that validates the
  // path below; the write rejects when the namespace is unregistered.
  const ops: SettingsPathOp[] = [{ op: 'set', path: ['theme'], value: pref }]
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
