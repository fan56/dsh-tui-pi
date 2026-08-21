/**
 * Skill surface helpers for the TUI.
 *
 * dsh exposes skills through the `ctx.skills` registry service (list / get /
 * snapshot); skills are not commands, so they are absent from the command
 * catalog. A user-invocable skill is triggered the way the harness itself
 * does it — the `/name ` gesture on a user message (packages/skill/tool-skill
 * scans user messages in `agent/pre-step` and injects the rendered
 * `<skill_content>`). This module owns the pure logic behind:
 *
 *   1. Completion: each user skill appears in the generic `/` dropdown as a
 *      native `/name` row alongside the commands (buildNativeSkillCandidates
 *      + mergeMixedSkillItems). Submitting such a line falls through the
 *      command dispatcher to the model untouched, where tool-skill's
 *      pre-step does the injection.
 *   2. The `/skills` browser's FW table rows, filtering and navigation.
 *   3. The enable/disable toggle, which edits the skill's own SKILL.md
 *      frontmatter (`disable-model-invocation` / `user-invocable`) — the
 *      same keys skill-filesystem parses, so the harness watcher picks the
 *      change up with no restart.
 *
 * The pure functions here are unit-tested against the built lib/; the
 * frontmatter editing keeps this file's body and non-invocation keys intact.
 */

import type { AutocompleteItem } from '@earendil-works/pi-tui'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { rowMarker, TABLE_SEP } from './panels.ts'
import type { UsageSnapshot } from './usage.ts'

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

// ------------------------------------------------------------ completion rows --

/**
 * Type of one completion candidate row, carried on the item outside the
 * pi-tui `AutocompleteItem` shape (label/value/description) so applyCompletion
 * and the tests can distinguish them without guessing at the value string:
 *
 * - `explicit-skill` — a bare skill-name row without the leading slash (the
 *   label vocabulary shared with the settings/Skills row label); kept
 *   distinct from `command` so its badge stays `[s]`.
 * - `native-skill` — a skill under its own `/name` in the mixed command list:
 *   completes like a command (trailing space readies it for arguments).
 * - `command` — a registry command row.
 */
export type CompletionItemKind = 'explicit-skill' | 'native-skill' | 'command'

