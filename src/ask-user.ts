/**
 * Ask the human a question while the model is mid-turn.
 *
 * Wires the upstream `ctx.userQuestions` capability seam (`dsh-user-questions`)
 * with a terminal-side UI: an in-place multi-question overlay that pauses the
 * tool call until the human answers, then feeds the canonical
 * `AskUserQuestionAnswer` envelope back to `dsh-tool-ask-user` as a normal
 * tool result.
 *
 * Layout — one framed overlay, all questions flattened:
 *
 *   ● Question 1
 *     Where should we deploy?   (left = header / right = question text)
 *     ▸ staging
 *       production
 *       Type something.          (sentinel row — inline input)
 *     Question 2 ···            (continues vertically)
 *     ▸ …
 *     ⏎ Confirm answers        (when ≥ 2 questions, or any multiSelect question)
 *
 * Single-question single-select overlay: Enter on an option (or committing a
 * filled sentinel) submits immediately. A multiSelect question — even a lone
 * one — gets a Confirm row instead of auto-submitting, so the user can pick
 * several options first. Multi-question overlay: Enter on the Confirm row
 * hops to the review page (all answers listed, each editable in place).
 * Esc double-press within 200 ms declines — but terminal key auto-repeat
 * (holding Esc) is ignored below `ESC_REPEAT_GUARD_MS`, so a long press
 * cannot accidentally fire the decline. The provider returns the "declined"
 * envelope and the model reads it as a normal user reply. An aborted
 * request signal (`request.signal`) settles declined too — we resolve the
 * declined envelope instead of rejecting ASK_ABORTED because the upstream
 * service already screens entry-time aborts and an aborted step discards
 * the result anyway.
 *
 * Pure logic lives in the top of this file (initial state, answer envelope,
 * declined envelope, double-Esc state machine, row-layout math) so it can
 * be unit-tested without a TTY. The component below owns the TUI render +
 * keyboard handling; the install function at the bottom registers the
 * provider under `ctx.userQuestions` (a Cordis effect, single active
 * provider in the tree).
 *
 * Inspired by juicesharp/rpiv-ask-user-question
 * (https://github.com/juicesharp/rpiv-ask-user-question).
 */

import { getKeybindings, matchesKey, type Component, type OverlayHandle, type TUI } from '@earendil-works/pi-tui'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionOption } from '@deepseek-ai/dsh-user-questions'
import type { Context } from '@deepseek-ai/cordis'
import {
  BOLD,
  RESET,
  type TuiTheme,
} from './theme/index.ts'
import {
  MARKER_W,
  panelThemeFns,
  TABLE_SEP,
  columnWidths,
  padCell,
  rowMarker,
  tableHeaderLine,
  tableRuleLine,
  type TableColumn,
} from './panels.ts'
import { wrapFramedOverlay } from './frame.ts'
import { clipToWidth } from './text.ts'

// ----------------------------------------------------------------- constants --

/** Maximum time between two Esc presses before the second one re-arms instead of firing. */
export const DOUBLE_ESC_WINDOW_MS = 200

/**
 * Minimum gap between two Esc presses below which the second one is treated as
 * terminal key auto-repeat (the user is HOLDING Esc) rather than a deliberate
 * press: repeats leave the state untouched, so a long press can never fire the
 * decline gesture on its own.
 */
export const ESC_REPEAT_GUARD_MS = 50

/** Sentinel row label appended to every question's option list. */
export const SENTINEL_LABEL = 'Type something.'

/** Decline message embedded into the answer envelope when the user bails. */
export const DECLINE_MESSAGE = 'User declined to answer questions.'

/** Transient hint when Enter lands on an incomplete confirm/submit row. */
export const INCOMPLETE_HINT = 'Answer every question first'

/** Mark left of a question a custom input wrote text into. */
const CUSTOM_MARK = '✎ '

// ------------------------------------------------------- pure types --

/** A row in the multi-question view. */
export interface FlatRow {
  kind: 'question-header' | 'option' | 'sentinel' | 'confirm'
  questionIndex: number
  /** optionIndex for `option` rows, undefined for everything else. */
  optionIndex?: number
  label: string
  description?: string
  /** Upstream `detail` (supporting text rendered under the header, never in labels). */
  detail?: string
  selectable: boolean
}

