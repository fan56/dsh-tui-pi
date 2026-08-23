/**
 * Ask-user-question: the pure-logic layer (state, envelope, decline,
 * double-Esc state machine, row layout) of `src/ask-user.ts`. The
 * provider/overlay layer is exercised through tui-driven smoke tests in
 * `test/ask-user-overlay.test.mjs` (TODO: that file lands in the next
 * round when we can drive a real TUI without a pty fixture).
 *
 * Pure functions only — no TTY, no TUI dependencies. Runs against the built
 * lib/ (pretest builds).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceDoubleEsc,
  allQuestionsAnswered,
  buildAnswerEnvelope,
  buildDeclinedEnvelope,
  buildRowList,
  DECLINE_MESSAGE,
  didDoubleEscFire,
  DOUBLE_ESC_WINDOW_MS,
  enterCustomEdit,
  exitCustomEdit,
  initialState,
  nextSelectableIndex,
  patchCustomInput,
  renderQuestionsView,
  renderReviewView,
  setCustomAnswer,
  SENTINEL_LABEL,
  toggleOption,
} from '../lib/ask-user.js'
import { githubLight } from '../lib/theme/palette.js'

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
