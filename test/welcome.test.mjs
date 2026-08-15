/**
 * Welcome banner tests — the startup whale pixel art + pixel-letter
 * wordmark. buildWelcomeBanner shape and colors (whale brand blue,
 * half-block gaps left transparent over the terminal default background,
 * wordmark letters in the same brand blue, banner theme-independent), and
 * TranscriptRenderer integration: the banner is the doc's first child at
 * construction, survives relayout, repaints identically against a new theme
 * (nothing theme-dependent), and is removed by clear() (/new) like any
 * startup screen. Also guards the art's reproducibility from
 * assets/whale-gen.mjs. Runs against the built lib/ (pnpm build && pnpm
 * test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Container, Spacer, Text } from '@earendil-works/pi-tui'
import { TranscriptRenderer } from '../lib/messages.js'
import { ansiBg, ansiFg, BOLD, darkTheme, lightTheme, POWERLINE, RESET } from '../lib/theme/index.js'
import { githubDark, githubLight } from '../lib/theme/palette.js'
import { visibleWidth } from '../lib/text.js'
import { buildWelcomeBanner, PIXEL_FONT, WHALE_ART, WHALE_COLOR, WORDMARK } from '../lib/welcome.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')
const execFileAsync = promisify(execFile)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Number of consecutive non-space glyph runs in one art row. */
function runCount(row) {
  return row.split(' ').filter(part => part !== '').length
}

/** Number of brand-blue runs the wordmark letters contribute to one banner row (from the pinned golden). */
function letterRunCount(r) {
  return runCount(LETTER_ROWS[r])
}

/**
 * The wordmark's 36-letter-column rows, all 10 pinned golden: 5 per letter,
 * 1 between letters, 2 between words (D S H [gap] T U I). Pinned as the
 * single source of truth for the rendered letter block, so a glyph or
 * layout regression fails even when it keeps the run structure intact.
 */
const LETTER_ROWS = [
  '█████ █████ █   █  █████ █   █ █████',
  '█   █ █     █   █    █   █   █   █  ',
  '█   █ █     █   █    █   █   █   █  ',
  '█   █ █████ █   █    █   █   █   █  ',
  '█   █     █ █████    █   █   █   █  ',
  '█   █     █ █   █    █   █   █   █  ',
  '█   █     █ █   █    █   █   █   █  ',
  '█   █     █ █   █    █   █   █   █  ',
  '█   █ █     █   █    █   █   █   █  ',
  '█████ █████ █   █    █   █████ █████',
]

/** Temporarily set process.stdout.columns (renderWelcome reads it at construction). */
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

test('WHALE_COLOR is the powerline brand blue (single source)', () => {
  assert.equal(WHALE_COLOR, POWERLINE.brand)
  assert.equal(WHALE_COLOR, '#4D6BFE')
})

test('WHALE_ART is the 10-row × 28-column grid of documented glyphs', () => {
  assert.equal(WHALE_ART.length, 10)
  const widths = [...new Set(WHALE_ART.map(row => row.length))]
  assert.deepEqual(widths, [28], 'every row is exactly 28 columns')
  for (const row of WHALE_ART) {
    assert.match(row, /^[ ▀▄█]+$/, 'only spaces, half-blocks and full blocks')
  }
})