/** Pending answer for a single question. */
export interface PendingAnswer {
  /** Selected option labels in display order. Empty when the sentinel/custom path owns this question. */
  selected: readonly string[]
  /** Free-text answer from the sentinel path. Optional — set only when the user typed. */
  custom?: string
}

/** Whole-state of one AskUser overlay. All setters are pure reducers. */
export interface AskUserState {
  questions: readonly AskUserQuestionItem[]
  /** Per-question pending answer. */
  perQuestion: PendingAnswer[]
  /** Cursor position in the flat row list (see `buildRowList`). */
  cursorIndex: number
  /** Live inline-edit text per question; non-null when the sentinel is engaged for that question. */
  customInputs: (string | null)[]
  /** Live inline edit owner (question index); null when not editing. */
  customEditingFor: number | null
  /** Phase: multi-question uses a review step before submission. */
  phase: 'questions' | 'review'
  /** Cursor over the review rows. Q rows + 1 submit row. */
  reviewIndex: number
  /** Last Esc timestamp for the double-Esc guard. */
  lastEscAt: number | null
  /** The status hint shown above the footer after one Esc press. */
  cancelHint: boolean
  /** Transient "you can't do that yet" hint (e.g. Enter on an incomplete confirm row). Cleared by any navigation. */
  attentionHint: string | null
}

// ---------------------------------------- pure functions (testable) --

/** Initial state for a `questions` payload — defaults: cursor on Q0/option-0, no edit, no Esc history. */
export function initialState(questions: readonly AskUserQuestionItem[]): AskUserState {
  return {
    questions,
    perQuestion: questions.map(() => ({ selected: [] })),
    cursorIndex: 0,
    customInputs: questions.map(() => null),
    customEditingFor: null,
    phase: 'questions',
    reviewIndex: 0,
    lastEscAt: null,
    cancelHint: false,
    attentionHint: null,
  }
}

/** Toggle/add an option. Single-select replaces; multi-select toggles membership. */
export function toggleOption(state: AskUserState, questionIndex: number, optionLabel: string): AskUserState {
  const question = state.questions[questionIndex]
  if (question === undefined) return state
  const answer = state.perQuestion[questionIndex]
  if (answer === undefined) return state
  const current = answer.selected
  const isMulti = question.multiSelect === true
  const next = isMulti
    ? current.includes(optionLabel) ? current.filter(l => l !== optionLabel) : [...current, optionLabel]
    : current.includes(optionLabel) ? [] : [optionLabel]
  const perQuestion = state.perQuestion.slice()
  perQuestion[questionIndex] = {
    selected: next,
    ...(answer.custom !== undefined ? { custom: answer.custom } : {}),
  }
  return { ...state, perQuestion }
}

/** Set the custom answer for a question (clears selected options). */
export function setCustomAnswer(state: AskUserState, questionIndex: number, text: string): AskUserState {
  const answer = state.perQuestion[questionIndex]
  if (answer === undefined) return state
  const perQuestion = state.perQuestion.slice()
  perQuestion[questionIndex] = { selected: [], custom: text }
  const customInputs = state.customInputs.slice()
  customInputs[questionIndex] = text
  return { ...state, perQuestion, customInputs }
}

/** Mutate the live custom input buffer for a question. */
export function patchCustomInput(state: AskUserState, questionIndex: number, mutator: (current: string) => string): AskUserState {
  const customInputs = state.customInputs.slice()
  customInputs[questionIndex] = mutator(customInputs[questionIndex] ?? '')
  return { ...state, customInputs }
}

/** Enter inline-edit mode for a question (sentinel row got pressed). */
export function enterCustomEdit(state: AskUserState, questionIndex: number): AskUserState {
  const customInputs = state.customInputs.slice()
  if (customInputs[questionIndex] === null) customInputs[questionIndex] = ''
  return { ...state, customEditingFor: questionIndex, customInputs, cancelHint: false }
}

/** Leave inline-edit mode; commit when `commit === true` and the buffer is non-empty. */
export function exitCustomEdit(state: AskUserState, commit: boolean): AskUserState {
  if (state.customEditingFor === null) return state
  const qi = state.customEditingFor
  const next = commit && (state.customInputs[qi] ?? '').trim() !== ''
    ? setCustomAnswer({ ...state, customEditingFor: null }, qi, (state.customInputs[qi] ?? '').trim())
    : { ...state, customEditingFor: null }
  return { ...next, cancelHint: false }
}

