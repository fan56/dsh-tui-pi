/**
 * dsh-tui-pi — pi-style terminal UI for DeepSeek Harness.
 *
 * Cordis plugin entry, mounted as a dsh profile bundle (`dsh.bundle.patch`).
 * The TUI runs in-process inside the dsh tree: it renders with
 * `@earendil-works/pi-tui`, talks to dsh services directly (ctx.agents,
 * ctx.commands, session events), and keeps dsh's slash commands untouched.
 *
 * @module dsh-tui-pi
 */

import type { Context } from '@deepseek-ai/cordis'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Loader } from '@earendil-works/pi-tui'
import { CommandService, type LocalCommandHandler } from './commands.ts'
import { FooterHint, PowerlineFooter, type FooterDataSource, type FooterHints } from './footer.ts'
import { GitBranchWatcher } from './git.ts'
import { ensureAppendSystemFile, dshHome, migrateAgentsMdTodoSection } from './append-system.ts'
import { TranscriptRenderer } from './messages.ts'
import type { PanelHeight } from './activity.ts'
import { AGENT_TICK_MS, LiveWidgets } from './live-widgets.ts'
import { displayPermissionPreset } from './permission.ts'
import { pickEffort, pickModel, pickPermission, pickTheme } from './selectors.ts'
import { runModelSync } from './model-sync.ts'
import { DshSessionBridge, persistDefaultModel, stashSessionIdForReload, takeStashedSessionId, type BridgeCallbacks } from './session.ts'
import {
  currentThemePreference,
  readFooterHintsPreference,
  readIconSetPreference,
  readPanelHeightPreference,
  readSubagentLimits,
  readThemePreference,
  registerThemeSettings,
  writeThemePreference,
} from './theme-settings.ts'
import { applyIconSet, resolveIconSet, stopIcon, type IconSet } from './icons.ts'
import { detectNerdFontAvailable } from './font-detect.ts'
import { openAgentManager } from './agents.ts'
import { openSettingsBrowser } from './settings.ts'
import { openSkillsManagerPanel } from './skills-manager.ts'
import { openLoginFlow, openLogoutFlow } from './login.ts'
import { reloadPlugin } from './reload.ts'
import { inspectPersistedSession, pickPersistedSession, showSessionInfo } from './sessions.ts'
import { applySubagentPolicy } from './subagent-policy.ts'
import { openSubagentViewer } from './subagent-viewer.ts'
import { commandUsagePath, CommandUsageTracker } from './usage.ts'
import type { AgentView } from './dsh-events.ts'
import { ansiFg, BOLD, darkTheme, lightTheme, RESET, resolveTheme, type ThemePreference, type TuiTheme } from './theme/index.ts'
import { rgbIsLight } from './theme/palette.ts'
import { clipToWidth } from './text.ts'
import { type KeyAction } from './keymap.ts'
import { keybindingsPath, loadKeyBindings, openHotkeysManager } from './hotkeys.ts'
import { startTui, type TuiHandle } from './tui.ts'

export const name = 'dsh-tui-pi'

/**
 * Delay (ms) before a double-Ctrl+C quit actually fires — a held key's first
 * auto-repeat lands inside the 500ms double-press window looking like a
 * deliberate second press, and a follow-up `key-repeat` (arriving within
 * ~30-50ms) aborts the quit before this timer ever fires.
 */
const QUIT_CONFIRM_MS = 200

/**
 * Delay (ms) before the double-Esc stop actually fires — the same held-key
 * defence as the Ctrl+C quit: the OS repeat delay (~183ms-2s) puts the first
 * auto-repeat of a held Esc exactly at the 500ms stop-window boundary; the
 * stop is confirmed for this long and a follow-up `key-repeat` (betraying
 * the held key) aborts it. A second HUMAN-speed press during the window
 * fires the stop immediately (see `interrupt-cancel`).
 */
const STOP_CONFIRM_MS = 200

/** The TUI drives the agent factory and registers slash commands. */
export const inject = ['agents', 'commands']

