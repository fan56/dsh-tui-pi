/**
 * /model picker favorites/hidden/filter tests — the pure list assembly
 * (src/model-list.ts), the ListController/TablePanel skip-unselectable and
 * filter-input machinery (src/panels.ts), and the settings read/write
 * wrappers (readModelPrefs/writeModelPref in src/theme-settings.ts, driven
 * through a fake in-memory settings provider — nothing touches
 * ~/.dsh/settings.yaml). Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import {
  buildModelRows,
  canHideModelRow,
  matchesModelFilter,
  modelKey,
  narrowStringList,
  toggleStringList,
} from '../lib/model-list.js'
import { ListController, TablePanel } from '../lib/panels.js'
import {
  readModelPrefs,
  registerThemeSettings,
  THEME_SETTINGS_NAMESPACE,
  writeModelPref,
} from '../lib/theme-settings.js'
import { githubLight } from '../lib/theme/palette.js'

const MODELS = [
  { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
  { provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  { provider: 'zhipu', id: 'glm-4.7', name: 'GLM-4.7' },
]

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')
/** Minimal theme the panel reads (palette only). */
const theme = { palette: githubLight }

// ------------------------------------------------------------ pure helpers --

test('modelKey composes the provider/id settings key', () => {
  assert.equal(modelKey({ provider: 'deepseek', id: 'deepseek-chat' }), 'deepseek/deepseek-chat')
})

test('toggleStringList appends absent keys in order and removes present ones', () => {
  const added = toggleStringList(['a/b'], 'c/d')
  assert.deepEqual(added, ['a/b', 'c/d'], 'absent key appended (join order)')
  assert.deepEqual(toggleStringList(added, 'a/b'), ['c/d'], 'present key removed')
  const source = ['x']
  toggleStringList(source, 'y')
  assert.deepEqual(source, ['x'], 'input array never mutated')
})

test('narrowStringList keeps only string entries', () => {
  assert.deepEqual(narrowStringList(['a', 42, null, 'b']), ['a', 'b'])
  assert.deepEqual(narrowStringList('nope'), [])
  assert.deepEqual(narrowStringList(undefined), [])
})

test('canHideModelRow: h is refused on a favorite row (unfavorite first, then hide)', () => {
  const [chat, reasoner, glm] = MODELS
  assert.equal(
    canHideModelRow({ kind: 'model', section: 'favorite', model: chat }),
    false,
    'favorite row refuses hide — it would silently persist hiddenModels with no visual feedback',
  )
  assert.equal(canHideModelRow({ kind: 'model', section: 'normal', model: reasoner }), true)
  assert.equal(
    canHideModelRow({ kind: 'model', section: 'hidden', model: glm }),
    true,
    'hidden row still toggles back to visible',
  )
})

test('matchesModelFilter is a case-insensitive substring match on name/id/provider', () => {
  const glm = { provider: 'zhipu', id: 'glm-4.7', name: 'GLM-4.7' }
  assert.equal(matchesModelFilter(glm, ''), true, 'empty query matches everything')
  assert.equal(matchesModelFilter(glm, 'glm'), true)
  assert.equal(matchesModelFilter(glm, 'GLM'), true)
  assert.equal(matchesModelFilter(glm, 'zhipu'), true)
  assert.equal(matchesModelFilter(glm, '4.7'), true)
  assert.equal(matchesModelFilter(glm, 'kimi'), false)
})

// ---------------------------------------------------------- buildModelRows --

test('buildModelRows: favorites → divider → normal → hidden header + hidden models', () => {
  const rows = buildModelRows(MODELS, ['zhipu/glm-4.7'], ['deepseek/deepseek-reasoner'])
  assert.deepEqual(
    rows.map(row => row.kind),
    ['model', 'divider', 'model', 'hiddenHeader', 'model'],
  )
  const [fav, , normal, header, hidden] = rows
  assert.equal(fav.section, 'favorite')
  assert.equal(fav.model.id, 'glm-4.7')
  assert.equal(normal.section, 'normal')
  assert.equal(normal.model.id, 'deepseek-chat')
  assert.equal(header.count, 1)
  assert.equal(hidden.section, 'hidden')
  assert.equal(hidden.model.id, 'deepseek-reasoner')
})

