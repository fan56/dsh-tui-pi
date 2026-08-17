/**
 * `/agents` — manage agent definition markdown files (the dsh terminal
 * counterpart of pi's fun-agent `/fun-agent-cfg` and zcode's subagents page).
 *
 * Two layers, both built on the select-panel framework (src/panels.ts):
 *
 *   1. agent table (TablePanel) — one row per agent, four columns
 *      (name | model | deep | description), ↑↓/PgUp/PgDn navigate, Enter
 *      opens the agent.
 *   2. agent fields window (FieldPanel) — title (display name + id), the
 *      full description, and the editable field rows model / thinking /
 *      deep. Enter edits the selected row (or m/t/d shortcuts), v opens the
 *      full system-prompt body (ViewerPanel), Esc returns to the table.
 *   3. subagent-limits panel (FieldPanel, `l` from the table) — the live
 *      `maxAgents` / `maxRounds` caps, editable and written straight to the
 *      `dsh-tui` settings namespace. Also the initial view when no agent
 *      files exist yet, so the caps stay configurable before any agent.
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
  migrateLegacyAgentsDir,
  seedFromZcode,
  updateAgentFrontmatter,
  zcodeAgentsDir,
  type AgentFile,
  type AgentMeta,
} from './agent-manager.ts'
import { EditField, type ParseOutcome } from './settings.ts'
import { readSubagentLimits, writeSubagentLimit } from './theme-settings.ts'
import {
  FieldPanel,
  PanelHost,
  TablePanel,
  ViewerPanel,
} from './panels.ts'
import { openEffortPicker } from './selectors.ts'
import { ansiFg, BOLD, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'

/** zcode-style 8-color label palette — GitHub-flavored hexes, per theme. */
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

/** Bright variants for the dark theme (the light hexes are too dim on dark). */
const AGENT_COLORS_DARK: Record<string, string> = {
  red: '#ff7b72',
  blue: '#58a6ff',
  green: '#3fb950',
  yellow: '#d29922',
  purple: '#bc8cff',
  orange: '#f0883e',
  pink: '#db61a2',
  cyan: '#39c5cf',
}

/** The label-dot color for an agent color name under the active theme. */
function agentDotColor(theme: TuiTheme, name: string): string | undefined {
  const table = theme.palette.name === 'github-dark' ? AGENT_COLORS_DARK : AGENT_COLORS
  return table[name]
}

/** Depth editor parse: empty = keep, otherwise a non-negative integer. */
function parseDeepInput(text: string): ParseOutcome {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'keep' }
  if (!/^\d+$/.test(trimmed)) {
    return { kind: 'error', error: `expected a non-negative integer, got "${trimmed}"` }
  }
  return { kind: 'value', value: Number(trimmed) }
}

/** Subagent-limit editor parse: empty = keep, otherwise a non-negative integer. */
function parseLimitInput(text: string): ParseOutcome {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'keep' }
  if (!/^\d+$/.test(trimmed)) {
    return { kind: 'error', error: `expected a non-negative integer, got "${trimmed}"` }
  }
  return { kind: 'value', value: Number(trimmed) }
}

/** The four table columns of the agent list. */
const AGENT_COLUMNS = [
  { key: 'name', title: 'name', width: 12 },
  { key: 'model', title: 'model', width: 24 },
  { key: 'deep', title: 'deep', width: 4, align: 'right' as const },
  { key: 'description', title: 'description', flex: true },
]

/** Cell text for one agent table row. */
function agentCell(agent: AgentFile, column: { key: string }): string {
  const meta = agent.meta
  switch (column.key) {
    case 'name': return meta.displayName ?? meta.name
    case 'model': return meta.model ?? '(inherit)'
    case 'deep': return String(meta.deep)
    default: return meta.description ?? ''
  }
}

