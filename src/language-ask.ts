/**
 * The `/language` ask-user flow: the command presents the installed UI
 * languages as a native ask-user question instead of a bespoke picker.
 *
 * Why the ask seam rather than an overlay: the question renders as the same
 * docked panel every model ask uses (same keyboard model, same fold, same
 * auto-answer rules) and goes through the answerer pipeline, so it answers
 * on ANY registered surface — the TUI, or the operator's phone through
 * dsh-feishu — with first-answer-wins. Nothing here depends on a UI; the
 * structural seam views below keep this module free of host type imports
 * beyond the question shapes.
 *
 * Ordering contract: the ask panel's no-input timeout picks the FIRST option
 * (the ask tool's convention puts the recommendation first), so the CURRENT
 * language leads the list — an ask nobody answers keeps the language instead
 * of switching it to whatever sorts first.
 */

import type { AskUserQuestionItem, AskUserQuestionOption } from '@deepseek-ai/dsh-user-questions'
import { DECLINE_MESSAGE } from './ask-user.ts'
import { currentLocale, listLocales, t } from './i18n/index.ts'

/** Question id of the /language ask (the answer envelope echoes it back). */
export const LANGUAGE_QUESTION_ID = 'language'

/** One selectable language: the id is the wire value, the name is display. */
export interface LanguageChoice {
  id: string
  name: string
}

/** The ask-panel label of one choice. The id is part of it: labels are the
 *  answer's only payload, and two language files may share a display name. */
export function languageChoiceLabel(choice: LanguageChoice): string {
  return `${choice.name} (${choice.id})`
}

/**
 * The choices in ask order: the current language first (see the module
 * header — the timeout auto-answer picks the first option), then the rest in
 * the registry's id order.
 */
export function languageChoices(): { current: LanguageChoice; options: LanguageChoice[] } {
  const current = currentLocale()
  const all = listLocales()
  return {
    current,
    options: [
      ...all.filter(locale => locale.id === current.id),
      ...all.filter(locale => locale.id !== current.id),
    ],
  }
}

/**
 * Build the ask question plus the label→id table its answer resolves
 * against. The current language's option carries a `description` marker; its
 * position (first) is what makes the timeout a no-op.
 */
export function buildLanguageQuestion(): { question: AskUserQuestionItem; options: LanguageChoice[] } {
  const { current, options } = languageChoices()
  const marker = t('ask.language.current')
  return {
    question: {
      id: LANGUAGE_QUESTION_ID,
      header: t('ask.language.header'),
      question: t('ask.language.question'),
      detail: t('ask.language.detail', { current: languageChoiceLabel(current) }),
      options: options.map((choice): AskUserQuestionOption => ({
        label: languageChoiceLabel(choice),
        ...(choice.id === current.id ? { description: marker } : {}),
      })),
    },
    options,
  }
}

/** Structural view of one answered item — surfaces may omit `selected`. */
export interface LanguageAnswerItem {
  id?: unknown
  selected?: readonly string[]
  custom?: string
}

/** What one answer means for the command. */
export type LanguageOutcome =
  | { kind: 'picked'; id: string }
  | { kind: 'unchanged' }
  | { kind: 'declined' }
  | { kind: 'unknown'; text: string }

/**
 * Resolve one answer item against the choices the question offered.
 *
 * Precedence: selected labels (the pick path) → custom text (the panel's
 * free-text row, matched by id, then display name, then label, all
 * case-insensitive) → declined. The timeout auto-answer arrives as the first
 * option's label plus a note in `custom`, so it resolves through the pick
 * path to the current language — `unchanged`.
 */
export function resolveLanguageAnswer(
  answer: LanguageAnswerItem | undefined,
  options: readonly LanguageChoice[],
): LanguageOutcome {
  if (answer === undefined) return { kind: 'declined' }
  const settle = (choice: LanguageChoice): LanguageOutcome =>
    choice.id === currentLocale().id ? { kind: 'unchanged' } : { kind: 'picked', id: choice.id }

  const selected = answer.selected ?? []
  const label = selected[0]
  if (label !== undefined) {
    // Labels carry the id, so the match is exact; an unrecognized label came
    // from somewhere that did not echo our options — report it verbatim.
    const match = options.find(choice => languageChoiceLabel(choice) === label)
    return match === undefined ? { kind: 'unknown', text: label } : settle(match)
  }

  const custom = (answer.custom ?? '').trim()
  // The panel's decline path rides `custom` (empty selections + the canonical
  // decline message); a blank answer is the same non-answer.
  if (custom === '' || custom === DECLINE_MESSAGE) return { kind: 'declined' }
  const folded = custom.toLowerCase()
  const byId = options.find(choice => choice.id.toLowerCase() === folded)
    ?? options.find(choice => choice.name.toLowerCase() === folded)
    ?? options.find(choice => languageChoiceLabel(choice).toLowerCase() === folded)
  return byId === undefined ? { kind: 'unknown', text: custom } : settle(byId)
}

/** Structural view of `ctx.userQuestions` — the one method this flow needs. */
export interface AskSeam {
  ask(request: {
    questions: AskUserQuestionItem[]
    agent?: unknown
    signal?: AbortSignal
  }): Promise<{ answers?: readonly LanguageAnswerItem[] }>
}

/**
 * Ask the user to pick a UI language through the native ask seam. Resolves
 * with the outcome of the answer; rejects when the ask itself fails (no
 * answerer accepted the request, the ask was aborted) — the caller owns the
 * receipt text for both.
 *
 * @param context.agent - the live session's agent when one exists: the ask
 *   then routes to the surfaces driving that session. A fresh TUI asks
 *   agentless, which fans out to every registered surface.
 */
export async function askLanguageChoice(
  ask: AskSeam,
  context: { agent?: unknown; signal?: AbortSignal } = {},
): Promise<LanguageOutcome> {
  const { question, options } = buildLanguageQuestion()
  const answer = await ask.ask({
    questions: [question],
    ...(context.agent === undefined ? {} : { agent: context.agent }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
  const answers = answer.answers ?? []
  const item = answers.find(candidate => candidate.id === LANGUAGE_QUESTION_ID) ?? answers[0]
  return resolveLanguageAnswer(item, options)
}