test('PIXEL_FONT: 5-column × 10-row blocky font, one glyph per wordmark letter', () => {
  assert.deepEqual(Object.keys(PIXEL_FONT).sort(), ['D', 'H', 'I', 'S', 'T', 'U'], 'glyphs for every letter of "DSH TUI"')
  for (const [ch, glyph] of Object.entries(PIXEL_FONT)) {
    assert.equal(glyph.length, WHALE_ART.length, `${ch}: as many rows as the whale (top-aligned)`)
    const widths = [...new Set(glyph.map(row => row.length))]
    assert.deepEqual(widths, [5], `${ch}: every row is exactly 5 columns`)
    for (const row of glyph) {
      assert.match(row, /^[#.]+$/, `${ch}: only stroke (#) and empty (.) cells`)
      assert.ok(row.includes('#'), `${ch}: every row carries a stroke — no fully blank letter row`)
    }
  }
})

test('every WORDMARK letter has a PIXEL_FONT glyph', () => {
  const missing = [...WORDMARK].filter(ch => ch !== ' ' && PIXEL_FONT[ch] === undefined)
  assert.deepEqual(missing, [],
    'WORDMARK minus spaces is a subset of PIXEL_FONT keys (wordmarkRows throws on a gap — fail at startup, not on render)')
})

test('buildWelcomeBanner: 10 equal-width rows, pixel letters aligned right of the whale', () => {
  const banner = buildWelcomeBanner()
  const rows = banner.split('\n')
  assert.equal(rows.length, 10)
  const widths = [...new Set(rows.map(row => visibleWidth(row)))]
  assert.deepEqual(widths, [68], 'every row is the same visible width (28 art + 4 gap + 36 letters)')

  const plain = rows.map(stripAnsi)
  for (let i = 0; i < WHALE_ART.length; i++) {
    assert.equal(plain[i].slice(0, 28), WHALE_ART[i], `row ${i}: whale art occupies columns 0-27`)
    assert.equal(plain[i].slice(28, 32), '    ', `row ${i}: the gap between whale and letters is 4 spaces`)
    assert.equal(plain[i].slice(32, 68), LETTER_ROWS[i], `row ${i}: letters occupy columns 32-67 — the pinned 10-row golden`)
  }
})

test('buildWelcomeBanner paints every whale and letter run in the brand blue with resets between runs', () => {
  const banner = buildWelcomeBanner()
  const rows = banner.split('\n')
  const whaleFg = ansiFg(WHALE_COLOR)
  for (let i = 0; i < WHALE_ART.length; i++) {
    const spans = rows[i].split(whaleFg).length - 1
    assert.equal(spans, runCount(WHALE_ART[i]) + letterRunCount(i),
      `row ${i}: one brand-blue span per whale run plus per letter run`)
  }
  assert.equal(banner.split(whaleFg).length - 1, banner.split(RESET).length - 1,
    'every brand-blue span (whale and letters) is opened and closed — one RESET per span')
})

test('no whale or letter run paints a canvas background — gaps fall through to the terminal default', () => {
  const banner = buildWelcomeBanner()
  const rows = banner.split('\n')
  const canvasBg = ansiBg(githubLight.canvas)
  for (let i = 0; i < WHALE_ART.length; i++) {
    assert.ok(!rows[i].includes(canvasBg), `row ${i}: no canvas bg — half-block and letter gaps stay transparent over the terminal default`)
  }
  const darkCanvasBg = ansiBg(githubDark.canvas)
  for (let i = 0; i < WHALE_ART.length; i++) {
    assert.ok(!rows[i].includes(darkCanvasBg), `row ${i}: no dark canvas bg either (bg is never painted, theme-independent)`)
  }
  // The two canvases differ, so the assertions above are not vacuously equal.
  assert.notEqual(githubLight.canvas, githubDark.canvas)
})

test('the banner carries no theme colors — whale and letters are brand blue only', () => {
  const banner = buildWelcomeBanner()
  assert.ok(!banner.includes(BOLD), 'no bold anywhere — the pixel letters carry their own weight')
  assert.ok(!banner.includes(ansiFg(githubDark.fgDefault)) && !banner.includes(ansiFg(githubLight.fgDefault)),
    'no theme fg — the banner is theme-independent, colored from WHALE_COLOR only')
})

test('the banner is the doc first child at construction (Text + spacer)', () => {
  const doc = new Container()
  // Fixed wide width: renderWelcome builds the banner at process.stdout.columns.
  withColumns(200, () => new TranscriptRenderer(doc, lightTheme, () => {}, '5'))
  assert.equal(doc.children.length, 2, 'banner Text plus the trailing spacer')
  assert.ok(doc.children[0] instanceof Text, 'first child is the banner Text')
  assert.ok(doc.children[1] instanceof Spacer, 'second child is the spacer')
  const rendered = doc.children[0].render(200)
  assert.equal(rendered.length, 10, 'banner renders its 10 rows')
  const plain = rendered.map(stripAnsi)
  // Each Text line carries a 1-column margin, so banner columns 32-67 land
  // at line columns 33-68.
  assert.equal(plain[0].slice(33, 69), LETTER_ROWS[0], 'banner carries the pixel letters, top row')
  assert.equal(plain[9].slice(33, 69), LETTER_ROWS[9], 'banner carries the pixel letters, bottom row')
})

test('buildWelcomeBanner: below 70 columns the banner degrades to the whale alone', () => {
  const degraded = buildWelcomeBanner(69).split('\n')
  assert.equal(degraded.length, 10, '69 columns: still 10 rows')
  const plain = degraded.map(stripAnsi)
  assert.deepEqual(plain, [...WHALE_ART], '69 columns: rows are exactly the bare art — no gap, no letters')
  assert.deepEqual([...new Set(plain.map(row => row.length))], [28], '69 columns: every row is 28 columns wide')
  assert.equal(buildWelcomeBanner(70).split('\n').length, 10, '70 columns: full banner, 10 rows')
  assert.deepEqual([...new Set(buildWelcomeBanner(70).split('\n').map(row => visibleWidth(row)))], [68],
    '70 columns: full banner is back at 68 columns')
  assert.equal(buildWelcomeBanner(30).split('\n').length, 10, '30 columns: still whale-only, 10 rows')
  assert.deepEqual(buildWelcomeBanner(30).split('\n').map(stripAnsi), [...WHALE_ART], '30 columns: whale-only rows unchanged')
})

test('narrow terminals render the whale-only banner as 10 rows; the 30-column floor is the limit', () => {
  // 70 columns: the full banner (68 + 1-column Text padding each side) fits.
  const full = withColumns(70, () => {
    const doc = new Container()
    new TranscriptRenderer(doc, lightTheme, () => {}, '5')
    return doc.children[0]
  })
  assert.equal(full.render(70).length, 10, '70 columns: full banner renders as exactly 10 rows')
  const fullPlain = full.render(200).map(stripAnsi)
  assert.equal(fullPlain[0].slice(33, 69), LETTER_ROWS[0], '70 columns: the letters are present')

  // 69 columns: the banner is built whale-only — still 10 rows, no letters.
  const whaleOnly = withColumns(69, () => {
    const doc = new Container()
    new TranscriptRenderer(doc, lightTheme, () => {}, '5')
    return doc.children[0]
  })
  assert.equal(whaleOnly.render(200).length, 10, '69 columns: whale-only banner, 10 rows')
  const whalePlain = whaleOnly.render(200).map(stripAnsi)
  for (let i = 0; i < 10; i++) {
    assert.equal(whalePlain[i].slice(1, 29), WHALE_ART[i], `row ${i}: whale-only rows are the bare art — no letter runs`)
  }
  assert.equal(whaleOnly.render(30).length, 10, '30 columns: whale-only rows (28 + 2 padding) fit exactly — the new floor')
  assert.ok(whaleOnly.render(29).length > 10, '29 columns: below the floor the whale rows wrap (accepted degradation, see welcome.ts)')
})

test('clear() (/new) removes the banner — it is a startup screen, not transcript chrome', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {}, '5')
  renderer.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, ts: 0, seq: 1 })
  assert.equal(doc.children.length > 2, true, 'banner + spacer + message components before /new')
  renderer.clear()
  assert.equal(doc.children.length, 0, 'clear() empties the doc, banner included')
  renderer.setTheme(darkTheme)
  assert.equal(doc.children.length, 0, 'the banner does not resurrect on a theme switch')
  renderer.relayout()
  assert.equal(doc.children.length, 0, 'the banner does not resurrect on relayout')
  assert.ok(!renderDoc(doc).includes('█████'), 'no pixel wordmark anywhere after /new')
})

