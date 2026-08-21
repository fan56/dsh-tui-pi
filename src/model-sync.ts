/**
 * /model-sync (singular) — discover models for CUSTOM provider routes and
 * merge them back into the llm-pi-ai settings section.
 *
 * A custom route is a hand-declared `llm-pi-ai.providers.<id>` profile that
 * carries a `baseURL` and is NOT one of the built-in catalog routes
 * (provider-catalog.ts): discovery against a catalog route would short-circuit
 * back to the installed pi-ai catalog. This command interrogates
 * each route's `GET ${baseURL}/models` through the official seam
 * (`LlmRuntime.discoverModels`, registered for the `llm-pi-ai` namespace by
 * dsh-llm-pi-ai with catalog short-circuit + stored-credential resolution),
 * then merges the answer into the profile's `models` array.
 *
 * The merge is additive-only: existing entries are preserved verbatim (local
 * overrides such as reasoningEfforts survive), discovered ids already present
 * are skipped, new ids are appended with sanitized metadata. The write goes
 * through `settings.mutate` at the revision read at execution time, with one
 * retry after SettingsConflictError (the persistDefaultModel pattern in
 * session.ts). Pure logic lives here as exported functions; src/index.ts only
 * wires the command.
 *
 * @module dsh-tui-pi/model-sync
 */

