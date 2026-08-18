/**
 * Skill-invocation module tests — pure helpers and the frontmatter toggle
 * writer, no TTY/dsh runtime needed. Runs against the built lib/.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applySkillFrontmatter,
  badgeText,
  buildNativeSkillCandidates,
  buildSkillCompletionCandidates,
  clampScrollOffset,
  clampSkillCursor,
  completionLabel,
  completionName,
  filterSkillRows,
  itemKind,
  isExplicitSkillItem,
  isPrintableInput,
  isSkillCompletionItem,
  isUserSkill,
  mergeMixedSkillItems,
  parseSkillCommand,
  readSkillToggle,
  skillCompletionQuery,
  skillDisableUpdates,
  skillEnableUpdates,
  skillEnabled,
  skillGesture,
  skillJumpCursor,
  skillPanelRowLine,
  skillSettingRowLabel,
  skillToggleEnabled,
  sortCompletionItems,
} from '../lib/skills.js'

const enabled = { invocation: { modelInvocable: true, userInvocable: true } }
const modelOnly = { invocation: { modelInvocable: true, userInvocable: false } }
const userOnly = { invocation: { modelInvocable: false, userInvocable: true } }
const disabled = { invocation: { modelInvocable: false, userInvocable: false } }

// ------------------------------------------------------------- parsing / labels --

test('parseSkillCommand parses /skill:<name> into an invoke', () => {
  assert.deepEqual(parseSkillCommand('/skill:data-analysis'), { kind: 'invoke', name: 'data-analysis' })
  assert.deepEqual(parseSkillCommand('/skill:data-analysis '), { kind: 'invoke', name: 'data-analysis' })
  assert.deepEqual(parseSkillCommand('  /skill:lark-base  '), { kind: 'invoke', name: 'lark-base' })
})

test('parseSkillCommand maps a bare /skill to picker', () => {
  assert.deepEqual(parseSkillCommand('/skill'), { kind: 'picker' })
  assert.deepEqual(parseSkillCommand('/skill '), { kind: 'picker' })
})

test('parseSkillCommand rejects non-skill and malformed names', () => {
  assert.equal(parseSkillCommand('/model'), undefined)
  assert.equal(parseSkillCommand('hello world'), undefined)
  // A trailing colon with no name is malformed, not a picker.
  assert.equal(parseSkillCommand('/skill:'), undefined)
  // Uppercase, underscore and multi-segment names are outside the public
  // kebab skill-name grammar → a malformed direct invocation.
  assert.equal(parseSkillCommand('/skill:DataAnalysis'), undefined)
  assert.equal(parseSkillCommand('/skill:data_analysis'), undefined)
  assert.equal(parseSkillCommand('/skill:data/analysis'), undefined)
  assert.equal(parseSkillCommand('/skill:a b'), undefined)
})

test('skillGesture builds the harness-native /name gesture line', () => {
  assert.equal(skillGesture('data-analysis'), '/data-analysis ')
  assert.equal(skillGesture('lark-base'), '/lark-base ')
})

// Regression: submit() intercepts any line whose lowered name is `skill` or a
// `skill:` prefix, INCLUDING lines that are not a valid skill command (args,
// uppercase). parseSkillCommand must reject those (so the caller surfaces a
// usage notice rather than silently dropping the user's input), and the prefix
// must not leak through the name regex into a half-baked invoke.
test('parseSkillCommand rejects skill-shaped lines with arguments', () => {
  assert.equal(parseSkillCommand('/skill some-args'), undefined)
  assert.equal(parseSkillCommand('/skill --list'), undefined)
  assert.equal(parseSkillCommand('/skill:foo bar'), undefined)
  assert.equal(parseSkillCommand('/skill list'), undefined)
})

test('parseSkillCommand rejects case-mismatched skill commands', () => {
  // The submit() interception lowercases the first token, so /SKILL and
  // /Skill:foo both reach the skill path; the case-sensitive grammar must not
  // accept them as invocations (they need an explicit usage notice instead).
  assert.equal(parseSkillCommand('/SKILL'), undefined)
  assert.equal(parseSkillCommand('/SKILL:foo'), undefined)
  assert.equal(parseSkillCommand('/Skill:foo'), undefined)
})

test('skillCompletionQuery identifies skill completion tokens', () => {
  assert.equal(skillCompletionQuery('skill'), '')
  assert.equal(skillCompletionQuery('skill:da'), 'da')
  assert.equal(skillCompletionQuery('SKILL:data'), 'data')
  assert.equal(skillCompletionQuery('model'), undefined)
  assert.equal(skillCompletionQuery('data'), undefined)
})

// Regression: tokenAtCursor hands the provider a token with its leading `/`
// (the canonical `/skill:da` shape), which must not defeat the match.
test('skillCompletionQuery accepts the leading-slash token from tokenAtCursor', () => {
  assert.equal(skillCompletionQuery('/skill'), '')
  assert.equal(skillCompletionQuery('/skill:da'), 'da')
  assert.equal(skillCompletionQuery('/SKILL:data'), 'data')
  assert.equal(skillCompletionQuery('/model'), undefined)
  assert.equal(skillCompletionQuery('/data'), undefined)
})

test('skillEnabled requires both invocation controls', () => {
  assert.equal(skillEnabled(enabled), true)
  assert.equal(skillEnabled(modelOnly), false)
  assert.equal(skillEnabled(userOnly), false)
  assert.equal(skillEnabled(disabled), false)
})

test('isUserSkill reflects only the user face', () => {
  assert.equal(isUserSkill(enabled), true)
  assert.equal(isUserSkill(userOnly), true)
  assert.equal(isUserSkill(modelOnly), false)
  assert.equal(isUserSkill(disabled), false)
})

// ------------------------------------------------------------- completion items --

test('badgeText pads every row to the widest tag for aligned names', () => {
  // `[skill]` is the widest tag; `[cmd]` is padded to the same width.
  const widths = new Set([badgeText('explicit-skill').length, badgeText('native-skill').length, badgeText('command').length])
  assert.equal(widths.size, 1)
  assert.equal(badgeText('explicit-skill'), '[skill]')
  assert.equal(badgeText('native-skill'), '[skill]')
  assert.equal(badgeText('command'), '[cmd]  ')
})

test('completionLabel prefixes an aligned badge to the candidate value', () => {
  // The badge tag is always the fixed width (see badgeText), so every row
  // starts its value at the same column; the raw value itself is preserved
  // verbatim (so the explicit form keeps the full `/skill:<name>`).
  assert.equal(completionLabel('explicit-skill', '/skill:data-analysis'), '[skill] /skill:data-analysis')
  assert.equal(completionLabel('command', '/model'), '[cmd]   /model')
})

test('skillSettingRowLabel leads with a fixed-width state then the [skill] row', () => {
  // `false` (width 5) and `true` (width 4) both pad to SKILL_STATE_WIDTH, so
  // every skill name starts on the same column regardless of the state.
  assert.equal(skillSettingRowLabel(false, 'data-analysis'), 'false [skill] data-analysis')
  assert.equal(skillSettingRowLabel(true, 'data-analysis'), 'true  [skill] data-analysis')
})

test('skillSettingRowLabel states align across skills and with completionLabel', () => {
  const rows = [
    skillSettingRowLabel(false, 'data-analysis'),
    skillSettingRowLabel(true, 'statistical-analysis'),
  ]
  // Strip the state prefix: the name column starts at the same index.
  const nameCols = rows.map((row) => row.indexOf('[skill]'))
  assert.deepEqual(nameCols, [nameCols[0], nameCols[0]])
  // The `[skill] <name>` tail is exactly completionLabel's output — the badge
  // and name text are preserved verbatim, just preceded by the state.
  assert.equal(skillSettingRowLabel(true, 'data-analysis').replace(/^true\s{2}/, ''), completionLabel('explicit-skill', 'data-analysis'))
  assert.equal(skillSettingRowLabel(false, 'data-analysis').replace(/^false\s/, ''), completionLabel('explicit-skill', 'data-analysis'))
})

test('skillPanelRowLine leads with cursor + index + state, state appears exactly once', () => {
  // The self-drawn panel fixes the SettingsList double-state bug: the row
  // shows the toggle state once, in front, never repeated at the tail.
  const selected = skillPanelRowLine(true, true, 'agent-browser', 1)
  assert.equal(selected, '▸   1 true  [skill] agent-browser')
  assert.equal(selected.indexOf('true'), selected.lastIndexOf('true'))
  assert.ok(!selected.endsWith('true'))
  const unselected = skillPanelRowLine(false, false, 'data-analysis', 10)
  assert.equal(unselected, '   10 false [skill] data-analysis')
  assert.equal(unselected.indexOf('false'), unselected.lastIndexOf('false'))
  assert.ok(!unselected.endsWith('false'))
})

test('skillPanelRowLine index is right-aligned and does not shift the name column', () => {
  // 1-based index pads to 3 columns (padStart), so the name column is stable.
  const rows = [
    skillPanelRowLine(false, true, 'a', 1),
    skillPanelRowLine(false, true, 'b', 12),
    skillPanelRowLine(false, true, 'c', 123),
  ]
  const nameCols = rows.map((row) => row.indexOf('[skill]'))
  assert.deepEqual(nameCols, [nameCols[0], nameCols[0], nameCols[0]])
})

test('skillPanelRowLine aligns names across states (single state column, with index)', () => {
  const rows = [
    skillPanelRowLine(false, false, 'data-analysis', 1),
    skillPanelRowLine(true, true, 'statistical-analysis', 2),
  ]
  const nameCols = rows.map((row) => row.indexOf('[skill]'))
  assert.deepEqual(nameCols, [nameCols[0], nameCols[0]])
})

test('clampSkillCursor bounds navigation to the row count', () => {
  assert.equal(clampSkillCursor(0, 3), 0)
  assert.equal(clampSkillCursor(2, 3), 2)
  assert.equal(clampSkillCursor(3, 3), 2) // past the end → last row
  assert.equal(clampSkillCursor(-1, 3), 0) // before the start → first row
  assert.equal(clampSkillCursor(0, 0), 0) // empty list → pinned at 0
  assert.equal(clampSkillCursor(5, 0), 0)
})

test('clampScrollOffset keeps cursor in visible window', () => {
  // Empty list → 0
  assert.equal(clampScrollOffset(0, 10, 0, 0), 0)
  // Cursor within window → no change
  assert.equal(clampScrollOffset(3, 10, 50, 0), 0)
  // Cursor above window → scroll up
  assert.equal(clampScrollOffset(2, 10, 50, 5), 2)
  // Cursor below window → scroll down so cursor is at bottom
  assert.equal(clampScrollOffset(15, 10, 50, 0), 6) // 15 - 10 + 1 = 6
  // Cursor at exact boundary (last visible row) → no change
  assert.equal(clampScrollOffset(9, 10, 50, 0), 0)
  // Cursor one past the boundary → scroll down by 1
  assert.equal(clampScrollOffset(10, 10, 50, 0), 1)
})

test('skillJumpCursor moves by one, a page, or jumps to an end', () => {
  // up/down step by one and clamp at the ends.
  assert.equal(skillJumpCursor(1, 5, 'up'), 0)
  assert.equal(skillJumpCursor(0, 5, 'up'), 0)
  assert.equal(skillJumpCursor(3, 5, 'down'), 4)
  assert.equal(skillJumpCursor(4, 5, 'down'), 4)
  // pageUp/pageDown step by SKILL_PAGE_SIZE, clamped to the row count.
  assert.equal(skillJumpCursor(30, 50, 'pageUp'), 20)
  assert.equal(skillJumpCursor(3, 50, 'pageUp'), 0)
  assert.equal(skillJumpCursor(20, 50, 'pageDown'), 30)
  assert.equal(skillJumpCursor(49, 50, 'pageDown'), 49)
  assert.equal(skillJumpCursor(5, 8, 'pageDown'), 7) // clamped to last row
  // home/end pin to the first/last row; empty lists stay at 0.
  assert.equal(skillJumpCursor(3, 5, 'home'), 0)
  assert.equal(skillJumpCursor(0, 5, 'end'), 4)
  assert.equal(skillJumpCursor(3, 0, 'home'), 0)
  assert.equal(skillJumpCursor(3, 0, 'end'), 0)
  // a custom page size is honored.
  assert.equal(skillJumpCursor(20, 100, 'pageDown', 25), 45)
  assert.equal(skillJumpCursor(20, 100, 'pageUp', 25), 0)
})


test('buildSkillCompletionCandidates filters by user-invocable and prefix', () => {
  const skills = [
    { name: 'data-analysis', description: 'analyze data', ...enabled },
    { name: 'lark-base', description: 'lark base', ...enabled },
    { name: 'data-viz', description: 'plot', ...modelOnly }, // not user-invocable
    { name: 'data-eda', description: 'eda', ...disabled }, // fully hidden
  ]
  const all = buildSkillCompletionCandidates(skills, '')
  assert.deepEqual(
    all.map(s => s.value),
    ['/skill:data-analysis', '/skill:lark-base'],
  )
  const prefix = buildSkillCompletionCandidates(skills, 'data')
  assert.deepEqual(
    prefix.map(s => s.value),
    ['/skill:data-analysis'],
  )
})

test('buildSkillCompletionCandidates emits carry the explicit-skill kind + badge', () => {
  const items = buildSkillCompletionCandidates([{ name: 'lark-base', description: 'lark base', ...enabled }], '')
  assert.equal(items.length, 1)
  assert.equal(items[0].value, '/skill:lark-base')
  assert.equal(items[0].label, '[skill] /skill:lark-base')
  assert.equal(items[0].description, 'lark base')
  assert.equal(itemKind(items[0]), 'explicit-skill')
  assert.equal(isSkillCompletionItem(items[0]), true)
  assert.equal(isExplicitSkillItem(items[0]), true)
})

test('buildNativeSkillCandidates lists user skills under their own /name', () => {
  const skills = [
    { name: 'data-analysis', description: 'analyze data', ...enabled },
    { name: 'data-viz', description: 'plot', ...modelOnly }, // not user-invocable
  ]
  const items = buildNativeSkillCandidates(skills)
  assert.equal(items.length, 1)
  assert.equal(items[0].value, '/data-analysis')
  assert.equal(items[0].label, '[skill] /data-analysis')
  assert.equal(items[0].description, 'analyze data')
  assert.equal(itemKind(items[0]), 'native-skill')
  // Native skills complete like commands (trailing space), so they are NOT
  // the explicit form — distinguishability drives applyCompletion.
  assert.equal(isSkillCompletionItem(items[0]), true)
  assert.equal(isExplicitSkillItem(items[0]), false)
})

test('isSkillCompletionItem / isExplicitSkillItem classify rows by kind', () => {
  const debug = (kind) => ({ value: '/x', label: '/x', kind })
  assert.equal(isSkillCompletionItem(debug('explicit-skill')), true)
  assert.equal(isSkillCompletionItem(debug('native-skill')), true)
  assert.equal(isSkillCompletionItem(debug('command')), false)
  assert.equal(isSkillCompletionItem({ value: '/model', label: '/model' }), false) // unmarked = command
  assert.equal(isExplicitSkillItem(debug('explicit-skill')), true)
  assert.equal(isExplicitSkillItem(debug('native-skill')), false)
  assert.equal(isExplicitSkillItem(debug('command')), false)
})

test('completionName strips the slash and the /skill: prefix for sorting', () => {
  assert.equal(completionName({ value: '/model', label: '/model' }), 'model')
  assert.equal(completionName({ value: '/data-analysis', label: '/data-analysis' }), 'data-analysis')
  assert.equal(completionName({ value: '/skill:data-analysis', label: '/skill:data-analysis' }), 'data-analysis')
})

test('sortCompletionItems orders the mixed list by native name', () => {
  const mixed = [
    { value: '/model', label: '/model', kind: 'command' },
    { value: '/data-analysis', label: '[skill] /data-analysis', kind: 'native-skill' },
    { value: '/agents', label: '/agents', kind: 'command' },
    // The explicit /skill: form sorts under its real name (data-viz), not in
    // the `s` bucket — that is what keeps the mixed list from grouping skills.
    { value: '/skill:data-viz', label: '[skill] /skill:data-viz', kind: 'explicit-skill' },
  ]
  const sorted = sortCompletionItems(mixed)
  // Ordering by completionName: agents < data-analysis < data-viz < model.
  assert.deepEqual(sorted.map(s => completionName(s)), ['agents', 'data-analysis', 'data-viz', 'model'])
  // The values themselves keep their kinds (explicit rows stay /skill:<name>).
  assert.deepEqual(sorted.map(s => s.value), ['/agents', '/data-analysis', '/skill:data-viz', '/model'])
})

test('sortCompletionItems is stable and does not mutate the input', () => {
  const mixed = [
    { value: '/b', label: '/b', kind: 'command' },
    { value: '/a', label: '/a', kind: 'command' },
    { value: '/b', label: '/b', kind: 'command' },
  ]
  const sorted = sortCompletionItems(mixed)
  assert.deepEqual(sorted.map(s => s.value), ['/a', '/b', '/b'])
  assert.deepEqual(mixed.map(s => s.value), ['/b', '/a', '/b']) // input untouched
})

test('mergeMixedSkillItems filters by prefix and interleaves commands + skills', () => {
  const commands = [
    { value: '/model', label: '/model', kind: 'command' },
    { value: '/data', label: '/data', kind: 'command' },
  ]
  const native = [
    { value: '/data-analysis', label: '[skill] /data-analysis', kind: 'native-skill' },
    { value: '/lark-base', label: '[skill] /lark-base', kind: 'native-skill' },
  ]
  // Empty query: everything, interleaved by native name.
  assert.deepEqual(
    mergeMixedSkillItems(commands, native, '').map(s => completionName(s)),
    ['data', 'data-analysis', 'lark-base', 'model'],
  )
  // Prefix filter applies to both commands and skills.
  assert.deepEqual(
    mergeMixedSkillItems(commands, native, 'data').map(s => completionName(s)),
    ['data', 'data-analysis'],
  )
  // A prefix with no match yields an empty list.
  assert.deepEqual(mergeMixedSkillItems(commands, native, 'xnothere'), [])
})

test('mergeMixedSkillItems never mutates the input lists', () => {
  const commands = [{ value: '/b', label: '/b', kind: 'command' }]
  const native = [{ value: '/a', label: '[skill] /a', kind: 'native-skill' }]
  mergeMixedSkillItems(commands, native, '')
  assert.equal(commands.length, 1)
  assert.equal(native.length, 1)
})

// ------------------------------------------------------------- filter --

test('filterSkillRows returns all rows for an empty query', () => {
  const rows = [
    { name: 'data-analysis', description: '', enabled: true },
    { name: 'lark-base', description: '', enabled: false },
  ]
  const result = filterSkillRows(rows, '')
  assert.equal(result.length, 2)
  assert.deepEqual(result.map(r => r.name), ['data-analysis', 'lark-base'])
  // Returns a new array (never mutates input).
  assert.notEqual(result, rows)
})

test('filterSkillRows filters by case-insensitive prefix match', () => {
  const rows = [
    { name: 'data-analysis', description: '', enabled: true },
    { name: 'data-viz', description: '', enabled: true },
    { name: 'lark-base', description: '', enabled: false },
  ]
  assert.deepEqual(filterSkillRows(rows, 'data').map(r => r.name), ['data-analysis', 'data-viz'])
  assert.deepEqual(filterSkillRows(rows, 'Data').map(r => r.name), ['data-analysis', 'data-viz'])
  assert.deepEqual(filterSkillRows(rows, 'LARK').map(r => r.name), ['lark-base'])
  assert.deepEqual(filterSkillRows(rows, 'z'), [])
})

test('filterSkillRows returns empty for no matches', () => {
  const rows = [{ name: 'x', description: '', enabled: true }]
  assert.deepEqual(filterSkillRows(rows, 'zzz'), [])
})

test('filterSkillRows handles an empty input list', () => {
  assert.deepEqual(filterSkillRows([], ''), [])
  assert.deepEqual(filterSkillRows([], 'x'), [])
})

test('isPrintableInput accepts printable ASCII characters', () => {
  assert.equal(isPrintableInput('a'), true)
  assert.equal(isPrintableInput('Z'), true)
  assert.equal(isPrintableInput('3'), true)
  assert.equal(isPrintableInput(' '), true)
  assert.equal(isPrintableInput('-'), true)
})

test('isPrintableInput rejects control characters and DEL', () => {
  assert.equal(isPrintableInput('\x00'), false) // NUL
  assert.equal(isPrintableInput('\x1b'), false) // ESC
  assert.equal(isPrintableInput('\x7f'), false) // DEL
  assert.equal(isPrintableInput('\n'), false)   // newline
  assert.equal(isPrintableInput('\t'), false)    // tab
})

test('isPrintableInput rejects multi-character strings', () => {
  assert.equal(isPrintableInput('ab'), false)
  assert.equal(isPrintableInput(''), false)
})

test('skillToggleEnabled maps a disk toggle read onto enabled', () => {
  assert.equal(skillToggleEnabled({ disable: false, invoke: true }), true)
  assert.equal(skillToggleEnabled({ disable: true, invoke: true }), false)
  assert.equal(skillToggleEnabled({ disable: false, invoke: false }), false)
  assert.equal(skillToggleEnabled({ disable: true, invoke: false }), false)
})

test('trailing-space decision: only the explicit /skill:<name> omits the space', () => {
  const explicit = { value: '/skill:data-analysis', label: '[skill] /skill:data-analysis', kind: 'explicit-skill' }
  const native = { value: '/data-analysis', label: '[skill] /data-analysis', kind: 'native-skill' }
  const command = { value: '/model', label: '/model', kind: 'command' }
  const unmarked = { value: '/model', label: '/model' }
  // applyCompletion appends a trailing space unless the row is explicit.
  assert.equal(isExplicitSkillItem(explicit), true)
  for (const item of [native, command, unmarked]) {
    assert.equal(isExplicitSkillItem(item), false)
  }
})

// ------------------------------------------------------------- frontmatter keys --

test('skillDisableUpdates sets both invocation locks', () => {
  assert.deepEqual(skillDisableUpdates(), {
    'disable-model-invocation': 'true',
    'user-invocable': 'false',
  })
})

test('skillEnableUpdates removes both locks', () => {
  assert.deepEqual(skillEnableUpdates(), {
    'disable-model-invocation': null,
    'user-invocable': null,
  })
})

// ------------------------------------------------------------- frontmatter edit --

function tempSkill(body) {
  const dir = mkdtempSync(join(tmpdir(), 'skills-test-'))
  const path = join(dir, 'SKILL.md')
  writeFileSync(path, body)
  return path
}

function cleanupSkill(path) {
  rmSync(path, { recursive: true, force: true })
}

const SKILL_BODY = [
  '---',
  'name: data-analysis',
  'description: Analyze spreadsheets',
  'whenToUse: Uploaded Excel or CSV',
  '---',
  '## Body',
  'Analyze the data with pandas.',
  '',
].join('\n')

test('applySkillFrontmatter disables then enables, preserving body', () => {
  const path = tempSkill(SKILL_BODY)
  try {
    const disableErr = applySkillFrontmatter(path, skillDisableUpdates())
    assert.equal(disableErr, undefined)
    const disabled1 = readFileSync(path, 'utf8')
    assert.match(disabled1, /disable-model-invocation: true/)
    assert.match(disabled1, /user-invocable: false/)
    assert.match(disabled1, /name: data-analysis/) // other keys intact
    assert.match(disabled1, /Analyze the data with pandas\./) // body intact
    assert.deepEqual(readSkillToggle(path), { disable: true, invoke: false })

    const enableErr = applySkillFrontmatter(path, skillEnableUpdates())
    assert.equal(enableErr, undefined)
    const enabled1 = readFileSync(path, 'utf8')
    assert.doesNotMatch(enabled1, /disable-model-invocation/)
    assert.doesNotMatch(enabled1, /user-invocable/)
    assert.match(enabled1, /whenToUse: Uploaded Excel or CSV/)
    assert.match(enabled1, /## Body/)
    assert.deepEqual(readSkillToggle(path), { disable: false, invoke: true })
  } finally {
    cleanupSkill(path)
  }
})

test('applySkillFrontmatter inserts missing keys and is idempotent', () => {
  const path = tempSkill(SKILL_BODY)
  try {
    assert.equal(applySkillFrontmatter(path, skillDisableUpdates()), undefined)
    // A second identical disable is a no-op (same keys already present).
    assert.equal(applySkillFrontmatter(path, skillDisableUpdates()), undefined)
    const body = readFileSync(path, 'utf8')
    assert.equal((body.match(/disable-model-invocation/g) ?? []).length, 1)
    assert.equal((body.match(/user-invocable/g) ?? []).length, 1)
  } finally {
    cleanupSkill(path)
  }
})

test('applySkillFrontmatter reports missing frontmatter and unresolvable files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-test-'))
  try {
    const noFm = join(dir, 'no-fm.md')
    writeFileSync(noFm, '# just a heading\n')
    assert.match(applySkillFrontmatter(noFm, skillDisableUpdates()) ?? '', /missing frontmatter/)
    assert.match(applySkillFrontmatter(join(dir, 'missing.md'), skillDisableUpdates()) ?? '', /cannot read/)
    assert.match(applySkillFrontmatter(noFm, skillEnableUpdates()) ?? '', /missing frontmatter/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readSkillToggle degrades on unreadable / non-frontmatter files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-test-'))
  try {
    assert.equal(readSkillToggle(join(dir, 'nope.md')), undefined)
    const plain = join(dir, 'plain.md')
    writeFileSync(plain, 'plain text\n')
    assert.equal(readSkillToggle(plain), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
