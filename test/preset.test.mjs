import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setPresetRootOverride, currentPreset, DEFAULT_PRESET_ID, fetchPresetRoster,
  findPresetByName, formatPresetLabel, initialPresetIndex, peekNextPreset, readPresetRegistry,
  resolvePresetRoots, rosterFromRegistry, shippedRootsFromEntryDir,
} from '../lib/preset.js'

const roster = [
  { id: 'standard', name: 'Standard', isDefault: true },
  { id: 'ptc', name: 'PTC', description: 'Code Mode', isDefault: false },
  { id: 'minimal', name: 'Minimal', isDefault: false },
  { id: 'creative', name: 'Creative', isDefault: false },
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
    roster: [{ id: 'standard', name: 'Standard', officialName: '标准模式', isDefault: false }],
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
  // `standard` is not the first-listed entry here — listing order must not win.
  const listed = [
    { id: 'ptc', name: 'PTC', isDefault: false },
    { id: 'minimal', name: 'Minimal', isDefault: false },
    { id: 'standard', name: 'Standard', isDefault: false },
  ]
  assert.equal(initialPresetIndex(listed), 2)
})

test('initialPresetIndex prefers the roster-marked default (registry isDefault)', () => {
  // The 0.1.7 registry marks its default row (`isDefault`) — that row wins
  // even when a `standard` entry exists elsewhere on the roster.
  const marked = [
    { id: 'ptc', name: 'PTC', isDefault: true },
    { id: 'standard', name: 'Standard', isDefault: false },
  ]
  assert.equal(initialPresetIndex(marked), 0)
  const markedMiddle = [
    { id: 'zebra', name: 'Zebra', isDefault: false },
    { id: 'minimal', name: 'Minimal', isDefault: true },
    { id: 'standard', name: 'Standard', isDefault: false },
  ]
  assert.equal(initialPresetIndex(markedMiddle), 1)
})

test('initialPresetIndex falls back to the DEFAULT_PRESET_ID entry when no row is marked', () => {
  const unmarked = [
    { id: 'zebra', name: 'Zebra', isDefault: false },
    { id: 'standard', name: 'Standard', isDefault: false },
  ]
  assert.equal(initialPresetIndex(unmarked), 1)
})

test('initialPresetIndex falls back to the first entry without any preference match', () => {
  const noStandard = roster.filter(p => p.id !== 'standard')
  assert.ok(noStandard.length > 0)
  assert.equal(initialPresetIndex(noStandard), 0)
})

test('initialPresetIndex returns 0 for an empty roster', () => {
  assert.equal(initialPresetIndex([]), 0)
})

