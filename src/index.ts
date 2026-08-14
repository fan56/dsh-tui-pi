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
import { CommandService } from './commands.ts'
import { PowerlineFooter, type FooterDataSource } from './footer.ts'
import { GitBranchWatcher } from './git.ts'
import { TranscriptRenderer } from './messages.ts'
import { pickModel } from './selectors.ts'
import { DshSessionBridge } from './session.ts'
import { ansiFg, RESET } from './theme/index.ts'
import { startTui, type TuiHandle } from './tui.ts'

export const name = 'dsh-tui-pi'

/** The TUI drives the agent factory and registers slash commands. */
export const inject = ['agents', 'commands']

export function apply(ctx: Context): void {
  let handle: TuiHandle | undefined

  ctx.effect(() => {
    const ui = startTui({
      onSubmit: text => {
        void submit(text)
      },
      onInterrupt: () => {
        void disposeAndExit(0)
      },
    })
    handle = ui

    const renderer = new TranscriptRenderer(ui.transcript, ui.theme, () => ui.requestRender())

    // Working/idle indicator in the fixed dock (hidden while idle).
    let loader: Loader | undefined
    const setStatus = (status: 'idle' | 'running'): void => {
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
    ui.editor.setAutocompleteProvider(commands.autocompleteProvider())

    // ------------------------------------------- TUI-owned slash commands --
    // Web-surface parity: `model` is a browser client contribution there and
    // `export` a web-only download plugin — the terminal gets native
    // equivalents registered here, so the autocomplete catalog matches web.
    ctx.effect(() => ctx.commands.register({
      name: 'model',
      description: 'Select the model for this conversation',
      handler: async () => {
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
        return { kind: 'success' as const, text: `Model: ${picked.provider}/${picked.model}` }
      },
    }), 'dsh-tui-pi: /model')

    ctx.effect(() => ctx.commands.register({
      name: 'export',
      description: 'Export this session log as JSONL',
      input: { hint: '[path]' },
      handler: async invocation => {
        const events = invocation.agent.session.events
        const fallback = join(homedir(), 'Downloads', `dsh-session-${String(invocation.agent.session.id).slice(0, 8)}.jsonl`)
        const target = invocation.rawInput.trim() === '' ? fallback : resolve(invocation.rawInput.trim())
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, events.map(event => JSON.stringify(event)).join('\n') + '\n')
        return { kind: 'success' as const, text: `Exported ${events.length} events → ${target}` }
      },
    }), 'dsh-tui-pi: /export')

    // /new: dispose the live agent (and clear the on-screen transcript) so
    // the next prompt opens a brand-new session. The escape hatch for
    // "current session has images in history, the next model doesn't accept
    // them" — and any other case where the user wants a clean slate.
    ctx.effect(() => ctx.commands.register({
      name: 'new',
      description: 'Start a new session',
      handler: async () => {
        try { await bridge.dispose() } catch { /* contained */ }
        renderer.clear()
        return { kind: 'success' as const, text: 'New session started.' }
      },
    }), 'dsh-tui-pi: /new')

    // ------------------------------------------------- powerline footer + git --
    const git = new GitBranchWatcher(process.cwd())
    git.onChange = () => ui.requestRender()
    ui.editor.setBranchProvider(() => git.getBranch())

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

    // Live clock: the footer is the only thing that changes each second.
    const clockTimer = setInterval(() => ui.requestRender(), 1000)
    clockTimer.unref?.()

    /** Route one submitted line: dsh slash command first, model prompt second. */
    const submit = async (text: string): Promise<void> => {
      const line = text.trim()
      if (line === '') return
      ui.setLastRequest(line)
      const command = await commands.tryExecute(line, AbortSignal.timeout(30_000))
      if (command.handled) {
        renderer.renderCommandEcho(line, command.error, command.text)
        return
      }
      renderer.renderPromptEcho(line)
      try {
        await bridge.prompt(line)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ui.transcript.addChild(new Text(ansiFg(ui.theme.palette.danger) + `✘ ${message}` + RESET, 1, 0))
        ui.requestRender()
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

    return () => {
      void (async () => {
        clearInterval(clockTimer)
        git.dispose()
        try { await bridge.dispose() } catch { /* contained */ }
        handle?.dispose()
        handle = undefined
      })()
    }
  }, 'dsh-tui-pi.render')
}
