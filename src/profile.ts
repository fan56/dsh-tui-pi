/**
 * `/profile` + `/profiles` — user model profiles: named snapshots of the
 * whole model configuration (default model + think level, every subagent's
 * model/thinking) that switch in one step between contexts like work and
 * personal.
 *
 * Layers, all on the select-panel framework (src/panels.ts):
 *
 *   1. `/profile` switcher (TablePanel) — one row per profile (name |
 *      default model | think | agents), Enter applies it to the live
 *      selection AND the agent markdown files, Esc backs out.
 *   2. `/profiles` manager (TablePanel) — the roster: n new, d delete
 *      (double-press confirm), Enter opens the profile's fields.
 *   3. profile fields (FieldPanel) — model / think / agents rows plus the
 *      s save-current, r rename, v review shortcuts.
 *   4. agents sub-table (TablePanel) — every discovered agent's recorded
 *      model/thinking; Enter picks through the SAME favorites/hidden model
 *      table /model uses (pickModel with the shared PanelHost), i sets
 *      explicit inherit, t edits think alone.
 *
 * Every edit persists to `$DSH_HOME/model-profiles.json` immediately
 * (src/model-profiles.ts). Applying a profile writes the agent frontmatter
 * files (updateAgentFrontmatter) and the default model through the same
 * chain as /model: live bridge selection + persistDefaultModel.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { OverlayHandle, TUI } from '@earendil-works/pi-tui'
import {
  agentsDir,
  listAgentFiles,
  updateAgentFrontmatter,
  type AgentFile,
} from './agent-manager.ts'
import {
  captureAgentsSnapshot,
  createProfile,
  deleteProfile,
  findProfile,
  formatProfileRoute,
  loadModelProfiles,
  modelProfilesPath,
  planAgentApply,
  profileReviewLines,
  renameProfile,
  saveModelProfiles,
  type ModelProfile,
  type ModelProfilesDoc,
  type ProfileAgentEntry,
  type ProfileModelRoute,
} from './model-profiles.ts'
import { persistDefaultModel } from './session.ts'
import { openEffortPicker, pickModel } from './selectors.ts'
import { EditField, type ParseOutcome } from './settings.ts'
import {
  autoColumns,
  FieldPanel,
  PanelHost,
  TablePanel,
  type TableColumn,
  ViewerPanel,
} from './panels.ts'
import { ansiFg, BOLD, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'

/** Live-session handles the profile flows need (bridged in from index.ts). */
export interface ProfileDeps {
  getSelection(): ModelSelection | undefined
  setSelection(selection: ModelSelection): void
}

/** The profile table columns: NAME/MODEL/THINK fit (capped), AGENTS right-aligned tail. */
function profileColumns(
  profiles: readonly ModelProfile[],
  current: string | undefined,
): readonly TableColumn[] {
  return autoColumns(
    [
      { key: 'name', title: 'Profile', cap: 18 },
      { key: 'model', title: 'Default model', cap: 36 },
      { key: 'think', title: 'Think', cap: 10 },
      { key: 'agents', title: 'Agents', align: 'right' as const },
    ],
    profiles,
    (profile, key) => profileCell(profile, key, current),
  )
}

/** Cell text for one profile table row; the current profile gets the ● mark. */
function profileCell(profile: ModelProfile, key: string, current: string | undefined): string {
  switch (key) {
    case 'name': return current === profile.name ? `● ${profile.name}` : profile.name
    case 'model': return profile.defaultModel === undefined
      ? '(not set)'
      : `${profile.defaultModel.provider}/${profile.defaultModel.model}`
    case 'think': return profile.defaultModel?.reasoningEffort ?? 'default'
    default: return String(Object.keys(profile.agents).length)
  }
}

/** A profile's default route as a ModelSelection (the /model handler shape). */
function routeToSelection(route: ProfileModelRoute): ModelSelection {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort !== undefined
      ? { reasoningEffort: route.reasoningEffort as ReasoningEffortId }
      : {}),
  }
}

