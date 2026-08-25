/**
 * Ask the human a question while the model is mid-turn.
 *
 * Wires the upstream `ctx.userQuestions` capability seam (`dsh-user-questions`)
 * with a terminal-side UI: a DOCKED panel pinned above the chat input (the
 * Todos-panel slot of the widgets dock — not a floating overlay) that pauses
 * the tool call until the human answers, then feeds the canonical
 * `AskUserQuestionAnswer` envelope back to `dsh-tool-ask-user` as a normal
 * tool result.
 *
 * Layout — one bordered dock panel, all questions flattened (numbered rows, a
 * divider between each question block and its options, and a scroll window
 * so the cursor row is always visible even when the dock is height-capped):
 *
 *   ┌────────────────────────────────────┐
 *   │ ● Questions (2)                    │
 *   │ SELECTION                          │
 *   │ ─────────────────────────────      │   (table chrome)
 *   │ Fruit  Where should we deploy?     │   (header — not selectable)
 *   │ ─────────────────────────────      │   (divider)
 *   │ ▸ ● 1. staging                     │   (cursor + inline selection mark)
 *   │   ○ 2. production                  │
 *   │      red and round                 │   (option description, own muted line)
 *   │     3. Type something.             │   (sentinel row — inline input)
 *   │                                    │   (blank separator before confirm)
 *   │     ⏎ Confirm answers              │   (when ≥ 2 questions, or any multiSelect)
 *   └────────────────────────────────────┘
 *
 * While the panel is open it owns the keyboard: it is mounted into the dock
 * slot between the live widgets and the editor, takes focus through
 * `tui.setFocus`, and `setModalActive(true)` routes the app keymap exactly
 * like an open overlay (Esc/Ctrl+C/app keys yield to the panel — Esc never
 * arms the running-task stop from inside a modal). On close the panel
 * unmounts, clears the modal flag, and focus returns to the current editor
 * through `restoreFocus`.
 *
 * The body renders through a scroll window sized from the live terminal
 * height (`askUserMaxVisibleForRows`; the dock budget subtracts the editor,
 * footer and a transcript floor, and falls back to `ASK_USER_MAX_VISIBLE`
 * when the terminal row count is unknown): pi-tui would lay a taller dock
 * out at full height and squeeze the transcript to nothing, so the window
 * caps the body. The window slides with the cursor and the footer gains a
 * `(n/m)` position readout while content overflows.
 *
 * Single-question single-select panel: Enter on an option (or committing a
 * filled sentinel) submits immediately. A multiSelect question — even a lone
 * one — gets a Confirm row instead of auto-submitting, so the user can pick
 * several options first. Multi-question panel: Enter on the Confirm row hops
 * to the review page (all answers listed, each editable in place). Esc
 * double-press within 200 ms declines — but terminal key auto-repeat (holding
 * Esc) is ignored below `ESC_REPEAT_GUARD_MS`, so a long press cannot
 * accidentally fire the decline. The provider returns the "declined" envelope
 * and the model reads it as a normal user reply. An aborted request signal
 * (`request.signal`) settles declined too — we resolve the declined envelope
 * instead of rejecting ASK_ABORTED because the upstream service already
 * screens entry-time aborts and an aborted step discards the result anyway.
 *
 * Pure logic lives in the top of this file (initial state, answer envelope,
 * declined envelope, double-Esc state machine, row-layout math) so it can be
 * unit-tested without a TTY. The component below owns the TUI render +
 * keyboard handling; the install function at the bottom registers the
 * provider under `ctx.userQuestions` (a Cordis effect, single active
 * provider in the tree).
 *
 * Inspired by juicesharp/rpiv-ask-user-question
 * (https://github.com/juicesharp/rpiv-ask-user-question).
 */

