/**
 * `/agents` — manage agent definition markdown files (the dsh terminal
 * counterpart of pi's fun-agent `/fun-agent-cfg` and zcode's subagents page).
 *
 * Two layers:
 *
 *   1. agent table — one row per agent, four columns (name | model | deep |
 *      description), ↑↓/PgUp/PgDn navigate, Enter opens the agent.
 *   2. agent fields window — title (display name + id), the full
 *      description, and the editable field rows model / thinking / deep.
 *      Enter edits the selected row (or m/t/d shortcuts), v opens the full
 *      system-prompt body, Esc returns to the table.
 *
 * Edits go straight to the frontmatter of the agent's markdown file and
 * take effect the next time the agent is spawned.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmReasoningEffortInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  getKeybindings,
  SelectList,
  type Component,
  type OverlayHandle,
  type SelectItem,
  type TUI,
} from '@earendil-works/pi-tui'
import {
  agentsDir,
  listAgentFiles,
  seedFromZcode,
  updateAgentFrontmatter,
  zcodeAgentsDir,
  type AgentFile,
  type AgentMeta,
} from './agent-manager.ts'
import { wrapFramedOverlay } from './frame.ts'
import { EditField, type ParseOutcome } from './settings.ts'
import { openEffortPicker } from './selectors.ts'
import { ansiFg, BOLD, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'

/** zcode-style 8-color label palette (GitHub-flavored hexes). */
const AGENT_COLORS: Record<string, string> = {
  red: '#d1242f',
  blue: '#0969da',
  green: '#1a7f37',
  yellow: '#9a6700',
  purple: '#8250df',
  orange: '#bc4c00',
  pink: '#bf3989',
  cyan: '#1b7c83',
}

/** Row marker slot width (▸ or two spaces). */
const MARKER_W = 2

/** Depth editor parse: empty = keep, otherwise a non-negative integer. */
function parseDeepInput(text: string): ParseOutcome {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'keep' }
  if (!/^\d+$/.test(trimmed)) {
    return { kind: 'error', error: `expected a non-negative integer, got "${trimmed}"` }
  }
  return { kind: 'value', value: Number(trimmed) }
}

/** Shared mutable status line (last action outcome) of the fields window. */
interface DetailState {
  getStatus(): string | undefined
}

/** Action callbacks the fields window triggers (wired by the manager). */
interface FieldsActions {
  onModel(): void
  onThinking(): void
  onDeep(): void
  onBody(): void
  onBack(): void
}

/** The agent list: a self-drawn four-column table (name | model | deep | desc). */
class AgentTable implements Component {
  private readonly theme: TuiTheme
  private readonly agents: readonly AgentFile[]
  private readonly actions: { onSelect(agent: AgentFile): void; onCancel(): void }
  private index = 0
  private scroll = 0
  private readonly maxVisible = 12

  constructor(
    theme: TuiTheme,
    agents: readonly AgentFile[],
    actions: { onSelect(agent: AgentFile): void; onCancel(): void },
    preselect?: string,
  ) {
    this.theme = theme
    this.agents = agents
    this.actions = actions
    if (preselect !== undefined) {
      const i = agents.findIndex(agent => agent.meta.name === preselect)
      if (i >= 0) this.index = i
    }
    if (this.index >= this.maxVisible) this.scroll = this.index - this.maxVisible + 1
  }

  invalidate(): void {}

  render(width: number): string[] {
    const fg = (hex: string) => (text: string) => ansiFg(hex) + text + RESET
    const subtle = fg(this.theme.palette.fgSubtle)
    const muted = fg(this.theme.palette.fgMuted)
    const accent = fg(this.theme.palette.accent)
    // Fixed columns + separators; the description column takes the rest.
    const nameW = 12
    const modelW = 24
    const deepW = 4
    const sep = ' │ '
    const descW = Math.max(8, width - MARKER_W - nameW - modelW - deepW - sep.length * 3)
    const cell = (text: string, colWidth: number) => clipToWidth(text, colWidth)
    const lines: string[] = []

    const header = `${' '.repeat(MARKER_W)}${cell('name', nameW)}${sep}${cell('model', modelW)}${sep}${'deep'.padStart(deepW)}${sep}${cell('description', descW)}`
    lines.push(subtle(header))

    for (const agent of this.agents.slice(this.scroll, this.scroll + this.maxVisible)) {
      const meta = agent.meta
      const selected = agent === this.agents[this.index]
      const marker = selected ? '▸ ' : '  '
      const name = cell(meta.displayName ?? meta.name, nameW)
      const model = cell(meta.model ?? '(inherit)', modelW)
      const deep = String(meta.deep).padStart(deepW)
      const description = cell(meta.description ?? '', descW)
      const namePart = `${marker}${name}${sep}${model}${sep}${deep}${sep}`
      if (selected) {
        lines.push(accent(BOLD + namePart + description + RESET))
      } else {
        lines.push(`${muted(namePart)}${muted(description)}`)
      }
    }

    lines.push('')
    const scrollInfo = this.agents.length > this.maxVisible ? ` (${this.index + 1}/${this.agents.length})` : ''
    lines.push(subtle(`↑↓ navigate · Enter open · Esc back${scrollInfo}`))
    return lines
  }

