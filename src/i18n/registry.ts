/**
 * Locale file registry: discovers UI-language files from the npm-bundled
 * `locales/` directory and the user's `$DSH_HOME/locales` directory, parses
 * and validates each `*.json` file, and merges them into one registry keyed
 * by locale id (the filename without `.json`, e.g. `en`, `zh-CN`).
 *
 * Adding a language is exactly one JSON file: `ko.json` in `locales/` (or the
 * user's `$DSH_HOME/locales/`) with a `name` and one flat `key: string` entry
 * per translatable string. No code changes.
 *
 * JSON contract (a language file):
 * - required: `name` — the display name in that language (e.g. `"简体中文"`),
 *   shown by the /language command and the /settings browser.
 * - every other entry: a non-empty string, flat dot-namespaced key → text.
 *   `{param}` placeholders in the value are interpolated by `t()`; a
 *   translation must carry the same `{param}` set as its `en` twin (enforced
 *   by the test suite, not here — the registry stays format-only).
 * - any other value shape (number, nested object, empty string) rejects the
 *   whole file with the offending key in the error — strictness is the point:
 *   a hand-edited file with one typo must not half-load.
 *
 * Merge semantics: a user file whose id matches a bundled file merges
 * per-key OVER the bundled one (a user fixing three strings keeps the rest
 * of the language), and a user file with a new id registers a new language.
 * Invalid files are skipped with a `warn` line (fail-open), mirroring the
 * theme registry.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One parsed language file: the id, its display name, and the key → text map. */
export interface LocaleStrings {
  id: string
  name: string
  strings: Record<string, string>
}

/** Default $DSH_HOME (mirrors theme/registry.ts's local helper — kept local to avoid a business-module dependency here). */
function defaultDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** npm-bundled locales dir (repo-root `locales/`; resolves up from lib/ at runtime). */
export function builtinLocalesDir(): string {
  // Compiled: lib/i18n/registry.js → ../.. = package root. From src/ the
  // same two hops land on the repo root too.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'locales')
}

/** User locales dir: `$DSH_HOME/locales` (home is the dshHome() result). */
export function userLocalesDir(home: string): string {
  return join(home, 'locales')
}

/**
 * Parse + validate one locale JSON file into its `name` and flat string map.
 * Throws an `Error` carrying the `source` path and the offending key on any
 * invalid input (see the JSON contract in the module header).
 */
export function parseLocaleFile(raw: string, source: string): { name: string; strings: Record<string, string> } {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${source}: invalid locale JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${source}: locale file must be a JSON object`)
  }
  const input = data as Record<string, unknown>

  const name = input['name']
  if (typeof name !== 'string' || name === '') {
    throw new Error(`${source}: locale "name" must be a non-empty string`)
  }

  const strings: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === 'name') continue
    if (typeof value !== 'string' || value === '') {
      throw new Error(`${source}: locale key "${key}" must be a non-empty string`)
    }
    strings[key] = value
  }
  return { name, strings }
}

/**
 * Scan one directory for `*.json` locale files, keyed by file id (filename
 * minus `.json`). Invalid files are skipped with a `warn` line (fail-open);
 * a missing/unreadable directory yields an empty Map (never throws).
 */
export function scanLocaleDir(dir: string, warn?: (msg: string) => void): Map<string, LocaleStrings> {
  const locales = new Map<string, LocaleStrings>()
  let files: string[]
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => join(dir, entry.name))
  } catch {
    // Missing/unreadable directory: nothing to register (fail-open).
    return locales
  }
  for (const file of files) {
    const id = file.slice(dir.length + 1, -'.json'.length)
    try {
      const { name, strings } = parseLocaleFile(readFileSync(file, 'utf8'), file)
      locales.set(id, { id, name, strings })
    } catch (error) {
      warn?.(`locale registry: skipping ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return locales
}

/**
 * Merge-register all discoverable locales: the bundled `locales/` directory
 * first, then the user's `$DSH_HOME/locales` — a user file whose id matches
 * a bundled one merges per-key over it (user strings win), and a user file
 * with a new id registers a new language.
 *
 * @param opts.home - the dsh home (defaults to `$DSH_HOME` or `~/.dsh`).
 * @param opts.warn - per-file skip reporter (invalid locales are fail-open).
 */
export function discoverLocales(opts?: { home?: string; warn?: (msg: string) => void }): Map<string, LocaleStrings> {
  const registry = new Map<string, LocaleStrings>()
  for (const [id, locale] of scanLocaleDir(builtinLocalesDir(), opts?.warn)) {
    registry.set(id, locale)
  }
  for (const [id, user] of scanLocaleDir(userLocalesDir(opts?.home ?? defaultDshHome()), opts?.warn)) {
    const bundled = registry.get(id)
    registry.set(id, bundled === undefined
      ? user
      : { id, name: user.name, strings: { ...bundled.strings, ...user.strings } })
  }
  return registry
}
