/**
 * Skill invocation surface for the TUI.
 *
 * dsh exposes skills through the `ctx.skills` registry service (list / get /
 * snapshot); skills are not commands, so they are absent from the command
 * catalog. This module owns the pure logic behind two user-facing surfaces:
 *
 *   1. `/skill:<name>` completion + invocation. A skill is triggered the way
 *      the harness itself does it — the `/name ` gesture on a user message
 *      (packages/skill/tool-skill scans user messages in `agent/pre-step` and
 *      injects the rendered `<skill_content>`). The colon form `/skill:<name>`
 *      is a TUI convenience that is not a valid command name (parseCommand
 *      rejects `:`), so the TUI translates it to the native gesture
 *      (`/<name> `) and sends that through the normal prompt path.
 *   2. The `/settings` Skills browser's enable/disable toggle, which edits the
 *      skill's own SKILL.md frontmatter (`disable-model-invocation` /
 *      `user-invocable`) — the same keys skill-filesystem parses, so the
 *      harness watcher picks the change up with no restart.
 *
 * The pure functions here are unit-tested against the built lib/; the
 * frontmatter editing keeps this file's body and non-invocation keys intact.
 */

import type { AutocompleteItem } from '@earendil-works/pi-tui'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Enabled state of a skill for a human user: visible and loadable on every
 * surface (model catalog, `skill` tool, user gesture) only when both
 * invocation controls allow it. Matches how skill-filesystem derives the
 * defaults: an unset `disable-model-invocation` → modelInvocable true, an
 * unset `user-invocable` → userInvocable true.
 */
export function skillEnabled(summary: Pick<SkillSummary, 'invocation'>): boolean {
  return summary.invocation.modelInvocable && summary.invocation.userInvocable
}

/** Only skills a user may explicitly invoke appear in the picker / completion. */
export function isUserSkill(summary: Pick<SkillSummary, 'invocation'>): boolean {
  return summary.invocation.userInvocable
}

/**
 * Map a file-toggle read (readSkillToggle) onto the enabled boolean the
 * settings browser displays: a skill is enabled when neither invocation lock
 * is set. Mirrors `skillEnabled` for the on-disk-truth path — used on the
 * toggle write-failure re-read so a stale in-memory summary never lies about
 * the frontmatter on disk.
 */
export function skillToggleEnabled(toggle: { disable: boolean; invoke: boolean }): boolean {
  return !toggle.disable && toggle.invoke
}

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Parse a `/skill`-shaped line into its requested action.
 * @returns `{ kind: 'invoke', name }` for `/skill:<name>`; `{ kind: 'picker' }`
 *   for a bare `/skill`; `undefined` for anything else (not a skill command).
 */
export function parseSkillCommand(
  line: string,
): { kind: 'invoke'; name: string } | { kind: 'picker' } | undefined {
  const m = /^\/skill(?::(\S+))?\s*$/.exec(line.trim())
  if (m === null) return undefined
  const name = m[1]
  if (name === undefined || name === '') return { kind: 'picker' }
  // The public skill-name grammar is kebab-case; anything else (a space, a
  // second colon, an underscore) is malformed for a direct invocation.
  if (!SKILL_NAME_RE.test(name)) return undefined
  return { kind: 'invoke', name }
}

/**
 * The harness-native gesture line the model-facing injection recognizes:
 * `/name ` (a whitespace-bounded `/name` token — see tool-skill's
 * SKILL_GESTURE). Skill names are validated kebab-case by construction.
 */
export function skillGesture(name: string): string {
  return `/${name} `
}

/**
 * Extract the skill-completion query from a leading slash token, or `undefined`
 * when this token is not a skill completion. The token may carry the leading
 * `/` the cursor reads off the editor (the canonical shape from tokenAtCursor),
 * so it is stripped before matching. The bare `skill` prefix yields an empty
 * query (all user skills), `skill:<prefix>` filters by the text after the colon.
 */
