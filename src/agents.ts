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
 * Edits go through the workspace-scoped path: when this directory tree is
 * pinned to an existing profile, model/think edits land in that profile's
 * per-agent overrides ($DSH_HOME/model-profiles.json) and the frontmatter
 * baseline is untouched; otherwise they write the agent file's frontmatter
 * as before. The table and the fields window always show the COMPOSED
 * values (frontmatter baseline ⊕ pinned-profile overrides — what a spawned
 * agent actually gets), so an edit never looks like a no-op.
 * `deep` stays a frontmatter-only key (profiles have no deep override).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmReasoningEffortInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  getKeybindings,
  type Component,
  type OverlayHandle,
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
import {
  agentEditTarget,
  commitAgentModelEdit,
  composeAgentValues,
  type AgentRuntimeValues,
} from './agent-runtime.ts'
import { EditField, type ParseOutcome } from './settings.ts'
import type { SubagentPolicyStats } from './subagent-policy.ts'
import { readOfficialSubagentLimits, readSubagentLimits, writeSubagentLimit } from './theme-settings.ts'
import {
  autoColumns,
  FieldPanel,
  PanelHost,
  TablePanel,
  type TableColumn,
  ViewerPanel,
} from './panels.ts'
import { openEffortPicker } from './selectors.ts'
import { ansiFg, BOLD, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'
import { t } from './i18n/index.ts'

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

/** Bright variants for the dark theme — the cmux GitHub Dark bright half
 * (#ffa198/#79c0ff/#56d364/#e3b341/#d2a8ff + GitHub emphasis orange/pink),
 * matching the theme palette's brightened status hues. */
const AGENT_COLORS_DARK: Record<string, string> = {
  red: '#ffa198',
  blue: '#79c0ff',
  green: '#56d364',
  yellow: '#e3b341',
  purple: '#d2a8ff',
  orange: '#ffa657',
  pink: '#f778ba',
  cyan: '#56d4dd',
}

/** The label-dot color for an agent color name under the active theme. */
function agentDotColor(theme: TuiTheme, name: string): string | undefined {
  const table = theme.palette.dark ? AGENT_COLORS_DARK : AGENT_COLORS
  return table[name]
}

/** Depth editor parse: empty = keep, otherwise a non-negative integer. */
function parseDeepInput(text: string): ParseOutcome {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'keep' }
  if (!/^\d+$/.test(trimmed)) {
    return { kind: 'error', error: t('agentsmg.error.integer', { text: trimmed }) }
  }
  return { kind: 'value', value: Number(trimmed) }
}

/** Subagent-limit editor parse: empty = keep, otherwise a non-negative integer. */
function parseLimitInput(text: string): ParseOutcome {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'keep' }
  if (!/^\d+$/.test(trimmed)) {
    return { kind: 'error', error: t('agentsmg.error.integer', { text: trimmed }) }
  }
  return { kind: 'value', value: Number(trimmed) }
}

/** The four agent-table columns under the auto layout: NAME/MODEL/DEEP fit
 *  the loaded agents (capped), DESCRIPTION runs to the right edge. The
 *  model cell shows the COMPOSED value (frontmatter ⊕ pinned profile). */
function agentColumns(
  agents: readonly AgentFile[],
  cell: (agent: AgentFile, key: string) => string,
): readonly TableColumn[] {
  return autoColumns(
    [
      { key: 'name', title: t('agentsmg.col.name'), cap: 16 },
      { key: 'model', title: t('agentsmg.col.model'), cap: 30 },
      { key: 'deep', title: t('agentsmg.col.deep'), align: 'right' as const },
      { key: 'description', title: t('agentsmg.col.description') },
    ],
    agents,
    cell,
  )
}

/** Cell text for one agent table row, model column COMPOSED (baseline ⊕
 *  pinned-profile overrides — what a spawned agent actually gets). */
