/**
 * TUI overlays for the pickers — the `/model` picker (two-stage), the
 * reasoning effort picker, the `/theme` preference picker and the
 * `/permission` preset picker. Every picker is the same FW table:
 * `●` title, uppercase header row, the ─┼─ rule under it, `│`-separated
 * aligned columns — one visual language across every slash-command panel.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { PresetEntry, PresetState } from './preset.ts'
import type { LlmReasoningEffortInfo, LlmResolvedModelInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { OverlayHandle, TUI } from '@earendil-works/pi-tui'
import { wrapFramedOverlay } from './frame.ts'
import {
  buildModelRows,
  canHideModelRow,
  modelKey,
  toggleStringList,
  type ListedModel,
  type ModelRow,
} from './model-list.ts'
import { permissionItems } from './permission.ts'
import { autoColumns, PanelHost, TablePanel, type TableColumn, type TablePanelOptions } from './panels.ts'
import { readModelPrefs, writeModelPref } from './theme-settings.ts'
import type { ThemePreference, TuiTheme } from './theme/index.ts'

/** Outcome of the reasoning effort picker overlay. */
export type PickEffortResult =
  | { kind: 'unsupported' }
  | { kind: 'cancelled' }
  | { kind: 'effort'; effort: ReasoningEffortId | 'default' }

/** First row of the effort picker: explicitly no effort override. */
const DEFAULT_EFFORT_ROW: PickerItem = {
  value: 'default',
  label: '(provider default)',
  description: 'adapter default behavior — clears the effort override',
}

/** The standard framed-overlay mount every picker here uses. */
function mountPicker<T>(tui: TUI, theme: TuiTheme, panel: TablePanel<T>): OverlayHandle {
  // The framed overlay adds 4 rows (borders + spacers) on top of the table
  // (title + header + rule + rows + footer); the 75% cap keeps the bottom
  // border intact on small terminals.
  return tui.showOverlay(wrapFramedOverlay(theme, panel), { width: '80%', maxHeight: '75%' })
}

/** A generic picker row — the SelectList-style shape every items builder already produces. */
interface PickerItem {
  value: string
  label: string
  description?: string
}

/** Columns of a label + description table under the auto layout. */
function labelDescriptionColumns(title: string, rows: readonly PickerItem[], cap = 28): readonly TableColumn[] {
  return autoColumns(
    [{ key: 'label', title, cap }, { key: 'description', title: 'Description' }],
    rows,
    itemText,
  )
}

/** Cell text of a `{ value, label, description }` row by column key. */
function itemText(row: PickerItem, key: string): string {
  return key === 'description' ? row.description ?? '' : row.label
}

/** renderCell for a `{ value, label, description }` row keyed by column. */
function itemCell(row: PickerItem, column: TableColumn): string {
  return itemText(row, column.key)
}

/**
 * Run the reasoning effort table overlay over the given efforts. Resolves
 * with the chosen effort (`'default'` meaning no override), or `undefined`
 * when cancelled. The row matching `selectedEffort` is preselected when
 * present. `afterShow` runs once the overlay is up (used by the two-stage
 * model picker to hide the previous stage only after this one owns focus);
 * focus returns to `restoreFocus` on close.
 */
export function openEffortPicker(
  tui: TUI,
  theme: TuiTheme,
  efforts: readonly LlmReasoningEffortInfo[],
  selectedEffort: ReasoningEffortId | undefined,
  restoreFocus: () => void,
  afterShow?: () => void,
): Promise<{ effort: ReasoningEffortId | 'default' } | undefined> {
  const rows: PickerItem[] = [
    DEFAULT_EFFORT_ROW,
    ...efforts.map(effort => ({
      value: effort.id,
      label: effort.name,
      description: effort.description ?? '',
    })),
  ]

  return new Promise(resolve => {
    const preselect = selectedEffort === undefined
      ? undefined
      : rows.findIndex(row => row.value === selectedEffort)
    const list = new TablePanel(theme, {
      title: '● Reasoning effort',
      columns: labelDescriptionColumns('Effort', rows, 24),
      rows,
      renderCell: itemCell,
      preselect: preselect !== undefined && preselect >= 0 ? preselect : undefined,
      onSelect: row => finish(row.value as ReasoningEffortId | 'default'),
      onCancel: () => finish(undefined),
    })
    const overlay = mountPicker(tui, theme, list)
    afterShow?.()

    function finish(effort: ReasoningEffortId | 'default' | undefined): void {
      overlay.hide()
      restoreFocus()
      resolve(effort === undefined ? undefined : { effort })
    }
  })
}

