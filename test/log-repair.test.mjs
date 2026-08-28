/**
 * Corrupted-resume-log repair orchestration (src/log-repair.ts →
 * lib/log-repair.js) plus the repair confirmation dialog reducer
 * (src/repair-dialog.ts) and the corrupt-row picker label (src/sessions.ts)
 * — pure logic over a stubbed spawnSync, so the whole matrix runs without a
 * terminal and without touching real session logs. Disk fixtures live in
 * mkdtemp dirs; the writer lock is exercised for real (same pid-file
 * contract as writer-lock.test.mjs) inside those dirs.
 *
 * Contracts under test:
 * - runRepair maps the script's exit contract (0 CLEAN / 0+artifact
 *   repaired / 3 corrupt-unwritten / 2 environment / ENOENT → install hint);
 * - swapRepaired keeps the original as .corrupt-bak (ms-suffixed when
 *   taken), swaps the verified copy in, chmod 0600;
 * - repairSessionLog claims the writer lock, never swaps an artifact that
 *   fails verification, always releases, and reports a live foreign holder;
 * - the dialog confirm/cancel matrix mirrors the routing dialog keymap;
 * - /corrupt .*(session|zstandard) log/i is the only fingerprint that
 *   routes into the repair flow.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REPAIR_TIMEOUT_MS,
  isCorruptLogError,
  locateSessionLog,
  repairFailureNotice,
  repairScriptPath,
  repairedArtifactPath,
  repairSessionLog,
  runRepair,
  swapRepaired,
  verifyClean,
} from '../lib/log-repair.js'
import {
  REPAIR_CONFIRM_OPTIONS,
  initialRepairConfirmState,
  repairConfirmOutcome,
  updateRepairConfirm,
} from '../lib/repair-dialog.js'
import { resumeRowTitle } from '../lib/sessions.js'
import { projectKeyFor } from '../lib/writer-lock.js'

const ENTER = '\r'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ESC = '\x1b'

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `tui-log-repair-${name}-`))
}

/** A stubbed spawnSync result the way runRepair consumes it. */
function procResult({ status = 0, stdout = '', stderr = '', error } = {}) {
  return { status, stdout, stderr, error }
}

/**
 * Recording stub: asserts-free scripted spawnSync that returns queued
 * results in order and logs every call (file/args/options) for inspection.
 * Distinguish apply vs verify calls by the presence of '--apply' in args.
 */
function scriptedSpawn(results) {
  const calls = []
  const fn = (file, args, options) => {
    calls.push({ file, args, options })
    const next = results.shift()
    if (next === undefined) throw new Error('scriptedSpawn: unexpected extra call')
    return next
  }
  fn.calls = calls
  return fn
}

// ------------------------------------------------------------- runRepair ----

test('runRepair: spawns the repo script via process.execPath with the 120s budget; clean verdict maps to clean', () => {
  const dir = tempDir('clean')
  const log = join(dir, 'session.jsonl.zstd')
  writeFileSync(log, 'zstd-bytes')
  const spawnFn = scriptedSpawn([procResult({ status: 0, stdout: 'rows: 3 | maxSeq: 2 | seq violations: 0\nverdict: CLEAN — nothing to do.' })])

  const result = runRepair(log, { spawnSyncFn: spawnFn })

  assert.deepEqual(result, { status: 'clean' })
  assert.equal(spawnFn.calls.length, 1)
  const call = spawnFn.calls[0]
  assert.equal(call.file, process.execPath)
  assert.equal(call.args.length, 2, 'no --apply on a dry run')
  assert.equal(call.args[0], repairScriptPath(), 'script resolves next to the built module')
  assert.equal(statSync(repairScriptPath()).isFile(), true, 'the bundled script exists')
  assert.equal(call.args[1], log)
  assert.equal(call.options.timeout, REPAIR_TIMEOUT_MS)
  assert.equal(REPAIR_TIMEOUT_MS, 120_000)
  rmSync(dir, { recursive: true, force: true })
})

