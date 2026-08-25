/**
 * Daily-quote tests — the welcome banner's caption line (see src/quotes.ts
 * and messages.ts renderWelcome): the pool's shape (100 unique, non-empty,
 * CJK-safe width so the formatted line fits under the 94-column banner),
 * the roll (injectable rand, always a pool member), and the transcript
 * integration (a muted caption Text under the banner, one pick per session
 * that survives relayout and theme switches, clipped before styling so it
 * never wraps, removed by /new with the rest of the startup screen).
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Container, Spacer, Text } from '@earendil-works/pi-tui'
import { TranscriptRenderer } from '../lib/messages.js'
import { ansiFg, darkTheme, lightTheme, RESET } from '../lib/theme/index.js'
import { visibleWidth } from '../lib/text.js'
import { DAILY_QUOTES, formatDailyQuote, pickDailyQuote } from '../lib/quotes.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

/** Temporarily set process.stdout.columns (renderWelcome reads it). */
function withColumns(columns, fn) {
  const hadOwn = Object.hasOwn(process.stdout, 'columns')
  const prev = process.stdout.columns
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true })
  try {
    return fn()
  } finally {
    if (hadOwn) Object.defineProperty(process.stdout, 'columns', { value: prev, configurable: true })
    else delete process.stdout.columns
  }
}

