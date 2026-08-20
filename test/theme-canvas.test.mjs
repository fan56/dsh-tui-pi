/**
 * App-owned canvas background tests.
 *
 * The canvas is painted by `CanvasTerminal` (src/canvas-terminal.ts), a
 * write-stream decorator wrapped around the terminal handed to TuiAltScreen:
 * it prefixes the canvas SGR before every erase-line (`\x1b[2K`) and
 * erase-screen (`\x1b[2J`) sequence, and terminals with BCE (back color
 * erase) fill the erased regions with that background — no pi-tui patches.
 *
 * Layers:
 * - CanvasTerminal unit tests (stub inner terminal): SGR injection at erase
 *   boundaries, transparent passthrough, alt-screen exit shutoff, and
 *   forwarding of the non-write Terminal members.
 * - TuiAltScreen driven through a CanvasTerminal: end-to-end that a canvas
 *   set at startup paints every rendered row, that a recolor with a forced
 *   redraw (what applyTheme does via requestRender(true)) repaints the
 *   screen with the new color, and that the alt-screen exit dump stays
 *   unpainted.
 * - startTui/applyTheme end-to-end over the real ProcessTerminal wiring
 *   (stdout captured): startup paints with the resolved theme's canvas and
 *   applyTheme swaps it via a full redraw.
 *
 * Plus `rgbIsLight` (palette luminance) used by the OSC 11 auto-detection
 * path. Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TuiAltScreen } from '@earendil-works/pi-tui'
import { CanvasTerminal } from '../lib/canvas-terminal.js'
import { ansiBg } from '../lib/theme/index.js'
import { githubDark, githubLight, rgbIsLight } from '../lib/theme/palette.js'

const BG = ansiBg(githubDark.canvas)
const LIGHT_BG = ansiBg(githubLight.canvas)
const RESET = '\x1b[0m'
const ENTER_ALT_SCREEN = '\x1b[?1049h'
const EXIT_ALT_SCREEN = '\x1b[?1049l'

/** Every erase sequence in `buffer` is preceded by `bg` (BCE painting). */
function allErasesPainted(buffer, bg) {
  const stripped = buffer.split(`${bg}\x1b[2K`).join('').split(`${bg}\x1b[2J`).join('')
  return !stripped.includes('\x1b[2K') && !stripped.includes('\x1b[2J')
}

// ------------------------------------------------------ CanvasTerminal unit --

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

test('CanvasTerminal prefixes every erase sequence with the canvas SGR', () => {
  const inner = stubTerminal()
  const term = new CanvasTerminal(inner)
  term.setCanvasBackground(BG)
  term.write('\x1b[2J\x1b[H')
  term.write('\x1b[3;1H\x1b[2Khello\x1b[4;1H\x1b[2Kworld')
  const out = inner.writes.join('')
  assert.ok(allErasesPainted(out, BG), 'no unpainted 2K/2J remains')
  assert.ok(out.includes(`${BG}\x1b[2J\x1b[H`), 'full clear painted')
  assert.ok(out.includes(`${BG}\x1b[2Khello`), 'row erase painted')
  assert.ok(out.includes('hello\x1b[4;1H'), 'non-erase bytes pass through unchanged')
})

test('CanvasTerminal writes without erases or bg-clearing resets pass through unchanged', () => {
  const inner = stubTerminal()
  const term = new CanvasTerminal(inner)
  term.setCanvasBackground(BG)
  const data = 'plain \x1b[1mbold\x1b[22m text\x1b[38;2;9;9;9m colored \x1b[39m tail'
  term.write(data)
  assert.equal(inner.writes[0], data)
})

test('CanvasTerminal re-injects the canvas after background-clearing resets', () => {
  const inner = stubTerminal()
  const term = new CanvasTerminal(inner)
  term.setCanvasBackground(BG)
  // A themed span closes with a full reset; the plain text that follows
  // would print with the terminal default background (canvas holes).
  term.write(`\x1b[2K\x1b[38;2;1;2;3mhi${RESET} there`)
  assert.ok(inner.writes[0].includes(`${RESET}${BG} there`), 'canvas restored after the full reset')

  term.write(`\x1b[2K\x1b[1mbold\x1b[m tail`)
  assert.ok(inner.writes[1].includes(`\x1b[m${BG} tail`), 'implicit ESC[m reset re-injected')

  term.write(`\x1b[2K\x1b[0;1mcombined${RESET} tail`)
  assert.ok(inner.writes[2].includes(`${RESET}${BG} tail`), 'combined 0;1 reset re-injected')

  // The explicit background-default reset (tmux shows these cells as ESC[49m)
  term.write(`\x1b[2K\x1b[38;2;7;7;7mglyph\x1b[39m\x1b[49m    next`)
  assert.ok(inner.writes[3].includes(`\x1b[49m${BG}    next`), 'ESC[49m reset re-injected')
})

