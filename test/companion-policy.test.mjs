/**
 * Table-driven coverage for the companion-latest decision table. Pure module
 * — no subprocess, no env, no filesystem (same范式 as host-version.test.mjs).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { decideCompanionInstall, REASONS } from '../bin/companion-policy.mjs'

const NAME = '@aiwayds/dsh-dcp'

// Each row: [label, input, expected { action, reason, spec }]
const CASES = [
  ['latest within declared minor (fresh)',
    { declaredRange: '^0.14.0', resolved: '0.14.5' },
    { action: 'latest', reason: REASONS.LATEST, spec: `${NAME}@0.14.5` }],

  ['0.x minor jump allowed (the target scenario)',
    { declaredRange: '^0.20.1', resolved: '0.21.0', currentPin: '0.20.1' },
    { action: 'latest', reason: REASONS.LATEST, spec: `${NAME}@0.21.0` }],

  ['0.x minor jump on fresh install allowed',
    { declaredRange: '^0.9.0', resolved: '0.10.0' },
    { action: 'latest', reason: REASONS.LATEST, spec: `${NAME}@0.10.0` }],

  ['prerelease resolved version kept verbatim',
    { declaredRange: '^0.2.0', resolved: '0.3.0-rc.1' },
    { action: 'latest', reason: REASONS.LATEST, spec: `${NAME}@0.3.0-rc.1` }],

  ['switch off → declared range, disabled reason',
    { declaredRange: '^0.14.0', resolved: '0.14.5', enabled: false },
    { action: 'fallback', reason: REASONS.DISABLED, spec: null }],

  ['resolution failed (null) → declared range, unresolved reason',
    { declaredRange: '^0.14.0', resolved: null },
    { action: 'fallback', reason: REASONS.UNRESOLVED, spec: null }],

  ['resolution unparsable → declared range, unresolved reason',
    { declaredRange: '^0.14.0', resolved: 'not-a-version' },
    { action: 'fallback', reason: REASONS.UNRESOLVED, spec: null }],

  ['missing declared range → declared range, unresolved reason',
    { declaredRange: null, resolved: '0.14.5' },
    { action: 'fallback', reason: REASONS.UNRESOLVED, spec: null }],

  ['cross-major rejected → declared range, cross_major reason',
    { declaredRange: '^0.20.1', resolved: '1.0.0' },
    { action: 'fallback', reason: REASONS.CROSS_MAJOR, spec: null }],

  ['downgrade rejected → skip, downgrade reason',
    { declaredRange: '^0.20.1', resolved: '0.19.0', currentPin: '0.20.1' },
    { action: 'skip', reason: REASONS.DOWNGRADE, spec: null }],

  ['same version as pin → skip, idempotent reason',
    { declaredRange: '^0.20.1', resolved: '0.21.0', currentPin: '0.21.0' },
    { action: 'skip', reason: REASONS.IDEMPOTENT, spec: null }],

  ['switch off wins over an otherwise valid latest',
    { declaredRange: '^0.20.1', resolved: '1.0.0', enabled: false },
    { action: 'fallback', reason: REASONS.DISABLED, spec: null }],

  ['higher patch than pin still installs',
    { declaredRange: '^0.8.1', resolved: '0.8.4', currentPin: '0.8.1' },
    { action: 'latest', reason: REASONS.LATEST, spec: `${NAME}@0.8.4` }],

  ['v-prefixed resolved version normalised in spec',
    { declaredRange: '^0.14.0', resolved: 'v0.14.9' },
    { action: 'latest', reason: REASONS.LATEST, spec: `${NAME}@0.14.9` }],

  ['v-prefixed prerelease normalised without losing the suffix',
    { declaredRange: '^0.2.0', resolved: 'v0.3.0-rc.1' },
    { action: 'latest', reason: REASONS.LATEST, spec: `${NAME}@0.3.0-rc.1` }],
]

test('decideCompanionInstall: full decision table', () => {
  for (const [label, input, expected] of CASES) {
    const actual = decideCompanionInstall({ packageName: NAME, ...input })
    assert.deepEqual(actual, expected, label)
  }
})

test('decideCompanionInstall: defaults enabled to true', () => {
  const withDefault = decideCompanionInstall({ packageName: NAME, declaredRange: '^0.14.0', resolved: '0.14.5' })
  const explicit = decideCompanionInstall({ packageName: NAME, declaredRange: '^0.14.0', resolved: '0.14.5', enabled: true })
  assert.deepEqual(withDefault, explicit)
})
