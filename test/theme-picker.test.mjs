/**
 * Theme picker overlay tests: the dual-pane layout (left theme list + right
 * live preview of the SELECTED theme) and the cursor-driven repaint. Pure
 * component tests, no TTY needed — the overlay renders to width, the preview
 * pane carries the selected theme's real surface colors, and handleInput
 * drives the same navigation the live TUI sends. Runs against the built
 * lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { darkTheme, lightTheme } from '../lib/theme/index.js'
import { githubDark, githubLight } from '../lib/theme/palette.js'
import { discoverThemes } from '../lib/theme/registry.js'
import { ThemePickerOverlay, themePickerRows } from '../lib/theme-preview.js'
import { visibleWidth } from '../lib/text.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;\x07/g, '')

/** ANSI background sequence for a hex color. */
const bgSeq = hex => {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `\x1b[48;2;${r};${g};${b}m`
}

function makeOverlay(theme = darkTheme, value = 'github-dark', columns = 120) {
  const rows = themePickerRows({ themes: discoverThemes() })
  const preselect = Math.max(0, rows.findIndex(row => row.value === value))
  const overlay = new ThemePickerOverlay(theme, rows, preselect, () => {}, () => theme)
  return { overlay, rows }
}

test('the picker list is flat two-level: auto, then every registered theme', () => {
  const rows = themePickerRows({ themes: discoverThemes() })
  assert.equal(rows[0].value, 'auto', 'auto leads')
  // The two defaults follow, then the rest of the registry — no alias rows.
  assert.equal(rows[1].value, 'github-light')
  assert.equal(rows[2].value, 'github-dark')
  const values = rows.map(row => row.value)
  assert.ok(!values.includes('light'), 'no light alias row')
  assert.ok(!values.includes('dark'), 'no dark alias row')
  assert.equal(new Set(values).size, values.length, 'no duplicate rows')
  assert.ok(values.includes('dracula'), 'registry themes are listed flat')
})

test('overlay renders the theme list and a live preview side by side', () => {
  const { overlay } = makeOverlay(darkTheme, 'github-dark', 120)
  const lines = overlay.render(120)
  const text = lines.map(stripAnsi).join('\n')
  // Left list: the constant row plus the registry themes.
  assert.ok(text.includes('● Theme'), 'title present')
  assert.ok(text.includes('auto'), 'auto row present')
  assert.ok(text.includes('GitHub light palette'), 'light description present')
  assert.ok(text.includes('GitHub dark palette'), 'dark description present')
  assert.ok(text.includes('dracula'), 'a registry theme is listed')
  // Right pane: the mock chat page content.
  assert.ok(text.includes('帮我分析这段代码'), 'user bubble text present')
  assert.ok(text.includes('read_file'), 'tool card text present')
  assert.ok(text.includes('const x = 42;'), 'code block present')
  // No line overflows the width.
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 120, `line within width: ${stripAnsi(line).slice(0, 40)}`)
  }
})

test('preview paints the SELECTED theme surface colors', () => {
  const { overlay } = makeOverlay(darkTheme, 'github-dark', 120)
  const raw = overlay.render(120).join('\n')
  // githubDark's user-bubble / code-block / tool / think surfaces.
  assert.ok(raw.includes(bgSeq(githubDark.canvasSubtle)), 'canvasSubtle bubble backdrop')
  assert.ok(raw.includes(bgSeq(githubDark.thinkingPanelBg)), 'thinking panel backdrop')
  assert.ok(raw.includes(bgSeq(githubDark.toolPanelBg)), 'tool card backdrop')
  assert.ok(raw.includes(bgSeq(githubDark.canvasInset)), 'title/input inset backdrop')
  // Light rows paint the light surfaces instead.
  const light = makeOverlay(lightTheme, 'github-light', 120).overlay.render(120).join('\n')
  assert.ok(light.includes(bgSeq(githubLight.canvasSubtle)), 'light canvasSubtle bubble')
})

test('preview title carries the selected theme description', () => {
  const { overlay } = makeOverlay(darkTheme, 'github-dark', 120)
  const text = overlay.render(120).map(stripAnsi).join('\n')
  assert.ok(text.includes('github-dark — GitHub dark palette'), 'dark title with description')
  // Moving up swaps the title to the light default.
  overlay.handleInput('\x1b[A') // github-dark -> github-light
  const after = overlay.render(120).map(stripAnsi).join('\n')
  assert.ok(after.includes('github-light — GitHub light palette'), 'light title after cursor move')
})

test('cursor navigation repaints the preview with the new theme', () => {
  const { overlay, rows } = makeOverlay(darkTheme, 'github-dark', 120)
  const next = rows[Math.max(0, rows.findIndex(r => r.value === 'github-dark')) + 1]
  const before = githubDark.canvasSubtle
  assert.ok(overlay.render(120).join('\n').includes(bgSeq(before)), 'dark bubble before')

  // One Down moves to the next theme row; the preview repaints.
  overlay.handleInput('\x1b[B')
  assert.notEqual(overlay.selectedValue(), 'github-dark', 'selection moved off github-dark')
  const raw = overlay.render(120).join('\n')
  assert.ok(raw.includes(bgSeq(next.palette.canvasSubtle)), 'new theme bubble backdrop')
  assert.ok(!raw.includes(bgSeq(before)), 'old theme bubble gone')
})

test('auto row shows a hint instead of a mock page', () => {
  const { overlay } = makeOverlay(darkTheme, 'auto', 120)
  let guard = 0
  while (overlay.selectedValue() !== 'auto' && guard++ < 30) overlay.handleInput('\x1b[A')
  const text = overlay.render(120).map(stripAnsi).join('\n')
  assert.ok(text.includes('Theme follows the terminal'), 'auto hint present')
  assert.ok(!text.includes('read_file'), 'no mock page for auto')
})

test('narrow terminals stack the list above the preview', () => {
  const { overlay } = makeOverlay(darkTheme, 'github-dark', 80)
  const lines = overlay.render(80).map(stripAnsi)
  const text = lines.join('\n')
  assert.ok(text.includes('● Theme'), 'title present on narrow')
  // Both panes visible: list rows and the preview page (or its first lines).
  assert.ok(text.includes('GitHub dark palette'), 'list visible')
  const listAt = lines.findIndex(line => line.includes('GitHub dark palette'))
  const previewAt = lines.findIndex(line => line.includes('read_file') || line.includes('帮我分析这段代码'))
  assert.ok(previewAt > listAt, `preview below list (list ${listAt}, preview ${previewAt})`)
  for (const line of overlay.render(80)) {
    assert.ok(visibleWidth(line) <= 80, 'narrow line within width')
  }
})

test('Enter resolves the selected row value', () => {
  const picked = []
  const rows = themePickerRows({ themes: discoverThemes() })
  const o = new ThemePickerOverlay(darkTheme, rows, 2, value => picked.push(value), () => darkTheme)
  // Selection starts at 'github-dark' (index 2): Enter picks it.
  o.handleInput('\r')
  assert.deepEqual(picked, ['github-dark'], 'Enter resolves the selected value')
})