/** Record what a live selection says into a plain storable route. */
function selectionToRoute(selection: ModelSelection): ProfileModelRoute {
  return selection.reasoningEffort === undefined
    ? { provider: selection.provider, model: selection.model }
    : {
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
      }
}

/**
 * Apply `profile` end to end: default model + think level through the /model
 * chain (live selection ref + persisted default; a profile without a default
 * model leaves the current selection alone), every LISTED agent's
 * frontmatter through the snapshot semantics (src/model-profiles.ts), then
 * the current pointer and the store. Resolves the command summary text —
 * failures ride along as ⚠ parts instead of aborting the rest.
 */
async function applyProfile(
  ctx: Context,
  path: string,
  doc: ModelProfilesDoc,
  profile: ModelProfile,
  deps: ProfileDeps,
): Promise<string> {
  const parts: string[] = []
  if (profile.defaultModel !== undefined) {
    const selection = routeToSelection(profile.defaultModel)
    deps.setSelection(selection)
    const persistError = await persistDefaultModel(ctx, selection)
    if (persistError !== undefined) parts.push(`⚠ default model not persisted: ${persistError}`)
  }

  const { agents } = listAgentFiles(agentsDir())
  let updated = 0
  const failed: string[] = []
  for (const { agent, updates } of planAgentApply(profile, agents)) {
    const error = updateAgentFrontmatter(agent.path, updates)
    if (error === undefined) {
      agent.meta.model = updates.model ?? undefined
      agent.meta.thinking = updates.thinking ?? undefined
      updated++
    } else {
      failed.push(agent.meta.name)
    }
  }
  if (failed.length > 0) parts.push(`⚠ agents failed: ${failed.join(', ')}`)

  doc.current = profile.name
  const saveError = saveModelProfiles(path, doc)
  if (saveError !== undefined) parts.push(`⚠ profile not saved: ${saveError}`)

  const modelText = profile.defaultModel !== undefined
    ? formatProfileRoute(profile.defaultModel)
    : 'model unchanged'
  return [`Profile → ${profile.name} · ${modelText} · agents ${String(updated)} updated`, ...parts]
    .filter(part => part !== '')
    .join(' · ')
}

/**
 * Open the `/profile` switcher. Resolves the apply summary when a profile
 * was switched, or `undefined` when cancelled / nothing applied.
 */
export async function openProfileSwitcher(
  ctx: Context,
  tui: TUI,
  theme: TuiTheme,
  deps: ProfileDeps,
  restoreFocus: () => void,
): Promise<string | undefined> {
  const path = modelProfilesPath()
  const doc = loadModelProfiles(path)
  let settle: ((value: string | undefined) => void) | undefined

  const host = new PanelHost(tui, theme, message => {
    restoreFocus()
    settle?.(`✘ failed to open the profile switcher: ${message}`)
  })

  return new Promise(resolve => {
    settle = resolve
    // Enter can fire again while the async apply runs — resolve-once guard,
    // the same settle discipline the pickers use.
    let applying = false

    const table = new TablePanel(theme, {
      title: '● Model profiles',
      columns: profileColumns(doc.profiles, doc.current),
      rows: doc.profiles,
      renderCell: (profile, column) => profileCell(profile, column.key, doc.current),
      preselect: Math.max(0, doc.profiles.findIndex(profile => profile.name === doc.current)),
      onSelect: profile => { void switchTo(profile) },
      onCancel: () => { host.close(); restoreFocus(); resolve(undefined) },
      footer: '↑↓ navigate · Enter switch · Esc back',
    })
    if (host.open(table) === undefined) return

    const switchTo = async (profile: ModelProfile): Promise<void> => {
      if (applying) return
      applying = true
      const summary = await applyProfile(ctx, path, doc, profile, deps)
      host.close()
      restoreFocus()
      resolve(summary)
    }
  })
}

/**
 * Open the `/profiles` manager. Resolves a summary when anything changed,
 * or `undefined` when the manager closed untouched. `preselect` jumps
 * straight into one profile's fields window.
 */
