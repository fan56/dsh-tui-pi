/**
 * Single-writer guard tests: the vendored pid-file lock plus its wiring into
 * the bridge's COLD arms (create / cold resume). The adopt arm must stay
 * lock-free — two surfaces sharing one process share one agent instance and
 * must never contend on a file. Every disk touch happens under
 * DSH_SESSION_ROOT pointed at a temp dir; the real ~/.dsh is never read,
 * never written.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshSessionBridge } from '../lib/session.js'
import {
  acquireWriterLock,
  projectKeyFor,
  releaseOwnedWriterLock,
  writerLockPath,
} from '../lib/writer-lock.js'

function tempRoot(name) {
  return mkdtempSync(join(tmpdir(), `tui-wlock-${name}-`))
}

function withSessionRoot(root, fn) {
  return async () => {
    process.env.DSH_SESSION_ROOT = root
    try {
      await fn()
    } finally {
      delete process.env.DSH_SESSION_ROOT
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function liveForeignPid() {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  return child.pid
}

async function deadPid() {
  const child = spawn('true')
  await new Promise(resolve => child.on('exit', resolve))
  return child.pid
}

// ---------------------------------------------------------------------------
// Lock module

test('projectKeyFor matches the upstream jsonl backend encoding', () => {
  // Separators collapse into single dashes; leading ones strip; ~..-- wrap.
  assert.equal(projectKeyFor('/home/alice/proj'), '--home-alice-proj--')
  // Non-safe characters escape as ~XXXX uppercase hex (space = 0x20).
  assert.equal(projectKeyFor('/a b'), '--a~0020b--')
})

test('acquire/release roundtrip; establishing owner may remove', async () => {
  const dir = tempRoot('roundtrip')
  assert.deepEqual(await acquireWriterLock(dir), { ok: true })
  const stored = JSON.parse(readFileSync(writerLockPath(dir), 'utf8'))
  assert.equal(stored.pid, process.pid)
  assert.equal(stored.holder, 'tui')
  await releaseOwnedWriterLock(dir)
  assert.equal(readdirSync(dir).includes('writer.lock'), false)
})

test('live foreign holder refuses with identity; nothing is stolen', async () => {
  const dir = tempRoot('foreign-live')
  const pid = liveForeignPid()
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(writerLockPath(dir), JSON.stringify({ pid, createdAt: '2026-08-27T00:00:00Z', holder: 'feishu' }))
    const result = await acquireWriterLock(dir)
    assert.notEqual(result.ok, true)
    if (!result.ok) {
      assert.equal(result.holder.pid, pid)
      assert.equal(result.holder.holder, 'feishu')
    }
    assert.equal(readdirSync(dir).filter(name => name.startsWith('writer.lock.stale-')).length, 0)
  } finally {
    process.kill(pid, 'SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dead holder is stolen aside and recreated', async () => {
  const dir = tempRoot('steal')
  const pid = await deadPid()
  mkdirSync(dir, { recursive: true })
  writeFileSync(writerLockPath(dir), JSON.stringify({ pid, createdAt: '', holder: 'feishu' }))
  assert.deepEqual(await acquireWriterLock(dir), { ok: true })
  assert.equal(JSON.parse(readFileSync(writerLockPath(dir), 'utf8')).pid, process.pid)
  assert.equal(readdirSync(dir).filter(name => name.startsWith('writer.lock.stale-')).length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('release without establish is a no-op', async () => {
  const dir = tempRoot('noop-release')
  mkdirSync(dir, { recursive: true })
  writeFileSync(writerLockPath(dir), JSON.stringify({ pid: process.pid + 1_000_000, createdAt: '', holder: 'other' }))
  await releaseOwnedWriterLock(dir)
  assert.equal(readdirSync(dir).includes('writer.lock'), true)
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Bridge cold-arm wiring

/**
 * Harness mirroring session-reconcile's minimal shape, plus whatever the
 * guard needs: an inspectable agents registry (get/resume/create with
 * capture), and an optional sessionPersistence seam.
 */
