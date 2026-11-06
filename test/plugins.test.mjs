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
  skippedPluginWarnings,
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

test('skippedPluginWarnings renders the compatibility gate rejection with name, requirements, host', () => {
  const skipped = bundle({
    name: 'feishu',
    error: {
      code: 'incompatible-version',
      incompatible: [{
        name: '@aiwayds/feishu',
        version: '0.17.0',
        runtimeVersion: '0.2.1-rc.5',
        requirements: { '@deepseek-ai/dsh-settings': '>=0.2.2-rc.1' },
      }],
    },
  })
  const lines = skippedPluginWarnings([bundle({ name: 'tui' }), skipped])
  assert.deepEqual(lines, [
    'plugin @aiwayds/feishu skipped: requires @deepseek-ai/dsh-settings >=0.2.2-rc.1 (host 0.2.1-rc.5)',
  ])
})

test('skippedPluginWarnings joins multiple requirements and renders one line per package', () => {
  const lines = skippedPluginWarnings([
    bundle({
      name: 'duo',
      error: {
        code: 'incompatible-version',
        incompatible: [
          {
            name: 'p1',
            version: '1.0.0',
            runtimeVersion: '0.2.1-rc.5',
            requirements: { '@deepseek-ai/dsh-settings': '>=0.2.2-rc.1', '@deepseek-ai/dsh-skill': '^0.2.2' },
          },
          { name: 'p2', version: '2.0.0', runtimeVersion: '0.2.1-rc.5', requirements: { '@deepseek-ai/dsh-settings': '>=999.0.0' } },
        ],
      },
    }),
  ])
  assert.deepEqual(lines, [
    'plugin p1 skipped: requires @deepseek-ai/dsh-settings >=0.2.2-rc.1, @deepseek-ai/dsh-skill ^0.2.2 (host 0.2.1-rc.5)',
    'plugin p2 skipped: requires @deepseek-ai/dsh-settings >=999.0.0 (host 0.2.1-rc.5)',
  ])
})

test('skippedPluginWarnings renders nothing without the rejection payload', () => {
  assert.deepEqual(skippedPluginWarnings([
    bundle(),
    bundle({ name: 'broken', error: { code: 'operation-error', message: 'load failed' } }),
    bundle({ name: 'loose', error: { incompatible: [{ name: 'x', requirements: {} }] } }),
    bundle({ name: 'empty-incompatible', error: { code: 'incompatible-version', incompatible: [] } }),
    bundle({
      name: 'no-requirements',
      error: { code: 'incompatible-version', incompatible: [{ name: 'x', version: '1.0.0', runtimeVersion: '0.2.1', requirements: {} }] },
    }),
  ]), [], 'other error codes, missing code, and requirement-less payloads stay silent')
})
