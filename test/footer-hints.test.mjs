/**
 * Footer hint bar tests - src/footer.ts's buildFooterHint and the no-wrap
 * FooterHint component. buildFooterHint assembles the hint bar from the
 * per-segment on/off selection; FooterHint clips it to the current width so
 * it never word-wraps on a narrow terminal.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_FOOTER_HINTS,
  FOOTER_HINT,
  FOOTER_HINT_ITEMS,
  FooterHint,
  PowerlineFooter,
  buildFooterHint,
} from '../lib/footer.js'
import { ansiBg, ansiFg, darkTheme, lightTheme, POWERLINE } from '../lib/theme/index.js'
import { visibleWidth } from '../lib/text.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

test('buildFooterHint with the default selection equals the legacy FOOTER_HINT', () => {
  assert.equal(buildFooterHint(DEFAULT_FOOTER_HINTS), FOOTER_HINT)
})

test('buildFooterHint keeps only the selected segments, in the fixed display order', () => {
  const shown = { ...DEFAULT_FOOTER_HINTS, send: false, subagents: false, search: false }
  const hint = buildFooterHint(shown)
  assert.equal(hint, '⌨ Esc ×2: stop · Ctrl+C ×2: quit · Ctrl+D: quit (empty) · Tab: preset · ↑↓: history')
  assert.ok(!hint.includes('Enter: send'))
  assert.ok(!hint.includes('Ctrl+G: subagents'))
  assert.ok(!hint.includes('Ctrl+Shift+F: search'))
})

test('buildFooterHint with every segment off is empty', () => {
  const allOff = Object.fromEntries(FOOTER_HINT_ITEMS.map(item => [item.id, false]))
  assert.equal(buildFooterHint(allOff), '')
})

test('DEFAULT_FOOTER_HINTS covers exactly the eight FOOTER_HINT_ITEMS keys, all on', () => {
  const ids = FOOTER_HINT_ITEMS.map(item => item.id)
  assert.deepEqual(Object.keys(DEFAULT_FOOTER_HINTS).sort(), ids.slice().sort())
  for (const id of ids) assert.equal(DEFAULT_FOOTER_HINTS[id], true)
})

test('the default hint width matches the current segment set', () => {
  // Width guard: record the current width so future edits notice growth.
  // The hint bar clips to terminal width, so growth is safe. Grew from 117
  // to 140 when the Ctrl+Shift+F search segment joined (transcript search).
  assert.equal(visibleWidth(FOOTER_HINT), 140)
})

test('FooterHint renders one clipped row at any width - never a wrap', () => {
  const hint = new FooterHint(() => darkTheme, () => DEFAULT_FOOTER_HINTS)
  for (const width of [40, 80, 200]) {
    const rows = hint.render(width)
    assert.equal(rows.length, 1, `one row at width ${width}`)
    const plain = stripAnsi(rows[0])
    assert.ok(visibleWidth(plain) <= width, `row fits ${width} (${visibleWidth(plain)})`)
  }
  // Narrow widths clip the tail (the hint is 103 cols); wide widths show it all.
  const narrow = stripAnsi(hint.render(60)[0])
  assert.ok(!narrow.includes('↑↓: history'), 'narrow row clips the trailing segment')
  const wide = stripAnsi(hint.render(200)[0])
  assert.ok(wide.includes('↑↓: history'), 'wide row shows the full hint')
})

test('FooterHint renders zero rows when every hint is off', () => {
  const allOff = Object.fromEntries(FOOTER_HINT_ITEMS.map(item => [item.id, false]))
  const hint = new FooterHint(() => darkTheme, () => allOff)
  assert.deepEqual(hint.render(80), [])
})

/** FooterDataSource stub driving the powerline segments + clock. */
function footerSource(overrides = {}) {
  return {
    getStats: () => ({
      inputTokens: 600,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      // Current-occupancy estimate (the Context segment numerator) — NOT the
      // cumulative inputTokens. 600 of a 1000-token window = 60% → contextWarn.
      contextTokens: 600,
      msgCount: 1,
      toolCallCount: 0,
      ...overrides.stats,
    }),
    getSelection: () => overrides.selection ?? { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'off' },
    getContextWindow: () => overrides.contextWindow ?? 1000,
    getBranch: () => undefined,
    getPreset: () => undefined,
  }
}

test('PowerlineFooter styles the clock with the palette foreground (never terminal-default black)', () => {
  for (const theme of [darkTheme, lightTheme]) {
    const footer = new PowerlineFooter(footerSource(), () => theme)
    const row = footer.render(200)[0]
    const clock = new RegExp(ansiFg(theme.palette.fgDefault).replace(/[[\\]/g, '\\$&') + '\\d{2}:\\d{2}:\\d{2}\\x1b\\[0m$')
    assert.match(row, clock, `${theme.palette.name}: trailing clock carries the palette fg color`)
  }
})

test('PowerlineFooter uses near-black text on bright segment fills (amber warn), white on dark fills', () => {
  // 600/1000 = 60% context → contextWarn (#FFC107, a bright fill); the brand
  // segment (#4D6BFE) stays a dark fill with white bold text.
  const footer = new PowerlineFooter(footerSource(), () => lightTheme)
  const row = footer.render(200)[0]
  assert.ok(row.includes(ansiFg('#1f2328')), 'bright amber segment carries near-black text')
  assert.ok(row.includes(ansiFg('#FFFFFF')), 'dark segment fills keep white bold text')
  const amber = row.indexOf(ansiBg(POWERLINE.contextWarn))
  assert.ok(amber >= 0, 'context-warn segment present at 60% usage')
  assert.ok(row.indexOf(ansiFg('#1f2328')) > amber, 'dark text sits on the amber segment')
})

test('the footer context percent is capped at 100 (occupancy can overshoot while pricing pending messages)', () => {
  // 5000 / 1000 = 500% uncapped; Math.min(100, …) clamps the display like the
  // web client's StatsLine (the window is a hard ceiling).
  const footer = new PowerlineFooter(footerSource({ stats: { contextTokens: 5000 } }), () => darkTheme)
  const row = footer.render(200)[0]
  assert.ok(row.includes('(100.0%)'), 'percent caps at 100 even when the estimate overshoots the window')
  assert.ok(!row.includes('500%'), 'no uncapped 500% anywhere in the row')
  assert.ok(row.includes(ansiBg(POWERLINE.contextDanger)), 'a capped 100% routes to the danger fill')
})
