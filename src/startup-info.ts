/**
 * Startup configuration summary — the config readout under the welcome
 * banner (MCP servers, installed/total skills, the plugin tree as a
 * collapsed one-line-per-user-plugin view) and the exit-time resume hint's
 * pure helpers (launcher flag parsing, command formatting).
 *
 * Everything width- or shape-sensitive is data-in/data-out so the tests run
 * without a terminal or a dsh runtime; the only IO lives in
 * {@link collectStartupSummary}, a best-effort snapshot that never throws.
 *
 * Counting semantics mirror the surfaces the user already knows:
 * - skills: installed = symlinked into `~/.dsh/skills`, total = available
 *   in `~/.agents/skills` — the same pair the /skills manager shows.
 * - MCP: loader entries mounting `@deepseek-ai/dsh-mcp-client` (one instance
 *   per server), excluding disabled entries.
 * - plugins: loader entries minus structural group rows, split into the
 *   harness base (`@deepseek-ai/*` packages and `cordis:` loader builtins,
 *   collapsed to one count line) and every other entry (the user's own
 *   composition, listed one per tree row).
 */

import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHome } from './append-system.ts'
import { clipToWidth } from './text.ts'

/** Module specifier of the MCP client plugin (one instance per server). */
export const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/** Name prefixes of the harness's own entries (the collapsed base line). */
const BASE_NAME_PREFIXES = ['@deepseek-ai/', 'cordis:']

/**
 * Minimal loader-entry view consumed by the pure classifiers. The loader's
 * real Entry exposes much more; tests hand-craft these rows.
 */
export interface PluginEntryView {
  /** Loader entry id (stable inside its tree). */
  readonly id: string
  /** Module specifier the entry imports. */
  readonly name: string
  /** Effective disabled state (own or inherited from a parent entry). */
  readonly disabled: boolean
  /** Structural group marker — skipped like the plugin inventory does. */
  readonly group: boolean
  /** Entry config, when the entry carries any (MCP `serverName` lives here). */
  readonly config?: Record<string, unknown> | undefined
}

/** Installed/total skill pair (the /skills manager's semantics). */
export interface SkillsCount {
  readonly installed: number
  readonly total: number
}

/** One MCP server as the summary sees it. */
export interface McpServer {
  readonly name: string
  readonly disabled: boolean
}

/** The startup snapshot rendered under the welcome banner. */
export interface StartupSummary {
  /** MCP servers currently enabled, in loader order. */
  readonly mcp: readonly McpServer[]
  /** Installed/total skills (see the module note). */
  readonly skills: SkillsCount
  /** Display rows for non-base plugins, in loader order. */
  readonly userPlugins: readonly string[]
  /** Count of `@deepseek-ai/*` entries (the collapsed base line). */
  readonly baseCount: number
  /** Every non-group loader entry, enabled or not. */
  readonly pluginTotal: number
}

// ------------------------------------------------------------ pure helpers --

/**
 * Normalize one directory listing into skill names, mirroring the /skills
 * manager's discovery: `foo.md` and `foo/` bundles both surface as `foo`,
 * dotfiles are skipped.
 */
export function skillNamesFromListing(names: readonly string[]): Set<string> {
  const skills = new Set<string>()
  for (const name of names) {
    if (name.endsWith('.md')) skills.add(name.slice(0, -3))
    else if (!name.startsWith('.')) skills.add(name)
  }
  return skills
}

/**
 * Count installed/total skills from the two directory listings: total is
 * the public catalog's size, installed the subset present (as `foo.md` or a
 * bundle directory) in the curated dir.
 */
export function countSkills(publicNames: readonly string[], curatedNames: readonly string[]): SkillsCount {
  const total = skillNamesFromListing(publicNames)
  const curated = skillNamesFromListing(curatedNames)
  let installed = 0
  for (const name of total) {
    if (curated.has(name)) installed += 1
  }
  return { installed, total: total.size }
}

/**
 * Split loader entries into the summary's plugin view: MCP servers off the
 * mcp-client instances (disabled ones kept but flagged, so the count stays
 * honest about what the tree declares vs. what runs), user plugin rows
 * (`name` + a `(disabled)` suffix), and the base count. Group rows never
 * count.
 */
export function classifyPluginEntries(entries: readonly PluginEntryView[]): Pick<StartupSummary, 'mcp' | 'userPlugins' | 'baseCount' | 'pluginTotal'> {
  const mcp: McpServer[] = []
  const userPlugins: string[] = []
  let baseCount = 0
  let pluginTotal = 0
  for (const entry of entries) {
    if (entry.group) continue
    pluginTotal += 1
    if (entry.name === MCP_CLIENT_PLUGIN) {
      const serverName = entry.config?.serverName
      mcp.push({ name: typeof serverName === 'string' ? serverName : entry.id, disabled: entry.disabled })
      continue
    }
    if (BASE_NAME_PREFIXES.some(prefix => entry.name.startsWith(prefix))) {
      baseCount += 1
      continue
    }
    userPlugins.push(entry.disabled ? `${entry.name} (disabled)` : entry.name)
  }
  return { mcp, userPlugins, baseCount, pluginTotal }
}

