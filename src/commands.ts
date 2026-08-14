/**
 * Slash-command integration with dsh's own command registry.
 *
 * dsh-tui-pi never re-implements a command: autocomplete lists
 * `ctx.commands.list(agent)` and submission routes through
 * `ctx.commands.execute(agent, line, signal)`. Anything that is not a
 * resolvable command falls through to the model as an ordinary prompt, so
 * every command registered by dsh packages (plan, compact, feedback, export,
 * permission, goal, …) works here unchanged and future registrations appear
 * automatically.
 */

import type { Context } from '@deepseek-ai/cordis'
import { parseCommand, type CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from '@earendil-works/pi-tui'
import type { DshSessionBridge } from './session.ts'

/**
 * Token ending at the cursor on one editor line, for command detection.
 * Returns the leading slash token when the caret sits inside one.
 */
function tokenAtCursor(line: string, cursorCol: number): { token: string; start: number } | undefined {
  const upto = line.slice(0, cursorCol)
  const match = /(^|\s)\/([a-z][a-z0-9_-]*)?$/u.exec(upto)
  if (match === null) return undefined
  const start = match.index + (match[1] ?? '').length
  return { token: upto.slice(start), start }
}

export class CommandService {
  private readonly ctx: Context
  private readonly bridge: DshSessionBridge

  constructor(ctx: Context, bridge: DshSessionBridge) {
    this.ctx = ctx
    this.bridge = bridge
  }

  /**
   * Try to run `line` as a dsh slash command.
   * @returns `handled: true` when the line was admitted as a command (the
   *   caller must not forward it to the model), with an optional `error` or
   *   success `text` to surface; `handled: false` when it is not a command.
   */
  async tryExecute(line: string, signal: AbortSignal): Promise<{ handled: boolean; error?: string; text?: string }> {
    const parsed = parseCommand(line)
    if (parsed === undefined) return { handled: false }

    const commands = this.ctx.get('commands')
    if (commands === undefined) return { handled: false }

    // Commands address a live agent; warm the session when it does not exist.
    const agent = await this.bridge.ensureAgent()
    if (commands.find(agent, parsed.name) === undefined) {
      // Syntactically a command but unregistered → treat as ordinary text so
      // the model still sees it (matches "unknown command" falling through).
      return { handled: false }
    }

    try {
      const execution = await commands.execute(agent, line, signal)
      if (execution === undefined) return { handled: false }
      if (execution.result.kind === 'error') return { handled: true, error: execution.result.text }
      return { handled: true, ...execution.result.text === undefined ? {} : { text: execution.result.text } }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return { handled: true, error: message }
    }
  }

  /**
   * Effective command descriptors for the current agent. Warms the session on
   * first use so `/` autocompletes before any prompt was sent.
   */
  async list(): Promise<readonly CommandDescriptor[]> {
    const commands = this.ctx.get('commands')
    if (commands === undefined) return []
    try {
      const agent = await this.bridge.ensureAgent()
      return commands.list(agent)
    } catch {
      // Session warm-up failed (e.g. provider not configured) — no completions.
      return []
    }
  }

  /** pi-tui autocomplete provider over the live command registry. */
  autocompleteProvider(): AutocompleteProvider {
    return {
      triggerCharacters: ['/'],
      getSuggestions: async (
        lines: string[],
        cursorLine: number,
        cursorCol: number,
        options: { signal: AbortSignal },
      ): Promise<AutocompleteSuggestions | null> => {
        const line = lines[cursorLine] ?? ''
        const at = tokenAtCursor(line, cursorCol)
        if (at === undefined) return null
        // Only complete the command name itself (leading token, no arguments yet).
        if (at.start !== 0 && line.slice(0, at.start).trim() !== '') return null

        const descriptors = await this.list()
        if (descriptors.length === 0) return null

        const query = at.token.slice(1).toLowerCase()
        const items: AutocompleteItem[] = descriptors
          .filter(d => query === '' || d.name.toLowerCase().startsWith(query))
          .map(d => ({
            value: `/${d.name}`,
            label: `/${d.name}`,
            description: d.description,
          }))
        if (items.length === 0) return null
        return { items, prefix: at.token } satisfies AutocompleteSuggestions
      },
      applyCompletion: (
        lines: string[],
        cursorLine: number,
        cursorCol: number,
        item: AutocompleteItem,
        prefix: string,
      ) => {
        const line = lines[cursorLine] ?? ''
        const at = tokenAtCursor(line, cursorCol)
        if (at === undefined) return { lines, cursorLine, cursorCol }
        const before = line.slice(0, at.start)
        const after = line.slice(cursorCol)
        const completed = `${before}${item.value} ${after}`
        const nextLines = lines.slice()
        nextLines[cursorLine] = completed
        return {
          lines: nextLines,
          cursorLine,
          cursorCol: before.length + item.value.length + 1,
        }
      },
    }
  }
}
