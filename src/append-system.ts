/**
 * APPEND_SYSTEM.md support — pi's convention (`~/.pi/agent/APPEND_SYSTEM.md`),
 * dsh side: `~/.dsh/APPEND_SYSTEM.md`. A user-editable file whose content is
 * appended to the system prompt of every agent this TUI creates. The TUI
 * registers a system-prompt section whose text provider reads the file at
 * each assembly, so edits apply to the very next request — no restart, no
 * watcher.
 *
 * The TUI seeds a fresh file at first run (`ensureAppendSystemFile`) from
 * the shipped template `templates/APPEND_SYSTEM.md` (the user's pi
 * orchestrator-identity definition in English — content lives in the FILE,
 * not in code), then maintains its marked todo-lifecycle section. An
 * existing file is user-owned — the TUI only maintains its marker section
 * there, idempotently (marker `<!-- dsh-tui-pi:todo-lifecycle -->`),
 * atomically (tmp + rename) and best-effort — a failure is contained and
 * reported, never breaks TUI startup. `migrateAgentsMdTodoSection` removes
 * the todo section's earlier incarnation from `~/.dsh/AGENTS.md` (the
 * pre-APPEND_SYSTEM.md delivery channel) so the guidance is not delivered
 * twice.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** The user-editable append file path (`$DSH_HOME/APPEND_SYSTEM.md`). */
export function appendSystemPath(home: string = dshHome()): string {
  return join(home, 'APPEND_SYSTEM.md')
}

/**
 * The shipped English template (`templates/APPEND_SYSTEM.md`): the user's pi
 * orchestrator-identity definition translated to English. The content lives
 * in this FILE, not in code — installation seeds `~/.dsh/APPEND_SYSTEM.md`
 * from it (a fresh file only; existing files are user-owned).
 */
export function appendSystemTemplatePath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'APPEND_SYSTEM.md')
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
 * Ensure the append file exists with the shipped template and the TUI's
 * marked todo-lifecycle section: a missing file is seeded from
 * `templates/APPEND_SYSTEM.md` (the English orchestrator template) followed
 * by the marked section; an existing file is user-owned — only the marked
 * section is appended when its marker is missing, and a marked file is left
 * untouched.
 * @param path - target file (injectable for tests).
 * @param templatePath - the shipped template (injectable for tests).
 * @returns an error message on failure, undefined on success (including the
 *   no-op case where the marker is already present).
 */
export async function ensureAppendSystemFile(
  path: string = appendSystemPath(),
  templatePath: string = appendSystemTemplatePath(),
): Promise<string | undefined> {
  let existing: string
  try {
    existing = await readFile(path, 'utf8')
  } catch {
    existing = ''
  }
  if (existing.includes(TODO_LIFECYCLE_MARKER)) return undefined
  if (existing !== '') {
    return writeAtomically(path, `${existing.replace(/\s+$/u, '')}\n\n${TODO_LIFECYCLE_SECTION}`)
  }
  // Fresh file: seed from the shipped template, then the marked section. A
  // missing template (broken tarball) degrades to the marked section alone.
  let template: string
  try {
    template = await readFile(templatePath, 'utf8')
  } catch {
    template = ''
  }
  const seed = template === '' ? TODO_LIFECYCLE_SECTION : `${template.replace(/\s+$/u, '')}\n\n${TODO_LIFECYCLE_SECTION}`
  return writeAtomically(path, seed)
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