test('assets/whale-gen.mjs regenerates WHALE_ART character-for-character', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['assets/whale-gen.mjs'], { cwd: repoRoot })
  const generated = JSON.parse(stdout)
  assert.deepEqual(generated, [...WHALE_ART], 'generator output must match the shipped art (regenerate after editing the source image)')
})

test('the event flow appends after the banner and never touches it', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, darkTheme, () => {}, '5')
  const before = doc.children[0].render(200).join('\n')
  renderer.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, ts: 0, seq: 1 })
  assert.equal(doc.children[0].render(200).join('\n'), before, 'banner bytes unchanged by events')
  assert.ok(doc.children.length > 2, 'message components appended after the banner')
  assert.ok(renderDoc(doc).includes('hello'), 'message content rendered below the banner')
})

test('relayout rebuilds the banner first, unchanged in rows and position', () => {
  const doc = new Container()
  const renderer = withColumns(200, () => {
    const renderer = new TranscriptRenderer(doc, lightTheme, () => {}, '5')
    renderer.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, ts: 0, seq: 1 })
    // relayout re-reads the width — keep it under the same wide stub.
    renderer.relayout()
    return renderer
  })
  assert.equal(doc.children[0].render(200).length, 10, 'banner keeps its 10 rows after relayout')
  const plain = doc.children[0].render(200).map(stripAnsi)
  // 1-column Text margin shifts the letters from banner columns 32-67 to 33-68.
  assert.equal(plain[0].slice(33, 69), LETTER_ROWS[0], 'pixel letters still present and aligned after relayout')
  assert.equal(plain[9].slice(33, 69), LETTER_ROWS[9], 'letter bottom strokes still present after relayout')
  assert.ok(renderDoc(doc).includes('hello'), 'message content survives the relayout below the banner')
})

