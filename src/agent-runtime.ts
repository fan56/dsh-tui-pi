/**
 * Profile-aware agent runtime composition — the single import seam for the
 * dsh-subagent-registry contract (`workspaceProfileName` /
 * `composeAgentRuntime` / `readModelProfilesDoc`, re-exported from the
 * package root).
 *
 * The registry is probed once at module load. A registry build that has not
 * shipped the contract yet (or one that fails to load) degrades to the
 * built-in equivalent computed from this repo's own model-profiles store, so
 * the /agents display and the scoped edit path keep working; once the
 * registry ships the contract the very same call sites use it — no code
 * changes needed.
 *
 * Composition semantics (shared with the registry's composeAgentRuntime,
 * mirrored here so the fallback displays exactly what a spawn resolves):
 * effective = frontmatter baseline ⊕ pinned profile overrides, per field —
 * a recorded NON-EMPTY override wins; an absent/empty recorded value falls
 * back to the baseline (an empty entry is the "recorded as inherit" shape,
 * which in this model means the baseline still applies). `thinking` is
 * whitelisted against the known effort ids, so a hand-edited store can
 * never ship a host-rejected value. No pin, an unknown profile, a missing
 * store or an unlistd agent → the baseline.
 *
 * Edit scoping uses the same store the writes land in: when the workspace is
 * pinned to an existing profile, /agents model/think edits update that
 * profile's per-agent overrides (model-profiles.json, workspace-scoped —
 * the frontmatter baseline is untouched); otherwise they write the agent
 * file's frontmatter, the pre-profile baseline behavior.
 */

import { dshHome } from './append-system.ts'
import {
  loadModelProfiles,
  modelProfilesPath,
  resolvePinnedProfile,
  saveModelProfiles,
  type ModelProfilesDoc,
  type ProfileAgentEntry,
} from './model-profiles.ts'
import { updateAgentFrontmatter } from './agent-manager.ts'

/** The baseline values an agent file's frontmatter carries. `null` = the key is absent (inherit). */
export interface AgentRuntimeBase {
  model?: string | null
  thinking?: string | null
}

/** Composed effective values for a spawned agent. Absent = inherit the default. */
export interface AgentRuntimeValues {
  model?: string
  thinking?: string
}

/** The registry contract this repo consumes (profile-aware composition). */
interface RegistryRuntime {
  workspaceProfileName(startDir?: string): string | null
  composeAgentRuntime(
    agentName: string,
    base: AgentRuntimeBase,
    opts?: { startDir?: string },
  ): AgentRuntimeValues
  readModelProfilesDoc(): unknown | null
}

/** Probe the registry once; the result is cached for the process lifetime.
 *  The specifier is passed as a variable so TypeScript keeps the registry's
 *  type graph OUT of this project (its peer closures may declare conflicting
 *  session-event augmentations) — compatibility is checked structurally at
 *  runtime instead. */
async function probeRegistryRuntime(): Promise<RegistryRuntime | null> {
  const specifier = '@aiwayds/dsh-subagent-registry'
  try {
    const mod = (await import(specifier)) as unknown as Record<string, unknown>
    if (
      typeof mod['composeAgentRuntime'] !== 'function'
      || typeof mod['workspaceProfileName'] !== 'function'
      || typeof mod['readModelProfilesDoc'] !== 'function'
    ) return null
    return mod as unknown as RegistryRuntime
  } catch {
    return null
  }
}

const registryRuntime = await probeRegistryRuntime()

/** Whether the registry shipped the contract (diagnostics / report hook). */
export function registryContractAvailable(): boolean {
  return registryRuntime !== null
}

/** The reasoning-effort ids the host accepts (mirrors the registry's THINKING_LEVELS). */
const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'] as const

/**
 * Pure composition: frontmatter baseline ⊕ pinned profile overrides,
 * resolved against `doc`/`startDir` explicitly — the test surface,
 * semantically identical to the registry composer (per-field override,
 * absent/empty recorded values fall back to the baseline).
 */
