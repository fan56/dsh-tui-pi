/**
 * UI string runtime: `t(key, params)` resolves the active language's text
 * for a flat dot-namespaced key, falling back per key to the bundled English
 * catalog and finally to the key itself (so an un-translated call site is
 * visible instead of rendering `undefined`).
 *
 * Language files are discovered by ./registry.ts (bundled `locales/` merged
 * with the user's `$DSH_HOME/locales`). The active language is the
 * `dsh-tui.language` setting: read once at TUI startup, and re-applied live
 * through the settings watch hook — `t()` reads the current module state on
 * every call, so the next repaint speaks the new language (already-rendered
 * transcript rows rebuild on the next resize, matching the theme hot-swap
 * behavior).
 *
 * The English catalog is ALSO the out-of-the-box behavior: every extracted
 * call site's English text must live in `locales/en.json` byte-identical to
 * the pre-i18n literal (the test suite greps `t('…')` call sites against
 * en.json). Tests that render components without booting the TUI therefore
 * still see the original English — en.json loads lazily here on the first
 * `t()`, no init required.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  builtinLocalesDir,
  discoverLocales,
  parseLocaleFile,
  type LocaleStrings,
} from './registry.ts'

/** Discovered languages (bundled ∪ user, user wins per key). Populated lazily. */
let discovered: Map<string, LocaleStrings> | undefined

/** The active language. Starts as the en fallback with no translations. */
let current: LocaleStrings = { id: 'en', name: 'English', strings: {} }

/** Lazily-parsed bundled en.json — the per-key fallback catalog. */
let enFallbackStrings: Record<string, string> | undefined

function enFallback(): Record<string, string> {
  if (enFallbackStrings === undefined) {
    enFallbackStrings = {}
    try {
      const raw = readFileSync(join(builtinLocalesDir(), 'en.json'), 'utf8')
      enFallbackStrings = parseLocaleFile(raw, join(builtinLocalesDir(), 'en.json')).strings
    } catch {
      // Missing/invalid en.json: t() degrades to the key itself (fail-open).
    }
  }
  return enFallbackStrings
}

function localeMap(): Map<string, LocaleStrings> {
  if (discovered === undefined) discovered = discoverLocales()
  return discovered
}

/**
 * Initialize the i18n runtime at TUI startup: discover language files and
 * activate `id`. Called once from apply() with the persisted
 * `dsh-tui.language` value; an unknown id degrades to `en`.
 * @param opts.warn - discovery skip reporter (defaults to console.warn).
 */
export function initI18n(opts?: { home?: string; id?: string; warn?: (msg: string) => void }): void {
  discovered = discoverLocales({ home: opts?.home, warn: opts?.warn })
  activate(opts?.id ?? 'en')
}

/** The active locale (id + display name). */
export function currentLocale(): { id: string; name: string } {
  return { id: current.id, name: current.name }
}

/** All discovered languages, id-sorted — for the /language listing. */
export function listLocales(): ReadonlyArray<{ id: string; name: string }> {
  return [...localeMap().values()]
    .map(locale => ({ id: locale.id, name: locale.name }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Activate one discovered language. Unknown ids keep the current language.
 * @returns true when the language exists and is now active.
 */
export function setLocale(id: string): boolean {
  return activate(id)
}

function activate(id: string): boolean {
  const locale = localeMap().get(id)
  if (locale === undefined) return false
  current = locale
  return true
}

/**
 * Translate one UI string. Resolution order: active language → bundled
 * English → the key itself. `{param}` placeholders are replaced from
 * `params`; a parameter with no entry stays visible as `{param}` (a missing
 * param is a programming error the rendered output exposes).
 */
export function t(key: string, params?: Readonly<Record<string, string | number>>): string {
  const text = current.strings[key] ?? enFallback()[key] ?? key
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}