/**
 * Double-Esc state machine: 1st press arms; 2nd within the window fires
 * (caller reads `lastEscAt===null + cancelHint===false`). Presses closer than
 * `repeatGuardMs` are terminal key auto-repeat (held key) and are ignored
 * entirely — the armed state stays at its original timestamp, so holding Esc
 * neither fires the decline nor refreshes the window.
 */
export function advanceDoubleEsc(
  state: AskUserState,
  now: number,
  windowMs: number = DOUBLE_ESC_WINDOW_MS,
  repeatGuardMs: number = ESC_REPEAT_GUARD_MS,
): AskUserState {
  const last = state.lastEscAt
  if (last !== null && now - last < repeatGuardMs) {
    return state
  }
  if (last === null || now - last > windowMs) {
    return { ...state, lastEscAt: now, cancelHint: true, attentionHint: null }
  }
  return { ...state, lastEscAt: null, cancelHint: false, attentionHint: null }
}

/** Was the most recent double-Esc press a "fired" event (the second within the window)? */
export function didDoubleEscFire(prevState: AskUserState, nextState: AskUserState, now: number, windowMs: number = DOUBLE_ESC_WINDOW_MS): boolean {
  if (prevState.lastEscAt === null) return false
  if (nextState.lastEscAt !== null) return false
  if (now - prevState.lastEscAt > windowMs) return false
  return true
}

/** Canonical envelope for a normal submission. The model reads it as a tool result. */
export function buildAnswerEnvelope(state: AskUserState): AskUserQuestionAnswer {
  const answers: AskUserQuestionAnswerItem[] = []
  for (let qi = 0; qi < state.questions.length; qi++) {
    const question = state.questions[qi]
    const answer = state.perQuestion[qi]
    if (question === undefined || answer === undefined) continue
    const item: AskUserQuestionAnswerItem = { id: question.id, selected: [...answer.selected] }
    if (answer.custom !== undefined && answer.custom !== '') item.custom = answer.custom
    answers.push(item)
  }
  return { answers }
}

/** Canonical envelope for the decline path: empty selected + custom decline message on every question. */
export function buildDeclinedEnvelope(questions: readonly AskUserQuestionItem[], message: string = DECLINE_MESSAGE): AskUserQuestionAnswer {
  return {
    answers: questions.map(question => ({ id: question.id, selected: [], custom: message })),
  }
}

/** Build the ordered, flat list of rows for the questions pane. */
export function buildRowList(questions: readonly AskUserQuestionItem[], perQuestion: readonly PendingAnswer[]): FlatRow[] {
  const rows: FlatRow[] = []
  questions.forEach((question, qi) => {
    rows.push({
      kind: 'question-header',
      questionIndex: qi,
      label: question.header ?? `Question ${qi + 1}`,
      description: question.question,
      ...(question.detail !== undefined ? { detail: question.detail } : {}),
      selectable: false,
    })
    const options = question.options ?? []
    options.forEach((opt, oi) => {
      rows.push({
        kind: 'option',
        questionIndex: qi,
        optionIndex: oi,
        label: opt.label,
        ...(opt.description !== undefined ? { description: opt.description } : {}),
        selectable: true,
      })
    })
    const customAnswer = perQuestion[qi]?.custom ?? ''
    rows.push({
      kind: 'sentinel',
      questionIndex: qi,
      label: customAnswer !== '' ? `${CUSTOM_MARK}${customAnswer.trim()}` : SENTINEL_LABEL,
      selectable: true,
    })
  })
  if (needsConfirmRow(questions)) {
    rows.push({ kind: 'confirm', questionIndex: -1, label: '⏎ Confirm answers', selectable: true })
  }
  return rows
}

/** Find the next selectable index from `i` going in `direction`, clamped into range. */
export function nextSelectableIndex(rows: readonly FlatRow[], from: number, direction: 1 | -1): number {
  const n = rows.length
  if (n === 0) return 0
  let i = Math.max(0, Math.min(n - 1, from))
  // Two-pass scan: forward in `direction`, then backward.
  for (let pass = 0; pass < 2; pass++) {
    let j = pass === 0 ? i + direction : (direction === 1 ? 0 : n - 1)
    while (j >= 0 && j < n) {
      if (rows[j]?.selectable === true) return j
      j += direction
    }
  }
  return i
}

