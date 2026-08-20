/**
 * Slash-command integration with dsh's own command registry.
 *
 * dsh-tui-pi never re-implements a command: autocomplete lists
 * `ctx.commands.list(agent)` and submission routes through
 * `executeCommand(ctx.commands, agent, line, signal)`. Anything that is not a
 * resolvable command falls through to the model as an ordinary prompt, so
 * every command registered by dsh packages (plan, compact, feedback, export,
 * permission, goal, …) works here unchanged and future registrations appear
 * automatically.
 *
 * One exemption: TUI-owned commands that never touch the receiving agent
 * (model pickers, settings browser, session info/resume) are dispatched
 * locally when no live agent exists — dsh's execute path addresses an agent
 * and would mint a throwaway session just to run them.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  parseCommand,
  type CommandDescriptor,
  type CommandExecution,
  type CommandResult,
} from '@deepseek-ai/dsh-commands'
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment/types'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from '@earendil-works/pi-tui'
import {
  buildNativeSkillCandidates,
  buildSkillCompletionCandidates,
  completionLabel,
  isExplicitSkillItem,
  mergeMixedSkillItems,
  skillCompletionQuery,
} from './skills.ts'
import type { DshSessionBridge } from './session.ts'

/**
 * Token ending at the cursor on one editor line, for command detection.
 * Returns the leading slash token when the caret sits inside one. The token
 * charset admits `:` (after the first letter) so the TUI's `/skill:<name>`
 * form reads as a single token and drives skill completion.
 */
function tokenAtCursor(line: string, cursorCol: number): { token: string; start: number } | undefined {
  const upto = line.slice(0, cursorCol)
  const match = /(^|\s)\/([a-z][a-z0-9_:-]*)?$/u.exec(upto)
  if (match === null) return undefined
  const start = match.index + (match[1] ?? '').length
  return { token: upto.slice(start), start }
}

/**
 * Call `commands.execute` across dsh-commands API versions.
 *
 * rc.7 signature: execute(agent, line, signal)               — 3 params
 * rc.8 signature: execute(agent, line, images, signal)       — 4 params
 *
 * The overloaded declaration accepts both call shapes so callers always
 * pass `(commands, agent, line, signal)`.  The implementation body
 * dispatches to the correct argument count: for rc.7 the 3-arg form
 * (signal in position 3); for rc.8 the 4-arg form (empty images array
 * in position 3, signal in position 4).
 *
 * @internal — exported for unit testing.
 */
export function executeCommand(
  commands: { execute: (...args: never[]) => unknown },
  agent: Agent,
  line: string,
  signal: AbortSignal,
): Promise<CommandExecution | undefined>
export function executeCommand(
  commands: { execute: (...args: never[]) => unknown },
  agent: Agent,
  line: string,
  images: readonly EncodedImageAttachment[],
  signal: AbortSignal,
): Promise<CommandExecution | undefined>
export function executeCommand(
  commands: { execute: (...args: never[]) => unknown },
  agent: Agent,
  line: string,
  imagesOrSignal: readonly EncodedImageAttachment[] | AbortSignal,
  maybeSignal?: AbortSignal,
): Promise<CommandExecution | undefined> {
  if (maybeSignal !== undefined) {
    // Explicit 4-arg call: caller provided images + signal directly.
    return (commands.execute as (...args: unknown[]) => unknown)(
      agent, line, imagesOrSignal, maybeSignal,
    ) as Promise<CommandExecution | undefined>
  }
  // Caller passed only (agent, line, signal) — route by runtime arity.
  // rc.8 added an `images` parameter before `signal`; detect via .length
  // and insert an empty images array when needed.
  const signal = imagesOrSignal as AbortSignal
  if (commands.execute.length >= 4) {
    return (commands.execute as (...args: unknown[]) => unknown)(
      agent, line, [], signal,
    ) as Promise<CommandExecution | undefined>
  }
  return (commands.execute as (...args: unknown[]) => unknown)(
    agent, line, signal,
  ) as Promise<CommandExecution | undefined>
}

/** A TUI-owned command body that needs no receiving agent. */
export type LocalCommandHandler =
  (rawInput: string, signal: AbortSignal) => CommandResult | Promise<CommandResult>

export class CommandService {
  private readonly ctx: Context
  private readonly bridge: DshSessionBridge
  /** TUI-owned command bodies, dispatchable without a live agent. */
  private readonly local = new Map<string, LocalCommandHandler>()

  constructor(ctx: Context, bridge: DshSessionBridge) {
    this.ctx = ctx
    this.bridge = bridge
  }

