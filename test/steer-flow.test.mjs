/**
 * Main-session steer / follow-up flow (src/steer-flow.ts → lib/steer-flow.js)
 * plus the submit routing dialog reducer (src/route-dialog.ts) — pure logic
 * over a structural agent slice, so the whole matrix runs without a terminal.
 * Runs against the built lib/ (pretest builds).
 *
 * Design contract (docs/design-steer-followup.md):
 * - idle submit → direct send; running submit → routing dialog;
 * - a steer that cannot land (turn ended / primitive throws) degrades to a
 *   queued follow-up — never an error, never a silent drop;
 * - queue panel: `d` removes (claimed/removed → not-found), `s` promotes to
 *   a strict steer with the same race fallback;
 * - dialog: ↑↓ or 1/2 select, Enter confirms, Esc cancels, one outcome only.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildUserPrompt,
  decideSubmitPath,
  deliverToAgent,
  describeQueueActionResult,
  promotePending,
  removeFromInbox,
} from '../lib/steer-flow.js'
import {
  ROUTE_DIALOG_FOOTER,
  ROUTE_OPTIONS,
  initialRouteDialogState,
  routeDialogOutcome,
  updateRouteDialog,
} from '../lib/route-dialog.js'
import { QUEUE_PANEL_FOOTER, queueRow } from '../lib/queue-panel.js'

const ENTER = '\r'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ESC = '\x1b'

/** Recording fake of the structural agent slice the flow operates on. */
function fakeAgent({
  status = 'running',
  throwSteer = false,
  throwFollowup = false,
  removeResult = true,
  throwRemove = false,
} = {}) {
  const calls = []
  return {
    calls,
    status,
    steer(message) {
      if (throwSteer) throw new Error('steer-unavailable')
      calls.push(['steer', message])
    },
    followup(message) {
      if (throwFollowup) throw new Error('followup failed')
      calls.push(['followup', message])
    },
    inbox: {
      remove(messageId) {
        if (throwRemove) throw new Error('queue-item-not-found')
        calls.push(['remove', messageId])
        return removeResult
      },
    },
  }
}

// ------------------------------------------------------- submit routing --

test('decideSubmitPath: idle sends directly, running opens the dialog', () => {
  assert.equal(decideSubmitPath(false), 'direct')
  assert.equal(decideSubmitPath(true), 'dialog')
})

test('buildUserPrompt keeps the ordinary user-source prompt shape', () => {
  const message = buildUserPrompt('hello there')
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'user' })
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello there' }])
  assert.ok(typeof message.id === 'string' && message.id !== '', 'message carries a fresh identity')
})

test('deliverToAgent: chosen follow-up goes straight to followup()', () => {
  const agent = fakeAgent()
  const outcome = deliverToAgent(agent, { id: 'm1' }, 'followup')
  assert.deepEqual(outcome, { outcome: 'sent', via: 'followup' })
  assert.deepEqual(agent.calls, [['followup', { id: 'm1' }]])
})

test('deliverToAgent: chosen follow-up failing surfaces an error (nothing lost silently)', () => {
  const agent = fakeAgent({ throwFollowup: true })
  const outcome = deliverToAgent(agent, {}, 'followup')
  assert.equal(outcome.outcome, 'error')
  assert.equal(outcome.error, 'followup failed')
  assert.deepEqual(agent.calls, [])
})

test('deliverToAgent: steer on a running driver calls steer() only', () => {
  const agent = fakeAgent({ status: 'running' })
  const outcome = deliverToAgent(agent, { id: 'm2' }, 'steer')
  assert.deepEqual(outcome, { outcome: 'sent', via: 'steer' })
  assert.deepEqual(agent.calls, [['steer', { id: 'm2' }]])
})

test('deliverToAgent: turn ended before delivery → degraded to follow-up (race fallback)', () => {
  const agent = fakeAgent({ status: 'idle' })
  const outcome = deliverToAgent(agent, { id: 'm3' }, 'steer')
  assert.deepEqual(outcome, { outcome: 'degraded' })
  assert.equal(agent.calls.length, 1)
  assert.equal(agent.calls[0][0], 'followup', 'the message lands queued, not dropped')
})

test('deliverToAgent: unexpected status shape fails closed into the queued path', () => {
  // A foreign handle whose status is neither running nor idle (explicitly
  // not undefined — that would trip the fake's own default).
  const agent = fakeAgent({ status: 'disintegrated' })
  const outcome = deliverToAgent(agent, {}, 'steer')
  assert.deepEqual(outcome, { outcome: 'degraded' })
  assert.equal(agent.calls[0][0], 'followup')
})