/** True when every question has at least one selected option or a non-empty custom answer. */
export function allQuestionsAnswered(state: AskUserState): boolean {
  return state.perQuestion.every(answer =>
    answer.selected.length > 0 || (answer.custom !== undefined && answer.custom.trim() !== ''),
  )
}

/**
 * Whether the overlay needs an explicit `⏎ Confirm answers` row: any
 * multi-question layout, plus a lone multiSelect question — multiSelect can
 * never auto-submit (the user may want more toggles), so it needs a path to
 * the review page.
 */
export function needsConfirmRow(questions: readonly AskUserQuestionItem[]): boolean {
  return questions.length >= 2 || questions.some(question => question.multiSelect === true)
}

/**
 * True when a successful action on THIS state can submit immediately without
 * the review step: exactly one question, single-select (a multiSelect
 * question may want further toggles), and every question answered.
 */
export function canAutoSubmit(state: AskUserState): boolean {
  if (state.questions.length !== 1) return false
  if (state.questions[0]?.multiSelect === true) return false
  return allQuestionsAnswered(state)
}

/**
 * Row index to land on after answering question `answeredQi`: the first
 * selectable row of the nearest LATER unanswered question, or -1 when every
 * later question is already answered (caller keeps the current cursor).
 */
export function nextUnansweredRow(
  rows: readonly FlatRow[],
  perQuestion: readonly PendingAnswer[],
  answeredQi: number,
): number {
  const answered = (qi: number): boolean => {
    const answer = perQuestion[qi]
    return answer !== undefined
      && (answer.selected.length > 0 || (answer.custom !== undefined && answer.custom.trim() !== ''))
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row === undefined || !row.selectable) continue
    if (row.questionIndex <= answeredQi) continue
    if (!answered(row.questionIndex)) return i
  }
  return -1
}

// ------------------------------------------------- render: questions phase --

/** Render width budgets for the questions phase (label flex column + status column). */
const QUESTIONS_COLUMNS = (): readonly TableColumn[] => [
  { key: 'label', title: 'Selection', flex: true },
  { key: 'status', title: 'State', width: 14 },
]

/** Status pill text for one row. */
function rowStatusText(kind: FlatRow['kind'], state: AskUserState, row: FlatRow, isMulti: boolean): string {
  if (kind === 'question-header') return ''
  if (kind === 'option') {
    const opt = state.questions[row.questionIndex]?.options?.[row.optionIndex ?? -1]
    if (opt === undefined) return ''
    const isSelected = state.perQuestion[row.questionIndex]?.selected.includes(opt.label) ?? false
    if (!isSelected) return ''
    return isMulti ? `[+]` : '[●]'
  }
  if (kind === 'sentinel') {
    return (state.perQuestion[row.questionIndex]?.custom !== undefined
      && state.perQuestion[row.questionIndex]?.custom !== '') ? '[✎]' : ''
  }
  if (kind === 'confirm') return allQuestionsAnswered(state) ? '[✓]' : '[—]'
  return ''
}

