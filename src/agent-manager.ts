/**
 * Agent definitions as markdown files — the dsh terminal counterpart of the
 * pi fun-agent / zcode "one file per agent" convention.
 *
 * An agent is a `<agents-dir>/<name>.md` file with a `---` frontmatter block
 * and a markdown body that doubles as the agent's system prompt:
 *
 *   ---
 *   name: oldfox
 *   display_name: 老法师
 *   description: "顾问角色：review、挑刺、保证健壮性。"
 *   color: red
 *   model: volc-ark-plan/glm-5.3
 *   thinking: high
 *   deep: 1
 *   ---
 *   You are 老法师 — 顾问…
 *
 * Frontmatter keys are parsed loosely (`key: value`, optional surrounding
 * quotes); `name` is required, `description` feeds the picker subtitle,
 * `model` is a dsh `provider/model` route (the picker rewrites it), and
 * `deep` caps how many levels of subagents this agent may spawn (default 1,
 * 0 = never, no unlimited — there is no spelling for unbounded depth).
 * The body is kept verbatim.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** One agent's frontmatter-derived metadata (the editable surface). */
export interface AgentMeta {
  /** File basename without `.md` — required, the stable agent id. */
  name: string
  /** Optional display name, shown before `name` in the picker. */
  displayName?: string
  /** Optional one-line summary shown as the picker subtitle. */
  description?: string
  /** Optional 8-color label (red/blue/green/yellow/purple/orange/pink/cyan). */
  color?: string
  /** dsh model route (`provider/model`); absent = inherit the default. */
  model?: string
  /** Reasoning effort id (off/low/medium/high/max); absent = inherit. */
  thinking?: string
  /** Max subagent spawn depth: default 1, 0 = never spawn children. */
  deep: number
}

/** A parsed agent file: metadata + the raw system-prompt body. */
export interface AgentFile {
  path: string
  meta: AgentMeta
  body: string
}

/** One parse outcome: a usable agent, or a broken file with a reason. */
export type AgentParseResult =
  | { ok: true; agent: AgentFile }
  | { ok: false; error: string }

/** The dsh agents directory (`~/.dsh/agents`, under the dsh home). */
export function agentsDir(): string {
  return join(homedir(), '.dsh', 'agents')
}

/**
 * The legacy agents directory from the first shipped layout (`~/dsh/agents`,
 * no dot). Kept only for one-time migration — see `migrateLegacyAgentsDir`.
 */
export function legacyAgentsDir(): string {
  return join(homedir(), 'dsh', 'agents')
}

/**
 * One-time migration from the legacy `~/dsh/agents` layout into
 * `~/.dsh/agents`: when the target directory holds no agents but the legacy
 * one does, every legacy file is copied over. Idempotent.
 */
export function migrateLegacyAgentsDir(
  targetDir: string = agentsDir(),
  legacyDir: string = legacyAgentsDir(),
): number {
  const { agents } = listAgentFiles(targetDir)
  if (agents.length > 0) return 0
  if (!existsSync(legacyDir)) return 0
  let migrated = 0
  for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, entry.name), readFileSync(join(legacyDir, entry.name)))
    migrated++
  }
  return migrated
}

/** zcode agent files are the one-time seeding source (model converted). */
export function zcodeAgentsDir(): string {
  return join(homedir(), '.zcode', 'agents')
}

const FRONTMATTER_FENCE = '---'
/** Frontmatter key pattern (same loose shape fun-agent / zcode accept). */
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/

/** Strip one pair of matching surrounding quotes, if present. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

/** Find the closing fence line index of a frontmatter starting at line 0. */
function frontmatterBounds(lines: string[]): { close: number } | undefined {
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return undefined
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FRONTMATTER_FENCE) return { close: i }
  }
  return undefined
}

/** Parse a loose `key: value` frontmatter block (lines 1..close-1). */
function parseFrontmatterValues(lines: string[], close: number): Record<string, string> {
  const values: Record<string, string> = {}
  for (let i = 1; i < close; i++) {
    const match = KEY_LINE.exec(lines[i])
    if (match === null) continue
    values[match[1]] = stripQuotes(match[2].trim())
  }
  return values
}

