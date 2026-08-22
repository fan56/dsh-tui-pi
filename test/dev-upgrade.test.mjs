/**
 * dev-upgrade.mjs pure-function tests — scripts/dev-upgrade.mjs (profile
 * upgrade helper). The injectable exports — parseArgs, bumpDependencyText
 * and assertOnlyDependencyChanged — are exercised directly against the
 * source module (a pure ESM .mjs; no build step involved): argument
 * parsing, pin-only rewrite with formatting preservation, refusal of
 * non-pin refs, and the exactly-one-change safety check.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertOnlyDependencyChanged,
  bumpDependencyText,
  parseArgs,
} from '../scripts/dev-upgrade.mjs'

const PROFILE_MANIFEST = `{
  "name": "dsh-profile-tui",
  "private": true,
  "dependencies": {
    "@aiwayds/dsh-dcp": "^0.5.1",
    "@aiwayds/dsh-tui-pi": "0.15.0"
  },
  "scripts": {
    "postinstall": "node scripts/link-dsh-closure.mjs"
  }
}
`

test('parseArgs reads version, --profile and --dry-run', () => {
  assert.deepEqual(parseArgs([]), { version: 'latest', profile: 'tui', dryRun: false })
  assert.deepEqual(parseArgs(['0.16.0']), { version: '0.16.0', profile: 'tui', dryRun: false })
  assert.deepEqual(parseArgs(['latest', '--dry-run']), {
    version: 'latest',
    profile: 'tui',
    dryRun: true,
  })
  assert.deepEqual(parseArgs(['--profile', 'demo', '1.2.3']), {
    version: '1.2.3',
    profile: 'demo',
    dryRun: false,
  })
})

test('parseArgs rejects unknown options and extra positional args', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown option/)
  assert.throws(() => parseArgs(['1.0.0', '2.0.0']), /extra argument/)
  assert.throws(() => parseArgs(['--profile']), /requires a value/)
})

test('bumpDependencyText rewrites only the pinned value, byte-for-byte elsewhere', () => {
  const updated = bumpDependencyText(PROFILE_MANIFEST, '@aiwayds/dsh-tui-pi', '0.16.0')
  assert.equal(
    updated,
    PROFILE_MANIFEST.replace('"@aiwayds/dsh-tui-pi": "0.15.0"', '"@aiwayds/dsh-tui-pi": "0.16.0"'),
    'everything except the one version literal is preserved verbatim',
  )
  // The result stays valid JSON with the sibling dependency untouched.
  const parsed = JSON.parse(updated)
  assert.equal(parsed.dependencies['@aiwayds/dsh-tui-pi'], '0.16.0')
  assert.equal(parsed.dependencies['@aiwayds/dsh-dcp'], '^0.5.1')
})

test('bumpDependencyText refuses missing keys and non-pin refs', () => {
  assert.throws(
    () => bumpDependencyText('{}', '@aiwayds/dsh-tui-pi', '1.0.0'),
    /not found in the profile/,
  )
  for (const ref of ['file:./x.tgz', 'link:../dsh-tui-pi', '^0.15.0', 'next']) {
    const source = PROFILE_MANIFEST.replace('0.15.0', ref)
    assert.throws(
      () => bumpDependencyText(source, '@aiwayds/dsh-tui-pi', '1.0.0'),
      /not a plain pinned version/,
      `refuses ${ref}`,
    )
  }
})

test('assertOnlyDependencyChanged accepts exactly the one intended change', () => {
  const before = PROFILE_MANIFEST
  const after = bumpDependencyText(before, '@aiwayds/dsh-tui-pi', '0.16.0')
  assert.doesNotThrow(() =>
    assertOnlyDependencyChanged(before, after, '@aiwayds/dsh-tui-pi', '0.16.0'),
  )
  // Any second change trips the guard.
  const tampered = after.replace('"private": true', '"private": false')
  assert.throws(
    () => assertOnlyDependencyChanged(before, tampered, '@aiwayds/dsh-tui-pi', '0.16.0'),
    /something other than the target dependency changed/,
  )
  // A no-op write or a wrong expected value also trip it.
  assert.throws(
    () => assertOnlyDependencyChanged(before, before, '@aiwayds/dsh-tui-pi', '0.15.0'),
    /nothing was rewritten/,
  )
  assert.throws(
    () => assertOnlyDependencyChanged(before, after, '@aiwayds/dsh-tui-pi', '9.9.9'),
    /did not become/,
  )
})