test('buildModelRows: no favorites means no divider row', () => {
  const rows = buildModelRows(MODELS, [], [])
  assert.deepEqual(rows.map(row => row.kind), ['model', 'model', 'model'])
  assert.ok(rows.every(row => row.section === 'normal'))
})

test('buildModelRows: favorites keep join order; stale keys are skipped', () => {
  const rows = buildModelRows(MODELS, ['deepseek/deepseek-reasoner', 'ghost/old-model'], [])
  assert.deepEqual(
    rows.filter(row => row.kind === 'model').map(row => row.model.id),
    ['deepseek-reasoner', 'deepseek-chat', 'glm-4.7'],
    'favorite first (join order), listing order after',
  )
  assert.deepEqual(rows.map(row => row.kind), ['model', 'divider', 'model', 'model'])
})

test('buildModelRows: a favorited hidden model appears once, in favorites', () => {
  const rows = buildModelRows(MODELS, ['deepseek/deepseek-reasoner'], ['deepseek/deepseek-reasoner'])
  assert.equal(rows.filter(row => row.kind === 'hiddenHeader').length, 0, 'hidden section empty → dropped')
  assert.deepEqual(
    rows.filter(row => row.kind === 'model').map(row => `${row.section}:${row.model.id}`),
    ['favorite:deepseek-reasoner', 'normal:deepseek-chat', 'normal:glm-4.7'],
  )
})

test('buildModelRows with a filter prunes each section and drops the Hidden section', () => {
  // Filter 'deepseek': favorite + one normal match; the hidden deepseek
  // reasoner must NOT resurface as a Hidden row.
  const rows = buildModelRows(
    MODELS,
    ['deepseek/deepseek-reasoner'],
    ['deepseek/deepseek-reasoner', 'zhipu/glm-4.7'],
    'deepseek',
  )
  assert.deepEqual(
    rows.map(row => row.kind),
    ['model', 'divider', 'model'],
    'pinned structure kept, only matching rows per section, no Hidden section',
  )
  assert.equal(rows[0].section, 'favorite')
  assert.equal(rows[2].section, 'normal')

  // A filter matching only normals drops the divider too (no visible favorites).
  const noFav = buildModelRows(MODELS, ['zhipu/glm-4.7'], [], 'chat')
  assert.deepEqual(noFav.map(row => row.kind), ['model'])

  // An empty-ish (whitespace) filter behaves like no filter.
  assert.deepEqual(buildModelRows(MODELS, [], [], '  ').length, 3)
})

// --------------------------------------------- ListController skip logic --

test('ListController: up/down step over unselectable rows', () => {
  // Row 1 (divider) and row 3 (header) are unselectable.
  const selectableAt = i => i !== 1 && i !== 3
  const c = new ListController(() => 5, 12, selectableAt)
  c.down()
  assert.equal(c.index, 2, 'down from 0 skips the divider at 1')
  c.up()
  assert.equal(c.index, 0, 'up from 2 skips back over the divider')
  c.setIndex(4)
  c.up()
  assert.equal(c.index, 2, 'up from 4 skips the header at 3')
  c.setIndex(0)
  c.up()
  assert.equal(c.index, 0, 'clamped at the top')
  c.setIndex(4)
  c.down()
  assert.equal(c.index, 4, 'clamped at the bottom')
})

test('ListController: pageUp/pageDown land past structural rows onto selectable ones', () => {
  // Rows 0..9, every even row unselectable (dividers).
  const c = new ListController(() => 10, 4, i => i % 2 === 1)
  c.pageDown()
  assert.equal(c.index, 5, 'target 4 is unselectable → snaps to 5 scanning forward')
  c.pageDown()
  assert.equal(c.index, 9, 'clamped to last selectable')
  c.pageUp()
  assert.equal(c.index, 5, 'pageUp target scans backward onto a selectable row')
})