test('CanvasTerminal does not treat color-sets containing a 0 channel as resets', () => {
  const inner = stubTerminal()
  const term = new CanvasTerminal(inner)
  term.setCanvasBackground(BG)
  // Regression (ported from the patched-build suite): cache-teal
  // #00796B → 48;2;0;121;107 — the 0 red channel must not read as a reset
  // param, or the canvas gets injected over intentional surface colors.
  const teal = '\x1b[48;2;0;121;107m'
  const white = '\x1b[38;2;255;255;255m'
  term.write(`\x1b[2K${teal}bold\x1b[1m${white} CH`)
  const out = inner.writes[0]
  assert.ok(!out.includes(`${teal}${BG}`), 'no canvas injected inside the teal segment')
  assert.ok(out.includes(`${teal}bold`), 'text follows the teal set directly')
  assert.ok(!out.includes(`${white}${BG}`), 'no canvas injected after a truecolor fg set')
  assert.ok(out.includes(`${white} CH`), 'text follows the white fg set directly')

  // 256-color fg index 0 is a set, not a reset.
  const blackFg = '\x1b[38;5;0m'
  term.write(`\x1b[2K${blackFg}plain`)
  assert.ok(inner.writes[1].includes(`${blackFg}plain`), '38;5;0 is a fg set, not a reset')
  assert.ok(!inner.writes[1].includes(`${blackFg}${BG}`), 'no canvas injected after the fg color-set')
})

test('CanvasTerminal keeps intentional surface backgrounds, framed by the canvas', () => {
  const inner = stubTerminal()
  const term = new CanvasTerminal(inner)
  term.setCanvasBackground(BG)
  const bubble = `\x1b[48;2;22;27;34mbox${RESET}`
  term.write(`\x1b[2Klead ${bubble} tail`)
  const out = inner.writes[0]
  assert.ok(out.includes(bubble), 'the explicit surface background survives verbatim')
  assert.ok(out.includes(`${RESET}${BG} tail`), 'canvas resumes right after the bubble closes')
})

test('transparent default and setCanvasBackground(undefined) pass through', () => {
  const inner = stubTerminal()
  const term = new CanvasTerminal(inner)
  term.write('\x1b[2K\x1b[2J')
  assert.equal(inner.writes[0], '\x1b[2K\x1b[2J', 'default is transparent')
  term.setCanvasBackground(BG)
  term.write('\x1b[2K')
  assert.equal(inner.writes[1], `${BG}\x1b[2K`)
  term.setCanvasBackground(undefined)
  term.write('\x1b[2K\x1b[2J')
  assert.equal(inner.writes[2], '\x1b[2K\x1b[2J', 'undefined reverts to transparent')
})

test('alt-screen exit passes through unpainted and stops painting until re-enter', () => {
  const inner = stubTerminal()
  const term = new CanvasTerminal(inner)
  term.setCanvasBackground(BG)
  term.write('\x1b[1;1H\x1b[2Kframe')
  // Teardown buffer: EXIT_ALT_SCREEN followed by the main-screen document
  // dump rows — must stay unpainted so quitting leaks no themed background.
  const teardown = `${EXIT_ALT_SCREEN}\r\x1b[2Kdoc line\r\n\x1b[0m`
  term.write(teardown)
  term.write('\r\x1b[2Kpost-exit write')
  assert.equal(inner.writes[0], `\x1b[1;1H${BG}\x1b[2Kframe`, 'pre-exit frame still painted')
  assert.equal(inner.writes[1], teardown, 'exit buffer passes through unchanged')
  assert.equal(inner.writes[2], '\r\x1b[2Kpost-exit write', 'post-exit writes unpainted')
  // Re-entering the alt screen reactivates painting (restart-safe).
  term.write(`${ENTER_ALT_SCREEN}\x1b[2J`)
  assert.equal(inner.writes[3], `${ENTER_ALT_SCREEN}${BG}\x1b[2J`, 're-enter repaints')
})

test('non-write Terminal members forward to the inner terminal', () => {
  const inner = stubTerminal(60, 20)
  const term = new CanvasTerminal(inner)
  let sawInput = false
  term.start(() => {
    sawInput = true
  }, () => {})
  inner._inputHandler()('x')
  assert.ok(sawInput, 'start handlers forwarded')
  assert.equal(term.columns, 60)
  assert.equal(term.rows, 20)
  assert.equal(term.kittyProtocolActive, false)
  term.drainInput()
  term.stop()
})

// ------------------------------------------- TuiAltScreen via CanvasTerminal --