/** Render the questions pane as a flat table line list. */
export function renderQuestionsView(theme: TuiTheme, state: AskUserState, width: number): string[] {
  const fns = panelThemeFns(theme)
  const wrap = Math.max(2, width - 2)
  const title = state.questions.length === 1
    ? '● Question'
    : `● Questions (${state.questions.length})`
  const lines: string[] = [fns.accent(BOLD + clipToWidth(title, wrap) + RESET)]
  const rows = buildRowList(state.questions, state.perQuestion)
  if (rows.length === 0) {
    lines.push(fns.muted(clipToWidth('(no questions)', wrap)))
    return finalizeQuestionsView(fns, wrap, lines, state)
  }

  const columns = QUESTIONS_COLUMNS()
  const widths = columnWidths(wrap - MARKER_W, columns)

  lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┬'), wrap)))
  lines.push(fns.subtle(clipToWidth(tableHeaderLine(columns, widths), wrap)))
  lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┼'), wrap)))

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row === undefined) continue

    if (row.kind === 'question-header') {
      // Header rows: full-width title, skip the table columns.
      const text = `${row.label}  ${row.description ?? ''}`
      const padded = clipToWidth(BOLD + text + RESET, wrap)
      lines.push(fns.accent(padded))
      // Upstream `detail` is supporting context (mandatory when the question
      // declares an intent) — render it muted below the header, never inside
      // option labels.
      if (row.detail !== undefined && row.detail !== '') {
        lines.push(fns.muted(clipToWidth(row.detail, wrap)))
      }
      continue
    }

    const isMulti = row.questionIndex >= 0
      ? state.questions[row.questionIndex]?.multiSelect === true
      : false
    const selected = i === state.cursorIndex && state.customEditingFor === null
    let displayLabel = row.label
    if (row.kind === 'option') {
      const opt = state.questions[row.questionIndex]?.options?.[row.optionIndex ?? -1]
      if (opt?.description !== undefined && opt.description !== '') {
        displayLabel = `${opt.label}  ${opt.description}`
      }
    }
    if (row.kind === 'sentinel' && state.customEditingFor === row.questionIndex) {
      displayLabel = `${state.customInputs[row.questionIndex] ?? ''}_`
    }
    const status = rowStatusText(row.kind, state, row, isMulti)
    const labelCell = padCell(clipToWidth(displayLabel, widths[0]), widths[0])
    const statusCell = padCell(clipToWidth(status, widths[1]), widths[1])
    const plain = `${rowMarker(selected)}${labelCell}${TABLE_SEP}${statusCell}`
    const line = clipToWidth(plain, wrap)
    if (selected) {
      lines.push(fns.accent(BOLD + line + RESET))
    } else if (row.kind === 'option'
      && (state.perQuestion[row.questionIndex]?.selected.includes(
        state.questions[row.questionIndex]?.options?.[row.optionIndex ?? -1]?.label ?? '',
      ) ?? false)) {
      lines.push(fns.success(line))
    } else if (row.kind === 'sentinel'
      && (state.perQuestion[row.questionIndex]?.custom !== undefined
        && state.perQuestion[row.questionIndex]?.custom !== '')) {
      lines.push(fns.success(line))
    } else {
      lines.push(fns.muted(line))
    }
  }

  lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┴'), wrap)))
  return finalizeQuestionsView(fns, wrap, lines, state)
}

function finalizeQuestionsView(
  fns: ReturnType<typeof panelThemeFns>,
  wrap: number,
  lines: string[],
  state: AskUserState,
): string[] {
  if (state.attentionHint !== null) {
    lines.push(fns.attention(clipToWidth(state.attentionHint, wrap)))
  }
  if (state.cancelHint) {
    lines.push(fns.attention(clipToWidth('Press Esc again to decline', wrap)))
  }
  lines.push('')
  const footer = state.customEditingFor !== null
    ? 'Type free text · Enter keep · Esc abandon edit'
    : `↑↓ navigate · Enter ${needsConfirmRow(state.questions) ? 'toggle / confirm' : 'select'} · Esc decline`
  lines.push(fns.subtle(clipToWidth(footer, wrap)))
  return lines
}

// -------------------------------------------------- render: review phase --

