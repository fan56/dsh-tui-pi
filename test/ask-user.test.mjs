/**
 * Ask-user-question: the pure-logic layer (state, envelope, decline,
 * double-Esc state machine with key-repeat guard, row layout) AND the
 * interaction layer (`openAskUserPanel` driven through a fake TUI +
 * `handleInput`, abort-signal wiring, provider registration failure
 * semantics) of `src/ask-user.ts`.
 *
 * Pure functions run against the built lib/ (pretest builds); the interaction
 * layer injects a fake `tui.showOverlay` handle, an injectable clock, and
 * plain-object ctx seams — no TTY anywhere.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceDoubleEsc,
  allQuestionsAnswered,
  buildAnswerEnvelope,
  buildDeclinedEnvelope,
  buildRowList,
  canAutoSubmit,
  DECLINE_MESSAGE,
  didDoubleEscFire,
  DOUBLE_ESC_WINDOW_MS,
  enterCustomEdit,
  ESC_REPEAT_GUARD_MS,
  exitCustomEdit,
  INCOMPLETE_HINT,
  initialState,
  isDuplicateProviderError,
  needsConfirmRow,
  nextSelectableIndex,
  nextUnansweredRow,
  openAskUserPanel,
  patchCustomInput,
  registerAskUserProvider,
  renderQuestionsView,
  renderReviewView,
  setCustomAnswer,
  SENTINEL_LABEL,
  toggleOption,
} from '../lib/ask-user.js'
import { githubLight } from '../lib/theme/palette.js'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'

const theme = { palette: githubLight }

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')
const baseQuestions = () => [
  { id: 'q1', question: 'Pick a fruit', header: 'Fruit', options: [{ label: 'apple', description: 'red and round' }, { label: 'banana', description: 'yellow and long' }] },
  { id: 'q2', question: 'Pick a vehicle', header: 'Vehicle', options: [{ label: 'car' }, { label: 'bike' }] },
]
const singleQuestion = () => [
  { id: 'q1', question: 'Continue?', header: 'Confirm', options: [{ label: 'yes' }, { label: 'no' }] },
]

// ---------------------------------------------------------- initial state --

test('initialState: cursor on first option, defaults to the questions phase', () => {
  const state = initialState(baseQuestions())
  assert.equal(state.phase, 'questions')
  assert.equal(state.cursorIndex, 0)
  assert.deepEqual(state.perQuestion, [{ selected: [] }, { selected: [] }])
  assert.equal(state.customEditingFor, null)
  assert.equal(state.cancelHint, false)
  assert.equal(state.lastEscAt, null)
})

test('initialState: rejects no questions gracefully', () => {
  const state = initialState([])
  assert.equal(state.questions.length, 0)
  assert.equal(state.cursorIndex, 0)
})

// ------------------------------------------------------- toggle (select) --

test('toggleOption: single-select replaces the previous pick', () => {
  const s0 = initialState(singleQuestion())
  const s1 = toggleOption(s0, 0, 'yes')
  assert.deepEqual(s1.perQuestion[0].selected, ['yes'])
  const s2 = toggleOption(s1, 0, 'no')
  assert.deepEqual(s2.perQuestion[0].selected, ['no'])
})

test('toggleOption: single-select deselects when the same label re-toggles', () => {
  const s0 = initialState(singleQuestion())
  const s1 = toggleOption(s0, 0, 'yes')
  const s2 = toggleOption(s1, 0, 'yes')
  assert.deepEqual(s2.perQuestion[0].selected, [])
})

test('toggleOption: multi-select accumulates selections across toggles', () => {
  const multi = [{ id: 'q1', question: 'Tags?', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multiSelect: true }]
  const s0 = initialState(multi)
  const s1 = toggleOption(s0, 0, 'a')
  const s2 = toggleOption(s1, 0, 'b')
  const s3 = toggleOption(s2, 0, 'c')
  assert.deepEqual(s3.perQuestion[0].selected, ['a', 'b', 'c'])
  const s4 = toggleOption(s3, 0, 'b')
  assert.deepEqual(s4.perQuestion[0].selected, ['a', 'c'])
})

// ----------------------------------------------------- custom (sentinel) --

test('setCustomAnswer: clears selected options when free text takes over', () => {
  const s0 = initialState(singleQuestion())
  const s1 = toggleOption(s0, 0, 'yes')
  assert.deepEqual(s1.perQuestion[0].selected, ['yes'])
  const s2 = setCustomAnswer(s1, 0, 'maybe')
  assert.deepEqual(s2.perQuestion[0].selected, [])
  assert.equal(s2.perQuestion[0].custom, 'maybe')
  assert.equal(s2.customInputs[0], 'maybe')
})

test('patchCustomInput: append and backspace mutate the live edit buffer', () => {
  const s0 = enterCustomEdit(initialState(singleQuestion()), 0)
  const s1 = patchCustomInput(s0, 0, current => current + 'a')
  assert.equal(s1.customInputs[0], 'a')
  const s2 = patchCustomInput(s1, 0, current => current + 'b')
  assert.equal(s2.customInputs[0], 'ab')
  const s3 = patchCustomInput(s2, 0, current => current.slice(0, -1))
  assert.equal(s3.customInputs[0], 'a')
})

test('exitCustomEdit: commit preserves the trimmed text; cancel discards', () => {
  const s0 = enterCustomEdit(initialState(singleQuestion()), 0)
  const s1 = patchCustomInput(s0, 0, () => '  yes please  ')
  const s2 = exitCustomEdit(s1, true)
  assert.equal(s2.customEditingFor, null)
  assert.equal(s2.perQuestion[0].custom, 'yes please')
  assert.deepEqual(s2.perQuestion[0].selected, [])
  const s3 = patchCustomInput(exitCustomEdit(s1, false), 0, () => '')
  assert.equal(s3.perQuestion[0].custom, undefined)
})

test('exitCustomEdit: empty commit does not write the answer', () => {
  const s0 = enterCustomEdit(initialState(singleQuestion()), 0)
  const s1 = exitCustomEdit(s0, true)
  assert.equal(s1.perQuestion[0].custom, undefined)
  assert.equal(s1.perQuestion[0].selected.length, 0)
  assert.equal(s1.customEditingFor, null)
})

// --------------------------------------------- double-Esc state machine --

test('advanceDoubleEsc: first press within the quiet window arms + sets hint', () => {
  const s0 = initialState(singleQuestion())
  const s1 = advanceDoubleEsc(s0, 1000)
  assert.equal(s1.lastEscAt, 1000)
  assert.equal(s1.cancelHint, true)
})

test('advanceDoubleEsc: second press within the window clears + clears hint (declined)', () => {
  const s0 = initialState(singleQuestion())
  const armed = advanceDoubleEsc(s0, 1000)
  const fired = advanceDoubleEsc(armed, 1000 + DOUBLE_ESC_WINDOW_MS - 1)
  assert.equal(fired.lastEscAt, null)
  assert.equal(fired.cancelHint, false)
  assert.equal(didDoubleEscFire(armed, fired, 1000 + DOUBLE_ESC_WINDOW_MS - 1), true)
})

test('advanceDoubleEsc: a press after the window lapses re-arms (no fire)', () => {
  const s0 = initialState(singleQuestion())
  const armed = advanceDoubleEsc(s0, 1000)
  const rearmed = advanceDoubleEsc(armed, 1000 + DOUBLE_ESC_WINDOW_MS + 1)
  assert.equal(rearmed.lastEscAt, 1000 + DOUBLE_ESC_WINDOW_MS + 1)
  assert.equal(rearmed.cancelHint, true)
  assert.equal(didDoubleEscFire(armed, rearmed, 1000 + DOUBLE_ESC_WINDOW_MS + 1), false)
})

test('advanceDoubleEsc: didDoubleEscFire returns true only for the explicit decline transition', () => {
  const s0 = initialState(singleQuestion())
  const armed = advanceDoubleEsc(s0, 1000)
  const fired = advanceDoubleEsc(armed, 1050)
  assert.equal(didDoubleEscFire(armed, fired, 1050), true)
  // Same state (no press) does not fire.
  assert.equal(didDoubleEscFire(armed, armed, 1050), false)
  // After lapse, a re-arm does not look like a fire.
  const rearmed = advanceDoubleEsc(fired, 1300)
  assert.equal(didDoubleEscFire(fired, rearmed, 1300), false)
})

// ------------------------------------------------------- answer envelope --

test('buildAnswerEnvelope: maps questions to {id, selected, custom?}', () => {
  const s0 = initialState(baseQuestions())
  const s1 = toggleOption(s0, 0, 'apple')
  const s2 = toggleOption(s1, 1, 'car')
  const env = buildAnswerEnvelope(s2)
  assert.equal(env.answers.length, 2)
  assert.deepEqual(env.answers[0], { id: 'q1', selected: ['apple'] })
  assert.deepEqual(env.answers[1], { id: 'q2', selected: ['car'] })
  assert.equal(env.answers[0].custom, undefined, 'no custom field when not used')
})

test('buildAnswerEnvelope: omits custom when the user typed only spaces', () => {
  const s0 = enterCustomEdit(initialState(singleQuestion()), 0)
  const s1 = patchCustomInput(s0, 0, () => '   ')
  const s2 = exitCustomEdit(s1, true)
  assert.equal(buildAnswerEnvelope(s2).answers[0].custom, undefined)
})

test('buildDeclinedEnvelope: every question gets empty selected + the decline message', () => {
  const env = buildDeclinedEnvelope(baseQuestions())
  assert.equal(env.answers.length, 2)
  for (const answer of env.answers) {
    assert.deepEqual(answer.selected, [])
    assert.equal(answer.custom, DECLINE_MESSAGE)
  }
})

test('buildDeclinedEnvelope: accepts an alternate decline message', () => {
  const env = buildDeclinedEnvelope(baseQuestions(), 'skipped by user')
  assert.equal(env.answers.every(a => a.custom === 'skipped by user'), true)
})

// ------------------------------------------------------------- row list --

test('buildRowList: lays out Q header + options + sentinel + confirm (multi)', () => {
  const rows = buildRowList(baseQuestions(), initialState(baseQuestions()).perQuestion)
  // Q0: header(1) + 2 options + sentinel(1) = 4 rows.
  // Q1: same = 4 rows.
  // Multi: confirm(1).
  assert.equal(rows.length, 4 + 4 + 1)
  assert.equal(rows[0].kind, 'question-header')
  assert.equal(rows[0].questionIndex, 0)
  assert.equal(rows[0].selectable, false)
  assert.equal(rows[1].kind, 'option')
  assert.equal(rows[2].kind, 'option')
  assert.equal(rows[3].kind, 'sentinel')
  // Last row is the confirm row.
  assert.equal(rows[8].kind, 'confirm')
  assert.equal(rows[9], undefined, 'confirm is the last row of a 2-question overlay')
})

test('buildRowList: single-question has NO confirm row', () => {
  const rows = buildRowList(singleQuestion(), initialState(singleQuestion()).perQuestion)
  // header(1) + 2 options + sentinel = 4 rows — no confirm.
  assert.equal(rows.length, 4)
  assert.equal(rows.find(row => row.kind === 'confirm'), undefined)
})

test('buildRowList: a confirmed custom answer marks the sentinel with ✎', () => {
  const s0 = setCustomAnswer(initialState(singleQuestion()), 0, 'maybe')
  const rows = buildRowList(singleQuestion(), s0.perQuestion)
  const sentinel = rows.find(row => row.kind === 'sentinel' && row.questionIndex === 0)
  assert.ok(sentinel?.label.startsWith('✎ '))
  assert.ok(sentinel?.label.includes('maybe'))
})

test('buildRowList: the default sentinel label reads "Type something."', () => {
  const rows = buildRowList(singleQuestion(), initialState(singleQuestion()).perQuestion)
  const sentinel = rows.find(row => row.kind === 'sentinel' && row.questionIndex === 0)
  assert.equal(sentinel?.label, SENTINEL_LABEL)
})

test('nextSelectableIndex: skips the unselectable header rows', () => {
  const rows = buildRowList(baseQuestions(), initialState(baseQuestions()).perQuestion)
  // 0 = Q0 header (unselectable)
  assert.equal(nextSelectableIndex(rows, 0, 1), 1)
  // start on Q0 option-1, jump down → Q0 sentinel
  assert.equal(nextSelectableIndex(rows, 2, 1), 3)
  // start on Q0 sentinel, jump down → Q1 option-0
  assert.equal(nextSelectableIndex(rows, 3, 1), 5, 'crosses into Q1 options')
  // start on Q0 option-0, jump up — the unselectable Q0 header above blocks
  // the forward scan, so the implementation wraps to the LAST selectable row.
  assert.equal(nextSelectableIndex(rows, 1, -1), 8, 'wraps to the last selectable row (Q1 sentinel or confirm)')
})

test('allQuestionsAnswered: false when any question is empty', () => {
  const s0 = initialState(baseQuestions())
  assert.equal(allQuestionsAnswered(s0), false)
  const s1 = toggleOption(s0, 0, 'apple')
  assert.equal(allQuestionsAnswered(s1), false, 'Q1 still unanswered')
  const s2 = toggleOption(s1, 1, 'car')
  assert.equal(allQuestionsAnswered(s2), true)
})

test('allQuestionsAnswered: a custom answer satisfies the question', () => {
  const s0 = initialState(baseQuestions())
  const s1 = setCustomAnswer(s0, 0, 'apple')
  const s2 = toggleOption(s1, 1, 'bike')
  assert.equal(allQuestionsAnswered(s2), true)
})

// ---------------------------------------------- render: questions view --

test('renderQuestionsView: title + table + scroll info + footer', () => {
  const state = initialState(baseQuestions())
  const lines = renderQuestionsView(theme, state, 60)
  // Title + 3 booktabs rows + 2 headers + 4 option rows + 2 sentinel + 1 confirm = 9 body lines
  // + possible status line + footer.
  const title = stripAnsi(lines[0])
  assert.equal(title, '● Questions (2)')
  // The booktabs header row + the body lines all live below the title.
  assert.ok(lines.find(line => stripAnsi(line).includes('SELECTION')))
  assert.ok(lines.find(line => stripAnsi(line).includes('STATE')))
  // Question labels appear in the table.
  assert.ok(lines.some(line => stripAnsi(line).includes('Fruit') && stripAnsi(line).includes('Pick a fruit')))
  assert.ok(lines.some(line => stripAnsi(line).includes('apple')))
  // The confirm pseudo-row appears at the bottom.
  const confirmLine = lines.find(line => stripAnsi(line).includes('Confirm answers'))
  assert.ok(confirmLine !== undefined, 'multi-question overlay exposes a confirm row')
  // Footer mention: arrow-keys hint.
  const footerLine = lines[lines.length - 1]
  assert.ok(stripAnsi(footerLine).includes('navigate'))
})

test('renderQuestionsView: a selected option shows the [●] status pill (single) or [+] (multi)', () => {
  const state = toggleOption(initialState(singleQuestion()), 0, 'yes')
  const lines = renderQuestionsView(theme, state, 50)
  const selectedLine = lines.find(line => stripAnsi(line).includes('yes'))
  assert.ok(selectedLine !== undefined)
  assert.ok(stripAnsi(selectedLine).includes('●'), 'single-select shows ●')
})

test('renderQuestionsView: cancel hint appears after a single Esc', () => {
  let state = initialState(singleQuestion())
  state = { ...state, ...advanceDoubleEsc(state, Date.now()) }
  const lines = renderQuestionsView(theme, state, 50)
  assert.ok(lines.some(line => stripAnsi(line).includes('Press Esc again to decline')))
})

test('renderQuestionsView: clean state — no cancel hint visible', () => {
  const state = initialState(singleQuestion())
  const lines = renderQuestionsView(theme, state, 50)
  assert.equal(lines.some(line => stripAnsi(line).includes('Press Esc again to decline')), false)
})

test('renderQuestionsView: single-question overlay never renders the confirm row', () => {
  const lines = renderQuestionsView(theme, initialState(singleQuestion()), 50)
  assert.equal(lines.some(line => stripAnsi(line).includes('Confirm answers')), false)
})

// --------------------------------------------------- render: review view --

test('renderReviewView: every question gets a row + the submit pseudo-row', () => {
  const state = toggleOption(toggleOption(initialState(baseQuestions()), 0, 'apple'), 1, 'car')
  const lines = renderReviewView(theme, state, 60)
  assert.ok(lines.find(line => stripAnsi(line).includes('Fruit') && stripAnsi(line).includes('Pick a fruit')))
  assert.ok(lines.find(line => stripAnsi(line).includes('Vehicle')))
  assert.ok(lines.find(line => stripAnsi(line).includes('apple')))
  assert.ok(lines.find(line => stripAnsi(line).includes('car')))
  assert.ok(lines.find(line => stripAnsi(line).includes('Submit answers')))
})

test('renderReviewView: a custom answer reads "✎ <text>" in the answer cell', () => {
  const state = setCustomAnswer(initialState(singleQuestion()), 0, 'maybe')
  const lines = renderReviewView(theme, state, 60)
  assert.ok(lines.some(line => stripAnsi(line).includes('maybe')))
})

// ---------------------------------------------- key-repeat (long-press) guard --

test('advanceDoubleEsc: terminal auto-repeat below the guard gap is ignored entirely', () => {
  const s0 = initialState(singleQuestion())
  const armed = advanceDoubleEsc(s0, 1000)
  // Held key repeats ~30 Hz: presses 20–40 ms apart neither fire nor refresh.
  assert.equal(advanceDoubleEsc(armed, 1000 + ESC_REPEAT_GUARD_MS - 10), armed, 'repeat returns the same state')
  const stillArmed = advanceDoubleEsc(armed, 1000 + ESC_REPEAT_GUARD_MS - 10)
  assert.equal(stillArmed.lastEscAt, 1000, 'armed timestamp is NOT refreshed by repeats')
  assert.equal(stillArmed.cancelHint, true)
  assert.equal(didDoubleEscFire(armed, stillArmed, 1000 + ESC_REPEAT_GUARD_MS - 10), false)
})

test('advanceDoubleEsc: a deliberate second press past the guard gap fires within the window', () => {
  const s0 = initialState(singleQuestion())
  const armed = advanceDoubleEsc(s0, 1000)
  const fired = advanceDoubleEsc(armed, 1000 + ESC_REPEAT_GUARD_MS)
  assert.equal(fired.lastEscAt, null)
  assert.equal(fired.cancelHint, false)
  assert.equal(didDoubleEscFire(armed, fired, 1000 + ESC_REPEAT_GUARD_MS), true)
})

test('advanceDoubleEsc: repeat guard does not block re-arming after the window lapses', () => {
  const s0 = initialState(singleQuestion())
  const armed = advanceDoubleEsc(s0, 1000)
  const rearmed = advanceDoubleEsc(armed, 1000 + DOUBLE_ESC_WINDOW_MS + 1)
  assert.equal(rearmed.lastEscAt, 1000 + DOUBLE_ESC_WINDOW_MS + 1)
  assert.equal(rearmed.cancelHint, true)
})

// --------------------------------------------------- fast-path / confirm row --

test('canAutoSubmit: only a lone single-select fully-answered state auto-submits', () => {
  const single = singleQuestion()
  assert.equal(canAutoSubmit(initialState(single)), false, 'unanswered')
  assert.equal(canAutoSubmit(toggleOption(initialState(single), 0, 'yes')), true, 'answered single-select')
  const twoAnswered = toggleOption(toggleOption(initialState(baseQuestions()), 0, 'apple'), 1, 'car')
  assert.equal(canAutoSubmit(twoAnswered), false, 'multi-question never auto-submits')
})

test('canAutoSubmit: a lone multiSelect question never auto-submits', () => {
  const multi = [{ id: 'q1', question: 'Tags?', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true }]
  assert.equal(canAutoSubmit(toggleOption(initialState(multi), 0, 'a')), false)
  assert.equal(canAutoSubmit(toggleOption(toggleOption(initialState(multi), 0, 'a'), 0, 'b')), false)
})

test('needsConfirmRow: multi questions and any multiSelect question need one', () => {
  assert.equal(needsConfirmRow(baseQuestions()), true, 'two questions')
  const multiSingle = [{ id: 'q1', question: 'Tags?', options: [{ label: 'a' }], multiSelect: true }]
  assert.equal(needsConfirmRow(multiSingle), true, 'lone multiSelect')
  assert.equal(needsConfirmRow(singleQuestion()), false, 'lone single-select')
  assert.equal(needsConfirmRow([]), false)
})

test('buildRowList: a lone multiSelect question gets a confirm row (submit path)', () => {
  const multi = [{ id: 'q1', question: 'Tags?', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true }]
  const rows = buildRowList(multi, initialState(multi).perQuestion)
  assert.equal(rows[rows.length - 1]?.kind, 'confirm', 'confirm row exists so multiSelect can submit')
})

// ------------------------------------------------------- cursor hop helper --

test('nextUnansweredRow: hops to the first selectable row of the next unanswered question', () => {
  const qs = baseQuestions()
  const rows = buildRowList(qs, initialState(qs).perQuestion)
  // After answering Q0, first selectable row belonging to an unanswered later question = Q1 option-0 (index 5).
  assert.equal(nextUnansweredRow(rows, initialState(qs).perQuestion, 0), 5)
})

test('nextUnansweredRow: returns -1 when every later question is already answered', () => {
  const qs = baseQuestions()
  const perQuestion = toggleOption(toggleOption(initialState(qs), 0, 'apple'), 1, 'car').perQuestion
  const rows = buildRowList(qs, perQuestion)
  assert.equal(nextUnansweredRow(rows, perQuestion, 0), -1)
  assert.equal(nextUnansweredRow(rows, perQuestion, 1), -1)
})

// ------------------------------------------------------ upstream detail field --

test('renderQuestionsView: upstream detail renders muted under its question header', () => {
  const withDetail = [{
    id: 'plan', header: 'Plan', question: 'Approve this plan?',
    detail: 'Step 1: deploy. Step 2: verify.',
    options: [{ label: 'approve' }, { label: 'decline' }],
    intent: { kind: 'plan-review', approve: 'approve' },
  }]
  const lines = renderQuestionsView(theme, initialState(withDetail), 80)
  assert.ok(lines.some(line => stripAnsi(line).includes('Step 1: deploy')), 'detail text is rendered')
})

// ------------------------------------------------------------ attention hint --

test('renderQuestionsView / renderReviewView surface the transient attention hint', () => {
  const qState = { ...initialState(baseQuestions()), attentionHint: INCOMPLETE_HINT }
  assert.ok(renderQuestionsView(theme, qState, 60).some(l => stripAnsi(l).includes(INCOMPLETE_HINT)))
  const rState = { ...toggleOption(initialState(baseQuestions()), 0, 'apple'), reviewIndex: 1, attentionHint: INCOMPLETE_HINT }
  assert.ok(renderReviewView(theme, rState, 60).some(l => stripAnsi(l).includes(INCOMPLETE_HINT)))
})

// --------------------------------------------- interaction layer (fake TUI) --

/** Fake TUI harness: captures the framed overlay component and its hide handle. */
function makeHarness(clockTimes = []) {
  const calls = { overlays: [], hides: 0, restoreFocus: 0 }
  const deps = {
    tui: {
      showOverlay(component) {
        const handle = { component, hide() { calls.hides += 1 } }
        calls.overlays.push(handle)
        return handle
      },
    },
    theme: () => ({ palette: githubLight }),
    restoreFocus: () => { calls.restoreFocus += 1 },
    now: () => clockTimes.shift() ?? 0,
  }
  return { deps, calls }
}