/**
 * Parse one agent markdown file. Tolerates CRLF, quotes, and non-key lines
 * inside the frontmatter; `name` is required, `deep` must be a non-negative
 * integer when present (absent defaults to 1).
 */
export function parseAgentMarkdown(text: string, path: string): AgentParseResult {
  const lines = text.split(/\r?\n/)
  const bounds = frontmatterBounds(lines)
  if (bounds === undefined) {
    return { ok: false, error: 'missing frontmatter (file must start with `---`)' }
  }
  const values = parseFrontmatterValues(lines, bounds.close)
  const name = values['name']?.trim()
  if (name === undefined || name === '') return { ok: false, error: 'missing required frontmatter key `name`' }
  let deep = 1
  if (values['deep'] !== undefined) {
    const raw = values['deep'].trim()
    if (!/^\d+$/.test(raw)) {
      return { ok: false, error: `invalid \`deep\`: expected a non-negative integer, got "${raw}"` }
    }
    deep = Number(raw)
  }
  const body = lines.slice(bounds.close + 1).join('\n').replace(/^\n+/, '').trimEnd()
  const meta: AgentMeta = { name, deep }
  const displayName = values['display_name']?.trim()
  if (displayName !== undefined && displayName !== '') meta.displayName = displayName
  const description = values['description']?.trim()
  if (description !== undefined && description !== '') meta.description = description
  const color = values['color']?.trim()
  if (color !== undefined && color !== '') meta.color = color
  const model = values['model']?.trim()
  if (model !== undefined && model !== '') meta.model = model
  const thinking = values['thinking']?.trim()
  if (thinking !== undefined && thinking !== '') meta.thinking = thinking
  return { ok: true, agent: { path, meta, body } }
}

/** Render an agent back to markdown (frontmatter + blank line + body). */
export function renderAgentMarkdown(meta: AgentMeta, body: string): string {
  const lines: string[] = ['---']
  lines.push(`name: ${meta.name}`)
  if (meta.displayName !== undefined) lines.push(`display_name: ${meta.displayName}`)
  if (meta.description !== undefined) lines.push(`description: ${JSON.stringify(meta.description)}`)
  if (meta.color !== undefined) lines.push(`color: ${meta.color}`)
  if (meta.model !== undefined) lines.push(`model: ${meta.model}`)
  if (meta.thinking !== undefined) lines.push(`thinking: ${meta.thinking}`)
  lines.push(`deep: ${meta.deep}`)
  lines.push('---')
  if (body !== '') lines.push('', body)
  return lines.join('\n') + '\n'
}

/** List agents under `dir` (top level only), broken files reported aside. */
export function listAgentFiles(dir: string): { agents: AgentFile[]; broken: Array<{ path: string; error: string }> } {
  const agents: AgentFile[] = []
  const broken: Array<{ path: string; error: string }> = []
  if (!existsSync(dir)) return { agents, broken }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const path = join(dir, entry.name)
    const result = parseAgentMarkdown(readFileSync(path, 'utf8'), path)
    if (result.ok) agents.push(result.agent)
    else broken.push({ path, error: result.error })
  }
  agents.sort((a, b) => a.meta.name.localeCompare(b.meta.name))
  return { agents, broken }
}

/**
 * Frontmatter field updates for one agent file. `undefined` leaves the key
 * untouched; `null` removes the line (the "inherit" spelling — the agent
 * falls back to its default); a concrete value writes/replaces the line.
 */
export interface FrontmatterUpdates {
  model?: string | null
  thinking?: string | null
  deep?: number | null
}

/**
 * Apply frontmatter updates in place: existing lines are rewritten in place,
 * missing keys are inserted before the closing fence, `null` removes the
 * line. CRLF is preserved; a no-op returns without touching the file.
 * Resolves with an error message, or `undefined` on success.
 */