  handleInput(data: string): void {
    const kb = getKeybindings()
    if (kb.matches(data, 'tui.select.up')) {
      if (this.index > 0) this.index--
    } else if (kb.matches(data, 'tui.select.down')) {
      if (this.index < this.agents.length - 1) this.index++
    } else if (kb.matches(data, 'tui.select.pageUp')) {
      this.index = Math.max(0, this.index - this.maxVisible)
    } else if (kb.matches(data, 'tui.select.pageDown')) {
      this.index = Math.min(this.agents.length - 1, this.index + this.maxVisible)
    } else if (kb.matches(data, 'tui.select.confirm')) {
      this.actions.onSelect(this.agents[this.index])
      return
    } else if (kb.matches(data, 'tui.select.cancel')) {
      this.actions.onCancel()
      return
    } else {
      return
    }
    // Keep the selection inside the viewport window.
    if (this.index < this.scroll) this.scroll = this.index
    else if (this.index >= this.scroll + this.maxVisible) this.scroll = this.index - this.maxVisible + 1
  }
}

/**
 * The agent fields window: title (display name + id), the full description,
 * and the editable field rows model / thinking / deep. Enter (or m/t/d)
 * edits the focused row; v opens the full system-prompt body.
 */
class AgentFieldsView implements Component {
  private readonly theme: TuiTheme
  private readonly agent: AgentFile
  private readonly state: DetailState
  private readonly actions: FieldsActions
  private index = 0
  private readonly rows: Array<{ key: string; value: string }>

  constructor(theme: TuiTheme, agent: AgentFile, state: DetailState, actions: FieldsActions) {
    this.theme = theme
    this.agent = agent
    this.state = state
    this.actions = actions
    const meta = agent.meta
    this.rows = [
      { key: 'model', value: meta.model ?? '(inherit — default model)' },
      { key: 'thinking', value: meta.thinking ?? '(inherit)' },
      { key: 'deep', value: String(meta.deep) },
    ]
  }

  invalidate(): void {}

  render(width: number): string[] {
    const fg = (hex: string) => (text: string) => ansiFg(hex) + text + RESET
    const accent = fg(this.theme.palette.accent)
    const muted = fg(this.theme.palette.fgMuted)
    const subtle = fg(this.theme.palette.fgSubtle)
    const attention = fg(this.theme.palette.attention)
    const meta = this.agent.meta
    const wrap = Math.max(2, width - 2)
    const lines: string[] = []

    const dot = meta.color !== undefined && AGENT_COLORS[meta.color] !== undefined
      ? fg(AGENT_COLORS[meta.color])('● ') + RESET
      : ''
    const nameText = clipToWidth(meta.displayName ?? meta.name, Math.max(2, wrap - 2))
    lines.push(accent(BOLD + `${dot}${nameText}` + RESET))
    if (meta.displayName !== undefined && meta.displayName !== meta.name) {
      lines.push(subtle(`name: ${clipToWidth(meta.name, wrap)}`))
    }
    lines.push('')
    for (const line of (meta.description ?? '(no description)').split('\n')) {
      lines.push(muted(clipToWidth(line === '' ? ' ' : line, wrap)))
    }
    lines.push('')

    const keyW = 10
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i]
      const selected = i === this.index
      const marker = selected ? '▸ ' : '  '
      const key = clipToWidth(row.key, keyW)
      const keyPad = keyW - clipToWidth(row.key, keyW).length
      const value = clipToWidth(row.value, wrap - MARKER_W - keyW - 3)
      const line = `${marker}${key}${' '.repeat(keyPad)} ✎ ${value}`
      if (selected) {
        lines.push(accent(BOLD + line + RESET))
      } else {
        const headW = MARKER_W + keyW + 3
        lines.push(`${muted(line.slice(0, headW))}${subtle(line.slice(headW))}`)
      }
    }

    const status = this.state.getStatus()
    if (status !== undefined) {
      lines.push('')
      lines.push(attention(clipToWidth(status, wrap)))
    }
    lines.push('')
    lines.push(subtle(clipToWidth('↑↓ field · Enter edit (m model · t think · d deep) · v full prompt · Esc back', wrap)))
    return lines
  }

  handleInput(data: string): void {
    const kb = getKeybindings()
    if (kb.matches(data, 'tui.select.up')) {
      if (this.index > 0) this.index--
    } else if (kb.matches(data, 'tui.select.down')) {
      if (this.index < this.rows.length - 1) this.index++
    } else if (data === 'm' || data === 'M') {
      this.actions.onModel()
    } else if (data === 't' || data === 'T') {
      this.actions.onThinking()
    } else if (data === 'd' || data === 'D') {
      this.actions.onDeep()
    } else if (data === 'v' || data === 'V') {
      this.actions.onBody()
    } else if (kb.matches(data, 'tui.select.confirm')) {
      if (this.index === 0) this.actions.onModel()
      else if (this.index === 1) this.actions.onThinking()
      else this.actions.onDeep()
    } else if (kb.matches(data, 'tui.select.cancel')) {
      this.actions.onBack()
    }
  }
}

