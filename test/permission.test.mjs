/**
 * permission.ts unit tests — display-name conventions (mirroring the web
 * client's presentation) and picker option assembly.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { displayPermissionPreset, displayPresetName, permissionItems } from '../lib/permission.js'

test('displayPresetName: kebab-case names become Title Case', () => {
  assert.equal(displayPresetName('workspace-write'), 'Workspace Write')
  assert.equal(displayPresetName('read-only'), 'Read Only')
  assert.equal(displayPresetName('danger-full-access'), 'Danger Full Access')
  assert.equal(displayPresetName('full'), 'Full')
})

test('displayPresetName: non-kebab names pass through unchanged', () => {
  assert.equal(displayPresetName('Read Only'), 'Read Only')
  assert.equal(displayPresetName('full_access'), 'full_access')
  assert.equal(displayPresetName(''), '')
})

test('displayPermissionPreset: danger-full-access gets the product label', () => {
  assert.equal(displayPermissionPreset('danger-full-access', 'danger-full-access'), 'Full access')
  // The product label wins even over a host-supplied pretty name.
  assert.equal(displayPermissionPreset('danger-full-access', 'Danger Full Access'), 'Full access')
})

test('displayPermissionPreset: other presets use the conventional name', () => {
  assert.equal(displayPermissionPreset('read-only', 'read-only'), 'Read Only')
  assert.equal(displayPermissionPreset('custom', 'Custom'), 'Custom')
  assert.equal(displayPermissionPreset('workspace-write', 'Workspace Write'), 'Workspace Write')
})

/** Minimal PermissionPresetService stand-in (optionOf/resolve semantics mirror dsh's). */
function stubPresets(specs, names) {
  const order = names ?? Object.keys(specs)
  return {
    names: [...order],
    optionOf(name) {
      if (name === 'custom') {
        return {
          value: 'custom',
          name: 'Custom',
          description: 'Current sandbox and approval settings do not match a preset.',
        }
      }
      const spec = specs[name]
      if (spec === undefined) throw new Error(`unknown preset "${name}"`)
      return {
        value: name,
        name: spec.name ?? name,
        ...(spec.description !== undefined ? { description: spec.description } : {}),
      }
    },
    resolve(name) {
      const spec = specs[name]
      if (spec === undefined) throw new Error(`unknown preset "${name}"`)
      return spec
    },
  }
}

const PRESET_TABLE = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask', name: 'Workspace Write' },
  'danger-full-access': {
    sandbox: 'danger-full-access',
    approval: 'never',
    description: 'Full access to the workspace and external commands.',
  },
}

test('permissionItems: table order with labels and fallback descriptions', () => {
  const items = permissionItems(stubPresets(PRESET_TABLE), 'workspace-write')
  assert.deepEqual(items.map(item => item.value), ['read-only', 'workspace-write', 'danger-full-access'])
  // No configured name: the label falls back to the kebab-cased key.
  assert.equal(items[0].label, 'Read Only')
  // A host-configured name wins over the kebab-case rendering.
  assert.equal(items[1].label, 'Workspace Write')
  // danger-full-access gets the product label regardless of configuration.
  assert.equal(items[2].label, 'Full access')
})

test('permissionItems: description falls back to the resolved knob bundle', () => {
  const items = permissionItems(stubPresets(PRESET_TABLE), 'workspace-write')
  assert.equal(items[0].description, 'sandbox: read-only · approval: ask')
  assert.equal(items[1].description, 'sandbox: workspace-write · approval: ask')
  // A configured description is kept as-is.
  assert.equal(items[2].description, 'Full access to the workspace and external commands.')
})

test('permissionItems: custom is appended exactly while it is current', () => {
  const items = permissionItems(stubPresets(PRESET_TABLE), 'custom')
  assert.equal(items.length, 4)
  const custom = items[3]
  assert.equal(custom.value, 'custom')
  assert.equal(custom.label, 'Custom')
  assert.equal(custom.description, 'Current sandbox and approval settings do not match a preset.')
})

test('permissionItems: no custom row when a preset is current', () => {
  const items = permissionItems(stubPresets(PRESET_TABLE), 'read-only')
  assert.deepEqual(items.map(item => item.value), ['read-only', 'workspace-write', 'danger-full-access'])
})

test('permissionItems: undefined current adds no custom row', () => {
  const items = permissionItems(stubPresets(PRESET_TABLE), undefined)
  assert.equal(items.length, 3)
})