import { getKeybindings, matchesKey, type Component, type TUI } from '@earendil-works/pi-tui'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionOption } from '@deepseek-ai/dsh-user-questions'
import type { Context } from '@deepseek-ai/cordis'
import {
  borderedRow,
  panelBottomBorder,
  panelBoxWidth,
  panelTopBorder,
} from './activity.ts'
import {
  BOLD,
  RESET,
  ansiFg,
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
import { clipToWidth, wrapText } from './text.ts'
import { emitNotice } from './notice-bridge.ts'

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

/**
 * Fallback visible body-line cap for the questions/review panes, used only
 * when the terminal row count is unknown (fake TUIs in tests, exotic
 * terminals). Matches the 24-row dock budget: 24 − 8 reserved (editor 3 +
 * footer 1 + status 1 + transcript floor 3) − 10 panel chrome lines = 6.
 * The live path derives the window from the real terminal height via
 * `askUserMaxVisibleForRows`.
 */
export const ASK_USER_MAX_VISIBLE = 6

/**
 * Panel-line overhead inside the dock box: 2 box borders + title(1) + table
 * chrome rules/header(3) + bottom rule(1) + blank(1) + footer(1) = 9 fixed
 * lines, plus 1 line of headroom for a transient hint.
 */
const ASK_USER_VIEW_OVERHEAD = 10

/**
 * Dock rows the ask panel never claims: the editor (3 — border + input +
 * border), the footer (1), the status slot (1) and a transcript floor (3) so
 * the conversation never collapses to nothing while the modal is up.
 */
const ASK_DOCK_RESERVED_ROWS = 8

/**
 * Derive the scroll-window size from the terminal height: the dock stacks
 * (it does not float over the transcript like the old overlay did), so the
 * panel budget is the terminal height minus the reserved dock rows, minus
 * the panel's own chrome. At the 24-row e2e floor this yields exactly
 * ASK_USER_MAX_VISIBLE (6); larger terminals scale up. Without a usable row
 * count it degrades to ASK_USER_MAX_VISIBLE.
 */
export function askUserMaxVisibleForRows(termRows: number | undefined): number {
  if (termRows === undefined || !Number.isFinite(termRows) || termRows <= 0) return ASK_USER_MAX_VISIBLE
  return Math.max(1, Math.floor(termRows) - ASK_DOCK_RESERVED_ROWS - ASK_USER_VIEW_OVERHEAD)
}

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

/**
 * Whole-state of one AskUser overlay. All setters are pure reducers — with
 * ONE deliberate exception: the render pass writes the clamped scroll offset
 * back into `questionsScroll`/`reviewScroll` (see `clampScrollWindow`). The
 * clamp depends on the rendered body height, which only exists at render
 * time; persisting it here makes navigation slide smoothly instead of
 * snapping, and direct render calls simply start from offset 0.
 */
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
  /** Questions-pane scroll offset in rendered body lines (clamped by the render pass, see `clampScrollWindow`). */
  questionsScroll: number
  /** Review-pane scroll offset in rendered rows (same mechanism). */
  reviewScroll: number
}

// ---------------------------------------- pure functions (testable) --