test('deliverToAgent: steer-unavailable throw degrades to follow-up', () => {
  const agent = fakeAgent({ status: 'running', throwSteer: true })
  const outcome = deliverToAgent(agent, { id: 'm4' }, 'steer')
  assert.deepEqual(outcome, { outcome: 'degraded' })
  assert.equal(agent.calls[0][0], 'followup')
})

test('deliverToAgent: both primitives throwing is an error carrying the last message', () => {
  const agent = fakeAgent({ status: 'running', throwSteer: true, throwFollowup: true })
  const outcome = deliverToAgent(agent, {}, 'steer')
  assert.equal(outcome.outcome, 'error')
  assert.equal(outcome.error, 'followup failed')
})

// --------------------------------------------------------- queue actions --

test('removeFromInbox: removed and already-gone map to distinct outcomes', () => {
  const inbox = fakeAgent().inbox
  const view = { id: 'a', text: 'hi', target: 'next-turn', message: { id: 'm-1' } }
  assert.deepEqual(removeFromInbox(inbox, view), { kind: 'removed' })
  const gone = fakeAgent({ removeResult: false }).inbox
  assert.deepEqual(removeFromInbox(gone, view), { kind: 'not-found' })
  const broken = fakeAgent({ throwRemove: true }).inbox
  const error = removeFromInbox(broken, view)
  assert.equal(error.kind, 'error')
  assert.equal(error.error, 'queue-item-not-found')
})

test('promotePending: running driver → strict steer of the exact queued object', () => {
  const message = { id: 'm-5' }
  const view = { id: 'm-5', text: 'now please', target: 'next-turn', message }
  const agent = fakeAgent({ status: 'running' })
  const result = promotePending(agent, view)
  assert.deepEqual(result, { kind: 'promoted', via: 'steer', degraded: false })
  // Remove first, then steer the ORIGINAL object (identity preserved).
  assert.deepEqual(agent.calls.map(([op]) => op), ['remove', 'steer'])
  assert.equal(agent.calls[1][1], message)
})

test('promotePending: idle driver at flush time → stays queued as follow-up (degraded)', () => {
  const view = { id: 'a', text: 'hi', target: 'next-turn', message: { id: 'm-6' } }
  const agent = fakeAgent({ status: 'idle' })
  const result = promotePending(agent, view)
  assert.deepEqual(result, { kind: 'promoted', via: 'followup', degraded: true })
  assert.equal(agent.calls[0][0], 'remove')
  assert.equal(agent.calls[1][0], 'followup')
})

test('promotePending: item claimed between render and keypress → not-found, nothing sent', () => {
  const view = { id: 'a', text: 'hi', target: 'next-step', message: { id: 'm-7' } }
  const agent = fakeAgent({ removeResult: false })
  const result = promotePending(agent, view)
  assert.deepEqual(result, { kind: 'not-found' })
  assert.deepEqual(agent.calls.map(([op]) => op), ['remove'], 'no delivery after a lost item')
})

test('S2: steer AND first followup fail → recovery re-queues the original object (no lost window)', () => {
  // The dangerous double-failure window: remove succeeded, then deliver's
  // internal fallback followup threw too. One recovery followup of the
  // ORIGINAL object must put the message back into the queue.
  const message = { id: 'm-15' }
  const view = { id: 'm-15', text: 'rescue me', target: 'next-turn', message }
  let followupThrows = true
  const agent = fakeAgent({ status: 'running', throwSteer: true })
  const originalFollowup = agent.followup.bind(agent)
  agent.followup = m => {
    if (followupThrows) {
      followupThrows = false
      throw new Error('followup failed')
    }
    originalFollowup(m)
  }
  const result = promotePending(agent, view)
  assert.deepEqual(result, { kind: 'promoted', via: 'followup', degraded: true }, 'recovery lands as a degraded promote, never an error')
  assert.equal(agent.calls.at(-1)[1], message, 'the exact original object is re-queued')
})

test('S2: every delivery attempt fails → explicit error saying the message was NOT delivered', () => {
  const view = { id: 'a', text: 'hi', target: 'next-turn', message: { id: 'm-16' } }
  const agent = fakeAgent({ status: 'running', throwSteer: true, throwFollowup: true })
  const result = promotePending(agent, view)
  assert.equal(result.kind, 'error')
  assert.match(result.error, /NOT delivered/, 'the user is told plainly the message was not sent')
  assert.match(result.error, /submit it again/, '…and what to do about it')
  // Only the successful remove was recorded — every delivery attempt threw
  // before reaching its call log, and the message is in neither queue nor
  // turn (the error is the honest terminal state).
  assert.deepEqual(agent.calls.map(([op]) => op), ['remove'])
})

