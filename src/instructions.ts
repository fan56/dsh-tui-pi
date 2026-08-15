/**
 * User-global workspace instructions (`~/.dsh/AGENTS.md`): dsh reads this
 * file as the fixed user-global baseline for EVERY session
 * (dsh-agent-instructions, mounted by dsh-base) — the native channel to
 * teach the model UI conventions, a real file the user can see and edit,
 * unlike a system-prompt patch. The TUI ensures its todo-lifecycle section
 * exists there, idempotently keyed by an HTML-comment marker: the file is
 * created when absent, the section appended when the marker is missing, and
 * left untouched when already present. The write is atomic (tmp + rename)
 * and best-effort — a failure is contained and reported, never breaks TUI
 * startup.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Idempotency marker for the TUI-owned section of the instructions file. */
export const TODO_LIFECYCLE_MARKER = '<!-- dsh-tui-pi:todo-lifecycle -->'

/**
 * The TUI-owned section: the model must clear the todo list when the work is
 * done, because `todo/write` is a whole-list snapshot (last-write-wins) and
 * an all-completed list would stay pinned above the chat input.
 */
export const TODO_LIFECYCLE_SECTION = `${TODO_LIFECYCLE_MARKER}
## Todo list lifecycle (dsh-tui-pi)

The UI renders your todo list as a fixed panel above the chat input. Keep
items \`pending\` or \`in_progress\` while they are not done. When EVERY todo is
completed — no pending or in-progress items remain — write an EMPTY todo list
(\`todos: []\`) so the panel clears. Never leave a fully-completed list behind.
`

/** The user-global instructions file path (`$DSH_HOME` or `~/.dsh`). */
export function userGlobalInstructionsPath(dshHome: string = process.env.DSH_HOME ?? join(homedir(), '.dsh')): string {
  return join(dshHome, 'AGENTS.md')
}

/**
 * Ensure the todo-lifecycle section exists in the user-global AGENTS.md.
 * @param path - target file (injectable for tests).
 * @returns an error message on failure, undefined on success (including the
 *   no-op case where the marker is already present).
 */
export async function ensureTodoLifecycleInstructions(path: string = userGlobalInstructionsPath()): Promise<string | undefined> {
  let existing: string
  try {
    existing = await readFile(path, 'utf8')
  } catch {
    existing = ''
  }
  if (existing.includes(TODO_LIFECYCLE_MARKER)) return undefined
  const next = existing === '' ? TODO_LIFECYCLE_SECTION : `${existing.replace(/\s+$/u, '')}\n\n${TODO_LIFECYCLE_SECTION}`
  const tmp = `${path}.tmp`
  try {
    await writeFile(tmp, next, 'utf8')
    await rename(tmp, path)
    return undefined
  } catch (error) {
    // Best-effort: never leave the tmp file behind, never break startup.
    try { await unlink(tmp) } catch { /* already gone */ }
    return error instanceof Error ? error.message : String(error)
  }
}
