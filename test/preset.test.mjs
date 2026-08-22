import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cyclePreset, currentPreset, DEFAULT_PRESET_ID, findPresetByName, formatPresetLabel, initialPresetIndex } from '../lib/preset.js'

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
