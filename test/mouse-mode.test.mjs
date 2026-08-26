/**
 * Mouse tracking mode selection (src/mouse-mode.ts → lib/mouse-mode.js).
 * dsh owns the terminal mouse modes instead of pi-tui's auto choice, whose
 * multiplexer probe does not know cmux and would enable all-motion tracking
 * there — idle-pointer bursts then escape pi-tui's single-sequence SGR
 * parsers and get typed into the editor. Runs against the built lib/
 * (pretest builds).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MOUSE_MODE_ENV,
  mouseDisableSequence,
  mouseEnableSequence,
  resolveMouseMode,
} from '../lib/mouse-mode.js'

const BUTTONS_ENABLE = '\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h'
const ALL_ENABLE = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h'

test('resolveMouseMode: default is buttons', () => {
  assert.equal(resolveMouseMode({}), 'buttons')
  assert.equal(resolveMouseMode({ [MOUSE_MODE_ENV]: '' }), 'buttons')
  assert.equal(resolveMouseMode({ [MOUSE_MODE_ENV]: '  ' }), 'buttons')
})

test('resolveMouseMode: accepts the three documented values, case-insensitive', () => {
  assert.equal(resolveMouseMode({ [MOUSE_MODE_ENV]: 'buttons' }), 'buttons')
  assert.equal(resolveMouseMode({ [MOUSE_MODE_ENV]: 'all' }), 'all')
  assert.equal(resolveMouseMode({ [MOUSE_MODE_ENV]: 'off' }), 'off')
  assert.equal(resolveMouseMode({ [MOUSE_MODE_ENV]: 'ALL' }), 'all')
  assert.equal(resolveMouseMode({ [MOUSE_MODE_ENV]: ' Off ' }), 'off')
})

test('resolveMouseMode: invalid values fall back to buttons, never all-motion', () => {
  assert.equal(resolveMouseMode({ [MOUSE_MODE_ENV]: 'yes' }), 'buttons')
  assert.equal(resolveMouseMode({ [MOUSE_MODE_ENV]: '1003' }), 'buttons')
  assert.equal(resolveMouseMode({ [MOUSE_MODE_ENV]: 'everything' }), 'buttons')
})

test('enable sequences mirror pi-tui 0.84.2 mode sets', () => {
  assert.equal(mouseEnableSequence('buttons'), BUTTONS_ENABLE)
  // all-motion is the only mode adding ?1003h (any-motion tracking)
  assert.equal(mouseEnableSequence('all'), ALL_ENABLE)
  assert.ok(ALL_ENABLE.includes('\x1b[?1003h'))
  assert.ok(!BUTTONS_ENABLE.includes('\x1b[?1003h'))
  assert.equal(mouseEnableSequence('off'), '')
})

test('disable sequences exactly reverse their enable counterparts', () => {
  for (const mode of ['buttons', 'all']) {
    const enable = mouseEnableSequence(mode)
    const disable = mouseDisableSequence(mode)
    // Same mode numbers, every h flipped to l, written in reverse order
    const enableModes = [...enable.matchAll(/\x1b\[\?(\d+)h/g)].map(m => m[1])
    const disableModes = [...disable.matchAll(/\x1b\[\?(\d+)l/g)].map(m => m[1])
    assert.deepEqual(disableModes, [...enableModes].reverse(), mode)
    assert.equal(disable.includes('h'), false)
  }
  assert.equal(mouseDisableSequence('off'), '')
})
