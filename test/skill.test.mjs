/**
 * Bundled-skill regression guards (the dsh-vault pattern, adapted): the
 * plugin ships skills/dsh-tui-pi-config/SKILL.md through ctx.skills.registerProvider,
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
import { apply, Config, inject, name, stripFrontmatter } from '../lib/index.js'

/**
 * The dsh-tui Config schema's own field names — the source of truth for what
 * SKILL_DESCRIPTION and SKILL.md must enumerate. Derived from the exported
 * Config (a schemastery `z.object` node), never hardcoded, so adding a config
 * key can no longer silently drift the routing description (review C3/S1).
 */
function configKeys() {
  // schemastery object nodes expose their fields as `.dict`; materializing the
  // resolved defaults is the fallback if that internal shape ever changes.
  const keys = Object.keys(Config.dict ?? {})
  return keys.length > 0 ? keys : Object.keys(Config({}))
}

/**
 * Per-key existence check: every Config key must appear in the given routing
 * description. The failure message lists the missing keys so a future config
 * addition cannot hide behind the heuristic length budget.
 */
function assertEnumeratesConfigKeys(description, label, keys) {
  const missing = keys.filter(key => !description.includes(key))
  assert.deepEqual(
    missing,
    [],
    `${label} is missing ${missing.length} Config key(s): ${missing.join(', ')}. Add them to BOTH SKILL_DESCRIPTION and the SKILL.md frontmatter description.`,
  )
}

// Minimal cordis-like context: the bundled-skill registration path needs
// ctx.skills; the render effect (startTui and friends) must NOT run, so
// ctx.effect is a no-op, and apply()'s best-effort APPEND_SYSTEM seeding is
// pointed at a scratch DSH_HOME so a unit test never touches the real
// ~/.dsh. `provide` absorbs the tuiWidgets seam registration (a real cordis
// context guards property writes — apply must go through provide).
function mockCtx() {
  const registered = []
  return {
    registered,
    effect() {},
    inject() {},
    provide() {},
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
  assert.equal(provider.name, 'dsh-tui-pi-config')

  const candidates = await provider.list({})
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate.name, 'dsh-tui-pi-config')
  assert.equal(candidate.provider, 'dsh-tui-pi-config')
  assert.equal(candidate.source, 'bundled')
  assert.equal(typeof candidate.rank, 'number')
  assert.ok(Number.isFinite(candidate.rank))
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
  assert.match(candidate.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(candidate.description.length > 0)
  // 500 is not a private magic number: dsh-tool-skill's catalog renderer caps
  // a skill's routing description at DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH
  // (500, configurable via catalogDescriptionMaxLength) and truncates longer
  // text with "...", which can silently drop keys from the catalog. The
  // structural per-key check below is the real guard; this budget only keeps
  // the description intact in the default catalog. Report the actual length
  // on failure so the editor knows how much to trim without dropping a key.
  assert.ok(
    candidate.description.length <= 500,
    `description is ${candidate.description.length} chars; dsh-tool-skill truncates at 500 (catalogDescriptionMaxLength) — trim to <=500 without dropping any Config key (see the per-key assertion)`,
  )
  // Structural parity with the schema: every key the loader exposes must be
  // enumerated in the routing description (review C3/S1). This replaces the
  // old reliance on the length budget alone, which let a missing key slip by.
  assertEnumeratesConfigKeys(candidate.description, 'SKILL_DESCRIPTION', configKeys())
  // The directory resource base must point at the packaged skills/ directory
  // (fileURLToPath keeps the trailing slash of the URL path).
  assert.equal(candidate.resourceBase.kind, 'directory')
  assert.ok(
    candidate.resourceBase.path.replace(/\/$/, '').endsWith('skills/dsh-tui-pi-config'),
    `unexpected resourceBase path: ${candidate.resourceBase.path}`,
  )
})

test('provider.get loads the packaged SKILL.md with matching metadata', async () => {
  const ctx = await applyInScratchHome()
  const provider = ctx.registered[0]
  const [candidate] = await provider.list({})

  const definition = await provider.get(candidate, {})
  assert.equal(definition.name, 'dsh-tui-pi-config')
  assert.equal(definition.description, candidate.description)
  // SkillDefinition.content is the instruction body after metadata removal:
  // the bundled get() must strip the raw frontmatter the file keeps for the
  // GitHub/manual install paths (same shape the filesystem provider serves).
  assert.ok(!definition.content.startsWith('---'), 'get() must not serve the frontmatter block')
  assert.ok(definition.content.includes('# dsh-tui-pi 使用指南'), 'body must be the packaged skill markdown')

  // Anti-drift: the hardcoded routing description must equal the SKILL.md
  // frontmatter, and the frontmatter itself must satisfy the registry grammar.
  const markdown = await readFile(new URL('../skills/dsh-tui-pi-config/SKILL.md', import.meta.url), 'utf8')
  assert.equal(frontmatterValue(markdown, 'name'), 'dsh-tui-pi-config')
  assert.equal(frontmatterValue(markdown, 'description'), candidate.description)
  // Same structural check against the frontmatter copy (not just the
  // hardcoded description) — the two are byte-identical by the assertion
  // above, but checking both keeps the failure message precise about which
  // artifact drifted if they ever diverge.
  assertEnumeratesConfigKeys(
    frontmatterValue(markdown, 'description'),
    'SKILL.md frontmatter description',
    configKeys(),
  )
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
