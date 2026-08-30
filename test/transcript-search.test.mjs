/**
 * Fullscreen transcript search (pi-tui built-in, Ctrl+Shift+F).
 *
 * TuiAltScreen ships the search wiring itself: the `tui.altScreen.search`
 * binding (default ctrl+shift+f) opens an input overlay anchored top-right,
 * `enter`/`ctrl+g` and `shift+enter`/`ctrl+shift+g` navigate matches, and
 * `escape` closes. Matches are found over the layout root's PRIMARY
 * ScrollView — ours is `transcriptView` (src/tui.ts, marked `primary: true`),
 * so the capability arrives with the 0.84.4 bump with no plugin code.
 *
 * Dispatch order makes the integration safe without any app changes:
 * TuiAltScreen registers its viewport input listener in its CONSTRUCTOR and
 * the app key chain (keymap.ts) registers at startTui time, so while the
 * search overlay is focused, enter/escape/ctrl+g are consumed by the search
 * (modal) and never reach the app-level Esc/Ctrl+C chains.
 *
 * These tests pin: the binding opens over OUR layout shape, typing counts
 * matches in our transcript content, navigation and close work, and plain
 * keys never open the search. Bytes are fed directly to the registered
 * input handler (StdinBuffer splitting is upstream, verified separately).
 * Runs against the built lib/ — wait, no: pi-tui only. This file asserts
 * upstream behavior the plugin RELIES on; it imports no plugin module so a
 * dependency regression is caught by the suite, not by a manual run.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Container, ScrollView, Spacer, Text, TuiAltScreen, VStack } from '@earendil-works/pi-tui'

const SEARCH_KEY = '\x1b[102;6u' // ctrl+shift+f, modifyOtherKeys form (matchesKey-verified)
const ENTER = '\r'
const ESC = '\x1b'

function stubTerminal(columns = 80, rows = 12) {
  let inputHandler
  const writes = []
  return {
    writes,
    feed(data) {
      inputHandler?.(data)
    },
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
  }
}

/** The plugin's exact layout shape: primary transcript ScrollView + dock. */
function searchHarness(term, lines) {
  const transcript = new Container()
  for (const line of lines) transcript.addChild(new Text(line, 1, 0))
  transcript.addChild(new Spacer(1))
  const transcriptView = new ScrollView(transcript, {
    follow: 'end',
    primary: true,
    overscroll: 'chain',
  })
  const root = new VStack([
    { component: transcriptView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: new Text('editor line', 1, 0), basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
  ])
  const tui = new TuiAltScreen(term, true, undefined, { mouse: false })
  tui.setLayoutRoot(root)
  tui.start()
  tui.renderNow(true)
  term.writes.length = 0
  return tui
}

function output(term) {
  return term.writes.join('')
}

test('ctrl+shift+f opens the search overlay over the plugin layout shape', () => {
  const term = stubTerminal()
  const tui = searchHarness(term, ['alpha beta gamma', 'the quick brown fox'])
  term.feed(SEARCH_KEY)
  tui.renderNow(true)
  const out = output(term)
  assert.ok(out.includes('Find transcript'), `search overlay rendered (got ${JSON.stringify(out.slice(-400))})`)
  tui.stop()
})

test('typing counts matches; enter navigates; escape closes; reopen starts fresh', () => {
  const term = stubTerminal()
  const tui = searchHarness(term, ['needle one', 'plain two', 'needle three'])
  term.feed(SEARCH_KEY)
  tui.renderNow(true)
  for (const ch of 'needle') term.feed(ch)
  tui.renderNow(true)
  let out = output(term)
  assert.ok(out.includes('1/2'), `two needle matches counted (got ${JSON.stringify(out.slice(-400))})`)

  // enter navigates to the next match — consumed by the search modal.
  term.feed(ENTER)
  tui.renderNow(true)
  out = output(term)
  assert.ok(out.includes('2/2'), `enter advanced to the second match (got ${JSON.stringify(out.slice(-400))})`)

  // escape closes; a plain key afterwards must not resurrect anything.
  term.feed(ESC)
  tui.renderNow(true)
  term.writes.length = 0
  term.feed('x')
  tui.renderNow(true)
  assert.ok(!output(term).includes('Find transcript'), 'closed search stays closed on plain input')

  // reopening starts a fresh, empty query — the old query is gone.
  term.feed(SEARCH_KEY)
  tui.renderNow(true)
  out = output(term)
  assert.ok(out.includes('Find transcript'), 'search reopened')
  assert.ok(!out.includes('2/2'), 'no stale match counter from the previous query')
  tui.stop()
})

test('plain keys and unmatched bindings never open the search', () => {
  const term = stubTerminal()
  const tui = searchHarness(term, ['alpha beta gamma'])
  for (const data of ['x', 'h', 'i', ENTER, '\t', 'q']) term.feed(data)
  tui.renderNow(true)
  assert.ok(!output(term).includes('Find transcript'), 'no search overlay on ordinary keys')
  tui.stop()
})

test('mouse-less alt screen ignores mouse-shaped input while search is open', () => {
  // A wheel event under an open search overlay must not crash or leak into
  // the search input (the overlay defers viewport input; regression guard
  // for the parser family the dsh-owned mouse modes depend on).
  const term = stubTerminal()
  const tui = searchHarness(term, ['alpha beta gamma'])
  term.feed(SEARCH_KEY)
  tui.renderNow(true)
  term.feed('\x1b[<64;10;5M\x1b[<64;10;6M') // two coalesced wheel-up events
  tui.renderNow(true)
  const out = output(term)
  assert.ok(out.includes('Find transcript'), 'search overlay still up')
  tui.stop()
})
