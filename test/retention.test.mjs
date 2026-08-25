/**
 * Session retention lock — the startup janitor that prunes jsonl session
 * directories outside "100 kept / 7 days" (src/retention.ts). Pure
 * selector coverage (age/count boundaries, idle guard, the protected set
 * = current session ∪ pending /resume target), knob resolution through
 * the precedence chain (settings.yaml explicit > env > default, invalid
 * fallbacks, MAX_COUNT<=0 disable) plus fs integration: a real temp store
 * tree, real removals, bucket and stray-file safety, rm-failure
 * isolation, symlink skipping. Runs against the built lib/ (pretest).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RETENTION_MAX_AGE_DAYS,
  RETENTION_MAX_COUNT,
  RETENTION_MIN_IDLE_MS,
  collectRetentionCandidates,
  resolveRetentionConfig,
  runSessionRetention,
  runSessionRetentionOnce,
  selectRetentionDeletions,
  sessionStoreRoot,
} from '../lib/retention.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const policy = (over = {}) => ({ maxCount: 3, maxAgeDays: 7, minIdleMs: RETENTION_MIN_IDLE_MS, now: NOW, ...over })

const cand = (id, mtimeMs, dir = `/store/p/${id}`) => ({ id, dir, mtimeMs })

// ------------------------------------------------------------- pure: age --

test('age rule deletes sessions strictly older than the window; the boundary survives', () => {
  const cutoff = NOW - 7 * DAY
  const doomed = selectRetentionDeletions(
    [cand('older', cutoff - 1), cand('exactly-at-cutoff', cutoff), cand('fresh', NOW)],
    policy(),
  )
  assert.deepEqual(doomed.map(c => c.id), ['older'])
})

test('age rule fires regardless of how many sessions exist', () => {
  // A single long-idle session is deleted even though the count cap (3)
  // is nowhere near reached — the two rules are a union.
  const doomed = selectRetentionDeletions([cand('lone-ancient', NOW - 8 * DAY)], policy())
  assert.deepEqual(doomed.map(c => c.id), ['lone-ancient'])
})

// ------------------------------------------------------------ pure: count --

test('count rule deletes beyond the cap only after the 24h idle guard', () => {
  // Four sessions, all touched within the last hour: ranked, the 4th is
  // beyond cap 3 but IDLE-PROTECTED (mtime >= now - 24h) — nothing dies.
  const recent = [cand('s1', NOW - 1000), cand('s2', NOW - 2000), cand('s3', NOW - 3000), cand('s4', NOW - 4000)]
  assert.deepEqual(selectRetentionDeletions(recent, policy()).map(c => c.id), [])
  // Same four, but older than 24h: the count rule now collects s4 only.
  const idle = recent.map(c => ({ ...c, mtimeMs: NOW - 2 * DAY + c.mtimeMs - NOW }))
  assert.deepEqual(selectRetentionDeletions(idle, policy()).map(c => c.id), ['s4'])
})

test('count rule: the cap boundary is exact — rank maxCount survives, maxCount+1 dies', () => {
  // Cap 3 with sessions ranked 1..5, all idle beyond 24h but inside 7
  // days: only the two OLDEST (rank 4 and 5) are beyond the cap.
  const ranked = [1, 2, 3, 4, 5].map(i => cand(`s${i}`, NOW - i * DAY))
  assert.deepEqual(selectRetentionDeletions(ranked, policy()).map(c => c.id), ['s4', 's5'])
  // One fewer session than the cap: nothing is beyond rank 3.
  assert.deepEqual(selectRetentionDeletions(ranked.slice(0, 3), policy()), [])
})

test('both rules union: an old session inside the cap still dies via the age rule', () => {
  // 3 sessions, cap 3 (nothing beyond the cap), but two exceed 7 days.
  const doomed = selectRetentionDeletions(
    [cand('fresh', NOW), cand('day8', NOW - 8 * DAY), cand('day9', NOW - 9 * DAY)],
    policy(),
  )
  assert.deepEqual(doomed.map(c => c.id), ['day8', 'day9']) // pool order
})

test('count-rule idle boundary is exact: idle == 24h survives, idle > 24h dies', () => {
  const idleCutoff = NOW - RETENTION_MIN_IDLE_MS
  const doomed = selectRetentionDeletions(
    [cand('keep', NOW), cand('keep2', NOW - 1), cand('keep3', NOW - 2), cand('at-24h-exactly', idleCutoff), cand('just-past-24h', idleCutoff - 1)],
    policy(),
  )
  // 'at-24h-exactly' is rank 4 (beyond cap 3) but idle EXACTLY the guard
  // — the strict `<` keeps it (same boundary semantics as the age rule).
  // 'just-past-24h' is rank 5 and strictly older than the guard — dies.
  assert.deepEqual(doomed.map(c => c.id), ['just-past-24h'])
})

test('ranking is by mtime, not input order; ties break by id deterministically', () => {
  const shuffled = [cand('z-newest', NOW - 1 * DAY), cand('m-old', NOW - 5 * DAY), cand('a-oldest', NOW - 6 * DAY), cand('b-tied', NOW - 5 * DAY), cand('y-fresh', NOW - 1000)]
  // Ranked newest→oldest: y-fresh, z-newest, then the NOW-5d tie broken
  // by id (b-tied rank 3, m-old rank 4), a-oldest rank 5. Beyond cap 3:
  // m-old and a-oldest — both idle > 24h and inside 7 days (count rule,
  // not age). Output preserves input (pool) order.
  assert.deepEqual(selectRetentionDeletions(shuffled, policy()).map(c => c.id), ['m-old', 'a-oldest'])
})

// ------------------------------------------- pure: protected session set --

test('the current session is never deleted and never consumes a cap slot', () => {
  // Current is the OLDEST and beyond the cap — still exempt from both
  // rules.
  const doomed = selectRetentionDeletions(
    [cand('fresh', NOW), cand('fresh2', NOW - 1), cand('fresh3', NOW - 2), cand('the-current', NOW - 6 * DAY)],
    policy(),
    ['the-current'],
  )
  assert.deepEqual(doomed.map(c => c.id), [])
  // Slot-freedom check: 5 sessions, the current one the NEWEST (rank 1
  // material). See the second half below.
  const pool = [
    cand('the-current', NOW),
    cand('d1', NOW - 2 * DAY),
    cand('d2', NOW - 3 * DAY),
    cand('d3', NOW - 4 * DAY),
    cand('d4', NOW - 5 * DAY),
  ]
  const doomedIds = selectRetentionDeletions(pool, policy(), ['the-current']).map(c => c.id)
  // Only the oldest non-current session (d4) is beyond the cap: the
  // exempt current session does NOT consume one of the 3 slots — had it
  // ranked, d3 would have been pushed to rank 4 and deleted too.
  assert.deepEqual(doomedIds, ['d4'])
})

test('empty-string current session id is treated as absent', () => {
  const doomed = selectRetentionDeletions([cand('old', NOW - 8 * DAY)], policy(), [''])
  assert.deepEqual(doomed.map(c => c.id), ['old'])
})

test('an empty store selects nothing', () => {
  assert.deepEqual(selectRetentionDeletions([], policy()), [])
})

// ------------------------------------------------------------ pure: defaults --

test('defaults match the shipped policy: 100 kept, 7 days, 24h idle guard', () => {
  // 105 sessions spanning 5 days (all idle-protected): only the 5 ranked
  // beyond 100 are collected. Verifies RETENTION_MAX_COUNT is the real cap.
  const pool = Array.from({ length: 105 }, (_, i) => cand(`s${i}`, NOW - i * 60 * 60 * 1000))
  const doomed = selectRetentionDeletions(pool, policy({ maxCount: RETENTION_MAX_COUNT }), ['nope'])
  assert.equal(doomed.length, 5)
  assert.deepEqual(doomed.map(c => c.id).sort(), ['s100', 's101', 's102', 's103', 's104'])
})

// ------------------------------------------------------------ env knobs --

test('resolveRetentionConfig: defaults when the environment is silent', () => {
  assert.deepEqual(resolveRetentionConfig({}), {
    maxCount: 100,
    maxAgeDays: 7,
    minIdleMs: 24 * 60 * 60 * 1000,
    enabled: true,
  })
})

test('resolveRetentionConfig: valid overrides apply; hours convert to ms', () => {
  assert.deepEqual(
    resolveRetentionConfig({
      DSH_TUI_RETENTION_MAX_COUNT: '5',
      DSH_TUI_RETENTION_MAX_AGE_DAYS: '30',
      DSH_TUI_RETENTION_MIN_IDLE_HOURS: '2.5',
    }),
    { maxCount: 5, maxAgeDays: 30, minIdleMs: 2.5 * 60 * 60 * 1000, enabled: true },
  )
  // A zero-hour idle guard is legal: the count rule fires immediately
  // past the cap (aggressive, but the user's explicit choice).
  assert.equal(resolveRetentionConfig({ DSH_TUI_RETENTION_MIN_IDLE_HOURS: '0' }).minIdleMs, 0)
})

test('resolveRetentionConfig: MAX_COUNT <= 0 disables retention; the knobs still resolve', () => {
  for (const raw of ['0', '-1']) {
    const config = resolveRetentionConfig({ DSH_TUI_RETENTION_MAX_COUNT: raw })
    assert.equal(config.enabled, false, raw)
    // The raw sentinel is preserved verbatim (nobody reads it — the
    // disabled pass returns before consuming any knob); the OTHER knobs
    // still resolve to their defaults.
    assert.equal(config.maxCount, Number(raw), raw)
    assert.equal(config.maxAgeDays, RETENTION_MAX_AGE_DAYS, raw)
  }
  assert.equal(resolveRetentionConfig({ DSH_TUI_RETENTION_MAX_COUNT: '12' }).enabled, true)
})

test('resolveRetentionConfig: invalid values fall back to the defaults', () => {
  // Non-numeric, empty, fractional count, or out of range (age must be
  // > 0, idle hours >= 0, count must be an integer) — a typo must never
  // silently widen or gut the policy.
  const bad = [
    { DSH_TUI_RETENTION_MAX_COUNT: 'abc' },
    { DSH_TUI_RETENTION_MAX_COUNT: '' },
    { DSH_TUI_RETENTION_MAX_COUNT: '100.5' },
    { DSH_TUI_RETENTION_MAX_COUNT: '-1.5' },
    { DSH_TUI_RETENTION_MAX_AGE_DAYS: '0' },
    { DSH_TUI_RETENTION_MAX_AGE_DAYS: '-7' },
    { DSH_TUI_RETENTION_MAX_AGE_DAYS: 'one week' },
    { DSH_TUI_RETENTION_MIN_IDLE_HOURS: '-1' },
    { DSH_TUI_RETENTION_MIN_IDLE_HOURS: 'later' },
  ]
  for (const env of bad) {
    const config = resolveRetentionConfig(env)
    assert.deepEqual(
      [config.maxCount, config.maxAgeDays, config.minIdleMs, config.enabled],
      [RETENTION_MAX_COUNT, RETENTION_MAX_AGE_DAYS, RETENTION_MIN_IDLE_MS, true],
      JSON.stringify(env),
    )
  }
})

test('resolveRetentionConfig: a fractional env MAX_COUNT is invalid env — the count rule stays armed at the default', () => {
  // The regression shape: 100.5 parses finite and positive, so the old
  // env layer accepted it — but `ranked[100.5]` is undefined forever and
  // the count loop never collected anything (the rule died silently). A
  // non-integer env count is invalid env: silent fall to the default,
  // same as any other garbage (only the settings layer warns).
  const warnings = []
  const originalWarn = console.warn
  console.warn = line => { warnings.push(line) }
  try {
    const config = resolveRetentionConfig({ DSH_TUI_RETENTION_MAX_COUNT: '100.5' })
    assert.equal(config.maxCount, RETENTION_MAX_COUNT, 'fractional count falls to the default 100')
    assert.equal(config.enabled, true)
    assert.deepEqual(warnings, [], 'env-level fallbacks are silent')
    // And the count rule genuinely fires at the resolved cap: 105 idle
    // sessions, the 5 ranked beyond 100 are collected (had 100.5 won,
    // this selection would return [] — the silent-death symptom).
    const pool = Array.from({ length: 105 }, (_, i) => cand(`s${i}`, NOW - i * 60 * 60 * 1000))
    const doomed = selectRetentionDeletions(pool, policy({ maxCount: config.maxCount }))
    assert.deepEqual(
      doomed.map(c => c.id).sort(),
      ['s100', 's101', 's102', 's103', 's104'],
      'the count rule collects beyond the default cap',
    )
  } finally {
    console.warn = originalWarn
  }
})

// ------------------------------------------------ settings precedence --

test('resolveRetentionConfig: explicit settings outrank env; env outranks defaults', () => {
  const settings = { maxCount: 42, maxAgeDays: 30, minIdleHours: 3 }
  assert.deepEqual(
    resolveRetentionConfig({
      DSH_TUI_RETENTION_MAX_COUNT: '5',
      DSH_TUI_RETENTION_MAX_AGE_DAYS: '14',
      DSH_TUI_RETENTION_MIN_IDLE_HOURS: '2',
    }, settings),
    { maxCount: 42, maxAgeDays: 30, minIdleMs: 3 * 60 * 60 * 1000, enabled: true },
    'settings wins on every knob',
  )
  // No settings section: the env layer governs.
  assert.deepEqual(
    resolveRetentionConfig({ DSH_TUI_RETENTION_MAX_COUNT: '5' }, undefined),
    { maxCount: 5, maxAgeDays: RETENTION_MAX_AGE_DAYS, minIdleMs: RETENTION_MIN_IDLE_MS, enabled: true },
  )
  // A partial settings section overrides only the present fields; the
  // absent ones keep flowing through env → default.
  const partial = resolveRetentionConfig(
    { DSH_TUI_RETENTION_MAX_COUNT: '5', DSH_TUI_RETENTION_MIN_IDLE_HOURS: '2' },
    { maxAgeDays: 30 },
  )
  assert.deepEqual(
    [partial.maxCount, partial.maxAgeDays, partial.minIdleMs],
    [5, 30, 2 * 60 * 60 * 1000],
  )
  // Everything silent: the defaults.
  assert.deepEqual(resolveRetentionConfig({}, {}), {
    maxCount: RETENTION_MAX_COUNT,
    maxAgeDays: RETENTION_MAX_AGE_DAYS,
    minIdleMs: RETENTION_MIN_IDLE_MS,
    enabled: true,
  })
})

test('resolveRetentionConfig: settings maxCount <= 0 disables retention (the documented off switch)', () => {
  for (const maxCount of [0, -3]) {
    const config = resolveRetentionConfig(
      { DSH_TUI_RETENTION_MAX_COUNT: '500' },
      { maxCount },
    )
    assert.equal(config.enabled, false, `maxCount ${maxCount} disables despite env`)
    // The sentinel is preserved verbatim (the disabled pass returns before
    // consuming any knob); the other knobs still resolve.
    assert.equal(config.maxCount, maxCount)
    assert.equal(config.maxAgeDays, RETENTION_MAX_AGE_DAYS)
  }
  // A positive settings maxCount re-enables even against a disabling env.
  assert.equal(resolveRetentionConfig({ DSH_TUI_RETENTION_MAX_COUNT: '0' }, { maxCount: 12 }).enabled, true)
})

test('resolveRetentionConfig: invalid settings values warn one line each and fall to the next level', () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = line => { warnings.push(line) }
  try {
    // Type error, non-integer count, non-positive age, negative idle: each
    // present-but-invalid field is rejected with exactly one stderr line,
    // and the chain continues at the env layer.
    const config = resolveRetentionConfig(
      {
        DSH_TUI_RETENTION_MAX_COUNT: '5',
        DSH_TUI_RETENTION_MAX_AGE_DAYS: '14',
        DSH_TUI_RETENTION_MIN_IDLE_HOURS: '2',
      },
      { maxCount: 'many', maxAgeDays: 0, minIdleHours: -1.5 },
    )
    assert.deepEqual(
      config,
      { maxCount: 5, maxAgeDays: 14, minIdleMs: 2 * 60 * 60 * 1000, enabled: true },
      'invalid settings fell through to env on every knob',
    )
    assert.equal(warnings.length, 3, 'one line per invalid field')
    assert.match(warnings[0], /^\[dsh-tui-pi\] settings dsh-tui\.retention\.maxCount: invalid value "many" — falling back to environment\/default$/)
    assert.match(warnings[1], /dsh-tui\.retention\.maxAgeDays: invalid value 0 —/)
    assert.match(warnings[2], /dsh-tui\.retention\.minIdleHours: invalid value -1\.5 —/)

    // Invalid settings with no env either → the defaults (still one line).
    warnings.length = 0
    assert.deepEqual(
      resolveRetentionConfig({}, { maxCount: 42.5, maxAgeDays: Number.NaN, minIdleHours: 'later' }),
      { maxCount: RETENTION_MAX_COUNT, maxAgeDays: RETENTION_MAX_AGE_DAYS, minIdleMs: RETENTION_MIN_IDLE_MS, enabled: true },
    )
    assert.equal(warnings.length, 3)

    // Absent fields never warn; valid values never warn.
    warnings.length = 0
    resolveRetentionConfig({}, { maxCount: 7, maxAgeDays: undefined, minIdleHours: 0 })
    assert.deepEqual(warnings, [])
  } finally {
    console.warn = originalWarn
  }
})

test('runSessionRetention honors explicit settings over env (loosened window keeps old logs)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-set-'))
  const prev = process.env.DSH_TUI_RETENTION_MAX_AGE_DAYS
  process.env.DSH_TUI_RETENTION_MAX_AGE_DAYS = '7'
  try {
    const now = Date.now()
    const ancient = await makeSession(dir, 'proj', 'nine-days', now - 9 * DAY)
    // settings.yaml says 30 days — the deliberate persistent choice wins
    // over the ambient env (which alone would delete the 9-day log).
    const result = await runSessionRetention({
      root: dir,
      maxCount: 3,
      getSessionId: () => undefined,
      readSettings: async () => ({ maxAgeDays: 30 }),
      now,
    })
    assert.deepEqual(result, { removed: 0, failed: 0 })
    assert.equal(await stat(ancient).then(() => true, () => false), true)
  } finally {
    if (prev === undefined) delete process.env.DSH_TUI_RETENTION_MAX_AGE_DAYS
    else process.env.DSH_TUI_RETENTION_MAX_AGE_DAYS = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('runSessionRetention: settings maxCount 0 disables the pass even with env set; a throwing readSettings degrades', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-off2-'))
  const prev = process.env.DSH_TUI_RETENTION_MAX_COUNT
  process.env.DSH_TUI_RETENTION_MAX_COUNT = '500'
  try {
    const now = Date.now()
    const ancient = await makeSession(dir, 'proj', 'ancient', now - 30 * DAY)
    const disabled = await runSessionRetention({
      root: dir,
      maxCount: 3,
      getSessionId: () => undefined,
      readSettings: async () => ({ maxCount: 0 }),
      now,
    })
    assert.deepEqual(disabled, { removed: 0, failed: 0 })
    assert.equal(await stat(ancient).then(() => true, () => false), true)

    // A readSettings that rejects must never fail the pass: it proceeds on
    // env (500 — nothing beyond the count cap; the age rule still fires).
    const degraded = await runSessionRetention({
      root: dir,
      maxCount: 3,
      getSessionId: () => undefined,
      readSettings: async () => { throw new Error('settings unavailable') },
      now,
    })
    assert.deepEqual(degraded, { removed: 1, failed: 0 })
    assert.equal(await stat(ancient).then(() => true, () => false), false)
  } finally {
    if (prev === undefined) delete process.env.DSH_TUI_RETENTION_MAX_COUNT
    else process.env.DSH_TUI_RETENTION_MAX_COUNT = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('runSessionRetention honors DSH_TUI_RETENTION_MAX_AGE_DAYS (loosened window keeps old logs)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-env-'))
  const prev = process.env.DSH_TUI_RETENTION_MAX_AGE_DAYS
  process.env.DSH_TUI_RETENTION_MAX_AGE_DAYS = '30'
  try {
    const now = Date.now()
    const ancient = await makeSession(dir, 'proj', 'nine-days', now - 9 * DAY)
    const result = await runSessionRetention({ root: dir, maxCount: 3, getSessionId: () => undefined, now })
    assert.deepEqual(result, { removed: 0, failed: 0 })
    assert.equal(await stat(ancient).then(() => true, () => false), true)
  } finally {
    if (prev === undefined) delete process.env.DSH_TUI_RETENTION_MAX_AGE_DAYS
    else process.env.DSH_TUI_RETENTION_MAX_AGE_DAYS = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('DSH_TUI_RETENTION_MAX_COUNT=0 disables the whole pass — and a dep override does not re-enable it', async () => {
  // The documented escape hatch for concurrent processes (feishu remote,
  // headless runs) that read-attach old sessions long-term.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-off-'))
  const prev = process.env.DSH_TUI_RETENTION_MAX_COUNT
  process.env.DSH_TUI_RETENTION_MAX_COUNT = '0'
  try {
    const now = Date.now()
    const ancient = await makeSession(dir, 'proj', 'ancient', now - 30 * DAY)
    const result = await runSessionRetention({ root: dir, maxCount: 3, getSessionId: () => undefined, now })
    assert.deepEqual(result, { removed: 0, failed: 0 })
    assert.equal(await stat(ancient).then(() => true, () => false), true)
  } finally {
    if (prev === undefined) delete process.env.DSH_TUI_RETENTION_MAX_COUNT
    else process.env.DSH_TUI_RETENTION_MAX_COUNT = prev
    await rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------- resume-in-flight race --

test('the protected set is current ∪ pending-resume target: neither is deleted nor consumes a cap slot', () => {
  // Both protected sessions are ancient and beyond the cap — still exempt
  // from both rules, and their absence from the ranking leaves the three
  // fresh sessions inside the cap untouched.
  const pool = [
    cand('fresh', NOW),
    cand('fresh2', NOW - 1),
    cand('fresh3', NOW - 2),
    cand('the-current', NOW - 6 * DAY),
    cand('resume-target', NOW - 8 * DAY),
  ]
  assert.deepEqual(selectRetentionDeletions(pool, policy(), ['the-current', 'resume-target']).map(c => c.id), [])
  // Drop either protection and that session dies (age rule for the
  // 8-day-old target, both rules for the 6-day-old current at cap 3).
  assert.deepEqual(
    selectRetentionDeletions(pool, policy(), ['the-current']).map(c => c.id),
    ['resume-target'],
  )
  assert.deepEqual(
    selectRetentionDeletions(pool, policy(), ['resume-target']).map(c => c.id),
    ['the-current'],
  )
})

test('runSessionRetention protects a pending resume target that lands after the walk (re-poll)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-res-'))
  try {
    const now = Date.now()
    const doomedDir = await makeSession(dir, 'proj', 'ancient-a', now - 9 * DAY)
    const targetDir = await makeSession(dir, 'proj', 'resume-target', now - 10 * DAY)
    // Selection sees no live session and no pending resume; the target
    // "lands" only after the walk — the re-poll before its removal must
    // save it even though selection already doomed it.
    let polled = 0
    const result = await runSessionRetention({
      root: dir,
      maxCount: 3,
      getSessionId: () => undefined,
      getResumingSessionId: () => (polled++ === 0 ? undefined : 'resume-target'),
      now,
    })
    assert.deepEqual(result, { removed: 1, failed: 0 })
    assert.equal(polled, 3) // once for selection, once per doomed candidate
    assert.equal(await stat(doomedDir).then(() => true, () => false), false)
    assert.equal(await stat(targetDir).then(() => true, () => false), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runSessionRetention deletes nothing while a resume target is protected from the start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-res2-'))
  try {
    const now = Date.now()
    const target = await makeSession(dir, 'proj', 'resume-target', now - 10 * DAY)
    const result = await runSessionRetention({
      root: dir,
      maxCount: 3,
      getSessionId: () => undefined,
      getResumingSessionId: () => 'resume-target',
      now,
    })
    assert.deepEqual(result, { removed: 0, failed: 0 })
    assert.equal(await stat(target).then(() => true, () => false), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- walk --

/**
 * Build `<root>/<project>/<session>/session.jsonl[.zstd]` fixtures with
 * pinned log mtimes (utimes), the sessions.test.mjs pattern.
 */