/** Read-only system-prompt viewer for one agent (Esc/Enter closes). */
class AgentBodyViewer implements Component {
  private readonly theme: TuiTheme
  private readonly agent: AgentFile
  private readonly onClose: () => void

  constructor(theme: TuiTheme, agent: AgentFile, onClose: () => void) {
    this.theme = theme
    this.agent = agent
    this.onClose = onClose
  }

  invalidate(): void {}

  render(width: number): string[] {
    const fg = (hex: string) => (text: string) => ansiFg(hex) + text + RESET
    const accent = fg(this.theme.palette.accent)
    const muted = fg(this.theme.palette.fgMuted)
    const subtle = fg(this.theme.palette.fgSubtle)
    const wrap = Math.max(2, width - 2)
    const lines: string[] = [
      accent(BOLD + clipToWidth(`ⓘ ${this.agent.meta.name} · system prompt`, wrap) + RESET),
      '',
    ]
    const bodyLines = this.agent.body.split('\n')
    for (const line of bodyLines.slice(0, 40)) {
      lines.push(muted(clipToWidth(line === '' ? ' ' : line, wrap)))
    }
    if (bodyLines.length > 40) {
      lines.push(subtle(clipToWidth(`… ${bodyLines.length - 40} more line(s)`, wrap)))
    }
    lines.push('')
    lines.push(subtle('  Esc to close'))
    return lines
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, 'tui.select.cancel')
      || getKeybindings().matches(data, 'tui.select.confirm')) {
      this.onClose()
    }
  }
}

/**
 * Flat `provider/model` picker for one agent — every route's models in one
 * list (the current frontmatter `model` is preselected), then — when that
 * model exposes reasoning levels — a think-level stage. Esc at either stage
 * cancels the whole change. `open` is the shared overlay-swap function of
 * the manager; the stage-1 overlay is returned so the effort stage can hide
 * it once it owns focus.
 */
