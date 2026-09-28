import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  AttentionBoard,
  ATTENTION_CRITICAL_AT,
  ATTENTION_WARN_AT,
  heuristicAttentionScore,
  tierFor,
  heuristicTag,
} from '../lib/attention.js'
import {
  buildAttentionQuestions,
  buildAttentionState,
  createJevAttentionSource,
  parseAttentionAnswers,
  SPINNING_TAG_AT,
} from '../lib/attention-jev.js'

// ---- pure scoring -------------------------------------------------------

const baseInput = { stallMs: 0, rounds: 0, cap: 75, ignoredInjection: false, retries: 0 }

test('heuristic score: a fresh idle child scores 0/ok', () => {
  const score = heuristicAttentionScore(baseInput)
  assert.equal(score, 0)
  assert.equal(tierFor(score), 'ok')
})

test('heuristic score: stall ramps between floor and ceiling', () => {
  assert.equal(heuristicAttentionScore({ ...baseInput, stallMs: 30_000 }), 0, 'under the floor')
  const mid = heuristicAttentionScore({ ...baseInput, stallMs: 330_000 }) // halfway up the ramp
  assert.ok(mid >= 0.22 && mid <= 0.23, `mid ramp ≈ 0.225 (2dp), got ${mid}`)
  const full = heuristicAttentionScore({ ...baseInput, stallMs: 1_200_000 })
  assert.equal(full, 0.45, 'past the ceiling the stall component alone is the full 0.45 weight')
  assert.equal(tierFor(full), 'warn')
})

test('heuristic score: rounds ratio stacks toward the cap', () => {
  const score = heuristicAttentionScore({ ...baseInput, rounds: 75, cap: 75, stallMs: 1_200_000 })
  assert.equal(score, 0.7, 'stall 0.45 + rounds 0.25')
  assert.equal(tierFor(score), 'critical')
})

test('heuristic score: unanswered injection and retries add their weights', () => {
  const score = heuristicAttentionScore({ ...baseInput, stallMs: 1_200_000, ignoredInjection: true, retries: 3 })
  assert.equal(score, 0.7, 'stall 0.45 + ignored 0.15 + retries 0.10')
})

test('heuristic score: unlimited cap drops the rounds component', () => {
  assert.equal(heuristicAttentionScore({ ...baseInput, rounds: 500, cap: 0 }), 0)
})

test('heuristic score: context ratio contributes its small weight', () => {
  const score = heuristicAttentionScore({ ...baseInput, contextRatio: 1 })
  assert.equal(score, 0.05)
})

test('tiers cut at the documented thresholds', () => {
  assert.equal(tierFor(ATTENTION_WARN_AT), 'warn')
  assert.equal(tierFor(ATTENTION_WARN_AT - 0.01), 'ok')
  assert.equal(tierFor(ATTENTION_CRITICAL_AT), 'critical')
})

test('heuristic tag: near-cap beats stalled; a warn-tier score without a dominant factor still names stalled', () => {
  assert.equal(heuristicTag({ ...baseInput, rounds: 70, cap: 75, stallMs: 500_000 }, 0.5), 'near-cap')
  assert.equal(heuristicTag({ ...baseInput, stallMs: 500_000 }, 0.3), 'stalled')
  assert.equal(heuristicTag(baseInput, 0), undefined)
})

// ---- board --------------------------------------------------------------

function makeView(overrides = {}) {
  return {
    childId: overrides.childId ?? 'aaaaaaaa-1111',
    label: overrides.label ?? 'child-a',
    startedAt: overrides.startedAt ?? 1_000,
    rounds: overrides.rounds ?? 0,
    tokens: overrides.tokens ?? 0,
    retries: overrides.retries ?? 0,
    contextTokens: overrides.contextTokens ?? 0,
    ...(overrides.contextWindow !== undefined ? { contextWindow: overrides.contextWindow } : {}),
    ...(overrides.injectedAt !== undefined ? { injectedAt: overrides.injectedAt } : {}),
    ...(overrides.mode !== undefined ? { mode: overrides.mode } : {}),
    ...(overrides.outcome !== undefined ? { outcome: overrides.outcome } : {}),
  }
}

function boardWithClock() {
  let now = 1_000_000
  const board = new AttentionBoard(() => now)
  return { board, advance: (ms) => { now += ms } }
}