async function makeSession(root, project, id, mtimeMs, name = 'session.jsonl') {
  const dir = join(root, project, id)
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  await writeFile(file, '{}\n', 'utf8')
  await utimes(file, new Date(mtimeMs), new Date(mtimeMs))
  return dir
}

test('collectRetentionCandidates walks directories only and takes the newest log mtime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-ret-'))
  try {
    await makeSession(dir, 'proj-a', 'sess-1', 111)
    // zstd sibling naming.
    await makeSession(dir, 'proj-b', 'sess-2', 222, 'session.jsonl.zstd')
    // Raw + compressed coexist: the newer of the two wins.
    const both = join(dir, 'proj-c', 'sess-3')
    await mkdir(both, { recursive: true })
    await writeFile(join(both, 'session.jsonl'), 'x', 'utf8')
    await utimes(join(both, 'session.jsonl'), new Date(100), new Date(100))
    await writeFile(join(both, 'session.jsonl.zstd'), 'y', 'utf8')
    await utimes(join(both, 'session.jsonl.zstd'), new Date(300), new Date(300))
    // Noise that must NOT become a candidate: empty project bucket,
    // empty session dir (no log), flat bucket file, root-level file.
    await mkdir(join(dir, 'proj-empty'), { recursive: true })
    await mkdir(join(dir, 'proj-a', 'no-log-dir'), { recursive: true })
    await writeFile(join(dir, 'proj-a', 'flat.jsonl'), 'x', 'utf8')
    await writeFile(join(dir, 'stray.txt'), 'x', 'utf8')

    const candidates = await collectRetentionCandidates(dir)
    const byId = new Map(candidates.map(c => [c.id, c]))
    assert.equal(candidates.length, 3)
    assert.equal(byId.get('sess-1').mtimeMs, 111)
    assert.equal(byId.get('sess-2').mtimeMs, 222)
    assert.equal(byId.get('sess-3').mtimeMs, 300)
    assert.ok(byId.get('sess-1').dir.endsWith(join('proj-a', 'sess-1')))
    assert.equal(byId.has('no-log-dir'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectRetentionCandidates resolves an empty list for a missing root', async () => {
  const candidates = await collectRetentionCandidates(join(tmpdir(), 'dsh-tui-nope-' + Date.now()))
  assert.deepEqual(candidates, [])
})

test('sessionStoreRoot resolves $DSH_HOME/sessions (core convention, no $DSH_SESSION_ROOT)', async () => {
  const prev = process.env.DSH_HOME
  const prevRoot = process.env.DSH_SESSION_ROOT
  try {
    // A set $DSH_SESSION_ROOT must NOT win: the core writer only reads
    // $DSH_HOME, so retention must resolve exactly the same tree.
    process.env.DSH_SESSION_ROOT = '/tmp/elsewhere-sessions'
    process.env.DSH_HOME = '/tmp/dsh-home-x'
    assert.equal(sessionStoreRoot(), join('/tmp/dsh-home-x', 'sessions'))
    delete process.env.DSH_HOME
    delete process.env.DSH_SESSION_ROOT
    assert.ok(sessionStoreRoot().endsWith(join('.dsh', 'sessions')))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    if (prevRoot === undefined) delete process.env.DSH_SESSION_ROOT
    else process.env.DSH_SESSION_ROOT = prevRoot
  }
})

// -------------------------------------------------------------- fs pass --

test('runSessionRetention deletes the right directories and keeps buckets + strays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-run-'))
  try {
    const now = Date.now()
    const ages = { 'd-age': 9 * DAY, 'k-fresh': 1000, 'k-recent': 2 * DAY, 'k-protected': 3 * 60 * 1000, 'd-idle-out': 5 * DAY }
    const made = {}
    for (const [id, age] of Object.entries(ages)) made[id] = await makeSession(dir, 'proj', id, now - age)
    // Stray flat file inside the bucket survives untouched.
    await writeFile(join(dir, 'proj', 'stray-flat.jsonl'), 'x', 'utf8')
    await mkdir(join(dir, 'empty-bucket'), { recursive: true })

    const result = await runSessionRetention({
      root: dir,
      maxCount: 3,
      // No live session in this pass.
      getSessionId: () => undefined,
      now,
    })
    assert.deepEqual(result, { removed: 2, failed: 0 })

    const exists = async p => { try { await stat(p); return true } catch { return false } }
    assert.equal(await exists(made['d-age']), false) // age rule
    assert.equal(await exists(made['d-idle-out']), false) // count rule: rank 4 of 5, idle > 24h
    for (const id of ['k-fresh', 'k-recent', 'k-protected']) assert.equal(await exists(made[id]), true, id)
    // Project buckets, the empty bucket, and every stray file survive.
    assert.equal(await exists(join(dir, 'proj')), true)
    assert.equal(await exists(join(dir, 'proj', 'stray-flat.jsonl')), true)
    assert.equal(await exists(join(dir, 'empty-bucket')), true)
    assert.deepEqual((await readdir(join(dir, 'proj'))).sort(), ['k-fresh', 'k-protected', 'k-recent', 'stray-flat.jsonl'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runSessionRetention re-checks the current session before every removal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-cur-'))
  try {
    const now = Date.now()
    // Two ancient sessions; the "live" one lands after the walk — the
    // re-poll before each rm must save it even though selection already
    // doomed it.
    const doomedDir = await makeSession(dir, 'proj', 'ancient-a', now - 9 * DAY)
    const currentDir = await makeSession(dir, 'proj', 'ancient-live', now - 10 * DAY)
    let polled = 0
    const getSessionId = () => (polled++ === 0 ? undefined : 'ancient-live')
    const result = await runSessionRetention({ root: dir, maxCount: 3, getSessionId, now })
    assert.deepEqual(result, { removed: 1, failed: 0 })
    assert.equal(polled, 3) // once for selection, once per doomed removal
    assert.equal(await stat(doomedDir).then(() => true, () => false), false)
    assert.equal(await stat(currentDir).then(() => true, () => false), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runSessionRetention is silent, non-fatal and inert on a missing root', async () => {
  const result = await runSessionRetention({
    root: join(tmpdir(), 'dsh-tui-missing-' + Date.now()),
    getSessionId: () => undefined,
  })
  assert.deepEqual(result, { removed: 0, failed: 0 })
})

test('a failed rm counts as failed and never stops the remaining removals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-fail-'))
  try {
    const now = Date.now()
    const lockedDir = await makeSession(dir, 'locked-proj', 'ancient-locked', now - 9 * DAY)
    const openDir = await makeSession(dir, 'open-proj', 'ancient-open', now - 9 * DAY)
    // Removing a child requires WRITE permission on its parent bucket:
    // 0555 keeps the walk alive (readdir/stat need only r-x) but breaks
    // every rm inside the bucket — a real-world EACCES failure shape.
    await chmod(join(dir, 'locked-proj'), 0o555)
    const result = await runSessionRetention({
      root: dir,
      maxCount: 3,
      getSessionId: () => undefined,
      now,
    })
    assert.deepEqual(result, { removed: 1, failed: 1 })
    // The locked directory survived intact; the failure did not stop the
    // removal in the other bucket.
    assert.equal(await stat(lockedDir).then(() => true, () => false), true)
    assert.equal(await stat(openDir).then(() => true, () => false), false)
  } finally {
    await chmod(join(dir, 'locked-proj'), 0o755).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

test('a session-level symlink to a directory is skipped by the walk (lstat semantics)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-link-'))
  try {
    const real = await makeSession(dir, 'proj', 'real-session', 111)
    // A symlinked session entry: readdir(withFileTypes) classifies entries
    // via lstat, so isDirectory() is false and the walk must not follow
    // the link — deleting "through" it would target a directory other
    // than the store-owned path, and double-walking would double-count.
    await symlink(real, join(dir, 'proj', 'linked-session'))
    const candidates = await collectRetentionCandidates(dir)
    assert.deepEqual(candidates.map(c => c.id), ['real-session'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------- one-shot --

test('runSessionRetentionOnce runs once per process across /reload-style re-invocations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-once-'))
  try {
    const now = Date.now()
    const ancient = await makeSession(dir, 'proj', 'ancient', now - 9 * DAY)
    const first = await runSessionRetentionOnce({ root: dir, maxCount: 3, getSessionId: () => undefined, now })
    assert.deepEqual(first, { removed: 1, failed: 0 })
    assert.equal(await stat(ancient).then(() => true, () => false), false)
    // The /reload re-run: a fresh module load would re-run apply(); the
    // process-global flag must make this pass a no-op even though new
    // ancient sessions appeared.
    const fresh = await makeSession(dir, 'proj', 'ancient-2', now - 9 * DAY)
    const second = await runSessionRetentionOnce({ root: dir, maxCount: 3, getSessionId: () => undefined, now })
    assert.deepEqual(second, { removed: 0, failed: 0 })
    assert.equal(await stat(fresh).then(() => true, () => false), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
