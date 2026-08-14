/**
 * TUI overlays (pi SelectList style). Currently: the `/model` picker and the
 * reasoning effort picker — the terminal counterparts of the web UI's "model"
 * client contribution.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { LlmReasoningEffortInfo, LlmResolvedModelInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SelectList, type SelectItem, type TUI } from '@earendil-works/pi-tui'
import type { TuiTheme } from './theme/index.ts'

interface ListedModel {
  provider: string
  id: string
  name: string
}

/** Outcome of the reasoning effort picker overlay. */
export type PickEffortResult =
  | { kind: 'unsupported' }
  | { kind: 'cancelled' }
  | { kind: 'effort'; effort: ReasoningEffortId | 'default' }

/** First row of the effort picker: explicitly no effort override. */
const DEFAULT_EFFORT_ITEM: SelectItem = {
  value: 'default',
  label: '(provider default)',
  description: 'adapter default behavior — clears the effort override',
}

/**
 * Run the reasoning effort SelectList overlay over the given efforts. Resolves
 * with the chosen effort (`'default'` meaning no override), or `undefined`
 * when cancelled. The row matching `selectedEffort` is preselected when
 * present. `afterShow` runs once the overlay is up (used by the two-stage
 * model picker to hide the previous stage only after this one owns focus);
 * focus returns to `restoreFocus` on close.
 */
function openEffortPicker(
  tui: TUI,
  theme: TuiTheme,
  efforts: readonly LlmReasoningEffortInfo[],
  selectedEffort: ReasoningEffortId | undefined,
  restoreFocus: () => void,
  afterShow?: () => void,
): Promise<{ effort: ReasoningEffortId | 'default' } | undefined> {
  const items: SelectItem[] = [
    DEFAULT_EFFORT_ITEM,
    ...efforts.map(effort => ({
      value: effort.id,
      label: effort.name,
      ...(effort.description !== undefined ? { description: effort.description } : {}),
    })),
  ]

  return new Promise(resolve => {
    const list = new SelectList(items, 12, theme.selectList)
    if (selectedEffort !== undefined) {
      const index = items.findIndex(item => item.value === selectedEffort)
      if (index >= 0) list.setSelectedIndex(index)
    }

    const overlay = tui.showOverlay(list, { width: '80%', maxHeight: '60%' })
    afterShow?.()

    const finish = (effort: ReasoningEffortId | 'default' | undefined): void => {
      overlay.hide()
      restoreFocus()
      resolve(effort === undefined ? undefined : { effort })
    }

    list.onSelect = item => finish(item.value as ReasoningEffortId | 'default')
    list.onCancel = () => finish(undefined)
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

/**
 * Open the model picker overlay. Resolves with the picked selection, or
 * `undefined` when cancelled. When the picked model exposes selectable
 * reasoning efforts, a second overlay asks for one; cancelling that stage
 * abandons the whole pick. Focus returns to `restoreFocus` on close.
 */
export async function pickModel(
  ctx: Context,
  tui: TUI,
  theme: TuiTheme,
  current: ModelSelection | undefined,
  restoreFocus: () => void,
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

  const key = (m: ListedModel): string => `${m.provider}/${m.id}`
  const items: SelectItem[] = models.map(model => ({
    value: key(model),
    label: model.name === '' ? model.id : model.name,
    description: model.provider,
  }))

  return new Promise<ModelSelection | undefined>(resolve => {
    const list = new SelectList(items, 12, theme.selectList)
    const currentIndex = items.findIndex(item => item.value === `${current?.provider}/${current?.model}`)
    if (currentIndex >= 0) list.setSelectedIndex(currentIndex)

    const overlay = tui.showOverlay(list, { width: '80%', maxHeight: '60%' })

    const finish = (picked: ListedModel | undefined): void => {
      // Detach the stage-1 input handlers on first settle: while the model
      // info resolves (stage 2 not up yet), a stray Esc would otherwise fire
      // a ghost settle AFTER this promise already settled, and a second
      // Enter would run two concurrent stage-2s.
      list.onSelect = () => {}
      list.onCancel = () => {}
      if (picked === undefined) {
        overlay.hide()
        restoreFocus()
        resolve(undefined)
        return
      }
      // The stage-1 overlay stays visible while the model info resolves; the
      // stage-2 picker hides it only after it owns focus (no focus trip
      // through the editor between the two overlays).
      void pickEffortStage(picked).catch(() => { /* contained */ })
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
        overlay.hide()
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
        overlay.hide()
        restoreFocus()
        resolve({
          provider: picked.provider,
          model: picked.id,
          ...(keptEffort !== undefined ? { reasoningEffort: keptEffort } : {}),
        })
        return
      }

      const chosen = await openEffortPicker(
        tui, theme, efforts, keptEffort, restoreFocus,
        // Hide stage 1 only after stage 2 took focus.
        () => overlay.hide(),
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

    list.onSelect = item => {
      finish(models.find(model => key(model) === item.value))
    }
    list.onCancel = () => finish(undefined)
  })
}