/** Initial state for a `questions` payload — defaults: cursor on Q0/option-0, no edit, no Esc history. */
export function initialState(questions: readonly AskUserQuestionItem[]): AskUserState {
  // Snap the starting cursor onto the first SELECTABLE row: index 0 is the
  // question header (unselectable), and a cursor parked there would render
  // no ▸ marker at all and ignore Enter/digits.
  const rows = buildRowList(questions, questions.map(() => ({ selected: [] })))
  return {
    questions,
    perQuestion: questions.map(() => ({ selected: [] })),
    cursorIndex: nextSelectableIndex(rows, 0, 1),
    customInputs: questions.map(() => null),
    customEditingFor: null,
    phase: 'questions',
    reviewIndex: 0,
    lastEscAt: null,
    cancelHint: false,
    attentionHint: null,
    questionsScroll: 0,
    reviewScroll: 0,
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

/**
 * Leave inline-edit mode; commit when `commit === true` and the buffer is
 * non-empty. Intentionally NEVER triggers auto-submit on its own: submission
 * decisions live exclusively with the callers (`commitCustomAnswer` after an
 * Enter commit, plain navigation after the ↑↓ arrow-exit path), so exiting
 * the editor — especially via arrow keys mid-multi-question flow — can never
 * settle the overlay as a side effect.
 */
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
 * Fold newlines (and the whitespace around them) into single spaces so a
 * label can never break a table row into two rendered lines. Width clipping
 * still happens later via `clipToWidth`.
 */
export function foldText(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ')
}

/**
 * The scroll offset that keeps `cursor` inside `[offset, offset + visibleRows)`
 * for a body of `length` rendered lines — same contract as skills.ts's
 * `clampScrollOffset`, kept local so ask-user scrolling is self-contained.
 * Pure; an empty body or non-positive window pins to 0.
 */
export function clampScrollWindow(cursor: number, visibleRows: number, length: number, currentOffset: number): number {
  if (length <= 0 || visibleRows <= 0) return 0
  if (cursor < currentOffset) return cursor
  if (cursor >= currentOffset + visibleRows) return cursor - visibleRows + 1
  return currentOffset
}

/**
 * 1-based per-question number of the selectable row at `index`: options count
 * `1..N` inside their question and the sentinel continues after them (`N+1`).
 * Header rows and the confirm pseudo-row are unnumbered (null). Pure so both
 * the renderer and tests share one numbering vocabulary.
 */
export function rowNumber(rows: readonly FlatRow[], index: number): number | null {
  const row = rows[index]
  if (row === undefined || !row.selectable || row.kind === 'confirm') return null
  let n = 0
  for (let i = 0; i <= index; i++) {
    const r = rows[i]
    if (r !== undefined && r.selectable && r.kind !== 'confirm' && r.questionIndex === row.questionIndex) n++
  }
  return n
}

/**
 * Inverse of `rowNumber` for the digit quick-pick: the index of the `n`-th
 * numbered row belonging to question `qi`, or -1 when out of range. Rows are
 * scanned in display order, so options come before the question's sentinel.
 */
export function rowIndexForNumber(rows: readonly FlatRow[], qi: number, n: number): number {
  if (!Number.isInteger(n) || n < 1) return -1
  let seen = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row === undefined || !row.selectable || row.kind === 'confirm' || row.questionIndex !== qi) continue
    seen++
    if (seen === n) return i
  }
  return -1
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

/** Render width budget for the questions phase (single flex label column). */
const QUESTIONS_COLUMNS = (): readonly TableColumn[] => [
  { key: 'label', title: 'Selection', flex: true },
]

/** Inline marker shown before a selected option's number (unselected: `○`). */
const OPTION_SELECTED_MARK = '●'
/** Inline marker shown before an unselected option's number. */
const OPTION_UNSELECTED_MARK = '○'

/**
 * Two-column-wide inline state slot rendered between the cursor marker and
 * the per-question number: options carry their selection mark (`●`/`○`),
 * the confirm pseudo-row carries its readiness mark (`✓` when every question
 * is answered), and sentinel rows keep it blank (their committed custom text
 * already carries the `✎` mark inside the label).
 */
function inlineStateSlot(row: FlatRow, isSelectedOption: boolean, allAnswered: boolean): string {
  if (row.kind === 'option') return `${isSelectedOption ? OPTION_SELECTED_MARK : OPTION_UNSELECTED_MARK} `
  if (row.kind === 'confirm') return allAnswered ? '✓ ' : '  '
  return '  '
}

/** Render the questions pane as a flat table line list behind a scroll window. */
export function renderQuestionsView(
  theme: TuiTheme,
  state: AskUserState,
  width: number,
  maxVisible: number = ASK_USER_MAX_VISIBLE,
): string[] {
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

  // Global position among SELECTABLE rows (headers are never counted), so the
  // questions pane and the review page share one (n/m) vocabulary and neither
  // clashes with the per-question numbering printed on the rows themselves.
  let selectableTotal = 0
  let cursorRank = 0
  rows.forEach((row, i) => {
    if (!row.selectable) return
    selectableTotal += 1
    if (i <= state.cursorIndex) cursorRank = selectableTotal
  })

  lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┬'), wrap)))
  lines.push(fns.subtle(clipToWidth(tableHeaderLine(columns, widths), wrap)))
  lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┼'), wrap)))

  // Body lines are collected first because the scroll window slices rendered
  // LINES: option descriptions and header details make line count ≠ row count.
  const visible = Math.max(1, maxVisible)
  const body: string[] = []
  let cursorLine = -1
  // Loop-invariant: readiness mark for the confirm row (pure state read).
  const allAnswered = allQuestionsAnswered(state)

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row === undefined) continue

    if (row.kind === 'question-header') {
      // Header rows: full-width title, skip the table columns. Word-wrapped
      // to the pane width so a long question never overflows the terminal.
      const text = `${foldText(row.label)}  ${foldText(row.description ?? '')}`
      for (const seg of wrapText(text, wrap)) {
        // Wrap plain text FIRST, then apply BOLD — width math on styled
        // strings counts SGR fragments as visible columns.
        body.push(fns.accent(BOLD + clipToWidth(seg, wrap) + RESET))
      }
      // Upstream `detail` is supporting context (mandatory when the question
      // declares an intent) — render it muted below the header, never inside
      // option labels.
      if (row.detail !== undefined && row.detail !== '') {
        for (const seg of wrapText(foldText(row.detail), wrap)) {
          body.push(fns.muted(clipToWidth(seg, wrap)))
        }
      }
      // Visual divider between a question's text and its option list.
      body.push(fns.muted(clipToWidth('─'.repeat(wrap), wrap)))
      continue
    }

    // Blank separator: the confirm pseudo-row is an action zone, not part of
    // any question block — give it its own visual group.
    if (row.kind === 'confirm' && body.length > 0) {
      body.push('')
    }

    const optionLabel = row.kind === 'option'
      ? state.questions[row.questionIndex]?.options?.[row.optionIndex ?? -1]?.label
      : undefined
    const isSelectedOption = optionLabel !== undefined
      && (state.perQuestion[row.questionIndex]?.selected.includes(optionLabel) ?? false)
    const isCustomSentinel = row.kind === 'sentinel'
      && state.perQuestion[row.questionIndex]?.custom !== undefined
      && state.perQuestion[row.questionIndex]?.custom !== ''
    const selected = i === state.cursorIndex && state.customEditingFor === null
    // The actively edited sentinel anchors the scroll window even though the
    // ▸ marker leaves it while editing (selected requires customEditingFor
    // === null). Without this, a digit quick-pick straight onto an
    // out-of-window sentinel opened the editor with cursorLine still -1, the
    // window froze on the previous offset and the edit line was invisible.
    const editingAnchor = !selected && row.kind === 'sentinel'
      && state.customEditingFor === row.questionIndex
    let displayLabel = foldText(row.label)
    if (row.kind === 'sentinel' && state.customEditingFor === row.questionIndex) {
      displayLabel = `${state.customInputs[row.questionIndex] ?? ''}_`
    }
    // Per-question numbering on every numbered row: options 1..N, sentinel N+1;
    // the confirm pseudo-row keeps its fixed ⏎ symbol instead.
    const number = rowNumber(rows, i)
    const numberPrefix = number !== null ? `${number}. ` : ''
    const slot = inlineStateSlot(row, isSelectedOption, allAnswered)
    // Continuation indent aligns wrapped label lines under the first label
    // column (past cursor marker, state slot and number).
    const contentIndent = MARKER_W + slot.length + numberPrefix.length
    const segments = wrapText(displayLabel, Math.max(1, widths[0] - contentIndent + MARKER_W))
    const styleLine = selected || editingAnchor
      ? (line: string): string => fns.accent(BOLD + line + RESET)
      : isSelectedOption || isCustomSentinel ? fns.success : fns.muted
    // First wrapped segment rides in the table row; the rest become indented
    // continuation lines below it.
    const labelCell = padCell(clipToWidth(slot + numberPrefix + (segments[0] ?? ''), widths[0]), widths[0])
    const plain = `${rowMarker(selected)}${labelCell}`
    body.push(styleLine(clipToWidth(plain, wrap)))
    for (const seg of segments.slice(1)) {
      body.push(styleLine(clipToWidth(`${' '.repeat(contentIndent)}${seg}`, wrap)))
    }
    if (selected || editingAnchor) {
      // Anchor the scroll window at the cursor row's LAST rendered line: a
      // wrapped label (or its description lines) renders as several body
      // lines, and anchoring the first one left the continuations below the
      // window when the clamp slid — blind keypresses on invisible rows.
      cursorLine = body.length - 1
    }
    // Option descriptions get their own muted lines under the label
    // (two-line header/detail pattern), word-wrapped like every other text.
    if (row.kind === 'option') {
      const description = state.questions[row.questionIndex]?.options?.[row.optionIndex ?? -1]?.description
      if (description !== undefined && description !== '') {
        for (const seg of wrapText(foldText(description), Math.max(1, wrap - contentIndent))) {
          body.push(fns.muted(clipToWidth(`${' '.repeat(contentIndent)}${seg}`, wrap)))
        }
      }
    }
  }

  // Scroll window (skills-manager scrollToCursor pattern): clamp the persisted
  // offset so the cursor line always sits inside the visible slice. Written
  // back into the panel-owned state so navigation slides smoothly instead of
  // snapping; direct render calls simply start from offset 0.
  const prevOffset = Math.max(0, state.questionsScroll)
  const offset = clampScrollWindow(cursorLine < 0 ? prevOffset : cursorLine, visible, body.length, prevOffset)
  state.questionsScroll = offset
  lines.push(...body.slice(offset, offset + visible))
  const overflow = body.length > visible

  lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┴'), wrap)))
  return finalizeQuestionsView(
    fns,
    wrap,
    lines,
    state,
    overflow ? ` (${cursorRank}/${selectableTotal})` : '',
  )
}