/** Render the review page for multi-question overlays. */
export function renderReviewView(theme: TuiTheme, state: AskUserState, width: number): string[] {
  const fns = panelThemeFns(theme)
  const wrap = Math.max(2, width - 2)
  const lines: string[] = [fns.accent(BOLD + clipToWidth('● Review answers', wrap) + RESET)]
  // Question column with a content cap + answer column flexes to the right edge.
  // (columnWidths only assigns the remainder to ONE flex column; two flex
  // columns would both get the whole remainder and clip the second off.)
  const usable = wrap - MARKER_W
  const leftCap = Math.max(20, Math.floor(usable * 0.45))
  const columns: readonly TableColumn[] = [
    { key: 'question', title: 'Question', width: leftCap },
    { key: 'answer', title: 'Your answer', flex: true },
  ]
  const widths = columnWidths(usable, columns)
  lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┬'), wrap)))
  lines.push(fns.subtle(clipToWidth(tableHeaderLine(columns, widths), wrap)))
  lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┼'), wrap)))
  state.questions.forEach((question, qi) => {
    const answer = state.perQuestion[qi]
    const left = `${question.header ?? `Q${qi + 1}`}  ${question.question}`
    const right = formatAnswerForReview(answer)
    const selected = qi === state.reviewIndex
    const leftCell = padCell(clipToWidth(left, widths[0]), widths[0])
    const rightCell = padCell(clipToWidth(right, widths[1]), widths[1])
    const plain = `${rowMarker(selected)}${leftCell}${TABLE_SEP}${rightCell}`
    const line = clipToWidth(plain, wrap)
    lines.push(selected ? fns.accent(BOLD + line + RESET) : fns.muted(line))
  })
  // Submit row (review pane).
  {
    const selected = state.reviewIndex === state.questions.length
    const leftCell = padCell(clipToWidth('Submit answers', widths[0]), widths[0])
    const rightCell = padCell(clipToWidth(allQuestionsAnswered(state) ? '✓ ready' : '— incomplete', widths[1]), widths[1])
    const plain = `${rowMarker(selected)}${leftCell}${TABLE_SEP}${rightCell}`
    const line = clipToWidth(plain, wrap)
    lines.push(selected ? fns.accent(BOLD + line + RESET) : fns.muted(line))
  }
  lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┴'), wrap)))
  if (state.attentionHint !== null) {
    lines.push(fns.attention(clipToWidth(state.attentionHint, wrap)))
  }
  lines.push('')
  lines.push(fns.subtle(clipToWidth('↑↓ select · Enter return to edit / submit', wrap)))
  return lines
}

function formatAnswerForReview(answer: PendingAnswer | undefined): string {
  if (answer === undefined) return ''
  if (answer.custom !== undefined && answer.custom !== '') return `${CUSTOM_MARK}${answer.custom}`
  if (answer.selected.length === 0) return '(no answer)'
  return answer.selected.join(', ')
}

// ------------------------------------------------------------ panel --

/** Options for assembling the panel + provider function. */
export interface AskUserPanelDeps {
  tui: TUI
  /** Live theme getter — re-read on every render so a mid-overlay hot-swap applies (frame included). */
  theme: () => TuiTheme
  /** Re-focus the current editor on overlay close. */
  restoreFocus: () => void
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number
  /** Width and height of the framed overlay. */
  width?: `${number}%` | number
  maxHeight?: `${number}%` | number
}

/** Result promise from `openAskUserPanel`. Declined carries the canonical decline envelope. */
export type AskUserResult = AskUserQuestionAnswer

/**
 * Open the AskUser overlay for one set of questions.
 *
 * `signal` is the caller's abort signal (the tool execution's). Already-aborted
 * settles declined WITHOUT staging an overlay; a live signal closes the
 * overlay and settles declined when it fires. We resolve the declined envelope
 * rather than rejecting with the upstream ASK_ABORTED code on purpose: the
 * upstream service already screens entry-time aborts, and a step aborted after
 * this point discards the tool result anyway — resolving keeps the pending
 * promise from ever hanging either way.
 */
