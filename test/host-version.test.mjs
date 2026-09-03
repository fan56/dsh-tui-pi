/**
 * Unit tests for the host floor guard (src/host-version.ts): version parsing,
 * semver-precedence comparison on the shapes dsh ships, and the checkHostSupport
 * verdict contract (fail-open on an unresolvable closure, plain-language
 * message on an unsupported host).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  HOST_FLOOR,
  parseVersion,
  compareVersions,
  hostSupported,
  checkHostSupport,
  readHostVersion,
} from '../lib/host-version.js'

test('parseVersion accepts core, prerelease, and padded input; rejects garbage', () => {
  assert.deepEqual(parseVersion('0.1.2'), { major: 0, minor: 1, patch: 2, pre: [] })
  assert.deepEqual(parseVersion(' 0.1.2-alpha.5 '), { major: 0, minor: 1, patch: 2, pre: ['alpha', 5] })
  assert.deepEqual(parseVersion('1.2.3-rc.2'), { major: 1, minor: 2, patch: 3, pre: ['rc', 2] })
  // alphanumeric identifiers with dashes are legal semver, not garbage
  assert.deepEqual(parseVersion('0.1.2-alpha.5-unexpected'), { major: 0, minor: 1, patch: 2, pre: ['alpha', '5-unexpected'] })
  assert.equal(parseVersion('garbage'), undefined)
  assert.equal(parseVersion('0.1.2-alpha..5'), undefined)
  assert.equal(parseVersion('0.1.2-'), undefined)
  assert.equal(parseVersion('0.1'), undefined)
})

test('compareVersions orders the host lines the plugin must distinguish', () => {
  const cmp = (a, b) => compareVersions(parseVersion(a), parseVersion(b))
  // the shipped stable line (npm latest) sits below the rc floor
  assert.ok(cmp('0.1.1-rc.2', '0.1.2-alpha.4') < 0)
  assert.ok(cmp('0.1.2-rc.1', HOST_FLOOR) === 0)
  assert.ok(cmp('0.1.2-rc.2', HOST_FLOOR) > 0)
  // the retired alpha line sorts below the rc identifiers
  assert.ok(cmp('0.1.2-alpha.5', HOST_FLOOR) < 0)
  // numeric identifiers compare numerically, not lexically
  assert.ok(cmp('0.1.2-alpha.13', '0.1.2-alpha.5') > 0)
  assert.ok(cmp('0.1.2-rc.13', '0.1.2-rc.5') > 0)
  // a prerelease loses to its own stable release
  assert.ok(cmp('0.1.2-alpha.9', '0.1.2') < 0)
  assert.ok(cmp('0.1.2-rc.9', '0.1.2') < 0)
  assert.ok(cmp('0.1.2', '0.1.1') > 0)
  // alphanumeric identifiers compare lexically when kinds match
  assert.ok(cmp('0.1.1-rc.2', '0.1.1-alpha.9') > 0)
  // fewer identifiers lose when the shared prefix is equal
  assert.ok(cmp('0.1.2-alpha', '0.1.2-alpha.1') < 0)
})

test('hostSupported judges exactly the peer floor', () => {
  assert.equal(hostSupported('0.1.1-rc.2'), false)
  assert.equal(hostSupported('0.1.2-alpha.3'), false)
  assert.equal(hostSupported('0.1.2-alpha.4'), false)
  assert.equal(hostSupported('0.1.2-alpha.5'), false)
  assert.equal(hostSupported('0.1.2-rc.1'), true)
  assert.equal(hostSupported('0.1.2-rc.2'), true)
  assert.equal(hostSupported('0.1.2'), true)
  assert.equal(hostSupported('0.2.0'), true)
  assert.equal(hostSupported('garbage'), false)
})

test('checkHostSupport reports an unsupported host with the found version and the upgrade path', () => {
  const check = checkHostSupport(() => '0.1.2-alpha.5')
  assert.equal(check.ok, false)
  assert.equal(check.version, '0.1.2-alpha.5')
  assert.match(check.message, new RegExp(HOST_FLOOR.replace('.', '\\.')))
  assert.match(check.message, /found 0\.1\.2-alpha\.5/)
  assert.match(check.message, /npm install -g @deepseek-ai\/dsh@next/)
})

test('checkHostSupport accepts hosts at or above the floor', () => {
  assert.deepEqual(checkHostSupport(() => '0.1.2-rc.1'), { ok: true, version: '0.1.2-rc.1' })
  assert.deepEqual(checkHostSupport(() => '0.1.2'), { ok: true, version: '0.1.2' })
})

test('checkHostSupport fails open when the closure version is unreadable', () => {
  assert.deepEqual(checkHostSupport(() => undefined), { ok: true, version: undefined })
  assert.deepEqual(checkHostSupport(() => 'not-a-version'), { ok: true, version: undefined })
})

test('readHostVersion resolves the real dev closure and checkHostSupport agrees with hostSupported', () => {
  const version = readHostVersion()
  assert.ok(typeof version === 'string', `expected a version from the dev closure, got ${version}`)
  assert.ok(parseVersion(version))
  const check = checkHostSupport()
  assert.equal(check.ok, hostSupported(version))
})