export async function openProfileManager(
  ctx: Context,
  tui: TUI,
  theme: TuiTheme,
  deps: ProfileDeps,
  restoreFocus: () => void,
  preselect?: string,
): Promise<string | undefined> {
  const path = modelProfilesPath()
  const doc = loadModelProfiles(path)
  const changed: string[] = []
  let tableStatus: string | undefined
  let fieldsStatus: string | undefined
  let agentsStatus: string | undefined
  let pendingDelete: string | undefined
  let pendingPreselect = preselect
  let fieldsHandle: OverlayHandle | undefined
  let agentsHandle: OverlayHandle | undefined
  let agentsCursor: string | undefined
  /** Settles the manager promise (assigned inside the executor below). */
  let settle: ((value: string | undefined) => void) | undefined

  const host = new PanelHost(tui, theme, message => {
    restoreFocus()
    settle?.(`✘ failed to open the profiles manager: ${message}`)
  })

  /** Persist the working doc; resolves a ✘ status line on failure. */
  const persistDoc = (): string | undefined => {
    const error = saveModelProfiles(path, doc)
    return error === undefined ? undefined : `✘ could not save profiles: ${error}`
  }

  /** Mark one profile as touched for the closing summary (first touch wins). */
  const markChanged = (name: string): void => {
    if (!changed.includes(name)) changed.push(name)
  }

  return new Promise(resolve => {
    settle = resolve

    const showTable = (): void => {
      const preselectIndex = pendingPreselect === undefined
        ? undefined
        : doc.profiles.findIndex(profile => profile.name === pendingPreselect)
      pendingPreselect = undefined
      const table = new TablePanel(theme, {
        title: '● Model profiles — configure',
        columns: profileColumns(doc.profiles, doc.current),
        rows: doc.profiles,
        renderCell: (profile, column) => profileCell(profile, column.key, doc.current),
        preselect: preselectIndex !== undefined && preselectIndex >= 0 ? preselectIndex : undefined,
        status: () => tableStatus,
        footer: '↑↓ navigate · Enter open · n new · d delete · Esc back',
        onSelect: profile => showFields(profile),
        onCancel: closeManager,
        shortcuts: {
          n: showNew,
          d: () => {
            const profile = table.selectedRow()
            if (profile === undefined) return
            if (pendingDelete === profile.name) {
              pendingDelete = undefined
              const error = deleteProfile(doc, profile.name)
              if (error !== undefined) tableStatus = `✘ ${error}`
              else {
                tableStatus = persistDoc() ?? `deleted profile "${profile.name}"`
                markChanged(`-${profile.name}`)
              }
            } else {
              pendingDelete = profile.name
              tableStatus = `press d again to delete "${profile.name}"`
            }
            showTable()
          },
        },
      })
      host.open(table)
    }

    const closeManager = (): void => {
      host.close()
      restoreFocus()
      resolve(changed.length > 0 ? `Profiles updated: ${changed.join(', ')}` : undefined)
    }

    const showFields = (profile: ModelProfile): void => {
      const content = [
        `named model snapshot — switch with /profile · applies ${agentsDir()}`,
      ]
      const agentsSet = Object.keys(profile.agents).length
      const fields = [
        {
          key: 'model',
          value: profile.defaultModel === undefined
            ? '(not set — switching keeps the current model)'
            : formatProfileRoute(profile.defaultModel),
          editable: true,
        },
        {
          key: 'think',
          value: profile.defaultModel?.reasoningEffort ?? '(provider default)',
          editable: true,
        },
        { key: 'agents', value: `${String(agentsSet)} agent override(s) recorded`, editable: true },
      ]
      const view = new FieldPanel(theme, {
        title: profileTitle(theme, profile, doc),
        content,
        fields,
        status: () => fieldsStatus,
        footer: '↑↓ field · Enter edit (m model · t think · a agents) · s save current · r rename · v review · Esc back',
        shortcuts: {
          m: () => void changeModel(profile),
          t: () => void changeThink(profile),
          a: () => showAgentsTable(profile),
          s: () => saveFromCurrent(profile),
          r: () => showRename(profile),
          v: () => showReview(profile),
        },
        onEdit: index => {
          if (index === 0) void changeModel(profile)
          else if (index === 1) void changeThink(profile)
          else showAgentsTable(profile)
        },
        onCancel: () => showTable(),
      })
      fieldsHandle = host.open(view)
    }

    /** Commit path shared by model/think/agent edits: flash and re-show. */
    const writeFields = (profile: ModelProfile, status: string | undefined, message: string): void => {
      if (status !== undefined) fieldsStatus = status
      else {
        markChanged(profile.name)
        fieldsStatus = message
      }
      showFields(profile)
    }

    const changeModel = async (profile: ModelProfile): Promise<void> => {
      const current = profile.defaultModel === undefined ? undefined : routeToSelection(profile.defaultModel)
      const picked = await pickModel(ctx, tui, theme, current, () => {}, host)
      if (picked === undefined) {
        showFields(profile)
        return
      }
      profile.defaultModel = selectionToRoute(picked)
      const status = persistDoc()
      writeFields(profile, status, `saved ${profile.name} default model → ${formatProfileRoute(profile.defaultModel)}`)
    }

    const changeThink = async (profile: ModelProfile): Promise<void> => {
      if (profile.defaultModel === undefined) {
        fieldsStatus = '✘ no default model set — pick a model first (m)'
        showFields(profile)
        return
      }
      const llm = ctx.get('llm')
      if (llm === undefined) {
        fieldsStatus = '✘ llm service unavailable'
        showFields(profile)
        return
      }
      const { provider, model } = profile.defaultModel
      let efforts
      try {
        efforts = (await llm.resolveModelInfo(provider, model)).reasoning?.efforts
      } catch {
        efforts = undefined
      }
      if (efforts === undefined || efforts.length === 0) {
        fieldsStatus = `✘ ${provider}/${model} exposes no think levels`
        showFields(profile)
        return
      }
      const currentEffort = profile.defaultModel.reasoningEffort as ReasoningEffortId | undefined
      const chosen = await openEffortPicker(
        tui, theme, efforts, currentEffort, () => {}, () => fieldsHandle?.hide(),
      )
      if (chosen === undefined) {
        showFields(profile)
        return
      }
      profile.defaultModel.reasoningEffort = chosen.effort === 'default' ? undefined : chosen.effort
      const status = persistDoc()
      const thinkText = profile.defaultModel.reasoningEffort === undefined
        ? 'provider default'
        : `think ${String(profile.defaultModel.reasoningEffort)}`
      writeFields(profile, status, `saved ${profile.name} think → ${thinkText}`)
    }

    const saveFromCurrent = (profile: ModelProfile): void => {
      const selection = deps.getSelection()
      if (selection !== undefined) profile.defaultModel = selectionToRoute(selection)
      const { agents } = listAgentFiles(agentsDir())
      profile.agents = captureAgentsSnapshot(agents)
      const status = persistDoc()
      const message = selection === undefined
        ? `saved ${String(agents.length)} agent(s) into "${profile.name}" · no live model selection — default model kept`
        : `saved current configuration into "${profile.name}" (model + ${String(agents.length)} agent(s))`
      writeFields(profile, status, message)
    }

    const showAgentsTable = (profile: ModelProfile): void => {
      const { agents } = listAgentFiles(agentsDir())
      const rows: Array<{ agent: AgentFile; entry: ProfileAgentEntry | undefined }> =
        agents.map(agent => ({ agent, entry: profile.agents[agent.meta.name] }))
      const cell = (row: { agent: AgentFile; entry: ProfileAgentEntry | undefined }, key: string): string => {
        switch (key) {
          case 'name': return row.agent.meta.displayName ?? row.agent.meta.name
          case 'model': return row.entry?.model ?? (row.entry === undefined ? '(not saved)' : '(inherit)')
          default: return row.entry?.thinking ?? 'inherit'
        }
      }
      const table = new TablePanel(theme, {
        title: `● Agents — ${profile.name}`,
        columns: autoColumns(
          [
            { key: 'name', title: 'Agent', cap: 16 },
            { key: 'model', title: 'Model', cap: 36 },
            { key: 'thinking', title: 'Think', cap: 10 },
          ],
          rows,
          cell,
        ),
        rows,
        renderCell: (row, column) => cell(row, column.key),
        preselect: Math.max(0, rows.findIndex(row => row.agent.meta.name === agentsCursor)),
        status: () => agentsStatus,
        footer: '↑↓ navigate · Enter pick model (i inherit · t think) · Esc back',
        onSelect: row => {
          agentsCursor = row.agent.meta.name
          void pickAgentModel(profile, row)
        },
        onCancel: () => showFields(profile),
        shortcuts: {
          i: () => {
            const row = table.selectedRow()
            if (row === undefined) return
            profile.agents[row.agent.meta.name] = {}
            const status = persistDoc()
            agentsStatus = status ?? `saved ${row.agent.meta.name} → inherit`
            if (status === undefined) markChanged(profile.name)
            showAgentsTable(profile)
          },
          t: () => {
            const row = table.selectedRow()
            if (row === undefined) return
            void changeAgentThinking(profile, row)
          },
        },
      })
      agentsHandle = host.open(table)
    }

    /** Pick one agent's model + think through the full /model picker. */
    const pickAgentModel = async (
      profile: ModelProfile,
      row: { agent: AgentFile; entry: ProfileAgentEntry | undefined },
    ): Promise<void> => {
      const current = row.entry?.model === undefined
        ? undefined
        : selectionFromRoute(row.entry.model, row.entry.thinking)
      const picked = await pickModel(ctx, tui, theme, current, () => {}, host)
      if (picked === undefined) {
        showAgentsTable(profile)
        return
      }
      profile.agents[row.agent.meta.name] = picked.reasoningEffort === undefined
        ? { model: `${picked.provider}/${picked.model}` }
        : { model: `${picked.provider}/${picked.model}`, thinking: picked.reasoningEffort }
      const status = persistDoc()
      const entry = profile.agents[row.agent.meta.name]
      const thinkText = entry.thinking === undefined ? '' : ` · think ${entry.thinking}`
      agentsStatus = status ?? `saved ${row.agent.meta.name} → ${entry.model ?? ''}${thinkText}`
      if (status === undefined) markChanged(profile.name)
      showAgentsTable(profile)
    }

    /** Edit one agent's think level alone (its recorded model must be set). */
    const changeAgentThinking = async (
      profile: ModelProfile,
      row: { agent: AgentFile; entry: ProfileAgentEntry | undefined },
    ): Promise<void> => {
      const route = row.entry?.model
      if (route === undefined) {
        agentsStatus = '✘ no model recorded — pick a model first (Enter)'
        showAgentsTable(profile)
        return
      }
      const llm = ctx.get('llm')
      if (llm === undefined) {
        agentsStatus = '✘ llm service unavailable'
        showAgentsTable(profile)
        return
      }
      const slash = route.indexOf('/')
      if (slash <= 0) {
        agentsStatus = `✘ cannot resolve think levels for ${route}`
        showAgentsTable(profile)
        return
      }
      let efforts
      try {
        efforts = (await llm.resolveModelInfo(route.slice(0, slash), route.slice(slash + 1))).reasoning?.efforts
      } catch {
        efforts = undefined
      }
      if (efforts === undefined || efforts.length === 0) {
        agentsStatus = `✘ ${route} exposes no think levels`
        showAgentsTable(profile)
        return
      }
      const entry = profile.agents[row.agent.meta.name] ?? {}
      const currentEffort = entry.thinking as ReasoningEffortId | undefined
      const chosen = await openEffortPicker(
        tui, theme, efforts, currentEffort, () => {}, () => agentsHandle?.hide(),
      )
      if (chosen === undefined) {
        showAgentsTable(profile)
        return
      }
      const next = chosen.effort === 'default' ? undefined : chosen.effort
      if (next === undefined) delete entry.thinking
      else entry.thinking = next
      profile.agents[row.agent.meta.name] = entry
      const status = persistDoc()
      agentsStatus = status ?? `saved ${row.agent.meta.name} → think ${next ?? 'inherit'}`
      if (status === undefined) markChanged(profile.name)
      showAgentsTable(profile)
    }

    const showRename = (profile: ModelProfile): void => {
      let committed = false
      const field = new EditField(tui, {
        title: `Rename profile — ${profile.name}`,
        subtitle: 'letters, digits, dash, space · must stay unique',
        initial: profile.name,
        parse: text => parseProfileName(doc, profile.name, text),
        onCommit: async parsed => {
          if (parsed.kind !== 'value') return undefined
          const name = parsed.value as string
          const error = renameProfile(doc, profile.name, name)
          if (error !== undefined) return { error }
          committed = true
          pendingPreselect = name
          return undefined
        },
        onDone: () => {
          if (committed) {
            const status = persistDoc()
            tableStatus = status ?? `renamed → ${profile.name}`
            if (status === undefined) markChanged(profile.name)
          }
          showTable()
        },
        onError: message => { tableStatus = `✘ ${message}` },
      }, theme)
      host.open(field)
    }

    const showNew = (): void => {
      let committed = false
      const field = new EditField(tui, {
        title: 'New model profile',
        subtitle: 'a name like "work" or "personal" · configured next',
        initial: '',
        parse: text => parseProfileName(doc, '', text),
        onCommit: async parsed => {
          if (parsed.kind !== 'value') return undefined
          const { profile, error } = createProfile(doc, parsed.value as string)
          if (error !== undefined || profile === undefined) return { error: error ?? 'create failed' }
          committed = true
          pendingPreselect = profile.name
          return undefined
        },
        onDone: () => {
          if (committed) {
            const status = persistDoc()
            tableStatus = status ?? `created profile "${pendingPreselect}"`
            if (status === undefined && pendingPreselect !== undefined) markChanged(`+${pendingPreselect}`)
          }
          showTable()
        },
        onError: message => { tableStatus = `✘ ${message}` },
      }, theme)
      host.open(field)
    }

    const showReview = (profile: ModelProfile): void => {
      const { agents } = listAgentFiles(agentsDir())
      host.open(new ViewerPanel(theme, {
        title: `ⓘ Model profile — ${profile.name}`,
        lines: profileReviewLines(profile, agents, doc.current === profile.name),
        footer: '  Esc to close',
        onClose: () => showFields(profile),
      }))
    }

    showTable()
  })
}

