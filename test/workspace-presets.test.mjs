/**
 * Workspace preset-memory store tests — the narrow/normalize, atomic save
 * and per-workspace lookup of src/workspace-presets.ts (the
 * model-profiles.json precedent: self-healing reads, best-effort writes,
 * never fatal). Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WORKSPACE_PRESETS_VERSION,
  loadWorkspacePresets,
  normalizeWorkspacePresets,
  rememberedPresetFor,
  saveWorkspacePresets,
  seedWorkspacePresetsDoc,
  withRememberedPreset,
  workspacePresetsPath,
} from '../lib/workspace-presets.js'

test('workspacePresetsPath lives in the dsh home', () => {
  assert.equal(workspacePresetsPath('/home/x/.dsh'), join('/home/x/.dsh', 'workspace-presets.json'))
})

test('normalize: valid document passes through; keys and values are trimmed', () => {
  const doc = normalizeWorkspacePresets({
    version: WORKSPACE_PRESETS_VERSION,
    presets: { ' --home-user-repo-- ': '  cordis  ', empty: '' },
  })
  assert.deepEqual(doc, { version: WORKSPACE_PRESETS_VERSION, presets: { '--home-user-repo--': 'cordis' } })
})

test('normalize: wrong version, garbage shape, or bad entries reset to the seed', () => {
  const seed = seedWorkspacePresetsDoc()
  assert.deepEqual(seed, { version: WORKSPACE_PRESETS_VERSION, presets: {} })
  assert.deepEqual(normalizeWorkspacePresets({ version: 999, presets: { a: 'b' } }), seed)
  assert.deepEqual(normalizeWorkspacePresets({ presets: { a: 'b' } }), seed)
  assert.deepEqual(normalizeWorkspacePresets(null), seed)
  assert.deepEqual(normalizeWorkspacePresets('nope'), seed)
  assert.deepEqual(normalizeWorkspacePresets({ version: WORKSPACE_PRESETS_VERSION, presets: [] }), seed)
  assert.deepEqual(
    normalizeWorkspacePresets({ version: WORKSPACE_PRESETS_VERSION, presets: { a: 42, b: null } }),
    seed,
    'non-string values drop',
  )
})

test('load: missing or corrupt file degrades to the empty document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-wspresets-'))
  assert.deepEqual(loadWorkspacePresets(join(dir, 'absent.json')), seedWorkspacePresetsDoc())
  const corrupt = join(dir, 'corrupt.json')
  await writeFile(corrupt, '{not json', 'utf8')
  assert.deepEqual(loadWorkspacePresets(corrupt), seedWorkspacePresetsDoc())
})

test('save + load round-trip; save is atomic (no tmp sibling left behind)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-wspresets-'))
  const path = join(dir, 'workspace-presets.json')
  const doc = withRememberedPreset(seedWorkspacePresetsDoc(), '--home-user-repo--', 'cordis')
  assert.equal(saveWorkspacePresets(path, doc), undefined)
  const onDisk = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(onDisk.presets['--home-user-repo--'], 'cordis')
  assert.deepEqual(loadWorkspacePresets(path), doc)
  const siblings = (await import('node:fs/promises')).readdir(dir)
  assert.ok(!(await siblings).some(name => name.includes('.tmp-')), 'the tmp sibling is renamed away')
})

test('save creates the parent directory and reports failures as messages (never throws)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-wspresets-'))
  const nested = join(dir, 'a', 'b', 'workspace-presets.json')
  assert.equal(saveWorkspacePresets(nested, seedWorkspacePresetsDoc()), undefined)
  // A parent path that is a FILE cannot become a directory — the write
  // fails with a message.
  const blocker = join(dir, 'blocker')
  await writeFile(blocker, 'x', 'utf8')
  const error = saveWorkspacePresets(join(blocker, 'child.json'), seedWorkspacePresetsDoc())
  assert.ok(typeof error === 'string' && error.length > 0)
})

test('rememberedPresetFor reads one workspace; missing keys read as undefined', () => {
  const doc = { version: WORKSPACE_PRESETS_VERSION, presets: { '--a--': 'cordis', '--b--': 'standard' } }
  assert.equal(rememberedPresetFor(doc, '--a--'), 'cordis')
  assert.equal(rememberedPresetFor(doc, '--zz--'), undefined)
  assert.equal(rememberedPresetFor(doc, ''), undefined)
})

test('withRememberedPreset is a pure merge — the input document is untouched', () => {
  const base = seedWorkspacePresetsDoc()
  const next = withRememberedPreset(base, '--a--', 'ptc')
  assert.deepEqual(base.presets, {}, 'the input document never mutates')
  assert.equal(next.presets['--a--'], 'ptc')
  // Re-recording the same workspace overwrites (last commit wins).
  const again = withRememberedPreset(next, '--a--', 'cordis')
  assert.equal(again.presets['--a--'], 'cordis')
  assert.equal(again.presets.size ?? Object.keys(again.presets).length, 1)
})

test('save is a serialized whole-file write: concurrent-looking updates converge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-wspresets-'))
  const path = join(dir, 'workspace-presets.json')
  await mkdir(dir, { recursive: true })
  // The switch path re-loads before each write, so interleaved callers
  // converge on the union — the regression here is the lost-update shape
  // (a write clobbering the OTHER workspace's entry).
  const first = withRememberedPreset(loadWorkspacePresets(path), '--a--', 'cordis')
  assert.equal(saveWorkspacePresets(path, first), undefined)
  const second = withRememberedPreset(loadWorkspacePresets(path), '--b--', 'ptc')
  assert.equal(saveWorkspacePresets(path, second), undefined)
  const final = loadWorkspacePresets(path)
  assert.equal(final.presets['--a--'], 'cordis')
  assert.equal(final.presets['--b--'], 'ptc')
})