function agentCellFor(
  effective: ReadonlyMap<string, AgentRuntimeValues>,
): (agent: AgentFile, column: { key: string }) => string {
  return (agent, column) => {
    const meta = agent.meta
    switch (column.key) {
      case 'name': return meta.displayName ?? meta.name
      case 'model': return effective.get(meta.name)?.model ?? t('agentsmg.inherit')
      case 'deep': return String(meta.deep)
      default: return meta.description ?? ''
    }
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
    // Settle-once guard replaces the old handler detachment (a stray Esc or
    // a second Enter while the effort stage resolves must not re-settle).
    let settled = false
    const settleOnce = (value: { model: string; thinking: string | null } | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const list = new TablePanel(theme, {
      title: t('agentsmg.model.title'),
      // Auto layout: MODEL fits its content, PROVIDER runs to the edge.
      columns: autoColumns(
        [{ key: 'label', title: t('agentsmg.picker.colModel'), cap: 40 }, { key: 'description', title: t('agentsmg.picker.colProvider') }],
        models,
        (model, key) => (key === 'description' ? model.description ?? '' : model.label),
      ),
      rows: models,
      renderCell: (model, column) => (column.key === 'description' ? model.description ?? '' : model.label),
      preselect: meta.model === undefined ? undefined : Math.max(0, models.findIndex(model => model.value === meta.model)),
      onSelect: item => {
        void (async () => {
          const slash = item.value.indexOf('/')
          if (slash <= 0) {
            settleOnce({ model: item.value, thinking: null })
            return
          }
          const providerId = item.value.slice(0, slash)
          const modelId = item.value.slice(slash + 1)
          let efforts: readonly LlmReasoningEffortInfo[] | undefined
          try {
            efforts = (await llm.resolveModelInfo(providerId, modelId)).reasoning?.efforts
          } catch { /* an unresolvable model just skips the effort stage */ }
          if (efforts === undefined || efforts.length === 0) {
            settleOnce({ model: item.value, thinking: null })
            return
          }
          const current = meta.thinking as ReasoningEffortId | undefined
          const chosen = await openEffortPicker(
            tui, theme, efforts, current, () => {}, () => stage1?.hide(),
          )
          if (chosen === undefined) settleOnce(undefined)
          else if (chosen.effort === 'default') settleOnce({ model: item.value, thinking: null })
          else settleOnce({ model: item.value, thinking: chosen.effort })
        })()
      },
      onCancel: () => settleOnce(undefined),
    })
    const stage1 = host.open(list)
    if (stage1 === undefined) settleOnce(undefined)
  })
}

/**
 * Open the `/agents` manager. Resolves with a summary text when the user
 * made changes (or seeded agents) and exits, or `undefined` when nothing
 * changed. `preselect` jumps straight into one agent's fields window.
 * `getStats` optionally feeds the limits panel the live subagent-runtime
 * counters (the policy's admission snapshot) — omitted when the caller has
 * no policy handle (tests, foreign hosts).
 */
