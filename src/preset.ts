/**
 * Agent-preset state manager — scans the filesystem for preset directories
 * (same discovery logic as @deepseek-ai/dsh-agent-presets), tracks the user's
 * /preset selection, and formats the footer label.
 *
 * Presets are a dsh deployment concept: each preset composes a session's agent
 * from a different set of plugins/tools. The TUI scans the preset roots once
 * at startup and lets the user switch through /preset; a switch is an explicit,
 * confirmed action that starts a NEW session on the chosen preset (a fresh TUI
 * without a live session applies the selection directly).
 *
 * The roster is O(1) to read (an in-memory array). The module is pure except
 * for the async `fetchPresetRoster` which scans the filesystem.
 */

import { existsSync, realpathSync } from 'node:fs'
import { access, readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { dshHome } from './append-system.ts'

/** One preset entry from the deployment roster. */
export interface PresetEntry {
  readonly id: string
  readonly name: string
  /** The official display string from the preset's metadata, when `name`
   *  carries our English override instead of it (matched by `/preset`). */
  readonly officialName?: string
  readonly description?: string
  readonly trust: 'system' | 'user'
  readonly isDefault: boolean
}

/** Mutable preset state — the roster plus the current selection index. */
export interface PresetState {
  roster: readonly PresetEntry[]
  index: number
}

/** A preset root: a directory containing preset subdirectories. */
export interface PresetRoot {
  path: string
  trust: 'system' | 'user'
}

/** Test seam: replace the scanned roots for hermetic roster tests. */
let presetRootOverride: PresetRoot[] | undefined
export function __setPresetRootOverride(roots: PresetRoot[] | undefined): void {
  presetRootOverride = roots
}

/**
 * Resolve the preset roots — same discovery families as dsh-agent-presets
 * (alpha.3: shipped presets are bundled inside the `@deepseek-ai/dsh-agent-presets`
 * package; locally authored presets live under the Harness home):
 *   1. shipped root: the `presets/` dir inside the `@deepseek-ai/dsh-agent-presets`
 *      package, located dynamically (see below)
 *   2. user root: `~/.dsh/.agent-presets/`
 *
 * The shipped root must track the RUNNING HOST's copy of the package — the
 * `/preset` switch sends the preset id to the host, which composes sessions
 * from its own install, so a roster listing presets the host cannot see is
 * worse than an empty one. Three strategies, first hit wins per id:
 *   a. walk up from the running dsh entry script (`process.argv[1]`, real
 *      path'd past the bin shim) probing `<dir>/node_modules/…` — the
 *      presets ship nested inside the dsh host package, so this finds the
 *      host's own copy at ANY install prefix (homebrew, nvm, a custom npm
 *      prefix, pnpm global); issue #3 shipped presets went missing on
 *      installs outside the probed prefixes
 *   b. resolve through this plugin's own module closure — covers monorepo
 *      dev runs and hoisted layouts where the package is reachable from the
 *      plugin even though the entry walk missed
 *   c. the known global prefixes as a static last-resort fallback
 * The user root is the conventional `~/.dsh/.agent-presets/`.
 *
 * Nonexistent roots scan to an empty roster, so every candidate is probed.
 */
export function resolvePresetRoots(): PresetRoot[] {
  const roots: PresetRoot[] = []
  const seen = new Set<string>()
  const pushShipped = (path: string): void => {
    if (seen.has(path)) return
    seen.add(path)
    roots.push({ path, trust: 'system' })
  }
  for (const path of shippedRootsFromEntry()) pushShipped(path)
  for (const path of shippedRootsFromClosure()) pushShipped(path)
  for (const path of SHIPPED_FALLBACK_PREFIXES) pushShipped(path)
  // User root: $DSH_HOME/.agent-presets/
  const userRoot = resolve(join(dshHome(), '.agent-presets'))
  roots.push({ path: userRoot, trust: 'user' })
  return roots
}

/** The npm package that carries the shipped presets. */
const SHIPPED_PACKAGE = '@deepseek-ai/dsh-agent-presets'

/**
 * The known global-prefix layouts, kept as the static last-resort fallback
 * for the dynamic probes above (e.g. an embedded host without `argv[1]`).
 */
const SHIPPED_FALLBACK_PREFIXES = [
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets',
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh-agent-presets/presets',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh-agent-presets/presets',
]

/**
 * Walk up from `startDir` probing `<dir>/node_modules/@deepseek-ai/dsh-agent-presets/presets`.
 * Exposed (with an injectable probe) for hermetic tests of the walk itself;
 * `shippedRootsFromEntry` is the runtime wrapper that starts the walk from
 * the running dsh entry script.
 */
export function shippedRootsFromEntryDir(
  startDir: string,
  probe: (path: string) => boolean = existsSync,
): string[] {
  const roots: string[] = []
  let dir = startDir
  for (;;) {
    const candidate = join(dir, 'node_modules', SHIPPED_PACKAGE, 'presets')
    if (probe(candidate)) roots.push(candidate)
    const parent = dirname(dir)
    if (parent === dir) return roots
    dir = parent
  }
}

/** Start the entry walk from `process.argv[1]`, real path'd past bin shims. */
function shippedRootsFromEntry(): string[] {
  const entry = process.argv[1]
  if (entry === undefined || entry === '') return []
  let start: string
  try {
    start = dirname(realpathSync(entry))
  } catch {
    return []
  }
  return shippedRootsFromEntryDir(start)
}

/**
 * Resolve the shipped package through this plugin's own module closure (the
 * same `createRequire(import.meta.url)` idiom the host-floor guard uses, so
 * it behaves identically under the profile loader).
 */
function shippedRootsFromClosure(): string[] {
  try {
    const req = createRequire(import.meta.url)
    return [join(dirname(req.resolve(join(SHIPPED_PACKAGE, 'package.json'))), 'presets')]
  } catch {
    return [] // not reachable from the plugin — the other strategies cover it
  }
}

/**
 * English display names for the shipped presets, keyed by preset id. Upstream
 * publishes display metadata in Chinese only (e.g. `标准模式`) with no i18n
 * mechanism, which would put Chinese in front of every user — so the roster
 * overrides the ids we know. Anything unmapped (a renamed or newly shipped
 * preset) keeps its official string until mapped here. The shipped alpha.3
 * roster is standard / minimal / cordis / ptc (the pre-alpha `code` id was
 * renamed upstream and no longer exists).
 */
const PRESET_ENGLISH_NAMES: Readonly<Record<string, string>> = {
  standard: 'Standard',
  minimal: 'Minimal',
  cordis: 'Cordis',
  ptc: 'PTC',
}

/**
 * Scan one preset root directory for valid presets. A preset is a directory
 * containing `agent.cordis.yml` (the composition file). Directories without
 * it are skipped. Entries come back in readdir order — no explicit sort is
 * applied here.
 */
async function scanRoot(root: PresetRoot): Promise<PresetEntry[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(root.path, { withFileTypes: true })
  } catch {
    return [] // absent root = no presets
  }
  const presets: PresetEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // Validate id: same regex as dsh-agent-presets (lowercase alphanumeric + hyphens)
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.name)) continue
    const dir = join(root.path, entry.name)
    const compositionPath = join(dir, 'agent.cordis.yml')
    try {
      await access(compositionPath)
    } catch {
      continue // no composition file → skip
    }
    // Read the display metadata: `preset.yml` is the canonical file
    // (`METADATA_FILE` in @deepseek-ai/dsh-agent-presets); absent metadata
    // keeps the directory id as the name.
    let name = entry.name
    let description: string | undefined
    let meta: string
    try {
      meta = await readFile(join(dir, 'preset.yml'), 'utf8')
    } catch {
      meta = ''
    }
    if (meta !== '') {
      const nameMatch = meta.match(/^name:\s*(.+)$/m)
      if (nameMatch) name = nameMatch[1].trim()
      const descMatch = meta.match(/^description:\s*(.+)$/m)
      if (descMatch) description = descMatch[1].trim()
    }
    // English override for the known shipped ids; unmapped presets keep the
    // official string (metadata name ?? id).
    const officialName = name === entry.name ? undefined : name
    presets.push({
      id: entry.name,
      name: PRESET_ENGLISH_NAMES[entry.name] ?? name,
      ...(officialName !== undefined ? { officialName } : {}),
      description,
      trust: root.trust,
      isDefault: false, // will be set later from settings
    })
  }
  return presets
}

