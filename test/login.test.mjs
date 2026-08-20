/**
 * /login + /logout pure-logic tests — no TTY, no services, no live config.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_CATALOG, catalogEntry } from '../lib/provider-catalog.js'
import {
  commitLogout,
  handDeclaredLogouts,
  listLogoutCandidates,
  logoutCandidatesFromSection,
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
    { id: 'openai', ref: 'OPENAI_API_KEY', name: 'My Gateway', declared: false },
    { id: 'opencode-go', ref: 'OPENCODE_GO_API_KEY', name: 'OpenCode Go', declared: false },
  ])
})

test('listLogoutCandidates falls back to catalog name then route id', () => {
  const loggedIn = listLogoutCandidates(PROVIDERS, new Set(['ZAI_CODING_CN_API_KEY', 'ANTHROPIC_API_KEY']))
  // Anthropic has a catalog name; zai-coding-cn's catalog name is "Z.AI Coding CN".
  assert.deepEqual(loggedIn, [
    { id: 'anthropic', ref: 'ANTHROPIC_API_KEY', name: 'Anthropic', declared: false },
    { id: 'zai-coding-cn', ref: 'ZAI_CODING_CN_API_KEY', name: 'Z.AI Coding CN', declared: false },
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
    { id: 'openai', ref: 'OPENAI_API_KEY', name: 'OpenAI', declared: false },
    { id: 'anthropic', ref: 'ANTHROPIC_API_KEY', name: 'Anthropic', declared: false },
  ])
})

test('listLogoutCandidates preserves the provider list order', () => {
  const reversed = [...PROVIDERS].reverse()
  const loggedIn = listLogoutCandidates(reversed, new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']))
  assert.deepEqual(loggedIn.map(c => c.id), ['openai', 'anthropic'])
})

test('listLogoutCandidates carries the hand-declared flag through', () => {
  const providers = [
    { id: 'openai', ref: 'OPENAI_API_KEY', declared: true },
    { id: 'anthropic', ref: 'ANTHROPIC_API_KEY' },
    { id: 'deepseek', ref: 'DEEPSEEK_API_KEY', declared: false },
  ]
  const loggedIn = listLogoutCandidates(providers, new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY']))
  assert.deepEqual(loggedIn.map(c => [c.id, c.declared]), [
    ['openai', true],
    ['anthropic', false],
    ['deepseek', false],
  ])
})

// -------------------------------------------------- logoutCandidatesFromSection --

test('logoutCandidatesFromSection prefers the profile apiKeyEnv over the derived ref', () => {
  const candidates = logoutCandidatesFromSection({
    providers: {
      openai: { apiKeyEnv: 'ACME_GATEWAY_KEY' },
      anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
    },
  })
  // A hand-edited profile naming its own ref must be unset at that ref —
  // deriving from the route id would unset an unrelated key.
  assert.deepEqual(candidates, [
    { id: 'openai', ref: 'ACME_GATEWAY_KEY', displayName: undefined },
    { id: 'anthropic', ref: 'ANTHROPIC_API_KEY', displayName: undefined },
  ])
})

test('logoutCandidatesFromSection falls back to the derived ref when apiKeyEnv is absent or empty', () => {
  const candidates = logoutCandidatesFromSection({
    providers: {
      'opencode-go': {},
      openai: { apiKeyEnv: '' },
    },
  })
  assert.deepEqual(candidates.map(c => c.ref), ['OPENCODE_GO_API_KEY', 'OPENAI_API_KEY'])
})

test('logoutCandidatesFromSection reads displayName and tolerates missing shapes', () => {
  assert.deepEqual(
    logoutCandidatesFromSection({ providers: { openai: { displayName: 'My Gateway' } } }),
    [{ id: 'openai', ref: 'OPENAI_API_KEY', displayName: 'My Gateway' }],
  )
  assert.deepEqual(logoutCandidatesFromSection({}), [])
  assert.deepEqual(logoutCandidatesFromSection(undefined), [])
  assert.deepEqual(logoutCandidatesFromSection({ providers: 'nope' }), [])
})

// -------------------------------------------------------- handDeclaredLogouts --

test('handDeclaredLogouts follows the live directory declared flags', () => {
  const directory = [
    { provider: 'openai', declared: false },
    { provider: 'acme-gateway', declared: true },
    { provider: 'deepseek' }, // flag absent — not declared
  ]
  const declared = handDeclaredLogouts(['openai', 'acme-gateway', 'deepseek', 'zai'], directory)
  assert.deepEqual([...declared], ['acme-gateway'])
})

test('handDeclaredLogouts falls back to the static catalog without a directory', () => {
  const declared = handDeclaredLogouts(['openai', 'acme-gateway', 'opencode-go'], undefined)
  // Unknown route keys are hand declarations; catalog routes are not.
  assert.deepEqual([...declared], ['acme-gateway'])
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

const CANDIDATE = { id: 'openai', ref: 'OPENAI_API_KEY', name: 'OpenAI', declared: false }

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

test('commitLogout drops only the key when the profile seam is omitted (hand-declared route)', async () => {
  const calls = []
  const seams = {
    unset: async ref => {
      calls.push(`unset:${ref}`)
    },
    // no removeProfile — the hand-declared route keeps its profile
  }
  const result = await commitLogout({ ...CANDIDATE, declared: true }, seams)
  assert.deepEqual(result, { kind: 'removed-key-only', name: 'OpenAI' })
  assert.deepEqual(calls, ['unset:OPENAI_API_KEY'])
})

test('commitLogout still reports failed (with cause) without a profile seam when the unset fails', async () => {
  const seams = {
    unset: async () => {
      throw new Error('env-shadowed ref')
    },
  }
  const result = await commitLogout({ ...CANDIDATE, declared: true }, seams)
  assert.deepEqual(result, { kind: 'failed', name: 'OpenAI', cause: 'env-shadowed ref' })
})