test('ListController: setIndex snaps off an unselectable row; all-unselectable keeps the cursor', () => {
  const c = new ListController(() => 3, 12, i => i !== 2)
  c.setIndex(2)
  assert.equal(c.index, 1, 'snaps upward to the nearest selectable row')
  const stuck = new ListController(() => 3, 12, () => false)
  stuck.setIndex(2)
  assert.equal(stuck.index, 0, 'no selectable row anywhere → cursor stays')
  stuck.down()
  stuck.up()
  assert.equal(stuck.index, 0)
})

// ------------------------------------------------- TablePanel integration --

/** Build a small model table panel with structural rows for render/input tests. */
function makePanel(overrides = {}) {
  const rows = [
    { kind: 'model', section: 'favorite', model: { provider: 'd', id: 'fav', name: 'Favorite One' } },
    { kind: 'divider' },
    { kind: 'model', section: 'normal', model: { provider: 'd', id: 'a', name: 'Model A' } },
    { kind: 'hiddenHeader', count: 1 },
    { kind: 'model', section: 'hidden', model: { provider: 'd', id: 'gone', name: 'Hidden One' } },
  ]
  const options = {
    title: '● Model',
    columns: [
      { key: 'model', title: 'Model', width: 14 },
      { key: 'provider', title: 'Provider', flex: true },
    ],
    rows,
    renderCell: (row, column) =>
      column.key === 'provider'
        ? row.model.provider
        : (row.section === 'favorite' ? `★ ${row.model.name}` : row.model.name),
    isSelectable: row => row.kind === 'model',
    specialRow: (row, width) => {
      if (row.kind === 'divider') return '─'.repeat(Math.max(1, width))
      if (row.kind === 'hiddenHeader') return `─ Hidden (${String(row.count)}) ─`
      return undefined
    },
    dimRow: row => row.kind === 'model' && row.section === 'hidden',
    onSelect: () => {},
    onCancel: () => {},
    ...overrides,
  }
  return { options, panel: new TablePanel(theme, options) }
}

test('TablePanel renders divider/header full-width lines, dim hidden rows, ★ favorites', () => {
  const { panel } = makePanel()
  const lines = panel.render(50).map(stripAnsi)
  const divider = lines.find(line => line.startsWith('  ────') && !line.includes('┬'))
  assert.ok(divider !== undefined, 'full-width ─ divider line rendered')
  assert.ok(lines.some(line => line.includes('─ Hidden (1) ─')), 'dim hidden-section header rendered')
  assert.ok(!lines.some(line => line.includes('▸') && line.includes('Hidden (')), 'header never carries the selection marker')
  assert.ok(lines.some(line => line.includes('★ Favorite One')), 'favorite row shows the ★ prefix')
  assert.ok(lines.some(line => line.includes('Hidden One')), 'hidden model listed under its header')
})

test('TablePanel navigation skips structural rows and Enter selects the cursor model', () => {
  const picked = []
  const { panel } = makePanel({ onSelect: row => picked.push(row.model.id) })
  panel.handleInput('\x1b[B') // down: favorite → normal (skips divider)
  assert.equal(panel.selectedRow().model.id, 'a')
  panel.handleInput('\x1b[B') // down: normal → hidden (skips header)
  assert.equal(panel.selectedRow().model.id, 'gone')
  panel.handleInput('\r') // Enter selects the hidden model directly
  assert.deepEqual(picked, ['gone'])
  panel.handleInput('\x1b[A') // up: hidden → normal (skips header again)
  assert.equal(panel.selectedRow().model.id, 'a')
})

test('TablePanel shortcuts f/h fire outside input mode', () => {
  const calls = []
  const { panel } = makePanel({ shortcuts: { f: () => calls.push('f'), h: () => calls.push('h') } })
  panel.handleInput('f')
  panel.handleInput('H'.toLowerCase())
  assert.deepEqual(calls, ['f', 'h'])
})

