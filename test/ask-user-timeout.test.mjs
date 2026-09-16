/**
 * Ask-user-question timeouts: the auto-answer rules behind
 * `openAskUserPanel(deps, questions, signal, timeouts)`.
 *
 * Config chain (`resolveAskUserTimeouts`): settings.yaml `dsh-tui.askUser.*`
 * explicit > `DSH_TUI_ASK_USER_*` env > defaults — invalid settings emit one
 * notice each (notice bridge), invalid env falls back silently, and any
 * non-positive value disables that rule (mirrors retention's maxCount off
 * switch). Deadline math and the per-question auto-answer are pure; the
 * panel behavior runs against the built lib/ with REAL short timers (tens of
 * ms) and a fake TUI — no TTY anywhere.
 *
 * Semantics under test (per focused question, dual rule):
 * - idle window  — any keypress restarts it; firing auto-answers the focused
 *   question (first option = the dsh "recommended" contract, plan-review
 *   never approves, no-option questions get a decline-style note, a live
 *   sentinel buffer commits as the custom answer);
 * - absolute cap — fires even under continuous input;
 * - firing on the last unanswered question settles the envelope DIRECTLY
 *   (the review page is a human double-check an absent human cannot do);
 *   a review-phase fire submits the answers already given;
 * - every automatic pick is declared in-band via the envelope's `custom`
 *   note (TIMEOUT_* notes) — never silently passed off as a human choice;
 * - disabled (both rules 0) reproduces the legacy wait-forever panel.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ASK_USER_ABSOLUTE_MINUTES_DEFAULT,
  ASK_USER_ABSOLUTE_MINUTES_DEFAULT as ABS_DEFAULT,
  ASK_USER_IDLE_MINUTES_DEFAULT,
  ASK_USER_IDLE_MINUTES_DEFAULT as IDLE_DEFAULT,
  ASK_USER_TIMEOUTS_DISABLED,
  buildAnswerEnvelope,
  buildAnswerEnvelopeWithNotes,
  formatCountdown,
  initialState,
  nextTimeoutDeadline,
  openAskUserPanel,
  resolveAskUserTimeouts,
  TIMEOUT_CUSTOM_NOTE,
  TIMEOUT_NO_DEFAULT_NOTE,
  TIMEOUT_PLAN_DECLINED_NOTE,
  TIMEOUT_RECOMMENDED_NOTE,
  timeoutAnswerFor,
} from '../lib/ask-user.js'
import { githubLight } from '../lib/theme/palette.js'
import { resetNoticeBridge, setNoticeSink } from '../lib/notice-bridge.js'

const MINUTE = 60_000
const IDLE_DEFAULT_MS = IDLE_DEFAULT * MINUTE
const ABS_DEFAULT_MS = ABS_DEFAULT * MINUTE

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const singleQuestion = () => [{
  id: 'q1',
  question: 'Which database should we use?',
  header: 'Database',
  options: [
    { label: 'Postgres', description: 'battle-tested' },
    { label: 'SQLite' },
  ],
}]

const baseQuestions = () => [
  {
    id: 'q1',
    question: 'Which fruit?',
    header: 'Fruit',
    options: [{ label: 'apple' }, { label: 'banana' }],
  },
  {
    id: 'q2',
    question: 'Which vehicle?',
    header: 'Vehicle',
    options: [{ label: 'car' }, { label: 'bike' }],
  },
]

/** Fake TUI harness without an injected clock — the panel uses Date.now and
 *  the tests drive REAL short timers. */
function makeHarness() {
  const calls = { unmounts: 0, restoreFocus: 0, modal: [], component: undefined }
  const deps = {
    tui: {
      hideOverlay() {},
      setFocus() {},
      requestRender() {},
    },
    theme: () => ({ palette: githubLight }),
    restoreFocus: () => { calls.restoreFocus += 1 },
    mount(component) {
      calls.component = component
      deps.component = component
      return () => { calls.unmounts += 1 }
    },
    setModalActive(active) { calls.modal.push(active) },
  }
  return { deps, calls }
}