/** The accent title line of the profile fields window (current profiles get the ● mark). */
function profileTitle(theme: TuiTheme, profile: ModelProfile, doc: ModelProfilesDoc): string {
  const mark = doc.current === profile.name ? '● ' : ''
  return ansiFg(theme.palette.accent) + BOLD + `${mark}${clipToWidth(profile.name, 100)}` + RESET
}

/** Name-editor parse: trimmed non-empty, unique against the doc (case-insensitive). */
function parseProfileName(doc: ModelProfilesDoc, currentName: string, text: string): ParseOutcome {
  const name = text.trim()
  if (name === '') return { kind: 'error', error: 'profile name must not be empty' }
  if (name.length > 32) return { kind: 'error', error: 'profile name must stay under 33 characters' }
  if (name.toLowerCase() !== currentName.toLowerCase() && findProfile(doc, name) !== undefined) {
    return { kind: 'error', error: `a profile named "${name}" already exists` }
  }
  return { kind: 'value', value: name }
}

/** An agent entry's `provider/model` route back into a picker preselection. */
function selectionFromRoute(route: string, thinking: string | undefined): ModelSelection {
  const slash = route.indexOf('/')
  if (slash <= 0) return { provider: route, model: route }
  return {
    provider: route.slice(0, slash),
    model: route.slice(slash + 1),
    ...(thinking !== undefined ? { reasoningEffort: thinking as ReasoningEffortId } : {}),
  }
}
