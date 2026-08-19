/**
 * Vendored schema-model helpers (src/schema-model.ts, forked from
 * @deepseek-ai/dsh-client-schema-form model.ts — see the module header).
 * These must behave exactly like the upstream helpers so the settings
 * browser keeps working when the closure lacks the original package.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Schema from '@deepseek-ai/schemastery'
import { getPath, nodeAtPath, rehydrateSchema } from '../lib/schema-model.js'

test('getPath walks objects and arrays, undefined on missing branches', () => {
  const value = { a: { b: 7 }, list: [{ name: 'x' }, { name: 'y' }] }
  assert.equal(getPath(value, ['a', 'b']), 7)
  assert.equal(getPath(value, ['list', '1', 'name']), 'y')
  assert.equal(getPath(value, ['a', 'missing']), undefined)
  assert.equal(getPath(value, ['a', 'b', 'c']), undefined, 'scalar has no children')
  assert.equal(getPath(undefined, ['a']), undefined)
  assert.equal(getPath(value, []), value, 'empty path returns the root')
})

test('nodeAtPath resolves object properties and dict inners from a rehydrated schema', () => {
  const schema = Schema.object({
    theme: Schema.union(['auto', 'light', 'dark']),
    providers: Schema.dict(Schema.object({ url: Schema.string() })),
    tags: Schema.array(String),
  })
  const root = rehydrateSchema(schema.toJSON())
  assert.equal(root.type, 'object')
  assert.equal(nodeAtPath(root, ['theme'])?.type, 'union')
  assert.equal(nodeAtPath(root, ['providers'])?.type, 'dict')
  assert.equal(nodeAtPath(root, ['providers'])?.inner?.type, 'object')
  assert.equal(nodeAtPath(root, ['providers', 'foo', 'url'])?.type, 'string')
  assert.equal(nodeAtPath(root, ['tags'])?.inner?.type, 'string')
  assert.equal(nodeAtPath(root, ['missing']), undefined, 'unknown property resolves to nothing')
  assert.equal(nodeAtPath(root, ['theme', 'nested']), undefined, 'leaf has no children')
})

test('rehydrateSchema round-trips a live validator with its semantics', () => {
  const schema = Schema.object({ name: Schema.string().required(), count: Schema.number().default(0) })
  const rehydrated = rehydrateSchema(schema.toJSON())
  // Validator behavior survives the toJSON() wire format.
  assert.deepEqual(rehydrated({ name: 'x', count: 2 }), { name: 'x', count: 2 })
  assert.deepEqual(rehydrated({ name: 'x' }), { name: 'x', count: 0 }, 'defaults apply')
  assert.throws(() => rehydrated({ count: 1 }), /name/i, 'required field enforced')
})