/**
 * Open the reasoning effort picker for the current model. Resolves with the
 * picked outcome: the model exposes no selectable efforts (`unsupported`),
 * the user cancelled (`cancelled`), or a chosen effort — where `'default'`
 * clears the effort override. Focus returns to `restoreFocus` on close.
 */
export async function pickEffort(
  ctx: Context,
  tui: TUI,
  theme: TuiTheme,
  current: ModelSelection,
  restoreFocus: () => void,
): Promise<PickEffortResult> {
  const llm = ctx.get('llm')
  if (llm === undefined) return { kind: 'unsupported' }

  let info: LlmResolvedModelInfo
  try {
    info = await llm.resolveModelInfo(current.provider, current.model)
  } catch {
    return { kind: 'unsupported' }
  }

  const efforts = info.reasoning?.efforts
  if (efforts === undefined || efforts.length === 0) return { kind: 'unsupported' }

  const picked = await openEffortPicker(tui, theme, efforts, current.reasoningEffort, restoreFocus)
  if (picked === undefined) return { kind: 'cancelled' }
  return { kind: 'effort', effort: picked.effort }
}

/** Theme preference rows of the picker, matching the settings schema vocabulary. */
const THEME_ROWS: PickerItem[] = [
  { value: 'auto', label: 'auto (terminal detection)', description: 'follow the terminal light/dark signal' },
  { value: 'light', label: 'light', description: 'GitHub light palette' },
  { value: 'dark', label: 'dark', description: 'GitHub dark palette' },
]

/**
 * Open the theme preference picker overlay. Resolves with the picked
 * preference, or `undefined` when cancelled. The row matching `current` is
 * preselected; focus returns to `restoreFocus` on close.
 */
export function pickTheme(
  tui: TUI,
  theme: TuiTheme,
  current: ThemePreference,
  restoreFocus: () => void,
): Promise<ThemePreference | undefined> {
  return new Promise(resolve => {
    const list = new TablePanel(theme, {
      title: '● Theme',
      columns: labelDescriptionColumns('Theme', THEME_ROWS),
      rows: THEME_ROWS,
      renderCell: itemCell,
      preselect: THEME_ROWS.findIndex(row => row.value === current),
      onSelect: row => finish(row.value as ThemePreference),
      onCancel: () => finish(undefined),
    })
    const overlay = mountPicker(tui, theme, list)

    function finish(picked: ThemePreference | undefined): void {
      overlay.hide()
      restoreFocus()
      resolve(picked)
    }
  })
}

/**
 * Open the permission preset picker overlay. Resolves with the picked preset
 * name, or `undefined` when cancelled. The row matching `current` is
 * preselected when present; focus returns to `restoreFocus` on close.
 * Without a composed permission-presets service there is nothing to pick —
 * resolves `undefined` immediately.
 */
