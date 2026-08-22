/**
 * Agent-preset state manager — fetches the roster from the api-proxy service,
 * tracks the user's Tab selection, and formats the footer label.
 *
 * Presets are a dsh deployment concept: each preset composes a session's agent
 * from a different set of plugins/tools. The TUI fetches the roster once at
 * startup and lets the user cycle through it with Tab; the chosen preset is
 * applied to the next blank session on first submit.
 *
 * The roster is O(1) to read (an in-memory array); cycle is O(1) mutation of
 * the index. The module is pure except for the async `fetchPresetRoster` which
 * calls the api-proxy service.
 */

import type { Context } from '@deepseek-ai/cordis'

/** One preset entry from the deployment roster. */
export interface PresetEntry {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly trust: 'system' | 'user'
  readonly isDefault: boolean
}

/** Mutable preset state — the roster plus the current selection index. */
export interface PresetState {
  roster: readonly PresetEntry[]
  index: number
}

/**
 * Fetch the preset roster from the api-proxy service. Returns an empty array
 * when the service is absent (standalone / no presets configured).
 */
export async function fetchPresetRoster(ctx: Context): Promise<PresetEntry[]> {
  const api = ctx.get('apiProxy') as
    | { agentPresets?: { list: (payload: Record<string, never>) => Promise<{ data?: { presets?: readonly { id: string; name?: string; description?: string; trust: 'system' | 'user'; isDefault: boolean; broken?: string }[] } }> } }
    | undefined
  if (api?.agentPresets === undefined) return []
  try {
    const res = await api.agentPresets.list({})
    const presets = res.data?.presets ?? []
    return presets
      .filter(p => p.broken === undefined)
      .map(p => ({
        id: p.id,
        name: p.name ?? p.id,
        description: p.description,
        trust: p.trust,
        isDefault: p.isDefault,
      }))
  } catch {
    return []
  }
}

/** Cycle the preset index forward (default) or backward, wrapping around. */
export function cyclePreset(state: PresetState, direction: 1 | -1 = 1): void {
  if (state.roster.length <= 1) return
  state.index = (state.index + direction + state.roster.length) % state.roster.length
}

/** Return the currently selected preset, or undefined when the roster is empty. */
export function currentPreset(state: PresetState): PresetEntry | undefined {
  return state.roster[state.index]
}

/**
 * Find a preset by id or name (case-insensitive). Used by `/preset <name>`.
 */
export function findPresetByName(state: PresetState, name: string): PresetEntry | undefined {
  const lower = name.toLowerCase()
  return state.roster.find(p => p.id.toLowerCase() === lower || p.name.toLowerCase() === lower)
}

/**
 * Format the short preset label for the footer brand segment. Returns the
 * preset name when one is selected, or '' when the roster is empty (the footer
 * falls back to plain "dsh").
 */
export function formatPresetLabel(entry: PresetEntry | undefined): string {
  return entry?.name ?? ''
}