export function openAskUserPanel(
  deps: AskUserPanelDeps,
  questions: readonly AskUserQuestionItem[],
  signal?: AbortSignal,
): Promise<AskUserResult> {
  if (signal?.aborted) {
    return Promise.resolve(buildDeclinedEnvelope(questions))
  }
  return new Promise<AskUserResult>((resolve) => {
    const clock = deps.now ?? Date.now
    const state: AskUserState = initialState(questions)
    let settled = false
    const onAbort = (): void => {
      settle(buildDeclinedEnvelope(questions))
      overlay.hide()
      deps.restoreFocus()
    }
    const settle = (envelope: AskUserQuestionAnswer): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(envelope)
    }

    const panel: Component = {
      invalidate() { /* frames are re-rendered on demand */ },
      render(width: number): string[] {
        const theme = deps.theme()
        if (state.phase === 'review') return renderReviewView(theme, state, width)
        return renderQuestionsView(theme, state, width)
      },
      handleInput(data: string) {
        if (settled) return
        if (state.customEditingFor !== null) {
          handleCustomInput(state, data)
          return
        }
        const kb = getKeybindings()
        if (kb.matches(data, 'tui.select.up')) { moveCursor(state, -1); return }
        if (kb.matches(data, 'tui.select.down')) { moveCursor(state, 1); return }
        if (kb.matches(data, 'tui.select.confirm')) { handleConfirm(state); return }
        if (kb.matches(data, 'tui.select.cancel')) {
          const now = clock()
          const prevState: AskUserState = { ...state }
          const after = advanceDoubleEsc(state, now)
          Object.assign(state, after)
          if (didDoubleEscFire(prevState, state, now)) {
            settle(buildDeclinedEnvelope(questions))
            overlay.hide()
            deps.restoreFocus()
          }
          return
        }
      },
    }

    // Stage the overlay through the standard FramedOverlay wrapper. The theme
    // getter is passed through so the frame re-reads it per render too.
    const overlay: OverlayHandle = deps.tui.showOverlay(
      wrapFramedOverlay(deps.theme, panel),
      { width: deps.width ?? '85%', maxHeight: deps.maxHeight ?? '80%' },
    )
    signal?.addEventListener('abort', onAbort, { once: true })

    // When the overlay closes (without an explicit settle first), resolve the
    // promise with the decline envelope — covers /reload, theme swap, agent
    // abort, and any path that closes the overlay out from under us.
    const originalHide = overlay.hide.bind(overlay)
    overlay.hide = (): void => {
      if (!settled) {
        settle(buildDeclinedEnvelope(questions))
        deps.restoreFocus()
      }
      originalHide()
    }

    // Local mutator helpers — these write into the closed-over state via
    // Object.assign so the keyboard handler can use the immutable reducers.
    function moveCursor(s: AskUserState, direction: 1 | -1): void {
      if (s.phase === 'review') {
        const max = s.questions.length // last row is the submit pseudo-row
        s.reviewIndex = Math.max(0, Math.min(max, s.reviewIndex + direction))
        Object.assign(s, { cancelHint: false, attentionHint: null })
        return
      }
      const rows = buildRowList(s.questions, s.perQuestion)
      const next = nextSelectableIndex(rows, s.cursorIndex + direction, direction)
      Object.assign(s, { cursorIndex: next, cancelHint: false, attentionHint: null })
    }

    function handleConfirm(s: AskUserState): void {
      if (s.phase === 'review') {
        if (s.reviewIndex < s.questions.length) {
          const rows = buildRowList(s.questions, s.perQuestion)
          const first = rows.findIndex(r => r.kind !== 'question-header' && r.questionIndex === s.reviewIndex)
          Object.assign(s, {
            phase: 'questions',
            cursorIndex: first >= 0 ? first : s.cursorIndex,
            cancelHint: false,
            attentionHint: null,
          })
          return
        }
        if (!allQuestionsAnswered(s)) {
          Object.assign(s, { cancelHint: false, attentionHint: INCOMPLETE_HINT })
          return
        }
        settle(buildAnswerEnvelope(s))
        overlay.hide()
        deps.restoreFocus()
        return
      }
      // questions phase
      const rows = buildRowList(s.questions, s.perQuestion)
      const row = rows[s.cursorIndex]
      if (row === undefined) return
      if (row.kind === 'option' && row.optionIndex !== undefined) {
        const option = s.questions[row.questionIndex]?.options?.[row.optionIndex]
        if (option === undefined) return
        const next = toggleOption(s, row.questionIndex, option.label)
        Object.assign(s, next)
        // Single-question single-select fast path: a successful selection
        // submits immediately. multiSelect never auto-submits — the user may
        // want more toggles, so it routes through the Confirm row instead.
        if (canAutoSubmit(next)) {
          settle(buildAnswerEnvelope(s))
          overlay.hide()
          deps.restoreFocus()
        }
        return
      }
      if (row.kind === 'sentinel') {
        const seed = s.perQuestion[row.questionIndex]?.custom ?? ''
        const seeded = patchCustomInput(enterCustomEdit(s, row.questionIndex), row.questionIndex, () => seed)
        Object.assign(s, seeded)
        return
      }
      if (row.kind === 'confirm') {
        if (allQuestionsAnswered(s)) {
          Object.assign(s, { phase: 'review', reviewIndex: 0, cancelHint: false, attentionHint: null })
        } else {
          Object.assign(s, { cancelHint: false, attentionHint: INCOMPLETE_HINT })
        }
      }
    }

    function handleCustomInput(s: AskUserState, data: string): void {
      const qi = s.customEditingFor
      if (qi === null) return
      const kb = getKeybindings()
      if (kb.matches(data, 'tui.select.confirm')) {
        Object.assign(s, exitCustomEdit(s, true))
        commitCustomAnswer(s, qi)
        return
      }
      if (kb.matches(data, 'tui.select.cancel')) {
        Object.assign(s, exitCustomEdit(s, false))
        return
      }
      if (data === '\x7f' || matchesKey(data, 'backspace')) {
        const next = s.customInputs.slice()
        next[qi] = (next[qi] ?? '').slice(0, -1)
        s.customInputs = next
        return
      }
      if (data.length === 1 && data.charCodeAt(0) >= 0x20 && data.charCodeAt(0) !== 0x7f) {
        const next = s.customInputs.slice()
        next[qi] = (next[qi] ?? '') + data
        s.customInputs = next
      }
    }

    /**
     * After a committed sentinel edit: a lone single-select question whose
     * answer is now complete submits right away (this is the free-text
     * counterpart of the option fast path — without it, typing an answer into
     * a question with no options could never reach `settle`). Otherwise, in a
     * multi-question layout the cursor hops to the next unanswered question's
     * first row to cut confirmation cost.
     */
    function commitCustomAnswer(s: AskUserState, qi: number): void {
      if (s.customEditingFor !== null) return // edit not committed (empty buffer)
      if (s.perQuestion[qi]?.custom === undefined) return
      if (canAutoSubmit(s)) {
        settle(buildAnswerEnvelope(s))
        overlay.hide()
        deps.restoreFocus()
        return
      }
      if (s.questions.length >= 2) {
        const rows = buildRowList(s.questions, s.perQuestion)
        const target = nextUnansweredRow(rows, s.perQuestion, qi)
        if (target >= 0) Object.assign(s, { cursorIndex: target, cancelHint: false, attentionHint: null })
      }
    }
  })
}