test('TuiAltScreen paints every rendered row when a canvas is set', () => {
  const inner = stubTerminal(12, 4)
  const term = new CanvasTerminal(inner)
  const tui = new TuiAltScreen(term, true)
  term.setCanvasBackground(BG)
  tui.setLayoutRoot({ render: () => ['hi'] })
  tui.start()
  tui.renderNow(true)

  const buffer = inner.writes.join('')
  assert.ok(allErasesPainted(buffer, BG), 'every erase of the frame carries the canvas SGR')
  tui.stop()
})

test('TuiAltScreen transparent default writes no canvas SGR', () => {
  const inner = stubTerminal(12, 4)
  const term = new CanvasTerminal(inner)
  const tui = new TuiAltScreen(term, true)
  tui.setLayoutRoot({ render: () => ['hi'] })
  tui.start()
  tui.renderNow(true)

  const buffer = inner.writes.join('')
  assert.ok(buffer.includes('\x1b[2K'), 'rows rendered')
  assert.ok(!buffer.includes(BG), 'transparent canvas leaves rows unpainted')
  tui.stop()
})

test('recolor with a forced redraw repaints the whole screen', () => {
  const inner = stubTerminal(12, 4)
  const term = new CanvasTerminal(inner)
  const tui = new TuiAltScreen(term, true)
  term.setCanvasBackground(BG)
  tui.setLayoutRoot({ render: () => ['hi'] })
  tui.start()
  tui.renderNow(true)
  assert.ok(allErasesPainted(inner.writes.join(''), BG))
  inner.writes.length = 0

  // The applyTheme swap: new canvas + forced full redraw (requestRender(true)
  // resets the diff state, so even content-unchanged rows are rewritten —
  // with a plain render the blank rows would keep the previous canvas).
  term.setCanvasBackground(LIGHT_BG)
  tui.renderNow(true)
  const buffer = inner.writes.join('')
  assert.ok(buffer.includes(`${LIGHT_BG}\x1b[2J`), 'forced redraw full-clears with the new canvas')
  assert.ok(!buffer.includes(`${BG}\x1b[2K`), 'no row keeps the old canvas')
  assert.ok(allErasesPainted(buffer, LIGHT_BG), 'every repaint carries the new canvas')
  tui.stop()
})

test('alt-screen exit dump stays unpainted', () => {
  const inner = stubTerminal(12, 4)
  const term = new CanvasTerminal(inner)
  const tui = new TuiAltScreen(term, true)
  term.setCanvasBackground(BG)
  tui.setLayoutRoot({ render: () => ['hi'] })
  tui.start()
  tui.renderNow(true)
  inner.writes.length = 0

  tui.stop()
  const buffer = inner.writes.join('')
  const exitAt = buffer.indexOf(EXIT_ALT_SCREEN)
  assert.ok(exitAt >= 0, 'exit sequence written')
  const afterExit = buffer.slice(exitAt)
  assert.ok(afterExit.includes('\r\x1b[2K'), 'document dump rows present')
  assert.ok(!afterExit.includes(`${BG}\x1b[2K`), 'exit dump rows are not painted')
  assert.ok(!afterExit.endsWith(BG), 'no trailing canvas SGR leaked to the shell')
})

// ------------------------------------------ startTui / applyTheme end-to-end --

test('startTui paints the startup canvas and applyTheme recolors via full redraw', () => {
  // startTui news up a real ProcessTerminal bound to process.stdout, so the
  // capture runs in a child process (e2e-canvas-fixture.mjs) — hijacking
  // process.stdout.write inside this file would corrupt node:test's own
  // reporting stream (test events are piped over stdout under process
  // isolation, and the corruption drops this file's earlier tests).
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'e2e-canvas-fixture.mjs')
  const stdout = execFileSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 30000 })
  const verdict = JSON.parse(stdout.trim().split('\n').pop())
  assert.ok(verdict.startupPainted, 'startup frame painted with the resolved theme canvas')
  assert.ok(verdict.forcedRedraw, 'applyTheme forced a full redraw with the new canvas')
  assert.ok(verdict.rowsRepainted, 'rows repainted with the new canvas')
  assert.ok(verdict.exitClean, 'exit dump unpainted (no SGR leaked to the shell)')
})

// -------------------------------------------------------------- rgbIsLight --

test('rgbIsLight thresholds the OSC 11 background luminance', () => {
  assert.ok(rgbIsLight({ r: 255, g: 255, b: 255 }), 'white is light')
  assert.ok(!rgbIsLight({ r: 13, g: 17, b: 23 }), 'github-dark canvas is dark')
  assert.ok(rgbIsLight({ r: 252, g: 253, b: 252 }), 'github-light canvas is light')
  // A mid-gray sits below the 0.5 luminance threshold.
  assert.ok(!rgbIsLight({ r: 128, g: 128, b: 128 }))
})