test('DAILY_QUOTES: 100 unique, non-empty, CJK-safe one-liners', () => {
  assert.equal(DAILY_QUOTES.length, 100, 'exactly 100 quotes')
  assert.equal(new Set(DAILY_QUOTES).size, 100, 'no duplicates')
  for (const quote of DAILY_QUOTES) {
    assert.ok(quote.length > 0, 'no empty quote')
    assert.ok(!/\x1b\[/.test(quote), 'no ANSI in the pool — quotes are clipped before styling')
  }
  // 20 full-width chars = 40 columns; +4 for 「」 keeps every formatted
  // line within the 94-column banner width.
  const widths = DAILY_QUOTES.map(quote => visibleWidth(quote))
  assert.equal(Math.max(...widths) <= 40, true, `longest quote is ${Math.max(...widths)} columns (≤ 40)`)
  assert.equal(Math.max(...DAILY_QUOTES.map(quote => visibleWidth(formatDailyQuote(quote)))) <= 44, true,
    'formatted lines (「quote」) all fit within 44 columns')
})

test('formatDailyQuote wraps the line in CJK corner brackets', () => {
  assert.equal(formatDailyQuote('今天也要开开心心呀'), '「今天也要开开心心呀」')
  assert.equal(visibleWidth(formatDailyQuote('好事正在路上,慢慢来')), visibleWidth('好事正在路上,慢慢来') + 4,
    'brackets add exactly 4 columns (2 each, full-width)')
})

test('pickDailyQuote rolls a pool member; rand is injectable edge-to-edge', () => {
  for (let i = 0; i < 50; i++) {
    const quote = pickDailyQuote()
    assert.ok(DAILY_QUOTES.includes(quote), `roll ${i} stays inside the pool`)
  }
  assert.equal(pickDailyQuote(() => 0), DAILY_QUOTES[0], 'rand 0 → first quote')
  assert.equal(pickDailyQuote(() => 0.999999), DAILY_QUOTES[DAILY_QUOTES.length - 1], 'rand ~1 → last quote (never out of range)')
})

test('the quote renders as a muted caption Text right under the banner', () => {
  const doc = new Container()
  withColumns(200, () => new TranscriptRenderer(doc, lightTheme, () => {}))
  assert.equal(doc.children.length, 5, 'spacer, banner, spacer, quote, spacer')
  assert.ok(doc.children[0] instanceof Spacer, 'leading spacer')
  assert.ok(doc.children[1] instanceof Text, 'banner Text')
  assert.ok(doc.children[2] instanceof Spacer, 'spacer between banner and quote')
  assert.ok(doc.children[3] instanceof Text, 'quote Text')
  assert.ok(doc.children[4] instanceof Spacer, 'trailing spacer')

  const line = doc.children[3].render(200)[0]
  const plain = stripAnsi(line)
  assert.ok(line.includes(ansiFg(lightTheme.palette.fgSubtle)), 'caption painted in the theme fgSubtle')
  assert.ok(line.trimEnd().endsWith(RESET), 'caption span closed (Text pads lines after the RESET)')
  assert.ok(plain.includes('「') && plain.includes('」'), 'bracketed line')
  // The whale icon prefixes the caption inline, exactly once, mirroring the
  // assistant's `🐳: text` chat contract (never its own line).
  assert.ok(plain.trim().startsWith('🐳 '), `caption is whale-prefixed (got: ${plain.trim()})`)
  assert.equal((plain.match(/🐳/g) ?? []).length, 1, 'one whale icon inline, never on its own line')
  assert.ok(!plain.includes('🐳\n'), 'the whale never takes its own line')
  const inner = plain.trim().replace(/^🐳\s*/, '').slice(1, -1)
  assert.ok(DAILY_QUOTES.includes(inner), `the shown line is a pool quote (got: ${inner})`)
})

test('one pick per session: relayout and theme switches keep the same quote', () => {
  const doc = new Container()
  const renderer = withColumns(200, () => {
    const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
    renderer.relayout()
    return renderer
  })
  const quoteAt = () => stripAnsi(doc.children[3].render(200)[0]).trim()
  const afterRelayout = quoteAt()
  renderer.setTheme(darkTheme)
  const afterTheme = quoteAt()
  assert.equal(afterTheme, afterRelayout, 'same quote text across a theme switch')
  const line = doc.children[3].render(200)[0]
  assert.ok(line.includes(ansiFg(darkTheme.palette.fgSubtle)), 'but repainted in the new theme fgSubtle')
  assert.ok(!line.includes(ansiFg(lightTheme.palette.fgSubtle)), 'no light fgSubtle left behind')
})

test('the quote line is clipped to the terminal width before styling', () => {
  const doc = new Container()
  withColumns(40, () => new TranscriptRenderer(doc, lightTheme, () => {}))
  // "Never wraps" is the contract, proven at the widest pool line: the max
  // formatted quote is 35 columns (`「…」` brackets +4), so with the 🐳
  // (2 cols) + space prefix the longest line is exactly 38 columns — the
  // 40−2 = 38-column clip budget. Width 40 therefore clips nothing, and the
  // longest roll stays one never-wrapping line.
  assert.equal(doc.children[3].render(40).length, 1, 'quote renders as exactly one line at 40 columns')
  const content = stripAnsi(doc.children[3].render(40)[0]).trimEnd().trimStart()
  assert.ok(content.startsWith('🐳'), 'clipped content still starts with the whale icon')
  assert.ok(content.includes('「') && content.includes('」'), 'and the bracketed quote still follows')
  assert.ok(visibleWidth(content) <= 38, `content is ${visibleWidth(content)} columns (≤ 40 − 2 padding)`)

  // A genuinely clipping width: budget 30−2 = 28 is well below the 38-column
  // max, so the emoji-clip guard is really exercised. Clip is width-safe and
  // never splits a grapheme; 🐳 (2) + space + 「 (2) ⇒ 5 cols, kept.
  const doc2 = new Container()
  withColumns(30, () => new TranscriptRenderer(doc2, lightTheme, () => {}))
  const clippedRows = doc2.children[3].render(30)
  assert.equal(clippedRows.length, 1, 'even clipped, the caption is exactly one physical row (never wraps)')
  const clippedContent = stripAnsi(clippedRows[0]).trimEnd().trimStart()
  assert.ok(clippedContent.startsWith('🐳 「'), `clipped content still opens with the whale and 「 (got: ${clippedContent})`)
  assert.ok(visibleWidth(clippedContent) <= 28, `clipped content is ${visibleWidth(clippedContent)} columns (≤ 30 − 2 padding)`)
})

test('clear() (/new) removes the quote with the rest of the startup screen', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.clear()
  assert.equal(doc.children.length, 0, 'doc emptied — quote gone with the banner')
  renderer.setTheme(darkTheme)
  renderer.relayout()
  assert.equal(doc.children.length, 0, 'the quote does not resurrect on rebuilds after /new')
})