export async function openAgentManager(
  ctx: Context,
  tui: TUI,
  theme: TuiTheme,
  restoreFocus: () => void,
  preselect?: string,
  getStats?: () => SubagentPolicyStats,
): Promise<string | undefined> {
  const dir = agentsDir()
  migrateLegacyAgentsDir(dir)
  const seed = seedFromZcode(dir)
  const { agents, broken } = listAgentFiles(dir)

  const cwd = process.cwd()
  /** Where model/think edits land in this workspace (decided at open; the
   *  commit rechecks against the same store, so the two cannot diverge). */
  const editTarget = agentEditTarget({ startDir: cwd })
  /** Composed runtime value per agent (baseline ⊕ pinned profile), resolved
   *  on open and after each edit — never inside a render callback (iron
   *  rule 1: no I/O in render). */
  const effective: Map<string, AgentRuntimeValues> = new Map()
  const refreshEffective = (): void => {
    effective.clear()
    for (const agent of agents) {
      effective.set(agent.meta.name, composeAgentValues(agent.meta.name, {
        model: agent.meta.model ?? null,
        thinking: agent.meta.thinking ?? null,
      }, { startDir: cwd }))
    }
  }
  refreshEffective()

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
    settle?.(t('agentsmg.openFailed', { message }))
  })

  return new Promise(resolve => {
    settle = resolve

    const showTable = (): void => {
      const preselectIndex = pendingPreselect === undefined
        ? undefined
        : agents.findIndex(agent => agent.meta.name === pendingPreselect)
      pendingPreselect = undefined
      const table = new TablePanel(theme, {
        title: t('agentsmg.title'),
        columns: agentColumns(agents, (agent, key) => agentCellFor(effective)(agent, { key })),
        rows: agents,
        renderCell: agentCellFor(effective),
        preselect: preselectIndex !== undefined && preselectIndex >= 0 ? preselectIndex : undefined,
        footer: t('agentsmg.tableFooter'),
        // Defensive: an empty table (never shown, but guards the round-trip)
        // must not hand `undefined` to showFields.
        onSelect: agent => {
          if (agent !== undefined) showFields(agent)
        },
        onCancel: () => closeManager(),
        shortcuts: { l: showLimits },
      })
      host.open(table)
    }

    const closeManager = (): void => {
      host.close()
      restoreFocus()
      if (changed.length > 0) {
        const seededNote = seed.seeded > 0
          ? t('agentsmg.seededNote', { n: seed.seeded, dir: zcodeAgentsDir() })
          : ''
        resolve(t('agentsmg.updated', { list: changed.join(', '), note: seededNote }))
      } else {
        resolve(seed.seeded > 0
          ? t('agentsmg.seededOnly', { n: seed.seeded, dir: zcodeAgentsDir() })
          : undefined)
      }
    }

    const showFields = (agent: AgentFile): void => {
      const meta = agent.meta
      const eff = effective.get(meta.name)
      const content = (meta.description ?? t('agentsmg.noDescription')).split('\n')
      content.push(
        editTarget.kind === 'profile'
          ? t('agentsmg.target.profile', { name: editTarget.name })
          : t('agentsmg.target.frontmatter'),
      )
      const fields = [
        { key: 'model', value: eff?.model ?? t('agentsmg.inheritDefault'), editable: true },
        { key: 'thinking', value: eff?.thinking ?? t('agentsmg.inherit'), editable: true },
        { key: 'deep', value: String(meta.deep), editable: true },
      ]
      const view = new FieldPanel(theme, {
        title: agentTitle(theme, meta),
        content,
        fields,
        status: () => detailStatus,
        footer: t('agentsmg.fieldsFooter'),
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

    /** The agent meta as the user sees it: composed values feed the picker's
     *  preselect (a profile override is what the fields window shows). */
    const effectiveMeta = (agent: AgentFile): AgentMeta => {
      const eff = effective.get(agent.meta.name)
      return eff === undefined
        ? agent.meta
        : { ...agent.meta, model: eff.model, thinking: eff.thinking }
    }

    const changeModel = async (agent: AgentFile): Promise<void> => {
      const picked = await pickAgentModel(ctx, tui, theme, effectiveMeta(agent), host)
      if (picked === undefined) {
        showFields(agent)
        return
      }
      const result = commitAgentModelEdit(agent.meta.name, agent.path, {
        model: picked.model,
        thinking: picked.thinking,
      }, { startDir: cwd })
      if (result.error !== undefined) {
        detailStatus = `✘ ${result.error}`
        showFields(agent)
        return
      }
      if (result.target.kind === 'frontmatter') {
        agent.meta.model = picked.model
        agent.meta.thinking = picked.thinking ?? undefined
      }
      refreshEffective()
      if (!changed.includes(agent.meta.name)) changed.push(agent.meta.name)
      const thinkText = picked.thinking !== null ? t('agentsmg.thinkSuffix', { effort: picked.thinking }) : ''
      const scopeNote = result.target.kind === 'profile' ? t('agentsmg.scopeNote', { name: result.target.name }) : ''
      detailStatus = t('agentsmg.savedModel', { name: agent.meta.name, model: picked.model, think: thinkText, scope: scopeNote })
      showFields(agent)
    }

    const changeThinking = async (agent: AgentFile): Promise<void> => {
      const model = effective.get(agent.meta.name)?.model
      if (model === undefined) {
        detailStatus = t('agentsmg.error.noModel')
        showFields(agent)
        return
      }
      const llm = ctx.get('llm')
      if (llm === undefined) {
        detailStatus = t('agentsmg.error.noLlm')
        showFields(agent)
        return
      }
      const slash = model.indexOf('/')
      if (slash <= 0) {
        detailStatus = t('agentsmg.error.noThinkLevels', { model })
        showFields(agent)
        return
      }
      let efforts: readonly LlmReasoningEffortInfo[] | undefined
      try {
        efforts = (await llm.resolveModelInfo(model.slice(0, slash), model.slice(slash + 1))).reasoning?.efforts
      } catch {
        efforts = undefined
      }
      if (efforts === undefined || efforts.length === 0) {
        detailStatus = t('agentsmg.error.modelNoThink', { model })
        showFields(agent)
        return
      }
      const currentEffort = effective.get(agent.meta.name)?.thinking as ReasoningEffortId | undefined
      const chosen = await openEffortPicker(
        tui, theme, efforts, currentEffort, () => {}, () => fieldsHandle?.hide(),
      )
      if (chosen === undefined) {
        showFields(agent)
        return
      }
      const thinking = chosen.effort === 'default' ? null : chosen.effort
      const result = commitAgentModelEdit(agent.meta.name, agent.path, { thinking }, { startDir: cwd })
      if (result.error !== undefined) {
        detailStatus = `✘ ${result.error}`
        showFields(agent)
        return
      }
      if (result.target.kind === 'frontmatter') agent.meta.thinking = thinking ?? undefined
      refreshEffective()
      if (!changed.includes(agent.meta.name)) changed.push(agent.meta.name)
      const scopeNote = result.target.kind === 'profile' ? t('agentsmg.scopeNote', { name: result.target.name }) : ''
      detailStatus = t('agentsmg.savedThink', { name: agent.meta.name, effort: thinking ?? t('agentsmg.inheritWord'), scope: scopeNote })
      showFields(agent)
    }

    const showDeepEditor = (agent: AgentFile): void => {
      let committed = false
      const field = new EditField(tui, {
        title: t('agentsmg.deep.title', { name: agent.meta.displayName ?? agent.meta.name }),
        subtitle: t('agentsmg.deep.subtitle'),
        initial: String(agent.meta.deep),
        parse: parseDeepInput,
        onCommit: async parsed => {
          if (parsed.kind !== 'value') return undefined
          const n = parsed.value as number
          const error = updateAgentFrontmatter(agent.path, { deep: n })
          if (error !== undefined) return { error }
          agent.meta.deep = n
          committed = true
          return { notice: t('agentsmg.deep.saved', { n }) }
        },
        onDone: () => {
          // onDone fires on every terminal transition (commit, keep, Esc) —
          // only a real commit counts as a change.
          if (committed) {
            if (!changed.includes(agent.meta.name)) changed.push(agent.meta.name)
            detailStatus = t('agentsmg.deep.status', { name: agent.meta.name, n: agent.meta.deep })
          }
          showFields(agent)
        },
        onError: message => { detailStatus = `✘ ${message}` },
      }, theme)
      host.open(field)
    }

    const showBody = (agent: AgentFile): void => {
      host.open(new ViewerPanel(theme, {
        title: t('agentsmg.body.title', { name: agent.meta.displayName ?? agent.meta.name }),
        lines: agent.body.split('\n'),
        footer: t('agentsmg.body.footer'),
        onClose: () => showFields(agent),
      }))
    }

    /**
     * The subagent-limits panel: the live `maxAgents` / `maxRounds` values
     * (0 = unlimited), editable like the field rows, plus two READ-ONLY rows
     * mirroring the official dsh-subagent plugin's 0.1.7 caps
     * (`maxActiveSubagents` / `maxDepth`, read through the settings forms —
     * editable in /settings, not here; an unreadable entry shows n/a).
     * Esc returns to the table — from here the limits are reachable even
     * with no agent files at all.
     */
    const showLimits = (): void => {
      const limits = readSubagentLimits(ctx)
      const official = readOfficialSubagentLimits(ctx)
      const stats = getStats?.()
      const fields = [
        { key: 'maxAgents', value: t('agentsmg.limits.maxAgents', { n: limits.maxAgents }), editable: true },
        { key: 'maxRounds', value: t('agentsmg.limits.maxRounds', { n: limits.maxRounds }), editable: true },
        { key: 'maxRoundsGrace', value: t('agentsmg.limits.maxRoundsGrace', { n: limits.maxRoundsGrace }), editable: true },
        { key: 'disableSubagent', value: t('agentsmg.limits.disableSubagent', { value: limits.disableSubagent ? t('agentsmg.on') : t('agentsmg.off') }), editable: true },
        { key: 'registeredOnly', value: t('agentsmg.limits.registeredOnly', { value: limits.registeredOnly ? t('agentsmg.on') : t('agentsmg.off') }), editable: true },
        {
          key: 'maxActiveSubagents',
          value: t('agentsmg.limits.maxActiveSubagents', { n: official.maxActiveSubagents ?? t('agentsmg.limits.unread') }),
          editable: false,
        },
        {
          key: 'maxDepth',
          value: t('agentsmg.limits.maxDepth', { n: official.maxDepth ?? t('agentsmg.limits.unread') }),
          editable: false,
        },
      ]
      const content: string[] = [
        t('agentsmg.limits.intro'),
        t('agentsmg.limits.officialNote'),
        ...(stats !== undefined
          ? [t('agentsmg.limits.runtime', {
              live: stats.live,
              allowed: stats.allowed,
              denied: stats.denied,
              pruned: stats.pruned,
              inFlight: stats.inFlight,
            })]
          : []),
        ...(agents.length === 0
          ? [t('agentsmg.limits.noAgents', { dir }),
              ...(broken.length > 0 ? [t('agentsmg.limits.broken', { n: broken.length })] : [])]
          : []),
      ]
      const panel = new FieldPanel(theme, {
        title: ansiFg(theme.palette.accent) + BOLD + t('agentsmg.limits.title') + RESET,
        content,
        fields,
        status: () => limitsStatus,
        footer: t('agentsmg.limits.footer'),
        shortcuts: { d: () => void toggleDisableSubagent(), r: () => void toggleRegisteredOnly() },
        onEdit: index => {
          if (index === 3) toggleDisableSubagent()
          else if (index === 4) toggleRegisteredOnly()
          else if (index >= 5) {
            // Read-only mirror of the official subagent plugin's own config.
            limitsStatus = t('agentsmg.limits.officialReadOnly')
          }
          else editLimit(index === 0 ? 'maxAgents' : index === 1 ? 'maxRounds' : 'maxRoundsGrace')
        },
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
    const editLimit = (key: 'maxAgents' | 'maxRounds' | 'maxRoundsGrace'): void => {
      const current = readSubagentLimits(ctx)[key]
      let committed = false
      const field = new EditField(tui, {
        title: t('agentsmg.limit.title', { key, current }),
        subtitle: t('agentsmg.limit.subtitle'),
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
            limitsStatus = t('agentsmg.limit.saved', { key, n })
          }
          showLimits()
        },
        onError: message => { limitsStatus = `✘ ${message}` },
      }, theme)
      host.open(field)
    }

    /**
     * Toggle the native `subagent` tool on/off (Enter on the disableSubagent
     * row, or the `d` shortcut). Flips the live setting — the guard reads it
     * at the next subagent call, and the tool-hide applies to agents created
     * afterwards. The status line flashes the committed state.
     */
    const toggleDisableSubagent = async (): Promise<void> => {
      const next = !readSubagentLimits(ctx).disableSubagent
      const error = await writeSubagentLimit(ctx, 'disableSubagent', next)
      limitsStatus = error !== undefined
        ? `✘ ${error}`
        : next
          ? t('agentsmg.subagent.enabled')
          : t('agentsmg.subagent.disabled')
      showLimits()
    }

    /**
     * Toggle the registeredOnly fence (the `r` shortcut / the 5th field
     * row): on, every spawn tool except `use_agent` is denied, so children
     * may only ever be backed by a registered agent definition. The live
     * read means the next spawn call is already fenced.
     */
    const toggleRegisteredOnly = async (): Promise<void> => {
      const next = !readSubagentLimits(ctx).registeredOnly
      const error = await writeSubagentLimit(ctx, 'registeredOnly', next)
      limitsStatus = error !== undefined
        ? `✘ ${error}`
        : next
          ? t('agentsmg.fence.on')
          : t('agentsmg.fence.off')
      showLimits()
    }

    // No agent files? The manager still opens — straight into the limits
    // panel, so maxAgents/maxRounds stay configurable before any agent exists.
    if (agents.length === 0) showLimits()
    else showTable()
  })
}