test('runRepair: exit 0 with a written artifact maps to repaired with the predicted path', () => {
  const dir = tempDir('repaired')
  const log = join(dir, 'session.jsonl.zstd')
  writeFileSync(log, 'corrupt')
  const artifact = repairedArtifactPath(log)
  assert.equal(artifact, join(dir, 'session.repaired.jsonl.zstd'), 'stem naming mirrors the script')
  writeFileSync(artifact, 'fixed')
  const spawnFn = scriptedSpawn([procResult({ status: 0, stdout: 'wrote ' + artifact + ' (5 rows). Original untouched.' })])

  const result = runRepair(log, { apply: true, spawnSyncFn: spawnFn })

  assert.equal(result.status, 'repaired')
  assert.equal(result.repairedPath, artifact)
  assert.match(result.detail, /wrote/)
  assert.deepEqual(spawnFn.calls[0].args, [repairScriptPath(), log, '--apply'])
  rmSync(dir, { recursive: true, force: true })
})

test('runRepair: plain .jsonl logs predict a .repaired.jsonl artifact', () => {
  assert.equal(repairedArtifactPath('/x/y/log.jsonl'), '/x/y/log.repaired.jsonl')
  assert.equal(repairedArtifactPath('/x/y/log.jsonl.zstd'), '/x/y/log.repaired.jsonl.zstd')
})

test('runRepair: exit 0 without CLEAN verdict and without an artifact is a contract failure', () => {
  const dir = tempDir('no-artifact')
  const log = join(dir, 'session.jsonl')
  writeFileSync(log, 'corrupt')
  const spawnFn = scriptedSpawn([procResult({ status: 0, stdout: 'wrote (claimed)' })])

  const result = runRepair(log, { apply: true, spawnSyncFn: spawnFn })

  assert.equal(result.status, 'failed')
  assert.match(result.detail, /no repaired artifact/)
  rmSync(dir, { recursive: true, force: true })
})

test('runRepair: exit 3 (corrupt, nothing written) and exit 2 (environment) both fail with detail', () => {
  const dir = tempDir('exits')
  const log = join(dir, 'session.jsonl')
  writeFileSync(log, 'corrupt')

  const dry = runRepair(log, { spawnSyncFn: scriptedSpawn([procResult({ status: 3, stdout: 'repair-session-log: 2 torn/unparseable line(s)' })]) })
  assert.equal(dry.status, 'failed')
  assert.match(dry.detail, /torn\/unparseable/)

  const env = runRepair(log, { apply: true, spawnSyncFn: scriptedSpawn([procResult({ status: 2, stderr: 'repair-session-log: cannot run zstd: spawn zstd ENOENT' })]) })
  assert.equal(env.status, 'failed')
  assert.match(env.detail, /cannot run zstd/)

  rmSync(dir, { recursive: true, force: true })
})

test('runRepair: spawn ENOENT fails with the install-zstd hint; other spawn errors fail plainly', () => {
  const dir = tempDir('enoent')
  const log = join(dir, 'session.jsonl')
  writeFileSync(log, 'x')

  const missing = runRepair(log, { spawnSyncFn: scriptedSpawn([procResult({ error: Object.assign(new Error('spawn zstd ENOENT'), { code: 'ENOENT' }) })]) })
  assert.equal(missing.status, 'failed')
  assert.match(missing.detail, /is zstd installed/)

  const timedOut = runRepair(log, { spawnSyncFn: scriptedSpawn([procResult({ error: Object.assign(new Error('spawn timed out'), { code: 'ETIMEDOUT' }) })]) })
  assert.equal(timedOut.status, 'failed')
  assert.doesNotMatch(timedOut.detail, /is zstd installed/, 'the hint is ENOENT-specific')
  assert.match(timedOut.detail, /timed out/)

  rmSync(dir, { recursive: true, force: true })
})

test('verifyClean: passes only on the CLEAN verdict and never passes --apply', () => {
  const dir = tempDir('verify')
  const log = join(dir, 'session.repaired.jsonl')
  writeFileSync(log, 'fixed')

  const ok = verifyClean(log, { spawnSyncFn: scriptedSpawn([procResult({ status: 0, stdout: 'verdict: CLEAN — nothing to do.' })]) })
  assert.deepEqual(ok, { ok: true })

  const bad = verifyClean(log, { spawnSyncFn: scriptedSpawn([procResult({ status: 3, stdout: '  ✗ line 4: assistant/message covers 3..3 after coverage through 3' })]) })
  assert.equal(bad.ok, false)
  assert.match(bad.detail, /line 4/)

  rmSync(dir, { recursive: true, force: true })
})

// --------------------------------------------------------- swapRepaired ----