import { settingsNamespace, SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type { SettingsDescriptor, SettingsNamespace, SettingsPathOp, SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { catalogEntry } from './provider-catalog.ts'

/** The settings namespace dsh-llm-pi-ai owns its provider routes under. */
const NS_LLM_PI_AI = settingsNamespace('llm-pi-ai')

/**
 * The services /model-sync needs, narrowed to the exact surface it touches so
 * tests can supply fakes without a live tree.
 */
export interface ModelSyncDeps {
  /** The settings provider (describe for revisions, mutate for the write). */
  settings: Pick<SettingsProvider, 'describe' | 'mutate'>
  /** The LLM runtime whose discoverModels serves the `llm-pi-ai` namespace. */
  llm: Pick<LlmRuntime, 'discoverModels'>
}

/** One models entry as stored in a profile — passed through untouched. */
type StoredModel = Record<string, unknown>

/**
 * A custom route selected for sync: the dict key plus the endpoint facts
 * discovery needs. `api` is optional — discovery defaults the protocol.
 */
export interface CustomProviderRoute {
  id: string
  baseURL: string
  api?: string
}

/**
 * A sanitized discovered model — the writable shape of one endpoint row:
 * always an id; name/capacities carried only when present and valid.
 */
export interface SanitizedModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

/** Outcome of merging one route's discovery into its stored models. */
export interface ModelSyncMergeResult {
  /**
   * The merged models array to store: existing entries first in their stored
   * order, newly discovered ids appended at the end in discovery order.
   */
  models: StoredModel[]
  /** Discovered rows appended as new entries. */
  added: number
  /** Existing entries preserved verbatim. */
  kept: number
  /**
   * Discovered rows dropped entirely: unusable id, or an id already covered
   * by an existing entry (local state wins) or by an earlier row of this batch.
   */
  skipped: number
}

/**
 * Read the providers dict out of an llm-pi-ai descriptor value. Tolerant of
 * every malformed shape — a section that is not an object yields no routes.
 */
function readProviders(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {}
  const providers = (value as { providers?: unknown }).providers
  if (typeof providers !== 'object' || providers === null) return {}
  return providers as Record<string, unknown>
}

/** The profile fields this module reads, extracted defensively. */
interface ProfileView {
  baseURL?: string
  api?: string
  models: StoredModel[]
}

function readProfile(raw: unknown): ProfileView {
  const source = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const baseURL = typeof source.baseURL === 'string' && source.baseURL !== '' ? source.baseURL : undefined
  const api = typeof source.api === 'string' && source.api !== '' ? source.api : undefined
  const rawModels = Array.isArray(source.models) ? source.models : []
  // Only well-formed entries are merged against; a malformed stored row is
  // left alone rather than deleted (additive-only merge).
  const models = rawModels.filter((entry): entry is StoredModel => typeof entry === 'object' && entry !== null)
  return { ...(baseURL !== undefined ? { baseURL } : {}), ...(api !== undefined ? { api } : {}), models }
}

/** The stored entry's id, when it is a non-empty string. */
function storedModelId(entry: StoredModel): string | undefined {
  const id = entry.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Select the custom (hand-declared) routes worth syncing from a providers
 * dict: profiles carrying a non-empty `baseURL` whose key is not a built-in
 * catalog route — a catalog key would short-circuit discovery back to the
 * installed catalog. Sorted by route key so the
 * report order is stable regardless of document order.
 */
export function selectCustomProviders(
  providers: Record<string, unknown> | undefined,
): CustomProviderRoute[] {
  const selected: CustomProviderRoute[] = []
  for (const [id, raw] of Object.entries(providers ?? {})) {
    if (catalogEntry(id) !== undefined) continue
    const profile = readProfile(raw)
    if (profile.baseURL === undefined) continue
    selected.push({
      id,
      baseURL: profile.baseURL,
      ...(profile.api !== undefined ? { api: profile.api } : {}),
    })
  }
  selected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return selected
}

/**
 * Clean one discovered row into a writable models entry. The id is mandatory
 * (blank/absent → undefined); name must be a non-blank string; capacities
 * must be integers ≥ 1 — the llm-pi-ai schema rejects anything else at write
 * time (`contextWindow >= 1`, integer step), and a field that fails stays
 * behind rather than sinking the whole row (verified against the shipped
 * schema: absent name/contextWindow/maxTokens validate fine).
 */
export function sanitizeDiscoveredModel(raw: unknown): SanitizedModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as { id?: unknown; name?: unknown; contextWindow?: unknown; maxTokens?: unknown }
  if (typeof row.id !== 'string') return undefined
  const id = row.id.trim()
  if (id === '') return undefined
  const name = typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : undefined
  const capacity = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
  const contextWindow = capacity(row.contextWindow)
  const maxTokens = capacity(row.maxTokens)
  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  }
}

/**
 * Merge one route's discovery into its stored models — additive-only:
 *
 * - existing entries are the base and are preserved VERBATIM (local overrides
 *   like reasoningEfforts/input/compat survive; nothing is overwritten or
 *   deleted);
 * - discovered rows join by id: an id already present (or repeated within the
 *   batch) counts as skipped, local state wins;
 * - new ids are appended with `sanitizeDiscoveredModel`'s cleaned fields;
 * - the stored order is never touched: existing entries keep their positions
 *   (id-less rows included) and new ids join at the end in discovery order.
 */
export function mergeModels(
  existing: ReadonlyArray<object>,
  discovered: ReadonlyArray<unknown>,
): ModelSyncMergeResult {
  const models: StoredModel[] = existing.map(entry => entry as StoredModel)
  const ids = new Set<string>()
  for (const entry of models) {
    const id = storedModelId(entry)
    if (id !== undefined) ids.add(id)
  }
  let added = 0
  let skipped = 0
  for (const raw of discovered) {
    const clean = sanitizeDiscoveredModel(raw)
    if (clean === undefined || ids.has(clean.id)) {
      skipped += 1
      continue
    }
    ids.add(clean.id)
    // A fresh literal (not a cast): interfaces carry no implicit index
    // signature, so the entry must be rebuilt as a plain record.
    models.push({ ...clean })
    added += 1
  }
  // No reordering: existing entries stay exactly where the user stored them
  // and new ids are appended at the end in discovery order — a no-op sync
  // therefore leaves the stored array byte-identical.
  return { models, added, kept: existing.length, skipped }
}

/**
 * Write one route's merged models with optimistic concurrency: mutate at the
 * revision read NOW (not at command start), one retry after
 * SettingsConflictError with a freshly read revision — the same bottom pattern
 * as persistDefaultModel in session.ts. A second conflict surfaces.
 */
async function writeModels(
  settings: ModelSyncDeps['settings'],
  providerId: string,
  models: StoredModel[],
): Promise<void> {
  const ops: SettingsPathOp[] = [
    { op: 'set', path: ['providers', providerId, 'models'], value: models },
  ]
  const ns: SettingsNamespace = NS_LLM_PI_AI
  for (let attempt = 0; ; attempt++) {
    const descriptor = currentDescriptor(settings)
    try {
      await settings.mutate(ns, ops, descriptor?.revision)
      return
    } catch (error) {
      if (attempt === 0 && error instanceof SettingsConflictError) continue
      throw error
    }
  }
}

/** The live llm-pi-ai descriptor, re-read on demand (revision freshness). */
function currentDescriptor(settings: ModelSyncDeps['settings']): SettingsDescriptor | undefined {
  return settings.describe().find(d => d.ns === NS_LLM_PI_AI)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one /model-sync round: select the target routes (the rawInput-named one,
 * or every custom route), discover each endpoint's models, merge, and write
 * back. One route's failure never aborts the rest — its line reports the
 * reason instead. Agentless by design: nothing here touches a session.
 *
 * @returns the command result — per-provider `<id>: added N · kept M ·
 *   skipped K` lines on success, `<id>: <reason>` for failed routes; `kind:
 *   'error'` only for preconditions (missing namespace, unknown/non-custom
 *   named route) or when EVERY route failed.
 */
export async function runModelSync(
  deps: ModelSyncDeps,
  options: { rawInput?: string; signal?: AbortSignal } = {},
): Promise<{ kind: 'success' | 'error'; text: string }> {
  const descriptor = currentDescriptor(deps.settings)
  if (descriptor === undefined) {
    return { kind: 'error', text: 'The llm-pi-ai settings namespace is not registered — nothing to sync.' }
  }

  const wanted = options.rawInput?.trim() ?? ''
  let targets: CustomProviderRoute[]
  if (wanted !== '') {
    const providers = readProviders(descriptor.value)
    if (!(wanted in providers)) {
      return { kind: 'error', text: `Provider "${wanted}" is not configured under llm-pi-ai providers.` }
    }
    targets = selectCustomProviders({ [wanted]: providers[wanted] })
    if (targets.length === 0) {
      // Two distinct shapes land here: a built-in catalog key (excluded by
      // selection even when the profile carries a baseURL) and a genuinely
      // non-custom route without a baseURL. Name each accurately.
      if (catalogEntry(wanted) !== undefined) {
        return {
          kind: 'error',
          text: `Provider "${wanted}" is a built-in catalog route — /model-sync syncs hand-declared (baseURL) routes only.`,
        }
      }
      return {
        kind: 'error',
        text: `Provider "${wanted}" has no baseURL — /model-sync syncs hand-declared routes only.`,
      }
    }
  } else {
    targets = selectCustomProviders(readProviders(descriptor.value))
    if (targets.length === 0) {
      return { kind: 'success', text: 'No hand-declared (baseURL) providers configured — nothing to sync.' }
    }
  }

  const lines: string[] = []
  let failures = 0
  for (const target of targets) {
    try {
      // Re-read the live section per route: an api added/removed between the
      // selection and this write still reaches discovery (and a vanished
      // namespace degrades into that route's failure line, not a crash).
      const liveValue = currentDescriptor(deps.settings)?.value
      const profile = readProfile(readProviders(liveValue)[target.id])
      const discovered = await deps.llm.discoverModels(NS_LLM_PI_AI, {
        provider: target.id,
        baseURL: target.baseURL,
        ...(profile.api !== undefined ? { api: profile.api } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
      const merged = mergeModels(profile.models, discovered)
      // A no-op sync must produce zero settings mutations: write only when
      // discovery actually contributed new ids.
      if (merged.added > 0) {
        await writeModels(deps.settings, target.id, merged.models)
      }
      lines.push(`${target.id}: added ${merged.added} · kept ${merged.kept} · skipped ${merged.skipped}`)
    } catch (error) {
      failures += 1
      lines.push(`${target.id}: ${errorText(error)}`)
    }
  }
  if (failures === targets.length && failures > 0) {
    return { kind: 'error', text: lines.join('\n') }
  }
  return { kind: 'success', text: lines.join('\n') }
}