test('every relayout rebuilds the banner at the current width (welcome op survives repeated rebuilds)', () => {
  const doc = new Container()
  const renderer = withColumns(100, () => {
    const renderer = new TranscriptRenderer(doc, lightTheme, () => {}, '5')
    renderer.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, ts: 0, seq: 1 })
    // Shrink: the banner degrades to the whale only.
    withColumns(60, () => renderer.relayout())
    // Widen again: it must come BACK to the full letters — the welcome op
    // must survive the first relayout (regression: it used to be consumed
    // on the first rebuild and freeze the banner at that width).
    withColumns(100, () => renderer.relayout())
    return renderer
  })
  const plain = doc.children[0].render(200).map(stripAnsi)
  assert.equal(plain.length, 10, 'banner stays 10 rows through both relayouts')
  assert.equal(plain[0].slice(33, 69), LETTER_ROWS[0], 'letters restored after widening back')
  assert.equal(plain[9].slice(33, 69), LETTER_ROWS[9], 'letter bottom strokes restored')
  // And a third relayout (e.g. another resize or a theme switch) still works.
  withColumns(100, () => renderer.relayout())
  const again = doc.children[0].render(200).map(stripAnsi)
  assert.equal(again[0].slice(33, 69), LETTER_ROWS[0], 'a third relayout still rebuilds the full banner')
})

test('setTheme repaints the banner identically — whale and letters are theme-independent brand blue', () => {
  const doc = new Container()
  // Fixed wide width: the construction banner and the setTheme rebuild both
  // read process.stdout.columns.
  const renderer = withColumns(200, () => {
    const renderer = new TranscriptRenderer(doc, lightTheme, () => {}, '5')
    renderer.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, ts: 0, seq: 1 })
    renderer.setTheme(darkTheme)
    return renderer
  })
  const before = doc.children[0].render(200).join('\n')
  const after = doc.children[0].render(200).join('\n')

  assert.equal(after, before, 'banner bytes are identical across themes — nothing theme-dependent left')
  assert.equal(doc.children[0].render(200).length, 10, 'banner rebuilt at 10 rows')
  assert.ok(after.includes(ansiFg(WHALE_COLOR)), 'whale blue present after the switch')
  assert.ok(!after.includes(ansiBg(githubDark.canvas)), 'gaps stay transparent — no dark canvas bg after the switch')
  assert.ok(!after.includes(ansiBg(githubLight.canvas)), 'no light canvas left behind')
  // One brand-blue span per run after the rebuild too — no double painting.
  const spans = doc.children[0].render(200).map((row, i) => row.split(ansiFg(WHALE_COLOR)).length - 1)
  assert.deepEqual(spans, WHALE_ART.map((_, i) => runCount(WHALE_ART[i]) + letterRunCount(i)),
    'each rebuilt row keeps one span per whale run plus per letter run')
  assert.ok(renderDoc(doc).includes('hello'), 'message content survives below the rebuilt banner')
})

/** Render every doc child into one plain text blob (ANSI stripped off). */
function renderDoc(doc, width = 200) {
  return doc.children.map(child => child.render(width).map(stripAnsi).join('\n')).join('\n')
}