/**
 * Render the summary as transcript lines: one header with the three counts,
 * then the collapsed plugin tree — every user plugin one `├─` row, the base
 * as the final `└─` row. Each line is clipped to the usable width (the
 * caller's Text padding handled outside, mirroring the quote line's budget).
 * A tree with nothing to show (no plugins at all) renders the header alone.
 */
export function formatStartupInfoLines(summary: StartupSummary, columns: number | undefined): readonly string[] {
  const budget = (columns ?? Infinity) - 2
  const enabledMcp = summary.mcp.filter(server => !server.disabled)
  const mcpNames = enabledMcp.map(server => server.name).join(', ')
  const header = clipToWidth(
    `mcp ${enabledMcp.length}${mcpNames === '' ? '' : ` (${mcpNames})`} · skills ${summary.skills.installed}/${summary.skills.total} · plugins ${summary.pluginTotal}`,
    budget,
  )
  const lines = [header]
  if (summary.pluginTotal > 0) {
    const rows = [...summary.userPlugins.map(name => `├─ ${name}`)]
    rows.push(`└─ dsh-base (${summary.baseCount})`)
    for (const row of rows) lines.push(clipToWidth(row, budget))
  }
  return lines
}

/**
 * Read the profile name the launcher booted, from the process's own argv:
 * `--profile <name>` or `--profile=<name>`. The plugin runs in-process with
 * the launcher, so process.argv carries the flag the user typed.
 */
export function detectProfileFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') {
      return argv[i + 1]
    }
    if (arg.startsWith('--profile=')) {
      return arg.slice('--profile='.length)
    }
  }
  return undefined
}

/**
 * Read the `--resume <id>` inner argument (the flag family `dsh --help`
 * documents for this profile): `--resume <id>` or `--resume=<id>`. Anything
 * else (including a valueless trailing `--resume`) resolves undefined.
 */
export function parseResumeArg(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--resume') {
      return args[i + 1]
    }
    if (arg.startsWith('--resume=')) {
      return arg.slice('--resume='.length)
    }
  }
  return undefined
}

/**
 * Fallback profile-name source for the resume hint: the loader's base URL
 * points at the booted profile directory (`…/profiles/<name>/`). Only a URL
 * whose path really sits under `/profiles/` yields a name — any other base
 * (a dev config dir, an embedding host) resolves undefined rather than
 * naming a directory that is not a profile.
 */
export function profileFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (typeof baseUrl !== 'string' || baseUrl === '') return undefined
  const marker = '/profiles/'
  const idx = baseUrl.lastIndexOf(marker)
  if (idx === -1) return undefined
  // Profile names cannot contain '/', so the first path segment after the
  // marker is the profile directory (nested subtrees would only follow it).
  const name = baseUrl.slice(idx + marker.length).split('/')[0]
  return name === '' ? undefined : name
}

/**
 * Format the exit-time resume hint's command. With a profile name the hint
 * reproduces the exact launcher invocation; without one (an embedding host,
 * an alias) it still states the flag family — the session id is the part
 * the user cannot recall.
 */
export function formatResumeCommand(profile: string | undefined, sessionId: string): string {
  return profile === undefined || profile === ''
    ? `dsh --resume ${sessionId}`
    : `dsh --profile ${profile} --resume ${sessionId}`
}

// ---------------------------------------------------------------- collector --

/** Structural slice of the cordis loader service the collector reads. */
interface LoaderLike {
  entries(): Iterable<{
    id: string
    disabled: boolean
    options: { name: string; group?: boolean | null; config?: unknown }
  }>
}

/** Read one directory's listing, degrading to empty on any error. */
function readDirNames(path: string): string[] {
  try {
    return readdirSync(path, { encoding: 'utf8' })
  } catch {
    return []
  }
}

/**
 * Snapshot the startup summary from the running tree: the loader's entry
 * list plus the two skill directories. Best-effort by contract — no loader
 * service, unreadable dirs or a throwing entry walk all degrade to
 * undefined, and the welcome banner renders alone (startup must never hang
 * or crash on this readout).
 */
export function collectStartupSummary(ctx: Context): StartupSummary | undefined {
  const loader = ctx.get('loader') as LoaderLike | undefined
  if (loader === undefined) return undefined
  const entries: PluginEntryView[] = []
  try {
    for (const entry of loader.entries()) {
      entries.push({
        id: entry.id,
        name: entry.options.name,
        disabled: entry.disabled,
        group: entry.options.group === true,
        config: (entry.options.config ?? undefined) as Record<string, unknown> | undefined,
      })
    }
  } catch {
    return undefined
  }
  const classified = classifyPluginEntries(entries)
  const agentsHome = process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')
  const skills = countSkills(
    readDirNames(resolve(agentsHome, 'skills')),
    readDirNames(resolve(dshHome(), 'skills')),
  )
  return { ...classified, skills }
}