const trackResolution = promise => {
  const state = { resolved: false, value: undefined }
  promise.then(v => { state.resolved = true; state.value = v })
  return state
}

/** The currently cursor-marked (▸) row label in the questions view. */
function cursorLine(handle) {
  const lines = handle.component.render(80).map(l => stripAnsi(l))
  return lines.find(l => l.includes('▸'))
}

/** Press `key` until the marked row's label contains `label` (the two-pass nav scan wraps/skips rows). */
function pressUntil(handle, label, key = '\x1b[B', maxSteps = 16) {
  for (let i = 0; i < maxSteps; i++) {
    const line = cursorLine(handle)
    if (line !== undefined && line.includes(label)) return
    handle.component.handleInput(key)
  }
  throw new Error(`cursor never reached ${JSON.stringify(label)}`)
}

/** Same, but targets the `nth` row whose label matches (sentinel labels repeat per question). */
function pressUntilNth(handle, label, nth, key = '\x1b[B', maxSteps = 16) {
  let seen = 0
  for (let i = 0; i < maxSteps; i++) {
    const line = cursorLine(handle)
    if (line !== undefined && line.includes(label)) {
      seen += 1
      if (seen === nth) return
    }
    handle.component.handleInput(key)
  }
  throw new Error(`cursor never reached ${JSON.stringify(label)} #${nth}`)
}