// ----------------------------------------------------- the provider --

/**
 * True only for the upstream's documented duplicate-registration failure
 * (`UserQuestionError` with code `DUPLICATE_PROVIDER`) — the one case where
 * yielding the single provider slot to the prior UI is correct. Matched
 * structurally on `name` + `code` so a cross-realm HarnessError instance or a
 * test double classifies identically.
 */
export function isDuplicateProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name !== 'UserQuestionError') return false
  return (error as { code?: string }).code === 'DUPLICATE_PROVIDER'
}

/** Minimal structural view of the `ctx.userQuestions` seam we register against. */
interface UserQuestionsSeam {
  registerProvider(provider: {
    ask: (request: { questions: AskUserQuestionItem[]; signal?: AbortSignal }) => Promise<AskUserQuestionAnswer>
  }): () => void
}

/**
 * Wires the provider into `ctx.userQuestions`. Call from inside `ctx.effect`.
 *
 * Failure semantics are deliberate (review round BM):
 * - missing service → warn + no-op disposer. The tool stays mounted by the
 *   bundle patch; without a provider its calls fail with the upstream
 *   NO_PROVIDER error, which is better than crashing the whole TUI plugin.
 * - DUPLICATE_PROVIDER → silent no-op disposer (a prior UI owns the slot).
 * - anything else → rethrown so the effect fails loudly instead of leaving a
 *   mounted tool with no UI and no trace.
 */
export function registerAskUserProvider(
  ctx: Context,
  deps: AskUserPanelDeps,
): () => void {
  const userQuestions = (ctx as { userQuestions?: UserQuestionsSeam }).userQuestions
  if (userQuestions === undefined || typeof userQuestions.registerProvider !== 'function') {
    console.warn('[dsh-tui-pi] ctx.userQuestions not mounted — ask_user_question calls will fail with NO_PROVIDER')
    return () => { /* no-op */ }
  }
  try {
    return userQuestions.registerProvider({
      ask: request => openAskUserPanel(deps, request.questions, request.signal),
    })
  } catch (error) {
    if (isDuplicateProviderError(error)) {
      // A prior UI is already the provider — yield ownership instead of crashing.
      return () => { /* no-op */ }
    }
    throw error
  }
}

// `AskUserQuestionOption` is imported for type completeness (re-exported for tests).
export type { AskUserQuestionOption }
