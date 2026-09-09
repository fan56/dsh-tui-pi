import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setPresetRootOverride, currentPreset, DEFAULT_PRESET_ID, fetchPresetRoster,
  findPresetByName, formatPresetLabel, initialPresetIndex, peekNextPreset, resolvePresetRoots,
  shippedRootsFromEntryDir,
} from '../lib/preset.js'

const roster = [
  { id: 'standard', name: 'Standard', trust: 'system', isDefault: true },
  { id: 'ptc', name: 'PTC', description: 'Code Mode', trust: 'system', isDefault: false },
  { id: 'minimal', name: 'Minimal', trust: 'user', isDefault: false },
  { id: 'creative', name: 'Creative', trust: 'user', isDefault: false },
]

test('currentPreset returns the entry at the index', () => {
  const state = { roster, index: 0 }
  assert.equal(currentPreset(state).id, 'standard')
  state.index = 2
  assert.equal(currentPreset(state).id, 'minimal')
})

test('currentPreset returns undefined for empty roster', () => {
  assert.equal(currentPreset({ roster: [], index: 0 }), undefined)
})

test('peekNextPreset previews the next entry without mutating the index', () => {
  const state = { roster, index: 0 }
  assert.equal(peekNextPreset(state).id, 'ptc')
  assert.equal(state.index, 0, 'pure: the selection is untouched')
  state.index = 3
  assert.equal(peekNextPreset(state).id, 'standard') // wrap
  assert.equal(state.index, 3)
})

test('peekNextPreset returns undefined for single-element or empty roster', () => {
  assert.equal(peekNextPreset({ roster: [roster[0]], index: 0 }), undefined)
  assert.equal(peekNextPreset({ roster: [], index: 0 }), undefined)
})

test('findPresetByName matches id (case-insensitive)', () => {
  const state = { roster, index: 0 }
  assert.equal(findPresetByName(state, 'ptc').id, 'ptc')
  assert.equal(findPresetByName(state, 'PTC').id, 'ptc')
  assert.equal(findPresetByName(state, 'Standard').id, 'standard')
  assert.equal(findPresetByName(state, 'nonexistent'), undefined)
})

test('findPresetByName matches display name', () => {
  const state = { roster, index: 0 }
  assert.equal(findPresetByName(state, 'Minimal').id, 'minimal')
  assert.equal(findPresetByName(state, 'creative').id, 'creative')
})

test('findPresetByName also matches the official name behind an English override', () => {
  const state = {
    roster: [{ id: 'standard', name: 'Standard', officialName: '标准模式', trust: 'system', isDefault: false }],
    index: 0,
  }
  assert.equal(findPresetByName(state, '标准模式').id, 'standard')
  assert.equal(findPresetByName(state, 'Standard').id, 'standard')
  assert.equal(findPresetByName(state, 'standard').id, 'standard')
})

test('formatPresetLabel returns name or empty string', () => {
  assert.equal(formatPresetLabel(roster[0]), 'Standard')
  assert.equal(formatPresetLabel(undefined), '')
})

test('DEFAULT_PRESET_ID is standard', () => {
  assert.equal(DEFAULT_PRESET_ID, 'standard')
})

test('initialPresetIndex selects the standard preset when present', () => {
  // `standard` is not the first-scanned entry here — scan order must not win.
  const scanned = [
    { id: 'ptc', name: 'PTC', trust: 'system', isDefault: false },
    { id: 'minimal', name: 'Minimal', trust: 'system', isDefault: false },
    { id: 'standard', name: 'Standard', trust: 'system', isDefault: false },
  ]
  assert.equal(initialPresetIndex(scanned), 2)
})

test('initialPresetIndex falls back to the first entry without a standard preset', () => {
  const noStandard = roster.filter(p => p.id !== 'standard')
  assert.ok(noStandard.length > 0)
  assert.equal(initialPresetIndex(noStandard), 0)
})

test('initialPresetIndex returns 0 for an empty roster', () => {
  assert.equal(initialPresetIndex([]), 0)
})

test('initialPresetIndex prefers the remembered selection over the default', () => {
  // Preset memory: a remembered id present in the roster WINS — even when
  // the default `standard` entry exists (the whole point is not falling
  // back to the default on launch).
  assert.equal(initialPresetIndex(roster, 'creative'), 3)
  assert.equal(initialPresetIndex(roster, 'standard'), 0)
  assert.equal(initialPresetIndex(roster, 'ptc'), 1)
})

