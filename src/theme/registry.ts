/**
 * Theme file registry: discovers themes from the npm-bundled `themes/`
 * directory and the user's `$DSH_HOME/themes` directory, parses+validates
 * each `*.json` theme file into a full `Palette`, and merges them into one
 * registry keyed by theme id. The user directory wins over the bundled
 * themes on name collisions, and the two hard-coded GitHub palettes always
 * win over a bundled JSON of the same name (their exact values are
 * load-bearing — the e2e suite asserts the canvas RGB).
 *
 * JSON contract (a user-writable theme file):
 * - required: `name` (string, the theme id), `dark` (boolean), and 13 hex
 *   colors (`#rrggbb`, six hex digits): `canvas` `canvasSubtle` `canvasInset`
 *   `fgDefault` `fgMuted` `fgSubtle` `borderDefault` `borderMuted` `accent`
 *   `success` `danger` `attention` `thinking`.
 * - optional (derived when absent): `accentMuted`, `successMuted`,
 *   `dangerMuted`, `attentionMuted`, `thinkingPanelBg`, `toolPanelBg`,
 *   `panelBorder`, `panelBoxBorder` — see `deriveDefault`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blend, githubDark, githubLight, type Palette } from './palette.ts'

/** #rrggbb hex matcher — same shape as palette.ts's internal HEX6. */
const HEX6 = /^#[0-9a-fA-F]{6}$/

/** The 13 required color fields of a user theme file. */
const REQUIRED_COLORS = [
  'canvas', 'canvasSubtle', 'canvasInset',
  'fgDefault', 'fgMuted', 'fgSubtle',
  'borderDefault', 'borderMuted',
  'accent', 'success', 'danger', 'attention', 'thinking',
] as const

/** True when `value` is a #rrggbb hex string. */
function isHex(value: unknown): value is string {
  return typeof value === 'string' && HEX6.test(value)
}

/** Default $DSH_HOME (mirrors append-system.ts's dshHome — kept local to avoid a business-module dependency here). */
function defaultDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** npm-bundled themes dir (repo-root `themes/`; resolves up from lib/ at runtime). */
export function builtinThemesDir(): string {
  // Compiled: lib/theme/registry.js → ../.. = package root. From src/ the
  // same two hops land on the repo root too.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'themes')
}

/** User themes dir: `$DSH_HOME/themes` (home is the dshHome() result). */
export function userThemesDir(home: string): string {
  return join(home, 'themes')
}

/** Derive the optional-field default for one field (see the JSON contract). */
function deriveDefault(
  field: string,
  dark: boolean,
  canvas: string,
  accent: string,
  colors: Readonly<Record<string, string>>,
  derived: ReadonlyMap<string, string>,
): string {
  switch (field) {
    case 'accentMuted':
      return dark ? blend(canvas, accent, 0.25) : blend(canvas, accent, 0.18)
    case 'successMuted':
      return blend(canvas, colors['success']!, 0.25)
    case 'dangerMuted':
      return blend(canvas, colors['danger']!, 0.25)
    case 'attentionMuted':
      return blend(canvas, colors['attention']!, 0.25)
    case 'thinkingPanelBg':
      return dark ? blend(canvas, colors['thinking']!, 0.25) : blend(canvas, colors['thinking']!, 0.12)
    case 'toolPanelBg':
      // Defaults to accentMuted — parseThemeFile derives accentMuted first.
      return derived.get('accentMuted')!
    case 'panelBorder':
      return colors['borderDefault']!
    case 'panelBoxBorder':
      return blend(canvas, accent, 0.70)
    default:
      throw new Error(`internal: no derivation for theme field "${field}"`)
  }
}

/**
 * Parse + validate one theme JSON file and derive its missing optional
 * fields into a complete `Palette`. Throws an `Error` carrying the `source`
 * (the file path) and the offending field on any invalid input.
 */
