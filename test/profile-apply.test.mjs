/**
 * applyProfile tests (src/profile.ts) — the /profile-switch apply path.
 *
 * The 2026-09 regression contract under test: applying a profile sets the
 * live selection, binds the workspace tree (.dsh-profile) and saves the
 * store — but writes NOTHING to the agent markdown files. Agent model/
 * thinking values compose per-workspace at spawn (src/agent-runtime.ts),
 * which is what makes a switch scoped to the tree.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { applyProfile } from '../lib/profile.js'
import {
  PROFILE_PIN_FILE,
  findProfile,
  loadModelProfiles,
  saveModelProfiles,
  seedModelProfilesDoc,
} from '../lib/model-profiles.js'

// ------------------------------------------------------------------ helpers --

/** Fresh isolated dsh-home + workspace pair per test. */
function tempEnv() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tui-profile-apply-'))
  const home = join(root, 'home')
  const cwd = join(root, 'worktree')
  mkdirSync(join(home, 'agents'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return {
    root,
    home,
    cwd,
    docPath: join(home, 'model-profiles.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** A work profile carrying a default route + one agent override. */
function workProfile(doc) {
  const profile = findProfile(doc, 'work')
  profile.defaultModel = { provider: 'volc-ark-plan', model: 'glm-5.3', reasoningEffort: 'high' }
  profile.agents = { oldfox: { model: 'volc-ark-plan/glm-4.5', thinking: 'medium' } }
  return profile
}

// --------------------------------------------------------------------- tests --

test('applyProfile: sets the live selection, pins the tree, saves the store — and does NOT touch agent frontmatter', async () => {
  const { home, cwd, docPath, cleanup } = tempEnv()
  try {
    const agentFile = join(home, 'agents', 'oldfox.md')
    const before = [
      '---', 'name: oldfox', 'model: baseline/m1', 'thinking: high', '---', '', 'You are the fox.',
    ].join('\n')
    writeFileSync(agentFile, before)

    const doc = seedModelProfilesDoc()
    const profile = workProfile(doc)
    const selections = []
    const deps = { getSelection: () => undefined, setSelection: selection => selections.push(selection) }

    const summary = await applyProfile(docPath, doc, profile, deps, cwd)

    // The one regression: frontmatter untouched.
    assert.equal(readFileSync(agentFile, 'utf8'), before, 'agent frontmatter byte-identical')
    // Still: live selection, tree binding, store save all happen.
    assert.deepEqual(selections, [{ provider: 'volc-ark-plan', model: 'glm-5.3', reasoningEffort: 'high' }])
    assert.ok(existsSync(join(cwd, PROFILE_PIN_FILE)), '.dsh-profile pin written')
    assert.equal(readFileSync(join(cwd, PROFILE_PIN_FILE), 'utf8').trim(), 'work')
    const reloaded = loadModelProfiles(docPath)
    assert.equal(reloaded.current, 'work')
    assert.deepEqual(findProfile(reloaded, 'work').agents['oldfox'], { model: 'volc-ark-plan/glm-4.5', thinking: 'medium' })
    // Summary wording carries the new scope claim, not an agent-count update.
    assert.ok(summary.includes('Profile → work'), summary)
    assert.ok(summary.includes('per-workspace'), summary)
    assert.ok(summary.includes(PROFILE_PIN_FILE), summary)
    assert.ok(!summary.includes('updated'), `no agents-updated claim (${summary})`)
  } finally {
    cleanup()
  }
})

test('applyProfile: a profile without a default model leaves the live selection alone', async () => {
  const { home, cwd, docPath, cleanup } = tempEnv()
  try {
    const doc = seedModelProfilesDoc()
    const profile = findProfile(doc, 'work')
    profile.agents = {}
    const selections = []
    const deps = { getSelection: () => undefined, setSelection: selection => selections.push(selection) }

    const summary = await applyProfile(docPath, doc, profile, deps, cwd)

    assert.deepEqual(selections, [])
    assert.ok(summary.includes('model unchanged'), summary)
    assert.ok(existsSync(join(cwd, PROFILE_PIN_FILE)), 'pin still written')
  } finally {
    cleanup()
  }
})

test('applyProfile: a hand-decorated pin is refused and surfaced, the rest still applies', async () => {
  const { home, cwd, docPath, cleanup } = tempEnv()
  try {
    writeFileSync(join(cwd, PROFILE_PIN_FILE), '# my pin\nwork\nextra line\n')
    const doc = seedModelProfilesDoc()
    const profile = workProfile(doc)
    const deps = { getSelection: () => undefined, setSelection: () => {} }

    const summary = await applyProfile(docPath, doc, profile, deps, cwd)

    assert.ok(summary.includes('⚠'), summary)
    assert.ok(summary.includes('refusing to overwrite'), summary)
    // The refuse never clobbers the hand-decorated file.
    assert.equal(readFileSync(join(cwd, PROFILE_PIN_FILE), 'utf8'), '# my pin\nwork\nextra line\n')
    // The store save is unaffected.
    assert.equal(loadModelProfiles(docPath).current, 'work')
  } finally {
    cleanup()
  }
})

test('applyProfile: an ancestor pin is overridden by the switch, reported in the summary', async () => {
  const { home, cwd, docPath, cleanup } = tempEnv()
  try {
    // Ancestor of cwd: cwd is root/worktree, write pin into root.
    writeFileSync(join(tempEnvRoot(cwd), PROFILE_PIN_FILE), 'personal\n')
    const doc = seedModelProfilesDoc()
    const profile = workProfile(doc)
    const deps = { getSelection: () => undefined, setSelection: () => {} }

    const summary = await applyProfile(docPath, doc, profile, deps, cwd)

    assert.ok(summary.includes('overrides ancestor pin "personal"'), summary)
    assert.equal(readFileSync(join(cwd, PROFILE_PIN_FILE), 'utf8').trim(), 'work')
  } finally {
    cleanup()
  }
})

/** The parent directory of `dir` (the ancestor pin location in the test). */
function tempEnvRoot(dir) {
  const parent = join(dir, '..')
  return parent
}
