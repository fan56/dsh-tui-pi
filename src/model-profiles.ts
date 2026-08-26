/**
 * User model profiles — named snapshots of the whole model configuration
 * (default model + think level, plus per-subagent model/thinking) that can
 * be saved, reviewed and applied in one step, so switching between contexts
 * (work ↔ personal) is a single command instead of a /model + per-agent
 * /agents tour.
 *
 * Storage: `$DSH_HOME/model-profiles.json` — a small JSON document the TUI
 * owns outright (same model as tui-command-usage.json, src/usage.ts). Reads
 * never throw: a missing, corrupt or wrong-version file degrades to the
 * seeded default document (work / personal / other, empty until configured).
 * Writes are atomic (tmp sibling + rename) and whole-document
 * last-write-wins — the accepted loss model for a human-paced UI feature
 * (same as settings.yaml).
 *
 * Snapshot semantics — the part to keep straight:
 * - `profile.agents[name]` PRESENT → applying writes that agent's
 *   frontmatter model/thinking to exactly the recorded values (absent keys
 *   CLEAR the line — explicit inherit).
 * - `profile.agents[name]` ABSENT → applying leaves the agent untouched
 *   (an agent file created after the last save — the profile never knew it).
 * - "Save current" records EVERY discovered agent, inherit ones as empty
 *   entries, so a round-trip switch restores inherit where inherit was.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './append-system.ts'
import type { AgentFile, FrontmatterUpdates } from './agent-manager.ts'

/** On-disk schema version; bump only for breaking changes. */
export const MODEL_PROFILES_VERSION = 1

/** Profiles seeded into a fresh document (and re-seeded when the stored one is empty). */
export const DEFAULT_PROFILE_NAMES: readonly string[] = ['work', 'personal', 'other']

/** The profile's default model route + think level (a saved /model selection). */
export interface ProfileModelRoute {
  provider: string
  model: string
  /** Reasoning effort id; absent = provider default. */
  reasoningEffort?: string
}

/** One agent's recorded overrides inside a profile. An EMPTY entry (no keys)
 * is meaningful: explicit inherit — applying clears the frontmatter lines. */
export interface ProfileAgentEntry {
  /** dsh model route (`provider/model`); absent = inherit the default model. */
  model?: string
  /** Reasoning effort id; absent = inherit. */
  thinking?: string
}

/** One named profile. */
export interface ModelProfile {
  name: string
  defaultModel?: ProfileModelRoute
  /** Agent name → recorded overrides; absent names are skipped on apply. */
  agents: Record<string, ProfileAgentEntry>
}

/** The whole stored document. */
export interface ModelProfilesDoc {
  /** Name of the profile the last /profile-switch applied. */
  current?: string
  profiles: ModelProfile[]
}

/** `$DSH_HOME/model-profiles.json` (or an explicit home override). */
export function modelProfilesPath(home: string = dshHome()): string {
  return join(home, 'model-profiles.json')
}

/** Narrow an unknown JSON value into a route; anything else is dropped. */
function narrowRoute(value: unknown): ProfileModelRoute | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { provider, model, reasoningEffort } = value as Record<string, unknown>
  if (typeof provider !== 'string' || provider === '') return undefined
  if (typeof model !== 'string' || model === '') return undefined
  const route: ProfileModelRoute = { provider, model }
  if (typeof reasoningEffort === 'string' && reasoningEffort !== '') route.reasoningEffort = reasoningEffort
  return route
}

/** Narrow one agents-map value; `undefined` drops the entry, `{}` keeps it. */
function narrowEntry(value: unknown): ProfileAgentEntry | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { model, thinking } = value as Record<string, unknown>
  const entry: ProfileAgentEntry = {}
  if (typeof model === 'string' && model !== '') entry.model = model
  if (typeof thinking === 'string' && thinking !== '') entry.thinking = thinking
  return entry
}

