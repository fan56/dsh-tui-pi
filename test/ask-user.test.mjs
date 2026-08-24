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
  askUserMaxVisibleForRows,
  buildAnswerEnvelope,
  buildDeclinedEnvelope,
  buildRowList,
  canAutoSubmit,
  clampScrollWindow,
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
  rowIndexForNumber,
  rowNumber,
  setCustomAnswer,
  SENTINEL_LABEL,
  toggleOption,
} from '../lib/ask-user.js'
import { githubLight } from '../lib/theme/palette.js'
import { visibleWidth } from '../lib/text.js'
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
  // Snapped onto the first SELECTABLE row (index 0 is the unselectable header),
  // so the ▸ marker is visible before any keypress.
  assert.equal(state.cursorIndex, 1)
  const rows = buildRowList(baseQuestions(), state.perQuestion)
  assert.equal(rows[state.cursorIndex]?.selectable, true)
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
  // Wide window (20 body lines) — every row fits; the capped-window behavior
  // has its own dedicated tests below.
  const lines = renderQuestionsView(theme, state, 60, 20)
  // Title + 3 booktabs rows + 2 headers + 4 option rows + 2 sentinel + confirm
  // group = body lines + possible status line + footer.
  const title = stripAnsi(lines[0])
  assert.equal(title, '● Questions (2)')
  // The booktabs header row + the body lines all live below the title.
  assert.ok(lines.find(line => stripAnsi(line).includes('SELECTION')))
  assert.equal(lines.find(line => stripAnsi(line).includes('STATE')), undefined, 'the dedicated State column is gone')
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

test('renderQuestionsView: selection state is marked INLINE before the option text (no State column)', () => {
  const state = toggleOption(initialState(singleQuestion()), 0, 'yes')
  const lines = renderQuestionsView(theme, state, 50, 20).map(stripAnsi)
  const selectedLine = lines.find(line => line.includes('yes'))
  assert.ok(selectedLine !== undefined)
  assert.ok(selectedLine.includes('● 1. yes'), `single-select shows ● inline before the text, got: ${selectedLine}`)
  assert.ok(!selectedLine.includes('│'), 'no column separator — selection lives inside the label column')
  const unselectedLine = lines.find(line => line.includes('no'))
  assert.ok(unselectedLine !== undefined && unselectedLine.includes('○ 2. no'), 'unselected options carry the hollow ○ mark for alignment')
})

test('renderQuestionsView: the confirm row sits in its own block, separated from the questions by a blank line', () => {
  const lines = renderQuestionsView(theme, initialState(baseQuestions()), 60, 20).map(stripAnsi)
  const confirmIdx = lines.findIndex(l => l.includes('Confirm answers'))
  assert.ok(confirmIdx > 0)
  assert.equal(lines[confirmIdx - 1], '', 'a blank line separates the confirm row from the question blocks above')
})

