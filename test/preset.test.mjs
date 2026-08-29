import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setPresetRootOverride, cyclePreset, currentPreset, DEFAULT_PRESET_ID, fetchPresetRoster,
  findPresetByName, formatPresetLabel, initialPresetIndex, resolvePresetRoots,
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

test('cyclePreset advances forward and wraps', () => {
  const state = { roster, index: 0 }
  cyclePreset(state)
  assert.equal(state.index, 1)
  cyclePreset(state)
  assert.equal(state.index, 2)
  cyclePreset(state)
  assert.equal(state.index, 3)
  cyclePreset(state)
  assert.equal(state.index, 0) // wrap
})

test('cyclePreset goes backward', () => {
  const state = { roster, index: 0 }
  cyclePreset(state, -1)
  assert.equal(state.index, 3) // wrap backward
})

test('cyclePreset is a no-op for single-element or empty roster', () => {
  const single = { roster: [roster[0]], index: 0 }
  cyclePreset(single)
  assert.equal(single.index, 0)
  const empty = { roster: [], index: 0 }
  cyclePreset(empty)
  assert.equal(empty.index, 0)
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
    { id: 'code', name: 'Code', trust: 'system', isDefault: false },
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

// --------------------------------------------- filesystem roster scan --

test('resolvePresetRoots probes rc-era and alpha-era shipped layouts plus the user root', () => {
  const paths = resolvePresetRoots().map(r => r.path)
  assert.ok(paths.includes('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/config/agent-presets'), 'rc-era layout probed')
  assert.ok(paths.includes('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets'), 'alpha-era nested layout probed')
  assert.ok(paths.includes('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh-agent-presets/presets'), 'alpha-era flat layout probed')
  assert.ok(paths.some(p => p.endsWith('.dsh/.agent-presets')), 'user root probed')
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

test('fetchPresetRoster: preset.yml wins when both metadata files exist (metadata.yml is legacy)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-presets-'))
  try {
    await mkdir(join(dir, 'hybrid'))
    await writeFile(join(dir, 'hybrid', 'agent.cordis.yml'), '')
    await writeFile(join(dir, 'hybrid', 'metadata.yml'), 'name: 旧版名字\n')
    await writeFile(join(dir, 'hybrid', 'preset.yml'), 'name: 新版名字\norder: 1\n')
    await mkdir(join(dir, 'legacy'))
    await writeFile(join(dir, 'legacy', 'agent.cordis.yml'), '')
    await writeFile(join(dir, 'legacy', 'metadata.yml'), 'name: 仅旧版名字\n') // old host, no preset.yml
    __setPresetRootOverride([{ path: dir, trust: 'user' }])
    const roster = await fetchPresetRoster()
    assert.equal(roster.length, 2)
    assert.equal(roster.find(p => p.id === 'hybrid').name, '新版名字')
    assert.equal(roster.find(p => p.id === 'legacy').name, '仅旧版名字', 'metadata.yml still read when preset.yml is absent')
  } finally {
    __setPresetRootOverride(undefined)
    await rm(dir, { recursive: true, force: true })
  }
})