/**
 * Fetch the preset roster by scanning the filesystem roots. First-root-wins
 * per id (shipped root before user root). Returns an empty array when no
 * presets are found.
 */
export async function fetchPresetRoster(): Promise<PresetEntry[]> {
  const roots = presetRootOverride ?? resolvePresetRoots()
  const seen = new Set<string>()
  const roster: PresetEntry[] = []
  for (const root of roots) {
    for (const preset of await scanRoot(root)) {
      if (seen.has(preset.id)) continue
      seen.add(preset.id)
      roster.push(preset)
    }
  }
  return roster
}

/**
 * The entry `/preset next` would switch to — the roster item after the
 * current selection, wrapping around. PURE (no index mutation): the switch
 * only commits through the confirmation flow, so `next` must be able to
 * preview its target first. With 0 or 1 entries there is nothing to switch
 * to (the caller short-circuits); with ≥2 the result always differs from
 * the current selection.
 */
export function peekNextPreset(state: PresetState): PresetEntry | undefined {
  if (state.roster.length <= 1) return undefined
  return state.roster[(state.index + 1) % state.roster.length]
}

/** Return the currently selected preset, or undefined when the roster is empty. */
export function currentPreset(state: PresetState): PresetEntry | undefined {
  return state.roster[state.index]
}

