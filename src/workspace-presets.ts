/**
 * Per-workspace preset memory — the last `/preset` selection of a directory,
 * so the next TUI launch in the same workspace starts on it instead of the
 * server-side default.
 *
 * dsh presets compose a session at CREATION time, and before the user ever
 * switches the server default governs — which means a `/preset cordis`
 * choice died with the session: every fresh launch silently fell back to
 * `standard`. This store closes that gap: the switch path records the
 * committed preset under the workspace's project key (the same
 * `projectKeyFor(cwd)` grouping the session log backend uses), and startup
 * reads it back into both the footer selection AND the session-creation
 * preset (`bridge.setAgentPreset`), so the first prompt composes under the
 * remembered preset exactly as the last session did.
 *
 * Storage is a plugin-owned JSON document at `$DSH_HOME/workspace-presets.json`
 * — the model-profiles.json precedent (atomic tmp+rename, self-healing
 * normalize, never fatal): the host settings document is deliberately NOT
 * used, because it is global user config and this state is per-workspace
 * runtime memory. The toggle lives in settings (`dsh-tui.rememberPreset`,
 * default true): when off, startup ignores the store and the switch path
 * stops recording — the file itself is left alone, so flipping the toggle
 * back restores the last remembered choices.
 *
 * The module is pure except for the two fs functions; both take an explicit
 * path so tests stay hermetic.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './append-system.ts'

/** Bump when the document shape changes (a mismatch resets to the seed). */
export const WORKSPACE_PRESETS_VERSION = 1

/** The whole stored document: workspace project key → last committed preset id. */
export interface WorkspacePresetsDoc {
  version: number
  presets: Record<string, string>
}

/** `$DSH_HOME/workspace-presets.json` (or an explicit home override). */
export function workspacePresetsPath(home: string = dshHome()): string {
  return join(home, 'workspace-presets.json')
}

/** A fresh empty document. */
export function seedWorkspacePresetsDoc(): WorkspacePresetsDoc {
  return { version: WORKSPACE_PRESETS_VERSION, presets: {} }
}

/**
 * Validate an unknown parsed document. A wrong version, a non-object, or
 * garbage entries degrade to the seed (an empty map) — the store is
 * self-healing, never fatal. Keys and values must be non-empty trimmed
 * strings; duplicates collapse (later JSON keys win, per JSON.parse).
 */
export function normalizeWorkspacePresets(raw: unknown): WorkspacePresetsDoc {
  const doc = seedWorkspacePresetsDoc()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return doc
  const { version, presets } = raw as Record<string, unknown>
  if (version !== WORKSPACE_PRESETS_VERSION) return doc
  if (presets === null || typeof presets !== 'object' || Array.isArray(presets)) return doc
  for (const [key, value] of Object.entries(presets as Record<string, unknown>)) {
    const trimmedKey = key.trim()
    if (typeof value !== 'string' || trimmedKey === '' || value.trim() === '') continue
    doc.presets[trimmedKey] = value.trim()
  }
  return doc
}

/** Read + validate the store; any failure degrades to the empty document. */
export function loadWorkspacePresets(path: string): WorkspacePresetsDoc {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return seedWorkspacePresetsDoc()
  }
  try {
    return normalizeWorkspacePresets(JSON.parse(text))
  } catch {
    return seedWorkspacePresetsDoc()
  }
}

/**
 * Atomically persist the document (tmp sibling + rename). Creates the
 * directory when missing. Returns an error message on failure, or
 * `undefined` on success — callers flash it, never throw.
 */
export function saveWorkspacePresets(path: string, doc: WorkspacePresetsDoc): string | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`)
    renameSync(tmp, path)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The remembered preset id for one workspace key, or `undefined`. */
export function rememberedPresetFor(doc: WorkspacePresetsDoc, workspaceKey: string): string | undefined {
  const id = doc.presets[workspaceKey]
  return id !== undefined && id !== '' ? id : undefined
}

/**
 * Pure merge: the document with `presetId` recorded for `workspaceKey`.
 * Returns a NEW document (the input is never mutated) so callers can retry
 * a failed save from a clean base.
 */
export function withRememberedPreset(
  doc: WorkspacePresetsDoc,
  workspaceKey: string,
  presetId: string,
): WorkspacePresetsDoc {
  return { version: doc.version, presets: { ...doc.presets, [workspaceKey]: presetId } }
}
