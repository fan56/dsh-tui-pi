/**
 * Agent-preset state manager — reads the deployment's preset roster from the
 * host's agent-preset registry (dsh 0.1.7 `@deepseek-ai/dsh-agent-preset-registry`,
 * the `agentPresets` Context service), tracks the user's /preset selection,
 * and formats the footer label.
 *
 * Presets are a dsh deployment concept: each preset composes a session's agent
 * from a different set of plugins/tools. Since dsh 0.1.7 a preset is declared
 * by a bundle patch row (`@deepseek-ai/dsh-agent-preset` with
 * `{id, name?, description?, order?, plugins}`); the registry owns the roster
 * and this module is a pure VIEW over it — no discovery of its own. The TUI
 * reads the roster once at startup (apply → /reload re-reads) and lets the
 * user switch through /preset; a switch is an explicit, confirmed action that
 * starts a NEW session on the chosen preset (a fresh TUI without a live
 * session applies the selection directly).
 *
 * Data source: `ctx.get('agentPresets').remoteExportList()` — the same face
 * the remote `agentPresets.list` RPC serves (rows carry `isDefault`, broken
 * declarations carry a `broken` reason). The registry orders rows
 * order→id; the 0.1.7 shipped roster is standard / ptc / minimal / cordis.
 *
 * `trust` is gone upstream (rows no longer carry a trust dimension) and this
 * module no longer models one. The 0.1.5-era directory scan
 * (`agent.cordis.yml` + `preset.yml` roots) is DEAD on a 0.1.7 host — the
 * registry neither scans directories nor reads preset paths — and survives
 * here only as a deprecated fallback for pre-0.1.7 hosts without the
 * `agentPresets` service; see `legacyScanRoster`. Old directory presets must
 * be re-declared as a bundle patch row with the SAME id (the old directory
 * name), or sessions recorded under that id fail to resolve on resume.
 *
 * The roster is O(1) to read (an in-memory array). The module is pure except
 * for the async `fetchPresetRoster` which talks to the registry (or, on the
 * legacy fallback, scans the filesystem).
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
  /** Why this preset cannot compose a session; absent when it can. Rendered
   *  as a badge by the /preset picker (the registry keeps broken rows
   *  visible instead of hiding them). */
  readonly broken?: string
  /** Whether a session naming no preset composes this one (registry-provided;
   *  the legacy directory scan never sets it). */
  readonly isDefault: boolean
}

/** Mutable preset state — the roster plus the current selection index. */
export interface PresetState {
  roster: readonly PresetEntry[]
  index: number
}

// ------------------------------------------------------------- registry view --

/**
 * Structural view of one roster row served by the 0.1.7 registry
 * (`AgentPresetRow` in @deepseek-ai/dsh-agent-preset-registry — mirrored
 * structurally so this module stays decoupled from the host package).
 */
export interface PresetRegistryRow {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly broken?: string
  readonly isDefault: boolean
}

/** Structural view of the registry's roster payload (`AgentPresetRoster`). */
export interface PresetRegistryRoster {
  readonly presets: readonly PresetRegistryRow[]
  readonly modeSelectionEnabled: boolean
}

/** Structural view of the registry service this module consumes. */
export interface PresetRegistryLike {
  remoteExportList(): Promise<PresetRegistryRoster>
}

/** Minimal structural host able to resolve a Context service by name. */
export interface PresetServiceHost {
  get(service: string): unknown
}

/**
 * Read the `agentPresets` registry service off a host context. Absent
 * (undefined) on pre-0.1.7 hosts — the signal for the legacy fallback.
 * `ctx.get` never throws for an unknown service name on any host generation.
 */
export function readPresetRegistry(ctx: PresetServiceHost | undefined): PresetRegistryLike | undefined {
  if (ctx === undefined) return undefined
  return (ctx as { get?(service: string): unknown }).get?.('agentPresets') as PresetRegistryLike | undefined
}

/**
 * English display names for the shipped presets, keyed by preset id. The
 * 0.1.7 shipped declarations publish no `name` at all (display copy lives in
 * the upstream locale dictionaries), which would put bare ids in front of
 * every user — so the roster overrides the ids we know. Anything unmapped (a
 * renamed or newly shipped preset) keeps the registry's string (id for the
 * shipped rows). The shipped 0.1.7 roster is standard / ptc / minimal /
 * cordis; `ptc` now composes the PTC runtime (`workflow-ptc`/`ptc-runtime`
 * plugins, the CodeRuntime successor) and `cordis` has CHANGED MEANING: its
 * dynamic define/run tools were removed upstream — it is now the
 * plugin/preset-authoring slot ("Creator mode" upstream), which the label
 * below reflects.
 */