function makeGuardHarness({ headers = [] }) {
  const handlers = new Map()
  const calls = { resume: [], create: [], resumeThrows: null }
  const registryAgents = new Map()
  const ctx = {
    on(evt, fn) { handlers.set(evt, fn); return () => handlers.delete(evt) },
    get(key) {
      if (key === 'sessionPersistence') {
        return headers.length > 0 ? { list: async () => headers } : undefined
      }
      return undefined
    },
    agents: {
      get(id) { return registryAgents.get(String(id)) },
      async resume(options) {
        if (calls.resumeThrows !== null) throw calls.resumeThrows
        calls.resume.push(String(options.resumeSessionId))
        const agent = { session: { id: String(options.resumeSessionId) }, status: 'idle' }
        return { agent, disposed: false, async dispose() { this.disposed = true } }
      },
      async create(options) {
        calls.create.push(String(options.sessionId))
        const agent = { session: { id: String(options.sessionId) }, status: 'idle' }
        return { agent, disposed: false, async dispose() { this.disposed = true } }
      },
    },
    __registry: registryAgents,
    __calls: calls,
  }
  return { ctx, handlers, calls, registryAgents }
}

const noopCallbacks = { onLive: () => {}, onStatus: () => {}, onEvent: () => {} }

test(
  'cold resume is refused before any resume call when another live process drives the session',
  withSessionRoot(tempRoot('refuse'), async () => {
    const root = process.env.DSH_SESSION_ROOT
    const pid = liveForeignPid()
    try {
      const sessDir = join(root, '--home-alice-proj--', 'sess-locked')
      mkdirSync(sessDir, { recursive: true })
      writeFileSync(join(sessDir, 'writer.lock'), JSON.stringify({ pid, createdAt: '', holder: 'feishu' }))
      const h = makeGuardHarness({ headers: [{ id: 'sess-locked', cwd: '/home/alice/proj' }] })
      const bridge = new DshSessionBridge(h.ctx, noopCallbacks)
      await assert.rejects(
        () => bridge.resume('sess-locked'),
        /locked by a live process/,
      )
      assert.deepEqual(h.calls.resume, [], 'no second writer may even start loading')
    } finally {
      process.kill(pid, 'SIGKILL')
    }
  }),
)

test(
  'cold resume acquires the lock beside the log and releases it through handle.dispose',
  withSessionRoot(tempRoot('hold'), async () => {
    const root = process.env.DSH_SESSION_ROOT
    const h = makeGuardHarness({ headers: [{ id: 'sess-free', cwd: '/home/alice/proj' }] })
    const bridge = new DshSessionBridge(h.ctx, noopCallbacks)
    const handle = await bridge.resume('sess-free')
    assert.deepEqual(h.calls.resume, ['sess-free'])
    const lockFile = join(root, '--home-alice-proj--', 'sess-free', 'writer.lock')
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, process.pid)
    await handle.dispose()
    assert.equal(readdirSync(join(root, '--home-alice-proj--', 'sess-free')).includes('writer.lock'), false)
    await bridge.dispose()
  }),
)

test(
  'the adopt arm stays lock-free even when a foreign lock already exists',
  withSessionRoot(tempRoot('adopt'), async () => {
    const root = process.env.DSH_SESSION_ROOT
    const sessDir = join(root, '--home-alice-proj--', 'sess-live')
    mkdirSync(sessDir, { recursive: true })
    const pid = liveForeignPid()
    try {
      writeFileSync(join(sessDir, 'writer.lock'), JSON.stringify({ pid, createdAt: '', holder: 'feishu' }))
      const h = makeGuardHarness({ headers: [{ id: 'sess-live', cwd: '/home/alice/proj' }] })
      const foreignAgent = { session: { id: 'sess-live' }, status: 'running' }
      h.registryAgents.set('sess-live', foreignAgent)
      const bridge = new DshSessionBridge(h.ctx, noopCallbacks)
      const adopted = await bridge.resume('sess-live')
      assert.equal(adopted.agent, foreignAgent, 'attach shares the live instance')
      assert.deepEqual(h.calls.resume, [])
      // Foreign file untouched, no second lock anywhere.
      assert.equal(JSON.parse(readFileSync(join(sessDir, 'writer.lock'), 'utf8')).pid, pid)
    } finally {
      process.kill(pid, 'SIGKILL')
    }
  }),
)

test(
  'createSession guards the freshly minted id; disposal releases',
  withSessionRoot(tempRoot('create'), async () => {
    const root = process.env.DSH_SESSION_ROOT
    const h = makeGuardHarness({})
    const bridge = new DshSessionBridge(h.ctx, noopCallbacks)
    await bridge.ensureAgent()
    assert.equal(h.calls.create.length, 1)
    const createdId = h.calls.create[0]
    const sessDir = join(root, projectKeyFor(process.cwd()), createdId)
    assert.equal(JSON.parse(readFileSync(join(sessDir, 'writer.lock'), 'utf8')).pid, process.pid)
    // Bridge teardown goes through this.handle.dispose() — the lock rides it.
    await bridge.dispose()
    assert.equal(readdirSync(sessDir).includes('writer.lock'), false)
  }),
)
