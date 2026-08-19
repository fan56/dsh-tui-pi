/**
 * FramedOverlay tests — the shared full-box popup wrapper (┌─┐ / │ │ / └─┘)
 * with a solid canvasSubtle backdrop on every row.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { FramedOverlay, wrapFramedOverlay } from '../lib/frame.js'
import { githubLight } from '../lib/theme/palette.js'
import { visibleWidth } from '../lib/text.js'

/** Minimal component recording render calls and input. */
class Stub {
  constructor() {
    this.rendered = []
    this.input = []
    this.invalidations = 0
  }

  invalidate() {
    this.invalidations += 1
  }

  render(width) {
    this.rendered.push(width)
    return ['a', 'b']
  }

  handleInput(data) {
    this.input.push(data)
  }
}

/** Minimal TuiTheme shape the frame reads (palette only). */
const theme = { palette: githubLight }

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

/** Expect `line` to be painted on a full-width canvasSubtle backdrop. */
function assertBackdropLine(line, width) {
  const [r, g, b] = hexToRgb(githubLight.canvasSubtle)
  assert.ok(line.startsWith(`\x1b[48;2;${r};${g};${b}m`), 'starts with canvasSubtle bg')
  assert.equal(visibleWidth(line), width, 'spans the full overlay width')
  assert.ok(line.endsWith('\x1b[0m'), 'ends with reset')
}

test('FramedOverlay renders box top, spacer, content, spacer, box bottom', () => {
  const frame = new FramedOverlay(theme, new Stub())
  const lines = frame.render(20)
  assert.equal(lines.length, 6)
  assertBackdropLine(lines[0], 20) // ┌─┐
  assertBackdropLine(lines[5], 20) // └─┘
  assertBackdropLine(lines[1], 20) // │   │ spacer
  assertBackdropLine(lines[4], 20)
  assert.ok(stripAnsi(lines[0]).startsWith('┌'))
  assert.ok(stripAnsi(lines[0]).endsWith('┐'))
  assert.ok(stripAnsi(lines[5]).startsWith('└'))
  assert.ok(stripAnsi(lines[5]).endsWith('┘'))
  // content rows carry the │ side borders and full-width backdrop
  assert.ok(stripAnsi(lines[2]).startsWith('│a│'))
  assert.ok(stripAnsi(lines[3]).startsWith('│b│'))
  assertBackdropLine(lines[2], 20)
})

test('every row is a full-width canvasSubtle panel row', () => {
  const frame = new FramedOverlay(theme, new Stub())
  for (const line of frame.render(23)) {
    assertBackdropLine(line, 23)
  }
})

test('backdrop is re-applied after every reset (nested and mid-line)', () => {
  // Theme fns nest RESETs (bold -> fg -> bg), and a SettingsList row resets
  // mid-line (empty styled value). Every cell must stay on the backdrop.
  const styled = `\x1b[48;2;1;2;3m\x1b[38;2;4;5;6m\x1b[1mfoo\x1b[0m\x1b[0m\x1b[0m  \x1b[48;2;1;2;3m\x1b[38;2;4;5;6m\x1b[0m`
  const child = { invalidate() {}, render: () => [styled] }
  const frame = new FramedOverlay(theme, child)
  const line = frame.render(10)[2]
  assertBackdropLine(line, 10)
  assert.ok(stripAnsi(line).startsWith('│foo'))
  // Every RESET (4 in the fixture) is followed by a re-applied backdrop.
  const reBgs = line.match(/\x1b\[0m\x1b\[48;2;238;243;238m/g) ?? []
  assert.equal(reBgs.length, 4)
})

test('unstyled child lines (raw separator/search rows) get the backdrop', () => {
  const child = { invalidate() {}, render: () => ['', 'raw row'] }
  const frame = new FramedOverlay(theme, child)
  const lines = frame.render(15)
  assertBackdropLine(lines[2], 15)
  assertBackdropLine(lines[3], 15)
  assert.ok(stripAnsi(lines[3]).startsWith('│raw row'))
})

test('over-wide child lines are left untouched (no negative padding)', () => {
  const child = { invalidate() {}, render: () => ['x'.repeat(50)] }
  const frame = new FramedOverlay(theme, child)
  const line = frame.render(10)[2]
  assertBackdropLine(line, 52) // 2 side borders + content, not shrunk
  assert.ok(stripAnsi(line).startsWith('│'))
})

test('box lines use palette panelBoxBorder on the backdrop and reset after', () => {
  const frame = new FramedOverlay(theme, new Stub())
  const lines = frame.render(10)
  const [br, bg, bb] = hexToRgb(githubLight.panelBoxBorder)
  const [cr, cg, cb] = hexToRgb(githubLight.canvasSubtle)
  for (const line of [lines[0], lines[5]]) {
    assert.ok(line.startsWith(`\x1b[48;2;${cr};${cg};${cb}m`), 'panel backdrop first')
    assert.match(line, new RegExp(`\\x1b\\[38;2;${br};${bg};${bb}m`), 'border fg present')
    assert.ok(line.endsWith('\x1b[0m'))
  }
})

test('FramedOverlay renders the child at width minus the box borders', () => {
  const child = new Stub()
  const frame = new FramedOverlay(theme, child)
  frame.render(42)
  assert.deepEqual(child.rendered, [40])
})

test('FramedOverlay forwards handleInput to the child', () => {
  const child = new Stub()
  const frame = new FramedOverlay(theme, child)
  frame.handleInput('x')
  assert.deepEqual(child.input, ['x'])
})

test('FramedOverlay forwards invalidate to the child', () => {
  const child = new Stub()
  const frame = new FramedOverlay(theme, child)
  frame.invalidate()
  assert.equal(child.invalidations, 1)
})

test('FramedOverlay tolerates a child without handleInput', () => {
  const frame = new FramedOverlay(theme, { invalidate() {}, render: () => ['only'] })
  frame.handleInput('x') // must not throw
  const line = frame.render(3)[2]
  assert.ok(stripAnsi(line).startsWith('│only'))
})

test('wrapFramedOverlay returns a working FramedOverlay', () => {
  const child = new Stub()
  const wrapped = wrapFramedOverlay(theme, child)
  const lines = wrapped.render(8)
  assert.equal(lines.length, 6)
  wrapped.handleInput('j')
  assert.deepEqual(child.input, ['j'])
})
