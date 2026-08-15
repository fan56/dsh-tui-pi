/**
 * Settings-browser module tests — pure helper functions, no TTY needed.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Schema from '@deepseek-ai/schemastery'
import {
  CATEGORY_MAP,
  categorizeNamespaces,
  categoryDescription,
  defaultValueFor,
  displayValue,
  fieldDescription,
  formatValue,
  parseNumberInput,
  parseStringInput,
  parseUnionInput,
  unionLiterals,
} from '../lib/settings.js'

test('formatValue handles every JSON kind', () => {
  assert.equal(formatValue(undefined), '(unset)')
  assert.equal(formatValue(null), 'null')
  assert.equal(formatValue('openai'), 'openai')
  assert.equal(formatValue(42), '42')
  assert.equal(formatValue(false), 'false')
  assert.equal(formatValue([]), '[]')
  assert.equal(formatValue([1, 2]), '[2 items]')
  assert.equal(formatValue({}), '{}')
  assert.equal(formatValue({ a: 1, b: 2 }), '{2 keys}')
})

test('displayValue renders literal vocabulary', () => {
  assert.equal(displayValue('enabled'), 'enabled')
  assert.equal(displayValue(1), '1')
  assert.equal(displayValue(null), 'null')
})

test('unionLiterals extracts literal branches only', () => {
  const all = Schema.union(['a', 'b'])
  assert.deepEqual(unionLiterals(all), { values: ['a', 'b'], all: true })
  const mixed = Schema.union([Schema.const(1), Schema.string()])
  assert.deepEqual(unionLiterals(mixed), { values: [1], all: false })
  assert.deepEqual(unionLiterals(Schema.union([])), { values: [], all: false })
})

test('parseNumberInput accepts numbers and rejects garbage', () => {
  assert.deepEqual(parseNumberInput('42'), { kind: 'value', value: 42 })
  assert.deepEqual(parseNumberInput('-1.5'), { kind: 'value', value: -1.5 })
  assert.deepEqual(parseNumberInput('  7 '), { kind: 'value', value: 7 })
  assert.deepEqual(parseNumberInput(''), { kind: 'unset' })
  assert.deepEqual(parseNumberInput('  '), { kind: 'unset' })
  assert.match(parseNumberInput('abc').error ?? '', /expected a number/)
  assert.match(parseNumberInput('Infinity').error ?? '', /expected a number/)
})

test('parseNumberInput is decimal-only (no hex, octal, or bare nonsense)', () => {
  // Number() would silently accept these; a settings field promises decimal.
  assert.match(parseNumberInput('0x10').error ?? '', /expected a number/)
  assert.match(parseNumberInput('0b101').error ?? '', /expected a number/)
  assert.match(parseNumberInput('0o17').error ?? '', /expected a number/)
  assert.match(parseNumberInput('12px').error ?? '', /expected a number/)
  // Scientific notation stays decimal and valid.
  assert.deepEqual(parseNumberInput('1e3'), { kind: 'value', value: 1000 })
  assert.deepEqual(parseNumberInput('-2.5E-2'), { kind: 'value', value: -0.025 })
})

test('parseStringInput keeps verbatim text, empty unsets', () => {
  assert.deepEqual(parseStringInput('deepseek-v4'), { kind: 'value', value: 'deepseek-v4' })
  assert.deepEqual(parseStringInput(' padded '), { kind: 'value', value: ' padded ' })
  assert.deepEqual(parseStringInput(''), { kind: 'unset' })
})

test('parseUnionInput accepts JSON and falls back to string branches', () => {
  const mixed = Schema.union([Schema.string(), Schema.number()])
  assert.deepEqual(parseUnionInput('42', mixed), { kind: 'value', value: 42 })
  assert.deepEqual(parseUnionInput('true', mixed), { kind: 'value', value: true })
  assert.deepEqual(parseUnionInput('hello', mixed), { kind: 'value', value: 'hello' })
  assert.deepEqual(parseUnionInput('', mixed), { kind: 'unset' })
  // No string branch → bare words are rejected.
  const numeric = Schema.union([Schema.number(), Schema.boolean()])
  assert.match(parseUnionInput('hello', numeric).error ?? '', /expected a JSON value/)
})

test('defaultValueFor seeds dict keys from schema defaults and types', () => {
  assert.equal(defaultValueFor(Schema.string()), '')
  assert.equal(defaultValueFor(Schema.number()), 0)
  assert.equal(defaultValueFor(Schema.boolean()), false)
  assert.deepEqual(defaultValueFor(Schema.array(Schema.string())), [])
  assert.deepEqual(defaultValueFor(Schema.object({})), {})
  assert.deepEqual(defaultValueFor(Schema.dict(Schema.string())), {})
  assert.equal(defaultValueFor(Schema.string().default('x')), 'x')
  assert.equal(defaultValueFor(Schema.union(['on', 'off'])), 'on')
})

test('fieldDescription surfaces meta markers', () => {
  const node = Schema.string()
    .required()
    .description('Provider id')
    .role('secret')
  const text = fieldDescription(node, true)
  assert.ok(text.includes('Provider id'))
  assert.ok(text.includes('required'))
  assert.ok(text.includes('secret'))
  assert.ok(text.includes('user-set'))
  // Deprecated/experimental flags and numeric bounds.
  const bounds = Schema.number().min(1).max(10).step(1).deprecated()
  const boundText = fieldDescription(bounds, false)
  assert.ok(boundText.includes('min: 1'))
  assert.ok(boundText.includes('max: 10'))
  assert.ok(boundText.includes('step: 1'))
  assert.ok(boundText.includes('deprecated'))
})

const KNOWN_NS = [
  'permission',
  'dsh-tui',
  'llm-deepseek',
  'llm-pi-ai',
  'agent-default-model',
  'shell',
  'agent-loop',
  'web-search-deepseek',
  'agent-presets',
]

test('categorizeNamespaces places the full known set with no other', () => {
  assert.deepEqual(categorizeNamespaces(KNOWN_NS), [
    { id: 'general', label: '通用 General', namespaces: ['permission', 'dsh-tui'] },
    { id: 'models', label: '模型 Models', namespaces: ['llm-deepseek', 'llm-pi-ai', 'agent-default-model'] },
    { id: 'plugins', label: '插件 Plugins', namespaces: ['shell', 'agent-loop', 'web-search-deepseek'] },
    { id: 'agent', label: 'Agent 设置 Agent Presets', namespaces: ['agent-presets'] },
  ])
})

test('categorizeNamespaces buckets unknown namespaces into trailing other', () => {
  assert.deepEqual(categorizeNamespaces(['dsh-tui', 'future-thing', 'shell', 'llm-deepseek']), [
    { id: 'general', label: '通用 General', namespaces: ['dsh-tui'] },
    { id: 'models', label: '模型 Models', namespaces: ['llm-deepseek'] },
    { id: 'plugins', label: '插件 Plugins', namespaces: ['shell'] },
    { id: 'other', label: '其他 Other', namespaces: ['future-thing'] },
  ])
})

test('categorizeNamespaces returns only other for an all-unknown input', () => {
  assert.deepEqual(categorizeNamespaces(['future-thing']), [
    { id: 'other', label: '其他 Other', namespaces: ['future-thing'] },
  ])
})

test('categorizeNamespaces returns an empty list for empty input', () => {
  assert.deepEqual(categorizeNamespaces([]), [])
})

test('categorizeNamespaces orders categories general, models, plugins, agent, other', () => {
  const shuffled = [...KNOWN_NS, 'future-thing'].sort()
  assert.deepEqual(
    categorizeNamespaces(shuffled).map(cat => cat.id),
    ['general', 'models', 'plugins', 'agent', 'other'],
  )
})

test('categorizeNamespaces dedupes duplicate input namespaces', () => {
  assert.deepEqual(categorizeNamespaces(['shell', 'shell', 'llm-deepseek', 'llm-deepseek']), [
    { id: 'models', label: '模型 Models', namespaces: ['llm-deepseek'] },
    { id: 'plugins', label: '插件 Plugins', namespaces: ['shell'] },
  ])
  // A duplicated unknown namespace shows up once in other, too.
  assert.deepEqual(categorizeNamespaces(['future-thing', 'future-thing']), [
    { id: 'other', label: '其他 Other', namespaces: ['future-thing'] },
  ])
})

test('CATEGORY_MAP namespaces are unique across categories', () => {
  const all = CATEGORY_MAP.flatMap(def => def.namespaces)
  assert.equal(new Set(all).size, all.length, 'a namespace must map to exactly one category')
  // Every mapped namespace resolves without loss through categorizeNamespaces.
  const resolved = new Set(categorizeNamespaces(all).flatMap(cat => cat.namespaces))
  assert.equal(resolved.size, all.length)
})

test('categoryDescription caps at max, truncating with an ellipsis', () => {
  const sixty = 'x'.repeat(60)
  assert.equal(categoryDescription([sixty]), sixty)
  assert.equal(categoryDescription(['x'.repeat(61)]), 'x'.repeat(59) + '…')
  assert.equal(categoryDescription([sixty]).length, 60)
  assert.equal(categoryDescription(['x'.repeat(61)]).length, 60)
  // Custom max follows the same boundary.
  assert.equal(categoryDescription(['abc'], 3), 'abc')
  assert.equal(categoryDescription(['abcd'], 3), 'ab…')
})

test('categoryDescription joins empty or duplicated members', () => {
  assert.equal(categoryDescription([]), '')
  assert.equal(categoryDescription(['llm-deepseek', 'llm-deepseek', 'shell']), 'llm-deepseek, shell')
})
