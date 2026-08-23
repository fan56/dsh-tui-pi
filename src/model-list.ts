/**
 * Pure model-list assembly for the /model picker — favorites pinned on top,
 * hidden models in a dim section at the bottom, everything between. No TUI
 * imports: every function here is plain data-in/data-out, so the ordering,
 * filtering and toggle semantics stay unit-testable without a terminal
 * (test/model-list.test.mjs).
 */

/** One listed model route (provider + model id + display name). */
export interface ListedModel {
  provider: string
  id: string
  name: string
}

/** Composite settings key of a model: `${provider}/${id}`. */
export function modelKey(model: Pick<ListedModel, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`
}

/**
 * One rendered row of the model picker table. `divider` separates the
 * favorites from the rest; `hiddenHeader` opens the dim Hidden section.
 * Both are structural and never selectable (see TablePanel `isSelectable`).
 */
export type ModelRow =
  | { kind: 'model'; section: 'favorite' | 'normal' | 'hidden'; model: ListedModel }
  | { kind: 'divider' }
  | { kind: 'hiddenHeader'; count: number }

/** Case-insensitive substring match of `query` against name/id/provider. */
export function matchesModelFilter(model: ListedModel, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return (
    model.name.toLowerCase().includes(needle)
    || model.id.toLowerCase().includes(needle)
    || model.provider.toLowerCase().includes(needle)
  )
}

/**
 * Toggle `key` in `list`: remove when present, append when absent (join
 * order = favorite order). Returns a new array; the input is never mutated.
 */
export function toggleStringList(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter(entry => entry !== key) : [...list, key]
}

/**
 * Hide-toggle guard: a favorite row is also shown pinned in Favorites, so
 * hiding it from there would silently persist `hiddenModels` with no visual
 * feedback (the model would only resurface once unfavorited — suddenly
 * landing in the Hidden section). The picker must refuse `h` on a favorite
 * row; the user unfavorites first.
 */
export function canHideModelRow(row: ModelRow): boolean {
  return row.kind !== 'model' || row.section !== 'favorite'
}

/** Narrow an unknown settings value into a string[] (non-strings dropped). */
export function narrowStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/**
 * Assemble the picker rows, top to bottom:
 *
 * 1. Favorites (`section: 'favorite'`, ★ prefix applied by renderCell), in
 *    join order — a favorited model is removed from every other section;
 * 2. one full-width divider row — only when at least one favorite is visible
 *    AND something follows it;
 * 3. the remaining models (`section: 'normal'`) in listing order;
 * 4. the Hidden section — only without an active filter and when non-empty:
 *    a `hiddenHeader` row carrying the count, then the hidden models
 *    (`section: 'hidden'`, rendered dim) that are not also favorited.
 *
 * An active `filter` keeps the pinned structure but leaves only matching
 * models per section; stale keys in `favorites`/`hidden` (models no longer
 * listed by any provider) are skipped silently.
 */
export function buildModelRows(
  models: readonly ListedModel[],
  favorites: readonly string[],
  hidden: readonly string[],
  filter = '',
): ModelRow[] {
  const byKey = new Map(models.map(model => [modelKey(model), model]))
  const favKeys = new Set(favorites)
  const hiddenSet = new Set(hidden)

  const favRows: ModelRow[] = favorites
    .map(key => byKey.get(key))
    .filter((model): model is ListedModel =>
      model !== undefined && matchesModelFilter(model, filter))
    .map(model => ({ kind: 'model', section: 'favorite', model }))

  const normalRows: ModelRow[] = models
    .filter(model =>
      !favKeys.has(modelKey(model))
      && !hiddenSet.has(modelKey(model))
      && matchesModelFilter(model, filter))
    .map(model => ({ kind: 'model', section: 'normal', model }))

  const hiddenModels = models.filter(model =>
    hiddenSet.has(modelKey(model)) && !favKeys.has(modelKey(model)))
  const showHidden = filter.trim() === '' && hiddenModels.length > 0

  const rows: ModelRow[] = [...favRows]
  if (favRows.length > 0 && (normalRows.length > 0 || showHidden)) {
    rows.push({ kind: 'divider' })
  }
  rows.push(...normalRows)
  if (showHidden) {
    rows.push({ kind: 'hiddenHeader', count: hiddenModels.length })
    for (const model of hiddenModels) rows.push({ kind: 'model', section: 'hidden', model })
  }
  return rows
}