const PRESET_ENGLISH_NAMES: Readonly<Record<string, string>> = {
  standard: 'Standard',
  ptc: 'PTC',
  minimal: 'Minimal',
  cordis: 'Creator',
}

/**
 * English descriptions for the shipped presets, used when a roster row
 * publishes none (the shipped 0.1.7 declarations do). Copy mirrors the
 * upstream locale dictionaries — including cordis's new authoring-slot
 * wording — so the /preset picker states what each shipped mode is for.
 * User-declared presets keep their own `description` verbatim.
 */
const PRESET_ENGLISH_DESCRIPTIONS: Readonly<Record<string, string>> = {
  standard: 'Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed.',
  ptc: 'Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.',
  minimal: 'The agent works using only a terminal tool. Useful for testing and comparing its basic performance.',
  cordis: 'Customize DSH through conversation. Author plugins and presets: inspect the running tree, install persistent plugins, or compose your own mode.',
}

/**
 * Map one registry roster to the display entries. English overrides apply to
 * the known shipped ids (the registry's own string kept as `officialName`
 * when the row publishes one); every other row passes through verbatim —
 * broken rows included, reason attached.
 */
export function rosterFromRegistry(roster: PresetRegistryRoster): PresetEntry[] {
  return roster.presets.map(row => {
    const override = PRESET_ENGLISH_NAMES[row.id]
    return {
      id: row.id,
      name: override ?? row.name ?? row.id,
      ...(override !== undefined && row.name !== undefined ? { officialName: row.name } : {}),
      description: row.description ?? PRESET_ENGLISH_DESCRIPTIONS[row.id],
      ...(row.broken !== undefined ? { broken: row.broken } : {}),
      isDefault: row.isDefault,
    }
  })
}

/**
 * Fetch the preset roster. Preferred source: the host's agentPresets
 * registry (`remoteExportList` — the same payload the remote
 * `agentPresets.list` RPC serves, `isDefault` included). On a host without
 * the service (pre-0.1.7) — or if the registry read throws — this degrades
 * to the deprecated directory scan (`legacyScanRoster`), which on a 0.1.7
 * host finds no roots and yields an empty roster: the /preset feature
 * disables gracefully, exactly as it did for an empty deployment before.
 * Never throws.
 */
export async function fetchPresetRoster(ctx?: PresetServiceHost): Promise<PresetEntry[]> {
  const registry = readPresetRegistry(ctx)
  if (registry === undefined) return legacyScanRoster()
  try {
    return rosterFromRegistry(await registry.remoteExportList())
  } catch {
    return legacyScanRoster()
  }
}

// ---------------------------------------------------------------- selection --

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

/**
 * The preset id selected out of the box when the roster supplies none of the
 * above preferences. Legacy-path preference only: a registry roster marks
 * its default row itself (`isDefault`), and this constant then only matters
 * for rosters that mark none.
 */
export const DEFAULT_PRESET_ID = 'standard'

/**
 * Initial selection index for a freshly fetched roster. With a remembered
 * selection (`rememberedId` — the workspace's last committed preset, when
 * `dsh-tui.rememberPreset` is on) present in the roster, its index WINS:
 * the launch resumes exactly where the last session in this directory left
 * off. Without one (memory off, first launch here, or a stale id — preset
 * renamed or removed upstream) the roster's own default row applies
 * (`isDefault`, registry-provided — never guessed); a roster that marks no
 * default falls back to the `DEFAULT_PRESET_ID` entry when present, then 0
 * (the first-listed entry). Deployments without a `standard` preset keep
 * the first-entry behaviour instead of failing — the default is a
 * preference, never a requirement.
 */
