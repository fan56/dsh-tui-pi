/**
 * /language ask-flow tests — the question built for the native ask-user
 * panel and the resolution of its answer back into a command outcome. Pure
 * functions over the built lib/ (pnpm build && pnpm test); the ask seam is a
 * stub, so no TUI is needed.
 *
 * The two contract points pinned here:
 *   1. the CURRENT language leads the option list — the ask panel's no-input
 *      timeout takes the FIRST option, so an unanswered ask must be a no-op,
 *      not an accidental switch to whatever sorts first;
 *   2. every answer shape the seam can produce (selected label, free-text id
 *      or display name, the decline envelope, a stray value) maps to exactly
 *      one outcome.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DECLINE_MESSAGE } from '../lib/ask-user.js'
import { initI18n, t } from '../lib/i18n/index.js'
import {
  LANGUAGE_QUESTION_ID,
  askLanguageChoice,
  buildLanguageQuestion,
  languageChoiceLabel,
  resolveLanguageAnswer,
} from '../lib/language-ask.js'

/** A temp DSH_HOME carrying a user locale, so the registry has >1 language. */
function seedLocales() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tui-langask-'))
  const dir = join(home, 'locales')
  mkdirSync(dir)
  writeFileSync(join(dir, 'de.json'), JSON.stringify({ name: 'Deutsch' }))
  return home
}

/** The ask seam stub: records the request, answers with `answers`. */
function stubSeam(answers) {
  const requests = []
  return {
    requests,
    ask: async request => {
      requests.push(request)
      return { answers }
    },
  }
}

test('the question offers every language, current first, and tags the current one', () => {
  initI18n({ home: seedLocales(), id: 'ja' })
  const { question, options } = buildLanguageQuestion()
  assert.equal(question.id, LANGUAGE_QUESTION_ID)
  assert.equal(question.header, t('ask.language.header'))
  assert.equal(question.options?.[0]?.label, '日本語 (ja)', 'current language leads (timeout is a no-op)')
  assert.equal(question.options?.[0]?.description, t('ask.language.current'), 'current row is tagged')
  assert.ok(question.options?.some(option => option.label === 'Deutsch (de)'), 'other languages listed')
  assert.ok(question.detail?.includes('日本語 (ja)'), 'detail names the current language')
  const ids = options.map(choice => choice.id)
  assert.equal(ids[0], 'ja')
  assert.equal(new Set(ids).size, ids.length, 'no duplicate choices')
})

test('picking another language resolves to that id', () => {
  initI18n({ home: seedLocales(), id: 'en' })
  const { options } = buildLanguageQuestion()
  const label = languageChoiceLabel(options.find(choice => choice.id === 'zh-CN'))
  assert.deepEqual(
    resolveLanguageAnswer({ id: LANGUAGE_QUESTION_ID, selected: [label] }, options),
    { kind: 'picked', id: 'zh-CN' },
  )
})

test('picking the CURRENT language is unchanged, not a rewrite', () => {
  initI18n({ home: seedLocales(), id: 'en' })
  const { options } = buildLanguageQuestion()
  assert.deepEqual(
    resolveLanguageAnswer({ id: LANGUAGE_QUESTION_ID, selected: ['English (en)'] }, options),
    { kind: 'unchanged' },
  )
})

test('free text matches by id, display name, or label — case-insensitively', () => {
  initI18n({ home: seedLocales(), id: 'en' })
  const { options } = buildLanguageQuestion()
  const byId = resolveLanguageAnswer({ id: LANGUAGE_QUESTION_ID, selected: [], custom: 'zh-cn' }, options)
  const byName = resolveLanguageAnswer({ id: LANGUAGE_QUESTION_ID, selected: [], custom: 'deutsch' }, options)
  const byLabel = resolveLanguageAnswer({ id: LANGUAGE_QUESTION_ID, selected: [], custom: 'Deutsch (de)' }, options)
  assert.deepEqual(byId, { kind: 'picked', id: 'zh-CN' })
  assert.deepEqual(byName, { kind: 'picked', id: 'de' })
  assert.deepEqual(byLabel, { kind: 'picked', id: 'de' })
})

test('the decline envelope (empty selection + canonical message) is a decline', () => {
  initI18n({ home: seedLocales(), id: 'en' })
  const { options } = buildLanguageQuestion()
  assert.deepEqual(resolveLanguageAnswer({ id: LANGUAGE_QUESTION_ID, selected: [], custom: DECLINE_MESSAGE }, options), { kind: 'declined' })
  assert.deepEqual(resolveLanguageAnswer({ id: LANGUAGE_QUESTION_ID, selected: [] }, options), { kind: 'declined' })
  assert.deepEqual(resolveLanguageAnswer(undefined, options), { kind: 'declined' })
})

test('an unrecognized pick or free text surfaces as unknown (verbatim)', () => {
  initI18n({ home: seedLocales(), id: 'en' })
  const { options } = buildLanguageQuestion()
  assert.deepEqual(
    resolveLanguageAnswer({ id: LANGUAGE_QUESTION_ID, selected: ['Klingon (tlh)'] }, options),
    { kind: 'unknown', text: 'Klingon (tlh)' },
  )
  assert.deepEqual(
    resolveLanguageAnswer({ id: LANGUAGE_QUESTION_ID, selected: [], custom: 'nope' }, options),
    { kind: 'unknown', text: 'nope' },
  )
})

test('askLanguageChoice passes agent/signal through and resolves the answer item', async () => {
  initI18n({ home: seedLocales(), id: 'en' })
  const agent = { session: { id: 's1' } }
  const controller = new AbortController()
  const seam = stubSeam([{ id: LANGUAGE_QUESTION_ID, selected: ['한국어 (ko)'] }])
  const outcome = await askLanguageChoice(seam, { agent, signal: controller.signal })
  assert.deepEqual(outcome, { kind: 'picked', id: 'ko' })
  assert.equal(seam.requests.length, 1)
  assert.equal(seam.requests[0].agent, agent)
  assert.equal(seam.requests[0].signal, controller.signal)
  assert.equal(seam.requests[0].questions.length, 1)
})

test('askLanguageChoice treats a missing answers array as declined', async () => {
  initI18n({ home: seedLocales(), id: 'en' })
  const empty = await askLanguageChoice(stubSeam(undefined), {})
  assert.deepEqual(empty, { kind: 'declined' })
})