test('renderQuestionsView: a completed overlay shows ✓ in the confirm row state slot', () => {
  const state = toggleOption(toggleOption(initialState(baseQuestions()), 0, 'apple'), 1, 'car')
  const lines = renderQuestionsView(theme, state, 60, 20).map(stripAnsi)
  const confirmLine = lines.find(l => l.includes('Confirm answers'))
  assert.ok(confirmLine !== undefined && confirmLine.includes('✓'), 'ready state marked inline on the confirm row')
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

// --------------------------------------------- scroll window + numbering --

test('clampScrollWindow: keeps the cursor inside the window and slides minimally', () => {
  assert.equal(clampScrollWindow(0, 5, 20, 0), 0)
  assert.equal(clampScrollWindow(4, 5, 20, 0), 0, 'cursor on the bottom edge stays')
  assert.equal(clampScrollWindow(5, 5, 20, 0), 1, 'cursor past the bottom edge slides the window by one')
  assert.equal(clampScrollWindow(3, 5, 20, 4), 3, 'cursor above the top edge jumps the window to it')
  assert.equal(clampScrollWindow(2, 5, 4, 0), 0, 'no overflow → offset pinned to 0')
  assert.equal(clampScrollWindow(9, 5, 0, 0), 0, 'empty body pins to 0')
})

test('rowNumber / rowIndexForNumber: per-question numbering with sentinel continuation', () => {
  const qs = baseQuestions()
  const rows = buildRowList(qs, initialState(qs).perQuestion)
  // rows: 0 header Q0 · 1 apple · 2 banana · 3 sentinel Q0 · 4 header Q1
  //       5 car · 6 bike · 7 sentinel Q1 · 8 confirm
  assert.equal(rowNumber(rows, 0), null, 'header rows are unnumbered')
  assert.equal(rowNumber(rows, 1), 1)
  assert.equal(rowNumber(rows, 2), 2)
  assert.equal(rowNumber(rows, 3), 3, 'sentinel continues after its question\'s options')
  assert.equal(rowNumber(rows, 5), 1, 'numbering restarts per question')
  assert.equal(rowNumber(rows, 8), null, 'confirm keeps its fixed ⏎ symbol instead of a number')
  assert.equal(rowIndexForNumber(rows, 0, 3), 3, 'digit 3 targets the sentinel')
  assert.equal(rowIndexForNumber(rows, 0, 4), -1, 'out-of-range digits map to nothing')
  assert.equal(rowIndexForNumber(rows, 1, 2), 6, 'targets stay inside their question')
})

test('renderQuestionsView: numbered prefixes + ▸ cursor marker on selectable rows', () => {
  const lines = renderQuestionsView(theme, initialState(singleQuestion()), 50, 20).map(stripAnsi)
  const cursor = lines.find(l => l.includes('▸'))
  assert.ok(cursor !== undefined && cursor.startsWith('▸ ○ 1. yes'), `selected row numbered under the marker, got: ${cursor}`)
  assert.ok(lines.some(l => l.startsWith('  ○ 2. no')), 'unselected rows keep a blank marker slot and hollow mark before their number')
  assert.ok(lines.some(l => l.includes('3. Type something.')), 'sentinel participates in per-question numbering')
})

test('renderQuestionsView: a muted ─ divider separates each question from its options', () => {
  const lines = renderQuestionsView(theme, initialState(baseQuestions()), 60, 20).map(stripAnsi)
  assert.ok(lines.filter(l => /^─+$/.test(l)).length >= 2, 'one divider per question block')
  const headerIdx = lines.findIndex(l => l.includes('Fruit'))
  const dividerIdx = lines.findIndex(l => /^─+$/.test(l))
  const optionIdx = lines.findIndex(l => l.includes('apple'))
  assert.ok(headerIdx !== -1 && headerIdx < dividerIdx && dividerIdx < optionIdx, 'divider sits between header and options')
})

test('renderQuestionsView: option description renders as its own line below the label', () => {
  const lines = renderQuestionsView(theme, initialState(baseQuestions()), 60, 20).map(stripAnsi)
  const appleIdx = lines.findIndex(l => l.includes('○ 1. apple'))
  assert.ok(appleIdx >= 0)
  assert.ok(!lines[appleIdx].includes('red and round'), 'description no longer concatenated into the label cell')
  assert.ok(lines[appleIdx + 1]?.includes('red and round'), 'description gets its own indented muted line')
})

test('renderQuestionsView: labels fold newlines into spaces (single rendered line)', () => {
  const qs = [{ id: 'q1', question: 'Pick', header: 'H', options: [{ label: 'two\nlines' }] }]
  const lines = renderQuestionsView(theme, initialState(qs), 60, 20).map(stripAnsi)
  assert.equal(lines.filter(l => l.includes('two')).length, 1, 'no second rendered row from an embedded newline')
  assert.ok(lines.some(l => l.includes('○ 1. two lines')), 'newline folded to a space inside one cell')
})

test('renderQuestionsView: height-capped window clips the body but keeps the cursor visible', () => {
  const state = initialState(baseQuestions()) // 14 rendered body lines at width 60 (incl. confirm blank separator)
  const lines = renderQuestionsView(theme, state, 60, 5).map(stripAnsi)
  assert.ok(lines.some(l => l.includes('▸') && l.includes('apple')), 'the cursor row is always inside the window')
  assert.equal(lines.some(l => l.includes('Confirm answers')), false, 'tail content beyond the window is clipped')
  // title + 3 table chrome rules + 5 body + bottom rule + blank + footer.
  assert.ok(lines.length <= 12, `output bounded by the window, got ${lines.length} lines`)
  assert.match(lines[lines.length - 1], /\(1\/7\)/, 'footer gains the (n/m) readout over selectable rows while overflowing')
})

test('renderQuestionsView: no overflow → footer carries no (n/m) readout', () => {
  const lines = renderQuestionsView(theme, initialState(singleQuestion()), 60, 20).map(stripAnsi)
  const footer = lines.find(l => l.includes('navigate'))
  assert.ok(footer !== undefined, 'sanity: footer line present')
  assert.doesNotMatch(footer, /\(\d+\/\d+\)/, 'the position readout only appears while the body overflows')
})

test('renderQuestionsView: scrolling follows the cursor and survives wrap-around', () => {
  const qs = [
    { id: 'q1', question: 'Q1', header: 'A', options: [{ label: 'a1' }, { label: 'a2' }, { label: 'a3' }] },
    { id: 'q2', question: 'Q2', header: 'B', options: [{ label: 'b1' }, { label: 'b2' }, { label: 'b3' }] },
    { id: 'q3', question: 'Q3', header: 'C', options: [{ label: 'c1' }, { label: 'c2' }, { label: 'c3' }] },
  ]
  let state = initialState(qs) // 13 selectable rows (12 numbered + confirm), 19 body lines
  const stepDown = () => {
    state = { ...state, cursorIndex: nextSelectableIndex(buildRowList(state.questions, state.perQuestion), state.cursorIndex, 1) }
  }
  for (let i = 0; i < 12; i++) stepDown() // first selectable → last selectable (confirm)
  let lines = renderQuestionsView(theme, state, 60, 6).map(stripAnsi)
  assert.ok(lines.some(l => l.includes('▸') && l.includes('Confirm answers')), 'window follows the cursor to the tail')
  assert.equal(lines.some(l => l.includes('A  Q1')), false, 'head content scrolled out of the window')
  stepDown() // wrap past the last row back to the first option
  lines = renderQuestionsView(theme, state, 60, 6).map(stripAnsi)
  assert.ok(lines.some(l => l.includes('▸ ○ 1. a1')), 'wrap-around lands back on a visible head row')
})

test("renderQuestionsView: the scroll anchor is the cursor row's LAST rendered line, so wrapped continuations stay visible", () => {
  // The third option's label word-wraps into several rendered lines; when the
  // clamp slides the window, anchoring the FIRST line left every continuation
  // below the cut (blind keypresses). Anchoring the last line keeps the whole
  // logical block inside the window whenever it fits.
  const qs = [{
    id: 'q1', question: 'Pick one', header: 'Wrap',
    options: [
      { label: 'aa' },
      { label: 'bb' },
      { label: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu' },
    ],
  }]
  const state = { ...initialState(qs), cursorIndex: 3 } // the wrapping option row
  const slice = renderQuestionsView(theme, state, 60, 5).map(stripAnsi)
  const joined = slice.join('\n')
  for (const word of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu']) {
    assert.ok(joined.includes(word), `wrapped continuation "${word}" must stay inside the scroll window`)
  }
  assert.ok(slice.some(l => l.includes('▸') && l.includes('alpha')), 'the cursor row itself is still in the window')
})

test('renderQuestionsView: exact-fit boundary — body == visible shows every line with NO scroll readout', () => {
  // Locks the boundary the confirm-blank-line separator shifted: when the body
  // exactly fills the window, nothing may be clipped and the (n/m) footer
  // readout must stay absent (overflow is strictly body.length > visible).
  const full = renderQuestionsView(theme, initialState(baseQuestions()), 60, 500).map(stripAnsi)
  // Single flex column → the table rules render as plain dash runs with no
  // ┬/┼/┴ junctions; anchor on the SELECTION header block and the footer.
  const bodyStart = full.findIndex(l => l.includes('SELECTION')) + 2
  const bodyEnd = full.findIndex(l => l.includes('navigate')) - 2 // blank + footer below the bottom rule
  const bodyCount = bodyEnd - bodyStart
  assert.ok(bodyCount > 0, 'sanity: body lines found between the table rules')
  const exact = renderQuestionsView(theme, initialState(baseQuestions()), 60, bodyCount).map(stripAnsi)
  const exactStart = exact.findIndex(l => l.includes('SELECTION')) + 2
  const exactEnd = exact.findIndex(l => l.includes('navigate')) - 2
  assert.deepEqual(exact.slice(exactStart, exactEnd), full.slice(bodyStart, bodyEnd),
    'an exactly-fitting window renders the complete body unclipped')
  assert.ok(exact.slice(exactStart, exactEnd).some(l => l.includes('Confirm answers')),
    'the confirm row is NOT pushed out of an exactly-fitting window')
  const footer = exact.find(l => l.includes('navigate'))
  assert.doesNotMatch(footer, /\(\d+\/\d+\)/, 'exact fit is not overflow — no position readout')
})

test('renderReviewView: capped window keeps the review cursor and submit row reachable', () => {
  const qs = baseQuestions()
  // reviewIndex 1 = the second question's row; 2 body rows fit a 2-line window.
  const state = { ...toggleOption(toggleOption(initialState(qs), 0, 'apple'), 1, 'car'), phase: 'review', reviewIndex: 1 }
  const lines = renderReviewView(theme, state, 60, 2).map(stripAnsi)
  assert.ok(lines.some(l => l.includes('▸') && l.includes('Vehicle')), 'reviewed cursor row inside the window')
  assert.match(lines[lines.length - 1], /\(2\/3\)/, 'review footer shows the position readout when overflowing')
})

// --------------------------------------------- interaction layer (fake TUI) --

/** Fake TUI harness: captures the DOCK-MOUNTED panel component and its unmount. */
function makeHarness(clockTimes = []) {
  const calls = { overlays: [], hides: 0, restoreFocus: 0, modal: [], focus: [], hideOverlayCalls: 0 }
  const deps = {
    tui: {
      hideOverlay() { calls.hideOverlayCalls += 1 },
      setFocus(component) { calls.focus.push(component) },
    },
    theme: () => ({ palette: githubLight }),
    restoreFocus: () => { calls.restoreFocus += 1 },
    mount(component) {
      const handle = {
        component,
        hide() {
          calls.hides += 1
          const index = calls.overlays.indexOf(handle)
          if (index >= 0) calls.overlays.splice(index, 1)
        },
      }
      calls.overlays.push(handle)
      return () => handle.hide()
    },
    setModalActive(active) { calls.modal.push(active) },
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
  pressUntilNth(handle, SENTINEL_LABEL, 1) // Q0's sentinel (navigation steps one row at a time)
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

test('openAskUserPanel: digit quick-pick selects the numbered option directly', async () => {
  const { deps, calls } = makeHarness()
  const result = openAskUserPanel(deps, singleQuestion())
  const tracked = trackResolution(result)
  calls.overlays[0].component.handleInput('2') // pick option 2 ('no') without arrows
  await result
  assert.equal(tracked.resolved, true)
  assert.deepEqual(tracked.value.answers, [{ id: 'q1', selected: ['no'] }])
  assert.equal(calls.restoreFocus, 1)
})

test('openAskUserPanel: ↑↓ while editing exits the editor (committing) and then navigates', () => {
  const { deps, calls } = makeHarness()
  openAskUserPanel(deps, baseQuestions())
  const handle = calls.overlays[0]
  const input = handle.component.handleInput.bind(handle.component)
  pressUntilNth(handle, SENTINEL_LABEL, 1) // Q0 sentinel
  input('\r') // inline edit
  input('h'); input('i')
  input('\x1b[B') // ↓ must NOT be swallowed: exit edit (commit 'hi'), then move
  assert.ok(cursorLine(handle).includes('car'), 'cursor moved off the sentinel')
  const lines = handle.component.render(80).map(stripAnsi)
  assert.ok(lines.some(l => l.includes('✎ hi')), 'buffer committed on arrow-exit')
  assert.ok(!lines.some(l => l.includes('_')), 'no editing cursor left behind')
})

test('openAskUserPanel: down-navigation wraps and the window follows with scroll info', () => {
  const qs = [
    { id: 'q1', question: 'Q1', header: 'A', options: [{ label: 'a1' }, { label: 'a2' }, { label: 'a3' }] },
    { id: 'q2', question: 'Q2', header: 'B', options: [{ label: 'b1' }, { label: 'b2' }, { label: 'b3' }] },
    { id: 'q3', question: 'Q3', header: 'C', options: [{ label: 'c1' }, { label: 'c2' }, { label: 'c3' }] },
  ]
  const { deps, calls } = makeHarness()
  openAskUserPanel(deps, qs)
  const handle = calls.overlays[0]
  pressUntil(handle, 'Confirm answers') // walk to the last selectable row
  const tailLines = handle.component.render(80).map(stripAnsi)
  assert.ok(tailLines.some(l => l.includes('▸') && l.includes('Confirm answers')))
  handle.component.handleInput('\x1b[B') // wrap past the end
  assert.ok(cursorLine(handle)?.includes('a1'), 'wrapped cursor lands back on a visible head row')
  // The framed overlay wraps the panel, so the footer is found by content,
  // not position.
  const footer = handle.component.render(80).map(stripAnsi).find(l => l.includes('navigate'))
  assert.match(footer ?? '', /\(1\/13\)/, '(n/m) readout counts selectable rows only (12 numbered + confirm; headers excluded)')
})

test('openAskUserPanel: digit jump onto an out-of-window sentinel keeps the edit line visible (M1)', async () => {
  // 8 options → body = header text + divider + 8 options + sentinel = 11 lines,
  // over the default 9-line window; the sentinel starts below the fold.
  const many = [{
    id: 'q1', question: 'Pick one', header: 'Big',
    options: Array.from({ length: 8 }, (_, i) => ({ label: `opt${i + 1}` })),
  }]
  const { deps, calls } = makeHarness()
  openAskUserPanel(deps, many)
  const handle = calls.overlays[0]
  const input = handle.component.handleInput.bind(handle.component)
  assert.equal(
    handle.component.render(80).map(stripAnsi).some(l => l.includes('_')),
    false,
    'sanity: no inline-edit line before the jump',
  )
  input('9') // quick-pick the sentinel (numbered N+1 = 9 after the 8 options)
  const lines = handle.component.render(80).map(stripAnsi)
  assert.ok(lines.some(l => l.includes('_')), 'the inline-edit line is rendered inside the window')
  // Footer readout agrees with the viewport: the edited sentinel is the 9th
  // selectable row of 9 (headers never counted).
  const footer = lines.find(l => l.includes('abandon edit'))
  assert.ok(footer !== undefined, 'editing footer present')
  assert.match(footer, /\(9\/9\)/, 'readout ranks the edited sentinel among global selectable rows')
})

test('openAskUserPanel: digit presses are a no-op in the review phase', async () => {
  const { deps, calls } = makeHarness()
  const result = openAskUserPanel(deps, baseQuestions())
  const tracked = trackResolution(result)
  const handle = calls.overlays[0]
  const input = handle.component.handleInput.bind(handle.component)
  input('1') // quick-pick Q0 option 1 (apple)
  pressUntil(handle, 'car') // walk into Q1
  input('1') // quick-pick Q1 option 1 (car)
  pressUntil(handle, 'Confirm answers')
  input('\r') // → review phase
  const before = handle.component.render(80).map(stripAnsi)
  assert.ok(before.some(l => l.includes('Review answers')), 'sanity: reached the review page')
  input('2') // digit while reviewing must do nothing
  assert.deepEqual(handle.component.render(80).map(stripAnsi), before, 'review view unchanged by a digit press')
  assert.equal(tracked.resolved, false, 'no accidental submit or phase flip')
})

test('openAskUserPanel: double-Esc decline fires; a late extra unmount afterwards is idempotent', async () => {
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
  const controller = new AbortController()
  const result = registered.ask({ questions: singleQuestion(), signal: controller.signal })
  const tracked = trackResolution(result)
  controller.abort() // abort → close → declined envelope
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

// ------------------------------------- terminal-height-adaptive scroll window --

test('askUserMaxVisibleForRows: the dock budget subtracts editor/footer/transcript from the terminal', () => {
  // Dock stacking: 24 rows − 8 reserved (editor 3 + footer 1 + status 1 +
  // transcript floor 3) − 10 panel chrome = 6 — the 24-row e2e floor.
  assert.equal(askUserMaxVisibleForRows(24), 6)
  assert.equal(askUserMaxVisibleForRows(40), 22, '40 − 18 = 22')
  assert.equal(askUserMaxVisibleForRows(100), 82, 'big terminals grow proportionally')
})

test('askUserMaxVisibleForRows: unknown terminal height falls back to ASK_USER_MAX_VISIBLE', () => {
  assert.equal(askUserMaxVisibleForRows(undefined), 6)
  assert.equal(askUserMaxVisibleForRows(Number.NaN), 6)
  assert.equal(askUserMaxVisibleForRows(0), 6)
  assert.equal(askUserMaxVisibleForRows(-5), 6)
})

test('renderQuestionsView: a larger maxVisible reveals body lines the default window clips', () => {
  const many = [{
    id: 'q1', question: 'Pick one', header: 'Big',
    options: Array.from({ length: 8 }, (_, i) => ({ label: `opt${i + 1}` })),
  }]
  const state = initialState(many)
  const capped = renderQuestionsView(theme, state, 80).map(stripAnsi) // default 9-line window
  const grown = renderQuestionsView(theme, state, 80, 20).map(stripAnsi)
  assert.equal(capped.some(l => l.includes('Type something.')), false, 'default window clips the tail sentinel')
  assert.equal(grown.some(l => l.includes('Type something.')), true, 'larger window shows the tail sentinel')
  assert.ok(grown.length > capped.length, `grown output has more lines (${grown.length} > ${capped.length})`)
})

test('openAskUserPanel: the panel derives its window from deps.tui.terminal.rows', () => {
  const many = [{
    id: 'q1', question: 'Pick one', header: 'Big',
    options: Array.from({ length: 8 }, (_, i) => ({ label: `opt${i + 1}` })),
  }]
  const calls = { overlays: [] }
  const deps = {
    tui: {
      terminal: { rows: 60 }, // 60 − 18 = 42 ≥ the 11-line body
      hideOverlay() {},
      setFocus() {},
    },
    theme: () => ({ palette: githubLight }),
    restoreFocus: () => {},
    mount(component) {
      const handle = { component, hide() {} }
      calls.overlays.push(handle)
      return () => {}
    },
    setModalActive() {},
  }
  openAskUserPanel(deps, many)
  const lines = calls.overlays[0].component.render(80).map(stripAnsi)
  assert.equal(
    lines.some(l => l.includes('Type something.')),
    true,
    'a tall terminal shows the whole body with no scrolling (old constant would clip it)',
  )
})

// ------------------------------------------------- review answer-cell folding --

test('renderReviewView: an answer containing \\n is folded — no bare newline breaks a row', () => {
  const qs = [{ id: 'q1', question: 'Pick', header: 'H', options: [{ label: 'two\nlines' }, { label: 'other' }] }]
  const state = toggleOption(initialState(qs), 0, 'two\nlines')
  const width = 60
  const lines = renderReviewView(theme, state, width).map(stripAnsi)
  assert.ok(lines.every(l => !l.includes('\n')), 'no rendered line carries a raw newline')
  assert.ok(lines.some(l => l.includes('two lines')), 'newline folded to a space inside the answer cell')
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `line width ${visibleWidth(line)} stays within ${width}`)
  }
})

test('renderReviewView: a multi-line custom answer folds too', () => {
  const qs = [{ id: 'q1', question: 'Why?', header: 'H', options: [{ label: 'a' }] }]
  const state = setCustomAnswer(initialState(qs), 0, 'line one\nline two')
  const lines = renderReviewView(theme, state, 60).map(stripAnsi)
  assert.ok(lines.every(l => !l.includes('\n')))
  assert.ok(lines.some(l => l.includes('✎ line one line two')), 'custom text folded onto one cell line')
})

// --------------------------------------------------- header bold + wrap order --

test('renderQuestionsView: long header text word-wraps to the pane width (never overflows)', () => {
  const longQuestion = 'x'.repeat(200)
  const qs = [{ id: 'q1', question: longQuestion, header: 'Fruit', options: [{ label: 'apple' }] }]
  const width = 40
  const wrap = width - 2
  const lines = renderQuestionsView(theme, initialState(qs), width, 30)
  const fruitLine = lines.find(l => stripAnsi(l).includes('Fruit'))
  const xLines = lines.filter(l => /^x+$/.test(stripAnsi(l).trim()))
  assert.ok(fruitLine !== undefined, 'the header prefix renders')
  assert.ok(xLines.length >= 2, `the 200-char question wraps onto multiple lines, got ${xLines.length}`)
  for (const headerLine of [fruitLine, ...xLines]) {
    assert.ok(headerLine.includes('\x1b[1m'), 'each wrapped header line keeps its BOLD span')
    const plain = stripAnsi(headerLine)
    assert.ok(visibleWidth(plain.trim()) <= wrap, `wrapped line stays within the wrap width (${wrap})`)
    assert.ok(!plain.includes('\x1b['), 'no SGR fragment leaks into the visible text')
  }
  // The whole question text survives — wrapping, not truncation.
  const totalX = xLines.reduce((sum, l) => sum + (stripAnsi(l).match(/x/g)?.length ?? 0), 0)
  assert.equal(totalX, 200, 'every character of the long question is rendered across the wrapped lines')
})

test('renderQuestionsView: a long option label wraps onto indented continuation lines', () => {
  const longLabel = 'staging-cluster-with-a-very-long-descriptive-name-that-exceeds-the-pane'
  const qs = [{ id: 'q1', question: 'Pick', header: 'H', options: [{ label: longLabel }, { label: 'short' }] }]
  const width = 40
  const lines = renderQuestionsView(theme, initialState(qs), width, 20).map(stripAnsi)
  const rowIdx = lines.findIndex(l => l.includes('○ 1.') && l.includes(longLabel.slice(0, 10)))
  assert.ok(rowIdx >= 0, 'the option row renders')
  const nextIdx = lines.findIndex((l, i) => i > rowIdx && l.includes('○ 2. short'))
  assert.ok(nextIdx > rowIdx, 'the sibling option still renders after the wrapped label')
  const block = lines.slice(rowIdx, nextIdx)
  assert.ok(block.length >= 3, `the label wraps onto several lines, got ${block.length}`)
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width - 2, `every rendered line fits the pane (width ${visibleWidth(line)})`)
  }
  // No characters lost: the row block reassembles into the original label.
  const reassembled = block
    .map((l, k) => (k === 0 ? stripAnsi(l).trim().replace(/^[▸○ ]*1\. /, '') : stripAnsi(l).trim()))
    .join('')
  assert.equal(reassembled, longLabel)
})

test('renderQuestionsView: a long option description word-wraps instead of being clipped', () => {
  const longDescription = 'Deploy to the staging cluster first, run the smoke suite, then promote to production.'
  const qs = [{ id: 'q1', question: 'Pick', header: 'H', options: [{ label: 'staging', description: longDescription }] }]
  const width = 40
  const lines = renderQuestionsView(theme, initialState(qs), width, 20).map(stripAnsi)
  // All lines between the option row and the next numbered row are the
  // wrapped description block.
  const startIdx = lines.findIndex(l => l.includes('○ 1. staging'))
  assert.ok(startIdx >= 0, 'the option row renders')
  const endIdx = lines.findIndex((l, i) => i > startIdx && l.includes('2. Type something.'))
  assert.ok(endIdx > startIdx, 'the sentinel row follows')
  const descriptionLines = lines.slice(startIdx + 1, endIdx)
  assert.ok(descriptionLines.length >= 2, `a long description wraps onto several lines, got ${descriptionLines.length}`)
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width - 2, `every rendered line fits the pane (width ${visibleWidth(line)})`)
  }
  // No words lost: reassemble and compare folded.
  const rejoined = descriptionLines.map(l => l.trim()).join(' ')
  for (const word of longDescription.split(' ')) {
    assert.ok(rejoined.includes(word), `wrapped description keeps the word "${word}"`)
  }
})

// ------------------------------------------------------- docked-panel contract --

test('openAskUserPanel: mounts into the dock, takes focus, declares the modal; close unmounts and clears it', async () => {
  const { deps, calls } = makeHarness()
  const result = openAskUserPanel(deps, singleQuestion())
  const tracked = trackResolution(result)
  assert.equal(calls.overlays.length, 1, 'panel mounted into the dock slot')
  assert.equal(calls.modal[0], true, 'modal keyboard ownership declared on open')
  assert.equal(calls.focus.length, 1, 'focus moved to the panel')
  assert.equal(calls.focus[0], calls.overlays[0].component, 'the mounted component holds focus')
  assert.equal(calls.hideOverlayCalls, 1, 'any capturing overlay beneath is dismissed on open')

  const panel = calls.overlays[0].component
  panel.handleInput('\x1b[B') // down → an option row
  panel.handleInput('\r') // Enter → auto-submit
  await result
  assert.equal(tracked.resolved, true)
  assert.deepEqual(calls.modal, [true, false], 'modal flag cleared on close (before restoreFocus)')
  assert.equal(calls.overlays.length, 0, 'panel unmounted from the dock')
  assert.equal(calls.restoreFocus, 1, 'focus offered back to the editor')
})

test('openAskUserPanel: the docked panel renders in the Todos-panel box language', () => {
  const { deps, calls } = makeHarness()
  openAskUserPanel(deps, baseQuestions())
  const lines = calls.overlays[0].component.render(80)
  assert.ok(lines[0].includes('┌') && lines[0].includes('┐'), 'top box border')
  assert.ok(lines[lines.length - 1].includes('└') && lines[lines.length - 1].includes('┘'), 'bottom box border')
  assert.ok(lines.some(l => l.includes('│')), 'side borders on body rows')
  const stripped = lines.map(l => stripAnsi(l))
  assert.ok(stripped.some(l => l.includes('Questions (2)')), 'title row inside the box')
})
