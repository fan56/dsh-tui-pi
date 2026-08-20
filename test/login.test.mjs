/**
 * /login + /logout pure-logic tests — no TTY, no services, no live config.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_CATALOG, catalogEntry } from '../lib/provider-catalog.js'
import {
  commitLogout,
  listLogoutCandidates,
  resolveLoginTarget,
} from '../lib/login.js'

/** A small fixed directory the match tests resolve against. */
const ENTRIES = [
  catalogEntry('openai'),
  catalogEntry('openrouter'),
  catalogEntry('opencode'),
  catalogEntry('opencode-go'),
  catalogEntry('moonshotai'),
  catalogEntry('moonshotai-cn'),
]

test('resolveLoginTarget returns [] for empty input', () => {
  assert.deepEqual(resolveLoginTarget('', ENTRIES), [])
  assert.deepEqual(resolveLoginTarget('   ', ENTRIES), [])
})

test('resolveLoginTarget matches a route id exactly, case-insensitively', () => {
  assert.deepEqual(resolveLoginTarget('openai', ENTRIES).map(e => e.id), ['openai'])
  assert.deepEqual(resolveLoginTarget('OPENAI', ENTRIES).map(e => e.id), ['openai'])
  assert.deepEqual(resolveLoginTarget('OpenCode-Go', ENTRIES).map(e => e.id), ['opencode-go'])
})

test('resolveLoginTarget matches a display name exactly, case-insensitively', () => {
  // "Moonshot AI" is the display name of moonshotai (id is not a match).
  assert.deepEqual(resolveLoginTarget('moonshot ai', ENTRIES).map(e => e.id), ['moonshotai'])
  assert.deepEqual(resolveLoginTarget('MOONSHOT AI', ENTRIES).map(e => e.id), ['moonshotai'])
})

test('resolveLoginTarget returns every prefix match (id or name), in order', () => {
  // "open" prefixes openai/openrouter/opencode/opencode-go (all ids).
  const open = resolveLoginTarget('open', ENTRIES).map(e => e.id)
  assert.deepEqual(open, ['openai', 'openrouter', 'opencode', 'opencode-go'])
  // "moonshot" is a prefix of the ids moonshotai + moonshotai-cn.
  const moonshot = resolveLoginTarget('moonshot', ENTRIES).map(e => e.id)
  assert.deepEqual(moonshot, ['moonshotai', 'moonshotai-cn'])
})

test('resolveLoginTarget keeps the entry order and identity of a prefix match', () => {
  const matched = resolveLoginTarget('open', ENTRIES)
  assert.deepEqual(matched.map(e => e.name), ['OpenAI', 'OpenRouter', 'OpenCode Zen', 'OpenCode Go'])
})

test('resolveLoginTarget returns a single unique prefix match', () => {
  assert.deepEqual(resolveLoginTarget('openr', ENTRIES).map(e => e.id), ['openrouter'])
})

test('resolveLoginTarget returns [] when nothing matches', () => {
  assert.deepEqual(resolveLoginTarget('acme-gateway', ENTRIES), [])
  assert.deepEqual(resolveLoginTarget('anthropic', ENTRIES), [])
})