test('board: fresh child starts ok; a stalled child climbs without any jev layer', () => {
  const { board, advance } = boardWithClock()
  board.update([makeView()], 75)
  assert.equal(board.get('aaaaaaaa-1111')?.score, 0)
  advance(1_200_000)
  board.update([makeView()], 75)
  const row = board.rows()[0]
  assert.equal(row.info.tier, 'warn')
  assert.equal(row.info.source, 'heuristic')
  assert.ok(row.stallMs >= 1_200_000)
})

test('board: progress resets the stall clock; jev judgment survives only until progress', () => {
  const { board, advance } = boardWithClock()
  const view = makeView()
  board.update([view], 75)
  advance(120_000)
  board.update([view], 75)
  board.applyJevScores([['aaaaaaaa-1111', 0.9, 'spinning']])
  assert.equal(board.get('aaaaaaaa-1111')?.source, 'jev')
  assert.equal(board.get('aaaaaaaa-1111')?.tag, 'spinning')
  // New rounds = new state: the snapshot judgment is stale, heuristic resumes.
  board.update([{ ...view, rounds: 3, tokens: 500 }], 75)
  assert.equal(board.get('aaaaaaaa-1111')?.source, 'heuristic')
})

test('board: dirty tracking drives the jev work list and is cleared by coverage', () => {
  const { board } = boardWithClock()
  board.update([makeView()], 75)
  assert.deepEqual(board.dirtyChildren(), ['aaaaaaaa-1111'])
  board.applyJevScores([['aaaaaaaa-1111', 0.2, undefined]])
  assert.deepEqual(board.dirtyChildren(), [])
})

test('board: settled children are pruned, not ranked', () => {
  const { board } = boardWithClock()
  board.update([makeView()], 75)
  board.update([makeView({ outcome: 'completed' })], 75)
  assert.equal(board.get('aaaaaaaa-1111'), undefined)
  assert.deepEqual(board.rows(), [])
})

test('board: topHint only speaks when something ranks above ok', () => {
  const { board, advance } = boardWithClock()
  assert.equal(board.topHint(), undefined)
  board.update([makeView({ label: 'grinder' }), makeView({ childId: 'bbbbbbbb-2222', label: 'stalled-one' })], 75)
  advance(1_200_000)
  board.update([makeView({ label: 'grinder' }), makeView({ childId: 'bbbbbbbb-2222', label: 'stalled-one' })], 75)
  const hint = board.topHint()
  assert.ok(hint?.label === 'grinder' || hint?.label === 'stalled-one')
  assert.match(hint.detail, /score 0\.\d\d/)
  // The jev layer can take over the top slot.
  board.applyJevScores([['bbbbbbbb-2222', 0.95, 'spinning']])
  assert.equal(board.topHint()?.label, 'stalled-one')
  assert.match(board.topHint().detail, /spinning/)
})

test('board: rows come back highest-score first', () => {
  const { board, advance } = boardWithClock()
  board.update([
    makeView({ childId: 'cccccccc-3333', label: 'c' }),
    makeView({ childId: 'dddddddd-4444', label: 'd' }),
  ], 75)
  board.applyJevScores([['dddddddd-4444', 0.9, undefined]])
  assert.equal(board.rows()[0].label, 'd')
})

// ---- jev source ---------------------------------------------------------

function liveViews(...ids) {
  // ids are the 8-char id8 forms; childIds carry a suffix like real session ids.
  return ids.map((id, index) => makeView({ childId: `${id}-extra`, label: `child-${id.slice(0, 4)}`, startedAt: index }))
}

