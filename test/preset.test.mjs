import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cyclePreset, currentPreset, findPresetByName, formatPresetLabel } from '../lib/preset.js'

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