test('describeQueueActionResult: English-only wording stating the actual route', () => {
  assert.ok(describeQueueActionResult({ kind: 'removed' }).includes('Removed'))
  const degraded = describeQueueActionResult({ kind: 'promoted', via: 'followup', degraded: true })
  assert.ok(degraded.includes('queued as a follow-up'), 'degrade notice names the real outcome')
  const promoted = describeQueueActionResult({ kind: 'promoted', via: 'steer', degraded: false })
  assert.ok(promoted.includes('steering'))
  assert.ok(describeQueueActionResult({ kind: 'not-found' }).includes('claimed'))
  assert.ok(describeQueueActionResult({ kind: 'error', error: 'boom' }).includes('boom'))
})

// ------------------------------------------------------- route dialog ----

test('route dialog: arrows move within bounds, digits select directly', () => {
  let state = initialRouteDialogState()
  assert.equal(state.selected, 0, 'first option preselected')
  state = updateRouteDialog(state, DOWN)
  assert.equal(state.selected, 1)
  state = updateRouteDialog(state, DOWN)
  assert.equal(state.selected, 1, 'clamped at the last option')
  state = updateRouteDialog(state, UP)
  assert.equal(state.selected, 0)
  state = updateRouteDialog(state, UP)
  assert.equal(state.selected, 0, 'clamped at the first option')
  state = updateRouteDialog(state, '2')
  assert.equal(state.selected, 1, 'digit selects without confirming')
  assert.equal(state.settled, undefined)
})

test('route dialog: Enter confirms the highlighted route, Esc cancels', () => {
  const confirm = updateRouteDialog(initialRouteDialogState(), ENTER)
  assert.equal(routeDialogOutcome(confirm), ROUTE_OPTIONS[0].id)
  const confirmSecond = updateRouteDialog(updateRouteDialog(initialRouteDialogState(), DOWN), ENTER)
  assert.equal(routeDialogOutcome(confirmSecond), 'steer')
  const cancel = updateRouteDialog(initialRouteDialogState(), ESC)
  assert.equal(cancel.settled, 'cancel')
  assert.equal(routeDialogOutcome(cancel), undefined, 'cancel resolves no route')
})

test('route dialog: exactly one terminal outcome — input after settle is ignored', () => {
  let state = updateRouteDialog(initialRouteDialogState(), ESC)
  const frozen = updateRouteDialog(state, ENTER)
  assert.equal(frozen, state, 'settled state is returned untouched')
  assert.equal(routeDialogOutcome(frozen), undefined)

  let confirmed = updateRouteDialog(initialRouteDialogState(), ENTER)
  confirmed = updateRouteDialog(confirmed, ESC)
  assert.equal(confirmed.settled, 'confirm', 'a later Esc cannot overwrite the confirm')
  assert.equal(routeDialogOutcome(confirmed), ROUTE_OPTIONS[0].id)
})

test('route dialog: unknown keys are no-ops and out-of-range digits are ignored', () => {
  const state = updateRouteDialog(initialRouteDialogState(), 'q')
  assert.deepEqual(state, initialRouteDialogState())
  const beyond = updateRouteDialog(initialRouteDialogState(), '9')
  assert.equal(beyond.selected, 0, 'no row 9 exists')
})

test('route dialog options carry the design labels with English hints', () => {
  assert.deepEqual(ROUTE_OPTIONS.map(option => option.id), ['followup', 'steer'])
  assert.equal(ROUTE_OPTIONS[0].title, 'Queue as follow-up')
  assert.equal(ROUTE_OPTIONS[1].title, 'Steer now')
  for (const option of ROUTE_OPTIONS) {
    assert.match(option.hint, /^[a-z].*[a-z]$/, 'hints are plain English text')
  }
  assert.match(ROUTE_DIALOG_FOOTER, /Esc cancel/)
  assert.match(QUEUE_PANEL_FOOTER, /d remove · s steer now/)
})

// ------------------------------------------------------------ queue rows --

test('queueRow: selection marker + route badge + single-line preview', () => {
  const step = { id: 'a', text: 'check the\n failing test', target: 'next-step', message: { id: 'm-8' } }
  const turn = { id: 'b', text: 'later thing', target: 'next-turn', message: { id: 'm-9' } }
  assert.equal(queueRow(step, true), '▸ ↪ steer · check the failing test')
  assert.equal(queueRow(turn, false), '  ⏳ queued · later thing')
})
