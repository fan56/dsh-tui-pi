/**
 * Preset-switch confirmation tests — the pure reducer + panel of
 * src/preset-dialog.ts (the /resume repair-dialog pattern), the injectable
 * `performPresetSwitch` three-way flow (fork / fresh / cancel) and the
 * `completedTurnSeed` slice that feeds the fork. Runs against the built
 * lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { lightTheme } from '../lib/theme/index.js'
import {
  completedTurnSeed,
  initialPresetConfirmState,
  performPresetSwitch,
  PresetConfirmPanel,
  presetConfirmBody,
  presetConfirmOptions,
  presetConfirmTitle,
  presetConfirmOutcome,
  presetConfirmWording,
  updatePresetConfirm,
} from '../lib/preset-dialog.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

const ENTER = '\r'
const ESC = '\x1b'
const DOWN = '\x1b[B'
const UP = '\x1b[A'

const roster = [
  { id: 'standard', name: 'Standard', trust: 'system', isDefault: true },
  { id: 'minimal', name: 'Minimal', trust: 'user', isDefault: false },
]

// ----------------------------------------------------------------- wording --

test('wording: switch vs restart titles, option prefixes, two body points, no handoff', () => {
  const move = presetConfirmWording('Minimal', false)
  assert.equal(presetConfirmTitle(move), '● Switch preset to Minimal?')
  assert.equal(move.firstPoint, 'Switching starts a NEW session on Minimal.')
  const restart = presetConfirmWording('Standard', true)
  assert.equal(presetConfirmTitle(restart), '● Restart session on Standard?')
  assert.equal(restart.firstPoint, 'Restarting starts a NEW session on Standard.')
  // Exactly three options in both wordings; the fork option always announces
  // the carried conversation; the /handoff tip is gone (decided against).
  for (const wording of [move, restart]) {
    const options = presetConfirmOptions(wording)
    assert.deepEqual(options.map(option => option.id), ['fork', 'fresh', 'cancel'])
    const flat = [
      presetConfirmTitle(wording),
      ...presetConfirmBody(wording),
      ...options.map(option => option.text),
    ].join('\n')
    assert.ok(!flat.includes('/handoff'), 'the handoff suggestion is removed')
    assert.ok(!flat.includes('Tip:'), 'no tip line remains')
    assert.ok(options[0].text.includes('carrying this conversation'))
    assert.ok(options[1].text.includes('empty session'))
    assert.ok(options[2].text.includes('stay on the current session'))
    assert.ok(presetConfirmBody(wording)[1].includes('compacted context included'))
  }
  assert.equal(move.fork, 'Fork & switch — new session on Minimal, carrying this conversation')
  assert.equal(move.fresh, 'Fresh start — new empty session on Minimal')
  assert.equal(restart.fork, 'Fork & restart — new session on Standard, carrying this conversation')
  assert.equal(restart.fresh, 'Restart now — new empty session on Standard')
})

// ----------------------------------------------------------------- reducer --

test('reducer: navigation clamps over three rows; 1/2/3 direct-select; Enter confirms; Esc cancels', () => {
  let state = initialPresetConfirmState()
  assert.equal(state.selected, 0)
  state = updatePresetConfirm(state, DOWN)
  state = updatePresetConfirm(state, DOWN)
  assert.equal(state.selected, 2, 'last row is Cancel')
  assert.equal(updatePresetConfirm(state, DOWN).selected, 2, 'clamped at the bottom')
  state = updatePresetConfirm(state, UP)
  assert.equal(state.selected, 1)
  assert.equal(updatePresetConfirm(initialPresetConfirmState(), UP).selected, 0, 'never below the first row')
  // Digit direct-select (1/2/3): '3' lands on Cancel.
  state = updatePresetConfirm(initialPresetConfirmState(), '3')
  assert.equal(state.selected, 2)
  assert.equal(updatePresetConfirm(state, '4').selected, 2, 'no fourth row')
  // Enter confirms the highlighted row: 3 = cancel, 1 = fork, 2 = fresh.
  assert.equal(presetConfirmOutcome(updatePresetConfirm(state, ENTER)), 'cancel')
  assert.equal(presetConfirmOutcome(updatePresetConfirm(initialPresetConfirmState(), ENTER)), 'fork')
  assert.equal(
    presetConfirmOutcome(updatePresetConfirm(updatePresetConfirm(initialPresetConfirmState(), DOWN), ENTER)),
    'fresh',
  )
  // Esc cancels from anywhere; after a settle every key is ignored.
  const cancelled = updatePresetConfirm(initialPresetConfirmState(), ESC)
  assert.equal(cancelled.settled, 'cancel')
  assert.equal(presetConfirmOutcome(cancelled), undefined)
  assert.equal(updatePresetConfirm(cancelled, UP).settled, 'cancel')
})

// ------------------------------------------------------------------- panel --

test('panel: title, two body points and the three option rows render; settles once', () => {
  const wording = presetConfirmWording('Minimal', false)
  let finish
  const panel = new PresetConfirmPanel(lightTheme, wording, outcome => { finish = outcome }, () => {})
  const text = panel.render(90).map(stripAnsi).join('\n')
  assert.ok(text.includes(presetConfirmTitle(wording)), text)
  assert.ok(text.includes('Switching starts a NEW session on Minimal.'), text)
  assert.ok(text.includes('compacted context included'), text)
  assert.ok(text.includes('1. Fork & switch — new session on Minimal, carrying this conversation'), text)
  assert.ok(text.includes('2. Fresh start — new empty session on Minimal'), text)
  assert.ok(text.includes('3. Cancel — stay on the current session'), text)
  assert.ok(text.includes('1/2/3 pick'))
  // The first terminal key settles the panel exactly once. Esc fires the
  // panel callback with `undefined` (the open-flow wrapper maps it to
  // 'cancelled'); post-settle keys are ignored.
  panel.handleInput(ESC)
  assert.equal(finish, undefined)
  panel.handleInput(ENTER)
  assert.equal(finish, undefined)
})

// ---------------------------------------------------------------- fork seed --

function event(type, seq) {
  return { type, seq, time: seq, data: {} }
}

test('completedTurnSeed: balanced prefix through the last turn/end; in-flight turn excluded', () => {
  const events = [
    event('turn/start', 0),
    event('user/message', 1),
    event('assistant/message', 2),
    event('turn/end', 3),
    event('turn/start', 4),
    event('user/message', 5),
    event('assistant/message', 6),
    event('turn/end', 7),
    event('turn/start', 8), // in-flight — never seeds
    event('user/message', 9),
  ]
  const seed = completedTurnSeed(events)
  assert.equal(seed.length, 8)
  assert.equal(seed[0].type, 'turn/start')
  assert.equal(seed[7].type, 'turn/end')
  // Contiguous from seq 0 — the seed validator's hard requirement.
  assert.deepEqual(seed.map(event => event.seq), [0, 1, 2, 3, 4, 5, 6, 7])
})

test('completedTurnSeed: empty before any completed turn (fork degrades to fresh)', () => {
  assert.deepEqual(completedTurnSeed([event('turn/start', 0), event('user/message', 1)]), [])
  assert.deepEqual(completedTurnSeed([]), [])
})

// ---------------------------------------------------------- the switch flow --

function makeDeps(overrides = {}) {
  const calls = { dialog: [], commits: [], forkCommits: [], action: 'fork' }
  const deps = {
    hasLiveSession: () => true,
    confirmSwitch: async (name, restart) => {
      calls.dialog.push({ name, restart })
      return calls.action
    },
    commit: async presetId => { calls.commits.push(presetId) },
    forkCommit: async presetId => { calls.forkCommits.push(presetId) },
    ...overrides,
  }
  return { deps, calls }
}

test('performPresetSwitch: fork outcome → forkCommit with the preset id, fresh commit untouched', async () => {
  const state = { roster, index: 0 }
  const { deps, calls } = makeDeps()
  calls.action = 'fork'
  const outcome = await performPresetSwitch(state, roster[1], deps)
  assert.equal(outcome.switched, true)
  assert.match(outcome.message, /Preset → Minimal/)
  assert.match(outcome.message, /forked from this conversation/)
  assert.deepEqual(calls.dialog, [{ name: 'Minimal', restart: false }])
  assert.deepEqual(calls.forkCommits, ['minimal'])
  assert.deepEqual(calls.commits, [], 'the fresh path never runs')
  assert.equal(state.index, 1)
})

test('performPresetSwitch: fresh outcome → the empty-session commit path', async () => {
  const state = { roster, index: 0 }
  const { deps, calls } = makeDeps()
  calls.action = 'fresh'
  const outcome = await performPresetSwitch(state, roster[1], deps)
  assert.equal(outcome.switched, true)
  assert.match(outcome.message, /new empty session/)
  assert.deepEqual(calls.commits, ['minimal'])
  assert.deepEqual(calls.forkCommits, [], 'the fork path never runs')
  assert.equal(state.index, 1)
})

test('performPresetSwitch: cancel changes nothing (no commit, no fork, selection untouched)', async () => {
  const state = { roster, index: 0 }
  const { deps, calls } = makeDeps()
  calls.action = 'cancel'
  const outcome = await performPresetSwitch(state, roster[1], deps)
  assert.equal(outcome.switched, false)
  assert.match(outcome.message, /unchanged/)
  assert.deepEqual(calls.commits, [])
  assert.deepEqual(calls.forkCommits, [])
  assert.equal(state.index, 0)
})

test('performPresetSwitch: without a live session the selection applies directly (no dialog)', async () => {
  const state = { roster, index: 0 }
  const { deps, calls } = makeDeps({ hasLiveSession: () => false })
  const outcome = await performPresetSwitch(state, roster[1], deps)
  assert.equal(outcome.switched, true)
  assert.match(outcome.message, /new session started on it/)
  assert.deepEqual(calls.dialog, [], 'no dialog without a live session')
  assert.deepEqual(calls.commits, ['minimal'])
  assert.deepEqual(calls.forkCommits, [])
  assert.equal(state.index, 1)
})

test('performPresetSwitch: a failed fork rolls the selection back', async () => {
  const state = { roster, index: 0 }
  const deps = makeDeps({
    forkCommit: async () => { throw new Error('fork create failed') },
  }).deps
  await assert.rejects(() => performPresetSwitch(state, roster[1], deps), /fork create failed/)
  // The rolled-back index is the point: the footer must not advertise a
  // preset the live session is not on after a failed switch.
  assert.equal(state.index, 0)
})

test('performPresetSwitch: the restart flag rides to the dialog when the target is current', async () => {
  const state = { roster, index: 0 }
  const { deps, calls } = makeDeps()
  await performPresetSwitch(state, roster[0], deps)
  assert.deepEqual(calls.dialog, [{ name: 'Standard', restart: true }])
})