export function composeAgentValuesFromDoc(
  agentName: string,
  base: AgentRuntimeBase,
  doc: ModelProfilesDoc,
  startDir: string,
): AgentRuntimeValues {
  const effective: AgentRuntimeValues = {
    ...(typeof base.model === 'string' && base.model !== '' ? { model: base.model } : {}),
    ...(typeof base.thinking === 'string' && (THINKING_LEVELS as readonly string[]).includes(base.thinking) ? { thinking: base.thinking } : {}),
  }
  const profile = resolvePinnedProfile(doc, startDir)
  const entry = profile?.agents[agentName]
  if (entry === undefined) return effective
  const model = entry.model
  if (model !== undefined && model !== '') effective.model = model
  const thinking = entry.thinking
  if (thinking !== undefined && (THINKING_LEVELS as readonly string[]).includes(thinking)) effective.thinking = thinking
  return effective
}

/**
 * The values to DISPLAY for one agent: frontmatter baseline ⊕ pinned
 * profile overrides. Uses the registry composer when available, the
 * built-in equivalent otherwise.
 */
export function composeAgentValues(
  agentName: string,
  base: AgentRuntimeBase,
  opts: { startDir?: string; home?: string } = {},
): AgentRuntimeValues {
  const startDir = opts.startDir ?? process.cwd()
  if (registryRuntime !== null) {
    return registryRuntime.composeAgentRuntime(agentName, base, { startDir })
  }
  const doc = loadModelProfiles(modelProfilesPath(opts.home ?? dshHome()))
  return composeAgentValuesFromDoc(agentName, base, doc, startDir)
}

/** Where an /agents model/think edit lands. */
export type AgentEditTarget =
  | { kind: 'profile'; name: string }
  | { kind: 'frontmatter' }

/**
 * The edit target for model/think edits in this workspace: pinned to an
 * existing profile → that profile's per-agent overrides; no pin (or the
 * pinned profile no longer exists) → the frontmatter baseline.
 */
export function agentEditTarget(opts: { startDir?: string; home?: string } = {}): AgentEditTarget {
  const doc = loadModelProfiles(modelProfilesPath(opts.home ?? dshHome()))
  const profile = resolvePinnedProfile(doc, opts.startDir ?? process.cwd())
  return profile === undefined ? { kind: 'frontmatter' } : { kind: 'profile', name: profile.name }
}

/** One agent model/think edit payload (`null` = clear back to inherit). */
export interface AgentEditPayload {
  model?: string | null
  thinking?: string | null
}

export interface AgentEditResult {
  /** Where the edit landed (drives the flash message / scope note). */
  target: AgentEditTarget
  /** Error message when the write failed. */
  error?: string
}

/**
 * Commit one agent model/thinking edit through the workspace-scoped path —
 * the SINGLE write site (decision + write share one doc read, so the target
 * cannot go stale mid-commit): the pinned profile's per-agent override when
 * the workspace is pinned to an existing profile (model-profiles.json via
 * the existing atomic save path, frontmatter untouched), the agent file's
 * frontmatter otherwise.
 */
export function commitAgentModelEdit(
  agentName: string,
  agentFile: string,
  edit: AgentEditPayload,
  opts: { startDir?: string; home?: string } = {},
): AgentEditResult {
  const path = modelProfilesPath(opts.home ?? dshHome())
  const doc = loadModelProfiles(path)
  const profile = resolvePinnedProfile(doc, opts.startDir ?? process.cwd())
  if (profile !== undefined) {
    // Merge semantics: a thinking-only edit keeps the recorded model (and
    // vice versa); a null value clears that one key back to inherit.
    const entry: ProfileAgentEntry = { ...(profile.agents[agentName] ?? {}) }
    if (edit.model !== undefined) {
      if (edit.model === null) delete entry.model
      else entry.model = edit.model
    }
    if (edit.thinking !== undefined) {
      if (edit.thinking === null) delete entry.thinking
      else entry.thinking = edit.thinking
    }
    profile.agents[agentName] = entry
    const error = saveModelProfiles(path, doc)
    return { target: { kind: 'profile', name: profile.name }, ...(error !== undefined ? { error } : {}) }
  }
  const error = updateAgentFrontmatter(agentFile, {
    model: edit.model ?? null,
    thinking: edit.thinking ?? null,
  })
  return { target: { kind: 'frontmatter' }, ...(error !== undefined ? { error } : {}) }
}