test('swapRepaired: original becomes .corrupt-bak, repaired copy takes over with 0600', () => {
  const dir = tempDir('swap')
  const log = join(dir, 'session.jsonl')
  const repaired = join(dir, 'session.repaired.jsonl')
  writeFileSync(log, 'corrupt-bytes')
  chmodSync(log, 0o644)
  writeFileSync(repaired, 'fixed-bytes')

  const { backupPath } = swapRepaired(log, repaired)

  assert.equal(backupPath, join(dir, 'session.jsonl.corrupt-bak'))
  assert.equal(readFileSync(backupPath, 'utf8'), 'corrupt-bytes', 'the original is preserved verbatim')
  assert.equal(readFileSync(log, 'utf8'), 'fixed-bytes', 'the verified copy sits under the canonical name')
  const mode = statSync(log).mode & 0o777
  assert.equal(mode, 0o600, 'the swapped-in log is owner-only')
  assert.deepEqual(readdirSync(dir).sort(), ['session.jsonl', 'session.jsonl.corrupt-bak'], 'the artifact is consumed by the swap')
  rmSync(dir, { recursive: true, force: true })
})

test('swapRepaired: a taken .corrupt-bak name gets the unix-ms suffix, never an overwrite', () => {
  const dir = tempDir('swap-suffix')
  const log = join(dir, 'session.jsonl')
  const repaired = join(dir, 'session.repaired.jsonl')
  writeFileSync(log, 'second-corruption')
  writeFileSync(repaired, 'second-fix')
  writeFileSync(join(dir, 'session.jsonl.corrupt-bak'), 'first-corruption')

  const { backupPath } = swapRepaired(log, repaired)

  assert.notEqual(backupPath, join(dir, 'session.jsonl.corrupt-bak'))
  assert.match(backupPath, /\.corrupt-bak\.\d+$/, 'backup naming is .corrupt-bak.<unixms>')
  assert.equal(readFileSync(backupPath, 'utf8'), 'second-corruption')
  assert.equal(readFileSync(join(dir, 'session.jsonl.corrupt-bak'), 'utf8'), 'first-corruption', 'the earlier backup is untouched')
  assert.equal(readFileSync(log, 'utf8'), 'second-fix')
  rmSync(dir, { recursive: true, force: true })
})

test('swapRepaired: a failed swap-in restores the original from the backup before rethrowing', () => {
  const dir = tempDir('swap-restore')
  const log = join(dir, 'session.jsonl')
  writeFileSync(log, 'original-bytes')

  // The repaired copy vanished between verification and the swap (the
  // crash-window the restore exists for): rename #2 fails, rename #1 rolls back.
  assert.throws(() => swapRepaired(log, join(dir, 'missing.repaired.jsonl')), /ENOENT/)

  assert.equal(readFileSync(log, 'utf8'), 'original-bytes', 'the canonical log is back in place')
  assert.deepEqual(
    readdirSync(dir).filter(name => name !== 'session.jsonl'),
    [],
    'no backup residue survives the restore',
  )
  rmSync(dir, { recursive: true, force: true })
})