test('resolveLoginTarget matches against the full real catalog', () => {
  const all = resolveLoginTarget('deep', PROVIDER_CATALOG).map(e => e.id)
  assert.deepEqual(all, ['deepseek'])
  const xai = resolveLoginTarget('x', PROVIDER_CATALOG).map(e => e.id)
  assert.deepEqual(xai, ['xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'xai'])
})

// ---------------------------------------------------------------- logout --

const PROVIDERS = [
  { id: 'anthropic', ref: 'ANTHROPIC_API_KEY' },
  { id: 'openai', ref: 'OPENAI_API_KEY', displayName: 'My Gateway' },
  { id: 'opencode-go', ref: 'OPENCODE_GO_API_KEY' },
  { id: 'zai-coding-cn', ref: 'ZAI_CODING_CN_API_KEY' },
]

test('listLogoutCandidates filters to configured refs and resolves labels', () => {
  const loggedIn = listLogoutCandidates(PROVIDERS, new Set(['OPENAI_API_KEY', 'OPENCODE_GO_API_KEY']))
  assert.deepEqual(loggedIn, [
    { id: 'openai', ref: 'OPENAI_API_KEY', name: 'My Gateway' },
    { id: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', name: 'OpenCode Go' },
  ])
})

test('listLogoutCandidates falls back to catalog name then route id', () => {
  const loggedIn = listLogoutCandidates(PROVIDERS, new Set(['ZAI_CODING_CN_API_KEY', 'ANTHROPIC_API_KEY']))
  // Anthropic has a catalog name; zai-coding-cn's catalog name is "Z.AI Coding CN".
  assert.deepEqual(loggedIn, [
    { id: 'anthropic', ref: 'ANTHROPIC_API_KEY', name: 'Anthropic' },
    { id: 'zai-coding-cn', ref: 'ZAI_CODING_CN_API_KEY', name: 'Z.AI Coding CN' },
  ])
})

test('listLogoutCandidates returns [] when nothing is configured', () => {
  assert.deepEqual(listLogoutCandidates(PROVIDERS, new Set()), [])
})

test('listLogoutCandidates returns [] for an empty provider list', () => {
  assert.deepEqual(listLogoutCandidates([], new Set(['OPENAI_API_KEY'])), [])
})

test('listLogoutCandidates treats an empty displayName as absent', () => {
  const providers = [
    { id: 'openai', ref: 'OPENAI_API_KEY', displayName: '' },
    { id: 'anthropic', ref: 'ANTHROPIC_API_KEY', displayName: undefined },
  ]
  const loggedIn = listLogoutCandidates(providers, new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']))
  // Both fall through to the catalog name, like providerRowView's label rule.
  assert.deepEqual(loggedIn, [
    { id: 'openai', ref: 'OPENAI_API_KEY', name: 'OpenAI' },
    { id: 'anthropic', ref: 'ANTHROPIC_API_KEY', name: 'Anthropic' },
  ])
})

test('listLogoutCandidates preserves the provider list order', () => {
  const reversed = [...PROVIDERS].reverse()
  const loggedIn = listLogoutCandidates(reversed, new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']))
  assert.deepEqual(loggedIn.map(c => c.id), ['openai', 'anthropic'])
})

// ------------------------------------------------------------ commitLogout --

/** Recording seams: call order + configurable outcomes, no real services. */
function recordingSeams({ unsetError, profileError } = {}) {
  const calls = []
  return {
    calls,
    unset: async ref => {
      calls.push(`unset:${ref}`)
      if (unsetError !== undefined) throw new Error(unsetError)
    },
    removeProfile: async id => {
      calls.push(`removeProfile:${id}`)
      return profileError
    },
  }
}

const CANDIDATE = { id: 'openai', ref: 'OPENAI_API_KEY', name: 'OpenAI' }

test('commitLogout unsets the key first, then removes the profile', async () => {
  const seams = recordingSeams()
  const result = await commitLogout(CANDIDATE, seams)
  assert.deepEqual(result, { kind: 'removed', name: 'OpenAI' })
  assert.deepEqual(seams.calls, ['unset:OPENAI_API_KEY', 'removeProfile:openai'])
})

test('commitLogout never touches the profile when the unset fails', async () => {
  const seams = recordingSeams({ unsetError: 'store is read-only' })
  const result = await commitLogout(CANDIDATE, seams)
  assert.deepEqual(result, { kind: 'failed', name: 'OpenAI', cause: 'store is read-only' })
  assert.deepEqual(seams.calls, ['unset:OPENAI_API_KEY'])
})

test('commitLogout reports removed-incomplete when the profile write fails after the unset', async () => {
  const seams = recordingSeams({ profileError: 'revision mismatch' })
  const result = await commitLogout(CANDIDATE, seams)
  assert.deepEqual(result, { kind: 'removed-incomplete', name: 'OpenAI', error: 'revision mismatch' })
  // The unset ran and stays — the key is gone even though the profile did not.
  assert.deepEqual(seams.calls, ['unset:OPENAI_API_KEY', 'removeProfile:openai'])
})
