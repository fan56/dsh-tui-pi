/**
 * FramedOverlay tests — the shared popup border wrapper.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { FramedOverlay, wrapFramedOverlay } from '../lib/frame.js'
import { githubLight } from '../lib/theme/palette.js'

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

test('FramedOverlay renders border, spacer, content, spacer, border', () => {
  const frame = new FramedOverlay(theme, new Stub())
  const lines = frame.render(20)
  assert.equal(lines.length, 6)
  assert.equal(lines[1], '')
  assert.equal(lines[4], '')
  assert.deepEqual(lines.slice(2, 4), ['a', 'b'])
})

test('border lines span exactly the overlay width', () => {
  const frame = new FramedOverlay(theme, new Stub())
  const lines = frame.render(37)
  const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')
  assert.equal(stripAnsi(lines[0]).length, 37)
  assert.equal(stripAnsi(lines[5]).length, 37)
  assert.ok(stripAnsi(lines[0]).startsWith('─'))
  assert.ok(stripAnsi(lines[5]).startsWith('─'))
})

test('border lines use palette borderDefault and reset after', () => {
  const frame = new FramedOverlay(theme, new Stub())
  const lines = frame.render(10)
  const [r, g, b] = hexToRgb(githubLight.borderDefault)
  for (const line of [lines[0], lines[5]]) {
    assert.match(line, new RegExp(`^\\x1b\\[38;2;${r};${g};${b}m`))
    assert.ok(line.endsWith('\x1b[0m'))
  }
})

test('FramedOverlay forwards render width to the child', () => {
  const child = new Stub()
  const frame = new FramedOverlay(theme, child)
  frame.render(42)
  assert.deepEqual(child.rendered, [42])
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
  assert.deepEqual(frame.render(3).slice(2, 3), ['only'])
})

test('wrapFramedOverlay returns a working FramedOverlay', () => {
  const child = new Stub()
  const wrapped = wrapFramedOverlay(theme, child)
  const lines = wrapped.render(8)
  assert.equal(lines.length, 6)
  wrapped.handleInput('j')
  assert.deepEqual(child.input, ['j'])
})
