/**
 * src/preflight-projcache.ts — legacy session_projcache record migration.
 *
 * dsh 0.1.2-alpha.4 fail-fasts at boot when a session_projcache record lacks
 * identity.isSeeded / identity.inheritedEventCount. These tests pin the
 * backfill behavior: which records get fixed, which are left byte-identical,
 * backup + atomic-rewrite guarantees, --check reporting, and the
 * never-blocks-startup CLI contract (bin/preflight-projcache.mjs, the
 * launcher-side mount point of the shared core).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { preflightProjcache, projcacheSessionsDir } from '../lib/preflight-projcache.js'

const SCRIPT = fileURLToPath(new URL('../bin/preflight-projcache.mjs', import.meta.url))

function makeSessionsDir() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preflight-'))
  const sessions = path.join(home, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(sessions, { recursive: true })
  return { home, sessions }
}

function writeRecord(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content)
}

function readRecord(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8')
}

test('backfills both missing identity fields, preserving the rest', () => {
  const { sessions: dir } = makeSessionsDir()
  writeRecord(dir, 'session-legacy.json', JSON.stringify({
    identity: { createdAt: 1756000000000, cwd: '/tmp/work' },
    events: [{ seq: 1 }],
  }, null, 2))

  const { checked, fixed } = preflightProjcache(dir)
  assert.equal(checked, 1)
  assert.equal(fixed, 1)

  const record = JSON.parse(readRecord(dir, 'session-legacy.json'))
  assert.equal(record.identity.isSeeded, false)
  assert.equal(record.identity.inheritedEventCount, 0)
  assert.equal(record.identity.createdAt, 1756000000000)
  assert.equal(record.identity.cwd, '/tmp/work')
  assert.deepEqual(record.events, [{ seq: 1 }])
})

test('a record already carrying both fields is left byte-identical with no backup', () => {
  const { sessions: dir } = makeSessionsDir()
  const content = JSON.stringify({ identity: { isSeeded: true, inheritedEventCount: 7, createdAt: 1 } }, null, 2)
  writeRecord(dir, 'session-modern.json', content)
  const before = fs.readFileSync(path.join(dir, 'session-modern.json'))

  const { checked, fixed } = preflightProjcache(dir)
  assert.equal(checked, 1)
  assert.equal(fixed, 0)
  assert.ok(fs.readFileSync(path.join(dir, 'session-modern.json')).equals(before))
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('bak-preflight')), [])
})

test('only the actually-missing field is backfilled', () => {
  const { sessions: dir } = makeSessionsDir()
  writeRecord(dir, 'session-half.json', JSON.stringify({ identity: { isSeeded: true, createdAt: 5 } }, null, 2))

  preflightProjcache(dir)
  const record = JSON.parse(readRecord(dir, 'session-half.json'))
  assert.equal(record.identity.isSeeded, true)
  assert.equal(record.identity.inheritedEventCount, 0)
  assert.equal(record.identity.createdAt, 5)
})

test('a missing identity object is created holding just the two fields', () => {
  const { sessions: dir } = makeSessionsDir()
  writeRecord(dir, 'session-noid.json', JSON.stringify({ events: [] }, null, 2))

  preflightProjcache(dir)
  const record = JSON.parse(readRecord(dir, 'session-noid.json'))
  assert.deepEqual(record.identity, { isSeeded: false, inheritedEventCount: 0 })
  assert.deepEqual(record.events, [])
})

test('unparsable records are warned about on stderr and skipped, others still fixed', () => {
  const { home, sessions: dir } = makeSessionsDir()
  writeRecord(dir, 'session-broken.json', '{not json')
  writeRecord(dir, 'session-good.json', JSON.stringify({ identity: { createdAt: 1 } }, null, 2))

  const { checked, fixed } = preflightProjcache(dir)
  assert.equal(checked, 2)
  assert.equal(fixed, 1)
  assert.equal(readRecord(dir, 'session-broken.json'), '{not json')
  assert.equal(JSON.parse(readRecord(dir, 'session-good.json')).identity.isSeeded, false)

  const { stderr } = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  assert.ok(stderr.includes('unparsable session-broken.json'))
})

test('non-object identity roots are left untouched', () => {
  const { sessions: dir } = makeSessionsDir()
  writeRecord(dir, 'session-weird.json', JSON.stringify({ identity: 'legacy' }, null, 2))

  const { fixed } = preflightProjcache(dir)
  assert.equal(fixed, 0)
  assert.equal(readRecord(dir, 'session-weird.json'), JSON.stringify({ identity: 'legacy' }, null, 2))
})

test('each rewrite backs up the original bytes and preserves the trailing newline style', () => {
  const { sessions: dir } = makeSessionsDir()
  const withNewline = JSON.stringify({ identity: { createdAt: 1 } }, null, 2) + '\n'
  writeRecord(dir, 'session-nl.json', withNewline)
  writeRecord(dir, 'session-nonl.json', JSON.stringify({ identity: { createdAt: 2 } }, null, 2))

  preflightProjcache(dir)

  const backups = fs.readdirSync(dir).filter((n) => n.includes('bak-preflight')).sort()
  assert.equal(backups.length, 2)
  const nlBackup = backups.find((b) => b.startsWith('session-nl.json.bak-preflight-'))
  const nonlBackup = backups.find((b) => b.startsWith('session-nonl.json.bak'))
  assert.ok(nlBackup && nonlBackup)
  assert.equal(fs.readFileSync(path.join(dir, nlBackup), 'utf8'), withNewline)
  assert.equal(fs.readFileSync(path.join(dir, nonlBackup), 'utf8'), JSON.stringify({ identity: { createdAt: 2 } }, null, 2))
  assert.ok(readRecord(dir, 'session-nl.json').endsWith('\n'))
  assert.ok(!readRecord(dir, 'session-nonl.json').endsWith('\n'))
})

test('--check reports the count without touching anything', () => {
  const { home, sessions: dir } = makeSessionsDir()
  writeRecord(dir, 'session-legacy.json', JSON.stringify({ identity: { createdAt: 1 } }, null, 2))
  const before = fs.readFileSync(path.join(dir, 'session-legacy.json'))

  const { fixed } = preflightProjcache(dir, { check: true })
  assert.equal(fixed, 1)
  assert.ok(fs.readFileSync(path.join(dir, 'session-legacy.json')).equals(before))
  assert.deepEqual(fs.readdirSync(dir), ['session-legacy.json'])

  const run = spawnSync(process.execPath, [SCRIPT, '--check'], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  assert.equal(run.status, 0)
  assert.match(run.stdout, /1 session_projcache record\(s\) need migration/)
  assert.ok(fs.readFileSync(path.join(dir, 'session-legacy.json')).equals(before))
})

test('a missing sessions directory is a silent no-op', () => {
  const { home, sessions } = makeSessionsDir()
  fs.rmSync(sessions, { recursive: true })

  assert.deepEqual(preflightProjcache(sessions), { checked: 0, fixed: 0 })

  const run = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  assert.equal(run.status, 0)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr, '')
})

test('the CLI shell migrates records and always exits 0', () => {
  const { home, sessions } = makeSessionsDir()
  writeRecord(sessions, 'session-cli.json', JSON.stringify({ identity: { createdAt: 1 } }, null, 2))

  const run = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  assert.equal(run.status, 0)
  assert.equal(run.stderr, '')
  const record = JSON.parse(readRecord(sessions, 'session-cli.json'))
  assert.equal(record.identity.isSeeded, false)
  assert.equal(record.identity.inheritedEventCount, 0)
})

test('projcacheSessionsDir honors DSH_HOME and falls back to ~/.dsh', () => {
  const { home } = makeSessionsDir()
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    assert.equal(projcacheSessionsDir(), path.join(home, 'storages', 'session_projcache', 'sessions'))
    delete process.env.DSH_HOME
    assert.equal(
      projcacheSessionsDir(),
      path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions'),
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