test('openAskUserPanel: single-question option Enter fast-path submits the answer envelope', async () => {
  const { deps, calls } = makeHarness()
  const result = openAskUserPanel(deps, singleQuestion())
  const tracked = trackResolution(result)
  const overlay = calls.overlays[0]
  overlay.component.handleInput('\x1b[B') // down → an option row
  overlay.component.handleInput('\r') // Enter on 'no' → auto-submit
  await result
  assert.equal(tracked.resolved, true)
  assert.deepEqual(tracked.value.answers, [{ id: 'q1', selected: ['no'] }])
  assert.equal(calls.hides, 1)
  assert.equal(calls.restoreFocus, 1)
})

test('openAskUserPanel: lone multiSelect question does NOT auto-submit; routes through Confirm → Submit', async () => {
  const multi = [{ id: 'q1', question: 'Tags?', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multiSelect: true }]
  const { deps, calls } = makeHarness()
  const result = openAskUserPanel(deps, multi)
  const tracked = trackResolution(result)
  const handle = calls.overlays[0]
  const input = handle.component.handleInput.bind(handle.component)
  pressUntil(handle, 'b'); input('\r') // select 'b'
  pressUntil(handle, 'c'); input('\r') // add 'c'
  assert.equal(tracked.resolved, false, 'multiSelect toggles never auto-submit')
  pressUntil(handle, 'Confirm answers'); input('\r') // confirm → review page
  for (let i = 0; i < 8 && !(cursorLine(handle)?.includes('Submit answers')); i++) input('\x1b[B')
  assert.ok(cursorLine(handle).includes('Submit answers'))
  input('\r') // submit
  await result
  assert.equal(tracked.resolved, true)
  assert.deepEqual(tracked.value.answers, [{ id: 'q1', selected: ['b', 'c'] }])
})