test('TablePanel filter mode: / engages, keystrokes bypass shortcuts, Enter applies, Esc clears', () => {
  const MODEL_FOOTER = '↑↓ navigate · Enter select · f favorite · h hide · / filter · Esc back'
  let query = ''
  const shortcutCalls = []
  const { options, panel } = makePanel({
    shortcuts: { f: () => shortcutCalls.push('f') },
    footer: MODEL_FOOTER,
    filter: {
      getQuery: () => query,
      onQueryChange: next => {
        // Caller-style live rebuild: filter the full row set by the new query.
        query = next
        const all = makePanel().options.rows
        options.rows = all.filter(
          row => row.kind !== 'model' || row.model.name.toLowerCase().includes(query),
        )
      },
    },
  })

  panel.handleInput('/') // engage
  panel.handleInput('f') // must accumulate into the query, NOT fire the shortcut
  panel.handleInput('a')
  assert.deepEqual(shortcutCalls, [], 'shortcuts suspended while the input line is engaged')
  assert.equal(query, 'fa')
  let lines = panel.render(60).map(stripAnsi)
  assert.ok(lines.some(line => line.startsWith('Filter: fa_')), 'live query shown while typing')
  assert.ok(!lines.some(line => line.includes('Model A')), 'rows narrowed live by the caller rebuild')
  assert.ok(!lines.some(line => line.includes('Hidden One')), 'hidden section pruned by the filter too')
  assert.ok(lines.some(line => line.includes('★ Favorite One')), 'matching favorite stays pinned with its divider')
  assert.ok(lines.at(-1).includes('Enter apply'), 'footer swaps to the input-mode hints')

  panel.handleInput('\r') // Enter applies and leaves input mode
  lines = panel.render(100).map(stripAnsi)
  assert.ok(lines.some(line => line.startsWith('Filter: fa')), 'applied filter stays visible as a reminder')
  assert.ok(lines.at(-1).includes('Esc'), 'footer back to navigation hints')

  panel.handleInput('\x1b') // Esc clears the applied filter before closing
  assert.equal(query, '', 'Esc cleared the applied filter')
  lines = panel.render(60).map(stripAnsi)
  assert.ok(!lines.some(line => line.startsWith('Filter:')), 'cleared filter line gone')
  assert.ok(lines.some(line => line.includes('Favorite One')), 'full list restored')

  let cancelled = 0
  const closing = makePanel({ onCancel: () => { cancelled++ } }).panel
  closing.handleInput('\x1b')
  assert.equal(cancelled, 1, 'Esc without any filter closes the panel')
})

test('TablePanel focusRow/resyncCursor keep the cursor on a selectable row across rebuilds', () => {
  const { options, panel } = makePanel()
  // Caller-style rebuild: reassign options.rows, then focus the toggled model.
  panel.focusRow(row => row.kind === 'model' && row.model.id === 'gone')
  assert.equal(panel.selectedRow().model.id, 'gone')
  panel.focusRow(row => row.kind === 'model' && row.model.id === 'missing')
  assert.equal(panel.selectedRow().model.id, 'gone', 'unknown target leaves the cursor alone')
  // Swap rows so the cursor lands on a structural row, then resync.
  options.rows = [options.rows[0], { kind: 'divider' }]
  panel.resyncCursor()
  assert.equal(panel.selectedRow().kind, 'model', 'cursor snapped off the divider')
})

test('TablePanel.focusRow reports a miss; the caller fallback resync keeps the cursor alive', () => {
  // Regression (S1): with a filter applied, hiding the cursor row removes it
  // from rows entirely (the Hidden section stays pruned while filtering).
  // focusRow(keepKey) must report the miss so the caller can resyncCursor —
  // otherwise the cursor strands out of range: selectedRow() undefined, no
  // ▸ marker rendered, arrow keys dead.
  const { options, panel } = makePanel()
  options.rows = [
    { kind: 'model', section: 'normal', model: { provider: 'd', id: 'a', name: 'Model A' } },
    { kind: 'model', section: 'normal', model: { provider: 'd', id: 'b', name: 'Model B' } },
  ]
  assert.equal(panel.focusRow(row => row.kind === 'model' && row.model.id === 'a'), true)
  assert.equal(panel.focusRow(row => row.kind === 'model' && row.model.id === 'b'), true)
  assert.equal(panel.selectedRow().model.id, 'b')

  // The h-toggle rebuild: 'b' is hidden and the active filter keeps its row
  // out of the list — focusRow('b') misses now.
  options.rows = [options.rows[0]]
  assert.equal(
    panel.focusRow(row => row.kind === 'model' && row.model.id === 'b'),
    false,
    'vanished row reports a miss instead of silently keeping the stale index',
  )
  panel.resyncCursor() // the caller-side rebuild fallback
  const row = panel.selectedRow()
  assert.ok(row !== undefined && row.kind === 'model', 'cursor re-clamped onto a selectable row')
  assert.equal(row.model.id, 'a')
  assert.ok(
    panel.render(60).map(stripAnsi).some(line => line.includes('▸')),
    'the ▸ selection marker renders again after the fallback',
  )
})