function finalizeQuestionsView(
  fns: ReturnType<typeof panelThemeFns>,
  wrap: number,
  lines: string[],
  state: AskUserState,
  scrollInfo = '',
): string[] {
  if (state.attentionHint !== null) {
    lines.push(fns.attention(clipToWidth(state.attentionHint, wrap)))
  }
  if (state.cancelHint) {
    lines.push(fns.attention(clipToWidth('Press Esc again to decline', wrap)))
  }
  lines.push('')
  const footer = state.customEditingFor !== null
    ? 'Type free text · Enter keep · ↑↓ move · Esc abandon edit'
    : `↑↓ navigate · Enter ${needsConfirmRow(state.questions) ? 'toggle / confirm' : 'select'} · 1-9 pick · Esc decline`
  // The (n/m) readout goes FIRST so narrow terminals clip the hint, never
  // the scroll info.
  lines.push(fns.subtle(clipToWidth(scrollInfo + footer, wrap)))
  return lines
}

// -------------------------------------------------- render: review phase --

/** Render the review page for multi-question overlays (scroll-windowed). */
export function renderReviewView(
  theme: TuiTheme,
  state: AskUserState,
  width: number,
  maxVisible: number = ASK_USER_MAX_VISIBLE,
): string[] {
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
  // Review rows render one line each, so the window slices rows directly.
  const visible = Math.max(1, maxVisible)
  const body: string[] = []
  state.questions.forEach((question, qi) => {
    const answer = state.perQuestion[qi]
    const left = `${question.header ?? `Q${qi + 1}`}  ${foldText(question.question)}`
    const right = formatAnswerForReview(answer)
    const selected = qi === state.reviewIndex
    const leftCell = padCell(clipToWidth(left, widths[0]), widths[0])
    const rightCell = padCell(clipToWidth(right, widths[1]), widths[1])
    const plain = `${rowMarker(selected)}${leftCell}${TABLE_SEP}${rightCell}`
    const line = clipToWidth(plain, wrap)
    body.push(selected ? fns.accent(BOLD + line + RESET) : fns.muted(line))
  })
  // Submit row (review pane).
  {
    const selected = state.reviewIndex === state.questions.length
    const leftCell = padCell(clipToWidth('Submit answers', widths[0]), widths[0])
    const rightCell = padCell(clipToWidth(allQuestionsAnswered(state) ? '✓ ready' : '— incomplete', widths[1]), widths[1])
    const plain = `${rowMarker(selected)}${leftCell}${TABLE_SEP}${rightCell}`
    const line = clipToWidth(plain, wrap)
    body.push(selected ? fns.accent(BOLD + line + RESET) : fns.muted(line))
  }
  const prevOffset = Math.max(0, state.reviewScroll)
  const offset = clampScrollWindow(state.reviewIndex, visible, body.length, prevOffset)
  state.reviewScroll = offset
  lines.push(...body.slice(offset, offset + visible))
  lines.push(fns.subtle(clipToWidth(tableRuleLine(widths, '┴'), wrap)))
  if (state.attentionHint !== null) {
    lines.push(fns.attention(clipToWidth(state.attentionHint, wrap)))
  }
  lines.push('')
  const footer = '↑↓ select · Enter return to edit / submit'
  const scrollInfo = body.length > visible ? ` (${state.reviewIndex + 1}/${body.length})` : ''
  lines.push(fns.subtle(clipToWidth(scrollInfo + footer, wrap)))
  return lines
}

