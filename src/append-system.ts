/**
 * APPEND_SYSTEM.md support — pi's convention (`~/.pi/agent/APPEND_SYSTEM.md`),
 * dsh side: `~/.dsh/APPEND_SYSTEM.md`. A user-editable file whose content is
 * appended to the system prompt of every agent this TUI creates. The TUI
 * registers a system-prompt section whose text provider reads the file at
 * each assembly, so edits apply to the very next request — no restart, no
 * watcher.
 *
 * The TUI also keeps its own todo-lifecycle guidance in the same file:
 * `ensureTodoLifecycleInstructions` is idempotent (marker
 * `<!-- dsh-tui-pi:todo-lifecycle -->`), atomic (tmp + rename) and
 * best-effort — a failure is contained and reported, never breaks TUI
 * startup. `migrateAgentsMdTodoSection` removes the section's earlier
 * incarnation from `~/.dsh/AGENTS.md` (dsh's user-global instruction file)
 * so the guidance is not delivered twice.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Idempotency marker for the TUI-owned section of the append file. */
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

/** Default harness home: `$DSH_HOME` or `~/.dsh`. */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** The user-editable append file path (`$DSH_HOME/APPEND_SYSTEM.md`). */
export function appendSystemPath(home: string = dshHome()): string {
  return join(home, 'APPEND_SYSTEM.md')
}

/** The user-global AGENTS.md path (the legacy delivery channel). */
function agentsMdPath(home: string = dshHome()): string {
  return join(home, 'AGENTS.md')
}

/**
 * Synchronous read for the system-prompt section provider (the provider
 * signature is sync; the file is small and read once per assembly).
 * @returns the file content, or '' when missing/unreadable — an empty
 *   section is dropped by the prompt renderer.
 */
export function readAppendSystem(path: string = appendSystemPath()): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Ensure the todo-lifecycle section exists in APPEND_SYSTEM.md: creates the
 * file when absent, appends the section when the marker is missing, leaves a
 * marked file untouched.
 * @param path - target file (injectable for tests).
 * @returns an error message on failure, undefined on success (including the
 *   no-op case where the marker is already present).
 */
export async function ensureTodoLifecycleInstructions(path: string = appendSystemPath()): Promise<string | undefined> {
  let existing: string
  try {
    existing = await readFile(path, 'utf8')
  } catch {
    existing = ''
  }
  if (existing.includes(TODO_LIFECYCLE_MARKER)) return undefined
  const next = existing === '' ? TODO_LIFECYCLE_SECTION : `${existing.replace(/\s+$/u, '')}\n\n${TODO_LIFECYCLE_SECTION}`
  return writeAtomically(path, next)
}

/**
 * Migration: strip the TUI-owned todo-lifecycle block from `~/.dsh/AGENTS.md`
 * (the earlier delivery channel). No-op when the marker is absent; the file
 * is deleted when the strip leaves it empty. The block is removed by exact
 * content match, so a user-edited block is left alone (best-effort). Every
 * write here is atomic and failure-contained.
 * @returns an error message on failure, undefined on success or no-op.
 */
export async function migrateAgentsMdTodoSection(path: string = agentsMdPath()): Promise<string | undefined> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch {
    return undefined // no AGENTS.md — nothing to migrate
  }
  if (!content.includes(TODO_LIFECYCLE_MARKER)) return undefined
  const next = content.trim() === TODO_LIFECYCLE_SECTION.trim()
    ? ''
    : content.split(TODO_LIFECYCLE_SECTION).join('').replace(/\n{3,}/gu, '\n\n').trim()
  if (next === '') {
    try { await unlink(path) } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return undefined
  }
  return writeAtomically(path, `${next}\n`)
}

/** Atomic write (tmp + rename); the tmp file is cleaned up on failure. */
async function writeAtomically(path: string, content: string): Promise<string | undefined> {
  const tmp = `${path}.tmp`
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
    return undefined
  } catch (error) {
    try { await unlink(tmp) } catch { /* already gone */ }
    return error instanceof Error ? error.message : String(error)
  }
}