test('initialPresetIndex ignores a stale remembered id', () => {
  // A preset renamed/removed upstream must not break the launch — fall back
  // to the stock default-selection behavior.
  assert.equal(initialPresetIndex(roster, 'gone-preset'), 0)
  assert.equal(initialPresetIndex([], 'gone-preset'), 0)
  // An empty/absent id behaves like no memory at all.
  assert.equal(initialPresetIndex(roster, ''), 0)
  assert.equal(initialPresetIndex(roster, undefined), 0)
})

// --------------------------------------------- filesystem roster scan --

test('resolvePresetRoots probes the dsh-agent-presets shipped layouts plus the user root', () => {
  const paths = resolvePresetRoots().map(r => r.path)
  assert.ok(paths.includes('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets'), 'nested layout probed')
  assert.ok(paths.includes('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh-agent-presets/presets'), 'flat layout probed')
  assert.ok(paths.some(p => p.endsWith('.dsh/.agent-presets')), 'user root probed')
  assert.ok(paths.every(p => !p.includes('/config/agent-presets')), 'the pre-alpha config-dir layout is no longer probed')
})

// ------------------------------------- shipped-root discovery (issue #3) --

test('shippedRootsFromEntryDir walks up from the entry and finds the nested presets package', async () => {
  // Fake install — presets nested at <root>/node_modules/@deepseek-ai/dsh-agent-presets/presets
  // with the entry script at <root>/lib/bin.js: the shape of ANY global npm
  // prefix (homebrew, nvm, a custom prefix), which the static fallback list
  // never covered (issue #3: shipped presets invisible off the known prefixes).
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-preset-roots-'))
  try {
    const shipped = join(root, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets')
    await mkdir(join(shipped, 'standard'), { recursive: true })
    await writeFile(join(shipped, 'standard', 'agent.cordis.yml'), '')
    await mkdir(join(root, 'lib'), { recursive: true })
    await writeFile(join(root, 'lib', 'bin.js'), '')
    assert.deepEqual(shippedRootsFromEntryDir(join(root, 'lib')), [shipped])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('shippedRootsFromEntryDir returns [] when no ancestor carries the package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-preset-roots-'))
  try {
    assert.deepEqual(shippedRootsFromEntryDir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolvePresetRoots dedups shipped roots across the discovery strategies', () => {
  // On a dsh machine the entry walk and the closure probe typically resolve
  // to the SAME physical dir — it must be probed once, not twice.
  const paths = resolvePresetRoots().map(r => r.path)
  assert.equal(new Set(paths).size, paths.length)
})

test('resolvePresetRoots: every system root is a dsh-agent-presets presets dir', () => {
  for (const root of resolvePresetRoots().filter(r => r.trust === 'system')) {
    assert.ok(
      root.path.endsWith(join('@deepseek-ai', 'dsh-agent-presets', 'presets')),
      `unexpected shipped root: ${root.path}`,
    )
  }
})

test('issue #3 case: an off-prefix install (nvm-style, profile launch) lists the shipped presets', async () => {
  // The reporter's environment, reconstructed: dsh lives under an nvm-managed
  // node — nowhere near the four hard-coded global prefixes — and is launched
  // as `dsh --profile tui` (the profile only changes which PLUGINS load; the
  // host entry — and therefore the host's own presets package — stays put).
  // Symptom on the old discovery: the roster showed only the user root's
  // custom presets, every shipped preset invisible. Reconstruction asserts the
  // full path: resolvePresetRoots() (argv[1] pointed at the nvm bin shim)
  // → fetchPresetRoster() finds `standard` with system trust.
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-issue3-'))
  const savedArgv1 = process.argv[1]
  try {
    const nodeDir = join(root, 'users', 'someone', '.nvm', 'versions', 'node', 'v22')
    const shipped = join(nodeDir, 'lib', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets')
    for (const id of ['standard', 'minimal', 'cordis', 'ptc']) {
      await mkdir(join(shipped, id), { recursive: true })
      await writeFile(join(shipped, id, 'agent.cordis.yml'), '')
    }
    // The dsh package nests its presets copy; the bin is the usual symlink shim.
    const hostLib = join(nodeDir, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    await mkdir(hostLib, { recursive: true })
    await writeFile(join(hostLib, 'bin.js'), '')
    await mkdir(join(nodeDir, 'bin'), { recursive: true })
    await symlink(join(hostLib, 'bin.js'), join(nodeDir, 'bin', 'dsh'))
    process.argv[1] = join(nodeDir, 'bin', 'dsh')

    // macOS /tmp is a symlink (/var → /private/var): the discovered root is
    // the entry's REAL path, so compare against the real path of the tree.
    const realRoot = realpathSync(root)
    const roots = resolvePresetRoots()
    const discovered = roots.find(r => r.trust === 'system' && r.path.startsWith(realRoot))
    assert.ok(discovered, 'the nvm-nested shipped root is discovered dynamically')
    // The old logic equals probing only the static fallback list — assert it
    // genuinely misses this layout, so the test cannot silently regress into it.
    assert.ok(roots[0].path.startsWith(realRoot), 'the dynamic hit outranks the static fallbacks')

    const roster = await fetchPresetRoster()
    for (const id of ['standard', 'minimal', 'cordis', 'ptc']) {
      const entry = roster.find(p => p.id === id)
      assert.ok(entry, `shipped preset "${id}" is listed`)
      assert.equal(entry.trust, 'system')
    }
  } finally {
    process.argv[1] = savedArgv1
    await rm(root, { recursive: true, force: true })
  }
})

test('fetchPresetRoster: shipped ids get English names (official string kept); unmapped ids fall back to official string', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-presets-'))
  try {
    await mkdir(join(dir, 'standard'))
    await writeFile(join(dir, 'standard', 'agent.cordis.yml'), '')
    await writeFile(join(dir, 'standard', 'preset.yml'), 'name: 标准模式\ndescription: 功能完整的编码 Agent\norder: 1\n')
    await mkdir(join(dir, 'ptc'))
    await writeFile(join(dir, 'ptc', 'agent.cordis.yml'), '')
    await mkdir(join(dir, 'cordis'))
    await writeFile(join(dir, 'cordis', 'agent.cordis.yml'), '')
    await writeFile(join(dir, 'cordis', 'preset.yml'), 'name: 创造模式\norder: 2\n')
    await mkdir(join(dir, 'lab-rodent')) // unmapped id, no metadata
    await writeFile(join(dir, 'lab-rodent', 'agent.cordis.yml'), '')
    await mkdir(join(dir, 'not-a-preset')) // no composition file → skipped
    __setPresetRootOverride([{ path: dir, trust: 'system' }])
    const roster = await fetchPresetRoster()
    assert.equal(roster.length, 4)
    const standard = roster.find(p => p.id === 'standard')
    assert.equal(standard.name, 'Standard', 'mapped id shows the English name')
    assert.equal(standard.officialName, '标准模式', 'official string kept for /preset matching')
    assert.equal(standard.description, '功能完整的编码 Agent')
    assert.equal(standard.trust, 'system')
    assert.equal(roster.find(p => p.id === 'ptc').name, 'PTC', 'mapping applies even without metadata')
    assert.equal(roster.find(p => p.id === 'cordis').name, 'Cordis', 'cordis keeps the framework name')
    assert.equal(roster.find(p => p.id === 'lab-rodent').name, 'lab-rodent', 'unmapped id → official fallback (id)')
  } finally {
    __setPresetRootOverride(undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

test('fetchPresetRoster: preset.yml is the only metadata file read (the metadata.yml legacy probe is gone)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-presets-'))
  try {
    await mkdir(join(dir, 'legacy'))
    await writeFile(join(dir, 'legacy', 'agent.cordis.yml'), '')
    await writeFile(join(dir, 'legacy', 'metadata.yml'), 'name: 仅旧版名字\n') // no preset.yml — ignored
    __setPresetRootOverride([{ path: dir, trust: 'user' }])
    const roster = await fetchPresetRoster()
    assert.equal(roster.length, 1)
    assert.equal(roster[0].name, 'legacy', 'a bare metadata.yml no longer names a preset (alpha hosts ship preset.yml only)')
  } finally {
    __setPresetRootOverride(undefined)
    await rm(dir, { recursive: true, force: true })
  }
})