function formatAnswerForReview(answer: PendingAnswer | undefined): string {
  if (answer === undefined) return ''
  // Fold newlines exactly like the questions pane (foldText): an answer cell
  // renders as ONE table row, and a bare \n inside it would split the row.
  if (answer.custom !== undefined && answer.custom !== '') return foldText(`${CUSTOM_MARK}${answer.custom}`)
  if (answer.selected.length === 0) return '(no answer)'
  return foldText(answer.selected.join(', '))
}

// ------------------------------------------------------------ panel --

/** Options for assembling the panel + provider function. */
export interface AskUserPanelDeps {
  tui: TUI
  /** Live theme getter — re-read on every render so a mid-panel hot-swap applies (borders included). */
  theme: () => TuiTheme
  /** Re-focus the current editor on panel close. */
  restoreFocus: () => void
  /**
   * Mount the panel component into the dock slot above the chat input (the
   * Todos-panel slot); returns the unmount function. The panel is NOT an
   * overlay — it renders pinned above the editor like the live widgets.
   */
  mount: (component: Component) => () => void
  /**
   * Declare the docked modal's keyboard ownership. While active, the app
   * keymap treats the panel exactly like an open overlay (app keys and the
   * Esc/Ctrl+C chains yield to the focused panel) and `refocusEditor` must
   * not steal focus from it.
   */
  setModalActive: (active: boolean) => void
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number
}

