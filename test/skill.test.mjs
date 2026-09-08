/**
 * Bundled-skill regression guards (the dsh-vault pattern, adapted): the
 * plugin ships skills/dsh-tui-pi/SKILL.md through ctx.skills.registerProvider,
 * and these tests lock the provider contract (registration, candidate
 * metadata, frontmatter-stripped body) plus the anti-drift assertion that the
 * hardcoded routing description stays identical to the packaged frontmatter.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, inject, name, stripFrontmatter } from '../lib/index.js'

// Minimal cordis-like context: the bundled-skill registration path needs
// ctx.skills; the render effect (startTui and friends) must NOT run, so
// ctx.effect is a no-op, and apply()'s best-effort APPEND_SYSTEM seeding is
// pointed at a scratch DSH_HOME so a unit test never touches the real
// ~/.dsh.
function mockCtx() {
  const registered = []
  return {
    registered,
    effect() {},
    inject() {},
    get() {
      return undefined
    },
    skills: {
      registerProvider(create) {
        const provider = create({
          signal: new AbortController().signal,
          invalidate() {},
        })
        registered.push(provider)
        return () => {}
      },
    },
  }
}

/** Run apply() with the scratch-home env wired; restores the env afterwards. */
function applyInScratchHome() {
  const prevHome = process.env.DSH_HOME
  const prevSkip = process.env.DSH_TUI_SKIP_HOST_CHECK
  const home = mkdtempSync(join(tmpdir(), 'dsh-tui-pi-skill-'))
  process.env.DSH_HOME = home
  process.env.DSH_TUI_SKIP_HOST_CHECK = '1'
  try {
    const ctx = mockCtx()
    apply(ctx)
    // Let apply()'s fire-and-forget file seeding settle into the scratch
    // home before it disappears (the seeders catch their own errors anyway).
    return new Promise(resolve => setImmediate(() => resolve(ctx)))
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevSkip === undefined) delete process.env.DSH_TUI_SKIP_HOST_CHECK
    else process.env.DSH_TUI_SKIP_HOST_CHECK = prevSkip
    try { rmSync(home, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}

/** Extract one scalar value from the SKILL.md YAML frontmatter. */
function frontmatterValue(markdown, key) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(match, 'SKILL.md must open with a YAML frontmatter block')
  const line = match[1]
    .split('\n')
    .find((entry) => entry.startsWith(`${key}:`))
  assert.ok(line, `frontmatter must declare "${key}"`)
  return line.slice(key.length + 1).trim().replace(/^"(.*)"$/s, '$1')
}

test('plugin metadata: name and inject expose the skills dependency', () => {
  assert.equal(name, 'dsh-tui-pi')
  assert.ok(inject.includes('skills'), 'inject must declare the skills service')
})

test('apply registers the bundled skill provider on ctx.skills', async () => {
  const ctx = await applyInScratchHome()
  assert.equal(ctx.registered.length, 1)
  const provider = ctx.registered[0]
  assert.equal(provider.name, 'dsh-tui-pi')

  const candidates = await provider.list({})
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate.name, 'dsh-tui-pi')
  assert.equal(candidate.provider, 'dsh-tui-pi')
  assert.equal(candidate.source, 'bundled')
  assert.equal(typeof candidate.rank, 'number')
  assert.ok(Number.isFinite(candidate.rank))
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
  assert.match(candidate.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(candidate.description.length > 0)
  assert.ok(candidate.description.length <= 500, 'description must stay within the 500-char routing budget')
  // The directory resource base must point at the packaged skills/ directory
  // (fileURLToPath keeps the trailing slash of the URL path).
  assert.equal(candidate.resourceBase.kind, 'directory')
  assert.ok(
    candidate.resourceBase.path.replace(/\/$/, '').endsWith('skills/dsh-tui-pi'),
    `unexpected resourceBase path: ${candidate.resourceBase.path}`,
  )
})

test('provider.get loads the packaged SKILL.md with matching metadata', async () => {
  const ctx = await applyInScratchHome()
  const provider = ctx.registered[0]
  const [candidate] = await provider.list({})

  const definition = await provider.get(candidate, {})
  assert.equal(definition.name, 'dsh-tui-pi')
  assert.equal(definition.description, candidate.description)
  // SkillDefinition.content is the instruction body after metadata removal:
  // the bundled get() must strip the raw frontmatter the file keeps for the
  // GitHub/manual install paths (same shape the filesystem provider serves).
  assert.ok(!definition.content.startsWith('---'), 'get() must not serve the frontmatter block')
  assert.ok(definition.content.includes('# dsh-tui-pi 使用指南'), 'body must be the packaged skill markdown')

  // Anti-drift: the hardcoded routing description must equal the SKILL.md
  // frontmatter, and the frontmatter itself must satisfy the registry grammar.
  const markdown = await readFile(new URL('../skills/dsh-tui-pi/SKILL.md', import.meta.url), 'utf8')
  assert.equal(frontmatterValue(markdown, 'name'), 'dsh-tui-pi')
  assert.equal(frontmatterValue(markdown, 'description'), candidate.description)
})

test('stripFrontmatter tolerates missing or unclosed frontmatter', () => {
  // No frontmatter: returned unchanged.
  assert.equal(stripFrontmatter('plain body\n'), 'plain body\n')
  assert.equal(stripFrontmatter(''), '')
  // A `---` fence that never closes is not frontmatter: returned unchanged.
  assert.equal(stripFrontmatter('---\nname: x'), '---\nname: x')
  assert.equal(stripFrontmatter('---'), '---')
  // A closed block is stripped down to the trimmed instruction body.
  assert.equal(stripFrontmatter('---\nname: x\n---\n\n# Body\n'), '# Body')
  // CRLF line endings are tolerated on both fence lines.
  assert.equal(stripFrontmatter('---\r\nname: x\r\n---\r\n\r\n# Body\r\n'), '# Body')
})
