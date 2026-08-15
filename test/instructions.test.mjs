/**
 * User-global instructions tests (src/instructions.ts): the TUI ensures the
 * todo-lifecycle section exists in `~/.dsh/AGENTS.md` (dsh's native
 * instruction channel, read by every session) — creating the file when
 * absent, appending the section when the marker is missing, and never
 * touching an already-marked file. Idempotent and atomic (tmp + rename).
 * Runs against the built lib/ (npm test → pretest build).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureTodoLifecycleInstructions, TODO_LIFECYCLE_MARKER, TODO_LIFECYCLE_SECTION } from '../lib/instructions.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-tui-instructions-'))
}

test('creates the file with the todo-lifecycle section when absent', async () => {
  const dir = await tempDir()
  try {
    const path = join(dir, 'AGENTS.md')
    assert.equal(await ensureTodoLifecycleInstructions(path), undefined)
    const content = await readFile(path, 'utf8')
    assert.ok(content.includes(TODO_LIFECYCLE_MARKER), 'marker present')
    assert.ok(content.includes('write an EMPTY todo list'), 'guidance present')
    // Idempotent: a second call leaves the file byte-identical.
    const before = await readFile(path, 'utf8')
    assert.equal(await ensureTodoLifecycleInstructions(path), undefined)
    assert.equal(await readFile(path, 'utf8'), before, 'no rewrite when marked')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('appends the section to an existing file without the marker', async () => {
  const dir = await tempDir()
  try {
    const path = join(dir, 'AGENTS.md')
    await writeFile(path, '# My project notes\n\nBe careful with prod.\n', 'utf8')
    assert.equal(await ensureTodoLifecycleInstructions(path), undefined)
    const content = await readFile(path, 'utf8')
    assert.ok(content.startsWith('# My project notes'), 'existing content preserved')
    assert.ok(content.includes(TODO_LIFECYCLE_MARKER), 'section appended')
    assert.ok(content.includes('Be careful with prod.'), 'existing text intact')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('leaves an already-marked file byte-identical', async () => {
  const dir = await tempDir()
  try {
    const path = join(dir, 'AGENTS.md')
    const marked = `# Notes\n\n${TODO_LIFECYCLE_SECTION}\nMore notes.\n`
    await writeFile(path, marked, 'utf8')
    assert.equal(await ensureTodoLifecycleInstructions(path), undefined)
    assert.equal(await readFile(path, 'utf8'), marked, 'no rewrite when already marked')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reports a failure instead of throwing (missing parent dir)', async () => {
  const dir = await tempDir()
  try {
    const path = join(dir, 'no-such-dir', 'AGENTS.md')
    const error = await ensureTodoLifecycleInstructions(path)
    assert.ok(typeof error === 'string' && error !== '', 'error message returned, not thrown')
    // The tmp file must not linger.
    await assert.rejects(() => readFile(`${path}.tmp`))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
