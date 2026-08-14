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
import { Loader, Text } from '@earendil-works/pi-tui'
import { CommandService } from './commands.ts'
import { PowerlineFooter, type FooterDataSource } from './footer.ts'
import { GitBranchWatcher } from './git.ts'
import { TranscriptRenderer } from './messages.ts'
import { DshSessionBridge } from './session.ts'
import { ansiFg, RESET } from './theme/index.ts'
import { startTui, type TuiHandle } from './tui.ts'

export const name = 'dsh-tui-pi'

/** The TUI drives the agent factory; compose over a profile that mounts agents. */
export const inject = ['agents']

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