test('openAskUserPanel: single question answered ONLY by typed custom text submits (deadlock fix B1)', async () => {
  const noOptions = [{ id: 'q1', question: 'What is your deployment name?' }] // options are optional upstream
  const { deps, calls } = makeHarness()
  const result = openAskUserPanel(deps, noOptions)
  const tracked = trackResolution(result)
  const input = calls.overlays[0].component.handleInput.bind(calls.overlays[0].component)
  input('\x1b[B') // down → sentinel row
  input('\r') // Enter → inline edit
  input('h'); input('i') // type free text
  input('\r') // commit → fast-path submit
  await result
  assert.equal(tracked.resolved, true)
  assert.deepEqual(tracked.value.answers, [{ id: 'q1', selected: [], custom: 'hi' }])
  assert.equal(calls.hides, 1)
  assert.equal(calls.restoreFocus, 1)
})

test('openAskUserPanel: committing a sentinel edit in a multi-question layout hops to the next unanswered question', async () => {
  const { deps, calls } = makeHarness()
  const result = openAskUserPanel(deps, baseQuestions())
  const tracked = trackResolution(result)
  const handle = calls.overlays[0]
  const input = handle.component.handleInput.bind(handle.component)
  pressUntilNth(handle, SENTINEL_LABEL, 2) // Q0's sentinel (the ↓ cycle reaches Q1's first)
  input('\r') // inline edit
  for (const ch of 'fruit') input(ch)
  input('\r') // commit → cursor hops to the next unanswered question (Q1 option-0)
  assert.ok(cursorLine(handle).includes('car'), `expected cursor on Q1 option-0, got: ${cursorLine(handle)}`)
  input('\r') // select 'car'
  assert.equal(tracked.resolved, false, 'multi-question waits for the review step')
  pressUntil(handle, 'Confirm answers', '\x1b[A'); input('\r') // confirm → review
  for (let i = 0; i < 8 && !(cursorLine(handle)?.includes('Submit answers')); i++) input('\x1b[B')
  input('\r') // Submit answers
  await result
  assert.deepEqual(tracked.value.answers, [
    { id: 'q1', selected: [], custom: 'fruit' },
    { id: 'q2', selected: ['car'] },
  ])
})