async function pickAgentModel(
  ctx: Context,
  tui: TUI,
  theme: TuiTheme,
  meta: AgentMeta,
  open: (component: Component) => OverlayHandle | undefined,
): Promise<{ model: string; thinking: string | null } | undefined> {
  const llm = ctx.get('llm')
  if (llm === undefined) return undefined
  const models: Array<{ value: string; label: string; description?: string }> = []
  for (const provider of llm.listProviders()) {
    try {
      for (const model of await llm.listModels(provider.id)) {
        models.push({
          value: `${provider.id}/${model.id}`,
          label: model.name === '' ? model.id : model.name,
          description: provider.id,
        })
      }
    } catch { /* one provider's listing failure must not kill the picker */ }
  }
  if (models.length === 0) return undefined

  return new Promise(resolve => {
    const items: SelectItem[] = models.map(model => ({
      value: model.value,
      label: model.label,
      ...(model.description !== undefined ? { description: model.description } : {}),
    }))
    const list = new SelectList(items, 12, theme.selectList)
    const currentIndex = meta.model === undefined ? -1 : items.findIndex(item => item.value === meta.model)
    if (currentIndex >= 0) list.setSelectedIndex(currentIndex)

    list.onSelect = item => {
      // Detach the stage-1 input handlers on first settle: while the model
      // info resolves (stage 2 not up yet), a stray Esc would otherwise fire
      // a ghost settle AFTER this promise already settled, and a second
      // Enter would run two concurrent stage-2s.
      list.onSelect = () => {}
      list.onCancel = () => {}
      void (async () => {
        const slash = item.value.indexOf('/')
        if (slash <= 0) {
          resolve({ model: item.value, thinking: null })
          return
        }
        const providerId = item.value.slice(0, slash)
        const modelId = item.value.slice(slash + 1)
        let efforts: readonly LlmReasoningEffortInfo[] | undefined
        try {
          efforts = (await llm.resolveModelInfo(providerId, modelId)).reasoning?.efforts
        } catch { /* an unresolvable model just skips the effort stage */ }
        if (efforts === undefined || efforts.length === 0) {
          resolve({ model: item.value, thinking: null })
          return
        }
        const current = meta.thinking as ReasoningEffortId | undefined
        const chosen = await openEffortPicker(
          tui, theme, efforts, current, () => {}, () => stage1?.hide(),
        )
        if (chosen === undefined) resolve(undefined)
        else if (chosen.effort === 'default') resolve({ model: item.value, thinking: null })
        else resolve({ model: item.value, thinking: chosen.effort })
      })()
    }
    list.onCancel = () => {
      // Same first-settle detachment as onSelect: a cancellation while no
      // stage-2 is in flight must not let a late Enter start one.
      list.onSelect = () => {}
      list.onCancel = () => {}
      resolve(undefined)
    }
    const stage1 = open(list)
    if (stage1 === undefined) resolve(undefined)
  })
}

/**
 * Open the `/agents` manager. Resolves with a summary text when the user
 * made changes (or seeded agents) and exits, or `undefined` when nothing
 * changed. `preselect` jumps straight into one agent's fields window.
 */
