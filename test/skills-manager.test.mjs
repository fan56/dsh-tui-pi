/**
 * Skills Manager apply-chain tests — idempotent install, per-item batch
 * application and the failure summary. Everything runs against throwaway
 * temp directories (the live ~/.agents/skills and ~/.dsh/skills are never
 * touched: the panel's static dirs are repointed at the temp tree and
 * restored in a finally block). Runs against the built lib/.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyOneSkillChange,
  installSkillSymlink,
  skillApplyShortReason,
  skillApplySummary,
  skillSymlinkPaths,
  SkillsManagerPanel,
} from '../lib/skills-manager.js'
import { darkTheme } from '../lib/theme/index.js'

/** Throwaway public/curated pair standing in for the two skill roots. */
function makeSkillDirs() {
  const root = mkdtempSync(join(tmpdir(), 'skills-manager-test-'))
  const publicDir = join(root, 'public')
  const curatedDir = join(root, 'curated')
  mkdirSync(publicDir)
  mkdirSync(curatedDir)
  return { root, publicDir, curatedDir }
}

// ------------------------------------------------------- installSkillSymlink --

test('installSkillSymlink creates a fresh symlink when dest is absent', async () => {
  const { root, publicDir, curatedDir } = makeSkillDirs()
  try {
    const src = join(publicDir, 'alpha.md')
    writeFileSync(src, 'alpha body\n')
    const dest = join(curatedDir, 'alpha.md')
    await installSkillSymlink(src, dest)
    assert.equal(realpathSync(dest), realpathSync(src))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installSkillSymlink is a no-op success when dest already points at the same source', async () => {
  // Re-installing an installed skill must not raise EEXIST — and must not
  // recreate the link either (same inode as before the call).
  const { root, publicDir, curatedDir } = makeSkillDirs()
  try {
    const src = join(publicDir, 'alpha.md')
    writeFileSync(src, 'alpha body\n')
    const dest = join(curatedDir, 'alpha.md')
    symlinkSync(src, dest)
    const before = lstatSync(dest)
    await installSkillSymlink(src, dest)
    const after = lstatSync(dest)
    assert.equal(after.ino, before.ino)
    assert.equal(realpathSync(dest), realpathSync(src))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installSkillSymlink refuses a dest symlinked to a different source', async () => {
  const { root, publicDir, curatedDir } = makeSkillDirs()
  try {
    const srcA = join(publicDir, 'alpha.md')
    const srcB = join(publicDir, 'beta.md')
    writeFileSync(srcA, 'alpha\n')
    writeFileSync(srcB, 'beta\n')
    const dest = join(curatedDir, 'alpha.md')
    symlinkSync(srcA, dest)
    await assert.rejects(
      () => installSkillSymlink(srcB, dest),
      /already installed from a different source/,
    )
    // The existing link is left exactly as it was.
    assert.equal(readlinkSync(dest), srcA)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installSkillSymlink refuses to pierce a physical directory at dest', async () => {
  // A real directory under ~/.dsh/skills (e.g. user-authored content) must
  // never be overwritten or written through.
  const { root, publicDir, curatedDir } = makeSkillDirs()
  try {
    const src = join(publicDir, 'alpha.md')
    writeFileSync(src, 'alpha\n')
    const dest = join(curatedDir, 'alpha')
    mkdirSync(dest)
    writeFileSync(join(dest, 'SKILL.md'), 'user content\n')
    await assert.rejects(() => installSkillSymlink(src, dest), /not a symlink/)
    assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), 'user content\n')
    assert.ok(lstatSync(dest).isDirectory())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installSkillSymlink refuses to overwrite a physical file at dest', async () => {
  const { root, publicDir, curatedDir } = makeSkillDirs()
  try {
    const src = join(publicDir, 'alpha.md')
    writeFileSync(src, 'alpha\n')
    const dest = join(curatedDir, 'alpha.md')
    writeFileSync(dest, 'user file\n')
    await assert.rejects(() => installSkillSymlink(src, dest), /not a symlink/)
    assert.equal(readFileSync(dest, 'utf8'), 'user file\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installSkillSymlink repairs a dangling symlink at dest', async () => {
  // A dest link whose target is gone is repairable: unlink, then recreate.
  const { root, publicDir, curatedDir } = makeSkillDirs()
  try {
    const src = join(publicDir, 'alpha.md')
    writeFileSync(src, 'alpha\n')
    const dest = join(curatedDir, 'alpha.md')
    symlinkSync(join(publicDir, 'gone.md'), dest) // target never exists
    await installSkillSymlink(src, dest)
    assert.equal(realpathSync(dest), realpathSync(src))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installSkillSymlink treats a relative-target symlink as the same source (no-op)', async () => {
  // A hand-made link with a relative target resolves to the same file, so
  // realpath normalization must recognize it as already installed.
  const { root, publicDir, curatedDir } = makeSkillDirs()
  try {
    const src = join(publicDir, 'alpha.md')
    writeFileSync(src, 'alpha\n')
    const dest = join(curatedDir, 'alpha.md')
    symlinkSync('../public/alpha.md', dest)
    const before = lstatSync(dest)
    await installSkillSymlink(src, dest)
    const after = lstatSync(dest)
    assert.equal(after.ino, before.ino)
    assert.equal(realpathSync(dest), realpathSync(src))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installSkillSymlink reports a vanished source instead of a raw ENOENT', async () => {
  const { root, publicDir, curatedDir } = makeSkillDirs()
  try {
    const src = join(publicDir, 'gone.md') // never created
    const dest = join(curatedDir, 'gone.md')
    await assert.rejects(
      () => installSkillSymlink(src, dest),
      /skill source vanished: ".*gone\.md" \(ENOENT\)/,
    )
    assert.ok(!existsSync(dest))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installSkillSymlink treats a symlink loop as a repairable dangling link', async () => {
  const { root, publicDir, curatedDir } = makeSkillDirs()
  try {
    const src = join(publicDir, 'alpha.md')
    writeFileSync(src, 'alpha\n')
    // loop-a → loop-b → loop-a: realpath fails with ELOOP — still a dead
    // link, repairable like any other dangling dest.
    symlinkSync('loop-b', join(curatedDir, 'loop-a'))
    symlinkSync('loop-a', join(curatedDir, 'loop-b'))
    await installSkillSymlink(src, join(curatedDir, 'loop-a'))
    assert.equal(realpathSync(join(curatedDir, 'loop-a')), realpathSync(src))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installSkillSymlink rethrows non-dangling realpath failures (EACCES)', async () => {
  const { root, publicDir, curatedDir } = makeSkillDirs()
  const locked = join(root, 'locked')
  mkdirSync(locked)
  try {
    const src = join(publicDir, 'alpha.md')
    writeFileSync(src, 'alpha\n')
    writeFileSync(join(locked, 'target.md'), 't\n')
    // dest lstats fine, but resolving its target crosses a mode-000 dir:
    // EACCES must surface, not be paved over with unlink + recreate.
    chmodSync(locked, 0o000)
    const dest = join(curatedDir, 'alpha.md')
    symlinkSync(join(locked, 'target.md'), dest)
    await assert.rejects(() => installSkillSymlink(src, dest), /EACCES/)
    assert.equal(readlinkSync(dest), join(locked, 'target.md'))
  } finally {
    chmodSync(locked, 0o755)
    rmSync(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------- skillSymlinkPaths --

test('skillSymlinkPaths prefers the .md form, falls back to the bundle, undefined when absent', () => {
  const { root, publicDir, curatedDir } = makeSkillDirs()
  try {
    writeFileSync(join(publicDir, 'both.md'), 'flat\n')
    mkdirSync(join(publicDir, 'both'))
    mkdirSync(join(publicDir, 'bundle-only'))
    const both = skillSymlinkPaths(publicDir, curatedDir, 'both')
    assert.equal(both.src, join(publicDir, 'both.md'))
    assert.equal(both.dest, join(curatedDir, 'both.md'))
    const bundle = skillSymlinkPaths(publicDir, curatedDir, 'bundle-only')
    assert.equal(bundle.src, join(publicDir, 'bundle-only'))
    assert.equal(bundle.dest, join(curatedDir, 'bundle-only'))
    assert.equal(skillSymlinkPaths(publicDir, curatedDir, 'missing'), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------- applyOneSkillChange --

test('applyOneSkillChange reports a missing source instead of throwing', async () => {
  const { root, publicDir, curatedDir } = makeSkillDirs()
  try {
    const error = await applyOneSkillChange('ghost', true, publicDir, curatedDir)
    assert.match(error, /^cannot install: skill not found in /)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyOneSkillChange installs and uninstalls, tolerating an absent dest', async () => {
  const { root, publicDir, curatedDir } = makeSkillDirs()
  try {
    writeFileSync(join(publicDir, 'alpha.md'), 'alpha\n')
    assert.equal(await applyOneSkillChange('alpha', true, publicDir, curatedDir), undefined)
    assert.equal(realpathSync(join(curatedDir, 'alpha.md')), realpathSync(join(publicDir, 'alpha.md')))
    assert.equal(await applyOneSkillChange('alpha', false, publicDir, curatedDir), undefined)
    // Uninstalling something that is not there is an idempotent success.
    assert.equal(await applyOneSkillChange('alpha', false, publicDir, curatedDir), undefined)
    // A dangling dest link still unlinks (unlink never follows the link).
    symlinkSync(join(publicDir, 'gone.md'), join(curatedDir, 'alpha.md'))
    assert.equal(await applyOneSkillChange('alpha', false, publicDir, curatedDir), undefined)
    assert.ok(!existsSync(join(curatedDir, 'alpha.md')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyOneSkillChange refuses to uninstall a physical file at dest', async () => {
  // A user-authored physical .md must never be silently deleted by an
  // uninstall — symmetric with the install-side refusal.
  const { root, publicDir, curatedDir } = makeSkillDirs()
  try {
    writeFileSync(join(publicDir, 'alpha.md'), 'alpha\n')
    writeFileSync(join(curatedDir, 'alpha.md'), 'hand-written\n')
    const error = await applyOneSkillChange('alpha', false, publicDir, curatedDir)
    assert.match(error, /^cannot uninstall: refusing to remove ".*alpha\.md": not a symlink$/)
    assert.equal(readFileSync(join(curatedDir, 'alpha.md'), 'utf8'), 'hand-written\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyOneSkillChange refuses to uninstall a physical directory at dest', async () => {
  const { root, publicDir, curatedDir } = makeSkillDirs()
  try {
    mkdirSync(join(publicDir, 'alpha'))
    writeFileSync(join(publicDir, 'alpha', 'SKILL.md'), 'src\n')
    mkdirSync(join(curatedDir, 'alpha'))
    writeFileSync(join(curatedDir, 'alpha', 'SKILL.md'), 'user content\n')
    const error = await applyOneSkillChange('alpha', false, publicDir, curatedDir)
    assert.match(error, /^cannot uninstall: refusing to remove ".*alpha": not a symlink$/)
    assert.equal(readFileSync(join(curatedDir, 'alpha', 'SKILL.md'), 'utf8'), 'user content\n')
    assert.ok(lstatSync(join(curatedDir, 'alpha')).isDirectory())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------ skillApplySummary --

test('skillApplySummary stays empty when there is nothing to report', () => {
  assert.equal(skillApplySummary([]), '')
  assert.equal(skillApplySummary([{ name: 'a', error: undefined }]), '')
  assert.equal(
    skillApplySummary([
      { name: 'a', error: undefined },
      { name: 'b', error: undefined },
    ]),
    '',
  )
})

test('skillApplySummary names successes and failures with short reasons', () => {
  assert.equal(
    skillApplySummary([
      { name: 'a', error: undefined },
      { name: 'b', error: 'cannot install: boom' },
      { name: 'c', error: undefined },
    ]),
    'Applied 2/3 — ok: a, c · failed: b (failed)',
  )
  assert.equal(
    skillApplySummary([
      { name: 'b', error: 'cannot install: x' },
      { name: 'd', error: 'cannot uninstall: y' },
    ]),
    'Applied 0/2 — failed: b (failed), d (failed)',
  )
})

test('skillApplyShortReason maps raw errors to short, path-free reasons', () => {
  assert.equal(
    skillApplyShortReason('cannot install: refusing to overwrite "/d/x": not a symlink'),
    'not a symlink',
  )
  assert.equal(
    skillApplyShortReason('cannot uninstall: refusing to remove "/d/x": not a symlink'),
    'not a symlink',
  )
  assert.equal(
    skillApplyShortReason('cannot install: already installed from a different source: "/d" points to "/y", expected "/z"'),
    'different source',
  )
  assert.equal(skillApplyShortReason('cannot install: skill not found in "/pub"'), 'source missing')
  assert.equal(
    skillApplyShortReason('cannot install: skill source vanished: "/pub/x.md" (ENOENT)'),
    'source missing',
  )
  assert.equal(skillApplyShortReason('cannot uninstall: dest missing "/d/x"'), 'dest missing')
  assert.equal(skillApplyShortReason('cannot install: boom'), 'failed')
})

test('skillApplySummary caps the failure list at three items plus a more-tail', () => {
  const failures = [
    { name: 'a', error: 'cannot install: refusing to overwrite "/x/a": not a symlink' },
    { name: 'b', error: 'cannot install: already installed from a different source: "/x/b" points to "/y", expected "/z"' },
    { name: 'c', error: 'cannot install: skill not found in "/pub"' },
    { name: 'd', error: 'cannot install: skill source vanished: "/pub/d.md" (ENOENT)' },
    { name: 'e', error: 'cannot uninstall: refusing to remove "/x/e": not a symlink' },
  ]
  // Five failures: only the first three are itemized, the rest collapse.
  assert.equal(
    skillApplySummary(failures),
    'Applied 0/5 — failed: a (not a symlink), b (different source), c (source missing) +2 more',
  )
  // Four failures: three itemized + one collapsed.
  assert.equal(
    skillApplySummary(failures.slice(0, 4)),
    'Applied 0/4 — failed: a (not a symlink), b (different source), c (source missing) +1 more',
  )
  // Exactly three failures: all itemized, no more-tail.
  assert.equal(
    skillApplySummary(failures.slice(0, 3)),
    'Applied 0/3 — failed: a (not a symlink), b (different source), c (source missing)',
  )
  // Full paths never leak into the single-line summary.
  const summary = skillApplySummary(failures)
  assert.ok(!summary.includes('/x/'))
  assert.ok(!summary.includes('/pub'))
})

test('skillApplySummary caps a large ok list so the failed segment stays on the line', () => {
  // Mixed batch: 10 successes + 2 failures. Without an ok cap the ok list
  // alone fills the clipped status line and pushes the failed segment —
  // the part the user actually needs — out of view.
  const results = [
    ...Array.from({ length: 10 }, (_, i) => ({ name: `skill-${i}`, error: undefined })),
    { name: 'bad-a', error: 'cannot install: refusing to overwrite "/x/bad-a": not a symlink' },
    { name: 'bad-b', error: 'cannot install: skill not found in "/pub"' },
  ]
  const summary = skillApplySummary(results)
  // The ok list collapses to three names plus a more-tail; the count header
  // still reports the true 10/12.
  assert.equal(
    summary,
    'Applied 10/12 — ok: skill-0, skill-1, skill-2 +7 more · failed: bad-a (not a symlink), bad-b (source missing)',
  )
  // The failed segment is complete and sits at the end of the line.
  assert.ok(summary.endsWith('failed: bad-a (not a symlink), bad-b (source missing)'))
  // Uncapped ok names beyond the third never appear.
  assert.ok(!summary.includes('skill-3'))
  assert.ok(!summary.includes('skill-9'))
})

// --------------------------------------------------------- panel batching --

/** Minimal panel over mock ctx/tui; static dirs get repointed per test. */
function makePanel() {
  const tui = { requestRender() {}, terminal: { rows: 40 } }
  const ctx = { get: () => undefined }
  return new SkillsManagerPanel(ctx, tui, darkTheme, () => {}, undefined)
}

/** Repoint the panel's static skill roots at a temp tree; returns a restore fn. */
function pinSkillDirs(publicDir, curatedDir) {
  const realPublic = SkillsManagerPanel.PUBLIC_SKILLS_DIR
  const realCurated = SkillsManagerPanel.CURATED_SKILLS_DIR
  SkillsManagerPanel.PUBLIC_SKILLS_DIR = publicDir
  SkillsManagerPanel.CURATED_SKILLS_DIR = curatedDir
  return () => {
    SkillsManagerPanel.PUBLIC_SKILLS_DIR = realPublic
    SkillsManagerPanel.CURATED_SKILLS_DIR = realCurated
  }
}

/** Resolve once the async scan settles; bounded so a hang fails loudly. */
async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('applyPendingChanges keeps applying after a failing item and summarizes the batch', async () => {
  const { root, publicDir, curatedDir } = makeSkillDirs()
  const restore = pinSkillDirs(publicDir, curatedDir)
  try {
    // blocked: bundle-form skill whose dest is a physical dir (user
    //   content, the ~/.dsh/skills/proxy-fallback shape) → install fails.
    // fresh: nothing at dest → installs cleanly.
    // present: already symlinked → reinstall must be idempotent, no EEXIST.
    mkdirSync(join(publicDir, 'blocked'))
    writeFileSync(join(publicDir, 'blocked', 'SKILL.md'), 'blocked\n')
    writeFileSync(join(publicDir, 'fresh.md'), 'fresh\n')
    writeFileSync(join(publicDir, 'present.md'), 'present\n')
    mkdirSync(join(curatedDir, 'blocked'))
    writeFileSync(join(curatedDir, 'blocked', 'SKILL.md'), 'user content\n')
    symlinkSync(join(publicDir, 'present.md'), join(curatedDir, 'present.md'))

    const panel = makePanel()
    panel.availableEntries = ['blocked', 'fresh', 'present'].map(name => ({
      name,
      description: '',
      installed: false,
    }))
    // The failing item comes FIRST: the old code returned on it and never
    // reached the two installable skills after it.
    panel.pendingChanges = new Map([
      ['blocked', true],
      ['fresh', true],
      ['present', true],
    ])
    await panel.applyPendingChanges()

    // Later items were still applied despite the leading failure.
    assert.equal(
      realpathSync(join(curatedDir, 'fresh.md')),
      realpathSync(join(publicDir, 'fresh.md')),
    )
    // The already-installed skill re-installed without EEXIST.
    assert.equal(
      realpathSync(join(curatedDir, 'present.md')),
      realpathSync(join(publicDir, 'present.md')),
    )
    // User content at the blocked dest is untouched.
    assert.equal(readFileSync(join(curatedDir, 'blocked', 'SKILL.md'), 'utf8'), 'user content\n')
    // The summary reports every item's outcome with a short reason.
    assert.equal(
      panel.status,
      'Applied 2/3 — ok: fresh, present · failed: blocked (not a symlink)',
    )
    // Pending changes are consumed either way.
    assert.equal(panel.pendingChanges.size, 0)
    // Only the succeeded items are marked installed (asserted before the
    // rescan settles — the scan re-derives `installed` from dest presence).
    const byName = new Map(panel.availableEntries.map(e => [e.name, e.installed]))
    assert.equal(byName.get('blocked'), false)
    assert.equal(byName.get('fresh'), true)
    assert.equal(byName.get('present'), true)
    // Let the rescan settle — the list comes back with the summary riding
    // above it (the panel is not a dead status line).
    await waitFor(() => panel.rows.some(r => r.name === 'blocked'))
    assert.equal(
      panel.status,
      'Applied 2/3 — ok: fresh, present · failed: blocked (not a symlink)',
    )
  } finally {
    restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyPendingChanges with failures rescans the list and keeps retry possible', async () => {
  const { root, publicDir, curatedDir } = makeSkillDirs()
  const restore = pinSkillDirs(publicDir, curatedDir)
  try {
    // blocked: physical dir at dest → install fails; fresh: installs.
    mkdirSync(join(publicDir, 'blocked'))
    writeFileSync(join(publicDir, 'blocked', 'SKILL.md'), 'blocked\n')
    writeFileSync(join(publicDir, 'fresh.md'), 'fresh\n')
    mkdirSync(join(curatedDir, 'blocked'))
    writeFileSync(join(curatedDir, 'blocked', 'SKILL.md'), 'user content\n')

    const panel = makePanel()
    panel.availableEntries = [
      { name: 'blocked', description: '', installed: false },
      { name: 'fresh', description: '', installed: false },
    ]
    panel.pendingChanges = new Map([
      ['blocked', true],
      ['fresh', true],
    ])
    await panel.applyPendingChanges()

    // The rescan restored the rows — the panel is not a dead status line.
    await waitFor(() => panel.rows.some(r => r.name === 'blocked'))
    assert.ok(panel.rows.length >= 2)
    // The failure summary survived the rescan.
    assert.equal(panel.status, 'Applied 1/2 — ok: fresh · failed: blocked (not a symlink)')
    // Retry works: Space toggles a new pending change on the restored rows.
    // blocked's physical dest still exists, so the rescan shows it enabled
    // and the toggle targets uninstall (false) — the point is that a
    // pending change can be staged again, the panel is not a dead end.
    assert.equal(panel.applying, false)
    panel.cursor = panel.rows.findIndex(r => r.name === 'blocked')
    panel.handleInput(' ')
    assert.equal(panel.pendingChanges.has('blocked'), true)
    assert.equal(panel.pendingChanges.get('blocked'), false)
  } finally {
    restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Space and Enter are ignored while a batch apply is in flight', async () => {
  const { root, publicDir, curatedDir } = makeSkillDirs()
  const restore = pinSkillDirs(publicDir, curatedDir)
  try {
    writeFileSync(join(publicDir, 'fresh.md'), 'fresh\n')
    const panel = makePanel()
    panel.availableEntries = [{ name: 'fresh', description: '', installed: false }]
    panel.pendingChanges = new Map([['fresh', true]])
    // Simulate an in-flight batch: mid-batch input must neither toggle
    // pending changes (the apply loop would drop them) nor kick off a
    // concurrent second batch.
    panel.applying = true
    panel.cursor = 0
    panel.handleInput(' ') // Space — blocked
    panel.handleInput('\r') // Enter — blocked
    assert.deepEqual([...panel.pendingChanges], [['fresh', true]])
    // The gate opens again once the batch settles.
    panel.applying = false
    await panel.applyPendingChanges()
    assert.equal(panel.applying, false)
    assert.equal(panel.pendingChanges.size, 0)
    await waitFor(() => panel.rows.some(r => r.name === 'fresh'))
    // Space works again after the batch: the row is installed, so the
    // toggle now targets uninstall.
    panel.cursor = panel.rows.findIndex(r => r.name === 'fresh')
    panel.handleInput(' ')
    assert.equal(panel.pendingChanges.get('fresh'), false)
  } finally {
    restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyPendingChanges with an all-success batch rescans without a failure status', async () => {
  const { root, publicDir, curatedDir } = makeSkillDirs()
  const restore = pinSkillDirs(publicDir, curatedDir)
  try {
    writeFileSync(join(publicDir, 'fresh.md'), 'fresh\n')
    const panel = makePanel()
    panel.availableEntries = [{ name: 'fresh', description: '', installed: false }]
    panel.pendingChanges = new Map([['fresh', true]])
    await panel.applyPendingChanges()
    assert.equal(
      realpathSync(join(curatedDir, 'fresh.md')),
      realpathSync(join(publicDir, 'fresh.md')),
    )
    // Let the rescan settle (bounded wait), then the rebuilt rows show the
    // skill installed and no failure summary replaced the list.
    await waitFor(() => panel.rows.some(r => r.name === 'fresh'))
    const row = panel.rows.find(r => r.name === 'fresh')
    assert.equal(row.enabled, true)
    assert.doesNotMatch(panel.status ?? '', /failed/)
  } finally {
    restore()
    rmSync(root, { recursive: true, force: true })
  }
})