test('jev source: dispatches one batched call for dirty children, applies verdicts, tags spinning at the high segment', async () => {
  let now = 1_000_000
  const board = new AttentionBoard(() => now)
  const views = liveViews('aaaaaaaa', 'bbbbbbbb')
  board.update(views, 75)
  const calls = []
  const source = createJevAttentionSource({
    modeReader: () => 'auto',
    now: () => now,
    minIntervalMs: 1,
    module: {
      async classify(options) {
        calls.push(options)
        return {
          answers: {
            attention_aaaaaaaa: { value: 0.2 },
            spin_aaaaaaaa: { value: 0.1 },
            attention_bbbbbbbb: { value: 0.85 },
            spin_bbbbbbbb: { value: SPINNING_TAG_AT },
          },
          model: 'jev-1.13.0',
          usage: null,
          latencyMs: 5,
        }
      },
      isConfigured: () => true,
    },
  })
  source.tick(board, views, 75)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(calls.length, 1, 'one batched call for both children')
  assert.deepEqual(
    Object.keys(calls[0].questions).sort(),
    ['attention_aaaaaaaa', 'attention_bbbbbbbb', 'spin_aaaaaaaa', 'spin_bbbbbbbb'],
  )
  assert.match(calls[0].state, /aaaaaaaa child-aaaa/)
  assert.equal(board.get('aaaaaaaa-extra').source, 'jev')
  assert.equal(board.get('aaaaaaaa-extra').score, 0.2)
  assert.equal(board.get('bbbbbbbb-extra').tag, 'spinning')
  assert.equal(board.dirtyChildren().length, 0, 'covered children lose their dirty flag')
  // Debounce: a fresh dirty child inside the window does not re-dispatch...
  board.update(views.map((view, index) => ({ ...view, rounds: 5 + index, tokens: 100 })), 75)
  assert.equal(board.dirtyChildren().length, 2, 'progress re-dirties')
  source.tick(board, views, 75)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(calls.length, 1, 'min interval holds')
  // ...and a failed call is a silent counter, never a throw nor a heuristic clobber.
  now += 60_000
  const failing = createJevAttentionSource({
    modeReader: () => 'auto',
    now: () => now,
    minIntervalMs: 1,
    module: {
      classify: async () => { throw Object.assign(new Error('boom'), { code: 'http' }) },
      isConfigured: () => true,
    },
  })
  const scoresBefore = board.rows().map(row => row.info.score).join()
  failing.tick(board, views, 75)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(failing.failures(), 1)
  assert.equal(board.rows().map(row => row.info.score).join(), scoresBefore, 'ranking untouched on failure')
})

test('jev source: silence rules — mode off, nothing dirty, unconfigured', async () => {
  const board = new AttentionBoard(() => 1_000_000)
  const views = liveViews('aaaa')
  board.update(views, 75)
  const calls = []
  const make = (mode, isConfigured) => {
    const source = createJevAttentionSource({
      modeReader: () => mode,
      minIntervalMs: 1,
      module: {
        classify: async (options) => {
          calls.push(options)
          return { answers: { attention_aaaa: { value: 0.5 }, spin_aaaa: { value: 0 } }, model: 'm', usage: null, latencyMs: 1 }
        },
        isConfigured,
      },
    })
    return source
  }
  make('off', () => true).tick(board, views, 75)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(calls.length, 0, 'mode off: silent')
  make('auto', () => false).tick(board, views, 75)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(calls.length, 0, 'unconfigured: silent')
  const clean = new AttentionBoard(() => 1_000_000)
  make('auto', () => true).tick(clean, views, 75)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(calls.length, 0, 'nothing dirty: no dispatch')
})

test('jev source: parse maps id8 → childId and only tags spinning at the high segment', () => {
  const id8ToChild = new Map([['aaaaaaaa', 'aaaaaaaa-extra']])
  const verdicts = parseAttentionAnswers(
    { attention_aaaaaaaa: { value: 0.7 }, spin_aaaaaaaa: { value: SPINNING_TAG_AT - 0.01 } },
    id8ToChild,
  )
  assert.equal(verdicts[0][1], 0.7)
  assert.equal(verdicts[0][2], undefined, 'middle spin values are uncertainty, never the tag')
  const tagged = parseAttentionAnswers(
    { attention_aaaaaaaa: { value: 0.7 }, spin_aaaaaaaa: { value: 0.9 } },
    id8ToChild,
  )
  assert.equal(tagged[0][2], 'spinning')
})

test('jev source: questions carry both atoms per child with two-sided criteria', () => {
  const questions = buildAttentionQuestions(['aaaa'])
  assert.deepEqual(Object.keys(questions), ['attention_aaaa', 'spin_aaaa'])
  for (const question of Object.values(questions)) {
    assert.equal(question.type, 'noul')
    assert.ok(question.criteria.true && question.criteria.false, 'two-sided criteria — calibration contract')
  }
})

test('jev source: state table is compact, factual, and hard-capped', () => {
  const views = liveViews('aaaaaaaa', 'bbbbbbbb')
  const state = buildAttentionState(views, 75, 1_000_000, () => 240_000)
  assert.match(state, /aaaaaaaa child-aaaa \| rounds 0\/75 \| idle 240s/)
  assert.ok(state.length <= 1000)
  const unlimited = buildAttentionState(views, 0, 1_000_000, () => 240_000)
  assert.match(unlimited, /rounds 0\/∞/, 'unlimited cap renders as ∞')
  const huge = Array.from({ length: 200 }, (_, index) => makeView({ childId: `${String(index).padStart(8, 'f')}-0000`, label: `x`.repeat(200) }))
  assert.ok(buildAttentionState(huge, 75, 0, () => 0).length <= 1000)
})