export async function openAgentManager(
  ctx: Context,
  tui: TUI,
  theme: TuiTheme,
  restoreFocus: () => void,
  preselect?: string,
): Promise<string | undefined> {
  const dir = agentsDir()
  const seed = seedFromZcode(dir)
  const { agents, broken } = listAgentFiles(dir)
  if (agents.length === 0) {
    return broken.length === 0
      ? `No agents in ${dir} — drop a markdown file to define one.`
      : `No usable agents in ${dir} (${broken.length} broken file(s)).`
  }

  let current: OverlayHandle | undefined
  const changed: string[] = []
  let detailStatus: string | undefined
  let pendingPreselect = preselect
  /** Settles the manager promise (assigned inside the executor below). */
  let settle: ((value: string | undefined) => void) | undefined

  /**
   * Swap the visible overlay: show the next, then hide the previous. Never
   * strands the keyboard on a half-mounted overlay — a showOverlay failure
   * tears down and settles the whole manager.
   */
  const open = (component: Component): OverlayHandle | undefined => {
    let next: OverlayHandle
    try {
      next = tui.showOverlay(wrapFramedOverlay(theme, component), { width: '80%', maxHeight: '80%' })
    } catch (error) {
      current?.hide()
      current = undefined
      restoreFocus()
      settle?.(`✘ failed to open the agents view: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    current?.hide()
    current = next
    return next
  }

  return new Promise(resolve => {
    settle = resolve

    const showTable = (): void => {
      const table = new AgentTable(theme, agents, {
        onSelect: agent => showFields(agent),
        onCancel: () => {
          current?.hide()
          current = undefined
          restoreFocus()
          if (changed.length > 0) {
            const seededNote = seed.seeded > 0 ? ` (seeded ${seed.seeded} from ${zcodeAgentsDir()})` : ''
            resolve(`Agents updated: ${changed.join(', ')}${seededNote}`)
          } else {
            resolve(seed.seeded > 0 ? `Seeded ${seed.seeded} agent(s) from ${zcodeAgentsDir()} — no changes.` : undefined)
          }
        },
      }, pendingPreselect)
      pendingPreselect = undefined
      open(table)
    }

    const showFields = (agent: AgentFile): void => {
      const state: DetailState = { getStatus: () => detailStatus }
      const view = new AgentFieldsView(theme, agent, state, {
        onModel: () => void changeModel(agent),
        onThinking: () => void changeThinking(agent),
        onDeep: () => showDeepEditor(agent),
        onBody: () => showBody(agent),
        onBack: () => showTable(),
      })
      open(view)
    }

    /** Commit path shared by model/think edits: write, mutate, flash, re-show. */
    const writeAndFlash = (agent: AgentFile, error: string | undefined, message: string): void => {
      if (error !== undefined) {
        detailStatus = `✘ ${error}`
      } else {
        if (!changed.includes(agent.meta.name)) changed.push(agent.meta.name)
        detailStatus = message
      }
      showFields(agent)
    }

    const changeModel = async (agent: AgentFile): Promise<void> => {
      const picked = await pickAgentModel(ctx, tui, theme, agent.meta, open)
      if (picked === undefined) {
        showFields(agent)
        return
      }
      const error = updateAgentFrontmatter(agent.path, {
        model: picked.model,
        thinking: picked.thinking,
      })
      if (error === undefined) {
        agent.meta.model = picked.model
        agent.meta.thinking = picked.thinking ?? undefined
      }
      const thinkText = picked.thinking !== null ? ` · think ${picked.thinking}` : ''
      writeAndFlash(agent, error, `saved ${agent.meta.name} → ${picked.model}${thinkText}`)
    }

    const changeThinking = async (agent: AgentFile): Promise<void> => {
      if (agent.meta.model === undefined) {
        detailStatus = '✘ no model set — pick a model first (m)'
        showFields(agent)
        return
      }
      const llm = ctx.get('llm')
      if (llm === undefined) {
        detailStatus = '✘ llm service unavailable'
        showFields(agent)
        return
      }
      const slash = agent.meta.model.indexOf('/')
      if (slash <= 0) {
        detailStatus = `✘ cannot resolve think levels for ${agent.meta.model}`
        showFields(agent)
        return
      }
      let efforts: readonly LlmReasoningEffortInfo[] | undefined
      try {
        efforts = (await llm.resolveModelInfo(agent.meta.model.slice(0, slash), agent.meta.model.slice(slash + 1))).reasoning?.efforts
      } catch {
        efforts = undefined
      }
      if (efforts === undefined || efforts.length === 0) {
        detailStatus = `✘ ${agent.meta.model} exposes no think levels`
        showFields(agent)
        return
      }
      const currentEffort = agent.meta.thinking as ReasoningEffortId | undefined
      const fieldsHandle = current
      const chosen = await openEffortPicker(
        tui, theme, efforts, currentEffort, () => {}, () => fieldsHandle?.hide(),
      )
      if (chosen === undefined) {
        showFields(agent)
        return
      }
      const thinking = chosen.effort === 'default' ? null : chosen.effort
      const error = updateAgentFrontmatter(agent.path, { thinking })
      if (error === undefined) agent.meta.thinking = thinking ?? undefined
      writeAndFlash(agent, error, `saved ${agent.meta.name} → think ${thinking ?? 'inherit'}`)
    }

    const showDeepEditor = (agent: AgentFile): void => {
      let committed = false
      const field = new EditField(tui, {
        title: `Max spawn depth — ${agent.meta.displayName ?? agent.meta.name}`,
        subtitle: '0 = this agent never spawns subagents · no unlimited',
        initial: String(agent.meta.deep),
        parse: parseDeepInput,
        onCommit: async parsed => {
          if (parsed.kind !== 'value') return undefined
          const n = parsed.value as number
          const error = updateAgentFrontmatter(agent.path, { deep: n })
          if (error !== undefined) return { error }
          agent.meta.deep = n
          committed = true
          return { notice: `max depth ${n} saved — takes effect when this agent is spawned` }
        },
        onDone: () => {
          // onDone fires on every terminal transition (commit, keep, Esc) —
          // only a real commit counts as a change.
          if (committed) {
            if (!changed.includes(agent.meta.name)) changed.push(agent.meta.name)
            detailStatus = `saved ${agent.meta.name} → max depth ${agent.meta.deep}`
          }
          showFields(agent)
        },
        onError: message => { detailStatus = `✘ ${message}` },
      }, theme)
      open(field)
    }

    const showBody = (agent: AgentFile): void => {
      open(new AgentBodyViewer(theme, agent, () => showFields(agent)))
    }

    showTable()
  })
}