test('swapRepaired: a chmod failure never flips the swap outcome', () => {
  const dir = tempDir('swap-chmod')
  const log = join(dir, 'session.jsonl')
  const repaired = join(dir, 'session.repaired.jsonl')
  writeFileSync(log, 'corrupt-bytes')
  writeFileSync(repaired, 'fixed-bytes')

  const { backupPath } = swapRepaired(log, repaired, {
    chmodFn: () => { throw new Error('EPERM: operation not permitted') },
  })

  assert.equal(backupPath, join(dir, 'session.jsonl.corrupt-bak'))
  assert.equal(readFileSync(log, 'utf8'), 'fixed-bytes', 'the verified copy stays swapped in')
  assert.equal(readFileSync(backupPath, 'utf8'), 'corrupt-bytes')
  rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------ repairSessionLog ----

/** Real-log fixture: a session dir under a project key, holding a "corrupt" log. */
function logFixture(name, content = 'corrupt-zstd-bytes') {
  const root = tempDir(name)
  const dir = join(root, projectKeyFor('/repo'), 'sid-1')
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'session.jsonl.zstd')
  writeFileSync(log, content)
  return { root, dir, log }
}

/** Stub pair: --apply writes a real artifact beside the log; dry-run verifies CLEAN. */
function applyThenCleanSpawn(artifactContent = 'fixed-zstd-bytes') {
  const calls = []
  const fn = (_file, args, options) => {
    calls.push({ args, options })
    if (args.includes('--apply')) {
      writeFileSync(repairedArtifactPath(args[1]), artifactContent)
      return procResult({ status: 0, stdout: `wrote ${repairedArtifactPath(args[1])} (5 rows). Original untouched.` })
    }
    return procResult({ status: 0, stdout: 'verdict: CLEAN — nothing to do.' })
  }
  fn.calls = calls
  return fn
}

test('repairSessionLog: applies, verifies, swaps under the lock — and releases it', async () => {
  const { dir, log } = logFixture('happy')
  const spawnFn = applyThenCleanSpawn()

  const result = await repairSessionLog(log, { spawnSyncFn: spawnFn })

  assert.equal(result.kind, 'repaired')
  assert.equal(result.backupPath, `${log}.corrupt-bak`)
  assert.equal(readFileSync(log, 'utf8'), 'fixed-zstd-bytes', 'the verified repair is the new canonical log')
  assert.equal(readFileSync(result.backupPath, 'utf8'), 'corrupt-zstd-bytes', 'the original is the backup')
  const mode = statSync(log).mode & 0o777
  assert.equal(mode, 0o600)
  const modes = spawnFn.calls.map(call => call.args.includes('--apply') ? 'apply' : 'verify')
  assert.deepEqual(modes, ['apply', 'verify'], 'apply first, then verify the artifact')
  assert.equal(readdirSync(dir).includes('writer.lock'), false, 'the lock is released after the swap')
  rmSync(dir, { recursive: true, force: true })
})

test('repairSessionLog: an artifact that fails verification is never swapped in, lock still released', async () => {
  const { dir, log } = logFixture('verify-fail')
  const calls = []
  const spawnFn = (_file, args) => {
    calls.push(args.includes('--apply') ? 'apply' : 'verify')
    if (args.includes('--apply')) {
      writeFileSync(repairedArtifactPath(args[1]), 'still-corrupt')
      return procResult({ status: 0, stdout: `wrote ${repairedArtifactPath(args[1])}` })
    }
    return procResult({ status: 3, stdout: '  ✗ line 2: covers 1..1 after coverage through 1' })
  }

  const result = await repairSessionLog(log, { spawnSyncFn: spawnFn })

  assert.equal(result.kind, 'failed')
  assert.match(result.detail, /still fails verification/)
  assert.equal(readFileSync(log, 'utf8'), 'corrupt-zstd-bytes', 'the canonical log is untouched')
  assert.equal(readdirSync(dir).includes('session.jsonl.zstd.corrupt-bak'), false, 'no backup was made')
  assert.deepEqual(calls, ['apply', 'verify'])
  assert.equal(readdirSync(dir).includes('writer.lock'), false, 'the lock is released on failure too')
  rmSync(dir, { recursive: true, force: true })
})

test('repairSessionLog: a failed swap-in restores the canonical log and reports failed', async () => {
  const { dir, log } = logFixture('swap-restore-e2e')
  const spawnFn = (_file, args) => {
    if (args.includes('--apply')) {
      writeFileSync(repairedArtifactPath(args[1]), 'fixed-zstd-bytes')
      return procResult({ status: 0, stdout: `wrote ${repairedArtifactPath(args[1])}` })
    }
    // Verification passes, but the artifact disappears before the swap's
    // second rename — the crash window the restore path exists for.
    rmSync(args[1])
    return procResult({ status: 0, stdout: 'verdict: CLEAN — nothing to do.' })
  }

  const result = await repairSessionLog(log, { spawnSyncFn: spawnFn })

  assert.equal(result.kind, 'failed', 'the swap failure surfaces as a result, never a throw')
  assert.match(result.detail, /swap failed/)
  assert.equal(readFileSync(log, 'utf8'), 'corrupt-zstd-bytes', 'the canonical log was restored')
  assert.equal(
    readdirSync(dir).some(name => name.includes('corrupt-bak')),
    false,
    'no backup residue survives the restore',
  )
  assert.equal(readdirSync(dir).includes('writer.lock'), false, 'the lock is released after a failed swap too')
  rmSync(dir, { recursive: true, force: true })
})

test('repairSessionLog: a chmod failure mid-swap still reports repaired', async () => {
  const { dir, log } = logFixture('chmod-e2e')

  const result = await repairSessionLog(log, {
    spawnSyncFn: applyThenCleanSpawn(),
    chmodFn: () => { throw new Error('EPERM: operation not permitted') },
  })

  assert.equal(result.kind, 'repaired', 'permissions are hygiene — they never flip the outcome')
  assert.equal(readFileSync(log, 'utf8'), 'fixed-zstd-bytes')
  assert.equal(readFileSync(result.backupPath, 'utf8'), 'corrupt-zstd-bytes')
  assert.equal(readdirSync(dir).includes('writer.lock'), false)
  rmSync(dir, { recursive: true, force: true })
})

test('repairSessionLog: a live foreign holder refuses the lock and nothing is touched', async () => {
  const { dir, log } = logFixture('locked')
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  writeFileSync(join(dir, 'writer.lock'), JSON.stringify({ pid: child.pid, createdAt: '2026-08-28T00:00:00Z', holder: 'feishu' }))
  try {
    const result = await repairSessionLog(log, { spawnSyncFn: applyThenCleanSpawn() })

    assert.equal(result.kind, 'locked')
    assert.equal(result.holder.pid, child.pid)
    assert.equal(result.holder.holder, 'feishu')
    assert.equal(readFileSync(log, 'utf8'), 'corrupt-zstd-bytes', 'the log is untouched while another writer drives the session')
    assert.equal(readdirSync(dir).includes('session.repaired.jsonl.zstd'), false, 'no repair was even attempted')
    assert.equal(readFileSync(join(dir, 'writer.lock'), 'utf8').includes(`"pid":${child.pid}`), true, 'the foreign lock was not stolen')
  } finally {
    process.kill(child.pid, 'SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repairSessionLog: a clean verdict swaps nothing and releases the lock', async () => {
  const { dir, log } = logFixture('clean-run')
  const spawnFn = scriptedSpawn([procResult({ status: 0, stdout: 'rows: 3 | maxSeq: 2 | seq violations: 0\nverdict: CLEAN — nothing to do.' })])

  const result = await repairSessionLog(log, { spawnSyncFn: spawnFn })

  assert.deepEqual(result, { kind: 'clean' })
  assert.equal(readFileSync(log, 'utf8'), 'corrupt-zstd-bytes')
  assert.equal(readdirSync(dir).includes('session.jsonl.zstd.corrupt-bak'), false)
  assert.equal(readdirSync(dir).includes('writer.lock'), false, 'the lock is released on the clean path too')
  rmSync(dir, { recursive: true, force: true })
})

test('repairSessionLog: a throwing spawn seam fails without touching the log', async () => {
  const { dir, log } = logFixture('throw')
  const spawnFn = () => {
    throw new Error('boom')
  }

  const result = await repairSessionLog(log, { spawnSyncFn: spawnFn })

  assert.equal(result.kind, 'failed')
  assert.match(result.detail, /cannot run the repair script/)
  assert.match(result.detail, /boom/)
  assert.equal(readFileSync(log, 'utf8'), 'corrupt-zstd-bytes')
  assert.equal(readdirSync(dir).includes('writer.lock'), false, 'the lock is released even when the script never ran')
  rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------- locateSessionLog ----

test('locateSessionLog: derives the guarded path from the header cwd; compressed suffix wins', async () => {
  const root = tempDir('locate')
  const dir = join(root, projectKeyFor('/repo'), 'sid-1')
  mkdirSync(dir, { recursive: true })
  const persistence = { list: async () => [{ id: 'sid-1', cwd: '/repo' }] }

  const none = await locateSessionLog(persistence, 'sid-1', root)
  assert.equal(none, undefined, 'no log file under the derived dir → undefined, never a decoy')

  writeFileSync(join(dir, 'session.jsonl'), 'raw')
  const raw = await locateSessionLog(persistence, 'sid-1', root)
  assert.equal(raw, join(dir, 'session.jsonl'))

  writeFileSync(join(dir, 'session.jsonl.zstd'), 'zstd')
  const both = await locateSessionLog(persistence, 'sid-1', root)
  assert.equal(both, join(dir, 'session.jsonl.zstd'), 'the writer-appended compressed name wins when both exist')

  const missing = await locateSessionLog(persistence, 'sid-other', root)
  assert.equal(missing, undefined, 'an unknown session id has no header cwd')

  const noCwd = await locateSessionLog({ list: async () => [{ id: 'sid-1' }] }, 'sid-1', root)
  assert.equal(noCwd, undefined, 'a header without a cwd cannot ground the path')

  const broken = await locateSessionLog({ list: async () => { throw new Error('store gone') } }, 'sid-1', root)
  assert.equal(broken, undefined, 'a failing header list degrades to undefined')

  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------- fingerprints and notices ----

test('isCorruptLogError: only the corrupt-log fingerprint routes into repair', () => {
  assert.equal(isCorruptLogError('corrupt session log: seq gap in committed region (3 after 5)'), true)
  assert.equal(isCorruptLogError('CORRUPT ZSTANDARD LOG: bad frame checksum'), true)
  assert.equal(isCorruptLogError('unrecoverable: corrupt zstandard log tail'), true)
  assert.equal(isCorruptLogError('session is locked by a live process (pid 42) — refusing to fork the log'), false)
  assert.equal(isCorruptLogError('Session persistence is not configured in this profile.'), false)
  assert.equal(isCorruptLogError('cannot locate the log of sid-1 for read-only viewing'), false)
  assert.equal(isCorruptLogError(''), false)
})

test('repairFailureNotice: locked and failed name the blocker; repaired/clean proceed silently', () => {
  assert.equal(
    repairFailureNotice({ kind: 'locked', holder: { pid: 4242, createdAt: '', holder: 'feishu' } }),
    'session is driven by pid 4242 — close it on the other side first',
  )
  assert.equal(
    repairFailureNotice({ kind: 'failed', detail: 'zstd -dc failed' }),
    'repair failed: zstd -dc failed — log untouched',
  )
  assert.equal(repairFailureNotice({ kind: 'repaired', backupPath: '/x/bak' }), undefined)
  assert.equal(repairFailureNotice({ kind: 'clean' }), undefined)
})

// ------------------------------------------------- repair confirm dialog ----

test('repair dialog: Repair & resume is preselected; Enter confirms it directly', () => {
  const state = initialRepairConfirmState()
  assert.equal(state.selected, 0)
  assert.equal(REPAIR_CONFIRM_OPTIONS[0].title, 'Repair & resume')
  assert.equal(REPAIR_CONFIRM_OPTIONS[1].title, 'Cancel')
  const confirmed = updateRepairConfirm(state, ENTER)
  assert.equal(confirmed.settled, 'confirm')
  assert.equal(repairConfirmOutcome(confirmed), 'repair')
})

test('repair dialog: arrows and digits move between the two buttons, Enter confirms the highlight', () => {
  let state = updateRepairConfirm(initialRepairConfirmState(), DOWN)
  assert.equal(state.selected, 1, 'Cancel is one step down')
  state = updateRepairConfirm(state, DOWN)
  assert.equal(state.selected, 1, 'clamped at the last option')
  state = updateRepairConfirm(state, UP)
  assert.equal(state.selected, 0)
  state = updateRepairConfirm(state, UP)
  assert.equal(state.selected, 0, 'clamped at the first option')
  state = updateRepairConfirm(state, '2')
  assert.equal(state.selected, 1, 'digit selects without confirming')
  assert.equal(state.settled, undefined)
  assert.equal(repairConfirmOutcome(updateRepairConfirm(state, ENTER)), 'cancel')
  assert.equal(repairConfirmOutcome(updateRepairConfirm(initialRepairConfirmState(), '9')), undefined, 'out-of-range digits are ignored')
})

test('repair dialog: Esc cancels, and a settled dialog ignores later input', () => {
  const cancelled = updateRepairConfirm(initialRepairConfirmState(), ESC)
  assert.equal(cancelled.settled, 'cancel')
  assert.equal(repairConfirmOutcome(cancelled), undefined, 'cancel resolves no action')
  const frozen = updateRepairConfirm(cancelled, ENTER)
  assert.equal(frozen, cancelled, 'input after settle is a no-op')

  let confirmed = updateRepairConfirm(initialRepairConfirmState(), ENTER)
  confirmed = updateRepairConfirm(confirmed, ESC)
  assert.equal(confirmed.settled, 'confirm', 'a later Esc cannot overwrite the confirm')
})

// --------------------------------------------------- corrupt picker label ----

test('resumeRowTitle: ⚠ marks corrupt rows on both the preview and the header fallback', () => {
  const header = { id: 'abcd1234-0000', cwd: '/repo/x', createdAt: 1 }
  assert.equal(resumeRowTitle(header, 'hello world', false), 'hello world')
  assert.equal(resumeRowTitle(header, 'hello world', true), '⚠ hello world')
  assert.equal(resumeRowTitle(header, undefined, true), '⚠ x · abcd1234', 'the fallback label carries the marker too')
  assert.equal(resumeRowTitle(header, undefined, false), 'x · abcd1234')
})