/** The completion badge tag for each kind (fixed-width aligned, see badgeText). */
export const COMPLETION_BADGES: Readonly<Record<CompletionItemKind, string>> = {
  'explicit-skill': '[s]',
  'native-skill': '[s]',
  command: '[c]',
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

// ---------------------------------------------------- styled (italic) rows --

// The editor-inline slash-autocomplete dropdown renders item rows raw
// (pi-tui SelectList has no per-row theme hook for unselected rows — only the
// whole selected row is wrapped in selectedText), so styling skill rows means
// emitting the ANSI SGR ourselves in the label + description. pi-tui's text
// pipeline fully supports that: visibleWidth strips SGR as zero-width, and a
// truncated result is terminated with a full \x1b[0m reset
// (finalizeTruncatedResult), so a truncated italic label closes itself — the
// dropped \x1b[23m never leaks past the row. Verified against pi-tui 0.84.2's
// real SelectList (see test/skills.test.mjs truncation regression).
const ITALIC_ON = '\x1b[3m'
const ITALIC_OFF = '\x1b[23m' // italic-off only — a full \x1b[0m reset would drop the selected-row backdrop

/**
 * The display label for one completion row in the slash dropdown: skill rows
 * render the WHOLE label (aligned badge + candidate value) as one italic span;
 * command rows stay completely plain (no ANSI at all). Consumers that need the
 * plain-text layout contract (the settings Skills row, width math) keep
 * `completionLabel`.
 */
export function styledCompletionLabel(kind: CompletionItemKind, value: string): string {
  const text = completionLabel(kind, value)
  return kind === 'command' ? text : `${ITALIC_ON}${text}${ITALIC_OFF}`
}

/**
 * The dropdown description for a skill row: rendered italic to match the
 * whole-line treatment. An empty — or whitespace-only — description stays
 * empty (a falsy description is what sends the row to SelectList's
 * no-description branch; a whitespace-only one would otherwise render a
 * stray run of italic spaces).
 */
export function styledDescription(text: string): string {
  return text.trim() === '' ? '' : `${ITALIC_ON}${text}${ITALIC_OFF}`
}

/** Fixed width of the toggle state prefix in the settings Skills row. */
export const SKILL_STATE_WIDTH = 5

/**
 * The settings Skills-row label: a fixed-width toggle state in front, then the
 * `[s] <name>` completion row. Leading the row with the state (padded to a
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
 * The scroll offset that keeps `cursor` inside `[offset, offset + visibleRows)`
 * for a list of `length` items. An empty list or zero visible rows returns 0.
 * Pure helper so the scrolling logic is unit-testable without a live TUI.
 */
export function clampScrollOffset(cursor: number, visibleRows: number, length: number, currentOffset: number): number {
  if (length <= 0 || visibleRows <= 0) return 0
  if (cursor < currentOffset) return cursor
  if (cursor >= currentOffset + visibleRows) return cursor - visibleRows + 1
  return currentOffset
}

/** Fixed page size for the settings Skills panel paged navigation (PgUp/PgDn). */
export const SKILL_PAGE_SIZE = 10

/** The moves the settings Skills panel cursor supports. */
export type SkillJump = 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end'

/**
 * The next cursor for a `jump` from `cursor` over `length` rows, clamped by
 * `clampSkillCursor`. `home` pins to the first row, `end` to the last; both
 * are no-ops on an empty list. `pageSize` (PgUp/PgDn step) defaults to
 * `SKILL_PAGE_SIZE`.
 */
export function skillJumpCursor(
  cursor: number,
  length: number,
  jump: SkillJump,
  pageSize = SKILL_PAGE_SIZE,
): number {
  switch (jump) {
    case 'up':
      return clampSkillCursor(cursor - 1, length)
    case 'down':
      return clampSkillCursor(cursor + 1, length)
    case 'pageUp':
      return clampSkillCursor(cursor - pageSize, length)
    case 'pageDown':
      return clampSkillCursor(cursor + pageSize, length)
    case 'home':
      return clampSkillCursor(0, length)
    case 'end':
      return clampSkillCursor(length - 1, length)
  }
}

// ------------------------------------------------------------------ filter --

/**
 * Filter skill-panel rows by a case-insensitive prefix match on the skill name.
 * Returns a new array (never mutates the input). An empty query returns all
 * rows. Pure helper so the filtering logic is unit-testable without a live TUI.
 */
export function filterSkillRows(
  rows: readonly SkillPanelRow[],
  query: string,
): SkillPanelRow[] {
  if (query === '') return [...rows]
  const lower = query.toLowerCase()
  return rows.filter(row => row.name.toLowerCase().startsWith(lower))
}

/**
 * Detect a printable single-character input (ASCII visible, not DEL/0x7f).
 * Returns `true` for characters that should accumulate into the filter query.
 */
export function isPrintableInput(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 0x20 && data.charCodeAt(0) !== 0x7f
}

/**
 * Plain-text layout contract for one Skills panel row: the cursor-marker
 * column (`▸` selected / spaces otherwise), the fixed-width ON icon column
 * (`●` enabled / `○` disabled), the `│` column separator, then the (already
 * padded) skill name — the FW table language every picker shares, with no
 * index column. The component applies color per segment on top of this
 * layout; tests assert the plain text.
 *
 * Prefix column widths: marker(2) + icon(2) = 4.
 */
export function skillPanelRowLine(selected: boolean, enabled: boolean, name: string): string {
  return `${rowMarker(selected)}${(enabled ? '●' : '○').padEnd(2)}${TABLE_SEP}${name}`
}

/** The `kind` recorded on a completion item (`command` for unmarked rows). */
export function itemKind(item: AutocompleteItem): CompletionItemKind {
  const tagged = item as { kind?: CompletionItemKind }
  return tagged.kind ?? 'command'
}

/** A skill completion row (either skill kind, never a plain command row). */
export function isSkillCompletionItem(item: AutocompleteItem): boolean {
  const kind = itemKind(item)
  return kind === 'native-skill' || kind === 'explicit-skill'
}

/**
 * The native display name used for prefix filtering and mixed-list sorting:
 * the value after the leading `/`.
 */
export function completionName(item: AutocompleteItem): string {
  return item.value.slice(1)
}

/**
 * Frequency-first comparator over usage counts: higher count wins; equal
 * counts fall back to native name order. `Array.prototype.sort` is stable,
 * so rows the comparator cannot separate (same count AND same name) keep
 * their input order — the non-mutation/stability guarantees of the plain
 * sort hold here too.
 */
function usageFirstCompare(a: AutocompleteItem, b: AutocompleteItem, usage: UsageSnapshot): number {
  const byUsage = (usage.get(completionName(b)) ?? 0) - (usage.get(completionName(a)) ?? 0)
  if (byUsage !== 0) return byUsage
  return completionName(a).localeCompare(completionName(b))
}

/**
 * Sort completion rows for the generic `/` dropdown (stable, never mutates
 * the input). With a non-empty `usage` table (name → count), most-used rows
 * come first and native display name only breaks ties; without usage data
 * every row has count 0, which degenerates to exactly the historical
 * name-only ordering.
 */
export function sortCompletionItems(
  items: readonly AutocompleteItem[],
  usage?: UsageSnapshot,
): AutocompleteItem[] {
  const ordered = [...items]
  if (usage === undefined || usage.size === 0) {
    ordered.sort((a, b) => completionName(a).localeCompare(completionName(b)))
    return ordered
  }
  ordered.sort((a, b) => usageFirstCompare(a, b, usage))
  return ordered
}

/**
 * Merge command rows with the user skills' native `/name` rows into one
 * mixed completion list (the generic `/` completion), each filtered by the
 * query prefix and the combined set sorted by usage frequency (when a usage
 * table is supplied) with native display name as tie-break. Extracted from
 * the autocomplete provider so the interleave/filter/sort is unit-testable
 * without a live CommandService. Because sorting runs after filtering, a
 * filtered-down subset keeps its frequency-first ordering.
 */
export function mergeMixedSkillItems(
  commandItems: readonly AutocompleteItem[],
  nativeSkillItems: readonly AutocompleteItem[],
  query: string,
  usage?: UsageSnapshot,
): AutocompleteItem[] {
  const filtered = [...commandItems, ...nativeSkillItems].filter(
    item => query === '' || completionName(item).toLowerCase().startsWith(query),
  )
  return sortCompletionItems(filtered, usage)
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
        label: styledCompletionLabel('native-skill', value),
        description: styledDescription(skill.description),
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
