/**
 * Fullscreen selection-copy wiring — tui.ts's selectionCopyOptions bundle
 * into TuiAltScreen.
 *
 * The plugin owns the terminal mouse MODES (src/mouse-mode.ts: button-motion
 * by default) while pi-tui owns mouse event HANDLING: releasing a drag
 * selection copies it through TuiAltScreen's selection path. pi-tui's
 * fallback writes a bare OSC 52 sequence, which "succeeds" while leaving the
 * system clipboard untouched on macOS Terminal.app and tmux without
 * passthrough — so the bundle injects our clipboard ladder (native commands
 * + OSC 52 with a verified success path, src/clipboard.ts) via the
 * `copySelection` option, and DSH_TUI_COPY_ON_SELECT gates copy-on-release.
 *
 * Layers:
 * - selectionCopyOptions(env, impl): env resolution + forwarding to
 *   writeClipboard with the injected impl (no real process is touched).
 * - TuiAltScreen constructed with the bundle over a stub terminal: pi-tui
 *   accepts the option shape, getCopyOnSelect() reflects the env, and the
 *   public copyActiveSelectionToClipboard() API reports "no selection"
 *   without firing the clipboard ladder.
 * Runs against the built lib/ (pretest builds).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { TuiAltScreen } from '@earendil-works/pi-tui'
import { selectionCopyOptions } from '../lib/tui.js'

const OFF = { DSH_TUI_COPY_ON_SELECT: '0' }

function stubTerminal(columns = 40, rows = 8) {
  const writes = []
  return {
    writes,
    start() {},
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
  }
}

/** Fake ClipboardImpl: records the OSC 52 write and the write-ladder spawn. */
function fakeClipboardImpl() {
  const writes = []
  const calls = []
  return {
    impl: {
      env: { platform: 'darwin', waylandDisplay: undefined, display: undefined },
      execFile: (cmd, args, _opts, stdinPayload) => {
        calls.push({ cmd, args, stdinPayload })
        return Promise.resolve({ stdout: '' })
      },
      write: chunk => {
        writes.push(chunk)
      },
    },
    writes,
    calls,
  }
}

// ------------------------------------------------- selectionCopyOptions --

test('selectionCopyOptions: copyOnSelect defaults on and honors DSH_TUI_COPY_ON_SELECT=0', () => {
  assert.equal(selectionCopyOptions({}).copyOnSelect, true, 'unset env → on')
  assert.equal(selectionCopyOptions(OFF).copyOnSelect, false, 'explicit 0 → off')
})

test('selectionCopyOptions: copySelection forwards through writeClipboard (ladder + OSC 52)', async () => {
  const { impl, writes, calls } = fakeClipboardImpl()
  const { copySelection } = selectionCopyOptions({}, impl)
  const ok = await copySelection('hello selection')
  assert.equal(ok, true, 'writeClipboard resolves true on the successful rung')
  // darwin ladder: pbcopy carries the payload on stdin.
  assert.equal(calls.length, 1, 'exactly one native write command spawned')
  assert.equal(calls[0].cmd, 'pbcopy')
  assert.equal(calls[0].stdinPayload, 'hello selection')
  // and the OSC 52 sequence went to the stdout seam.
  const expected = `\x1b]52;c;${Buffer.from('hello selection', 'utf8').toString('base64')}\x07`
  assert.deepEqual(writes, [expected])
})

test('selectionCopyOptions: a failing ladder still reports what writeClipboard decided (no throw)', async () => {
  const writes = []
  const impl = {
    env: { platform: 'linux', waylandDisplay: '', display: '' },
    // Linux with no Wayland/X11 and an empty ladder → writeClipboard
    // returns the OSC 52 outcome alone; the forwarder must never reject.
    execFile: () => Promise.reject(new Error('must not be called')),
    write: chunk => {
      writes.push(chunk)
    },
  }
  const { copySelection } = selectionCopyOptions({}, impl)
  const ok = await copySelection('tiny')
  assert.equal(ok, true, 'OSC 52 write alone resolves true')
  assert.equal(writes.length, 1)
})

// ------------------------------------- TuiAltScreen accepts the bundle ----

test('TuiAltScreen accepts the selectionCopyOptions bundle; getCopyOnSelect reflects env', () => {
  for (const [env, expected] of [[{}, true], [OFF, false]]) {
    const term = stubTerminal()
    const tui = new TuiAltScreen(term, true, undefined, {
      mouse: false,
      ...selectionCopyOptions(env),
    })
    assert.equal(tui.getCopyOnSelect(), expected, `env ${JSON.stringify(env)} → copyOnSelect ${expected}`)
    tui.stop()
  }
})

test('setCopyOnSelect toggles the live behavior; no-selection copy is a harmless false', async () => {
  const term = stubTerminal()
  const { impl } = fakeClipboardImpl()
  const tui = new TuiAltScreen(term, true, undefined, {
    mouse: false,
    ...selectionCopyOptions({}, impl),
  })
  tui.setCopyOnSelect(false)
  assert.equal(tui.getCopyOnSelect(), false)
  tui.setCopyOnSelect(true)
  assert.equal(tui.getCopyOnSelect(), true)
  // With no active selection the public copy API must short-circuit BEFORE
  // the clipboard ladder — nothing is spawned, nothing is written.
  const ok = await tui.copyActiveSelectionToClipboard()
  assert.equal(ok, false, 'empty selection → false without touching the clipboard')
  assert.equal(term.writes.join('').includes('\x1b]52;'), false, 'no OSC 52 emitted')
  tui.stop()
})
