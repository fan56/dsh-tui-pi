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
import { Loader, Text } from '@earendil-works/pi-tui'
import { CommandService, type LocalCommandHandler } from './commands.ts'
import { PowerlineFooter, type FooterDataSource } from './footer.ts'
import { GitBranchWatcher } from './git.ts'
import { TranscriptRenderer } from './messages.ts'
import { pickEffort, pickModel, pickTheme } from './selectors.ts'
import { DshSessionBridge, persistDefaultModel } from './session.ts'
import {
  currentThemePreference,
  readThemePreference,
  registerThemeSettings,
  writeThemePreference,
} from './theme-settings.ts'
import { openSettingsBrowser } from './settings.ts'
import { reloadPlugin } from './reload.ts'
import { inspectPersistedSession, pickPersistedSession, showSessionInfo } from './sessions.ts'
import { ansiFg, darkTheme, lightTheme, RESET, resolveTheme, type ThemePreference, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'
import { startTui, type TuiHandle } from './tui.ts'

export const name = 'dsh-tui-pi'

/** The TUI drives the agent factory and registers slash commands. */
export const inject = ['agents', 'commands']

export function apply(ctx: Context): void {
  let handle: TuiHandle | undefined
  /**
   * Live theme hot-reload sink, wired to the settings watch hook: a committed
   * `dsh-tui` theme change (this TUI's /theme write included) is applied to
   * the running TUI. Set inside runTui once the renderer exists; the first
   * commit can only follow a user write, long after startup.
   */
  let applyThemeRef: ((pref: ThemePreference) => void) | undefined

  ctx.effect(async () => {
    // The theme bundle is built once at TUI startup and held by every
    // component, so the persisted preference must land before startTui — the
    // namespace registration rides the settings injection fiber and the read
    // awaits it (bounded, degrades to 'auto' without a settings service).
    // The registration also watches the namespace: `applies: 'live'`, so
    // later commits (the /theme picker, the /settings browser, an external
    // edit) hot-apply through applyThemeRef.
    registerThemeSettings(ctx, pref => applyThemeRef?.(pref))
    const themePreference = await readThemePreference(ctx)
    let disposer: (() => void) | undefined
    try {
      disposer = runTui(themePreference)
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
   * Build the TUI and its slash commands for the resolved theme preference.
   * Declared as a hoisted function so the effect body stays a thin wrapper:
   * the whole build runs inside the try/catch above, so any failure disposes
   * the TUI handle before the error reaches cordis. Returns the effect
   * disposer handed back to cordis on teardown.
   */
  function runTui(themePreference: ThemePreference): () => void {
    // Graded Ctrl+C: while the agent is mid-turn the first press cancels the
    // active turn (keepInbox preserves the queue) with on-screen feedback;
    // any further press — or any press while idle — quits the TUI.
    let cancelAttempted = false
    let lastInterrupt = 0

    const ui = startTui({
      onSubmit: text => {
        void submit(text)
      },
      onInterrupt: () => {
        if (bridge.isRunning() && !cancelAttempted && Date.now() - lastInterrupt > 1500) {
          // First press mid-turn: cancel with on-screen feedback (mirrors the
          // web client's stop button). The next press — of any kind — quits.
          cancelAttempted = true
          lastInterrupt = Date.now()
          // Transient notice: a second press quits and disposes the whole
          // TUI, so the line's replay entry only matters for theme-switch
          // repaints — buffering it keeps that rebuild faithful.
          renderer.renderNotice('⏹ canceling current turn…', 'info')
          void bridge.cancelActiveTurn().then(cancelled => {
            // Nothing was running (state raced idle): nothing to cancel — quit.
            if (!cancelled) void disposeAndExit(0)
          })
        } else {
          void disposeAndExit(0)
        }
      },
      themePreference,
    })
    handle = ui
    // Arm the settings watch sink now that the renderer exists (see apply()).
    applyThemeRef = (pref: ThemePreference): void => {
      applyTheme(resolveTheme(process.env, pref))
    }

    const renderer = new TranscriptRenderer(ui.transcript, ui.theme, () => ui.requestRender())

    // Working/idle indicator in the fixed dock (hidden while idle).
    let loader: Loader | undefined
    let agentStatus: 'idle' | 'running' = 'idle'
    const setStatus = (status: 'idle' | 'running'): void => {
      agentStatus = status
      if (status === 'running') {
        if (loader === undefined) {
          loader = new Loader(
            ui.tui,
            text => ansiFg(ui.theme.palette.accent) + text + RESET,
            text => ansiFg(ui.theme.palette.fgMuted) + text + RESET,
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

    const bridge = new DshSessionBridge(ctx, {
      onEvent: event => renderer.applyEvent(event),
      onStatus: setStatus,
    })

    const commands = new CommandService(ctx, bridge)
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
      // Clear BEFORE replay: the renderer's local-echo dedupe must not see
      // replayed user messages next to a stale prompt echo.
      renderer.clear()
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
      renderer.clear()
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

    // ------------------------------------------------- powerline footer + git --
    const git = new GitBranchWatcher(process.cwd())
    git.onChange = () => ui.requestRender()
    ui.setEditorBranchProvider(() => git.getBranch())

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
    ui.footer.addChild(new PowerlineFooter(footerSource))
    // Keybinding hint, added *after* the clear above: the placeholder line in
    // tui.ts used to be wiped before first render. paddingX 1 aligns the text
    // with the powerline segment labels (each starts with a leading space).
    // The hint is the footer stack's only theme-dependent piece (the powerline
    // segments carry fixed theme-agnostic colors) — `paintFooterHint` re-colors
    // it under a theme hot-swap; the PowerlineFooter itself needs no rebuild.
    const footerHint = new Text('', 1, 0)
    const paintFooterHint = (): void => {
      footerHint.setText(ansiFg(ui.theme.palette.fgSubtle) + '⌨ Enter: send · Ctrl+C: cancel / double: quit' + RESET)
    }
    paintFooterHint()
    ui.footer.addChild(footerHint)

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
      ui.applyTheme(theme)
      paintFooterHint()
      if (loader !== undefined) {
        loader.stop()
        ui.status.removeChild(loader)
        loader = undefined
        setStatus(agentStatus)
      }
    }

    // Live clock: the footer is the only thing that changes each second.
    const clockTimer = setInterval(() => ui.requestRender(), 1000)
    clockTimer.unref?.()

    /**
     * Modal commands keep an overlay open for as long as the user browses
     * (model/effort pickers, settings browser, session panel, resume list).
     * The generic 30s guard would fire mid-session and echo a spurious
     * "aborted due to timeout" — those run with a never-aborting signal
     * instead.
     */
    const MODAL_COMMANDS = new Set(['settings', 'model', 'think', 'session', 'resume', 'theme'])

    /** Route one submitted line: dsh slash command first, model prompt second. */
    const submit = async (text: string): Promise<void> => {
      const line = text.trim()
      if (line === '') return
      ui.setLastRequest(line)
      const name = line.startsWith('/') ? line.slice(1).split(/\s+/)[0]?.toLowerCase() : undefined
      const signal = name !== undefined && MODAL_COMMANDS.has(name)
        ? new AbortController().signal
        : AbortSignal.timeout(30_000)
      let command: Awaited<ReturnType<CommandService['tryExecute']>>
      try {
        command = await commands.tryExecute(line, signal)
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
        git.dispose()
        try { await bridge.dispose() } catch { /* contained */ }
        ui.dispose()
        try { await ctx.root.fiber.dispose() } catch { /* contained */ }
        process.exit(code)
      })()
      return exitTask
    }

    return async () => {
      clearInterval(clockTimer)
      git.dispose()
      applyThemeRef = undefined
      // Stop the TUI FIRST, before the (possibly slow) agent teardown: the
      // terminal must be released while the fiber is still alone with it.
      // Deferring tui.stop() until after `await bridge.dispose()` lets any
      // fire-and-forget disposal (e.g. /reload's fiber swap) start a fresh
      // TUI while this one still holds the terminal — the late stop then
      // disables raw mode and pauses stdin out from under the new TUI.
      handle?.dispose()
      handle = undefined
      try { await bridge.dispose() } catch { /* contained */ }
    }
  }
}