test('openAskUserPanel: double-Esc decline fires; external overlay.hide afterwards is idempotent', async () => {
  const { deps, calls } = makeHarness([1000, 1050])
  const result = openAskUserPanel(deps, baseQuestions())
  const tracked = trackResolution(result)
  const handle = calls.overlays[0]
  handle.component.handleInput('\x1b')
  handle.component.handleInput('\x1b')
  await result
  assert.equal(tracked.resolved, true)
  assert.deepEqual(tracked.value, buildDeclinedEnvelope(baseQuestions()))
  assert.equal(calls.restoreFocus, 1)
  // External close after settle must not re-resolve or re-focus.
  handle.hide()
  handle.hide()
  assert.equal(calls.restoreFocus, 1)
})

test('openAskUserPanel: held-Esc auto-repeat does not fire the decline; a deliberate second press does', async () => {
  // t=1000 arm · t=1030 repeat (ignored) · t=1060 deliberate fire.
  const repeatHarness = makeHarness([1000, 1030, 1060])
  const resultRepeat = openAskUserPanel(repeatHarness.deps, singleQuestion())
  const trackedRepeat = trackResolution(resultRepeat)
  const comp = repeatHarness.calls.overlays[0].component
  comp.handleInput('\x1b')
  comp.handleInput('\x1b')
  assert.equal(trackedRepeat.resolved, false, 'auto-repeat burst must not decline')
  comp.handleInput('\x1b')
  await resultRepeat
  assert.equal(trackedRepeat.resolved, true)
  assert.deepEqual(trackedRepeat.value, buildDeclinedEnvelope(singleQuestion()))
})

