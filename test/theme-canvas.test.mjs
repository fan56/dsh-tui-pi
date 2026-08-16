/**
 * App-owned canvas background tests.
 *
 * Two layers:
 * - `paintCanvasRow` (patched pi-tui export): the pure row transform that
 *   prefixes the canvas SGR, re-injects it after every background-clearing
 *   reset, and pads to the full row width.
 * - `TuiAltScreen` with a stub terminal: end-to-end that a canvas set at
 *   startup paints every rendered row, that switching the canvas recolors
 *   the screen, and that the transparent default stays untouched.
 *
 * Plus `rgbIsLight` (palette luminance) used by the OSC 11 auto-detection
 * path. Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { paintCanvasRow, TuiAltScreen } from '@earendil-works/pi-tui'
import { rgbIsLight } from '../lib/theme/palette.js'

const BG = '\x1b[48;2;13;17;23m'   // githubDark canvas
const RESET = '\x1b[0m'

test('paintCanvasRow prefixes the canvas and re-injects after resets', () => {
  const painted = paintCanvasRow(`\x1b[38;2;1;2;3mhi${RESET} there`, BG, 12)
  assert.ok(painted.startsWith(BG), 'row starts with the canvas background')
  // The fg reset clears the bg — the canvas must come back right after it.
  assert.ok(painted.includes(`${RESET}${BG}`), 'canvas re-injected after the fg reset')
  assert.ok(painted.endsWith(RESET), 'row ends on a clean reset')
})

test('paintCanvasRow leaves intentional background spans alone', () => {
  const bubble = `\x1b[48;2;22;27;34mbox${RESET}`
  const painted = paintCanvasRow(bubble, BG, 10)
  assert.ok(painted.includes(bubble), 'the explicit surface background survives verbatim')
  // ...but the canvas still frames it: prefix + re-injection after the close.
  assert.ok(painted.startsWith(BG) && painted.includes(`${RESET}${BG}`))
})

test('paintCanvasRow treats the implicit ESC[m reset as a bg clear', () => {
  const painted = paintCanvasRow(`\x1b[1mbold\x1b[m tail`, BG, 10)
  assert.ok(painted.includes(`\x1b[m${BG}`), 'implicit reset re-injects the canvas')
})

test('paintCanvasRow pads short rows to the full width', () => {
  const painted = paintCanvasRow('x', BG, 5)
  // prefix + 'x' + 4 spaces + reset
  assert.equal(painted, `${BG}x    ${RESET}`)
})

test('paintCanvasRow tolerates over-wide rows (pre-clamped by doRender)', () => {
  const wide = 'y'.repeat(20)
  const painted = paintCanvasRow(wide, BG, 5)
  assert.equal(painted, `${BG}${wide}${RESET}`)
})

test('paintCanvasRow re-injects after combined SGR resets (0;1)', () => {
  const painted = paintCanvasRow(`\x1b[0;1mcombined${RESET}`, BG, 12)
  assert.ok(painted.includes(`\x1b[0;1m${BG}`), '0;1 sequence is a reset too')
})

// ------------------------------------------------------------- TuiAltScreen --

/** Minimal fake terminal: records every write, reports a fixed size. */
function stubTerminal(columns = 40, rows = 8) {
  let inputHandler
  const writes = []
  return {
    writes,
    start(onInput) {
      inputHandler = onInput
    },
    stop() {},
    async drainInput() {},
    write(data) {
      writes.push(data)
    },
    get columns() {
      return columns
    },
    get rows() {
      return rows
    },
    get kittyProtocolActive() {
      return false
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    _inputHandler() {
      return inputHandler
    },
  }
}

function canvasRows(term) {
  // The render buffer paints every row as "\x1b[{row};1H\x1b[2K" + painted
  // line. Capture the line up to the next row / cursor / buffer end — the
  // line may carry SGRs and OSC 8 hyperlink bookkeeping.
  const buffer = term.writes.join('')
  const rows = [...buffer.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;1H|\x1b\[\?25l|\x1b\[\?2026l)/g)]
  return rows.map(([, row, content]) => ({ row: Number(row), content }))
}

test('TuiAltScreen paints the canvas on every rendered row when set', () => {
  const term = stubTerminal(12, 4)
  const tui = new TuiAltScreen(term, true)
  tui.setCanvasBackground(BG)
  tui.setLayoutRoot({ render: () => ['hi'] })
  tui.start()
  tui.renderNow(true)

  const rows = canvasRows(term)
  assert.ok(rows.length >= 4, `expected at least 4 rows, got ${rows.length}`)
  for (const { row, content } of rows) {
    assert.ok(content.startsWith(BG), `row ${row} starts with the canvas bg`)
    assert.ok(content.endsWith(RESET), `row ${row} ends with a reset`)
    // Padded to the full terminal width so the erase-line remainder is painted.
    assert.ok(content.length >= 2 + 12, `row ${row} padded to width`)
  }
})

test('TuiAltScreen transparent default writes no canvas SGR', () => {
  const term = stubTerminal(12, 4)
  const tui = new TuiAltScreen(term, true)
  tui.setLayoutRoot({ render: () => ['hi'] })
  tui.start()
  tui.renderNow(true)

  const rows = canvasRows(term)
  assert.ok(rows.length > 0)
  for (const { content } of rows) {
    assert.ok(!content.includes(BG), 'transparent canvas leaves rows unpainted')
  }
})

test('TuiAltScreen recolor: switching the canvas repaints every row', () => {
  const term = stubTerminal(12, 4)
  const tui = new TuiAltScreen(term, true)
  tui.setCanvasBackground(BG)
  tui.setLayoutRoot({ render: () => ['hi'] })
  tui.start()
  tui.renderNow(true)
  assert.ok(canvasRows(term).length >= 4, 'first render painted')
  term.writes.length = 0

  const lightBg = '\x1b[48;2;252;253;252m'
  tui.setCanvasBackground(lightBg)
  tui.renderNow(true)
  const after = canvasRows(term)

  assert.ok(after.length >= 4, 'recolor repainted the rows')
  for (const { content } of after) {
    assert.ok(content.startsWith(lightBg), 'rows repainted with the new canvas')
  }
})

// -------------------------------------------------------------- rgbIsLight --

test('rgbIsLight thresholds the OSC 11 background luminance', () => {
  assert.ok(rgbIsLight({ r: 255, g: 255, b: 255 }), 'white is light')
  assert.ok(!rgbIsLight({ r: 13, g: 17, b: 23 }), 'github-dark canvas is dark')
  assert.ok(rgbIsLight({ r: 252, g: 253, b: 252 }), 'github-light canvas is light')
  // A mid-gray sits below the 0.5 luminance threshold.
  assert.ok(!rgbIsLight({ r: 128, g: 128, b: 128 }))
})