export function pickPermission(
  ctx: Context,
  tui: TUI,
  theme: TuiTheme,
  current: string | undefined,
  restoreFocus: () => void,
): Promise<string | undefined> {
  const presets = ctx.get('permissionPresets')
  if (presets === undefined) return Promise.resolve(undefined)

  const items = permissionItems(presets, current)
  return new Promise((resolve, reject) => {
    const list = new TablePanel(theme, {
      title: '● Permission preset',
      columns: labelDescriptionColumns('Preset', items),
      rows: items,
      renderCell: itemCell,
      preselect: current === undefined
        ? undefined
        : Math.max(0, items.findIndex(item => item.value === current)),
      onSelect: item => finish(item.value),
      onCancel: () => finish(undefined),
    })
    let overlay: OverlayHandle
    try {
      overlay = mountPicker(tui, theme, list)
    } catch (error) {
      // Never strand the keyboard on a half-mounted picker: the rejection
      // reaches the caller (submit's try/catch surfaces it), but focus must
      // already be back on the editor.
      restoreFocus()
      reject(error)
      return
    }

    function finish(picked: string | undefined): void {
      overlay.hide()
      restoreFocus()
      resolve(picked)
    }
  })
}

/** Footer hints of the model picker with the favorites/hidden/filter keys. */
const MODEL_PICKER_FOOTER = '↑↓ navigate · Enter select · f favorite · h hide · / filter · Esc back'

/**
 * Open the model picker overlay. Resolves with the picked selection, or
 * `undefined` when cancelled. When the picked model exposes selectable
 * reasoning efforts, a second overlay asks for one; cancelling that stage
 * abandons the whole pick. Focus returns to `restoreFocus` on close.
 *
 * The list carries the favorites/hidden structure: `f` toggles the favorite
 * flag on the cursor model (list reorders live, panel stays open), `h`
 * toggles hidden, `/` engages a session-local substring filter. Every toggle
 * persists immediately through the dsh-tui settings namespace (best-effort).
 *
 * With `host` given (the profile editor embeds this picker inside its own
 * overlay flow) the stage-1 table mounts and unmounts through the host's
 * show-new-then-hide-old lifecycle instead of a bare mountPicker; callers
 * then typically pass a no-op `restoreFocus` and re-show their own panel
 * once the promise resolves.
 */
