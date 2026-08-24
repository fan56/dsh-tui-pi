/**
 * APPEND_SYSTEM.md tests (src/append-system.ts): the user-editable
 * `~/.dsh/APPEND_SYSTEM.md` (pi's convention, dsh side) is appended to the
 * system prompt of agents this TUI creates — read per assembly by the
 * section provider (`readAppendSystem`), so edits hot-apply. The TUI keeps
 * its todo-lifecycle section in the same file (idempotent marker, atomic
 * write) and migrates the legacy AGENTS.md marker block out.
 * Runs against the built lib/ (npm test → pretest build).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendSystemTemplatePath,
  ensureAppendSystemFile,
  migrateAgentsMdTodoSection,
  readAppendSystem,
  TODO_LIFECYCLE_MARKER,
  TODO_LIFECYCLE_SECTION,
} from '../lib/append-system.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-tui-append-'))
}

// ------------------------------------------------------------- ensure ----

test('creates APPEND_SYSTEM.md seeded from the shipped template when absent', async () => {
  const dir = await tempDir()
  try {
    const path = join(dir, 'APPEND_SYSTEM.md')
    const template = join(dir, 'template.md')
    await writeFile(template, '# Orchestrator template\n', 'utf8')
    assert.equal(await ensureAppendSystemFile(path, template), undefined)
    const content = await readFile(path, 'utf8')
    assert.ok(content.startsWith('# Orchestrator template'), 'template seeded first')
    assert.ok(content.includes(TODO_LIFECYCLE_MARKER), 'marker present')
    assert.ok(content.includes('write an EMPTY todo list'), 'guidance present')
    assert.ok(content.indexOf(TODO_LIFECYCLE_MARKER) > content.indexOf('Orchestrator template'),
      'template first, marked section after')
    // Idempotent: a second call leaves the file byte-identical.
    const before = await readFile(path, 'utf8')
    assert.equal(await ensureAppendSystemFile(path), undefined)
    assert.equal(await readFile(path, 'utf8'), before, 'no rewrite when marked')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('appends the section to an existing file without the marker', async () => {
  const dir = await tempDir()
  try {
    const path = join(dir, 'APPEND_SYSTEM.md')
    await writeFile(path, '# My append notes\n\nAlways cite sources.\n', 'utf8')
    assert.equal(await ensureAppendSystemFile(path), undefined)
    const content = await readFile(path, 'utf8')
    assert.ok(content.startsWith('# My append notes'), 'existing content preserved')
    assert.ok(content.includes(TODO_LIFECYCLE_MARKER), 'section appended')
    assert.ok(content.includes('Always cite sources.'), 'existing text intact')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('leaves an already-marked, rule-carrying file byte-identical', async () => {
  const dir = await tempDir()
  try {
    const path = join(dir, 'APPEND_SYSTEM.md')
    const marked = `# Notes\n\n${TODO_LIFECYCLE_MARKER}\n## Todo list lifecycle (dsh-tui-pi)\n\nKeep it tidy. Registered subagents only.\n`
    await writeFile(path, marked, 'utf8')
    assert.equal(await ensureAppendSystemFile(path), undefined)
    assert.equal(await readFile(path, 'utf8'), marked, 'no rewrite when marked and the rule is phrased')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// -------------------------------------------------------------- read ----

test('readAppendSystem returns the file content, or "" when missing', () => {
  const dir = tmpdir()
  const missing = join(dir, `dsh-tui-missing-${Date.now()}.md`)
  assert.equal(readAppendSystem(missing), '', 'missing file reads empty')
  const path = join(dir, `dsh-tui-present-${Date.now()}.md`)
  try {
    writeFileSync(path, 'append me', 'utf8')
    assert.equal(readAppendSystem(path), 'append me')
  } finally {
    rmSync(path, { force: true })
  }
})

// ---------------------------------------------------------- migrate ----

test('migrate strips the marker block from AGENTS.md and deletes an emptied file', async () => {
  const dir = await tempDir()
  try {
    const path = join(dir, 'AGENTS.md')
    // Our earlier incarnation: AGENTS.md contained only the TUI block.
    await writeFile(path, TODO_LIFECYCLE_SECTION, 'utf8')
    assert.equal(await migrateAgentsMdTodoSection(path), undefined)
    await assert.rejects(() => stat(path), 'file deleted when the strip leaves it empty')
    // With user content around the block, only the block is removed.
    await writeFile(path, `User notes.\n\n${TODO_LIFECYCLE_SECTION}\n\nMore user notes.\n`, 'utf8')
    assert.equal(await migrateAgentsMdTodoSection(path), undefined)
    const content = await readFile(path, 'utf8')
    assert.ok(content.includes('User notes.'), 'leading user content kept')
    assert.ok(content.includes('More user notes.'), 'trailing user content kept')
    assert.ok(!content.includes(TODO_LIFECYCLE_MARKER), 'marker block removed')
    // No-op when the marker is absent.
    const before = await readFile(path, 'utf8')
    assert.equal(await migrateAgentsMdTodoSection(path), undefined)
    assert.equal(await readFile(path, 'utf8'), before, 'untouched without the marker')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reports a failure instead of throwing (missing parent dir)', async () => {
  const dir = await tempDir()
  try {
    const path = join(dir, 'no-such-dir', 'APPEND_SYSTEM.md')
    const error = await ensureAppendSystemFile(path)
    assert.ok(typeof error === 'string' && error !== '', 'error message returned, not thrown')
    // The tmp file must not linger.
    await assert.rejects(() => readFile(`${path}.tmp`))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the shipped template carries the registered-subagents iron rule', async () => {
  const content = await readFile(appendSystemTemplatePath(), 'utf8')
  assert.ok(content.includes('registered subagents only'), 'rule present in the template')
})

test('ensure appends the subagents rule to a marked file that lacks it (and stays idempotent)', async () => {
  const dir = await tempDir()
  try {
    const path = join(dir, 'APPEND_SYSTEM.md')
    const template = join(dir, 'template.md')
    await writeFile(template, '# T\n', 'utf8')
    assert.equal(await ensureAppendSystemFile(path, template), undefined)
    const withMarker = await readFile(path, 'utf8')
    assert.ok(withMarker.includes('registered subagents only'), 'fresh seed from a rule-less template gets the rule via ensure')
    // The marker-present early path still appends the rule exactly once.
    await writeFile(path, `${TODO_LIFECYCLE_SECTION.trimEnd()}\n`, 'utf8')
    assert.equal(await ensureAppendSystemFile(path, template), undefined)
    const once = await readFile(path, 'utf8')
    assert.equal(once.indexOf('registered subagents only'), once.lastIndexOf('registered subagents only'), 'rule appended once')
    const before = await readFile(path, 'utf8')
    assert.equal(await ensureAppendSystemFile(path), undefined)
    assert.equal(await readFile(path, 'utf8'), before, 'phrase-present file is not rewritten')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensure skips the subagents rule for a file that phrases it already (user hand-edit)', async () => {
  const dir = await tempDir()
  try {
    const path = join(dir, 'APPEND_SYSTEM.md')
    await writeFile(path, `## Subagents\n\nWhen the user says "subagent", they mean the registered subagents only; never use unregistered subagents.\n\n${TODO_LIFECYCLE_SECTION}`, 'utf8')
    const before = await readFile(path, 'utf8')
    assert.equal(await ensureAppendSystemFile(path), undefined)
    assert.equal(await readFile(path, 'utf8'), before, 'no duplicate rule for a hand-phrased file')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
