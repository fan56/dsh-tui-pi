/**
 * Settings-browser module tests — pure helper functions, no TTY needed.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { nodeAtPath, rehydrateSchema } from '../lib/schema-model.js'
import {
  CATEGORY_MAP,
  categorizeNamespaces,
  categoryDescription,
  defaultValueFor,
  displayValue,
  fieldDescription,
  FIELD_GROUPS,
  formatValue,
  parseNumberInput,
  parseStringInput,
  parseUnionInput,
  slotFieldKeys,
  unionLiterals,
} from '../lib/settings.js'
import { Config, THEME_SETTINGS_NAMESPACE } from '../lib/theme-settings.js'

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
  'bash-sandbox',
  'pwsh-sandbox',
  'agent-loop',
  'web-search-deepseek',
  'agent-preset-registry',
  // Settings-bearing entry ids of the installed dsh plugins (Plugins
  // category) — under dsh 0.1.7 the descriptor ns IS the profile entry id.
  'dsh-mcp-adapter',
  'dsh-topics-memory',
  'dsh-vault',
  'dsh-model-sync',
  'dsh-feishu',
  'dsh-llm-proxy',
]

test('categorizeNamespaces places the full known set with no other', () => {
  assert.deepEqual(categorizeNamespaces(KNOWN_NS), [
    { id: 'agent', label: 'Agent Presets', namespaces: ['agent-preset-registry'] },
    { id: 'general', label: 'General', namespaces: ['permission'] },
    { id: 'models', label: 'Models', namespaces: ['llm-deepseek', 'llm-pi-ai', 'agent-default-model'] },
    {
      id: 'plugins',
      label: 'Plugins',
      namespaces: ['bash-sandbox', 'pwsh-sandbox', 'agent-loop', 'web-search-deepseek', 'dsh-mcp-adapter', 'dsh-topics-memory', 'dsh-vault', 'dsh-model-sync', 'dsh-feishu', 'dsh-llm-proxy'],
    },
    { id: 'dsh-tui', label: 'TUI', namespaces: ['dsh-tui'] },
  ])
})

test('categorizeNamespaces buckets unknown namespaces into trailing other', () => {
  assert.deepEqual(categorizeNamespaces(['dsh-tui', 'future-thing', 'bash-sandbox', 'llm-deepseek']), [
    { id: 'models', label: 'Models', namespaces: ['llm-deepseek'] },
    { id: 'other', label: 'Other', namespaces: ['future-thing'] },
    { id: 'plugins', label: 'Plugins', namespaces: ['bash-sandbox'] },
    { id: 'dsh-tui', label: 'TUI', namespaces: ['dsh-tui'] },
  ])
})

test('categorizeNamespaces returns only other for an all-unknown input', () => {
  assert.deepEqual(categorizeNamespaces(['future-thing']), [
    { id: 'other', label: 'Other', namespaces: ['future-thing'] },
  ])
})

test('categorizeNamespaces returns empty for empty input', () => {
  assert.deepEqual(categorizeNamespaces([]), [])
})

test('categorizeNamespaces orders categories alphabetically by canonical label', () => {
  const shuffled = [...KNOWN_NS, 'future-thing'].sort()
  assert.deepEqual(
    categorizeNamespaces(shuffled).map(cat => cat.id),
    ['agent', 'general', 'models', 'other', 'plugins', 'dsh-tui'],
  )
})

test('categorizeNamespaces dedupes duplicate input namespaces', () => {
  assert.deepEqual(categorizeNamespaces(['bash-sandbox', 'bash-sandbox', 'llm-deepseek', 'llm-deepseek']), [
    { id: 'models', label: 'Models', namespaces: ['llm-deepseek'] },
    { id: 'plugins', label: 'Plugins', namespaces: ['bash-sandbox'] },
  ])
  // A duplicated unknown namespace shows up once in other, too.
  assert.deepEqual(categorizeNamespaces(['future-thing', 'future-thing']), [
    { id: 'other', label: 'Other', namespaces: ['future-thing'] },
  ])
})

test('CATEGORY_MAP namespaces are unique across categories', () => {
  const all = CATEGORY_MAP.flatMap(def => def.namespaces)
  assert.equal(new Set(all).size, all.length, 'a namespace must map to exactly one category')
  // Every mapped namespace resolves without loss through categorizeNamespaces.
  const resolved = new Set(categorizeNamespaces(all).flatMap(cat => cat.namespaces))
  assert.equal(resolved.size, all.length)
})

test('slotFieldKeys collapses grouped fields into one slot at the first member', () => {
  const slots = slotFieldKeys('dsh-tui', [
    'language', 'theme', 'maxAgents', 'maxRounds', 'footerHints', 'registeredOnly',
  ])
  assert.deepEqual(slots, [
    { kind: 'field', key: 'language' },
    { kind: 'field', key: 'theme' },
    { kind: 'group', group: FIELD_GROUPS['dsh-tui'][0], members: ['maxAgents', 'maxRounds', 'registeredOnly'] },
    { kind: 'field', key: 'footerHints' },
  ])
})

test('slotFieldKeys passes through ungrouped namespaces and lists members in group order', () => {
  // No groups for this namespace: every key passes through untouched.
  assert.deepEqual(
    slotFieldKeys('permission', ['a', 'b']).map(slot => slot.kind),
    ['field', 'field'],
  )
  // Members list follows the group's declaration order, not the input order,
  // and only keys actually present (hidden/unknown fields never show).
  const slots = slotFieldKeys('dsh-tui', ['registeredOnly', 'maxRoundsGrace'])
  assert.equal(slots.length, 1)
  assert.equal(slots[0].kind, 'group')
  assert.deepEqual(slots[0].members, ['maxRoundsGrace', 'registeredOnly'])
  // Every declared group field is covered by exactly one group of its namespace.
  const grouped = FIELD_GROUPS['dsh-tui'].flatMap(def => def.fields)
  assert.equal(new Set(grouped).size, grouped.length, 'a field must belong to at most one group')
})

test('categoryDescription caps at max columns (width-aware clip)', () => {
  const sixty = 'x'.repeat(60)
  assert.equal(categoryDescription([sixty]), sixty)
  // Over the cap the clip keeps maxWidth columns of content; the ellipsis
  // appears only when the kept prefix leaves a column free.
  assert.equal(categoryDescription(['x'.repeat(61)]), 'x'.repeat(60))
  assert.equal(categoryDescription([sixty]).length, 60)
  assert.equal(categoryDescription(['x'.repeat(61)]).length, 60)
  // Custom max follows the same boundary.
  assert.equal(categoryDescription(['abc'], 3), 'abc')
  assert.equal(categoryDescription(['abcd'], 3), 'abc')
})

test('categoryDescription joins empty or duplicated members', () => {
  assert.equal(categoryDescription([]), '')
  assert.equal(categoryDescription(['llm-deepseek', 'llm-deepseek', 'bash-sandbox']), 'llm-deepseek, bash-sandbox')
})

test('the Config schema renders theme as a free string and panelHeight as an all-literal union', () => {
  // The entry config is DECLARED (static Config), not registered: serialize
  // it exactly like the host's describe() does and walk it like the
  // /settings browser's SettingsBrowser.root → nodeAtPath path.
  const root = rehydrateSchema(Config.toJSON())

  // Every field is volatile — the settings browser lists only volatile
  // fields, and the legacy settings.yaml import rejects a section carrying
  // any non-volatile field.
  for (const [key, node] of Object.entries(Config.toJSON().dict ?? {})) {
    assert.equal(node.meta?.volatile, true, `Config.${key} must be volatile`)
  }

  // Theme field: a free string — custom theme names (one-dark, a user's own
  // file in ~/.dsh/themes) are valid preferences, so the schema can not be an
  // all-literal union. rowKindFor maps it to 'input' (inline text editor)
  // instead of 'cycle'; the /theme picker is the friendly entry point.
  const theme = nodeAtPath(root, ['theme'])
  assert.equal(theme.type, 'string', 'theme node is a free string')

  // PanelHeight field: the five configurable heights stay an all-literal
  // union → cycle row.
  const panelHeight = nodeAtPath(root, ['panelHeight'])
  assert.equal(panelHeight.type, 'union', 'panelHeight node is a union')
  assert.deepEqual(unionLiterals(panelHeight), { values: ['1', '5', '7', '10', 'all'], all: true },
    'panelHeight is an all-literal union over the five heights → cycle row')

  // The grouped subagent fields survive serialization with their labels.
  assert.deepEqual(unionLiterals(nodeAtPath(root, ['cacheHitMode'])), { values: ['lastMessage', 'session'], all: true })
})
