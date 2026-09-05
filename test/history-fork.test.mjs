/**
 * Fork-at-turn tests — the /history browser's `f` flow pieces: the
 * `turnSeedSlice` pure slicer (src/history-turns.ts) and the confirmation
 * dialog (src/history-fork.ts, the repair-dialog pure-reducer pattern).
 * The browser-level wiring (dialog → deps.forkAtTurn → close) is covered in
 * test/history-viewer.test.mjs. Runs against the built lib/
 * (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { lightTheme } from '../lib/theme/index.js'
import { groupHistoryTurns, turnSeedSlice } from '../lib/history-turns.js'
import {
  forkAtTurnBody,
  forkAtTurnOptions,
  forkAtTurnOutcome,
  forkAtTurnTitle,
  FORK_AT_TURN_OPTION_IDS,
  ForkAtTurnPanel,
  initialForkAtTurnState,
  updateForkAtTurn,
} from '../lib/history-fork.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

const ENTER = '\r'
const ESC = '\x1b'
const DOWN = '\x1b[B'
const UP = '\x1b[A'

function event(type, seq, data = {}) {
  return { type, seq, time: seq, data }
}

/** Turns 0–2 fully completed; turn 3 left in flight. */
function sampleEvents() {
  return [
    event('turn/start', 0, { turn: 0 }),
    event('user/message', 1),
    event('turn/end', 2, { turn: 0, reason: { kind: 'completed' } }),
    event('turn/start', 3, { turn: 1 }),
    event('user/message', 4),
    event('tool/call', 5, { turn: 1, step: 0, callId: 'c1', name: 'read', arguments: '{}' }),
    event('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }),
    event('turn/start', 7, { turn: 2 }),
    event('user/message', 8),
    event('turn/end', 9, { turn: 2, reason: { kind: 'completed' } }),
    event('turn/start', 10, { turn: 3 }), // in-flight
    event('user/message', 11),
  ]
}

// ------------------------------------------------------------ turnSeedSlice --

test('turnSeedSlice: the first turn slices through its turn/end (inclusive)', () => {
  const [turn0] = groupHistoryTurns(sampleEvents())
  const seed = turnSeedSlice(sampleEvents(), turn0)
  assert.equal(seed.length, 3)
  assert.equal(seed[0].seq, 0)
  assert.equal(seed[2].type, 'turn/end')
  assert.equal(seed[2].data.turn, 0)
})

test('turnSeedSlice: a middle turn includes it and excludes everything after', () => {
  const turns = groupHistoryTurns(sampleEvents())
  const seed = turnSeedSlice(sampleEvents(), turns[1])
  assert.equal(seed.length, 7)
  assert.equal(seed[6].type, 'turn/end')
  assert.equal(seed[6].data.turn, 1)
  // Seq === index contiguity — the seed validator's hard requirement — for
  // both live snapshots and restored (inspect) logs.
  assert.deepEqual(seed.map(event => event.seq), [0, 1, 2, 3, 4, 5, 6])
})

test('turnSeedSlice: the last completed turn forks the whole completed log', () => {
  const turns = groupHistoryTurns(sampleEvents())
  const seed = turnSeedSlice(sampleEvents(), turns[2])
  assert.equal(seed.length, 10)
  assert.equal(seed[9].type, 'turn/end')
  // The in-flight turn 3 (its start + user message) stays out.
  assert.ok(!seed.some(event => event.data.turn === 3))
})

test('turnSeedSlice: duplicate turn numbers slice at the SELECTED fold, not the first match', () => {
  // A damaged log with the same turn id twice: picking the second must cut
  // at the SECOND turn/end — matching by number alone would truncate early.
  const events = [
    event('turn/start', 0, { turn: 5 }),
    event('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }] }),
    event('turn/end', 2, { turn: 5, reason: { kind: 'completed' } }),
    event('turn/start', 3, { turn: 5 }),
    event('user/message', 4, { source: { kind: 'user' }, content: [{ type: 'text', text: 'b' }] }),
    event('turn/end', 5, { turn: 5, reason: { kind: 'completed' } }),
  ]
  const folds = groupHistoryTurns(events)
  assert.equal(folds.length, 2)
  const seed = turnSeedSlice(events, folds[1])
  assert.equal(seed.length, 6, 'cut at the second fold\'s end, not the first')
  assert.equal(seed[5].seq, 5)
  assert.equal(turnSeedSlice(events, folds[0]).length, 3)
})

test('turnSeedSlice: clamps to the log length', () => {
  const [turn] = groupHistoryTurns([
    event('turn/start', 0, { turn: 0 }),
    event('turn/end', 0, { turn: 0, reason: { kind: 'completed' } }),
  ])
  assert.deepEqual(turnSeedSlice([], turn), [])
})

// ------------------------------------------------------------------- dialog --

test('dialog copy: title, the two body points and exactly two options', () => {
  assert.equal(forkAtTurnTitle('2'), '● Fork at turn 2?')
  // Live browse (no detached live session): the generic wording.
  const body = forkAtTurnBody('2', 5)
  assert.deepEqual(body, [
    'The new session carries turns through 2 (of 5); later turns stay in the current session.',
    'The current session stays resumable via /resume.',
  ])
  // Cold browse: the dialog must NAME the detached live session instead of
  // hiding its fate behind "the current session".
  const cold = forkAtTurnBody('2', 5, 'abcd1234')
  assert.equal(cold[1], 'Your live session abcd1234 will be detached — it stays resumable via /resume.')
  assert.equal(cold[0], body[0])
  const options = forkAtTurnOptions('2')
  assert.deepEqual(options.map(option => option.id), ['fork', 'cancel'])
  assert.equal(options[0].text, 'Fork now — new session through turn 2')
  assert.equal(options[1].text, 'Cancel')
  assert.equal(FORK_AT_TURN_OPTION_IDS.length, 2)
})

test('dialog reducer: navigation clamps at two rows; 1/2 direct-select; Enter/Esc settle once', () => {
  let state = initialForkAtTurnState()
  assert.equal(state.selected, 0)
  assert.equal(updateForkAtTurn(state, UP).selected, 0, 'clamped at the top')
  state = updateForkAtTurn(state, DOWN)
  assert.equal(state.selected, 1)
  assert.equal(updateForkAtTurn(state, DOWN).selected, 1, 'clamped at the bottom')
  // Digit direct-select moves the cursor; Enter confirms it.
  state = updateForkAtTurn(initialForkAtTurnState(), '2')
  assert.equal(state.selected, 1)
  assert.equal(forkAtTurnOutcome(updateForkAtTurn(state, ENTER)), 'cancel')
  assert.equal(forkAtTurnOutcome(updateForkAtTurn(initialForkAtTurnState(), ENTER)), 'fork')

  // Esc cancels; after a settle every key is ignored.
  const cancelled = updateForkAtTurn(initialForkAtTurnState(), ESC)
  assert.equal(cancelled.settled, 'cancel')
  assert.equal(forkAtTurnOutcome(cancelled), undefined)
  assert.equal(updateForkAtTurn(cancelled, DOWN).settled, 'cancel')
})

test('dialog panel: renders title, body and both options; settles exactly once', () => {
  let finish
  const panel = new ForkAtTurnPanel(lightTheme, '2', 5, undefined, outcome => { finish = outcome }, () => {})
  const text = panel.render(90).map(stripAnsi).join('\n')
  assert.ok(text.includes('● Fork at turn 2?'), text)
  assert.ok(text.includes('The new session carries turns through 2 (of 5);'), text)
  assert.ok(text.includes('stays resumable via /resume.'), text)
  assert.ok(text.includes('1. Fork now — new session through turn 2'), text)
  assert.ok(text.includes('2. Cancel'), text)
  assert.ok(text.includes('Enter confirm · Esc cancel'))
  // Cold browse renders the named-live-session wording.
  const coldPanel = new ForkAtTurnPanel(lightTheme, '2', 5, 'abcd1234', () => {}, () => {})
  const coldText = coldPanel.render(90).map(stripAnsi).join('\n')
  assert.ok(coldText.includes('Your live session abcd1234 will be detached'), coldText)
  // The first terminal key settles exactly once; Esc fires `undefined`
  // (the open-flow wrapper maps it to 'cancelled').
  panel.handleInput(ESC)
  assert.equal(finish, undefined)
  panel.handleInput(ENTER)
  assert.equal(finish, undefined)
})

test('dialog panel: Enter on the preselected row confirms the fork', () => {
  let finish
  const panel = new ForkAtTurnPanel(lightTheme, '3', 4, undefined, outcome => { finish = outcome }, () => {})
  panel.handleInput(ENTER)
  assert.equal(finish, 'fork')
})