/**
 * Find a preset by id, name, or official name (case-insensitive). Used by
 * `/preset <name>` — the official string keeps working even where the roster
 * shows our English override.
 */
export function findPresetByName(state: PresetState, name: string): PresetEntry | undefined {
  const lower = name.toLowerCase()
  return state.roster.find(p =>
    p.id.toLowerCase() === lower
    || p.name.toLowerCase() === lower
    || (p.officialName !== undefined && p.officialName.toLowerCase() === lower))
}

/** The preset id selected out of the box when the roster supplies it. It
 *  mirrors the dsh shipped default, but there is no mechanical binding:
 *  until the user switches via /preset, the server-side
 *  `agent-presets.default` setting still governs session creation. */
export const DEFAULT_PRESET_ID = 'standard'

/**
 * Initial selection index for a freshly scanned roster. With a remembered
 * selection (`rememberedId` — the workspace's last committed preset, when
 * `dsh-tui.rememberPreset` is on) present in the roster, its index WINS:
 * the launch resumes exactly where the last session in this directory left
 * off. Without one (memory off, first launch here, or a stale id — preset
 * renamed or removed upstream) the stock behavior applies: the
 * DEFAULT_PRESET_ID entry when present, otherwise 0 (the first-scanned
 * entry). Deployments without a `standard` preset keep the previous
 * first-entry behaviour instead of failing — the default is a preference,
 * never a requirement.
 */
export function initialPresetIndex(roster: readonly PresetEntry[], rememberedId?: string): number {
  if (rememberedId !== undefined && rememberedId !== '') {
    const remembered = roster.findIndex(p => p.id === rememberedId)
    if (remembered >= 0) return remembered
  }
  const i = roster.findIndex(p => p.id === DEFAULT_PRESET_ID)
  return i < 0 ? 0 : i
}

/**
 * Format the short preset label for the footer brand segment. Returns the
 * preset name when one is selected, or '' when the roster is empty (the footer
 * falls back to plain "dsh").
 */
export function formatPresetLabel(entry: PresetEntry | undefined): string {
  return entry?.name ?? ''
}