export async function pickModel(
  ctx: Context,
  tui: TUI,
  theme: TuiTheme,
  current: ModelSelection | undefined,
  restoreFocus: () => void,
  host?: PanelHost,
): Promise<ModelSelection | undefined> {
  const llm = ctx.get('llm')
  if (llm === undefined) return undefined

  const providers = llm.listProviders()
  const models: ListedModel[] = []
  await Promise.all(providers.map(async provider => {
    try {
      for (const model of await llm.listModels(provider.id)) {
        models.push({ provider: provider.id, id: model.id, name: model.name })
      }
    } catch { /* one provider's listing failure must not kill the picker */ }
  }))
  if (models.length === 0) return undefined

  // Favorites/hiddens persist under dsh-tui settings; the picker works on
  // local copies and flushes each f/h press immediately (best-effort — a
  // settings-less deployment keeps the session-local state).
  const persisted = await readModelPrefs(ctx)
  let favorites = persisted.favoriteModels
  let hidden = persisted.hiddenModels

  return new Promise<ModelSelection | undefined>(resolve => {
    // Auto layout: MODEL fits its content, PROVIDER runs to the right edge.
    const columns: readonly TableColumn[] = autoColumns(
      [
        { key: 'model', title: 'Model', cap: 40 },
        { key: 'provider', title: 'Provider' },
      ],
      models,
      (model, key) => (key === 'provider' ? model.provider : model.name === '' ? model.id : model.name),
    )

    let query = ''
    // Transient in-panel failure line for the best-effort pref writes below
    // (FieldPanel-style status row; auto-clears so it never goes stale).
    let persistStatus: string | undefined
    let statusTimer: ReturnType<typeof setTimeout> | undefined
    const initialRows = buildModelRows(models, favorites, hidden)
    const options: TablePanelOptions<ModelRow> = {
      title: '● Model',
      columns,
      rows: initialRows,
      renderCell: (row, column) => {
        if (row.kind !== 'model') return ''
        if (column.key === 'provider') return row.model.provider
        const label = row.model.name === '' ? row.model.id : row.model.name
        return row.section === 'favorite' ? `★ ${label}` : label
      },
      isSelectable: row => row.kind === 'model',
      specialRow: (row, width) => {
        if (row.kind === 'divider') return '─'.repeat(Math.max(1, width))
        if (row.kind === 'hiddenHeader') return `─ Hidden (${String(row.count)}) ─`
        return undefined
      },
      dimRow: row => row.kind === 'model' && row.section === 'hidden',
      shortcuts: {
        f: () => toggle('favorite'),
        h: () => toggle('hide'),
      },
      preselect: Math.max(0, initialRows.findIndex(row =>
        row.kind === 'model'
        && row.model.provider === current?.provider
        && row.model.id === current?.model)),
      onSelect: row => { if (row.kind === 'model') settle(row.model) },
      onCancel: () => settle(undefined),
      footer: MODEL_PICKER_FOOTER,
      status: () => persistStatus,
      filter: {
        getQuery: () => query,
        onQueryChange: next => {
          query = next
          rebuild()
        },
      },
    }
    const list = new TablePanel<ModelRow>(theme, options)

    /**
     * Rebuild rows from the live favorites/hidden/filter state. The cursor
     * follows `keepKey` when given (a toggle must not jump); a miss — the
     * toggled row vanished from the rebuilt list — falls back to
     * `resyncCursor`, otherwise the cursor would strand out of range
     * (`selectedRow()` undefined, no ▸ marker, dead arrow keys).
     */
    const rebuild = (keepKey?: string): void => {
      options.rows = buildModelRows(models, favorites, hidden, query)
      const followed = keepKey !== undefined
        && list.focusRow(row => row.kind === 'model' && modelKey(row.model) === keepKey)
      if (!followed) list.resyncCursor()
    }

    /** Best-effort persistence of one pref list; failures surface in-panel. */
    const persist = (key: 'favoriteModels' | 'hiddenModels', value: readonly string[]): void => {
      void writeModelPref(ctx, key, value).then(
        error => {
          if (error !== undefined) flashPersistFailure(error)
        },
        err => {
          flashPersistFailure(err instanceof Error ? err.message : String(err))
        },
      )
    }

    /** Show one failure message for a few seconds, then clear the status row. */
    const flashPersistFailure = (message: string): void => {
      persistStatus = `✘ save failed: ${message}`
      clearTimeout(statusTimer)
      statusTimer = setTimeout(() => { persistStatus = undefined; tui.requestRender() }, 4000)
    }

    /** Toggle favorite/hidden on the cursor model and reflow in place. */
    const toggle = (action: 'favorite' | 'hide'): void => {
      const row = list.selectedRow()
      if (row === undefined || row.kind !== 'model') return
      const key = modelKey(row.model)
      if (action === 'favorite') {
        favorites = toggleStringList(favorites, key)
        persist('favoriteModels', favorites)
      } else {
        // Favorite rows are also shown pinned in Favorites: hiding one from
        // there would silently persist hiddenModels with no visual feedback.
        // Unfavorite first, then hide.
        if (!canHideModelRow(row)) return
        hidden = toggleStringList(hidden, key)
        persist('hiddenModels', hidden)
      }
      rebuild(key)
    }

    const overlay = host !== undefined ? host.open(list) : mountPicker(tui, theme, list)

    /**
     * Tear the stage-1 table down: through the host when one owns the flow
     * (it also disposes), or the bare overlay handle otherwise.
     */
    const closeStage1 = (): void => {
      if (host !== undefined) host.close()
      else overlay?.hide()
    }

    // Enter settles stage 1 once; while the model info resolves (stage 2 not
    // up yet), a stray Esc or a second Enter must not run two concurrent
    // stage-2s — settle guards itself.
    let settled = false
    const settle = (picked: ListedModel | undefined): void => {
      if (settled) return
      settled = true
      // The picker is going away — drop any pending status-row clear timer.
      clearTimeout(statusTimer)
      if (picked === undefined) {
        closeStage1()
        restoreFocus()
        resolve(undefined)
        return
      }
      // The stage-1 overlay stays visible while the model info resolves; the
      // stage-2 picker hides it only after it owns focus (no focus trip
      // through the editor between the two overlays).
      void pickEffortStage(picked).catch(() => { /* contained */ })
    }

    // A host.open failure already ran the host's error path (focus restored);
    // just settle the promise so the caller resumes instead of hanging.
    if (overlay === undefined) {
      settle(undefined)
      return
    }

    /**
     * Second stage: when the picked route exposes selectable reasoning
     * efforts, ask for one. Cancelling this stage abandons the whole pick;
     * a resolution failure skips it and keeps the current effort on the same
     * provider only.
     */
    const pickEffortStage = async (picked: ListedModel): Promise<void> => {
      // The current effort survives a pick only within the same provider; a
      // new provider starts from its own default behavior.
      const keptEffort =
        current !== undefined && current.provider === picked.provider
          ? current.reasoningEffort
          : undefined

      let efforts: readonly LlmReasoningEffortInfo[] | undefined
      try {
        efforts = (await llm.resolveModelInfo(picked.provider, picked.id)).reasoning?.efforts
      } catch {
        // Resolution failure: fall back to the plain selection, keeping the
        // current effort on the same provider.
        closeStage1()
        restoreFocus()
        resolve({
          provider: picked.provider,
          model: picked.id,
          ...(keptEffort !== undefined ? { reasoningEffort: keptEffort } : {}),
        })
        return
      }

      if (efforts === undefined || efforts.length === 0) {
        // No selectable efforts on this route: same fallback as above.
        closeStage1()
        restoreFocus()
        resolve({
          provider: picked.provider,
          model: picked.id,
          ...(keptEffort !== undefined ? { reasoningEffort: keptEffort } : {}),
        })
        return
      }

      // No kept effort: default the stage-2 cursor to `high` rather than the
      // adapter-default row. openEffortPicker's findIndex guard falls back to
      // the first row when the model does not offer the level.
      const chosen = await openEffortPicker(
        tui, theme, efforts, keptEffort ?? ('high' as ReasoningEffortId), restoreFocus,
        // Hide stage 1 only after stage 2 took focus.
        () => closeStage1(),
      )
      if (chosen === undefined) {
        // Escaping the effort stage is an escape from the whole pick.
        resolve(undefined)
        return
      }
      if (chosen.effort === 'default') {
        // Explicitly no override: clear any inherited effort.
        resolve({ provider: picked.provider, model: picked.id })
        return
      }
      resolve({ provider: picked.provider, model: picked.id, reasoningEffort: chosen.effort })
    }
  })
}

/**
 * Open the agent preset picker overlay. Resolves with the picked preset id,
 * or `undefined` when cancelled. The row matching the current selection is
 * preselected; focus returns to `restoreFocus` on close.
 */
export function pickPreset(
  tui: TUI,
  theme: TuiTheme,
  state: PresetState,
  restoreFocus: () => void,
): Promise<string | undefined> {
  const rows: PickerItem[] = state.roster.map(p => ({
    value: p.id,
    label: p.name,
    description: p.description ?? (p.trust === 'system' ? 'shipped preset' : 'user preset'),
  }))
  return new Promise(resolve => {
    const list = new TablePanel(theme, {
      title: '● Agent preset',
      columns: labelDescriptionColumns('Preset', rows),
      rows,
      renderCell: itemCell,
      preselect: Math.max(0, state.index),
      onSelect: row => finish(row.value),
      onCancel: () => finish(undefined),
    })
    const overlay = mountPicker(tui, theme, list)

    function finish(picked: string | undefined): void {
      overlay.hide()
      restoreFocus()
      resolve(picked)
    }
  })
}
