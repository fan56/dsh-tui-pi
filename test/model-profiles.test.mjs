/**
 * Model-profile storage tests (src/model-profiles.ts) — the pure layer
 * behind /profile + /profiles.
 *
 * Contract under test:
 * - Reads never throw: missing / corrupt / wrong-version / empty documents
 *   degrade to the seeded defaults (work / personal / other); good entries
 *   survive beside bad ones; duplicate names (case-insensitive) keep the
 *   first occurrence; a `current` pointing at a dropped profile is unset.
 * - Writes are atomic: success leaves no tmp sibling and creates the
 *   directory when missing; a failing write resolves an error message
 *   instead of throwing.
 * - Name ops: create / rename / delete validate uniqueness
 *   (case-insensitive), keep the `current` pointer consistent and refuse to
 *   delete the last profile.
 * - Snapshot semantics: capture records every agent (inherit ones as EMPTY
 *   entries — at compose the baseline still applies). The effective-value
 *   compose path itself lives in agent-runtime.ts (registry contract); the
 *   pure store layer plans no agent-file writes.
 * - Workspace binding: bindWorkspaceProfile writes a fresh pin and rebinds a
 *   clean one but refuses a hand-decorated file (same guard as
 *   removeProfilePin); boundProfileName resolves the nearest pin through the
 *   doc — the ● current display — and stays undefined for unknown names.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DEFAULT_PROFILE_NAMES,
  MODEL_PROFILES_VERSION,
  PROFILE_PIN_FILE,
  bindWorkspaceProfile,
  boundProfileName,
  captureAgentsSnapshot,
  createProfile,
  deleteProfile,
  findProfile,
  formatProfileRoute,
  loadModelProfiles,
  modelProfilesPath,
  normalizeModelProfiles,
  normalizeProfileName,
  parseProfilePinText,
  profileReviewLines,
  readNearestProfilePin,
  removeProfilePin,
  renameProfile,
  resolvePinnedProfile,
  saveModelProfiles,
  seedModelProfilesDoc,
  writeProfilePin,
} from '../lib/model-profiles.js'

// ------------------------------------------------------------------ helpers --

/** Fresh isolated directory per test; caller cleans up via the returned fn. */
function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-profiles-test-'))
  return {
    dir,
    path: join(dir, 'model-profiles.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Minimal AgentFile stand-in — only meta.name/model/thinking matter here. */
function agentFile(name, model, thinking) {
  return {
    path: `/agents/${name}.md`,
    meta: { name, deep: 1, ...(model !== undefined ? { model } : {}), ...(thinking !== undefined ? { thinking } : {}) },
    body: 'prompt',
  }
}

// -------------------------------------------------------------------- seeds --

test('seed document carries the three default profiles, unconfigured', () => {
  const doc = seedModelProfilesDoc()
  assert.deepEqual(doc.profiles.map(p => p.name), [...DEFAULT_PROFILE_NAMES])
  assert.equal(doc.current, undefined)
  for (const profile of doc.profiles) {
    assert.equal(profile.defaultModel, undefined)
    assert.deepEqual(profile.agents, {})
  }
})

test('modelProfilesPath joins the dsh home with the store file name', () => {
  assert.equal(modelProfilesPath('/tmp/home'), '/tmp/home/model-profiles.json')
})

// --------------------------------------------------------------------- load --

test('loadModelProfiles: missing file degrades to the seeded document', () => {
  const { path, cleanup } = tempStore()
  try {
    assert.deepEqual(loadModelProfiles(path), seedModelProfilesDoc())
  } finally {
    cleanup()
  }
})

test('loadModelProfiles: corrupt JSON degrades to the seeded document', () => {
  const { path, cleanup } = tempStore()
  try {
    writeFileSync(path, '{not json')
    assert.deepEqual(loadModelProfiles(path), seedModelProfilesDoc())
  } finally {
    cleanup()
  }
})

test('loadModelProfiles: wrong version degrades to the seeded document', () => {
  const { path, cleanup } = tempStore()
  try {
    writeFileSync(path, JSON.stringify({ version: 99, profiles: [{ name: 'x', agents: {} }] }))
    assert.deepEqual(loadModelProfiles(path), seedModelProfilesDoc())
  } finally {
    cleanup()
  }
})

test('loadModelProfiles: empty or non-array profiles re-seed the defaults', () => {
  const { path, cleanup } = tempStore()
  try {
    writeFileSync(path, JSON.stringify({ version: MODEL_PROFILES_VERSION, profiles: [] }))
    assert.deepEqual(loadModelProfiles(path), seedModelProfilesDoc())
    writeFileSync(path, JSON.stringify({ version: MODEL_PROFILES_VERSION, profiles: 'nope' }))
    assert.deepEqual(loadModelProfiles(path), seedModelProfilesDoc())
  } finally {
    cleanup()
  }
})

test('normalizeModelProfiles: good profiles survive beside invalid ones', () => {
  const doc = normalizeModelProfiles({
    version: MODEL_PROFILES_VERSION,
    current: 'work',
    profiles: [
      { name: 'work', defaultModel: { provider: 'p', model: 'm', reasoningEffort: 'high' }, agents: {} },
      'garbage',
      { agents: {} }, // no name → dropped
      { name: '', agents: {} }, // empty name → dropped
      { name: 'personal', agents: { duck: { model: 'q/r' }, bad: 'nope', ghost: { model: 7, thinking: 'low' } } },
    ],
  })
  assert.deepEqual(doc.profiles.map(p => p.name), ['work', 'personal'])
  assert.equal(doc.current, 'work')
  assert.deepEqual(doc.profiles[0].defaultModel, { provider: 'p', model: 'm', reasoningEffort: 'high' })
  // A wholly-invalid entry value drops the agent; a valid-but-partial one keeps the good keys.
  assert.deepEqual(doc.profiles[1].agents, { duck: { model: 'q/r' }, ghost: { thinking: 'low' } })
})

test('normalizeModelProfiles: duplicate names keep the first occurrence', () => {
  const doc = normalizeModelProfiles({
    version: MODEL_PROFILES_VERSION,
    profiles: [
      { name: 'Work', agents: {} },
      { name: 'work', agents: { duck: {} } },
    ],
  })
  assert.equal(doc.profiles.length, 1)
  assert.equal(doc.profiles[0].name, 'Work')
  assert.deepEqual(doc.profiles[0].agents, {})
})

test('normalizeModelProfiles: a current pointing at a dropped profile is unset', () => {
  const doc = normalizeModelProfiles({
    version: MODEL_PROFILES_VERSION,
    current: 'ghost',
    profiles: [{ name: 'work', agents: {} }],
  })
  assert.equal(doc.current, undefined)
})

test('normalizeModelProfiles: empty agent entries are kept (explicit inherit)', () => {
  const doc = normalizeModelProfiles({
    version: MODEL_PROFILES_VERSION,
    profiles: [{ name: 'work', agents: { duck: {} } }],
  })
  assert.deepEqual(doc.profiles[0].agents, { duck: {} })
})

// --------------------------------------------------------------------- save --

test('saveModelProfiles round-trips through loadModelProfiles', () => {
  const { path, cleanup } = tempStore()
  try {
    const doc = seedModelProfilesDoc()
    doc.profiles[0].defaultModel = { provider: 'p', model: 'm', reasoningEffort: 'high' }
    doc.profiles[0].agents = { duck: { model: 'q/r', thinking: 'low' } }
    doc.current = 'work'
    assert.equal(saveModelProfiles(path, doc), undefined)
    assert.deepEqual(loadModelProfiles(path), doc)
  } finally {
    cleanup()
  }
})

test('saveModelProfiles creates the directory when missing and leaves no tmp sibling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-profiles-nested-'))
  const path = join(dir, 'deep', 'model-profiles.json')
  try {
    assert.equal(saveModelProfiles(path, seedModelProfilesDoc()), undefined)
    assert.deepEqual(readdirSync(join(dir, 'deep')), ['model-profiles.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveModelProfiles resolves an error message instead of throwing on failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-profiles-fail-'))
  const path = join(dir, 'model-profiles.json')
  try {
    mkdirSync(path) // a directory where the file should be → write fails
    const error = saveModelProfiles(path, seedModelProfilesDoc())
    assert.equal(typeof error, 'string')
    assert.notEqual(error, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- name ops --

test('findProfile matches names case-insensitively and ignores surrounding blanks', () => {
  const doc = seedModelProfilesDoc()
  assert.equal(findProfile(doc, '  WORK ')?.name, 'work')
  assert.equal(findProfile(doc, 'nope'), undefined)
})

test('normalizeProfileName trims and rejects empty input', () => {
  assert.equal(normalizeProfileName('  work '), 'work')
  assert.equal(normalizeProfileName('   '), undefined)
})

test('createProfile appends an empty profile and rejects taken or empty names', () => {
  const doc = seedModelProfilesDoc()
  const { profile } = createProfile(doc, 'lab')
  assert.equal(profile?.name, 'lab')
  assert.deepEqual(profile?.agents, {})
  assert.equal(doc.profiles.length, 4)
  assert.match(createProfile(doc, 'lab').error ?? '', /already exists/)
  assert.match(createProfile(doc, ' PERSONAL ').error ?? '', /already exists/)
  assert.match(createProfile(doc, '  ').error ?? '', /must not be empty/)
})

test('renameProfile keeps the current pointer and rejects collisions', () => {
  const doc = seedModelProfilesDoc()
  doc.current = 'work'
  assert.equal(renameProfile(doc, 'work', 'job'), undefined)
  assert.equal(doc.profiles[0].name, 'job')
  assert.equal(doc.current, 'job')
  assert.equal(renameProfile(doc, 'job', 'job '), undefined) // self-trim is fine
  assert.match(renameProfile(doc, 'job', 'personal') ?? '', /already exists/)
  assert.match(renameProfile(doc, 'ghost', 'x') ?? '', /no profile named/)
  assert.match(renameProfile(doc, 'personal', ' ') ?? '', /must not be empty/)
})

test('deleteProfile removes the profile, clears a dangling current and refuses the last one', () => {
  const doc = seedModelProfilesDoc()
  doc.current = 'personal'
  assert.equal(deleteProfile(doc, 'personal'), undefined)
  assert.equal(doc.current, undefined)
  assert.equal(doc.profiles.length, 2)
  assert.match(deleteProfile(doc, 'ghost') ?? '', /no profile named/)
  deleteProfile(doc, 'work')
  deleteProfile(doc, 'other')
  assert.match(deleteProfile(doc, 'other') ?? '', /last profile/)
})

// ------------------------------------------------------- snapshot + apply --

test('captureAgentsSnapshot records overrides and keeps inherit agents as empty entries', () => {
  const snapshot = captureAgentsSnapshot([
    agentFile('workhorse', 'p/m', 'high'),
    agentFile('duck'),
  ])
  assert.deepEqual(snapshot, { workhorse: { model: 'p/m', thinking: 'high' }, duck: {} })
})

// ----------------------------------------------------------------- display --

test('formatProfileRoute renders unset, plain and think-suffixed routes', () => {
  assert.equal(formatProfileRoute(undefined), '(not set)')
  assert.equal(formatProfileRoute(undefined, 'keep'), 'keep')
  assert.equal(formatProfileRoute({ provider: 'p', model: 'm' }), 'p/m')
  assert.equal(formatProfileRoute({ provider: 'p', model: 'm', reasoningEffort: 'high' }), 'p/m · think high')
})

test('profileReviewLines lists the default model, every discovered agent and stale entries', () => {
  const profile = seedModelProfilesDoc().profiles[0]
  profile.defaultModel = { provider: 'p', model: 'm', reasoningEffort: 'high' }
  profile.agents = {
    workhorse: { model: 'q/r', thinking: 'low' },
    duck: {},
    ghost: { model: 'x/y' },
  }
  const lines = profileReviewLines(profile, [agentFile('workhorse', 'a/b'), agentFile('duck'), agentFile('newcomer')], true)
  const text = lines.join('\n')
  assert.match(lines[0], /Profile: work/)
  assert.match(lines[0], /current/)
  assert.match(text, /Default model: p\/m · think high/)
  assert.match(text, /workhorse .* q\/r · think low/)
  assert.match(text, /duck .* \(inherit\) · inherit/)
  // A discovered agent the profile never recorded is called out, not faked.
  assert.match(text, /newcomer.*not saved/)
  // A recorded agent whose file disappeared is marked.
  assert.match(text, /ghost \(file missing\)/)
})

test('profileReviewLines hints at capture when nothing is recorded', () => {
  const profile = seedModelProfilesDoc().profiles[0]
  const lines = profileReviewLines(profile, [])
  assert.match(lines.join('\n'), /none recorded/)
})

// --------------------------------------------------------- end-to-end disk --

test('a captured snapshot saved and reloaded keeps the recorded agents', () => {
  const { path, cleanup } = tempStore()
  try {
    const doc = seedModelProfilesDoc()
    const profile = doc.profiles[0]
    profile.defaultModel = { provider: 'p', model: 'm' }
    profile.agents = captureAgentsSnapshot([agentFile('workhorse', 'a/b', 'high'), agentFile('duck')])
    saveModelProfiles(path, doc)

    const reloaded = loadModelProfiles(path)
    const reloadedProfile = findProfile(reloaded, 'work')
    assert.deepEqual(reloadedProfile?.agents, profile.agents)
    // The raw document stays a small, versioned, human-readable JSON file.
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(raw.version, MODEL_PROFILES_VERSION)
  } finally {
    cleanup()
  }
})

// ------------------------------------------------------------ directory pin --

test('parseProfilePinText: first usable line wins, comments and blanks skipped', () => {
  assert.deepEqual(parseProfilePinText('work\n'), { name: 'work' })
  assert.deepEqual(parseProfilePinText('\n# a comment\n  personal  \n'), { name: 'personal' })
  assert.match(parseProfilePinText('# only comments\n').error ?? '', /no profile name/)
  assert.match(parseProfilePinText('').error ?? '', /no profile name/)
})

test('writeProfilePin + readNearestProfilePin: nearest file up the tree wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pin-'))
  const child = join(dir, 'sub', 'deep')
  mkdirSync(child, { recursive: true })
  try {
    assert.equal(readNearestProfilePin(child), undefined) // nothing anywhere
    writeProfilePin(dir, 'work')
    const fromRoot = readNearestProfilePin(dir)
    assert.equal(fromRoot?.name, 'work')
    assert.equal(fromRoot?.path, join(dir, PROFILE_PIN_FILE))
    // A pin added in an ancestor is visible to deeper start dirs immediately
    // (no memo — hand edits take effect on the next session).
    assert.equal(readNearestProfilePin(child)?.name, 'work')
    // A deeper file overrides the parent's.
    writeProfilePin(child, 'personal')
    const deep = readNearestProfilePin(child)
    assert.equal(deep?.name, 'personal')
    assert.equal(deep?.path, join(child, PROFILE_PIN_FILE))
    // And removing it falls through to the ancestor's pin again.
    assert.equal(removeProfilePin(child, 'personal'), undefined)
    assert.equal(readNearestProfilePin(child)?.name, 'work')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readNearestProfilePin tolerates an unreadable or garbage pin file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pin-bad-'))
  try {
    writeFileSync(join(dir, PROFILE_PIN_FILE), '\n   \n# just a comment\n')
    assert.equal(readNearestProfilePin(dir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolvePinnedProfile returns the named profile, undefined when unknown/unbound', () => {
  const doc = seedModelProfilesDoc()
  findProfile(doc, 'work').defaultModel = { provider: 'p', model: 'm' }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pin-res-'))
  try {
    assert.equal(resolvePinnedProfile(doc, dir), undefined)
    writeProfilePin(dir, 'work')
    assert.equal(resolvePinnedProfile(doc, dir)?.name, 'work')
    writeProfilePin(dir, 'ghost') // profile no longer exists
    assert.equal(resolvePinnedProfile(doc, dir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('removeProfilePin removes a simple matching file and refuses everything else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pin-rm-'))
  const path = join(dir, PROFILE_PIN_FILE)
  try {
    // Missing file → fs error surfaced as a message.
    assert.match(removeProfilePin(dir, 'work') ?? '', /ENOENT|no such/i)
    // Name must match (case-insensitive); a different name refuses.
    writeProfilePin(dir, 'work')
    assert.equal(readFileSync(path, 'utf8'), 'work\n')
    assert.match(removeProfilePin(dir, 'personal') ?? '', /refusing|edited by hand/)
    assert.ok(existsSync(path), 'the refusal left the file in place')
    assert.equal(removeProfilePin(dir, 'WORK'), undefined) // case-insensitive match removes
    assert.equal(existsSync(path), false)
    // A hand-decorated file (comments/extra lines) is never auto-removed.
    writeProfilePin(dir, 'work')
    writeFileSync(path, '# my pin\nwork\nextra line\n')
    assert.match(removeProfilePin(dir, 'work') ?? '', /edited by hand/)
    assert.ok(readFileSync(path, 'utf8').includes('extra line'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bindWorkspaceProfile writes a fresh file and rebinds a clean one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pin-bind-'))
  const path = join(dir, PROFILE_PIN_FILE)
  try {
    // Missing file → written.
    assert.equal(bindWorkspaceProfile(dir, 'work'), undefined)
    assert.equal(readFileSync(path, 'utf8'), 'work\n')
    // A clean single-entry file naming ANOTHER profile is rebound (a switch
    // moves this tree's binding).
    writeProfilePin(dir, 'personal')
    assert.equal(bindWorkspaceProfile(dir, 'work'), undefined)
    assert.equal(readFileSync(path, 'utf8'), 'work\n')
    // Same name: idempotent rewrite, no error.
    assert.equal(bindWorkspaceProfile(dir, 'WORK'), undefined)
    assert.equal(readFileSync(path, 'utf8'), 'WORK\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bindWorkspaceProfile refuses a hand-decorated file and leaves it untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pin-bind2-'))
  const path = join(dir, PROFILE_PIN_FILE)
  try {
    // Comments + entries + extra lines: never clobbered by a switch.
    const handEdited = '# my pin\nwork\nextra line\n'
    writeFileSync(path, handEdited)
    assert.match(bindWorkspaceProfile(dir, 'personal') ?? '', /refusing|edited by hand/)
    assert.equal(readFileSync(path, 'utf8'), handEdited)
    // Comment-only file: hand-written too, refused.
    writeFileSync(path, '# just a comment\n')
    assert.match(bindWorkspaceProfile(dir, 'personal') ?? '', /refusing|edited by hand/)
    assert.equal(readFileSync(path, 'utf8'), '# just a comment\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('boundProfileName resolves the nearest binding through the doc, undefined when unknown', () => {
  const doc = seedModelProfilesDoc()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pin-cur-'))
  const child = join(dir, 'sub')
  mkdirSync(child, { recursive: true })
  try {
    assert.equal(boundProfileName(doc, dir), undefined) // nothing bound
    writeProfilePin(dir, 'work')
    assert.equal(boundProfileName(doc, dir), 'work')
    // Case-insensitive lookup, canonical stored name returned.
    writeProfilePin(dir, 'WORK')
    assert.equal(boundProfileName(doc, dir), 'work')
    // A child inherits the nearest ancestor's binding.
    assert.equal(boundProfileName(doc, child), 'work')
    // A pin naming a since-deleted profile binds nothing.
    writeProfilePin(dir, 'ghost')
    assert.equal(boundProfileName(doc, dir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