/** The colored-dot title line of the fields window. */
function agentTitle(theme: TuiTheme, meta: AgentMeta): string {
  const dotColor = agentDotColor(theme, meta.color ?? '')
  const dot = dotColor !== undefined ? ansiFg(dotColor) + '● ' + RESET : ''
  const name = clipToWidth(meta.displayName ?? meta.name, 100)
  return ansiFg(theme.palette.accent) + BOLD + `${dot}${name}` + RESET
}

/**
 * Flat `provider/model` picker for one agent — every route's models in one
 * list (the current frontmatter `model` is preselected), then — when that
 * model exposes reasoning levels — a think-level stage. Esc at either stage
 * cancels the whole change. `host` is the shared overlay lifecycle; the
 * stage-1 overlay is returned so the effort stage can hide it once it owns
 * focus.
 */
async function pickAgentModel(
  ctx: Context,
  tui: TUI,
  theme: TuiTheme,
  meta: AgentMeta,
  host: PanelHost,
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
    const stage1 = host.open(list)
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
  migrateLegacyAgentsDir(dir)
  const seed = seedFromZcode(dir)
  const { agents, broken } = listAgentFiles(dir)

  const changed: string[] = []
  let detailStatus: string | undefined
  let limitsStatus: string | undefined
  let pendingPreselect = preselect
  /** Settles the manager promise (assigned inside the executor below). */
  let settle: ((value: string | undefined) => void) | undefined
  /** The fields-window overlay handle (for effort-stage afterShow). */
  let fieldsHandle: OverlayHandle | undefined

  const host = new PanelHost(tui, theme, message => {
    restoreFocus()
    settle?.(`✘ failed to open the agents view: ${message}`)
  })

  return new Promise(resolve => {
    settle = resolve

    const showTable = (): void => {
      const preselectIndex = pendingPreselect === undefined
        ? undefined
        : agents.findIndex(agent => agent.meta.name === pendingPreselect)
      pendingPreselect = undefined
      // TablePanel has no single-key shortcuts, so the `l` limits entry is a
      // thin subclass that routes the key before the table's own handling.
      class AgentTablePanel extends TablePanel<AgentFile> {
        handleInput(data: string): void {
          if (data.toLowerCase() === 'l') {
            showLimits()
            return
          }
          super.handleInput(data)
        }
      }
      const table = new AgentTablePanel(theme, {
        columns: AGENT_COLUMNS,
        rows: agents,
        renderCell: agentCell,
        preselect: preselectIndex !== undefined && preselectIndex >= 0 ? preselectIndex : undefined,
        footer: '↑↓ navigate · Enter open · Esc back · l limits',
        // Defensive: an empty table (never shown, but guards the round-trip)
        // must not hand `undefined` to showFields.
        onSelect: agent => {
          if (agent !== undefined) showFields(agent)
        },
        onCancel: () => closeManager(),
      })
      host.open(table)
    }

    const closeManager = (): void => {
      host.close()
      restoreFocus()
      if (changed.length > 0) {
        const seededNote = seed.seeded > 0 ? ` (seeded ${seed.seeded} from ${zcodeAgentsDir()})` : ''
        resolve(`Agents updated: ${changed.join(', ')}${seededNote}`)
      } else {
        resolve(seed.seeded > 0 ? `Seeded ${seed.seeded} agent(s) from ${zcodeAgentsDir()} — no changes.` : undefined)
      }
    }

    const showFields = (agent: AgentFile): void => {
      const meta = agent.meta
      const content = (meta.description ?? '(no description)').split('\n')
      const fields = [
        { key: 'model', value: meta.model ?? '(inherit — default model)', editable: true },
        { key: 'thinking', value: meta.thinking ?? '(inherit)', editable: true },
        { key: 'deep', value: String(meta.deep), editable: true },
      ]
      const view = new FieldPanel(theme, {
        title: agentTitle(theme, meta),
        content,
        fields,
        status: () => detailStatus,
        footer: '↑↓ field · Enter edit (m model · t think · d deep) · v full prompt · Esc back',
        shortcuts: {
          m: () => void changeModel(agent),
          t: () => void changeThinking(agent),
          d: () => showDeepEditor(agent),
          v: () => showBody(agent),
        },
        onEdit: index => {
          if (index === 0) void changeModel(agent)
          else if (index === 1) void changeThinking(agent)
          else showDeepEditor(agent)
        },
        onCancel: () => showTable(),
      })
      fieldsHandle = host.open(view)
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
      const picked = await pickAgentModel(ctx, tui, theme, agent.meta, host)
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
      host.open(field)
    }

    const showBody = (agent: AgentFile): void => {
      host.open(new ViewerPanel(theme, {
        title: `ⓘ ${agent.meta.name} · system prompt`,
        lines: agent.body.split('\n'),
        footer: '  Esc to close',
        onClose: () => showFields(agent),
      }))
    }

    /**
     * The subagent-limits panel: the live `maxAgents` / `maxRounds` values
     * (0 = unlimited), editable like the field rows. Esc returns to the table
     * — from here the limits are reachable even with no agent files at all.
     */
    const showLimits = (): void => {
      const limits = readSubagentLimits(ctx)
      const fields = [
        { key: 'maxAgents', value: `${limits.maxAgents} · concurrent live children (0 = unlimited)`, editable: true },
        { key: 'maxRounds', value: `${limits.maxRounds} · completed turns before wrap-up (0 = unlimited)`, editable: true },
      ]
      const content: string[] = [
        'subagent delegation caps — read live at every spawn / turn decision',
        ...(agents.length === 0
          ? [`no agents in ${dir} yet — drop a markdown file to define one`, ...(broken.length > 0 ? [`${broken.length} broken file(s) ignored`] : [])]
          : []),
      ]
      const panel = new FieldPanel(theme, {
        title: ansiFg(theme.palette.accent) + BOLD + '⚙ subagent limits' + RESET,
        content,
        fields,
        status: () => limitsStatus,
        footer: '↑↓ field · Enter edit (0 = unlimited) · Esc back',
        onEdit: index => editLimit(index === 0 ? 'maxAgents' : 'maxRounds'),
        // With no agent files the table has nothing to go back to — Esc then
        // closes the whole manager (mirroring the old empty-directory reply).
        onCancel: () => (agents.length === 0 ? closeManager() : showTable()),
      })
      host.open(panel)
    }

    /**
     * EditField for one subagent limit: a non-negative integer, 0 = unlimited,
     * empty keeps the current value. A commit writes the setting live — the
     * policy reads `readSubagentLimits` at its next decision point.
     */
    const editLimit = (key: 'maxAgents' | 'maxRounds'): void => {
      const current = readSubagentLimits(ctx)[key]
      let committed = false
      const field = new EditField(tui, {
        title: `${key} — subagent delegation limit (current ${current})`,
        subtitle: 'non-negative integer · 0 = unlimited · empty keeps the current value',
        initial: String(current),
        parse: parseLimitInput,
        onCommit: async parsed => {
          if (parsed.kind !== 'value') return undefined
          const n = parsed.value as number
          const error = await writeSubagentLimit(ctx, key, n)
          if (error !== undefined) return { error }
          committed = true
          return undefined
        },
        onDone: () => {
          // onDone fires on every terminal transition (commit, keep, Esc) —
          // only a real commit counts and flashes the status line.
          if (committed) {
            const n = readSubagentLimits(ctx)[key]
            limitsStatus = `${key} → ${n} saved — applies to future subagent spawns`
          }
          showLimits()
        },
        onError: message => { limitsStatus = `✘ ${message}` },
      }, theme)
      host.open(field)
    }

    // No agent files? The manager still opens — straight into the limits
    // panel, so maxAgents/maxRounds stay configurable before any agent exists.
    if (agents.length === 0) showLimits()
    else showTable()
  })
}
