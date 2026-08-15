/**
 * Welcome banner tests — the startup whale pixel art + wordmark.
 * buildWelcomeBanner shape and colors (whale brand blue, half-block gaps
 * left transparent over the terminal default background, bold wordmark in
 * the theme fg), and TranscriptRenderer integration: the banner is the
 * doc's first child at construction, survives relayout, repaints against a
 * new theme while the whale keeps its brand blue, and is removed by
 * clear() (/new) like any startup screen. Also guards the art's
 * reproducibility from assets/whale-gen.mjs. Runs against the built lib/
 * (pnpm build && pnpm test).
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
import { buildWelcomeBanner, WHALE_ART, WHALE_COLOR } from '../lib/welcome.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')
const execFileAsync = promisify(execFile)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Number of consecutive non-space glyph runs in one art row. */
function runCount(row) {
  return row.split(' ').filter(part => part !== '').length
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

test('buildWelcomeBanner: 10 equal-width rows, wordmark centered on row 4', () => {
  const banner = buildWelcomeBanner(lightTheme)
  const rows = banner.split('\n')
  assert.equal(rows.length, 10)
  const widths = [...new Set(rows.map(row => visibleWidth(row)))]
  assert.deepEqual(widths, [39], 'every row is the same visible width (28 art + 4 gap + 7 wordmark)')

  const plain = rows.map(stripAnsi)
  const wordmarkRows = plain.map((row, i) => row.includes('DSH TUI') ? i : -1).filter(i => i !== -1)
  assert.deepEqual(wordmarkRows, [4], 'the wordmark appears on exactly the centered row (0-based 4)')
  assert.equal(plain[4].indexOf('DSH TUI'), 32, 'wordmark sits 4 columns after the 28-wide whale')
  assert.equal(plain[4].slice(28, 32), '    ', 'the gap between whale and wordmark is 4 spaces')
})

test('buildWelcomeBanner paints every whale run in the brand blue with resets between runs', () => {
  const banner = buildWelcomeBanner(lightTheme)
  const rows = banner.split('\n')
  const whaleFg = ansiFg(WHALE_COLOR)
  for (let i = 0; i < WHALE_ART.length; i++) {
    const spans = rows[i].split(whaleFg).length - 1
    assert.equal(spans, runCount(WHALE_ART[i]), `row ${i}: one whale-blue span per glyph run`)
  }
})

test('no whale run paints a canvas background — half-block gaps fall through to the terminal default', () => {
  const banner = buildWelcomeBanner(lightTheme)
  const rows = banner.split('\n')
  const canvasBg = ansiBg(githubLight.canvas)
  for (let i = 0; i < WHALE_ART.length; i++) {
    assert.ok(!rows[i].includes(canvasBg), `row ${i}: no canvas bg — half-block gaps stay transparent over the terminal default`)
  }
  const darkCanvasBg = ansiBg(githubDark.canvas)
  for (let i = 0; i < WHALE_ART.length; i++) {
    assert.ok(!rows[i].includes(darkCanvasBg), `row ${i}: no dark canvas bg either (bg is never painted, theme-independent)`)
  }
  // The two canvases differ, so the assertions above are not vacuously equal.
  assert.notEqual(githubLight.canvas, githubDark.canvas)
})

test('the wordmark is bold in the theme fgDefault and reset after', () => {
  const banner = buildWelcomeBanner(darkTheme)
  const row = banner.split('\n')[4]
  const titleStart = row.indexOf('DSH TUI')
  assert.ok(row.slice(0, titleStart).endsWith(BOLD + ansiFg(githubDark.fgDefault)),
    'wordmark prefixed with bold + dark fg')
  assert.ok(row.slice(titleStart + 'DSH TUI'.length).startsWith(RESET), 'wordmark reset after')
})

test('the banner is the doc first child at construction (Text + spacer)', () => {
  const doc = new Container()
  new TranscriptRenderer(doc, lightTheme, () => {}, '5')
  assert.equal(doc.children.length, 2, 'banner Text plus the trailing spacer')
  assert.ok(doc.children[0] instanceof Text, 'first child is the banner Text')
  assert.ok(doc.children[1] instanceof Spacer, 'second child is the spacer')
  const rendered = doc.children[0].render(200)
  assert.equal(rendered.length, 10, 'banner renders its 10 rows')
  assert.ok(rendered.map(stripAnsi).join('\n').includes('DSH TUI'), 'banner carries the wordmark')
})

test('the banner needs 41 columns (39 wide + 1-column Text padding each side)', () => {
  const doc = new Container()
  new TranscriptRenderer(doc, lightTheme, () => {}, '5')
  const banner = doc.children[0]
  assert.equal(banner.render(200).length, 10, 'wide terminal: 10 rows')
  assert.equal(banner.render(80).length, 10, '80 columns: 10 rows')
  assert.equal(banner.render(41).length, 10, '41 columns: 39-wide rows plus 2 padding columns fit exactly')
  assert.ok(banner.render(40).length > 10, '40 columns: rows wrap onto extra lines (accepted degradation, see welcome.ts)')
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
  assert.ok(!renderDoc(doc).includes('DSH TUI'), 'no wordmark anywhere after /new')
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
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {}, '5')
  renderer.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, ts: 0, seq: 1 })
  renderer.relayout()
  assert.equal(doc.children[0].render(200).length, 10, 'banner keeps its 10 rows after relayout')
  const plain = doc.children[0].render(200).map(stripAnsi)
  assert.equal(plain.filter(row => row.includes('DSH TUI')).length, 1, 'wordmark still on one row')
  assert.equal(plain.findIndex(row => row.includes('DSH TUI')), 4, 'wordmark still on row 4')
  assert.ok(renderDoc(doc).includes('hello'), 'message content survives the relayout below the banner')
})

test('setTheme repaints the banner: whale keeps the brand blue, theme colors follow', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {}, '5')
  renderer.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, ts: 0, seq: 1 })
  renderer.setTheme(darkTheme)

  assert.equal(doc.children[0].render(200).length, 10, 'banner rebuilt at 10 rows')
  const styled = doc.children[0].render(200).join('\n')
  assert.ok(styled.includes(ansiFg(WHALE_COLOR)), 'whale blue unchanged across themes')
  assert.ok(!styled.includes(ansiBg(githubDark.canvas)), 'half-block gaps stay transparent — no dark canvas bg after the switch')
  assert.ok(!styled.includes(ansiBg(githubLight.canvas)), 'no light canvas left behind')
  assert.ok(styled.includes(BOLD + ansiFg(githubDark.fgDefault) + 'DSH TUI'), 'wordmark repainted in the dark fg')
  assert.ok(!styled.includes(BOLD + ansiFg(githubLight.fgDefault)), 'no light-fg wordmark left behind')
  // One whale-blue span per run after the rebuild too — no double painting.
  const spans = doc.children[0].render(200).map((row, i) => row.split(ansiFg(WHALE_COLOR)).length - 1)
  assert.deepEqual(spans, WHALE_ART.map(runCount), 'each rebuilt row keeps one span per run')
  assert.ok(renderDoc(doc).includes('hello'), 'message content survives below the rebuilt banner')
})

/** Render every doc child into one plain text blob (ANSI stripped off). */
function renderDoc(doc, width = 200) {
  return doc.children.map(child => child.render(width).map(stripAnsi).join('\n')).join('\n')
}