/** Narrow one profile; a missing/invalid name drops the whole profile. */
function narrowProfile(value: unknown): ModelProfile | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { name, defaultModel, agents } = value as Record<string, unknown>
  if (typeof name !== 'string' || name.trim() === '') return undefined
  const profile: ModelProfile = { name: name.trim(), agents: {} }
  const route = narrowRoute(defaultModel)
  if (route !== undefined) profile.defaultModel = route
  if (agents !== null && typeof agents === 'object' && !Array.isArray(agents)) {
    for (const [agentName, entry] of Object.entries(agents as Record<string, unknown>)) {
      const key = agentName.trim()
      if (key === '') continue
      const narrowed = narrowEntry(entry)
      if (narrowed !== undefined) profile.agents[key] = narrowed
    }
  }
  return profile
}

/** A fresh document with the three seeded, unconfigured default profiles. */
export function seedModelProfilesDoc(): ModelProfilesDoc {
  return { profiles: DEFAULT_PROFILE_NAMES.map(name => ({ name, agents: {} })) }
}

/**
 * Validate an unknown parsed document. A wrong version, a non-object or an
 * empty/invalid profiles array degrades to the seeded defaults — the store
 * is self-healing, never fatal. Duplicate names (case-insensitive) keep the
 * first occurrence; a `current` pointing at a dropped profile is unset.
 */
export function normalizeModelProfiles(raw: unknown): ModelProfilesDoc {
  const doc = seedModelProfilesDoc()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return doc
  const { version, current, profiles } = raw as Record<string, unknown>
  if (version !== MODEL_PROFILES_VERSION) return doc
  const narrowed: ModelProfile[] = []
  const seen = new Set<string>()
  if (Array.isArray(profiles)) {
    for (const value of profiles) {
      const profile = narrowProfile(value)
      if (profile === undefined) continue
      const key = profile.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      narrowed.push(profile)
    }
  }
  if (narrowed.length === 0) return doc
  doc.profiles = narrowed
  if (typeof current === 'string' && narrowed.some(profile => profile.name === current)) {
    doc.current = current
  }
  return doc
}

/** Read + validate the store; any failure degrades to the seeded document. */
export function loadModelProfiles(path: string): ModelProfilesDoc {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return seedModelProfilesDoc()
  }
  try {
    return normalizeModelProfiles(JSON.parse(text))
  } catch {
    return seedModelProfilesDoc()
  }
}

/**
 * Atomically persist the document (tmp sibling + rename). Creates the
 * directory when missing. Resolves an error message on failure, or
 * `undefined` on success — callers flash it, never throw.
 */