export function parseThemeFile(raw: string, source: string): Palette {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${source}: invalid theme JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${source}: theme must be a JSON object`)
  }
  const input = data as Record<string, unknown>

  const name = input['name']
  if (typeof name !== 'string' || name === '') {
    throw new Error(`${source}: theme "name" must be a non-empty string`)
  }
  const dark = input['dark']
  if (typeof dark !== 'boolean') {
    throw new Error(`${source}: theme "dark" must be a boolean`)
  }

  const colors: Record<string, string> = {}
  for (const field of REQUIRED_COLORS) {
    const value = input[field]
    if (!isHex(value)) {
      throw new Error(`${source}: missing or invalid hex color "${field}" (expected #rrggbb)`)
    }
    colors[field] = value
  }

  // Optional fields: an explicitly provided value is used verbatim (and must
  // be a valid hex — a malformed one is a rejected file, not a silent
  // derivation); absent fields derive per the contract formulas. Derived
  // values are cached so `toolPanelBg` (which defaults to `accentMuted`) can
  // read them back.
  const derived = new Map<string, string>()
  const optional = (field: string): string => {
    const existing = derived.get(field)
    if (existing !== undefined) return existing
    const value = input[field]
    let resolved: string
    if (value === undefined) {
      resolved = deriveDefault(field, dark, colors['canvas']!, colors['accent']!, colors, derived)
    } else if (!isHex(value)) {
      throw new Error(`${source}: invalid hex color "${field}" (expected #rrggbb)`)
    } else {
      resolved = value
    }
    derived.set(field, resolved)
    return resolved
  }
  // toolPanelBg derives from accentMuted, so force accentMuted's derivation
  // before reading it (optional() caches per field, so order matters).
  const accentMuted = optional('accentMuted')
  const toolPanelBg = optional('toolPanelBg')

  const get = (field: string): string => colors[field]!
  return {
    name,
    dark,
    canvas: get('canvas'),
    canvasSubtle: get('canvasSubtle'),
    canvasInset: get('canvasInset'),
    fgDefault: get('fgDefault'),
    fgMuted: get('fgMuted'),
    fgSubtle: get('fgSubtle'),
    borderDefault: get('borderDefault'),
    borderMuted: get('borderMuted'),
    accent: get('accent'),
    accentMuted,
    success: get('success'),
    successMuted: optional('successMuted'),
    danger: get('danger'),
    dangerMuted: optional('dangerMuted'),
    attention: get('attention'),
    attentionMuted: optional('attentionMuted'),
    thinking: get('thinking'),
    thinkingPanelBg: optional('thinkingPanelBg'),
    toolPanelBg,
    panelBorder: optional('panelBorder'),
    panelBoxBorder: optional('panelBoxBorder'),
  }
}

/**
 * Scan one directory for `*.json` theme files, parsing each into a full
 * `Palette`. Invalid files are skipped with a `warn` line (fail-open); a
 * missing/unreadable directory yields an empty Map (never throws).
 */
export function scanThemeDir(dir: string, warn?: (msg: string) => void): Map<string, Palette> {
  const themes = new Map<string, Palette>()
  let files: string[]
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => join(dir, entry.name))
  } catch {
    // Missing/unreadable directory: nothing to register (fail-open).
    return themes
  }
  for (const file of files) {
    try {
      const palette = parseThemeFile(readFileSync(file, 'utf8'), file)
      themes.set(palette.name, palette)
    } catch (error) {
      warn?.(`theme registry: skipping ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return themes
}

/**
 * Merge-register all discoverable themes: the bundled `themes/` directory
 * first, then the user's `$DSH_HOME/themes` — user themes override bundled
 * ones of the same name. The hard-coded `github-light`/`github-dark` palettes
 * are always re-seeded over a bundled JSON of the same name (their exact
 * values are load-bearing for the e2e suite).
 *
 * @param opts.home - the dsh home (defaults to `$DSH_HOME` or `~/.dsh`).
 * @param opts.warn - per-file skip reporter (invalid themes are fail-open).
 */
export function discoverThemes(opts?: { home?: string; warn?: (msg: string) => void }): Map<string, Palette> {
  const registry = scanThemeDir(builtinThemesDir(), opts?.warn)
  // The canonical GitHub palettes win over any bundled JSON of the same name.
  registry.set(githubLight.name, githubLight)
  registry.set(githubDark.name, githubDark)
  for (const [name, palette] of scanThemeDir(userThemesDir(opts?.home ?? defaultDshHome()), opts?.warn)) {
    registry.set(name, palette)
  }
  return registry
}