// --------------------------------------------------- settings read/write --

/**
 * Minimal fake of the settings-provider surface (same shape as
 * theme-settings.test.mjs): describe/register/mutate with watcher delivery.
 */
function makeSettings() {
  const descriptors = []
  let revision = 0
  return {
    describe() {
      return descriptors
    },
    register(ns, schema, opts) {
      descriptors.push({ ns, schema, revision, value: opts?.base ?? {}, applies: opts?.applies })
      return { watch: () => () => {} }
    },
    async mutate(ns, ops) {
      const descriptor = descriptors.find(d => d.ns === ns)
      if (descriptor === undefined) throw new Error('namespace not registered')
      const value = { ...descriptor.value }
      for (const op of ops) {
        if (op.op === 'set') value[op.path[0]] = op.value
        if (op.op === 'unset') delete value[op.path[0]]
      }
      descriptor.value = value
      revision += 1
      descriptor.revision = revision
    },
  }
}

/** One tick: the registration rides the inject fiber. */
const settle = () => new Promise(resolve => setImmediate(resolve))

test('readModelPrefs defaults to empty lists and writeModelPref round-trips via mutate', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  registerThemeSettings(ctx)
  await settle()

  assert.deepEqual(await readModelPrefs(ctx), { favoriteModels: [], hiddenModels: [] })

  assert.equal(await writeModelPref(ctx, 'favoriteModels', ['zhipu/glm-4.7', 'd/a']), undefined)
  assert.equal(await writeModelPref(ctx, 'hiddenModels', ['d/gone']), undefined)
  assert.deepEqual(await readModelPrefs(ctx), {
    favoriteModels: ['zhipu/glm-4.7', 'd/a'],
    hiddenModels: ['d/gone'],
  })

  // The write landed as a namespace path mutation, not a whole-file rewrite.
  const section = settings.describe().find(d => d.ns === THEME_SETTINGS_NAMESPACE).value
  assert.deepEqual(section.favoriteModels, ['zhipu/glm-4.7', 'd/a'])
})

test('readModelPrefs narrows malformed values; settings-less deployments degrade', async () => {
  const ctx = new Context()
  const settings = makeSettings()
  ctx.provide('settings', settings)
  registerThemeSettings(ctx)
  await settle()

  await settings.mutate(THEME_SETTINGS_NAMESPACE, [
    { op: 'set', path: ['favoriteModels'], value: ['ok', 42, null, {}, 'also-ok'] },
    { op: 'set', path: ['hiddenModels'], value: 'garbage' },
  ])
  assert.deepEqual(await readModelPrefs(ctx), { favoriteModels: ['ok', 'also-ok'], hiddenModels: [] })

  await settings.mutate(THEME_SETTINGS_NAMESPACE, [{ op: 'unset', path: ['favoriteModels'] }])
  assert.deepEqual((await readModelPrefs(ctx)).favoriteModels, [])

  // No settings service: reads degrade empty, writes report instead of throwing.
  const bare = new Context()
  assert.deepEqual(await readModelPrefs(bare), { favoriteModels: [], hiddenModels: [] })
  assert.equal(
    await writeModelPref(bare, 'favoriteModels', ['d/a']),
    'Settings service is not available.',
  )
})