export function saveModelProfiles(path: string, doc: ModelProfilesDoc): string | undefined {
  const body = JSON.stringify({
    version: MODEL_PROFILES_VERSION,
    current: doc.current,
    profiles: doc.profiles,
  })
  const dir = dirname(path)
  const base = path.split('/').pop() ?? 'model-profiles.json'
  const tmp = join(dir, `.${base}.tmp-${process.pid}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, body)
    renameSync(tmp, path)
    return undefined
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch { /* best-effort cleanup of the failed tmp sibling */ }
    return error instanceof Error ? error.message : String(error)
  }
}

/** Find a profile by (case-insensitive) name. */
export function findProfile(doc: ModelProfilesDoc, name: string): ModelProfile | undefined {
  const needle = name.trim().toLowerCase()
  return doc.profiles.find(profile => profile.name.toLowerCase() === needle)
}

/** Trim one candidate profile name; empty (or whitespace-only) is invalid. */
export function normalizeProfileName(name: string): string | undefined {
  const trimmed = name.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Create a new empty profile; the name must be valid and not taken. */
export function createProfile(doc: ModelProfilesDoc, rawName: string): { profile?: ModelProfile; error?: string } {
  const name = normalizeProfileName(rawName)
  if (name === undefined) return { error: 'profile name must not be empty' }
  if (findProfile(doc, name) !== undefined) return { error: `a profile named "${name}" already exists` }
  const profile: ModelProfile = { name, agents: {} }
  doc.profiles.push(profile)
  return { profile }
}

/** Rename a profile in place, keeping `current` consistent. Error or undefined. */
export function renameProfile(doc: ModelProfilesDoc, from: string, to: string): string | undefined {
  const profile = findProfile(doc, from)
  if (profile === undefined) return `no profile named "${from}"`
  const name = normalizeProfileName(to)
  if (name === undefined) return 'profile name must not be empty'
  if (name.toLowerCase() !== profile.name.toLowerCase() && findProfile(doc, name) !== undefined) {
    return `a profile named "${name}" already exists`
  }
  if (doc.current === profile.name) doc.current = name
  profile.name = name
  return undefined
}

/** Delete a profile; the last remaining one is refused (the store never goes empty). */
export function deleteProfile(doc: ModelProfilesDoc, name: string): string | undefined {
  const index = doc.profiles.findIndex(
    profile => profile.name.toLowerCase() === name.trim().toLowerCase())
  if (index < 0) return `no profile named "${name}"`
  if (doc.profiles.length <= 1) return 'the last profile cannot be deleted'
  const [removed] = doc.profiles.splice(index, 1)
  if (doc.current === removed.name) doc.current = undefined
  return undefined
}

/**
 * Record every discovered agent's model/thinking into a fresh agents map —
 * the "save current" capture. Inherit agents become EMPTY entries so the
 * snapshot is complete: applying it later restores inherit where inherit
 * was (see the module header's snapshot semantics).
 */
export function captureAgentsSnapshot(agents: readonly AgentFile[]): Record<string, ProfileAgentEntry> {
  const snapshot: Record<string, ProfileAgentEntry> = {}
  for (const agent of agents) {
    snapshot[agent.meta.name] = {
      ...(agent.meta.model !== undefined ? { model: agent.meta.model } : {}),
      ...(agent.meta.thinking !== undefined ? { thinking: agent.meta.thinking } : {}),
    }
  }
  return snapshot
}

/** One planned frontmatter write produced by `planAgentApply`. */
export interface PlannedAgentUpdate {
  agent: AgentFile
  updates: FrontmatterUpdates
}

/**
 * The frontmatter writes that apply `profile` onto the discovered `agents`:
 * every agent LISTED in the profile gets exactly the recorded overrides
 * (absent keys clear the line); agents absent from the profile are skipped
 * — the profile never knew them, applying must not guess. The caller
 * executes each plan through `updateAgentFrontmatter`.
 */
export function planAgentApply(
  profile: ModelProfile,
  agents: readonly AgentFile[],
): PlannedAgentUpdate[] {
  const planned: PlannedAgentUpdate[] = []
  for (const agent of agents) {
    const entry = profile.agents[agent.meta.name]
    if (entry === undefined) continue
    planned.push({
      agent,
      updates: {
        model: entry.model ?? null,
        thinking: entry.thinking ?? null,
      },
    })
  }
  return planned
}

/** `provider/model · think high` label for a route; `fallback` when unset. */
export function formatProfileRoute(route: ProfileModelRoute | undefined, fallback = '(not set)'): string {
  if (route === undefined) return fallback
  const base = `${route.provider}/${route.model}`
  return route.reasoningEffort === undefined ? base : `${base} · think ${route.reasoningEffort}`
}

/**
 * The full review dump of one profile (the `v` viewer): header, default
 * model, then every discovered agent's recorded state — plus stale entries
 * whose agent file no longer exists, marked so the user can prune them.
 */
export function profileReviewLines(
  profile: ModelProfile,
  agents: readonly AgentFile[],
  isCurrent = false,
): string[] {
  const lines: string[] = [
    `Profile: ${profile.name}${isCurrent ? '  · current' : ''}`,
    `Default model: ${formatProfileRoute(profile.defaultModel)}`,
  ]
  const discovered = new Set(agents.map(agent => agent.meta.name))
  const rows: Array<{ name: string; entry: ProfileAgentEntry | undefined; stale: boolean }> =
    agents.map(agent => ({ name: agent.meta.name, entry: profile.agents[agent.meta.name], stale: false }))
  for (const [name, entry] of Object.entries(profile.agents)) {
    if (!discovered.has(name)) rows.push({ name, entry, stale: true })
  }
  if (rows.length === 0) {
    lines.push('Agents: none recorded — pick models under /profile-cfg, or press s to save the current configuration')
    return lines
  }
  lines.push(`Agents (${String(rows.length)}):`)
  for (const { name, entry, stale } of rows) {
    const model = entry?.model ?? (entry === undefined ? '(not saved — apply leaves untouched)' : '(inherit)')
    const think = entry?.thinking !== undefined ? `think ${entry.thinking}` : 'inherit'
    lines.push(`  ${name}${stale ? ' (file missing)' : ''} · ${model} · ${think}`)
  }
  return lines
}