/** All rendered lines (ANSI stripped) of the mounted panel. */
function panelLines(handle, width = 80) {
  return handle.component.render(width).map(l => l.replace(/\x1b\[[0-9;]*m/g, ''))
}

// ------------------------------------------------------------ config chain --

test('resolveAskUserTimeouts: defaults are 5 idle / 10 absolute minutes', () => {
  assert.equal(ASK_USER_IDLE_MINUTES_DEFAULT, 5)
  assert.equal(ASK_USER_ABSOLUTE_MINUTES_DEFAULT, 10)
  assert.deepEqual(resolveAskUserTimeouts(undefined, {}), { idleMs: IDLE_DEFAULT_MS, absoluteMs: ABS_DEFAULT_MS })
  assert.deepEqual(resolveAskUserTimeouts({}, {}), { idleMs: IDLE_DEFAULT_MS, absoluteMs: ABS_DEFAULT_MS })
})

test('resolveAskUserTimeouts: explicit settings outrank env, env outranks defaults', () => {
  // settings > env
  assert.deepEqual(
    resolveAskUserTimeouts(
      { idleMinutes: 2, absoluteMinutes: 3 },
      { DSH_TUI_ASK_USER_IDLE_MINUTES: '7', DSH_TUI_ASK_USER_ABSOLUTE_MINUTES: '8' },
    ),
    { idleMs: 2 * MINUTE, absoluteMs: 3 * MINUTE },
  )
  // env with no settings
  assert.deepEqual(
    resolveAskUserTimeouts(undefined, { DSH_TUI_ASK_USER_IDLE_MINUTES: '1', DSH_TUI_ASK_USER_ABSOLUTE_MINUTES: '2' }),
    { idleMs: 1 * MINUTE, absoluteMs: 2 * MINUTE },
  )
  // one knob at a time mixes levels independently
  assert.deepEqual(
    resolveAskUserTimeouts({ idleMinutes: 4 }, { DSH_TUI_ASK_USER_ABSOLUTE_MINUTES: '9' }),
    { idleMs: 4 * MINUTE, absoluteMs: 9 * MINUTE },
  )
})

test('resolveAskUserTimeouts: non-positive values DISABLE the rule (documented off switch)', () => {
  assert.deepEqual(resolveAskUserTimeouts({ idleMinutes: 0, absoluteMinutes: -3 }, {}), { idleMs: 0, absoluteMs: 0 })
  assert.deepEqual(
    resolveAskUserTimeouts(undefined, { DSH_TUI_ASK_USER_IDLE_MINUTES: '0' }),
    { idleMs: 0, absoluteMs: ABS_DEFAULT_MS },
  )
})

test('resolveAskUserTimeouts: invalid settings emit one notice each and fall to env/default', () => {
  resetNoticeBridge()
  const notices = []
  setNoticeSink(message => { notices.push(message) })
  try {
    // Garbage falls to the env layer.
    assert.deepEqual(
      resolveAskUserTimeouts(
        { idleMinutes: 'soon', absoluteMinutes: Number.NaN },
        { DSH_TUI_ASK_USER_IDLE_MINUTES: '6', DSH_TUI_ASK_USER_ABSOLUTE_MINUTES: '7' },
      ),
      { idleMs: 6 * MINUTE, absoluteMs: 7 * MINUTE },
    )
    assert.equal(notices.length, 2, 'one notice per invalid settings field')
    assert.match(notices[0], /^settings dsh-tui\.askUser\.idleMinutes: invalid value "soon" — falling back to environment\/default$/)
    assert.match(notices[1], /dsh-tui\.askUser\.absoluteMinutes: invalid value null —/)

    // Garbage with no env either → the defaults (still one notice each).
    notices.length = 0
    assert.deepEqual(
      resolveAskUserTimeouts({ idleMinutes: true, absoluteMinutes: [5] }, {}),
      { idleMs: IDLE_DEFAULT_MS, absoluteMs: ABS_DEFAULT_MS },
    )
    assert.equal(notices.length, 2)

    // Valid values and absent fields never notice.
    notices.length = 0
    resolveAskUserTimeouts({ idleMinutes: 1.5 }, {})
    assert.equal(notices.length, 0)
  } finally {
    resetNoticeBridge()
  }
})

test('resolveAskUserTimeouts: invalid env falls back silently (retention finiteEnv contract)', async () => {
  resetNoticeBridge()
  const notices = []
  setNoticeSink(message => { notices.push(message) })
  try {
    assert.deepEqual(
      resolveAskUserTimeouts(undefined, { DSH_TUI_ASK_USER_IDLE_MINUTES: 'soon', DSH_TUI_ASK_USER_ABSOLUTE_MINUTES: '' }),
      { idleMs: IDLE_DEFAULT_MS, absoluteMs: ABS_DEFAULT_MS },
    )
    assert.deepEqual(resolveAskUserTimeouts(undefined, { DSH_TUI_ASK_USER_IDLE_MINUTES: '  ' }), { idleMs: IDLE_DEFAULT_MS, absoluteMs: ABS_DEFAULT_MS })
    assert.equal(notices.length, 0, 'env garbage is silent')
  } finally {
    resetNoticeBridge()
  }
})

// ----------------------------------------------------------- deadline math --

test('nextTimeoutDeadline: disabled rules → null; armed rules → the earlier deadline', () => {
  const now = 1_000_000
  assert.equal(nextTimeoutDeadline(ASK_USER_TIMEOUTS_DISABLED, now, now, now), null)
  assert.equal(nextTimeoutDeadline({ idleMs: 0, absoluteMs: 0 }, now, now, now), null)
  // idle only
  assert.equal(nextTimeoutDeadline({ idleMs: 5_000, absoluteMs: 0 }, now, now - 60_000, now), now + 5_000)
  // absolute only — runs from focusEnteredAt even if input is older/newer
  assert.equal(nextTimeoutDeadline({ idleMs: 0, absoluteMs: 30_000 }, now, now - 10_000, now), now + 20_000)
  // both — the minimum wins
  assert.equal(nextTimeoutDeadline({ idleMs: 5_000, absoluteMs: 30_000 }, now, now - 10_000, now), now + 5_000)
  assert.equal(nextTimeoutDeadline({ idleMs: 60_000, absoluteMs: 30_000 }, now, now, now), now + 30_000)
})

// ---------------------------------------------------------- auto-answer ----

test('timeoutAnswerFor: picks the FIRST option (the recommended contract) with a note', () => {
  const { answer, note } = timeoutAnswerFor(singleQuestion()[0], null)
  assert.deepEqual(answer, { selected: ['Postgres'] })
  assert.equal(note, TIMEOUT_RECOMMENDED_NOTE)
})

test('timeoutAnswerFor: commits a non-empty live buffer as the custom answer', () => {
  const { answer, note } = timeoutAnswerFor(singleQuestion()[0], '  use sqlite please  ')
  assert.deepEqual(answer, { selected: [], custom: 'use sqlite please' })
  assert.equal(note, TIMEOUT_CUSTOM_NOTE)
  // an empty/whitespace buffer is NOT an answer
  const empty = timeoutAnswerFor(singleQuestion()[0], '   ')
  assert.deepEqual(empty.answer, { selected: ['Postgres'] })
})

test('timeoutAnswerFor: plan-review NEVER auto-approves', () => {
  const plan = {
    id: 'plan',
    question: 'Approve the plan?',
    options: [{ label: 'Approve plan' }, { label: 'Decline' }],
    intent: { kind: 'plan-review', approve: 'Approve plan' },
  }
  const { answer, note } = timeoutAnswerFor(plan, null)
  assert.deepEqual(answer, { selected: ['Decline'] })
  assert.equal(note, TIMEOUT_PLAN_DECLINED_NOTE)

  // approve-only option list → nothing selectable is safe: empty selection + note
  const approveOnly = { ...plan, options: [{ label: 'Approve plan' }] }
  const only = timeoutAnswerFor(approveOnly, null)
  assert.deepEqual(only.answer, { selected: [] })
  assert.equal(only.note, TIMEOUT_PLAN_DECLINED_NOTE)
})

test('timeoutAnswerFor: a question with no options gets the no-default note', () => {
  const freeText = { id: 'q', question: 'What is your quest?' }
  const { answer, note } = timeoutAnswerFor(freeText, null)
  assert.deepEqual(answer, { selected: [] })
  assert.equal(note, TIMEOUT_NO_DEFAULT_NOTE)
})

test('buildAnswerEnvelopeWithNotes: no notes === buildAnswerEnvelope; notes fold into custom', () => {
  const questions = baseQuestions()
  const state = {
    ...initialState(questions),
    perQuestion: [{ selected: ['apple'] }, { selected: [], custom: 'a bike, please' }],
  }
  assert.deepEqual(buildAnswerEnvelopeWithNotes(state), buildAnswerEnvelope(state))
  assert.deepEqual(buildAnswerEnvelopeWithNotes(state, new Map()), buildAnswerEnvelope(state))

  const noted = buildAnswerEnvelopeWithNotes(state, new Map([[0, TIMEOUT_RECOMMENDED_NOTE]]))
  assert.deepEqual(noted.answers[0], { id: 'q1', selected: ['apple'], custom: TIMEOUT_RECOMMENDED_NOTE })
  // an existing custom answer gets the note CONCATENATED, not replaced
  const both = buildAnswerEnvelopeWithNotes(state, new Map([[1, TIMEOUT_CUSTOM_NOTE]]))
  assert.equal(both.answers[1].custom, `a bike, please (${TIMEOUT_CUSTOM_NOTE})`)
})

test('formatCountdown: m:ss, ceiling, floored at 0:00', () => {
  assert.equal(formatCountdown(0), '0:00')
  assert.equal(formatCountdown(-5), '0:00')
  assert.equal(formatCountdown(1_000), '0:01')
  assert.equal(formatCountdown(59_900), '1:00') // ceiling, not truncation
  assert.equal(formatCountdown(61_200), '1:02')
  assert.equal(formatCountdown(125_000), '2:05')
  assert.equal(formatCountdown(3_600_000), '60:00')
})

// ------------------------------------------------------------ panel logic --
// Real timers, tens of ms. Every assertion leaves generous margins so a slow
// CI box cannot flake: "not resolved" checks run at ~40% of the deadline,
// resolution waits run at 3-5x.

test('panel timeout: idle fire auto-answers the single question with the recommended option + note', async () => {
  const { deps, calls } = makeHarness()
  const result = openAskUserPanel(deps, singleQuestion(), undefined, { idleMs: 40, absoluteMs: 0 })
  const tracked = { resolved: false, value: undefined }
  result.then(v => { tracked.resolved = true; tracked.value = v })
  await sleep(15)
  assert.equal(tracked.resolved, false, 'must still be pending before the idle window closes')
  await sleep(180)
  assert.equal(tracked.resolved, true, 'idle fire settles the panel')
  assert.deepEqual(tracked.value.answers, [{
    id: 'q1',
    selected: ['Postgres'],
    custom: TIMEOUT_RECOMMENDED_NOTE,
  }])
  assert.equal(calls.unmounts, 1, 'panel unmounted')
  assert.deepEqual(calls.modal, [true, false], 'modal flag cleared')
  assert.equal(calls.restoreFocus, 1)
})

test('panel timeout: multi-question fire hops with fresh budgets — Q1 then Q2 both auto-answered', async () => {
  const { deps } = makeHarness()
  const result = openAskUserPanel(deps, baseQuestions(), undefined, { idleMs: 40, absoluteMs: 0 })
  const tracked = { resolved: false, value: undefined }
  result.then(v => { tracked.resolved = true; tracked.value = v })
  await sleep(20)
  assert.equal(tracked.resolved, false, 'Q1 idle pending')
  await sleep(50)
  assert.equal(tracked.resolved, false, 'Q1 fired → focus advanced to Q2; the panel stays open for Q2 own budget')
  await sleep(180)
  assert.equal(tracked.resolved, true)
  assert.deepEqual(tracked.value.answers, [
    { id: 'q1', selected: ['apple'], custom: TIMEOUT_RECOMMENDED_NOTE },
    { id: 'q2', selected: ['car'], custom: TIMEOUT_RECOMMENDED_NOTE },
  ])
})

test('panel timeout: a keypress restarts the idle window (presence)', async () => {
  const { deps } = makeHarness()
  const result = openAskUserPanel(deps, singleQuestion(), undefined, { idleMs: 100, absoluteMs: 0 })
  const tracked = { resolved: false, value: undefined }
  result.then(v => { tracked.resolved = true; tracked.value = v })
  await sleep(50)
  deps.component.handleInput('\x1b[B') // ↓ — presence at ~50ms moves the deadline to ~150ms
  await sleep(45)
  assert.equal(tracked.resolved, false, 'the original deadline (~100ms) passed but input restarted the window')
  await sleep(160)
  assert.equal(tracked.resolved, true, 'the RESTARTED window fires')
  assert.deepEqual(tracked.value.answers[0].selected, ['Postgres'])
})

test('panel timeout: the absolute cap fires even under continuous input', async () => {
  const { deps } = makeHarness()
  const result = openAskUserPanel(deps, singleQuestion(), undefined, { idleMs: 0, absoluteMs: 60 })
  const tracked = { resolved: false, value: undefined }
  result.then(v => { tracked.resolved = true; tracked.value = v })
  // keypresses every 20ms — well inside any idle window (which is off anyway)
  for (let i = 0; i < 6; i++) {
    await sleep(20)
    if (!tracked.resolved) deps.component.handleInput('\x1b[B')
  }
  await sleep(80)
  assert.equal(tracked.resolved, true, 'the hard cap fired despite activity')
  assert.deepEqual(tracked.value.answers[0].selected, ['Postgres'])
})

test('panel timeout: user-answered questions are untouched; only unanswered ones auto-answer', async () => {
  const { deps } = makeHarness()
  const result = openAskUserPanel(deps, baseQuestions(), undefined, { idleMs: 40, absoluteMs: 0 })
  const tracked = { resolved: false, value: undefined }
  result.then(v => { tracked.resolved = true; tracked.value = v })
  await sleep(5)
  deps.component.handleInput('\r') // Enter on Q1's first option ('apple') → auto-advance to Q2
  await sleep(180)
  assert.equal(tracked.resolved, true)
  assert.deepEqual(tracked.value.answers, [
    // the user's own pick carries NO note
    { id: 'q1', selected: ['apple'] },
    { id: 'q2', selected: ['car'], custom: TIMEOUT_RECOMMENDED_NOTE },
  ])
})

test('panel timeout: plan-review questions never auto-approve', async () => {
  const plan = [{
    id: 'plan',
    question: 'Approve the plan?',
    options: [{ label: 'Approve plan' }, { label: 'Decline' }],
    intent: { kind: 'plan-review', approve: 'Approve plan' },
  }]
  const { deps } = makeHarness()
  const result = openAskUserPanel(deps, plan, undefined, { idleMs: 40, absoluteMs: 0 })
  const tracked = { resolved: false, value: undefined }
  result.then(v => { tracked.resolved = true; tracked.value = v })
  await sleep(180)
  assert.equal(tracked.resolved, true)
  assert.deepEqual(tracked.value.answers, [{
    id: 'plan',
    selected: ['Decline'],
    custom: TIMEOUT_PLAN_DECLINED_NOTE,
  }])
})

test('panel timeout: a live sentinel buffer commits as the custom answer (with the auto-commit note)', async () => {
  const freeText = [{ id: 'q1', question: 'What is your quest?' }]
  const { deps } = makeHarness()
  const result = openAskUserPanel(deps, freeText, undefined, { idleMs: 60, absoluteMs: 0 })
  const tracked = { resolved: false, value: undefined }
  result.then(v => { tracked.resolved = true; tracked.value = v })
  await sleep(5)
  deps.component.handleInput('\r') // Enter on the sentinel row (the only selectable) → inline edit
  for (const ch of 'to seek the grail') deps.component.handleInput(ch)
  await sleep(150)
  assert.equal(tracked.resolved, true)
  assert.equal(tracked.value.answers.length, 1)
  assert.equal(tracked.value.answers[0].custom, `to seek the grail (${TIMEOUT_CUSTOM_NOTE})`)
})

test('panel timeout: a review-phase fire submits the answers already given', async () => {
  const { deps } = makeHarness()
  const result = openAskUserPanel(deps, baseQuestions(), undefined, { idleMs: 60, absoluteMs: 0 })
  const tracked = { resolved: false, value: undefined }
  result.then(v => { tracked.resolved = true; tracked.value = v })
  await sleep(5)
  deps.component.handleInput('\r') // Q1 → 'apple', hop to Q2
  deps.component.handleInput('\r') // Q2 → 'car', cursor parks on Confirm
  deps.component.handleInput('\r') // confirm → review page
  await sleep(200)
  assert.equal(tracked.resolved, true, 'the review page does not wait forever either')
  assert.deepEqual(tracked.value.answers, [
    { id: 'q1', selected: ['apple'] },
    { id: 'q2', selected: ['car'] },
  ])
})

test('panel timeout: disabled rules reproduce the legacy wait-forever panel', async () => {
  const { deps } = makeHarness()
  const result = openAskUserPanel(deps, singleQuestion(), undefined, ASK_USER_TIMEOUTS_DISABLED)
  const tracked = { resolved: false, value: undefined }
  result.then(v => { tracked.resolved = true; tracked.value = v })
  await sleep(120)
  assert.equal(tracked.resolved, false, 'no timers armed — still waiting for the human')
  deps.component.handleInput('\r') // the human answers manually
  await sleep(20)
  assert.equal(tracked.resolved, true)
  assert.deepEqual(tracked.value.answers, [{ id: 'q1', selected: ['Postgres'] }])
})

test('panel timeout: default param is disabled — existing direct callers keep the legacy behavior', async () => {
  const { deps } = makeHarness()
  const result = openAskUserPanel(deps, singleQuestion())
  const tracked = { resolved: false }
  result.then(() => { tracked.resolved = true })
  await sleep(120)
  assert.equal(tracked.resolved, false)
})

test('panel timeout: aborting disarms the timer — no auto-answer fires afterwards', async () => {
  const controller = new AbortController()
  const { deps, calls } = makeHarness()
  const result = openAskUserPanel(deps, singleQuestion(), controller.signal, { idleMs: 40, absoluteMs: 0 })
  const tracked = { resolved: false, value: undefined }
  result.then(v => { tracked.resolved = true; tracked.value = v })
  await sleep(5)
  controller.abort()
  await sleep(5)
  assert.equal(tracked.resolved, true, 'abort settles declined immediately')
  assert.deepEqual(tracked.value, {
    answers: [{ id: 'q1', selected: [], custom: 'User declined to answer questions.' }],
  })
  await sleep(120)
  assert.equal(calls.unmounts, 1, 'and stays settled — the fired-abort timer cannot double-resolve')
})

test('panel timeout: the countdown rides the footer while armed and disappears when disabled', async () => {
  const armed = makeHarness()
  openAskUserPanel(armed.deps, singleQuestion(), undefined, { idleMs: 60_000, absoluteMs: 0 })
  const armedLines = panelLines(armed.calls, 100)
  assert.ok(
    armedLines.some(l => /auto in 1:00/.test(l)),
    `footer shows the idle countdown, got: ${JSON.stringify(armedLines)}`,
  )

  const off = makeHarness()
  openAskUserPanel(off.deps, singleQuestion(), undefined, ASK_USER_TIMEOUTS_DISABLED)
  assert.ok(
    panelLines(off.calls).every(l => !l.includes('auto in')),
    'no countdown when the rules are disabled',
  )
})