test('openAskUserPanel: abort signal closes the overlay and settles declined', async () => {
  const { deps, calls } = makeHarness()
  const controller = new AbortController()
  const result = openAskUserPanel(deps, baseQuestions(), controller.signal)
  const tracked = trackResolution(result)
  controller.abort()
  await result
  assert.equal(tracked.resolved, true)
  assert.deepEqual(tracked.value, buildDeclinedEnvelope(baseQuestions()))
  assert.equal(calls.hides, 1, 'overlay was hidden')
  assert.equal(calls.restoreFocus, 1)
})

test('openAskUserPanel: pre-aborted signal declines without ever opening an overlay', async () => {
  const { deps, calls } = makeHarness()
  const controller = new AbortController()
  controller.abort()
  const result = await openAskUserPanel(deps, baseQuestions(), controller.signal)
  assert.deepEqual(result, buildDeclinedEnvelope(baseQuestions()))
  assert.equal(calls.overlays.length, 0)
})

// ------------------------------------------- provider registration semantics --

test('registerAskUserProvider: happy path registers, forwards ask(), and passes the disposer through', async () => {
  let registered
  let disposed = 0
  const ctx = { userQuestions: { registerProvider(provider) { registered = provider; return () => { disposed += 1 } } } }
  const { deps, calls } = makeHarness()
  const disposer = registerAskUserProvider(ctx, deps)
  assert.equal(typeof registered.ask, 'function')
  const result = registered.ask({ questions: singleQuestion(), signal: undefined })
  const tracked = trackResolution(result)
  calls.overlays[0].hide() // external close → declined envelope
  await result
  assert.deepEqual(tracked.value, buildDeclinedEnvelope(singleQuestion()))
  disposer()
  assert.equal(disposed, 1)
})

