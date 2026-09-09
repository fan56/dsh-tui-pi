/**
 * Stop-everything confirmation tests — the pure reducer + panel of
 * src/stop-dialog.ts (the preset/repair-dialog pattern) and the wording that
 * states the blast radius (what is running right now). Runs against the
 * built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { lightTheme } from '../lib/theme/index.js'
import {
  STOP_CONFIRM_FOOTER,
  STOP_CONFIRM_OPTION_IDS,
  StopConfirmPanel,
  initialStopConfirmState,
  openStopConfirmDialog,
  stopConfirmOptions,
  stopConfirmOutcome,
  stopConfirmTitle,
  stopConfirmWording,
  updateStopConfirm,
} from '../lib/stop-dialog.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

const ENTER = '\r'
const ESC = '\x1b'
const DOWN = '\x1b[B'
const UP = '\x1b[A'

// ----------------------------------------------------------------- wording --

test('wording: main turn + subagents named, queued-work reassurance present', () => {
  const both = stopConfirmWording(true, 2)
  assert.equal(stopConfirmTitle(both), '● Stop all LLM work?')
  assert.match(both.body[0], /main turn is generating/)
  assert.match(both.body[0], /2 subagents are running/)
  const childOnly = stopConfirmWording(false, 1)
  assert.match(childOnly.body[0], /1 subagent is running/)
  assert.ok(!childOnly.body[0].includes('main turn'), 'an idle parent is not named as running')
  const parentOnly = stopConfirmWording(true, 0)
  assert.match(parentOnly.body[0], /main turn is generating/)
  assert.ok(!parentOnly.body[0].includes('subagent'), 'no subagent count is named when none run')
  const idle = stopConfirmWording(false, 0)
  assert.match(idle.body[0], /Nothing is running/)
  // The reassurance rides every wording: queued prompts survive, session
  // stays resumable.
  for (const wording of [both, childOnly, parentOnly, idle]) {
    assert.ok(wording.body.some(point => point.includes('Queued messages are kept')))
    assert.ok(wording.body.some(point => point.includes('stays resumable')))
  }
})

test('options: exactly stop + cancel, stop first (preselected)', () => {
  const options = stopConfirmOptions()
  assert.deepEqual(options.map(option => option.id), ['stop', 'cancel'])
  assert.deepEqual([...STOP_CONFIRM_OPTION_IDS], ['stop', 'cancel'])
  assert.match(options[0].text, /Stop everything/)
  assert.match(options[1].text, /keep everything running/)
})

// ---------------------------------------------------------------- reducer --

test('reducer: Enter on the preselected row confirms the stop', () => {
  let state = initialStopConfirmState()
  state = updateStopConfirm(state, ENTER)
  assert.equal(stopConfirmOutcome(state), 'stop')
})

test('reducer: Esc cancels — the outcome is undefined, not a stop', () => {
  let state = initialStopConfirmState()
  state = updateStopConfirm(state, ESC)
  assert.equal(state.settled, 'cancel')
  assert.equal(stopConfirmOutcome(state), undefined)
})

test('reducer: digit select-then-confirm; 2 + Enter cancels', () => {
  let state = initialStopConfirmState()
  state = updateStopConfirm(state, '2')
  assert.equal(state.selected, 1, 'the digit selects the row')
  assert.equal(state.settled, undefined, '…but does not confirm yet')
  state = updateStopConfirm(state, ENTER)
  assert.equal(stopConfirmOutcome(state), undefined, 'row 2 is cancel')
})

test('reducer: arrows move within the two rows; unknown keys are no-ops', () => {
  let state = initialStopConfirmState()
  state = updateStopConfirm(state, UP)
  assert.equal(state.selected, 0, 'clamped at the top')
  state = updateStopConfirm(state, DOWN)
  assert.equal(state.selected, 1)
  state = updateStopConfirm(state, DOWN)
  assert.equal(state.selected, 1, 'clamped at the bottom')
  state = updateStopConfirm(state, 'z')
  assert.equal(state.settled, undefined)
  state = updateStopConfirm(state, ENTER)
  // The selection sits on row 2 (cancel) after the no-op — the Enter is
  // still a confirm of THAT row, not of stop.
  assert.equal(stopConfirmOutcome(state), undefined)
})

test('reducer: input after a settle is ignored (single terminal outcome)', () => {
  let state = initialStopConfirmState()
  state = updateStopConfirm(state, ESC)
  state = updateStopConfirm(state, ENTER)
  assert.equal(stopConfirmOutcome(state), undefined, 'the late Enter cannot confirm a cancelled dialog')
})

// ------------------------------------------------------------------ panel --

function makeTui() {
  return { requestRender: () => {} }
}

test('panel: renders title, body points, both options and the footer', () => {
  const tui = makeTui()
  const panel = new StopConfirmPanel(lightTheme, stopConfirmWording(true, 1), () => {}, () => tui.requestRender())
  const lines = panel.render(100).map(stripAnsi)
  const flat = lines.join('\n')
  assert.ok(flat.includes('Stop all LLM work?'))
  assert.ok(flat.includes('1 subagent is running'))
  assert.ok(flat.includes('Stop everything'))
  assert.ok(flat.includes('keep everything running'))
  assert.ok(flat.includes(STOP_CONFIRM_FOOTER))
})

test('panel: the first terminal key fires onFinish exactly once with the outcome', () => {
  const tui = makeTui()
  const finishes = []
  const panel = new StopConfirmPanel(lightTheme, stopConfirmWording(true, 0), outcome => finishes.push(outcome), () => tui.requestRender())
  panel.handleInput(ENTER)
  assert.deepEqual(finishes, ['stop'])
  panel.handleInput(ENTER)
  assert.deepEqual(finishes, ['stop'], 'a follow-up key fires nothing')
})

test('panel: render does not consume the settle — only handleInput does', () => {
  const tui = makeTui()
  let finished = 0
  const panel = new StopConfirmPanel(lightTheme, stopConfirmWording(false, 0), () => { finished += 1 }, () => tui.requestRender())
  panel.render(80)
  assert.equal(finished, 0)
})

// ------------------------------------------------------------- open flow --

test('openStopConfirmDialog: Enter resolves stop, Esc resolves cancelled', async () => {
  // PanelHost.open mounts through tui.showOverlay; a stub that silently
  // swallows the overlay keeps the promise pending while we drive the panel
  // directly — enough to pin the settle contract without a terminal.
  const openCalls = []
  const tui = {
    requestRender: () => {},
    showOverlay: component => {
      openCalls.push(component)
      return { hide: () => {} }
    },
  }
  const restorations = []
  const promise = openStopConfirmDialog(tui, lightTheme, true, 1, () => restorations.push(1))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(openCalls.length, 1, 'the dialog panel mounted as an overlay')
  openCalls[0].handleInput(ENTER)
  assert.equal(await promise, 'stop')
  assert.equal(restorations.length, 1, 'focus hands back through restoreFocus')
})

test('openStopConfirmDialog: a failed mount settles as cancelled (never implies consent)', async () => {
  const tui = {
    requestRender: () => {},
    showOverlay: () => { throw new Error('no terminal') },
  }
  const restorations = []
  const promise = openStopConfirmDialog(tui, lightTheme, true, 0, () => restorations.push(1))
  const outcome = await promise
  assert.equal(outcome, 'cancelled')
  assert.equal(restorations.length, 1)
})