/** Result promise from `openAskUserPanel`. Declined carries the canonical decline envelope. */
export type AskUserResult = AskUserQuestionAnswer

/**
 * Open the AskUser docked panel for one set of questions.
 *
 * `signal` is the caller's abort signal (the tool execution's). Already-aborted
 * settles declined WITHOUT mounting a panel; a live signal closes the panel
 * and settles declined when it fires. We resolve the declined envelope rather
 * than rejecting with the upstream ASK_ABORTED code on purpose: the upstream
 * service already screens entry-time aborts, and a step aborted after this
 * point discards the tool result anyway — resolving keeps the pending promise
 * from ever hanging either way.
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

    /**
     * Terminal close: unmount the dock panel, clear the modal flag (BEFORE
     * restoreFocus so refocusEditor's guard sees the modal gone), and hand
     * the keyboard back. An overlay that was open when the panel mounted was
     * dismissed then (see below), so focus lands on the current editor.
     */
    const close = (): void => {
      unmount()
      deps.setModalActive(false)
      deps.restoreFocus()
    }
    const settle = (envelope: AskUserQuestionAnswer): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(envelope)
    }
    const onAbort = (): void => {
      settle(buildDeclinedEnvelope(questions))
      close()
    }

    const panel: Component = {
      invalidate() { /* frames are re-rendered on demand */ },
      render(width: number): string[] {
        const theme = deps.theme()
        // Terminal-height-adaptive scroll window: the dock stacks with the
        // editor/footer/transcript, so the budget subtracts the reserved rows
        // (see askUserMaxVisibleForRows). Fake TUIs without a `terminal`
        // degrade to ASK_USER_MAX_VISIBLE.
        const maxVisible = askUserMaxVisibleForRows(
          (deps.tui as { terminal?: { rows?: number } }).terminal?.rows,
        )
        // Todos-panel box language: full-width bordered panel pinned above
        // the chat input. The inner views clip to the box's inner budget.
        const boxWidth = panelBoxWidth(width)
        const borderFg = ansiFg(theme.palette.borderDefault)
        const innerWidth = Math.max(2, boxWidth - 4)
        const inner = state.phase === 'review'
          ? renderReviewView(theme, state, innerWidth, maxVisible)
          : renderQuestionsView(theme, state, innerWidth, maxVisible)
        return [
          panelTopBorder(boxWidth, borderFg),
          ...inner.map(line => borderedRow(boxWidth, borderFg, line)),
          panelBottomBorder(boxWidth, borderFg),
        ]
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
        // Digit quick-pick: jump the cursor to the numbered row and activate
        // it (same path as Enter — toggles an option / opens the sentinel
        // edit). Only outside inline editing; digits feed the buffer there.
        if (data.length === 1 && data >= '1' && data <= '9') {
          handleDigitSelect(state, Number(data))
          return
        }
        if (kb.matches(data, 'tui.select.cancel')) {
          const now = clock()
          const prevState: AskUserState = { ...state }
          const after = advanceDoubleEsc(state, now)
          Object.assign(state, after)
          if (didDoubleEscFire(prevState, state, now)) {
            settle(buildDeclinedEnvelope(questions))
            close()
          }
          return
        }
      },
    }

    // Mount the docked panel and take the keyboard. A capturing overlay that
    // is up when the question arrives (queue panel, route dialog) would keep
    // floating OVER the dock with a dead keyboard — the ask panel is a hard
    // modal that outranks it, so dismiss it first (hideOverlay restores its
    // own focus chain; setFocus below takes over regardless).
    const unmount = deps.mount(panel)
    deps.tui.hideOverlay()
    deps.tui.setFocus(panel)
    deps.setModalActive(true)
    signal?.addEventListener('abort', onAbort, { once: true })

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
      // nextSelectableIndex scans from `from + direction`, so it must receive
      // the raw cursor — passing cursor+direction double-stepped every press
      // (masked for years by the initial cursor parking on the header row).
      const next = nextSelectableIndex(rows, s.cursorIndex, direction)
      Object.assign(s, { cursorIndex: next, cancelHint: false, attentionHint: null })
    }

    /**
     * Digit quick-pick: move the cursor onto the `digit`-th numbered row of
     * the question the cursor currently sits in, then run the normal confirm
     * path (toggle / open sentinel edit). Out-of-range digits and presses on
     * the confirm row are ignored — there is no question to target.
     */
    function handleDigitSelect(s: AskUserState, digit: number): void {
      // Digits only mean quick-pick while the questions pane is up; in the
      // review phase they must be a no-op instead of relying on incidental
      // cursor invariants.
      if (s.phase !== 'questions') return
      const rows = buildRowList(s.questions, s.perQuestion)
      const anchor = rows[s.cursorIndex]
      if (anchor === undefined || anchor.kind === 'confirm' || anchor.questionIndex < 0) return
      const target = rowIndexForNumber(rows, anchor.questionIndex, digit)
      if (target < 0) return
      s.cursorIndex = target
      handleConfirm(s)
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
        close()
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
          close()
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
      // ↑↓ never get swallowed by the edit: leave the editor first (committing
      // a non-empty buffer — the "Enter keep" semantics), then navigate.
      if (kb.matches(data, 'tui.select.up') || kb.matches(data, 'tui.select.down')) {
        Object.assign(s, exitCustomEdit(s, true))
        moveCursor(s, kb.matches(data, 'tui.select.up') ? -1 : 1)
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
        close()
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
 * - missing service → one notice + no-op disposer. The tool stays mounted by the
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
    // Through the shared notice bridge (src/notice-bridge.ts), never raw
    // stderr: the TUI owns the terminal, and this registers during
    // startup — possibly before the first frame.
    emitNotice('ctx.userQuestions not mounted — ask_user_question calls will fail with NO_PROVIDER')
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
