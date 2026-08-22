/**
 * `/hotkeys` support (src/hotkeys.ts → lib/hotkeys.js): the user keybindings
 * file contract (path, loader, validation) and the display table. Runs
 * against the built lib/ (pretest builds).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appHotkeyRows,
  displayKey,
  isValidKeyId,
  KEYBINDINGS_FILE,
  keybindingsPath,
  loadKeyBindings,
  parseKeyInput,
  updateKeyBindingsFile,
} from '../lib/hotkeys.js'

// ------------------------------------------------------------- helpers --

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-hotkeys-'))
}

function writeKeys(home, json) {
  const file = keybindingsPath(home)
  writeFileSync(file, JSON.stringify(json, null, 2))
  return file
}

function readText(file) {
  return readFileSync(file, 'utf8')
}

// ---------------------------------------------------------------- path --

test('keybindingsPath joins the home with keybindings.json', () => {
  assert.equal(KEYBINDINGS_FILE, 'keybindings.json')
  assert.equal(keybindingsPath('/home/u/.dsh'), '/home/u/.dsh/keybindings.json')
})

// ---------------------------------------------------------- validation --

test('isValidKeyId accepts documented key ids', () => {
  for (const id of ['escape', 'esc', 'ctrl+c', 'ctrl+l', 'alt+c', 'ctrl+shift+p',
    'pageUp', 'backspace', 'f5', 'f12', 'f24', 'x', '5', '-', 'super+k']) {
    assert.equal(isValidKeyId(id), true, `expected ${JSON.stringify(id)} to be valid`)
  }
})

test('isValidKeyId rejects typos and unknown names', () => {
  for (const id of ['', '   ', 'zzz', 'ctrl++', 'ctrl', 'shift+', 'bogus;!',
    'ctrl+alt+x+y', '+c', 'control+c', 42, null, undefined, {}, [], 'fnord+1']) {
    assert.equal(isValidKeyId(id), false, `expected ${JSON.stringify(id)} to be invalid`)
  }
})

test('displayKey formats ids like pi keybinding hints', () => {
  assert.equal(displayKey('escape'), 'Esc')
  assert.equal(displayKey('ctrl+c'), 'Ctrl+C')
  assert.equal(displayKey('ctrl+shift+p'), 'Ctrl+Shift+P')
  assert.equal(displayKey('pageUp'), 'PageUp')
  assert.equal(displayKey('f5'), 'F5')
})

// --------------------------------------------------------------- load --

test('loadKeyBindings: missing file → empty bindings, no warnings', () => {
  const home = tempHome()
  const result = loadKeyBindings(keybindingsPath(home))
  assert.deepEqual(result.bindings, {})
  assert.deepEqual(result.warnings, [])
  assert.equal(result.exists, false)
})

test('loadKeyBindings: valid partial file overrides only those keys', () => {
  const home = tempHome()
  const file = writeKeys(home, { escape: 'ctrl+x', modelPicker: 'ctrl+m' })
  const result = loadKeyBindings(file)
  assert.deepEqual(result.bindings, { escape: 'ctrl+x', modelPicker: 'ctrl+m' })
  assert.deepEqual(result.warnings, [])
  assert.equal(result.exists, true)
})

test('loadKeyBindings: invalid JSON warns and keeps defaults', () => {
  const home = tempHome()
  const file = keybindingsPath(home)
  writeFileSync(file, '{ not json')
  const result = loadKeyBindings(file)
  assert.deepEqual(result.bindings, {})
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /invalid JSON/)
  assert.equal(result.exists, true)
})

test('loadKeyBindings: a non-object file warns and keeps defaults', () => {
  const home = tempHome()
  const file = writeKeys(home, ['escape'])
  const result = loadKeyBindings(file)
  assert.deepEqual(result.bindings, {})
  assert.match(result.warnings[0], /expected a JSON object/)
})

test('loadKeyBindings: invalid key ids warn and keep the default for that key', () => {
  const home = tempHome()
  const file = writeKeys(home, { escape: 'zzz', ctrlD: 'woops!', modelPicker: 'ctrl+l' })
  const result = loadKeyBindings(file)
  assert.deepEqual(result.bindings, { modelPicker: 'ctrl+l' })
  assert.equal(result.warnings.length, 2)
  assert.match(result.warnings[0], /"escape"/)
  assert.match(result.warnings[1], /"ctrlD"/)
})

test('loadKeyBindings: unknown fields warn and are ignored', () => {
  const home = tempHome()
  const file = writeKeys(home, { escape: 'escape', ctrlZ: 'ctrl+z' })
  const result = loadKeyBindings(file)
  assert.deepEqual(result.bindings, { escape: 'escape' })
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /unknown field "ctrlZ"/)
})

test('updateKeyBindingsFile: absent file → creates it with the update', () => {
  const home = tempHome()
  const file = keybindingsPath(home)
  const error = updateKeyBindingsFile(file, [['escape', 'ctrl+x']])
  assert.equal(error, undefined)
  const result = loadKeyBindings(file)
  assert.deepEqual(result.bindings, { escape: 'ctrl+x' })
  assert.equal(result.exists, true)
})

test('updateKeyBindingsFile: merge preserves other keys, null removes one', () => {
  const home = tempHome()
  const file = writeKeys(home, { escape: 'ctrl+x', modelPicker: 'ctrl+m', note: 'user key' })
  // Set one key and null out another in one write; unknown fields survive.
  const error = updateKeyBindingsFile(file, [['escape', null], ['ctrlD', 'ctrl+w']])
  assert.equal(error, undefined)
  const result = loadKeyBindings(file)
  assert.deepEqual(result.bindings, { ctrlD: 'ctrl+w', modelPicker: 'ctrl+m' })
})

test('updateKeyBindingsFile: a broken existing file errors instead of being clobbered', () => {
  const home = tempHome()
  const file = keybindingsPath(home)
  writeFileSync(file, '{ nope')
  const error = updateKeyBindingsFile(file, [['escape', 'ctrl+x']])
  assert.match(error, /fix or delete the file/)
  // The broken file is untouched.
  assert.equal(readText(file), '{ nope')
})

test('parseKeyInput: empty resets, valid ids pass, typos are rejected', () => {
  assert.deepEqual(parseKeyInput(''), { kind: 'unset' })
  assert.deepEqual(parseKeyInput('  '), { kind: 'unset' })
  assert.deepEqual(parseKeyInput('ctrl+x'), { kind: 'value', value: 'ctrl+x' })
  assert.deepEqual(parseKeyInput('f5'), { kind: 'value', value: 'f5' })
  const bad = parseKeyInput('zzz')
  assert.equal(bad.kind, 'error')
})

// --------------------------------------------------------------- table --

test('appHotkeyRows: default table lists the six app keys', () => {
  const rows = appHotkeyRows({})
  assert.deepEqual(rows.map(row => row.key), ['Esc', 'Ctrl+C', 'Ctrl+D', 'Ctrl+L', 'Ctrl+G', 'Tab'])
  assert.deepEqual(rows.map(row => row.field), ['escape', 'ctrlC', 'ctrlD', 'modelPicker', 'subagentViewer', 'presetCycle'])
  assert.ok(rows.every(row => !row.custom))
  assert.equal(rows[0].action, 'stop the current task — requires two presses (1st arms, 2nd within 500ms fires)')
})

test('appHotkeyRows: a custom binding replaces the key display and flags the row', () => {
  const rows = appHotkeyRows({ escape: 'ctrl+x', modelPicker: 'ctrl+m' })
  const escape = rows.find(row => row.field === 'escape')
  assert.equal(escape.key, 'Ctrl+X')
  assert.equal(escape.custom, true)
  // The rest of the table stays at its defaults, unstarred.
  const model = rows.find(row => row.key === 'Ctrl+M')
  assert.equal(model.custom, true)
  assert.equal(rows.find(row => row.key === 'Ctrl+L'), undefined)
  assert.equal(rows.find(row => row.key === 'Ctrl+C').custom, false)
  assert.equal(rows.find(row => row.key === 'Ctrl+G').custom, false)
})