export function updateAgentFrontmatter(path: string, updates: FrontmatterUpdates): string | undefined {
  const text = readFileSync(path, 'utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const bounds = frontmatterBounds(lines)
  if (bounds === undefined) return 'missing frontmatter (file must start with `---`)'
  const pending: Array<[string, string | null]> = []
  if (updates.model !== undefined) pending.push(['model', updates.model])
  if (updates.thinking !== undefined) pending.push(['thinking', updates.thinking])
  if (updates.deep !== undefined) pending.push(['deep', updates.deep === null ? null : String(updates.deep)])
  let changed = false
  let close = bounds.close
  for (const [key, value] of pending) {
    let found = -1
    for (let i = 1; i < close; i++) {
      if (KEY_LINE.test(lines[i]) && lines[i].trimStart().startsWith(`${key}:`)) {
        found = i
        break
      }
    }
    const rendered = value === null ? null : `${key}: ${value}`
    if (found >= 0) {
      if (rendered === null) {
        lines.splice(found, 1)
        close--
        changed = true
      } else if (lines[found] !== rendered) {
        lines[found] = rendered
        changed = true
      }
    } else if (rendered !== null) {
      lines.splice(close, 0, rendered)
      close++
      changed = true
    }
  }
  if (!changed) return undefined
  writeFileSync(path, lines.join(eol))
  return undefined
}

/**
 * Convert a zcode `custom:<uri-encoded providerId>:<modelName>` model value
 * to a dsh `provider/model` route for providers we know. Unknown providers
 * return `undefined` (caller keeps the original line); a value without the
 * `custom:` prefix is assumed to be dsh format already.
 */
export function convertZcodeModel(model: string): string | undefined {
  if (!model.startsWith('custom:')) return model
  const rest = model.slice('custom:'.length)
  const colon = rest.indexOf(':')
  if (colon < 0) return undefined
  const providerId = decodeURIComponent(rest.slice(0, colon))
  const modelName = decodeURIComponent(rest.slice(colon + 1))
  switch (providerId) {
    case 'builtin:bigmodel':
      // bigmodel's GLM family maps onto the volc-ark-plan route's glm-5.3.
      return modelName === 'GLM-5.3' ? 'volc-ark-plan/glm-5.3' : undefined
    case '9524bbc9-01a6-4e24-9ea2-a0a076ef518b': // zcode provider "Opencode-Go"
      return `opencode-go/${modelName}`
    case 'd7ef608b-857f-4960-9a4f-380e851fdedb': // zcode provider "minimax"
      return `minimax-cn/${modelName}`
    default:
      return undefined
  }
}

/**
 * One-time seeding: when `targetDir` holds no agents yet, copy every
 * parseable zcode agent into it with the model converted to a dsh route.
 * Idempotent — once any agent exists, nothing is written.
 */
export function seedFromZcode(
  targetDir: string,
  sourceDir: string = zcodeAgentsDir(),
): { seeded: number; errors: Array<{ file: string; error: string }> } {
  mkdirSync(targetDir, { recursive: true })
  const { agents } = listAgentFiles(targetDir)
  if (agents.length > 0) return { seeded: 0, errors: [] }
  if (!existsSync(sourceDir)) return { seeded: 0, errors: [] }
  let seeded = 0
  const errors: Array<{ file: string; error: string }> = []
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const sourcePath = join(sourceDir, entry.name)
    const result = parseAgentMarkdown(readFileSync(sourcePath, 'utf8'), sourcePath)
    if (!result.ok) {
      errors.push({ file: entry.name, error: result.error })
      continue
    }
    const agent = result.agent
    if (agent.meta.model !== undefined) {
      const converted = convertZcodeModel(agent.meta.model)
      if (converted !== undefined) agent.meta.model = converted
    }
    writeFileSync(join(targetDir, `${agent.meta.name}.md`), renderAgentMarkdown(agent.meta, agent.body))
    seeded++
  }
  return { seeded, errors }
}

/** Short file label for diagnostics (kept importable for callers). */
export function agentFileLabel(path: string): string {
  return basename(path)
}