export function initialPresetIndex(roster: readonly PresetEntry[], rememberedId?: string): number {
  if (rememberedId !== undefined && rememberedId !== '') {
    const remembered = roster.findIndex(p => p.id === rememberedId)
    if (remembered >= 0) return remembered
  }
  const marked = roster.findIndex(p => p.isDefault)
  if (marked >= 0) return marked
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

// ---------------------------------------------- deprecated directory scan --
// DEAD on a dsh 0.1.7 host: 0.1.7 removed directory-preset discovery entirely
// (the `@deepseek-ai/dsh-agent-presets` package no longer exists and the
// registry "neither scans directories nor accepts preset paths"), so this
// scan finds no presets there. It is kept ONLY as the roster fallback for
// pre-0.1.7 hosts that lack the `agentPresets` service. Do not extend it;
// do not treat its output as authoritative anywhere the registry is present.

/** A preset root: a directory containing preset subdirectories. @deprecated legacy-scan seam only. */
export interface PresetRoot {
  path: string
  origin: 'shipped' | 'user'
}

/** Test seam: replace the scanned roots for hermetic roster tests. @deprecated legacy-scan seam only. */
let presetRootOverride: PresetRoot[] | undefined
export function __setPresetRootOverride(roots: PresetRoot[] | undefined): void {
  presetRootOverride = roots
}

/**
 * Resolve the preset roots — the discovery families of the REMOVED
 * `@deepseek-ai/dsh-agent-presets` package (the shipped presets lived inside
 * that package; locally authored presets under the Harness home):
 *   1. shipped root: the `presets/` dir inside the
 *      `@deepseek-ai/dsh-agent-presets` package, located dynamically (see below)
 *   2. user root: `~/.dsh/.agent-presets/`
 *
 * The shipped root must track the RUNNING HOST's copy of the package — the
 * `/preset` switch sends the preset id to the host, which composes sessions
 * from its own install, so a roster listing presets the host cannot see is
 * worse than an empty one. Three strategies, first hit wins per id:
 *   a. walk up from the running dsh entry script (`process.argv[1]`, real
 *      path'd past the bin shim) probing `<dir>/node_modules/…`
 *   b. resolve through this plugin's own module closure
 *   c. the known global prefixes as a static last-resort fallback
 * The user root is the conventional `~/.dsh/.agent-presets/`.
 *
 * Nonexistent roots scan to an empty roster, so every candidate is probed.
 *
 * @deprecated 0.1.7 removed directory presets (bundle-patch declarations
 * replaced them); this only serves pre-0.1.7 hosts via `fetchPresetRoster`'s
 * fallback and must not run when the agentPresets registry is present.
 */
export function resolvePresetRoots(): PresetRoot[] {
  const roots: PresetRoot[] = []
  const seen = new Set<string>()
  const pushShipped = (path: string): void => {
    if (seen.has(path)) return
    seen.add(path)
    roots.push({ path, origin: 'shipped' })
  }
  for (const path of shippedRootsFromEntry()) pushShipped(path)
  for (const path of shippedRootsFromClosure()) pushShipped(path)
  for (const path of SHIPPED_FALLBACK_PREFIXES) pushShipped(path)
  // User root: $DSH_HOME/.agent-presets/
  const userRoot = resolve(join(dshHome(), '.agent-presets'))
  roots.push({ path: userRoot, origin: 'user' })
  return roots
}

/** The npm package that carried the shipped presets (removed in 0.1.7). */
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
 * @deprecated legacy-scan seam only (see {@link resolvePresetRoots}).
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
    // Validate id: same regex as the removed dsh-agent-presets package
    // (lowercase alphanumeric + hyphens)
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.name)) continue
    const dir = join(root.path, entry.name)
    const compositionPath = join(dir, 'agent.cordis.yml')
    try {
      await access(compositionPath)
    } catch {
      continue // no composition file → skip
    }
    // Read the display metadata: `preset.yml` was the canonical file
    // (`METADATA_FILE` in the removed package); absent metadata keeps the
    // directory id as the name.
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
      description: description ?? PRESET_ENGLISH_DESCRIPTIONS[entry.name],
      isDefault: false, // the legacy scan has no default notion
    })
  }
  return presets
}

/**
 * Fetch the preset roster by scanning the filesystem roots (the pre-0.1.7
 * data source). First-root-wins per id (shipped root before user root).
 * Returns an empty array when no presets are found.
 * @deprecated legacy fallback for hosts without the agentPresets registry;
 * a 0.1.7 host has no preset directories to find here.
 */
async function legacyScanRoster(): Promise<PresetEntry[]> {
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