  /**
   * Register a local command body (the same handler the ctx.commands
   * registration wraps). It is dispatched directly when no live agent
   * exists, avoiding a throwaway session for agentless commands.
   */
  registerLocal(name: string, handler: LocalCommandHandler): void {
    this.local.set(name, handler)
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

    // Agentless local commands never warm the session — /resume or /session
    // on a fresh TUI must not mint a session just to run.
    const localHandler = this.local.get(parsed.name)
    if (localHandler !== undefined && this.bridge.getAgent() === undefined) {
      try {
        const result = await localHandler(parsed.rawInput, signal)
        if (result.kind === 'error') return { handled: true, error: result.text }
        return { handled: true, ...result.text === undefined ? {} : { text: result.text } }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        return { handled: true, error: message }
      }
    }

    // Commands address a live agent; warm the session when it does not exist.
    let agent: Agent
    try {
      agent = await this.bridge.ensureAgent()
    } catch (error: unknown) {
      // Warm-up failed (e.g. provider not configured) — surface instead of
      // rejecting into an unhandled promise rejection.
      const message = error instanceof Error ? error.message : String(error)
      return { handled: true, error: message }
    }
    if (commands.find(agent, parsed.name) === undefined) {
      // Syntactically a command but unregistered → treat as ordinary text so
      // the model still sees it (matches "unknown command" falling through).
      return { handled: false }
    }

    try {
      const execution = await executeCommand(commands, agent, line, signal)
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

        // A `/skill` or `/skill:<prefix>` token yields the explicit
        // `/skill:<name>` candidates (a dedicated list, not the mixed one).
        // skillCompletionQuery strips the token's leading `/`, so the
        // canonical `/skill:da` token from tokenAtCursor matches here.
        const skillQuery = skillCompletionQuery(at.token)
        if (skillQuery !== undefined) {
          const skillItems = await this.skillCandidates(skillQuery)
          if (skillItems.length === 0) return null
          return { items: skillItems, prefix: at.token } satisfies AutocompleteSuggestions
        }

        // Generic `/` completion: commands and the user skills' native `/name`
        // rows in one mixed list, sorted by display name and filtered by the
        // token after the slash. This keeps skills interleaved with commands
        // (never grouped under their `/skill:` prefix, which would cluster all
        // of them in a single `s` bucket).
        const query = at.token.slice(1).toLowerCase()
        const descriptors = await this.list()
        const commandItems: AutocompleteItem[] = descriptors
          .filter(d => query === '' || d.name.toLowerCase().startsWith(query))
          .map(d => ({
            value: `/${d.name}`,
            label: completionLabel('command', `/${d.name}`),
            description: d.description,
            kind: 'command' as const,
          }))
        const nativeSkillItems = await this.nativeSkillCandidates()
        const items = mergeMixedSkillItems(commandItems, nativeSkillItems, query)
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
        // A completed explicit `/skill:<name>` is a full invocation — the
        // trailing-space separator (which readies a command's arguments)
        // would just be noise, so it is inserted exactly with the cursor at
        // the end. Native `/name` skills and commands keep the space.
        const isExplicit = isExplicitSkillItem(item)
        const completed = `${before}${item.value}${isExplicit ? '' : ' '}${after}`
        const nextLines = lines.slice()
        nextLines[cursorLine] = completed
        return {
          lines: nextLines,
          cursorLine,
          cursorCol: before.length + item.value.length + (isExplicit ? 0 : 1),
        }
      },
    }
  }

  /**
   * The live (optional) `ctx.skills` registry's user-invocable summaries,
   * scoped to the current agent/cwd. An absent or failing service yields none.
   */
  private async listSkills(): Promise<readonly SkillSummary[]> {
    const skills = this.ctx.get('skills')
    if (skills === undefined) return []
    const agent = this.bridge.getAgent()
    const cwd = agent?.session.header.cwd ?? process.cwd()
    try {
      return await skills.list({ scope: agent, cwd })
    } catch {
      return []
    }
  }

  /**
   * Explicit `/skill:<name>` completion candidates for a `/skill:<prefix>`
   * query. Only user-invocable skills appear.
   */
  private async skillCandidates(afterColon: string): Promise<AutocompleteItem[]> {
    return buildSkillCompletionCandidates(await this.listSkills(), afterColon)
  }

  /** Native `/name` skill candidates for the mixed `/` command list. */
  private async nativeSkillCandidates(): Promise<AutocompleteItem[]> {
    return buildNativeSkillCandidates(await this.listSkills())
  }
}