export function skillCompletionQuery(token: string): string | undefined {
  const lower = token.toLowerCase().replace(/^\//, '')
  if (lower === 'skill') return ''
  if (lower.startsWith('skill:')) return lower.slice('skill:'.length)
  return undefined
}

// ------------------------------------------------------------ completion rows --

/**
 * Type of one completion candidate row, carried on the item outside the
 * pi-tui `AutocompleteItem` shape (label/value/description) so applyCompletion
 * and the tests can distinguish them without guessing at the value string:
 *
 * - `explicit-skill` — the `/skill:<name>` form: completing it is a complete
 *   invocation, so it must NOT gain the trailing-space separator.
 * - `native-skill` — a skill under its own `/name` in the mixed command list:
 *   completes like a command (trailing space readies it for arguments).
 * - `command` — a registry command row.
 */
export type CompletionItemKind = 'explicit-skill' | 'native-skill' | 'command'

/** The completion badge tag for each kind (fixed-width aligned, see badgeText). */
export const COMPLETION_BADGES: Readonly<Record<CompletionItemKind, string>> = {
  'explicit-skill': '[skill]',
  'native-skill': '[skill]',
  command: '[cmd]',
}

/** The widest badge tag — the alignment target every row's badge pads to. */
export const BADGE_WIDTH = Math.max(
  COMPLETION_BADGES['explicit-skill'].length,
  COMPLETION_BADGES.command.length,
)

/** The badge text of `kind`, right-padded to the common tag width. */
export function badgeText(kind: CompletionItemKind): string {
  return COMPLETION_BADGES[kind].padEnd(BADGE_WIDTH)
}

/** The display label for one completion row: aligned badge + candidate value. */
export function completionLabel(kind: CompletionItemKind, value: string): string {
  return `${badgeText(kind)} ${value}`
}

/** Fixed width of the toggle state prefix in the settings Skills row. */
export const SKILL_STATE_WIDTH = 5

/**
 * The settings Skills-row label: a fixed-width toggle state in front, then the
 * `[skill] <name>` completion row. Leading the row with the state (padded to a
 * common width) keeps every skill name on the same column regardless of how
 * long the state strings are — `'false'` is one column wider than `'true'`.
 */
export function skillSettingRowLabel(enabled: boolean, name: string): string {
  const state = enabled ? 'true' : 'false'
  return `${state.padEnd(SKILL_STATE_WIDTH)} ${completionLabel('explicit-skill', name)}`
}

// ------------------------------------------------------------- settings panel --

/**
 * One row in the self-drawn `/settings` Skills panel (drawn directly instead
 * of through pi-tui's SettingsList, whose forced right-hand value column
 * duplicated the toggle state).
 */
export interface SkillPanelRow {
  name: string
  description: string
  enabled: boolean
}

/** Clamp a panel cursor into `[0, length)`; an empty list pins the cursor at 0. */
export function clampSkillCursor(cursor: number, length: number): number {
  if (length <= 0) return 0
  if (cursor < 0) return 0
  if (cursor >= length) return length - 1
  return cursor
}

/**
 * Plain-text layout contract for one Skills panel row: a cursor-marker column
 * (`▸` selected / space otherwise), then the fixed-width state + `[skill]
 * <name>` row. The state appears exactly once, up front — the row never
 * repeats it at the tail (the bug the custom render fixes). The component
 * applies color per segment on top of this layout; tests assert the plain text.
 */
export function skillPanelRowLine(selected: boolean, enabled: boolean, name: string): string {
  const marker = selected ? '▸' : ' '
  return `${marker} ${skillSettingRowLabel(enabled, name)}`
}

/** The `kind` recorded on a completion item (`command` for unmarked rows). */
export function itemKind(item: AutocompleteItem): CompletionItemKind {
  const tagged = item as { kind?: CompletionItemKind }
  return tagged.kind ?? 'command'
}

/** A skill completion row (native `/name` or explicit `/skill:<name>`). */
export function isSkillCompletionItem(item: AutocompleteItem): boolean {
  const kind = itemKind(item)
  return kind === 'native-skill' || kind === 'explicit-skill'
}

/**
 * The explicit `/skill:<name>` row completes a whole invocation — it must not
 * gain the trailing-space separator a command/native skill gets.
 */
export function isExplicitSkillItem(item: AutocompleteItem): boolean {
  return itemKind(item) === 'explicit-skill'
}

/**
 * The native display name used for prefix filtering and mixed-list sorting:
 * the value after the leading `/`, with a `/skill:` form reduced to the name
 * after the colon so an explicit row sorts under its real skill name rather
 * than stacking in the `s` bucket.
 */
export function completionName(item: AutocompleteItem): string {
  const value = item.value
  if (value.startsWith('/skill:')) return value.slice('/skill:'.length)
  return value.slice(1)
}

/** Sort completion rows by their native display name (stable, locale-aware). */
export function sortCompletionItems(items: readonly AutocompleteItem[]): AutocompleteItem[] {
  return [...items].sort((a, b) => completionName(a).localeCompare(completionName(b)))
}

/**
 * Merge command rows with the user skills' native `/name` rows into one
 * mixed completion list (the generic `/` completion), each filtered by the
 * query prefix and the combined set sorted by native display name. Extracted
 * from the autocomplete provider so the interleave/filter/sort is unit-testable
 * without a live CommandService.
 */
export function mergeMixedSkillItems(
  commandItems: readonly AutocompleteItem[],
  nativeSkillItems: readonly AutocompleteItem[],
  query: string,
): AutocompleteItem[] {
  const filtered = [...commandItems, ...nativeSkillItems].filter(
    item => query === '' || completionName(item).toLowerCase().startsWith(query),
  )
  return sortCompletionItems(filtered)
}

/**
 * Autocomplete items for the explicit `/skill:<name>` form: `value`/`label`
 * are the full invocation (no argument), `description` is the skill's own
 * routing line. Carries `kind: 'explicit-skill'` so applyCompletion omits the
 * trailing-space separator (a completed `/skill:<name>` is a complete call —
 * Enter submits it). Filtered by the prefix after `skill:`.
 */
export function buildSkillCompletionCandidates(
  skills: readonly Pick<SkillSummary, 'name' | 'description' | 'invocation'>[],
  afterColon: string,
): AutocompleteItem[] {
  const q = afterColon.toLowerCase()
  return skills
    .filter(skill => isUserSkill(skill) && (q === '' || skill.name.toLowerCase().startsWith(q)))
    .map(skill => {
      const value = `/skill:${skill.name}`
      return {
        value,
        label: completionLabel('explicit-skill', value),
        description: skill.description,
        kind: 'explicit-skill' as const,
      }
    })
}

/**
 * Autocomplete items for a skill under its own native `/name`, for the generic
 * `/` command list where commands and skills mix. Carries
 * `kind: 'native-skill'` so applyCompletion adds the trailing-space separator
 * like a command row (the native `/name ` is a valid command-shaped line that
 * falls through to the harness skill gesture once submitted). Not
 * prefix-filtered here — the caller filters the mixed list by query.
 */
export function buildNativeSkillCandidates(
  skills: readonly Pick<SkillSummary, 'name' | 'description' | 'invocation'>[],
): AutocompleteItem[] {
  return skills
    .filter(isUserSkill)
    .map(skill => {
      const value = `/${skill.name}`
      return {
        value,
        label: completionLabel('native-skill', value),
        description: skill.description,
        kind: 'native-skill' as const,
      }
    })
}

// ------------------------------------------------------------- frontmatter --

/**
 * The frontmatter key transform for one toggle action. Disabling hides a skill
 * from every surface: `disable-model-invocation: true` clears the model-facing
 * catalog/tool and `user-invocable: false` clears the user gesture/picker.
 * Enabling restores the defaults by removing both keys (skill-filesystem treats
 * an absent key as permissive — a skill with neither key is fully enabled).
 */
export function skillDisableUpdates(): Readonly<Record<string, string | null>> {
  return { 'disable-model-invocation': 'true', 'user-invocable': 'false' }
}

export function skillEnableUpdates(): Readonly<Record<string, string | null>> {
  return { 'disable-model-invocation': null, 'user-invocable': null }
}

/**
 * Apply a set of frontmatter key writes/removals to a markdown file, keeping
 * every other line and the body verbatim. Existing keys are rewritten in
 * place; missing keys are inserted just before the closing fence; `null`
 * removes the key's line. An absent opening or closing fence is an error.
 * Returns an error message, or `undefined` on success (an empty diff still
 * succeeds). The write is atomic (tmp + rename in the same directory) so the
 * harness watcher never observes half a file.
 */
export function applySkillFrontmatter(
  path: string,
  updates: Readonly<Record<string, string | null>>,
): string | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return `cannot read skill file: ${path}`
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  // A YAML frontmatter block opens at line 0 and closes at the next `---`.
  if (lines[0]?.trim() !== '---') return 'missing frontmatter (file must start with `---`)'
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i
      break
    }
  }
  if (close < 0) return 'missing closing frontmatter fence'
  let changed = false
  for (const [key, value] of Object.entries(updates)) {
    const rendered = value === null ? null : `${key}: ${value}`
    let found = -1
    for (let i = 1; i < close; i++) {
      // Match the key at the start of the line (hyphens included), then a colon.
      if (lines[i].trimStart().startsWith(`${key}:`)) {
        found = i
        break
      }
    }
    if (found >= 0) {
      if (rendered === null) {
        lines.splice(found, 1)
        close--
        changed = true
      } else if (lines[found] !== rendered) {
        lines[found] = rendered
        changed = true
      }
    } else if (rendered !== null) {
      lines.splice(close, 0, rendered)
      close++
      changed = true
    }
  }
  if (!changed) return undefined
  const out = lines.join(eol)
  // Atomic replace in the same directory: write a sibling then rename over, so
  // a crash or an early watcher event never sees a truncated frontmatter.
  const pathBase = path.split('/').pop() ?? 'skill'
  const tmp = join(dirname(path), `.${pathBase}.tmp-${process.pid}`)
  try {
    writeFileSync(tmp, out)
    renameSync(tmp, path)
  } catch (error) {
    // A failed write/rename can leave the `.SKILL.md.tmp-<pid>` sibling behind;
    // clean it up so a crash or an early watcher event never sees a stray file.
    try {
      rmSync(tmp, { force: true })
    } catch {
      // Best-effort — the original error is what we surface.
    }
    const message = error instanceof Error ? error.message : String(error)
    return `cannot write skill file: ${message}`
  }
  return undefined
}

/**
 * Read the frontmatter of a skill markdown file and report the current toggle
 * values (`disable` = `disable-model-invocation: true`, `invoke` =
 * `user-invocable` absent/true). Returns `undefined` when the file is
 * unreadable or has no usable frontmatter (the caller degrades to the
 * in-memory summary).
 */
export function readSkillToggle(
  path: string,
): { disable: boolean; invoke: boolean } | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return undefined
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i
      break
    }
  }
  if (close < 0) return undefined
  let disable = false
  let invoke = true
  for (let i = 1; i < close; i++) {
    if (lines[i].trimStart().startsWith('disable-model-invocation:')) {
      disable = lines[i].includes('true')
    } else if (lines[i].trimStart().startsWith('user-invocable:')) {
      invoke = !lines[i].includes('false')
    }
  }
  return { disable, invoke }
}