export function apply(ctx: Context): void {
  let handle: TuiHandle | undefined
  // APPEND_SYSTEM.md (pi's convention; dsh side ~/.dsh/APPEND_SYSTEM.md): a
  // user-editable file appended to the system prompt of the MAIN agent this
  // TUI creates - and to no subagent (an orchestrator identity riding on the
  // children defeats its own purpose). The section is registered on the
  // agent's scoped context inside DshSessionBridge's create/resume setup
  // (see installAppendSystem in session.ts); the text provider reads the
  // file at each assembly, so edits apply to the next request without a
  // restart or watcher, and empty content contributes nothing.
  //
  // The TUI's own todo-lifecycle guidance rides the same file (idempotent
  // marker); a fresh file is seeded with the orchestrator template. The
  // legacy AGENTS.md delivery is migrated out. All best-effort.
  void ensureAppendSystemFile()
  void migrateAgentsMdTodoSection()
  /**
   * Live theme hot-reload sink, wired to the settings watch hook: a committed
   * `dsh-tui` theme change (this TUI's /theme write included) is applied to
   * the running TUI. Set inside runTui once the renderer exists; the first
   * commit can only follow a user write, long after startup.
   */
  let applyThemeRef: ((pref: ThemePreference) => void) | undefined
  /**
   * Live panel-height hot-reload sink, wired to the same watch hook: a
   * committed `dsh-tui` panelHeight change re-budgets the fixed think/tool
   * panels above the chat input. Armed inside runTui once the widgets exist.
   */
  let applyPanelHeightRef: ((height: PanelHeight) => void) | undefined
  /**
   * Live footer-hints hot-reload sink, wired to the same watch hook: a
   * committed `dsh-tui` footerHints change repaints the footer hint bar with
   * the new segment selection. Armed inside runTui once the TUI exists.
   */
  let applyFooterHintsRef: ((hints: FooterHints) => void) | undefined
  /**
   * Live icon-set hot-reload sink, wired to the same watch hook: a committed
   * `dsh-tui` iconSet change re-resolves the risky glyphs (an 'auto' change
   * resolves against the startup font-detection snapshot) and repaints the
   * footer/notices/panels that carry them. Armed inside runTui once the TUI
   * exists.
   */
  let applyIconSetRef: ((set: IconSet) => void) | undefined

  ctx.effect(async () => {
    // The theme bundle is built once at TUI startup and held by every
    // component, so the persisted preference must land before startTui — the
    // namespace registration rides the settings injection fiber and the read
    // awaits it (bounded, degrades to the defaults without a settings
    // service). The registration also watches the namespace: `applies:
    // 'live'`, so later commits (the /theme picker, the /settings browser, an
    // external edit) hot-apply through applyThemeRef / applyPanelHeightRef /
    // applyFooterHintsRef.
    // Panel height FIRST, theme second: a single commit of both fields (a
    // namespace-level reset, an external edit) must not replay at the wrong
    // height. setPanelHeight re-budgets the fixed think/tool panels; the
    // setTheme replay that follows already renders at that new height.
    // applyTheme carries the theme-bundle identity guard, so a height-only
    // commit never triggers a second rebuild.
    registerThemeSettings(ctx, (pref, height, footerHints, iconSet) => {
      applyPanelHeightRef?.(height)
      applyThemeRef?.(pref)
      applyFooterHintsRef?.(footerHints)
      applyIconSetRef?.(iconSet)
    })
    const themePreference = await readThemePreference(ctx)
    const panelHeight = await readPanelHeightPreference(ctx)
    const footerHints = await readFooterHintsPreference(ctx)
    // Icon-set self-adaptation: probe the platform once at startup (the
    // memoised snapshot shared with every later 'auto' resolution), resolve
    // the persisted mode against it and push the result into src/icons.ts
    // BEFORE the TUI's first frame — so the footer renders the right
    // separator from frame one, never a late plain→powerline flicker.
    const iconSetPreference = await readIconSetPreference(ctx)
    const nerdfontAvailable = await detectNerdFontAvailable()
    applyIconSet(resolveIconSet(iconSetPreference, nerdfontAvailable))
    let disposer: (() => void) | undefined
    try {
      disposer = runTui(themePreference, panelHeight, footerHints, nerdfontAvailable)
    } catch (error) {
      // An async-effect failure after startTui would otherwise orphan the
      // terminal in raw mode — the disposer never registers, so nothing ever
      // restores the TTY. Clean up and rethrow so cordis logs the error
      // instead of silently leaking the TUI.
      handle?.dispose()
      handle = undefined
      throw error
    }
    return disposer
  }, 'dsh-tui-pi.render')

  /**
   * Build the TUI and its slash commands for the resolved theme preference,
   * panel height and footer-hint selection. Declared as a hoisted function so
   * the effect body stays a thin wrapper: the whole build runs inside the
   * try/catch above, so any failure disposes the TUI handle before the error
   * reaches cordis. Returns the effect disposer handed back to cordis on
   * teardown.
   */
  function runTui(themePreference: ThemePreference, panelHeight: PanelHeight, footerHints: FooterHints, nerdfontAvailable: boolean): () => void {
    // User keybindings (`~/.dsh/keybindings.json`): a partial map of the app
    // keys, read once per TUI start — `/reload` re-runs apply() and re-reads
    // it. Broken entries surface as notices instead of breaking startup.
    const keyFile = keybindingsPath(dshHome())
    const keyBindings = loadKeyBindings(keyFile)
    const ui = startTui({
      onSubmit: text => {
        void submit(text)
      },
      keyBindings: keyBindings.bindings,
      // App-level keys (pi interrupt chain): Esc on a running task is a
      // deliberate double-press — the first press arms the window (with
      // feedback), the second within 500ms stops the whole task (parent +
      // subagents); popup/autocomplete first, anti-misfire no-op on a
      // non-empty editor, and an empty idle editor double-Esc opens /session.
      // Ctrl+C cancels a running turn or clears the editor — a second press
      // within 500ms quits — and Ctrl+D quits only on an empty editor.
      // Ctrl+G opens the subagent picker while children run. All decisions
      // live in keymap.ts.
      isRunning: () => bridge.isRunning(),
      getRunningAgents: () => bridge.getLiveChildren().length,
      onKeyAction: (action: KeyAction) => {
        switch (action.kind) {
          case 'interrupt-arm-stop':
            // First Esc while the task runs: the stop is ARMED, not fired —
            // a second Esc within the window confirms it, so a stray Esc can
            // never kill a running turn. The notice keeps the armed first
            // press from feeling dead and states the contract explicitly.
            renderer.renderNotice('Press Esc again to stop the current task', 'info')
            break
          case 'interrupt-cancel': {
            // Second Esc while the task runs (parent + subagents). Like the
            // Ctrl+C quit, the stop is CONFIRMED, not immediate: a held
            // Esc's FIRST auto-repeat lands at the OS repeat delay (right at
            // the 500ms window boundary) looking exactly like a deliberate
            // second press. The stop fires after STOP_CONFIRM_MS unless a
            // follow-up `key-repeat` aborts it (a repeat betrays a held key),
            // while another HUMAN-speed press during the window stops right
            // away. The '⏹ stopping…' notice renders now, so the visible
            // feedback is immediate even though the cancellation (and its
            // '⏹ canceling current turn…' notice inside `stopTask`) is
            // deferred by the confirm window.
            if (stopConfirmTimer !== undefined) {
              clearTimeout(stopConfirmTimer)
              stopConfirmTimer = undefined
              void stopTask()
              break
            }
            renderer.renderNotice(`${stopIcon()} stopping — Esc was double-pressed`, 'info')
            stopConfirmTimer = setTimeout(() => {
              stopConfirmTimer = undefined
              void stopTask()
            }, STOP_CONFIRM_MS)
            break
          }
          case 'ctrl-c-cancel': {
            // First Ctrl+C mid-turn: cancel straight away with the same
            // on-screen feedback as Esc ×2 (mirrors the web client's stop
            // button; keepInbox preserves the queue).
            void stopTask()
            break
          }
          case 'interrupt-double':
            // Double-Esc on an empty editor: pi's default double action is
            // /tree; dsh has no /tree, so this opens /session (the session
            // info panel — the closest non-invasive analogue).
            void sessionHandler('', new AbortController().signal)
            break
          case 'ctrl-c-clear':
            // First Ctrl+C while idle: clear the editor (pi app.clear); a
            // second press within 500ms quits.
            ui.editor.setText('')
            ui.requestRender()
            break
          case 'ctrl-c-quit': {
            // Double Ctrl+C quits — but a held key must not. The terminal
            // re-sends a held Ctrl+C every ~30-50ms after the OS repeat delay,
            // and the FIRST repeat can land inside the 500ms double-press
            // window looking exactly like a deliberate second press. So the
            // quit is confirmed, not immediate: it fires after
            // QUIT_CONFIRM_MS unless a `key-repeat` arrives (a repeat betrays
            // a held key → abort), while another HUMAN-speed press during the
            // window (a deliberate mash) quits right away.
            if (quitConfirmTimer !== undefined) {
              clearTimeout(quitConfirmTimer)
              quitConfirmTimer = undefined
              void disposeAndExit(0)
              break
            }
            renderer.renderNotice(`${stopIcon()} Ctrl+C ×2 — quitting…`, 'info')
            quitConfirmTimer = setTimeout(() => {
              quitConfirmTimer = undefined
              void disposeAndExit(0)
            }, QUIT_CONFIRM_MS)
            break
          }
          case 'key-repeat':
            // Auto-repeat of a held key — betrays a hold, never a double:
            // abort a pending Ctrl+C quit confirmation and/or a pending
            // double-Esc stop confirmation.
            if (action.key === 'ctrl-c' && quitConfirmTimer !== undefined) {
              clearTimeout(quitConfirmTimer)
              quitConfirmTimer = undefined
              renderer.renderNotice('quit aborted — Ctrl+C was held, not double-pressed', 'info')
            }
            if (action.key === 'escape' && stopConfirmTimer !== undefined) {
              clearTimeout(stopConfirmTimer)
              stopConfirmTimer = undefined
              renderer.renderNotice('stop aborted — Esc was held, not double-pressed', 'info')
            }
            break
          case 'ctrl-d-quit':
            void disposeAndExit(0)
            break
          case 'model-picker':
            // Ctrl+L: pi app.model.select — open the model/think picker.
            void modelHandler('', new AbortController().signal)
            break
          case 'subagent-viewer':
            // Ctrl+G: open the subagent picker → transcript viewer while
            // children run (modal overlay; Esc / double-x closes).
            void openSubagentViewer(ctx, ui.tui, ui.theme, bridge, () => ui.tui.setFocus(ui.editor))
            break
          default:
            break
        }
      },
      themePreference,
    })
    handle = ui
    // Live theme preference, tracked so terminal-following (below) can tell
    // 'auto' (follow the terminal) from an explicit light/dark pin.
    let themePreferenceRef: ThemePreference = themePreference
    /**
     * Pending Ctrl+C quit confirmation (see the `ctrl-c-quit` case): armed by
     * a double press, fired after QUIT_CONFIRM_MS, aborted by a `key-repeat`
     * (held key) or torn down with the TUI.
     */
    let quitConfirmTimer: ReturnType<typeof setTimeout> | undefined
    /**
     * Pending double-Esc stop confirmation (see the `interrupt-cancel` case):
     * armed by the second Esc while running, fired after STOP_CONFIRM_MS,
     * aborted by a `key-repeat` (held key) or torn down with the TUI. The
     * Ctrl+C quit and the Esc stop never share a timer — distinct keys, both
     * could theoretically be in flight.
     */
    let stopConfirmTimer: ReturnType<typeof setTimeout> | undefined
    /**
     * Stop the whole task (parent turn + subagents), mirroring the web
     * client's stop button: `agent.cancel({ kind: 'user' }, { keepInbox:
     * true })` via the bridge. Deferred by the confirm windows above (the
     * ESC/Ctrl+C double-press guards); the notice renders immediately.
     */
    const stopTask = async (): Promise<void> => {
      renderer.renderNotice(`${stopIcon()} canceling current turn…`, 'info')
      const cancelled = await bridge.cancelActiveTurn()
      // State raced idle between the decision and the cancel call — nothing
      // to cancel (e.g. the turn settled inside the confirm window).
      if (!cancelled) renderer.renderNotice('Nothing running to cancel.', 'info')
    }
    // Arm the settings watch sink now that the renderer exists (see apply()).
    applyThemeRef = (pref: ThemePreference): void => {
      themePreferenceRef = pref
      // 'auto' subscribes to the terminal's live color-scheme pushes; an
      // explicit pin opts out. resolveTheme guards env-pinned displays.
      ui.tui.setTerminalColorSchemeNotifications(pref === 'auto')
      applyTheme(resolveTheme(process.env, pref))
    }

    const renderer = new TranscriptRenderer(ui.transcript, ui.theme, () => ui.requestRender())
    // Startup notices for a broken/misleading keybindings file — the TUI keeps
    // running with defaults; the panel shows the same warnings via /hotkeys.
    for (const warning of keyBindings.warnings) {
      renderer.renderNotice(`keybindings: ${warning}`, 'error')
    }
    // Live widgets, pinned around the chat window: the Todos panel plus the
    // fixed think/tool status panels ABOVE the input (one of each, refreshed
    // in place, hidden while empty), and the running-agent activity merged
    // into the last-request area BELOW the editor. Owned here — fed by
    // session events and the bridge's subagent fold, ticked by the live
    // timer, recolored by applyTheme.
    const liveWidgets = new LiveWidgets(
      ui.widgets, ui.lastRequest, ui.theme, () => ui.requestRender(), panelHeight,
      // Live maxRounds for the compact running-agent lines' `round N/M` — read
      // at every rebuild (the /agents limits panel hot-applies).
      () => readSubagentLimits(ctx).maxRounds,
    )
    // Arm the panel-height watch sink now that the widgets exist: a committed
    // panelHeight change re-budgets the think/tool panels — they are
    // self-drawing, so the next frame already renders at the new height.
    applyPanelHeightRef = (height: PanelHeight): void => {
      liveWidgets.setPanelHeight(height)
    }

    // Terminal resize: pi-tui re-renders every component at the new columns,
    // but bordered panel rows were padded to the OLD box width — a narrowing
    // terminal wraps every row and shatters the fixed-height panels. Relayout
    // the transcript (replay-buffer rebuild) on the next frame: pi-tui's own
    // resize render is nextTick + 16ms throttled, so the rebuilt panels win
    // the race and the first new-width frame is already intact. The trailing
    // 0ms timer coalesces resize-event storms from terminal drags. The
    // listener is per-runTui and removed in the effect disposer below, so a
    // /reload never leaks one.
    let relayoutTimer: NodeJS.Timeout | undefined
    const onResize = (): void => {
      if (relayoutTimer !== undefined) clearTimeout(relayoutTimer)
      relayoutTimer = setTimeout(() => {
        relayoutTimer = undefined
        renderer.relayout()
      }, 0)
    }
    process.stdout.on('resize', onResize)

    // Working/idle indicator in the fixed dock (hidden while idle).
    let loader: Loader | undefined
    let agentStatus: 'idle' | 'running' = 'idle'
    const setStatus = (status: 'idle' | 'running'): void => {
      agentStatus = status
      if (status === 'running') {
        if (loader === undefined) {
          loader = new Loader(
            ui.tui,
            text => BOLD + ansiFg(ui.theme.palette.accent) + text + RESET,
            text => BOLD + ansiFg(ui.theme.palette.accent) + text + RESET,
            'working…',
          )
          ui.status.addChild(loader)
          loader.start()
        }
      } else if (loader !== undefined) {
        loader.stop()
        ui.status.removeChild(loader)
        loader = undefined
        ui.requestRender()
      }
    }

    // Permission knob events (preset switch, sandbox mode, approval policy)
    // paint nothing in the transcript — they only change the editor's
    // permission badge — so the renderer's default no-op must be compensated
    // with a repaint request here. The badge reads the cached current preset
    // (see the provider below), so a knob change must refresh the cache too.
    const PERMISSION_KNOB_EVENTS = new Set(['permission/preset', 'sandbox/mode', 'approval/policy'])
    const bridgeCallbacks: BridgeCallbacks = {
      onEvent: (event: SessionEvent) => {
        renderer.applyEvent(event)
        // Think/tool activity, todos and the panel phase machine: the fixed
        // live surfaces above the chat input, never transcript blocks.
        liveWidgets.applyEvent(event)
        if (event.type === 'todo/write') {
          liveWidgets.renderTodos(event.data.todos)
        }
        if (PERMISSION_KNOB_EVENTS.has(event.type)) {
          refreshPermissionPreset()
          ui.requestRender()
        }
      },
      onStatus: setStatus,
      onLive: (agents: readonly AgentView[]) => {
        liveWidgets.renderAgents(agents)
      },
    }
    const bridge = new DshSessionBridge(ctx, bridgeCallbacks)
    // Subagent fine-grained control, all in-process (see subagent-policy.ts):
    // a tools.guard denies spawn-tool calls once `maxAgents` children run
    // (workflow fan-out, which bypasses the tool pipeline, is pruned on
    // `subagent/start`), and when a child's assistant-message count reaches
    // `maxRounds` the policy queues one wrap-up message into its next turn.
    // Limits are read live from the `dsh-tui` settings namespace
    // (/agents → l limits).
    const subagentPolicy = applySubagentPolicy(ctx, {
      getLive: () => bridge.getLiveChildren(),
      getRoundCount: childId => bridge.getRoundCount(childId),
      isSettled: childId => bridge.isChildSettled(childId),
    })
    bridgeCallbacks.onRoundCount = (childId, count) => subagentPolicy.onRoundCount(childId, count)

    /**
     * One O(events) fold of the session log into the effective preset, stored
     * for the badge provider. Runs once per session (ensure/resume, see the
     * call sites) and once per knob change — never on the render path, which
     * is what makes the provider's read O(1). Clearing to undefined is the
     * right answer for an absent agent/preset service: the provider then
     * hides the badge.
     */
    let permissionPreset: string | undefined
    const refreshPermissionPreset = (): void => {
      const presets = ctx.get('permissionPresets')
      const agent = bridge.getAgent()
      permissionPreset = presets === undefined || agent === undefined
        ? undefined
        : presets.current(agent.session.events)
    }

    // Usage memory for the slash completion list: successful commands and
    // skill gestures bump per-name counters persisted under $DSH_HOME. The
    // disk copy is authoritative — a /reload swaps this plugin fiber and the
    // fresh tracker re-reads the file, so counts survive hot reloads too.
    const commandUsage = new CommandUsageTracker(commandUsagePath())
    const commands = new CommandService(ctx, bridge, commandUsage)
    // Wiring through the handle: the editor is rebuilt on theme hot-swap, and
    // these providers are re-applied to the replacement instance.
    ui.setEditorAutocompleteProvider(commands.autocompleteProvider())

    // ------------------------------------------- TUI-owned slash commands --
    // Web-surface parity: `model` is a browser client contribution there and
    // `export` a web-only download plugin — the terminal gets native
    // equivalents registered here, so the autocomplete catalog matches web.
    // Agentless bodies are registered through both ctx.commands (discovery,
    // lifecycle events against a live agent) and CommandService.registerLocal
    // (direct dispatch when no agent exists — no throwaway session).

    const modelHandler: LocalCommandHandler = async () => {
      const picked = await pickModel(
        ctx, ui.tui, ui.theme, bridge.getSelection(),
        () => ui.tui.setFocus(ui.editor),
      )
      if (picked === undefined) return { kind: 'success' as const, text: 'Model unchanged.' }
      const llm = ctx.get('llm')
      if (llm !== undefined) {
        await llm.resolveCallConfig({ provider: picked.provider, model: picked.model })
      }
      bridge.setSelection(picked)
      const persistError = await persistDefaultModel(ctx, picked)
      ui.requestRender()
      const modelText = picked.reasoningEffort === undefined
        ? `Model: ${picked.provider}/${picked.model}`
        : `Model: ${picked.provider}/${picked.model} · think ${String(picked.reasoningEffort)}`
      return {
        kind: 'success' as const,
        text: persistError === undefined ? modelText : `${modelText} · ⚠ not persisted: ${persistError}`,
      }
    }
    commands.registerLocal('model', modelHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'model',
      description: 'Select the model (and think level) for this conversation',
      handler: invocation => modelHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /model')

    // /agents: manage agent definition markdown files (model, think level,
    // spawn depth) — the terminal counterpart of pi's /fun-agent-cfg. An
    // optional argument preselects one agent by name.
    const agentsHandler: LocalCommandHandler = async rawInput => {
      const trimmed = rawInput?.trim() ?? ''
      const result = await openAgentManager(
        ctx, ui.tui, ui.theme, () => ui.tui.setFocus(ui.editor),
        trimmed === '' ? undefined : trimmed,
      )
      if (result === undefined) return { kind: 'success' as const, text: 'Agents unchanged.' }
      return { kind: 'success' as const, text: result }
    }
    commands.registerLocal('agents', agentsHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'agents',
      description: 'Manage agent definitions (model, think level, spawn depth) from markdown files',
      handler: invocation => agentsHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /agents')

    // /subagents: the command twin of Ctrl+G — pick a running (or recently
    // settled) subagent and inspect its live transcript in the 80% viewer.
    // Same flow as the key path; empty board closes immediately.
    const subagentsHandler: LocalCommandHandler = async () => {
      await openSubagentViewer(ctx, ui.tui, ui.theme, bridge, () => ui.tui.setFocus(ui.editor))
      return { kind: 'success' as const, text: 'Subagent viewer closed.' }
    }
    commands.registerLocal('subagents', subagentsHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'subagents',
      description: 'Browse subagents and inspect their live transcript',
      handler: invocation => subagentsHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /subagents')

    // /think: cycle the current model's reasoning effort without re-picking
    // the model. A no-session /think still lands in the selection ref and
    // survives the lazy session creation (bridge seeds only an empty ref).
    const thinkHandler: LocalCommandHandler = async () => {
      const current = bridge.getSelection()
      if (current === undefined) {
        return { kind: 'error' as const, text: 'No model selected — pick one with /model first.' }
      }
      const result = await pickEffort(ctx, ui.tui, ui.theme, current, () => ui.tui.setFocus(ui.editor))
      if (result.kind === 'unsupported') {
        return {
          kind: 'error' as const,
          text: `${current.provider}/${current.model} exposes no selectable think levels.`,
        }
      }
      if (result.kind === 'cancelled') return { kind: 'success' as const, text: 'Think level unchanged.' }
      if (result.effort === 'default') {
        const next = { provider: current.provider, model: current.model }
        bridge.setSelection(next)
        const persistError = await persistDefaultModel(ctx, next)
        ui.requestRender()
        const thinkText = `Think: provider default (${current.provider}/${current.model}).`
        return {
          kind: 'success' as const,
          text: persistError === undefined ? thinkText : `${thinkText} · ⚠ not persisted: ${persistError}`,
        }
      }
      const next = {
        provider: current.provider,
        model: current.model,
        reasoningEffort: result.effort,
      }
      bridge.setSelection(next)
      const persistError = await persistDefaultModel(ctx, next)
      ui.requestRender()
      const thinkText = `Think: ${String(result.effort)} (${current.provider}/${current.model}).`
      return {
        kind: 'success' as const,
        text: persistError === undefined ? thinkText : `${thinkText} · ⚠ not persisted: ${persistError}`,
      }
    }
    commands.registerLocal('think', thinkHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'think',
      description: 'Switch the current model\'s think (reasoning) level',
      handler: invocation => thinkHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /think')

    // /models-sync: run one dsh-model-sync catalog round on demand and show
    // its report. Agentless like the pickers above — the sync only touches the
    // settings document, never a conversation, so no throwaway session. The
    // service is optional: without the dsh-model-sync plugin loaded, the
    // command says so instead of failing elsewhere.
    const modelSyncHandler: LocalCommandHandler = async () => {
      const modelSync = ctx.get('modelSync') as { syncNow(): Promise<string> } | undefined
      if (modelSync === undefined) {
        return { kind: 'error' as const, text: 'dsh-model-sync plugin is not loaded.' }
      }
      const report = await modelSync.syncNow()
      return { kind: 'success' as const, text: report }
    }
    commands.registerLocal('models-sync', modelSyncHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'models-sync',
      description: 'Sync the model catalog from configured providers (custom providers excluded)',
      handler: invocation => modelSyncHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /models-sync')

    // /model-sync (singular): discover models for CUSTOM provider routes — the
    // hand-declared llm-pi-ai profiles carrying a baseURL — straight from each
    // endpoint's model listing, merged additively back into settings.yaml.
    // Agentless like /models-sync above: only the settings document is
    // touched, never a conversation. The two commands are complements:
    // /models-sync (plural) runs a dsh-model-sync catalog round and excludes
    // custom providers; this one covers exactly those excluded routes.
    const modelSyncCustomHandler: LocalCommandHandler = async (rawInput, signal) => {
      const settings = ctx.get('settings')
      if (settings === undefined) {
        return { kind: 'error' as const, text: 'Settings service is unavailable.' }
      }
      const llm = ctx.get('llm')
      if (llm === undefined) {
        return { kind: 'error' as const, text: 'LLM runtime is unavailable.' }
      }
      return runModelSync({ settings, llm }, { rawInput, signal })
    }
    commands.registerLocal('model-sync', modelSyncCustomHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'model-sync',
      description: 'Discover models for hand-declared (baseURL) providers and merge them into settings',
      handler: invocation => modelSyncCustomHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /model-sync')

    const sessionHandler: LocalCommandHandler = async () => {
      const agent = bridge.getAgent()
      const stats = bridge.getStats()
      const selection = bridge.getSelection()
      const header = agent?.session.header
      await showSessionInfo(ui.tui, ui.theme, {
        id: agent === undefined ? undefined : String(agent.session.id),
        cwd: header?.cwd,
        createdAt: header?.createdAt,
        model: selection === undefined ? undefined : `${selection.provider}/${selection.model}`,
        effort: selection === undefined || selection.reasoningEffort === undefined
          ? (selection === undefined ? undefined : 'provider default')
          : String(selection.reasoningEffort),
        msgCount: stats.msgCount,
        toolCallCount: stats.toolCallCount,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cacheReadTokens: stats.cacheReadTokens,
        cacheWriteTokens: stats.cacheWriteTokens,
        status: agent === undefined ? 'none' : agentStatus,
        eventCount: agent === undefined ? undefined : agent.session.events.length,
        parentSession: header?.parentSession === undefined ? undefined : String(header.parentSession),
      }, () => ui.tui.setFocus(ui.editor))
      return { kind: 'success' as const, text: agent === undefined ? 'No active session.' : 'Session info shown.' }
    }
    commands.registerLocal('session', sessionHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'session',
      description: 'Show the current session\'s info (id, model, stats)',
      handler: invocation => sessionHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /session')

    // /resume: pick a persisted session, validate its log, swap the live
    // agent for it, and rebuild transcript + stats from the stored events.
    const resumeHandler: LocalCommandHandler = async () => {
      let picked: Awaited<ReturnType<typeof pickPersistedSession>>
      try {
        const currentId = bridge.getSessionId()
        picked = await pickPersistedSession(
          ctx, ui.tui, ui.theme,
          currentId === undefined ? undefined : String(currentId),
          () => ui.tui.setFocus(ui.editor),
        )
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        return { kind: 'error' as const, text: message }
      }
      if (picked.kind === 'empty') {
        return { kind: 'error' as const, text: 'No other persisted sessions to resume.' }
      }
      if (picked.kind === 'cancelled') return { kind: 'success' as const, text: 'Resume cancelled.' }

      // Validate the target log before tearing down the current agent: a
      // corrupt log must leave the live session untouched.
      try {
        await inspectPersistedSession(ctx, picked.id)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        return { kind: 'error' as const, text: `Cannot resume ${clipToWidth(String(picked.id), 8)}: ${message}` }
      }

      let resumed: Awaited<ReturnType<DshSessionBridge['resume']>>
      try {
        resumed = await bridge.resume(picked.id)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          kind: 'error' as const,
          text: `Resume failed: ${message} — the previous session was closed; the next prompt starts a new one.`,
        }
      }
      // Seed the badge cache for the resumed session (its pin event may have
      // been emitted before the bridge's session-id filter re-bound).
      refreshPermissionPreset()
      // Clear BEFORE replay: the renderer's local-echo dedupe must not see
      // replayed user messages next to a stale prompt echo. The live widget
      // drops the previous session's todos too (its agents already went via
      // the bridge's onLive([]) on resume reset).
      renderer.clear()
      liveWidgets.clear()
      // Replay seed history only: events at or above firstLiveSeq were
      // published in-process and arrive again through the session/event
      // subscription (replaying them would double-count stats and echo).
      // Seeds entered through construction never published — replaying them
      // exactly once covers the stored log with zero overlap, zero gap.
      const session = resumed.agent.session
      bridge.replay(session.events.filter(event => event.seq < session.firstLiveSeq))
      ui.requestRender()
      return {
        kind: 'success' as const,
        text: `Resumed ${clipToWidth(String(picked.id), 8)} · ${session.events.length} events.`,
      }
    }
    commands.registerLocal('resume', resumeHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'resume',
      description: 'Resume a persisted session',
      handler: invocation => resumeHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /resume')

    // Auto-resume after a hot-reload: a `/reload` stashes the previously
    // current session id before this fiber's teardown, and the freshly
    // re-imported module consumes it best-effort here so the next prompt
    // continues that session instead of lazily creating a fresh one. The stash
    // is already one-shot-consumed by takeStashedSessionId, so on ANY failure
    // we fall back silently to today's behavior (next prompt creates a new
    // session); the apply must never crash on this. Guarded against re-entrant
    // reloads: if a second reload happens while this runs, takeStashedSessionId
    // returns undefined and the block no-ops.
    const stashedSessionId = takeStashedSessionId()
    if (stashedSessionId !== undefined) {
      void (async () => {
        try {
          const resumed = await bridge.resume(stashedSessionId)
          // Mirror the /resume flow: seed the badge cache, drop the previous
          // session's render state, and replay only the seed history.
          refreshPermissionPreset()
          renderer.clear()
          liveWidgets.clear()
          const session = resumed.agent.session
          bridge.replay(session.events.filter(event => event.seq < session.firstLiveSeq))
          ui.requestRender()
        } catch { /* best-effort: fall back to lazy session creation */ }
      })()
    }

    // Agentless guard: dsh's own /export addresses a live agent and would
    // mint a throwaway session just to report there is nothing to export —
    // CommandService routes this locally only when no agent exists, and
    // falls back to the dsh path when one does (behavior unchanged there).
    commands.registerLocal('export', async () => ({
      kind: 'error' as const,
      text: 'No active session to export.',
    }))
    ctx.effect(() => ctx.commands.register({
      name: 'export',
      description: 'Export this session log as JSONL',
      input: { hint: '[path]' },
      handler: async invocation => {
        const events = invocation.agent.session.events
        const fallback = join(homedir(), 'Downloads', `dsh-session-${clipToWidth(String(invocation.agent.session.id), 8)}.jsonl`)
        const target = invocation.rawInput.trim() === '' ? fallback : resolve(invocation.rawInput.trim())
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, events.map(event => JSON.stringify(event)).join('\n') + '\n')
        return { kind: 'success' as const, text: `Exported ${events.length} events → ${target}` }
      },
    }), 'dsh-tui-pi: /export')

    // /new: detach the live agent (and clear the on-screen transcript) so
    // the next prompt opens a brand-new session. The escape hatch for
    // "current session has images in history, the next model doesn't accept
    // them" — and any other case where the user wants a clean slate.
    // detachCurrent keeps the event subscriptions alive (dispose() would
    // splice them away and no future message would ever render again).
    const newHandler: LocalCommandHandler = async () => {
      try { await bridge.detachCurrent() } catch { /* contained */ }
      // No agent → the badge cache must not serve the old session's preset
      // to a later one (the next prompt re-seeds it).
      refreshPermissionPreset()
      renderer.clear()
      // The widget's agents already cleared via the bridge's onLive([]); drop
      // the previous session's todos too.
      liveWidgets.clear()
      return { kind: 'success' as const, text: 'New session started.' }
    }
    commands.registerLocal('new', newHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'new',
      description: 'Start a new session',
      handler: invocation => newHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /new')

    // /settings: text-based configuration browser — the terminal counterpart
    // of the web GUI's settings surface. Enumerates ctx.settings.describe()
    // and walks each namespace's schema (drill-ins, cycle rows, inline editors,
    // reset-to-defaults), writing through settings.mutate path ops.
    const settingsHandler: LocalCommandHandler = async () => {
      if (ctx.get('settings') === undefined) {
        return { kind: 'error' as const, text: 'Settings service is not available.' }
      }
      const changes = await openSettingsBrowser({
        ctx,
        tui: ui.tui,
        theme: ui.theme,
        restoreFocus: () => ui.tui.setFocus(ui.editor),
        onError: message => {
          // Buffered notice: the settings browser outlives the write, so the
          // line must survive a theme hot-swap (the doc.clear() rebuild).
          renderer.renderNotice(message, 'error')
        },
      })
      if (changes < 0) return { kind: 'error' as const, text: 'No settings namespaces are registered.' }
      return {
        kind: 'success' as const,
        text: changes === 0
          ? 'Settings: no changes.'
          : `Settings: ${changes} change${changes === 1 ? '' : 's'} applied.`,
      }
    }
    commands.registerLocal('settings', settingsHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'settings',
      description: 'Browse and edit configuration (namespaces, values, resets)',
      handler: invocation => settingsHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /settings')

    // /skills: standalone skill browser with Installed/Available dual mode.
    // Enter/Space toggles or symlinks; Tab switches views; Esc exits.
    const skillsHandler: LocalCommandHandler = async () => {
      const agent = bridge.getAgent()
      openSkillsManagerPanel(ctx, ui.tui, ui.theme, () => ui.tui.setFocus(ui.editor), agent ?? undefined, () => {})
      return { kind: 'success' as const, text: 'Skills manager opened.' }
    }
    commands.registerLocal('skills', skillsHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'skills',
      description: 'Manage user skills (installed and available)',
      handler: invocation => skillsHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /skills')

    // /theme: pick a color scheme and apply it immediately — the choice is
    // persisted to the dsh-tui settings namespace (`applies: 'live'`, so the
    // watch hook would re-apply the same change anyway) and hot-swapped into
    // the running TUI: footer hint, editor border and the whole transcript
    // repaint on the next frame, no restart needed. The settings guard
    // mirrors /settings: without the service there is nowhere to write.
    const themeHandler: LocalCommandHandler = async () => {
      if (ctx.get('settings') === undefined) {
        return { kind: 'error' as const, text: 'Settings service is not available.' }
      }
      // Preselect from the live settings value (which may have changed since
      // startup via the /settings browser), not the startup snapshot.
      const picked = await pickTheme(ui.tui, ui.theme, currentThemePreference(ctx), () => ui.tui.setFocus(ui.editor))
      if (picked === undefined) return { kind: 'success' as const, text: 'Theme unchanged.' }
      const writeError = await writeThemePreference(ctx, picked)
      if (writeError !== undefined) return { kind: 'error' as const, text: writeError }
      // DSH_TUI_THEME pins the display regardless of the preference — don't
      // claim the pick was applied when it wasn't. The preference is still
      // persisted (and shown once the env override is dropped); the notice
      // goes through the buffered command echo, so no replay issue.
      const applied = resolveTheme(process.env, picked)
      applyTheme(applied)
      const expected = picked === 'light' ? lightTheme : picked === 'dark' ? darkTheme : undefined
      if (expected !== undefined && applied !== expected) {
        return {
          kind: 'success' as const,
          text: `Theme preference saved — display is pinned by DSH_TUI_THEME=${process.env.DSH_TUI_THEME}`,
        }
      }
      return { kind: 'success' as const, text: `Theme: ${picked} — applied.` }
    }
    commands.registerLocal('theme', themeHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'theme',
      description: 'Set the terminal color scheme (applies immediately)',
      handler: invocation => themeHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /theme')

    // /reload: hot-reload this plugin from the current source — re-imports the
    // module and its dependencies (picking up src changes after `pnpm build`)
    // and swaps the plugin runtime. The old fiber is disposed, so the TUI and
    // the live agent bridge are torn down; the session log persists and can be
    // rejoined with /resume. Failures before the swap leave the TUI untouched.
    const reloadHandler: LocalCommandHandler = async () => ({
      kind: 'success' as const,
      text: await reloadPlugin(ctx, import.meta.url),
    })
    commands.registerLocal('reload', reloadHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'reload',
      description: 'Reload the TUI from the current source (apply code changes without restarting dsh)',
      handler: invocation => reloadHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /reload')

    // /hotkeys — pi's keybinding browser, in the /agents select-panel style:
    // a field list of the app keys, Enter opens an editor that writes
    // ~/.dsh/keybindings.json and live-applies the change (no /reload).
    const hotkeysHandler: LocalCommandHandler = async () => {
      const summary = await openHotkeysManager(ui.tui, ui.theme, {
        filePath: keyFile,
        apply: bindings => ui.setKeyBindings(bindings),
        restoreFocus: () => ui.tui.setFocus(ui.editor),
      })
      return { kind: 'success' as const, text: summary ?? 'Keybindings unchanged.' }
    }
    commands.registerLocal('hotkeys', hotkeysHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'hotkeys',
      description: 'Show the current keybindings (custom file: ~/.dsh/keybindings.json)',
      handler: invocation => hotkeysHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /hotkeys')

    // /login: register provider credentials — the terminal counterpart of
    // pi-agent's /login, on the Models category's add-provider flow. Opens a
    // searchable provider directory (including already-configured routes, so
    // a re-login can overwrite a key), collects one API key through the masked
    // editor, and commits the provider profile + credential the way the web
    // Models page does. An optional argument names the provider: `/login
    // openai` jumps straight to the key editor on a unique match and to a
    // filtered picker otherwise.
    const loginHandler: LocalCommandHandler = async rawInput => {
      if (ctx.get('settings') === undefined) {
        return { kind: 'error' as const, text: 'Settings service is not available.' }
      }
      const result = await openLoginFlow({
        ctx,
        tui: ui.tui,
        theme: ui.theme,
        restoreFocus: () => ui.tui.setFocus(ui.editor),
        onError: message => renderer.renderNotice(message, 'error'),
        target: rawInput?.trim() ?? '',
      })
      if (result.kind === 'unknown') {
        return {
          kind: 'error' as const,
          text: `Unknown provider '${result.target}' — run /login to pick from the directory.`,
        }
      }
      if (result.kind === 'cancelled') return { kind: 'success' as const, text: 'Login cancelled.' }
      return { kind: 'success' as const, text: `Provider ${result.name} configured.` }
    }
    commands.registerLocal('login', loginHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'login',
      description: 'Configure a provider API key (register or replace credentials)',
      handler: invocation => loginHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /login')

    // /logout: unsubscribe a provider — pi-agent's /logout on the dsh side.
    // Lists the providers with a stored credential; on selection removes the
    // key AND the settings.yaml provider entry, so the provider's models
    // leave /model right away (the llm-pi-ai adapter keeps a route
    // registered for every profile key). /login re-subscribes and serves
    // the installed catalog's current model list.
    const logoutHandler: LocalCommandHandler = async () => {
      if (ctx.get('settings') === undefined) {
        return { kind: 'error' as const, text: 'Settings service is not available.' }
      }
      const result = await openLogoutFlow({
        ctx,
        tui: ui.tui,
        theme: ui.theme,
        restoreFocus: () => ui.tui.setFocus(ui.editor),
        onError: message => renderer.renderNotice(message, 'error'),
      })
      if (result.kind === 'none') {
        return { kind: 'success' as const, text: 'No stored credentials to remove.' }
      }
      if (result.kind === 'cancelled') return { kind: 'success' as const, text: 'Logout cancelled.' }
      if (result.kind === 'failed') {
        const cause = result.cause === undefined ? '' : `: ${result.cause}`
        return { kind: 'error' as const, text: `Failed to remove stored API key for ${result.name}${cause}.` }
      }
      if (result.kind === 'removed-incomplete') {
        return {
          kind: 'error' as const,
          text: `Removed the API key for ${result.name}, but its provider configuration stays: ${result.error}`
            + ' — remove the provider in /settings to finish the logout.',
        }
      }
      if (result.kind === 'removed-key-only') {
        return {
          kind: 'success' as const,
          text: `Removed the API key for ${result.name}. Hand-declared route — its configuration stays;`
            + ' remove the provider in /settings to also drop its models.',
        }
      }
      return {
        kind: 'success' as const,
        text: `Logged out ${result.name} — API key and provider configuration removed.`,
      }
    }
    commands.registerLocal('logout', logoutHandler)
    ctx.effect(() => ctx.commands.register({
      name: 'logout',
      description: 'Log out a provider (removes its API key and provider configuration)',
      handler: invocation => logoutHandler(invocation.rawInput, invocation.signal),
    }), 'dsh-tui-pi: /logout')

    // ------------------------------------------------- powerline footer + git --
    const git = new GitBranchWatcher(process.cwd())
    git.onChange = () => ui.requestRender()
    ui.setEditorBranchProvider(() => git.getBranch())
    // Permission badge: the live session's effective preset under the web
    // client's display conventions (danger-full-access → "Full access").
    // Reads the cached current preset — O(1) per render, never a session-log
    // fold (that lives in refreshPermissionPreset, once per session/knob
    // change). Falls back to a live fold only while the cache is unprimed:
    // the session's initial pin event can be dropped by the bridge's
    // session-id filter (which binds only after agent creation completes),
    // so until the ensure/resume seed lands, the fallback keeps the badge
    // correct at the price of one fold per frame — bounded by the short
    // creation window.
    ui.setEditorPermissionProvider(() => {
      const presets = ctx.get('permissionPresets')
      const agent = bridge.getAgent()
      if (presets === undefined || agent === undefined) return undefined
      const current = permissionPreset ?? presets.current(agent.session.events)
      return displayPermissionPreset(current, presets.optionOf(current).name)
    })

    let contextWindow: number | undefined
    let contextWindowKey = ''
    const footerSource: FooterDataSource = {
      getStats: () => bridge.getStats(),
      getSelection: () => bridge.getSelection(),
      getBranch: () => git.getBranch(),
      getContextWindow: () => {
        const selection = bridge.getSelection()
        if (selection === undefined) return undefined
        const key = `${selection.provider}/${selection.model}`
        if (key !== contextWindowKey) {
          contextWindowKey = key
          contextWindow = undefined
          const llm = ctx.get('llm')
          if (llm !== undefined) {
            void llm.resolveModelInfo(selection.provider, selection.model).then(info => {
              const window = info.context?.contextWindow
              if (contextWindowKey === key && typeof window === 'number') {
                contextWindow = window
                ui.requestRender()
              }
            }).catch(() => { /* unknown window → footer degrades gracefully */ })
          }
        }
        return contextWindow
      },
    }
    ui.footer.clear()
    ui.footer.addChild(new PowerlineFooter(footerSource, () => ui.theme))
    // Keybinding hint, added *after* the clear above: a single width-clipped
    // row (never word-wraps) reading the live footer-hints selection through
    // its getter — a /settings toggle applies on the next repaint, and the
    // theme colors follow `ui.theme` (see FooterHint in footer.ts).
    let footerHintsRef: FooterHints = footerHints
    const footerHint = new FooterHint(() => ui.theme, () => footerHintsRef)
    ui.footer.addChild(footerHint)
    // Arm the footer-hints watch sink now that the TUI exists (see apply()).
    applyFooterHintsRef = (hints: FooterHints): void => {
      footerHintsRef = hints
      ui.requestRender()
    }
    // Arm the icon-set watch sink: a committed iconSet change hot-applies the
    // risky glyphs (an 'auto' change resolves against the startup font-
    // detection snapshot, matching the startup glyph choice) and repaints the
    // footer/notices/panels that carry them on the next frame.
    applyIconSetRef = (set: IconSet): void => {
      applyIconSet(resolveIconSet(set, nerdfontAvailable))
      ui.requestRender()
    }

    /**
     * Hot-apply a theme bundle to the running TUI: the transcript rebuilds
     * from its replay buffer, the dock/editor swap to the new bundle, and the
     * spinner (when mid-turn) is recreated with the new accent. Per-piece
     * requestRenders coalesce into the single next-throttled frame, so the
     * switch repaints once. No-op on the unchanged bundle — the settings
     * watch echoes this TUI's own /theme write, and the theme modules are
     * singletons.
     */
    const applyTheme = (theme: TuiTheme): void => {
      if (theme === ui.theme) return
      renderer.setTheme(theme)
      liveWidgets.setTheme(theme)
      ui.applyTheme(theme)
      if (loader !== undefined) {
        loader.stop()
        ui.status.removeChild(loader)
        loader = undefined
        setStatus(agentStatus)
      }
    }

    // 'auto' refinement (the cmux/gostty case): COLORFGBG is often absent or
    // wrong inside multiplexers, so the synchronous startup guess may be
    // wrong. Ask the terminal itself — CSI ?996n color-scheme query first
    // (Ghostty/cmux, kitty, iTerm answer), then the OSC 11 background color
    // as ground truth — and hot-apply when the answer differs. Both queries
    // time out silently on quiet terminals; the startup resolution stands.
    if (themePreference === 'auto') {
      ui.tui.setTerminalColorSchemeNotifications(true)
      void (async () => {
        const scheme = await ui.tui.queryTerminalColorScheme({ timeoutMs: 200 }).catch(() => undefined)
        if (scheme === 'light' || scheme === 'dark') {
          applyTheme(resolveTheme(process.env, scheme))
          return
        }
        const background = await ui.tui.queryTerminalBackgroundColor({ timeoutMs: 200 }).catch(() => undefined)
        if (background !== undefined) {
          applyTheme(resolveTheme(process.env, rgbIsLight(background) ? 'light' : 'dark'))
        }
      })()
    }
    // Follow the terminal's live light/dark switches (CSI 997 pushes) while
    // the preference is 'auto' — the terminal flips its OS appearance and the
    // TUI repaints on the next frame, no restart. Explicit pins ignore it.
    const stopTerminalFollow = ui.tui.onTerminalColorSchemeChange(scheme => {
      if (themePreferenceRef !== 'auto') return
      applyTheme(resolveTheme(process.env, scheme))
    })

    // Live clock: the footer is the only thing that changes each second.
    const clockTimer = setInterval(() => ui.requestRender(), 1000)
    clockTimer.unref?.()

    // Live Todos/Agents widget: spinner + elapsed refresh ~10x/sec while
    // children run (tickLive no-ops when nothing runs).
    const liveTimer = setInterval(() => liveWidgets.tickLive(), AGENT_TICK_MS)
    liveTimer.unref?.()

    /**
     * Modal commands keep an overlay open for as long as the user browses
     * (model/effort pickers, settings browser, session panel, resume list).
     * The generic 30s guard would fire mid-session and echo a spurious
     * "aborted due to timeout" — those run with a never-aborting signal
     * instead.
     */
    const MODAL_COMMANDS = new Set(['settings', 'model', 'think', 'session', 'resume', 'theme', 'permission', 'agents', 'subagents', 'login', 'logout', 'skills'])

    /** Route one submitted line: dsh slash command first, model prompt second. */
    const submit = async (text: string): Promise<void> => {
      const line = text.trim()
      if (line === '') return
      liveWidgets.setLastRequest(line)
      const tokens = line.startsWith('/') ? line.slice(1).split(/\s+/) : []
      const name = tokens[0]?.toLowerCase()
      let executeLine = line
      const signal = name !== undefined && MODAL_COMMANDS.has(name)
        ? new AbortController().signal
        : AbortSignal.timeout(30_000)
      // Bare /permission (no arguments) opens the preset picker — UI sugar
      // over dsh's canonical command: a picked row is replayed as
      // `/permission <name>` through the normal execute path below, so the
      // switch stays canonical while the echo keeps the user's original line.
      // `/permission <name>` passes straight through. Without a composed
      // preset service there is nothing to pick and the bare line falls
      // through to the model like any other unregistered command.
      if (name === 'permission' && tokens.length === 1) {
        const presets = ctx.get('permissionPresets')
        if (presets !== undefined) {
          const agent = bridge.getAgent()
          const current = agent === undefined ? undefined : presets.current(agent.session.events)
          let picked: string | undefined
          try {
            picked = await pickPermission(ctx, ui.tui, ui.theme, current, () => ui.tui.setFocus(ui.editor))
          } catch (error: unknown) {
            // Picker failure (preset service or overlay error) — pickPermission
            // restores focus itself before rejecting, so the editor is usable
            // again; surface the failure in the transcript like every other
            // dispatch error. Buffered notice: this line is the only record of
            // the failure and must survive a theme-switch rebuild (doc.clear()).
            const message = error instanceof Error ? error.message : String(error)
            renderer.renderNotice(message, 'error')
            return
          }
          if (picked === undefined || picked === 'custom') {
            // Cancelled — or the derived custom state, which is display-only
            // and not a switch target (mirrors the web client's popup
            // filtering). Either way nothing changed.
            renderer.renderCommandEcho(line, undefined, 'Permission unchanged.')
            return
          }
          executeLine = `/permission ${picked}`
        }
      }
      let command: Awaited<ReturnType<CommandService['tryExecute']>>
      try {
        command = await commands.tryExecute(executeLine, signal)
      } catch (error: unknown) {
        // Dispatch itself failed (outside every contained path) — surface in
        // the transcript instead of an unhandled rejection killing the TUI.
        // Buffered notice: this line is the only record of the failure and
        // must survive a theme-switch rebuild (doc.clear()).
        const message = error instanceof Error ? error.message : String(error)
        renderer.renderNotice(message, 'error')
        return
      }
      if (command.handled) {
        renderer.renderCommandEcho(line, command.error, command.text)
        return
      }
      renderer.renderPromptEcho(line)
      try {
        await bridge.prompt(line)
      } catch (error: unknown) {
        // Buffered notice: the failure line is the only on-screen record and
        // must survive a theme-switch rebuild (doc.clear()).
        const message = error instanceof Error ? error.message : String(error)
        renderer.renderNotice(message, 'error')
      }
      // Session (re)created by the prompt: seed the badge cache. The initial
      // permission pin event was likely dropped by the session-id filter,
      // which binds only after agent creation completes.
      refreshPermissionPreset()
    }

    /**
     * The TUI owns the product lifetime in this profile (openma contract):
     * dispose the agent, then the whole root runtime, then exit. Runs once —
     * concurrent Ctrl+C presses share the single shutdown task.
     */
    let exitTask: Promise<void> | undefined
    const disposeAndExit = async (code: number): Promise<void> => {
      exitTask ??= (async () => {
        clearInterval(clockTimer)
        clearInterval(liveTimer)
        git.dispose()
        try { await bridge.dispose() } catch { /* contained */ }
        ui.dispose()
        try { await ctx.root.fiber.dispose() } catch { /* contained */ }
        process.exit(code)
      })()
      return exitTask
    }

    return async () => {
      if (relayoutTimer !== undefined) clearTimeout(relayoutTimer)
      process.stdout.removeListener('resize', onResize)
      stopTerminalFollow()
      clearInterval(clockTimer)
      clearInterval(liveTimer)
      git.dispose()
      applyThemeRef = undefined
      applyPanelHeightRef = undefined
      applyFooterHintsRef = undefined
      // Stop the TUI FIRST, before the (possibly slow) agent teardown: the
      // terminal must be released while the fiber is still alone with it.
      // Deferring tui.stop() until after `await bridge.dispose()` lets any
      // fire-and-forget disposal (e.g. /reload's fiber swap) start a fresh
      // TUI while this one still holds the terminal — the late stop then
      // disables raw mode and pauses stdin out from under the new TUI.
      handle?.dispose()
      handle = undefined
      // Stash the current session BEFORE the bridge clears its sessionId on
      // dispose, so a same-process hot-reload (/reload) can resume it in the
      // fresh fiber. On shutdown the process exits and the stash dies with it
      // (harmless) — only /reload in the same process consumes it.
      stashSessionIdForReload(bridge.getSessionId())
      if (quitConfirmTimer !== undefined) clearTimeout(quitConfirmTimer)
      if (stopConfirmTimer !== undefined) clearTimeout(stopConfirmTimer)
      subagentPolicy.dispose()
      try { await bridge.dispose() } catch { /* contained */ }
    }
  }
}
