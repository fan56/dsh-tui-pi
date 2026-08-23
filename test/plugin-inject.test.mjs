/**
 * Regression guard for the 0.18.0 startup crash: the cordis plugin declared
 * `inject = ['agents', 'commands']` while its effects also touched
 * `ctx.userQuestions` and `ctx.systemPrompt`. Cordis THROWS on property
 * access for a service missing from `inject` (it is not `undefined`), so on a
 * real profile the TUI died at startup — invisible to unit tests whose fake
 * contexts expose every property.
 *
 * This test locks the contract two ways, statically against src/index.ts:
 * 1. the regression services ('userQuestions', 'systemPrompt') must stay in
 *    the inject array;
 * 2. every direct `ctx.<member>` access in index.ts must be either a declared
 *    inject service or a known non-service context member (`effect`, `get`,
 *    `root`) — so a future `ctx.<service>` touch cannot land without
 *    updating `inject`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')

/** Members of the cordis Context itself — never injected, safe to touch. */
const NON_SERVICE_MEMBERS = new Set([
  'effect',
  'get',
  'root',
])

/** Extract the string contents of the `export const inject = [...]` array. */
function parseInjectArray(src) {
  const match = src.match(/export const inject = \[([^\]]*)\]/)
  if (!match) throw new Error('src/index.ts no longer declares `export const inject = [...]`')
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1])
}

/** Strip block and line comments so commented mentions don't count as accesses. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

test('inject declares the regression services that crashed real profiles in 0.18.0', () => {
  const injected = parseInjectArray(source)
  assert.ok(injected.includes('agents'), '`agents` must stay injected')
  assert.ok(injected.includes('commands'), '`commands` must stay injected')
  assert.ok(
    injected.includes('userQuestions'),
    '`userQuestions` must be injected — cordis throws on access otherwise (0.18.0 crash)',
  )
  assert.ok(
    injected.includes('systemPrompt'),
    '`systemPrompt` must be injected — cordis throws on access otherwise (0.18.0 crash)',
  )
})

test('every ctx.<member> access in index.ts is an injected service or a known context member', () => {
  const injected = new Set(parseInjectArray(source))
  const code = stripComments(source)
  const accessed = [...code.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map(m => m[1])
  assert.ok(accessed.length > 0, 'expected at least one ctx.<member> access in index.ts')
  const undeclared = [...new Set(accessed)].filter(name => !injected.has(name) && !NON_SERVICE_MEMBERS.has(name))
  assert.deepEqual(
    undeclared,
    [],
    `ctx.${undeclared.length ? undeclared[0] : ''} is accessed but missing from inject — `
      + 'cordis throws on property access for non-injected services; add it to the inject array '
      + '(or to NON_SERVICE_MEMBERS here if it is part of the Context itself)',
  )
})
