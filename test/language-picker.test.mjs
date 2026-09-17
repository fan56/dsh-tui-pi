/**
 * Language picker panel tests — the in-place table behind the /settings
 * browser's `dsh-tui.language` edit row. (`/language` itself goes through the
 * native ask-user panel; see language-ask.test.mjs.) Pure component tests, no
 * TTY needed: the panel renders to a width and `handleInput` drives the same
 * navigation the live TUI sends. Runs against the built lib/
 * (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { darkTheme } from '../lib/theme/index.js'
import { initI18n, listLocales } from '../lib/i18n/index.js'
import { languagePickerPanel } from '../lib/selectors.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;\x07/g, '')

/**
 * A temp DSH_HOME whose user locale dir adds `de` and re-declares `en`/
 * `zh-CN` (merge paths), on top of the four bundled languages — the picker
 * must list the merged registry, id-sorted, whatever the discovery order.
 */
function seedLocales() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tui-langpicker-'))
  const dir = join(home, 'locales')
  mkdirSync(dir)
  writeFileSync(join(dir, 'zh-CN.json'), JSON.stringify({ name: '简体中文', 'x.test': 'zh' }))
  writeFileSync(join(dir, 'de.json'), JSON.stringify({ name: 'Deutsch', 'x.test': 'de' }))
  writeFileSync(join(dir, 'en.json'), JSON.stringify({ name: 'English', 'x.test': 'en' }))
  return home
}

/** The picker wired to capture lists, against the merged temp-home registry. */
function makePanel(current) {
  const picked = []
  const panel = languagePickerPanel(darkTheme, current, id => picked.push(id), () => {})
  return { panel, picked }
}

test('picker lists the merged registry id-sorted, display name per row', () => {
  initI18n({ home: seedLocales(), id: 'en' })
  const { panel } = makePanel('en')
  const lines = panel.render(60).map(stripAnsi)
  const ids = listLocales().map(locale => locale.id)
  assert.deepEqual(ids, ['de', 'en', 'ja', 'ko', 'zh-CN'])
  const text = lines.join('\n')
  assert.ok(text.includes('● Language'), 'title present')
  assert.ok(text.includes('LANGUAGE'), 'header column present')
  for (const name of ['Deutsch', 'English', '日本語', '한국어', '简体中文']) {
    assert.ok(text.includes(name), `display name row: ${name}`)
  }
})

test('the current locale carries the ▸ cursor', () => {
  initI18n({ home: seedLocales(), id: 'en' })
  const { panel } = makePanel('ja')
  const lines = panel.render(60).map(stripAnsi)
  const jaRow = lines.find(line => line.includes('日本語'))
  assert.match(jaRow, /^▸/, 'cursor sits on the preselected locale')
  const otherRow = lines.find(line => line.includes('Deutsch'))
  assert.match(otherRow, /^ {2}/, 'non-selected rows carry no cursor')
})

test('Enter picks the cursor locale; navigation moves it first', () => {
  initI18n({ home: seedLocales(), id: 'en' })
  const { panel, picked } = makePanel('de')
  panel.handleInput('\r')
  assert.deepEqual(picked, ['de'], 'preselected row picks without navigation')
  picked.length = 0
  panel.handleInput('\x1b[B')
  panel.handleInput('\r')
  assert.deepEqual(picked, ['en'], 'one down then Enter picks the next row')
})

test('Esc cancels without a pick', () => {
  initI18n({ home: seedLocales(), id: 'en' })
  const picked = []
  let cancelled = 0
  const panel = languagePickerPanel(darkTheme, 'en', id => picked.push(id), () => { cancelled++ })
  panel.handleInput('\x1b')
  assert.equal(cancelled, 1)
  assert.deepEqual(picked, [])
})

test('an in-panel status message (failed write) renders above the footer', () => {
  initI18n({ home: seedLocales(), id: 'en' })
  let status
  const panel = languagePickerPanel(darkTheme, 'en', () => {}, () => {}, () => status)
  const before = panel.render(60).map(stripAnsi).join('\n')
  assert.ok(!before.includes('save failed'), 'no status line until one is set')
  status = '✘ save failed: boom'
  const after = panel.render(60).map(stripAnsi).join('\n')
  assert.ok(after.includes('save failed: boom'), 'status line shows the failure')
})
