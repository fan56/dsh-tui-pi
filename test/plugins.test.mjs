/**
 * Plugin manager pure-builder tests (src/plugins.ts): bundle row assembly
 * (sorting, @version labels, state badges, toggle/removable guards) and
 * ChangeResult wording. The panel is PanelHost glue, exercised on a
 * terminal.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bundleStateText,
  pluginChangeNotice,
  pluginRowViews,
} from '../lib/plugins.js'

const bundle = (over = {}) => ({
  name: 'dsh-tui-pi',
  version: '2.26.0',
  enabled: true,
  installed: true,
  optional: false,
  removable: true,
  ...over,
})

test('pluginRowViews sorts by name, labels with @version, carries state and guards', () => {
  const rows = pluginRowViews([
    bundle({ name: 'zeta' }),
    bundle({ name: 'alpha', version: undefined, enabled: false }),
    bundle({ name: 'web', readOnlyReason: 'management-required' }),
  ])
  assert.deepEqual(rows.map(row => row.name), ['alpha', 'web', 'zeta'])
  assert.equal(rows[0].label, 'alpha', 'no version → bare name')
  assert.equal(rows[2].label, 'zeta@2.26.0')
  assert.equal(rows[0].state, 'off')
  assert.equal(rows[1].toggleable, false, 'read-only rows refuse the toggle')
  assert.equal(rows[2].toggleable, true)
})

test('bundleStateText badges error and read-only, marks switch-on candidates available', () => {
  assert.equal(bundleStateText(bundle()), 'on')
  assert.equal(bundleStateText(bundle({ enabled: false })), 'off')
  assert.equal(bundleStateText(bundle({ installed: false, optional: true, enabled: false })), 'available')
  assert.equal(bundleStateText(bundle({ error: { message: 'load failed' } })), 'on ⚠ error')
  assert.equal(bundleStateText(bundle({ readOnlyReason: 'unaddressable', enabled: false })), 'off · read-only')
})

test('pluginChangeNotice phrases every application outcome', () => {
  const target = { target: 'dsh-tui-pi' }
  assert.match(pluginChangeNotice({ ...target, changed: true, application: 'applied' }), /dsh-tui-pi/)
  assert.match(pluginChangeNotice({ ...target, application: 'restart-required' }), /next start/)
  assert.match(pluginChangeNotice({ ...target, application: 'overridden' }), /override/i)
  const failed = pluginChangeNotice({
    ...target,
    application: 'failed',
    error: { message: 'pnpm missing' },
  })
  assert.ok(failed.includes('pnpm missing'), 'the management error message rides along')
  assert.match(pluginChangeNotice({ target: 'x', application: 'cancelled' }), /cancel/i)
})