test('initialPresetIndex prefers the remembered selection over the default', () => {
  // Preset memory: a remembered id present in the roster WINS — even when
  // the default entry exists (the whole point is not falling back to the
  // default on launch).
  assert.equal(initialPresetIndex(roster, 'creative'), 3)
  assert.equal(initialPresetIndex(roster, 'standard'), 0)
  assert.equal(initialPresetIndex(roster, 'ptc'), 1)
  // Remembered also outranks the roster-marked default.
  assert.equal(initialPresetIndex([{ id: 'ptc', name: 'PTC', isDefault: true }, { id: 'minimal', name: 'Minimal', isDefault: false }], 'minimal'), 1)
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

// ------------------------------------------------- registry-driven roster --

/** A host context whose `agentPresets` service is `registry`. */
function fakeCtx(registry) {
  return { get(name) { return name === 'agentPresets' ? registry : undefined } }
}

function fakeRegistry(presets) {
  return { remoteExportList: async () => ({ presets, modeSelectionEnabled: true }) }
}

test('readPresetRegistry resolves the agentPresets service and tolerates its absence', () => {
  const registry = fakeRegistry([])
  assert.equal(readPresetRegistry(fakeCtx(registry)), registry)
  assert.equal(readPresetRegistry({ get: () => undefined }), undefined)
  // A host without a `get` at all (embedded/embedder context shapes).
  assert.equal(readPresetRegistry({}), undefined)
  assert.equal(readPresetRegistry(undefined), undefined)
})

test('fetchPresetRoster reads the registry roster and renders the shipped ids with the new semantics', async () => {
  // The 0.1.7 shipped roster: standard (order 1), ptc (2), minimal (3),
  // cordis (4). Shipped declarations publish no name/description — the
  // English display copy comes from our mapping. cordis is now the
  // plugin/preset-authoring slot ("Creator"), ptc composes the PTC runtime.
  const registryRoster = await fetchPresetRoster(fakeCtx(fakeRegistry([
    { id: 'standard', isDefault: true },
    { id: 'ptc', isDefault: false },
    { id: 'minimal', isDefault: false },
    { id: 'cordis', isDefault: false },
  ])))
  assert.deepEqual(registryRoster.map(p => p.id), ['standard', 'ptc', 'minimal', 'cordis'], 'registry order is preserved')
  const standard = registryRoster.find(p => p.id === 'standard')
  assert.equal(standard.name, 'Standard')
  assert.equal(standard.isDefault, true, 'isDefault rides the registry row')
  assert.ok(standard.description.length > 0, 'shipped ids get display copy')
  assert.equal(standard.officialName, undefined, 'no official string when the row publishes no name')
  assert.equal(registryRoster.find(p => p.id === 'ptc').name, 'PTC')
  assert.equal(registryRoster.find(p => p.id === 'minimal').name, 'Minimal')
  const cordis = registryRoster.find(p => p.id === 'cordis')
  assert.equal(cordis.name, 'Creator', 'cordis renders under its NEW authoring-slot semantics')
  assert.ok(cordis.description.includes('plugins'), 'cordis description states the authoring slot')
  assert.equal(cordis.isDefault, false)
})

test('fetchPresetRoster passes unmapped registry rows through verbatim (broken included)', async () => {
  const registryRoster = await fetchPresetRoster(fakeCtx(fakeRegistry([
    { id: 'lab-rodent', name: 'Lab Rodent', description: 'custom composition', isDefault: false },
    { id: 'minimal', name: 'Minimal mode', isDefault: false },
    { id: 'broken-one', isDefault: false, broken: 'entry boom failed to activate' },
  ])))
  const custom = registryRoster.find(p => p.id === 'lab-rodent')
  assert.equal(custom.name, 'Lab Rodent', 'unmapped ids keep the registry name')
  assert.equal(custom.description, 'custom composition', 'user descriptions pass through untranslated')
  assert.equal(custom.broken, undefined)
  const overridden = registryRoster.find(p => p.id === 'minimal')
  assert.equal(overridden.name, 'Minimal', 'mapped id shows the English name')
  assert.equal(overridden.officialName, 'Minimal mode', 'the registry string is kept for /preset matching')
  const broken = registryRoster.find(p => p.id === 'broken-one')
  assert.equal(broken.name, 'broken-one', 'broken rows stay on the roster')
  assert.equal(broken.broken, 'entry boom failed to activate', 'the activation reason rides along')
})

test('fetchPresetRoster degrades to the legacy directory scan when the registry service is absent', async () => {
  // Pre-0.1.7 host: no `agentPresets` service → the deprecated scan runs
  // (on a 0.1.7 host it finds no roots and returns [] — dead dirs, empty
  // roster, feature disables gracefully).
  const scanned = await fetchPresetRoster({ get: () => undefined })
  assert.ok(Array.isArray(scanned))
  // And with no ctx at all (the pre-T13 call shape still works).
  assert.ok(Array.isArray(await fetchPresetRoster()))
})

test('fetchPresetRoster degrades to the legacy directory scan when the registry read throws', async () => {
  const registry = { remoteExportList: async () => { throw new Error('registry exploded') } }
  const scanned = await fetchPresetRoster(fakeCtx(registry))
  assert.ok(Array.isArray(scanned), 'never throws — the fallback roster comes back')
})

test('rosterFromRegistry is pure: the input roster object is not mutated', () => {
  const input = { presets: [{ id: 'standard', isDefault: true }], modeSelectionEnabled: false }
  const snapshot = JSON.stringify(input)
  rosterFromRegistry(input)
  assert.equal(JSON.stringify(input), snapshot)
})

// --------------------------------------------- legacy filesystem scan (deprecated) --

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

test('resolvePresetRoots: every shipped root is a dsh-agent-presets presets dir', () => {
  for (const root of resolvePresetRoots().filter(r => r.origin === 'shipped')) {
    assert.ok(
      root.path.endsWith(join('@deepseek-ai', 'dsh-agent-presets', 'presets')),
      `unexpected shipped root: ${root.path}`,
    )
  }
})

test('legacy scan case: an off-prefix install (nvm-style, profile launch) lists the shipped presets', async () => {
  // The reporter's environment, reconstructed: dsh lives under an nvm-managed
  // node — nowhere near the four hard-coded global prefixes — and is launched
  // as `dsh --profile tui` (the profile only changes which PLUGINS load; the
  // host entry — and therefore the host's own presets package — stays put).
  // Symptom on the old discovery: the roster showed only the user root's
  // custom presets, every shipped preset invisible. Reconstruction asserts the
  // full path: resolvePresetRoots() (argv[1] pointed at the nvm bin shim)
  // → the legacy scan finds `standard`. On a 0.1.7 host this whole path is
  // the deprecated fallback (the registry serves the roster instead).
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
    const discovered = roots.find(r => r.origin === 'shipped' && r.path.startsWith(realRoot))
    assert.ok(discovered, 'the nvm-nested shipped root is discovered dynamically')
    // The old logic equals probing only the static fallback list — assert it
    // genuinely misses this layout, so the test cannot silently regress into it.
    assert.ok(roots[0].path.startsWith(realRoot), 'the dynamic hit outranks the static fallbacks')

    const scanned = await fetchPresetRoster({ get: () => undefined })
    for (const id of ['standard', 'minimal', 'cordis', 'ptc']) {
      assert.ok(scanned.find(p => p.id === id), `shipped preset "${id}" is listed`)
    }
  } finally {
    process.argv[1] = savedArgv1
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy scan: shipped ids get English names (official string kept); unmapped ids fall back to official string', async () => {
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
    __setPresetRootOverride([{ path: dir, origin: 'shipped' }])
    const scanned = await fetchPresetRoster({ get: () => undefined })
    assert.equal(scanned.length, 4)
    const standard = scanned.find(p => p.id === 'standard')
    assert.equal(standard.name, 'Standard', 'mapped id shows the English name')
    assert.equal(standard.officialName, '标准模式', 'official string kept for /preset matching')
    assert.equal(standard.description, '功能完整的编码 Agent')
    assert.equal(standard.isDefault, false, 'the legacy scan marks no default')
    assert.equal(scanned.find(p => p.id === 'ptc').name, 'PTC', 'mapping applies even without metadata')
    assert.equal(scanned.find(p => p.id === 'cordis').name, 'Creator', 'cordis keeps its new-semantics framework name')
    assert.equal(scanned.find(p => p.id === 'lab-rodent').name, 'lab-rodent', 'unmapped id → official fallback (id)')
  } finally {
    __setPresetRootOverride(undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

test('legacy scan: preset.yml is the only metadata file read (the metadata.yml legacy probe is gone)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-presets-'))
  try {
    await mkdir(join(dir, 'legacy'))
    await writeFile(join(dir, 'legacy', 'agent.cordis.yml'), '')
    await writeFile(join(dir, 'legacy', 'metadata.yml'), 'name: 仅旧版名字\n') // no preset.yml — ignored
    __setPresetRootOverride([{ path: dir, origin: 'user' }])
    const scanned = await fetchPresetRoster({ get: () => undefined })
    assert.equal(scanned.length, 1)
    assert.equal(scanned[0].name, 'legacy', 'a bare metadata.yml no longer names a preset (alpha hosts ship preset.yml only)')
  } finally {
    __setPresetRootOverride(undefined)
    await rm(dir, { recursive: true, force: true })
  }
})
