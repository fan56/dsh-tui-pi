/**
 * Agent-runtime composition tests (src/agent-runtime.ts) — the pure layer
 * behind the /agents COMPOSED display and the workspace-scoped edit path.
 *
 * Contract under test:
 * - Composition (what a spawned agent gets): frontmatter baseline ⊕ the
 *   nearest pinned profile's per-agent overrides. A profile entry PRESENT
 *   overrides the baseline (absent keys inside the entry mean explicit
 *   inherit — they do NOT fall through to the baseline); an entry ABSENT for
 *   the agent leaves the baseline untouched. No pin, or a pin naming a
 *   profile that no longer exists, resolves to the baseline.
 * - Edit scoping: a workspace pinned to an existing profile commits model/
 *   think edits into that profile's per-agent overrides (model-profiles.json,
 *   frontmatter file byte-identical); no pin / unknown profile commits into
 *   the agent file's frontmatter (the document untouched).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  agentEditTarget,
  commitAgentModelEdit,
  composeAgentValuesFromDoc,
} from '../lib/agent-runtime.js'
import {
  PROFILE_PIN_FILE,
  findProfile,
  loadModelProfiles,
  modelProfilesPath,
  saveModelProfiles,
  seedModelProfilesDoc,
  writeProfilePin,
} from '../lib/model-profiles.js'

// ------------------------------------------------------------------ helpers --

/** Fresh isolated dsh-home directory per test. */
function tempDshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-agent-runtime-'))
  mkdirSync(join(dir, 'agents'), { recursive: true })
  return {
    dir,
    home: dir,
    docPath: join(dir, 'model-profiles.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** A seeded doc with the `work` profile's agents replaced by `overrides`. */
function docWithAgents(overrides) {
  const doc = seedModelProfilesDoc()
  const work = findProfile(doc, 'work')
  work.agents = overrides
  return doc
}

/** Write a .dsh-profile pin naming `profile` into `dir`. */
function pinEditor(dir, profile) {
  const error = writeProfilePin(dir, profile)
  assert.equal(error, undefined)
  return join(dir, PROFILE_PIN_FILE)
}

// --------------------------------------------------------------- composition --

test('composition: no pin → the frontmatter baseline untouched', () => {
  const { home: home, cleanup } = tempDshHome()
  try {
    const doc = docWithAgents({ oldfox: { model: 'volc-ark-plan/glm-5.3' } })
    const base = { model: 'baseline/m1', thinking: 'high' }
    // startDir = a fresh dir with no pin anywhere up the tree? mkdtemp is
    // under /tmp — an ancestor pin is unlikely but possible; pin the SAME
    // dir to nothing by using an empty doc instead.
    const values = composeAgentValuesFromDoc('oldfox', base, doc, home)
    assert.deepEqual(values, base)
  } finally {
    cleanup()
  }
})

test('composition: pinned profile entry overrides the baseline', () => {
  const { home, cleanup } = tempDshHome()
  try {
    pinEditor(home, 'work')
    const doc = docWithAgents({ oldfox: { model: 'work/p-m2', thinking: 'medium' } })
    const values = composeAgentValuesFromDoc('oldfox', { model: 'baseline/m1', thinking: 'high' }, doc, home)
    assert.deepEqual(values, { model: 'work/p-m2', thinking: 'medium' })
  } finally {
    cleanup()
  }
})

test('composition: an ABSENT entry leaves the baseline untouched', () => {
  const { home, cleanup } = tempDshHome()
  try {
    pinEditor(home, 'work')
    const doc = docWithAgents({ other: { model: 'work/p-m2' } })
    const base = { model: 'baseline/m1', thinking: 'high' }
    assert.deepEqual(composeAgentValuesFromDoc('oldfox', base, doc, home), base)
  } finally {
    cleanup()
  }
})

test('composition: absent recorded keys fall back to the baseline (registry semantics)', () => {
  const { home, cleanup } = tempDshHome()
  try {
    pinEditor(home, 'work')
    // Only model recorded: thinking falls back to the BASELINE.
    const doc = docWithAgents({ oldfox: { model: 'work/p-m2' } })
    assert.deepEqual(
      composeAgentValuesFromDoc('oldfox', { model: 'baseline/m1', thinking: 'high' }, doc, home),
      { model: 'work/p-m2', thinking: 'high' },
    )
    // EMPTY entry (saved-inherit) leaves both baseline values in place.
    const emptyDoc = docWithAgents({ oldfox: {} })
    assert.deepEqual(
      composeAgentValuesFromDoc('oldfox', { model: 'baseline/m1', thinking: 'high' }, emptyDoc, home),
      { model: 'baseline/m1', thinking: 'high' },
    )
  } finally {
    cleanup()
  }
})

test('composition: an unlisted thinking effort id is dropped, baseline wins', () => {
  const { home, cleanup } = tempDshHome()
  try {
    pinEditor(home, 'work')
    const doc = docWithAgents({ oldfox: { model: 'work/p-m2', thinking: 'ultra' } })
    assert.deepEqual(
      composeAgentValuesFromDoc('oldfox', { model: 'baseline/m1', thinking: 'high' }, doc, home),
      { model: 'work/p-m2', thinking: 'high' },
    )
    const baseDoc = seedModelProfilesDoc()
    assert.deepEqual(
      composeAgentValuesFromDoc('oldfox', { model: 'baseline/m1', thinking: 'ultra' }, baseDoc, home),
      { model: 'baseline/m1' },
    )
  } finally {
    cleanup()
  }
})

test('composition: baseline values may be null (frontmatter key absent)', () => {
  const { home, cleanup } = tempDshHome()
  try {
    const doc = seedModelProfilesDoc()
    assert.deepEqual(composeAgentValuesFromDoc('oldfox', { model: null, thinking: null }, doc, home), {})
    assert.deepEqual(
      composeAgentValuesFromDoc('oldfox', { model: 'baseline/m1', thinking: null }, doc, home),
      { model: 'baseline/m1' },
    )
  } finally {
    cleanup()
  }
})

test('composition: a pin naming a deleted profile resolves to the baseline', () => {
  const { home, cleanup } = tempDshHome()
  try {
    pinEditor(home, 'ghost')
    const doc = docWithAgents({ oldfox: { model: 'work/p-m2' } })
    const base = { model: 'baseline/m1', thinking: 'high' }
    assert.deepEqual(composeAgentValuesFromDoc('oldfox', base, doc, home), base)
  } finally {
    cleanup()
  }
})

test('composition: nearest pin wins (subdir overrides the parent)', () => {
  const { home, cleanup } = tempDshHome()
  try {
    const sub = join(home, 'proj')
    mkdirSync(sub, { recursive: true })
    pinEditor(home, 'work')          // parent pin
    pinEditor(sub, 'personal')       // nearer pin wins
    const doc = seedModelProfilesDoc()
    const personal = findProfile(doc, 'personal')
    personal.agents = { oldfox: { model: 'personal/p-m3' } }
    assert.deepEqual(
      composeAgentValuesFromDoc('oldfox', { model: 'baseline/m1' }, doc, sub),
      { model: 'personal/p-m3' },
    )
  } finally {
    cleanup()
  }
})

// --------------------------------------------------------------- edit target --

test('agentEditTarget: no pin → frontmatter baseline path', () => {
  const { home, cleanup } = tempDshHome()
  try {
    assert.deepEqual(agentEditTarget({ startDir: home, home }), { kind: 'frontmatter' })
  } finally {
    cleanup()
  }
})

test('agentEditTarget: pinned to an existing profile → profile overrides', () => {
  const { home, cleanup } = tempDshHome()
  try {
    pinEditor(home, 'work')
    assert.deepEqual(agentEditTarget({ startDir: home, home }), { kind: 'profile', name: 'work' })
  } finally {
    cleanup()
  }
})

test('agentEditTarget: pinned to a deleted profile → frontmatter baseline path', () => {
  const { home, cleanup } = tempDshHome()
  try {
    pinEditor(home, 'ghost')
    assert.deepEqual(agentEditTarget({ startDir: home, home }), { kind: 'frontmatter' })
  } finally {
    cleanup()
  }
})

// ------------------------------------------------------------------- commit --

test('commitAgentModelEdit: pinned workspace writes the profile override, frontmatter untouched', () => {
  const { home, docPath, cleanup } = tempDshHome()
  try {
    pinEditor(home, 'work')
    const doc = docWithAgents({})
    assert.equal(saveModelProfiles(docPath, doc), undefined)
    const agentFile = join(home, 'agents', 'oldfox.md')
    writeFileSync(agentFile, [
      '---', 'name: oldfox', 'model: baseline/m1', 'thinking: high', '---', '', 'prompt',
    ].join('\n'))
    const before = readFileSync(agentFile, 'utf8')

    const result = commitAgentModelEdit('oldfox', agentFile, { model: 'work/p-m2', thinking: 'medium' }, { startDir: home, home })
    assert.deepEqual(result, { target: { kind: 'profile', name: 'work' } })

    const reloaded = loadModelProfiles(docPath)
    const entry = findProfile(reloaded, 'work').agents['oldfox']
    assert.deepEqual(entry, { model: 'work/p-m2', thinking: 'medium' })
    assert.equal(readFileSync(agentFile, 'utf8'), before, 'frontmatter file byte-identical')
  } finally {
    cleanup()
  }
})

test('commitAgentModelEdit: unpinned workspace writes the frontmatter, doc untouched', () => {
  const { home, docPath, cleanup } = tempDshHome()
  try {
    const doc = docWithAgents({})
    assert.equal(saveModelProfiles(docPath, doc), undefined)
    const before = readFileSync(docPath, 'utf8')
    const agentFile = join(home, 'agents', 'oldfox.md')
    writeFileSync(agentFile, '---\nname: oldfox\n---\n\nprompt\n')

    const result = commitAgentModelEdit('oldfox', agentFile, { model: 'baseline/m1', thinking: null }, { startDir: home, home })
    assert.deepEqual(result, { target: { kind: 'frontmatter' } })

    const text = readFileSync(agentFile, 'utf8')
    assert.ok(text.includes('model: baseline/m1'), `model line written (${text})`)
    assert.ok(!text.includes('thinking:'), 'thinking null removes the line')
    assert.equal(readFileSync(docPath, 'utf8'), before, 'model-profiles.json untouched')
  } finally {
    cleanup()
  }
})

test('commitAgentModelEdit: a null thinking in profile scope removes the recorded key', () => {
  const { home, docPath, cleanup } = tempDshHome()
  try {
    pinEditor(home, 'work')
    const doc = docWithAgents({ oldfox: { model: 'work/p-m2', thinking: 'medium' } })
    assert.equal(saveModelProfiles(docPath, doc), undefined)
    const agentFile = join(home, 'agents', 'oldfox.md')
    writeFileSync(agentFile, '---\nname: oldfox\nmodel: baseline/m1\n---\n\nprompt\n')

    const result = commitAgentModelEdit('oldfox', agentFile, { thinking: null }, { startDir: home, home })
    assert.deepEqual(result, { target: { kind: 'profile', name: 'work' } })
    const reloaded = loadModelProfiles(docPath)
    assert.deepEqual(findProfile(reloaded, 'work').agents['oldfox'], { model: 'work/p-m2' })
  } finally {
    cleanup()
  }
})

test('commitAgentModelEdit: a missing agent file on the frontmatter path throws (unchanged updateAgentFrontmatter semantics)', () => {
  const { home, cleanup } = tempDshHome()
  try {
    assert.throws(
      () => commitAgentModelEdit('oldfox', join(home, 'agents', 'missing.md'), { model: 'x/y' }, { startDir: home, home }),
      /ENOENT/,
    )
  } finally {
    cleanup()
  }
})

test('commitAgentModelEdit: the doc directory is created when pinned and the store is absent', () => {
  const { home, docPath, cleanup } = tempDshHome()
  try {
    pinEditor(home, 'work')
    const agentFile = join(home, 'agents', 'oldfox.md')
    writeFileSync(agentFile, '---\nname: oldfox\n---\n\nprompt\n')
    const result = commitAgentModelEdit('oldfox', agentFile, { model: 'work/p-m2' }, { startDir: home, home })
    assert.deepEqual(result, { target: { kind: 'profile', name: 'work' } })
    assert.ok(existsSync(docPath), 'store created')
    assert.deepEqual(loadModelProfiles(docPath).profiles[0].agents['oldfox'], { model: 'work/p-m2' })
  } finally {
    cleanup()
  }
})
