/**
 * TUI overlays (pi SelectList style). Currently: the `/model` picker —
 * the terminal counterpart of the web UI's "model" client contribution.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { SelectList, type SelectItem, type TUI } from '@earendil-works/pi-tui'
import type { TuiTheme } from './theme/index.ts'

interface ListedModel {
  provider: string
  id: string
  name: string
}

/**
 * Open the model picker overlay. Resolves with the picked selection, or
 * `undefined` when cancelled. Focus returns to `restoreFocus` on close.
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
      overlay.hide()
      restoreFocus()
      if (picked === undefined) return resolve(undefined)
      resolve({
        provider: picked.provider,
        model: picked.id,
        // Keep the effort when staying on the same provider; a new provider
        // starts from its own default behavior.
        ...current !== undefined && current.provider === picked.provider && current.reasoningEffort !== undefined
          ? { reasoningEffort: current.reasoningEffort }
          : {},
      })
    }

    list.onSelect = item => {
      finish(models.find(model => key(model) === item.value))
    }
    list.onCancel = () => finish(undefined)
  })
}