test('registerAskUserProvider: DUPLICATE_PROVIDER yields ownership silently (no-op disposer)', () => {
  const ctx = { userQuestions: { registerProvider() { throw new UserQuestionError('a user-questions provider is already registered', 'DUPLICATE_PROVIDER') } } }
  const warnings = captureWarnings(() => {
    const disposer = registerAskUserProvider(ctx, makeHarness().deps)
    assert.equal(typeof disposer, 'function')
    disposer() // must be safe to call
  })
  assert.deepEqual(warnings, [])
})

test('registerAskUserProvider: unexpected registration failures are NOT swallowed', () => {
  const ctx = { userQuestions: { registerProvider() { throw new TypeError('boom') } } }
  assert.throws(() => registerAskUserProvider(ctx, makeHarness().deps), /boom/)
})

test('registerAskUserProvider: missing userQuestions service warns and degrades instead of crashing', () => {
  const warnings = captureWarnings(() => {
    const disposer = registerAskUserProvider({}, makeHarness().deps)
    assert.equal(typeof disposer, 'function')
    disposer()
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /userQuestions/)
})

function captureWarnings(fn) {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  try {
    fn()
  } finally {
    console.warn = original
  }
  return warnings
}

// ------------------------------------------- duplicate-error classifier (pure) --

test('isDuplicateProviderError: matches only UserQuestionError with code DUPLICATE_PROVIDER', () => {
  assert.equal(isDuplicateProviderError(new UserQuestionError('already registered', 'DUPLICATE_PROVIDER')), true)
  assert.equal(isDuplicateProviderError(new UserQuestionError('aborted', 'ASK_ABORTED')), false)
  assert.equal(isDuplicateProviderError(new TypeError('boom')), false)
  assert.equal(isDuplicateProviderError('DUPLICATE_PROVIDER'), false)
  assert.equal(isDuplicateProviderError(undefined), false)
})
