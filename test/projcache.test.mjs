/**
 * src/projcache.ts — the wrapper module the bundle patch mounts in place of
 * the stock session-projection-cache row (plain `dsh --profile tui` boots,
 * launcher or not). These tests pin the two guarantees that make the wrapper
 * safe: the migration runs at module-evaluation time (before the stock
 * plugin's Service.init could open the domain and fail-fast), and the
 * re-export surface is the stock module, byte for byte.
 *
 * The wrapper migrates <DSH_HOME||~/.dsh> at import, so this file pins
 * DSH_HOME to a scratch home before importing anything.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WRAPPER_URL = pathToFileURL(
  fileURLToPath(new URL('../lib/projcache.js', import.meta.url)),
).href

const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-projcache-test-'))
process.env.DSH_HOME = scratchHome

// Both imports are deferred until after DSH_HOME is pinned: importing the
// wrapper triggers the migration for real.
const wrapper = await import(WRAPPER_URL)
const stock = await import('@deepseek-ai/dsh-session-projection-cache')

function sessionsDirFor(home) {
  return path.join(home, 'storages', 'session_projcache', 'sessions')
}

function makeSessionsDir() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-projcache-e2e-'))
  const sessions = sessionsDirFor(home)
  fs.mkdirSync(sessions, { recursive: true })
  return { home, sessions }
}

function runChild(home) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(WRAPPER_URL)}); console.log('default:' + typeof m.default)`],
    { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' },
  )
}

test('importing the stock module directly stays untouched by this suite', () => {
  // Guards the fixture assumptions: the stock package resolves through the
  // dev closure and evaluates without side effects.
  assert.equal(typeof stock.SessionProjectionCache, 'function')
})

test('the wrapper re-exports the stock plugin unchanged', () => {
  assert.equal(wrapper.default, stock.default)
  assert.equal(wrapper.default, stock.SessionProjectionCache)
  assert.equal(wrapper.projectionCacheDomainSpec, stock.projectionCacheDomainSpec)
  assert.equal(wrapper.Config, stock.Config)
})

test('wrapper import backfills legacy records at module-evaluation time', () => {
  const { home, sessions } = makeSessionsDir()
  fs.writeFileSync(
    path.join(sessions, 'session-legacy.json'),
    JSON.stringify({ identity: { createdAt: 1756000000000, cwd: '/tmp/work' }, events: [{ seq: 1 }] }, null, 2),
  )

  const run = runChild(home)
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /default:function/)

  const record = JSON.parse(fs.readFileSync(path.join(sessions, 'session-legacy.json'), 'utf8'))
  assert.equal(record.identity.isSeeded, false)
  assert.equal(record.identity.inheritedEventCount, 0)
  assert.equal(record.identity.createdAt, 1756000000000)
  // The migration core's backups apply here too.
  assert.equal(fs.readdirSync(sessions).filter((n) => n.includes('bak-preflight')).length, 1)
})

test('wrapper import leaves modern records byte-identical', () => {
  const { home, sessions } = makeSessionsDir()
  const content = JSON.stringify(
    { identity: { isSeeded: true, inheritedEventCount: 7, createdAt: 1 } },
    null, 2,
  )
  fs.writeFileSync(path.join(sessions, 'session-modern.json'), content)

  const run = runChild(home)
  assert.equal(run.status, 0, run.stderr)
  assert.equal(fs.readFileSync(path.join(sessions, 'session-modern.json'), 'utf8'), content)
  assert.equal(fs.readdirSync(sessions).filter((n) => n.includes('bak-preflight')).length, 0)
})

test('wrapper import survives a missing sessions directory', () => {
  const { home } = makeSessionsDir()
  fs.rmSync(sessionsDirFor(home), { recursive: true })

  const run = runChild(home)
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /default:function/)
  assert.equal(run.stderr.includes('preflight'), false)
})
