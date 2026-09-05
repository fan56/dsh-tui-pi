/**
 * /history browser tests — the viewer-level pieces of src/history.ts that are
 * testable without a terminal: the row builder (filter + preview clip), the
 * overlay budget math, the detail-pane container (bubble / Markdown / tool
 * summary / turn-end line, user-bubble truncation) and the HistoryBrowserPanel
 * itself driven through handleInput (dual-pane vs stacked layout, navigation
 * rebuilds the detail, Enter copy closes with the editor refill, the `/`
 * filter contract, the `s` picker error path). Runs against the built lib/
 * (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import {
  buildTurnDetailContainer,
  DUAL_PANE_MIN_COLUMNS,
  MAX_DETAIL_LINES,
  filterSessionPickRows,
  historyLoadErrorMessage,
  historyRows,
  HistoryBrowserPanel,
  LEFT_PANE_MIN_COLUMNS,
  listMaxVisible,
  overlayContentBudget,
} from '../lib/history.js'
import { groupHistoryTurns } from '../lib/history-turns.js'
import { lightTheme } from '../lib/theme/index.js'
import { visibleWidth } from '../lib/text.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

/** Three completed turns with distinct prompts, replies and tool calls. */
function sampleEvents() {
  return [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 0 } },
    { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'explain the websocket retry' }] } },
    { type: 'assistant/message', seq: 2, time: 2, data: { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'Retry uses **backoff**.' }] } } },
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 0, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 4, time: 4, data: { turn: 1 } },
    { type: 'user/message', seq: 5, time: 5, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'now refactor the kerberos layer' }] } },
    { type: 'tool/call', seq: 6, time: 6, data: { turn: 1, step: 0, callId: 'c1', name: 'read', arguments: '{}' } },
    { type: 'tool/call', seq: 7, time: 7, data: { turn: 1, step: 0, callId: 'c2', name: 'read', arguments: '{}' } },
    { type: 'tool/call', seq: 8, time: 8, data: { turn: 1, step: 1, callId: 'c3', name: 'edit', arguments: '{}' } },
    { type: 'assistant/message', seq: 9, time: 9, data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'Refactored.' }] } } },
    { type: 'turn/end', seq: 10, time: 10, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 11, time: 11, data: { turn: 2 } },
    { type: 'user/message', seq: 12, time: 12, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'third prompt' }] } },
    { type: 'turn/end', seq: 13, time: 13, data: { turn: 2, reason: { kind: 'error', error: { message: 'provider exploded' } } } },
  ]
}

/** Fake seams: no terminal, no ctx services, copied text captured. */
function makePanel(events = sampleEvents(), overrides = {}) {
  const state = {
    copied: undefined, closed: 0, refocused: 0, finished: undefined, opened: [],
    forkDialogs: [], forks: [], forkErrors: [], forkAnswer: false,
  }
  const deps = {
    ctx: { get: () => undefined },
    tui: { requestRender() {} },
    theme: lightTheme,
    getSessionId: () => 'aaaaaaaa-1111-2222-3333-444444444444',
    getLiveEvents: () => events,
    copyToEditor: text => { state.copied = text },
    confirmForkAtTurn: async (turnLabel, totalTurns, cold) => {
      state.forkDialogs.push({ turnLabel, totalTurns, cold })
      return state.forkAnswer
    },
    forkAtTurn: async (seed, parentSessionId) => {
      state.forks.push({ seed, parentSessionId })
      return {}
    },
    reportError: message => { state.forkErrors.push(message) },
    restoreFocus: () => { state.refocused += 1 },
    requestRender: () => {},
    ...overrides.deps,
  }
  const host = {
    open: component => { state.opened.push(component); return {} },
    close: () => { state.closed += 1 },
  }
  const loaded = { sessionId: 'aaaaaaaa-1111', live: true, events, ...overrides.loaded }
  const panel = new HistoryBrowserPanel(deps, host, loaded)
  panel.onFinish = text => { state.finished = text }
  return { panel, state, deps }
}

/** Poll an async panel flow to completion (bounded, test-only). */
async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(condition(), 'condition not met in time')
}

function renderedText(panel, width) {
  return panel.render(width).map(stripAnsi)
}

test('overlayContentBudget: 85% of the terminal minus the 4 framed-overlay rows', () => {
  assert.equal(overlayContentBudget(24), 16)
  assert.equal(overlayContentBudget(40), 30)
  // Unknown terminal (tests, pipes): the 24-row floor applies.
  assert.equal(overlayContentBudget(undefined), 16)
  // Absurdly small terminals clamp to a livable minimum.
  assert.ok(overlayContentBudget(4) >= 6)
})

test('listMaxVisible: side-by-side reserves 9 rows, stacked 15; clamped', () => {
  assert.equal(listMaxVisible(24, 120), 7)
  assert.equal(listMaxVisible(24, 80), 3)
  assert.equal(listMaxVisible(60, 140), 20)
  assert.equal(listMaxVisible(4, 80), 3)
  assert.ok(DUAL_PANE_MIN_COLUMNS === 100)
  assert.ok(LEFT_PANE_MIN_COLUMNS === 30)
})

test('historyRows: filters by preview and turn number, clips previews, keeps order', () => {
  const turns = groupHistoryTurns(sampleEvents())
  const all = historyRows(turns, '')
  assert.equal(all.length, 3)
  assert.deepEqual(all.map(row => row.turnLabel), ['0', '1', '2'])
  assert.equal(historyRows(turns, 'WEBSOCKET').length, 1)
  assert.equal(historyRows(turns, 'websocket')[0].turnLabel, '0')
  assert.equal(historyRows(turns, '2')[0].turnLabel, '2')
  assert.equal(historyRows(turns, 'no-such-thing').length, 0)
  // Control characters fold out of the preview (normalizePreview vocabulary).
  const messy = groupHistoryTurns([
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 0 } },
    { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'one\ntwo\tthree' }] } },
    { type: 'turn/end', seq: 2, time: 2, data: { turn: 0, reason: { kind: 'completed' } } },
  ])
  assert.equal(historyRows(messy, '')[0].preview, 'one two three')
})

test('buildTurnDetailContainer: bubble, Markdown reply, tool summary in order', () => {
  const turns = groupHistoryTurns(sampleEvents())
  const lines = buildTurnDetailContainer(turns[1], lightTheme).render(80).map(stripAnsi)
  const text = lines.join('\n')
  // The user prompt renders as the transcript's bubble (Text pads 1 column).
  assert.ok(lines.some(line => line.trimStart().startsWith('▎ now refactor')), text)
  // The assembled reply renders through Markdown (bold survives as text).
  assert.ok(lines.some(line => line.includes('Refactored.')), text)
  // The tool-count summary rides at the content tail.
  assert.ok(lines.some(line => line.includes('⚙ 3 tool calls: read×2, edit×1')), text)
  const replyAt = lines.findIndex(line => line.includes('Refactored.'))
  const toolsAt = lines.findIndex(line => line.includes('⚙ 3 tool calls'))
  assert.ok(replyAt < toolsAt)
})

test('buildTurnDetailContainer: completed turn carries no end line, failed turns do', () => {
  const turns = groupHistoryTurns(sampleEvents())
  const ok = buildTurnDetailContainer(turns[0], lightTheme).render(80).map(stripAnsi).join('\n')
  assert.ok(!ok.includes('interrupted'))
  assert.ok(!ok.includes('✘'))
  const failed = buildTurnDetailContainer(turns[2], lightTheme).render(80).map(stripAnsi).join('\n')
  assert.ok(failed.includes('✘ provider exploded'))
})

test('buildTurnDetailContainer: oversized user prompts truncate with a continuation marker', () => {
  const many = Array.from({ length: 45 }, (_, i) => `line ${i}`)
  const turns = groupHistoryTurns([
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 0 } },
    { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: many.join('\n') }] } },
    { type: 'turn/end', seq: 2, time: 2, data: { turn: 0, reason: { kind: 'completed' } } },
  ])
  const text = buildTurnDetailContainer(turns[0], lightTheme).render(80).map(stripAnsi).join('\n')
  assert.ok(text.includes('▎ line 0'))
  assert.ok(text.includes('▎ line 39'))
  assert.ok(!text.includes('▎ line 40'))
  assert.ok(text.includes('… +5 more lines'))
})

test('the browser renders side-by-side at 120 columns within the width', () => {
  const { panel } = makePanel()
  const lines = panel.render(120)
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 120, `line overflows 120: ${JSON.stringify(line)}`)
  }
  const text = lines.map(stripAnsi).join('\n')
  assert.ok(text.includes('● History · aaaaaaaa (live)'))
  assert.ok(text.includes('TURN'), 'uppercase header row present')
  assert.ok(text.includes('explain the websocket retry'))
  assert.ok(text.includes('Turn 0 · live snapshot'), 'detail pane header present')
  assert.ok(text.includes('Retry uses'), 'detail pane shows the selected reply')
})

test('the browser stacks below 100 columns and stays within the width', () => {
  const { panel } = makePanel()
  const lines = panel.render(80)
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 80, `line overflows 80: ${JSON.stringify(line)}`)
  }
  const text = lines.map(stripAnsi).join('\n')
  assert.ok(text.includes('● History · aaaaaaaa (live)'))
  assert.ok(text.includes('Turn 0 · live snapshot'))
  // List first (above), detail second (below).
  const listAt = text.indexOf('● History')
  const detailAt = text.indexOf('Turn 0')
  assert.ok(listAt >= 0 && detailAt > listAt)
})

test('navigation rebuilds the right pane; Enter copies the prompt and closes', () => {
  const { panel, state } = makePanel()
  panel.handleInput('\x1b[B') // down → turn 1
  let text = panel.render(120).map(stripAnsi).join('\n')
  assert.ok(text.includes('Turn 1 · live snapshot'))
  assert.ok(text.includes('now refactor the kerberos layer'))
  panel.handleInput('\x1b[B') // down → turn 2 (ends with an error)
  text = panel.render(120).map(stripAnsi).join('\n')
  assert.ok(text.includes('Turn 2 · error · live snapshot'))
  assert.ok(text.includes('✘ provider exploded'))
  // Enter on turn 2: the editor refill carries the turn's user prompt, the
  // overlay closes, focus returns, and the echo text is delivered.
  panel.handleInput('\r')
  assert.equal(state.copied, 'third prompt')
  assert.equal(state.closed, 1)
  assert.equal(state.refocused, 1)
  assert.equal(state.finished, 'Prompt copied to the editor.')
})

test('the `/` filter rebuilds rows live; first Esc clears it, second Esc closes', () => {
  const { panel, state } = makePanel()
  panel.handleInput('/')
  panel.handleInput('k')
  panel.handleInput('e')
  panel.handleInput('r')
  let text = panel.render(120).map(stripAnsi).join('\n')
  assert.ok(text.includes('Filter: ker'), 'the engaged query is visible')
  assert.ok(text.includes('now refactor the kerberos layer'))
  assert.ok(!text.includes('explain the websocket retry'), 'filtered-out rows vanish')
  // First Esc clears the applied filter…
  panel.handleInput('\x1b')
  text = panel.render(120).map(stripAnsi).join('\n')
  assert.ok(!text.includes('Filter: ker'))
  assert.ok(text.includes('explain the websocket retry'), 'all rows return')
  assert.equal(state.closed, 0)
  // …the second Esc pops the panel.
  panel.handleInput('\x1b')
  assert.equal(state.closed, 1)
  assert.equal(state.refocused, 1)
  assert.equal(state.finished, 'History closed.')
})

test('`c` copies like Enter; a turn without a user prompt declines to copy', () => {
  const { panel, state } = makePanel()
  panel.handleInput('c')
  assert.equal(state.copied, 'explain the websocket retry')
  assert.equal(state.closed, 1)
  // An injected-only turn declines: a notice must never land in the editor,
  // where one Enter would submit it as a prompt (the row preview still shows
  // it — only the copy path declines).
  const empty = makePanel([
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 0 } },
    { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'notice only' }] } },
    { type: 'turn/end', seq: 2, time: 2, data: { turn: 0, reason: { kind: 'completed' } } },
  ])
  empty.panel.handleInput('c')
  assert.equal(empty.state.copied, undefined)
  assert.equal(empty.state.closed, 0)
  assert.ok(empty.panel.render(120).map(stripAnsi).join('\n').includes('Nothing to copy'))
  const blank = makePanel([
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 0 } },
    { type: 'turn/end', seq: 1, time: 1, data: { turn: 0, reason: { kind: 'completed' } } },
  ])
  blank.panel.handleInput('c')
  assert.equal(blank.state.copied, undefined)
  assert.equal(blank.state.closed, 0)
  assert.ok(blank.panel.render(120).map(stripAnsi).join('\n').includes('Nothing to copy'))
})

test('`[`/`]` page the detail pane, clamp at both ends, and stay out of filter input', () => {
  const longReply = Array.from({ length: 60 }, (_, i) => `reply line ${i}`).join('\n')
  const { panel } = makePanel([
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 0 } },
    { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'long reply turn' }] } },
    { type: 'assistant/message', seq: 2, time: 2, data: { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: longReply }] } } },
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 0, reason: { kind: 'completed' } } },
  ])
  const width = 120
  const footer = () => {
    const line = panel.render(width).map(stripAnsi).find(l => l.includes('[ / ] page'))
    const m = line?.match(/page · (\d+)[–](\d+)\/(\d+)/)
    return m === undefined ? undefined : { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) }
  }
  // The long reply overflows the window; it starts at the top.
  const first = footer()
  assert.ok(first !== undefined, 'long reply is scrollable')
  assert.equal(first.start, 1)
  assert.ok(first.end < first.total, 'window is smaller than the content')
  // `]` pages down, `[` pages back up.
  panel.handleInput(']')
  const down = footer()
  assert.ok(down.start > first.start)
  panel.handleInput('[')
  assert.equal(footer().start, 1)
  // Mashing `]` clamps at the bottom and stays there.
  for (let i = 0; i < 50; i++) panel.handleInput(']')
  const bottom = footer()
  assert.equal(bottom.end, bottom.total)
  panel.handleInput(']')
  assert.deepEqual(footer(), bottom)
  // `[` moves up from the bottom.
  panel.handleInput('[')
  assert.ok(footer().start < bottom.start)
  // With the filter input engaged, `[` types into the query instead of paging.
  panel.handleInput(']')
  const beforeFilter = footer()
  panel.handleInput('/')
  panel.handleInput('[')
  const view = panel.render(width).map(stripAnsi).join('\n')
  assert.ok(view.includes('Filter: [_'), view)
  assert.deepEqual(footer(), beforeFilter)
  // Esc clears the query, second Esc closes (unchanged contract).
  panel.handleInput('\x1b')
  panel.handleInput('\x1b')
})

/** One long-reply turn (60 reply lines) so the detail pane overflows. */
function longReplyEvents() {
  const longReply = Array.from({ length: 60 }, (_, i) => `reply line ${i}`).join('\n')
  return [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 0 } },
    { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'long reply turn' }] } },
    { type: 'assistant/message', seq: 2, time: 2, data: { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: longReply }] } } },
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 0, reason: { kind: 'completed' } } },
  ]
}

/** The detail footer's visible scroll window ({start,end,total}), if paging. */
function detailWindow(panel, width) {
  const line = panel.render(width).map(stripAnsi).find(l => l.includes('[ / ] page'))
  const m = line?.match(/page · (\d+)[–](\d+)\/(\d+)/)
  return m === null || m === undefined ? undefined : { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) }
}

test('focus model: → enters the detail pane, ←/Esc step back, detail keys are graded', () => {
  const { panel, state } = makePanel(longReplyEvents())
  const width = 120
  const text = () => panel.render(width).map(stripAnsi).join('\n')
  // List focus: ▸ cursor, no detail hints.
  assert.ok(text().includes('▸'))
  assert.ok(!text().includes('← list · ↑↓ scroll'))
  // → hands focus to the detail pane: the cursor demotes to › and the detail
  // footer shows the exit/scroll hints.
  panel.handleInput('\x1b[C')
  let view = text()
  assert.ok(view.includes('›') && !view.includes('▸'), 'cursor demotes while detail is focused')
  assert.ok(view.includes('← list · ↑↓ scroll'), 'focused detail footer hint')
  // While detail is keyed, list/copy keys are inert…
  panel.handleInput('c')
  panel.handleInput('s')
  panel.handleInput('\r')
  assert.equal(state.copied, undefined)
  assert.equal(state.closed, 0)
  // …↓ scrolls the detail by one line…
  const before = detailWindow(panel, width)
  assert.ok(before !== undefined && before.start === 1)
  panel.handleInput('\x1b[B')
  assert.equal(detailWindow(panel, width).start, 2)
  // …Esc steps back to the list WITHOUT closing (▸ cursor returns, hint gone).
  panel.handleInput('\x1b')
  view = text()
  assert.ok(view.includes('▸') && !view.includes('›'))
  assert.ok(!view.includes('← list · ↑↓ scroll'))
  assert.equal(state.closed, 0)
  assert.ok(view.includes('Turn 0'), 'selection survived the focus round-trip')
  // ← from list focus is not an exit either (list nav owns it / inert).
  panel.handleInput('\x1b[D')
  assert.equal(state.closed, 0)
  // Esc in list focus (no applied filter) closes.
  panel.handleInput('\x1b')
  assert.equal(state.closed, 1)
  assert.equal(state.refocused, 1)
})

test('focus model: PgUp/PgDn page while the detail is focused; scroll clamps both ends', () => {
  const { panel } = makePanel(longReplyEvents())
  const width = 120
  panel.render(width) // the open frame populates the scroll window
  panel.handleInput('\x1b[C') // → detail focus
  // ↓ clamps at the bottom…
  for (let i = 0; i < 200; i++) panel.handleInput('\x1b[B')
  const bottom = detailWindow(panel, width)
  assert.equal(bottom.end, bottom.total)
  // …PgUp pages up…
  panel.handleInput('\x1b[5~')
  const paged = detailWindow(panel, width)
  assert.ok(paged.start < bottom.start)
  // …and ↑ walks back to the very top.
  for (let i = 0; i < 200; i++) panel.handleInput('\x1b[A')
  assert.equal(detailWindow(panel, width).start, 1)
  // PgDn pages down again from the top.
  panel.handleInput('\x1b[6~')
  assert.ok(detailWindow(panel, width).start > 1)
})

test('focus model: → inside the filter input goes to the query, never yanks focus', () => {
  const { panel } = makePanel()
  const width = 120
  panel.handleInput('/')
  panel.handleInput('w')
  // The filter input owns the keyboard: `→` must not switch focus…
  panel.handleInput('\x1b[C')
  const view = panel.render(width).map(stripAnsi).join('\n')
  assert.ok(!view.includes('← list · ↑↓ scroll'), 'still list-focused')
  assert.ok(view.includes('▸'), 'cursor still in list focus')
  // …and the applied query is untouched (the filter input ignores arrows).
  assert.ok(view.includes('Filter: w'), view)
  panel.handleInput('\x1b') // clear filter
  panel.handleInput('\x1b') // close
})

test('fixed geometry: every render is exactly the budget; resize re-derives it', () => {
  const prevRows = process.stdout.rows
  const prevColumns = process.stdout.columns
  process.stdout.rows = 24
  process.stdout.columns = 140
  try {
    const budget = overlayContentBudget()
    // A short-turn session…
    const short = makePanel(sampleEvents())
    assert.equal(short.panel.render(120).length, budget)
    // …and a long-turn one render the SAME window height.
    const long = makePanel(longReplyEvents())
    assert.equal(long.panel.render(120).length, budget)
    // An engaged filter line does not grow the window either.
    long.panel.handleInput('/')
    long.panel.handleInput('l')
    assert.equal(long.panel.render(120).length, budget)
    long.panel.handleInput('\x1b') // clear the (engaged) filter
    // Resize: the budget and the list re-derive for the new terminal; the
    // window follows the new budget and the list footer survives.
    process.stdout.rows = 18
    const shrunk = overlayContentBudget()
    assert.ok(shrunk < budget)
    const lines = long.panel.render(120)
    assert.equal(lines.length, shrunk)
    assert.ok(lines.map(stripAnsi).join('\n').includes('navigate · Enter/c copy'))
    // Scrolling still works at the new size…
    long.panel.handleInput('\x1b[C')
    for (let i = 0; i < 200; i++) long.panel.handleInput('\x1b[B')
    const bottom = detailWindow(long.panel, 120)
    assert.equal(bottom.end, bottom.total)
    // …and growing the terminal back re-derives again.
    process.stdout.rows = 40
    assert.equal(long.panel.render(120).length, overlayContentBudget())
  } finally {
    process.stdout.rows = prevRows
    process.stdout.columns = prevColumns
  }
})

test('an applied filter plus a status line still fits the fixed budget — footers intact', () => {
  // rows=24 → budget 16, the zone where an unreserved status row used to
  // slice the footers off: the list then renders listMax+9 lines (chrome +
  // filter line + status line), which overflowed budget when listMax was
  // budget-8. The window fills only if the filtered result fills the list,
  // hence a dozen notice turns under a matching filter.
  const prevRows = process.stdout.rows
  const prevColumns = process.stdout.columns
  process.stdout.rows = 24
  process.stdout.columns = 120
  try {
    const notices = []
    let seq = 0
    for (let turn = 0; turn < 12; turn += 1) {
      notices.push({ type: 'turn/start', seq: seq++, time: seq, data: { turn } })
      notices.push({ type: 'user/message', seq: seq++, time: seq, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: `file-change notice ${turn}` }] } })
      notices.push({ type: 'turn/end', seq: seq++, time: seq, data: { turn, reason: { kind: 'completed' } } })
    }
    const { panel, state } = makePanel(notices)
    panel.handleInput('/')
    for (const ch of 'notice') panel.handleInput(ch) // engage + type, one key event at a time
    panel.handleInput('\r') // apply the filter — all 12 notice turns stay visible
    panel.handleInput('\r') // copy → declined: the 'Nothing to copy' status line appears
    assert.equal(state.copied, undefined)
    assert.equal(state.closed, 0)
    const lines = panel.render(120)
    assert.equal(lines.length, overlayContentBudget(), 'geometry stays exactly at budget')
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('Nothing to copy'), 'status line visible')
    assert.ok(text.includes('↑↓ navigate'), 'list footer survives the slice')
    assert.ok(text.includes('page'), 'detail footer survives the slice')
  } finally {
    process.stdout.rows = prevRows
    process.stdout.columns = prevColumns
  }
})

test('`s` with no persistence service surfaces the failure in the status line', async () => {
  const { panel } = makePanel()
  panel.handleInput('s')
  await new Promise(resolve => setImmediate(resolve))
  // The status line clips to the left pane's width — assert the visible head.
  const text = panel.render(120).map(stripAnsi).join('\n')
  assert.ok(text.includes('Cannot read aaaaaaaa: Session persistence'), text)
})

/** Hermetic session-store root for picker tests (sessionLogRoot reads it). */
function withTempSessionRoot(run) {
  const previous = process.env.DSH_SESSION_ROOT
  process.env.DSH_SESSION_ROOT = os.tmpdir()
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env.DSH_SESSION_ROOT
    else process.env.DSH_SESSION_ROOT = previous
  })
}

function fakePersistence(headers) {
  return {
    list: async () => headers,
    inspect: async id => ({
      meta: headers.find(header => header.id === id),
      events: [{
        type: 'user/message', seq: 0, time: 0,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: `${String(id).split('-')[1]} prompt` }] },
      }],
    }),
  }
}

test('the s picker filters by title/dir/id and keeps the cursor; Esc clears then returns', () => withTempSessionRoot(async () => {
  const persistence = fakePersistence([
    { id: 'session-alpha-1', createdAt: 30, cwd: '/tmp/alpha', isSeeded: false },
    { id: 'session-beta-2', createdAt: 20, cwd: '/tmp/beta', isSeeded: false },
    { id: 'session-gamma-3', createdAt: 10, cwd: '/tmp/gamma', isSeeded: false },
  ])
  const { panel, state } = makePanel(sampleEvents(), {
    deps: { ctx: { get: key => (key === 'sessionPersistence' ? persistence : undefined) } },
  })
  panel.handleInput('s')
  await waitFor(() => state.opened.length > 0)
  const picker = state.opened.at(-1)
  assert.ok(picker !== undefined && picker !== panel, 'the picker overlay mounted')
  // Newest createdAt first.
  picker.handleInput('\x1b[B') // down → beta
  let selected = picker.render(100).map(stripAnsi).find(line => line.includes('▸'))
  assert.ok(selected.includes('beta'), selected)
  // `/` engages; typing rebuilds the rows and the cursor follows its session.
  picker.handleInput('/')
  picker.handleInput('b')
  selected = picker.render(100).map(stripAnsi).find(line => line.includes('▸'))
  assert.ok(selected.includes('beta'), 'cursor followed its session across the rebuild')
  let view = picker.render(100).map(stripAnsi).join('\n')
  assert.ok(view.includes('Filter: b'), view)
  assert.ok(view.includes('beta prompt'), view)
  assert.ok(!view.includes('alpha prompt'), view)
  assert.ok(!view.includes('/tmp/gamma'), view)
  // A query with no matches shows the picker's empty hint, not a dead list.
  picker.handleInput('z')
  view = picker.render(100).map(stripAnsi).join('\n')
  assert.ok(view.includes('No matching sessions'), view)
  picker.handleInput('\x7f') // backspace → 'b' again
  view = picker.render(100).map(stripAnsi).join('\n')
  assert.ok(view.includes('beta prompt'), view)
  // Esc clears the applied query — all rows return…
  picker.handleInput('\x1b')
  view = picker.render(100).map(stripAnsi).join('\n')
  assert.ok(!view.includes('Filter:'))
  assert.ok(view.includes('alpha prompt'), view)
  assert.ok(view.includes('gamma prompt'), view)
  // …the second Esc returns to the browser surface.
  picker.handleInput('\x1b')
  assert.equal(state.opened.at(-1), panel)
}))

test('selecting a corrupt session in the picker returns to the browser with the error visible', () => withTempSessionRoot(async () => {
  const persistence = {
    list: async () => [{ id: 'bbbb2222-3333', createdAt: 5, cwd: '/tmp/corrupt', isSeeded: false }],
    inspect: async () => { throw new Error('cannot read corrupt session log: bad frame') },
  }
  const { panel, state } = makePanel(sampleEvents(), {
    deps: { ctx: { get: key => (key === 'sessionPersistence' ? persistence : undefined) } },
  })
  panel.handleInput('s')
  await waitFor(() => state.opened.length > 0)
  const picker = state.opened.at(-1)
  picker.handleInput('\r') // Enter on the corrupt row
  // The picker has no status row — the flow must come back to the browser
  // (show-new-then-hide-old) where the status line is actually visible.
  await waitFor(() => state.opened.at(-1) === panel)
  const text = panel.render(120).map(stripAnsi).join('\n')
  assert.ok(text.includes('⚠ bbbb2222'), text)
  assert.ok(text.includes('corrupt session log'), text)
}))

test('a load failure landing after the browser closed must not resurrect the overlay', () => withTempSessionRoot(async () => {
  const header = { id: 'bbbb2222-3333', createdAt: 5, cwd: '/tmp/slow', isSeeded: false }
  const previewEvents = [{ type: 'user/message', seq: 0, time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'slow prompt' }] } }]
  let armed = false
  let slowInspectUsed = false
  let rejectInspect
  const persistence = {
    list: async () => [header],
    // The picker build (preview enrichment) resolves fast; the Enter-driven
    // cold read parks on a promise only the test can settle.
    inspect: () => {
      if (!armed) return Promise.resolve({ meta: header, events: previewEvents })
      slowInspectUsed = true
      return new Promise((_resolve, reject) => { rejectInspect = reject })
    },
  }
  const { panel, state } = makePanel(sampleEvents(), {
    deps: { ctx: { get: key => (key === 'sessionPersistence' ? persistence : undefined) } },
  })
  panel.handleInput('s')
  await waitFor(() => state.opened.length > 0)
  const picker = state.opened.at(-1)
  armed = true
  picker.handleInput('\r') // Enter → loadAndShow parks on the controlled inspect
  await waitFor(() => slowInspectUsed)
  picker.handleInput('\x1b') // no query applied → straight back to the browser
  assert.equal(state.opened.at(-1), panel)
  panel.handleInput('\x1b') // Esc → finish(): overlay closed for good
  assert.equal(state.closed, 1)
  assert.equal(typeof state.finished, 'string')
  const openCount = state.opened.length
  rejectInspect(new Error('cannot read corrupt session log: bad frame'))
  await new Promise(resolve => setTimeout(resolve, 10))
  // The late failure must be swallowed: reopening a closed panel would leave
  // an overlay finish() can never close (keyboard dead until Ctrl+C).
  assert.equal(state.opened.length, openCount, 'no reopen after close')
  assert.equal(state.closed, 1)
}))

test('switching sessions rebuilds the list panel — the Turn column refits to wider numbers', () => withTempSessionRoot(async () => {
  const bigTurns = []
  let seq = 0
  for (let turn = 0; turn <= 10000; turn += 2500) {
    bigTurns.push({ type: 'turn/start', seq: seq++, time: seq, data: { turn } })
    bigTurns.push({ type: 'user/message', seq: seq++, time: seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text: `prompt ${turn}` }] } })
    bigTurns.push({ type: 'turn/end', seq: seq++, time: seq, data: { turn, reason: { kind: 'completed' } } })
  }
  const persistence = fakePersistence([
    // Same id as the fake live session (getSessionId) so the pick reloads the
    // LIVE snapshot path, exercising loadSessionEvents's live shortcut.
    { id: 'aaaaaaaa-1111-2222-3333-444444444444', createdAt: 5, cwd: '/tmp/switch', isSeeded: false },
  ])
  const { panel, state } = makePanel(sampleEvents(), {
    deps: {
      ctx: { get: key => (key === 'sessionPersistence' ? persistence : undefined) },
      getLiveEvents: () => bigTurns,
    },
  })
  panel.handleInput('s')
  await waitFor(() => state.opened.length > 0)
  const picker = state.opened.at(-1)
  picker.handleInput('\r') // pick the (live-marked) session → live snapshot reload
  await waitFor(() => state.opened.at(-1) === panel)
  const text = panel.render(120).map(stripAnsi).join('\n')
  assert.ok(text.includes('● History · aaaaaaaa (live)'), text)
  // The 5-digit turn number renders whole (cursor rests on row 0, so the
  // row is unmarked) — with the stale 1-digit-fit column it would clip to
  // `100…`.
  assert.ok(text.includes('10000 │'), text)
}))

test('filterSessionPickRows: substring over title/dir/id, order preserved', () => {
  const rows = [
    { id: 'aaa-1', updated: 'x', dir: '/tmp/alpha', session: 'alpha prompt' },
    { id: 'bbb-2', updated: 'y', dir: '/work/beta repo', session: 'beta prompt' },
  ]
  assert.equal(filterSessionPickRows(rows, '').length, 2)
  assert.deepEqual(filterSessionPickRows(rows, 'ALPHA').map(row => row.id), ['aaa-1'])
  assert.deepEqual(filterSessionPickRows(rows, 'work').map(row => row.id), ['bbb-2'])
  assert.deepEqual(filterSessionPickRows(rows, 'bbb-2').map(row => row.id), ['bbb-2'])
  assert.equal(filterSessionPickRows(rows, 'zzz').length, 0)
})

test('historyLoadErrorMessage: corrupt logs get the ⚠ + repair pointer', () => {
  const corrupt = historyLoadErrorMessage('abcd1234-ef90', new Error('cannot read corrupt session log: bad frame'))
  assert.ok(corrupt.startsWith('⚠'))
  assert.ok(corrupt.includes('corrupt session log'))
  assert.ok(corrupt.includes('/resume abcd1234'))
  const plain = historyLoadErrorMessage('abcd1234-ef90', new Error('session/not-found'))
  assert.ok(plain.startsWith('Cannot read'))
  assert.ok(!plain.startsWith('⚠'))
})

// ------------------------------------------------------------ fork at turn --

test('`f` forks at the selected turn from list focus: correct seed, parent id, close echo', async () => {
  const { panel, state } = makePanel()
  panel.handleInput('\x1b[B') // down → turn 1
  state.forkAnswer = true
  panel.handleInput('f')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(state.forkDialogs, [{ turnLabel: '1', totalTurns: 3, cold: false }])
  assert.equal(state.forks.length, 1)
  const { seed, parentSessionId } = state.forks[0]
  // The seed runs from seq 0 through turn 1's turn/end (seq 10) — 11 events.
  assert.equal(seed.length, 11)
  assert.equal(seed[0].seq, 0)
  assert.equal(seed[10].type, 'turn/end')
  assert.equal(seed[10].data.turn, 1)
  assert.equal(parentSessionId, 'aaaaaaaa-1111')
  // Success closes the browser with the fork echo.
  assert.equal(state.closed, 1)
  assert.equal(state.finished, 'Forked at turn 1 — new session opened.')
  assert.equal(state.refocused, 1)
})

test('`f` from detail focus targets the same selected turn', async () => {
  const { panel, state } = makePanel()
  panel.handleInput('\x1b[B') // down → turn 1
  panel.handleInput('\x1b[C') // → detail focus
  state.forkAnswer = true
  panel.handleInput('f')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(state.forkDialogs, [{ turnLabel: '1', totalTurns: 3, cold: false }])
  assert.equal(state.forks.length, 1)
  assert.equal(state.forks[0].seed.length, 11)
})

test('`f` cancelled (Esc answer) changes nothing and keeps the browser open', () => {
  const { panel, state } = makePanel()
  panel.handleInput('f') // turn 0 selected; dialog answers cancel by default
  assert.deepEqual(state.forkDialogs, [{ turnLabel: '0', totalTurns: 3, cold: false }])
  assert.deepEqual(state.forks, [], 'no fork ran')
  assert.equal(state.closed, 0)
  const text = panel.render(120).map(stripAnsi).join('\n')
  assert.ok(text.includes('Turn 0 · live snapshot'), 'the browser is still usable')
})

test('a failed fork keeps the browser open with the failure visible', async () => {
  const { panel, state } = makePanel(sampleEvents(), {
    deps: {
      forkAtTurn: async () => { throw new Error('create refused') },
    },
  })
  state.forkAnswer = true
  panel.handleInput('f')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.closed, 0, 'the browser stays open')
  assert.deepEqual(state.forkErrors, ['Fork at turn 0 failed: create refused'])
  const text = panel.render(120).map(stripAnsi).join('\n')
  assert.ok(text.includes('Fork failed: create refused'), text)
  // The flow is retryable after a failure (the in-progress guard released).
  panel.handleInput('f')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.forkErrors.length, 2)
})

test('`f` on a cold-read session flags cold and hands the seed to the fork seam', async () => {
  // `loaded.live: false` is what a cold `s`-picker switch produces.
  const { panel, state } = makePanel(sampleEvents(), { loaded: { live: false } })
  state.forkAnswer = true
  panel.handleInput('f')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(state.forkDialogs, [{ turnLabel: '0', totalTurns: 3, cold: true }])
  assert.equal(state.forks[0].parentSessionId, 'aaaaaaaa-1111', 'the seed is sliced from the browsed session')
  assert.equal(state.forks[0].seed.length, 4, 'seed through turn 0 (seqs 0–3)')
  assert.equal(state.closed, 1)
})

test('`f` inside the filter input types into the query and never opens the dialog', () => {
  const { panel, state } = makePanel()
  panel.handleInput('/') // engage the filter input
  panel.handleInput('f')
  assert.deepEqual(state.forkDialogs, [], 'filter input owns the keyboard — no fork dialog')
  const text = panel.render(120).map(stripAnsi).join('\n')
  assert.ok(text.includes('Filter: f'), text)
  assert.equal(state.closed, 0)
})

// --------------------------------------------------- detail line budget ----

test('detail content: an oversized reply truncates at MAX_DETAIL_LINES with a /resume marker', () => {
  const longReply = Array.from({ length: MAX_DETAIL_LINES + 100 }, (_, i) => `reply line ${i}`).join('\n')
  const turns = groupHistoryTurns([
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 0 } },
    { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'huge reply turn' }] } },
    { type: 'assistant/message', seq: 2, time: 2, data: { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: longReply }] } } },
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 0, reason: { kind: 'completed' } } },
  ])
  const container = buildTurnDetailContainer(turns[0], lightTheme, 'aaaaaaaa-1111')
  const lines = container.render(90).map(stripAnsi)
  const text = lines.join('\n')
  // The budget holds and the marker names the escape hatch.
  assert.ok(lines.length <= MAX_DETAIL_LINES + 50, `rendered lines stay bounded (${lines.length})`)
  assert.ok(text.includes(`… 100 more lines truncated — /resume aaaaaaaa for the full turn`), text)
  // The truncated tail is really gone.
  assert.ok(!text.includes('reply line 4099'), text)
  assert.ok(text.includes('reply line 0'), text)
})

test('detail content: a reply within the budget is never truncated', () => {
  const turns = groupHistoryTurns(sampleEvents())
  for (const turn of turns) {
    const text = buildTurnDetailContainer(turn, lightTheme).render(90).map(stripAnsi).join('\n')
    assert.ok(!text.includes('more lines truncated'), 'within-budget turns render whole')
  }
})

// ----------------------------------------------- filter survives rebuilds --

test('an ENGAGED filter survives a resize rebuild (still typing, query intact)', () => {
  const prevRows = process.stdout.rows
  const prevColumns = process.stdout.columns
  process.stdout.rows = 30
  process.stdout.columns = 120
  try {
    const { panel } = makePanel()
    panel.handleInput('/') // engage the filter input
    panel.handleInput('w')
    panel.handleInput('e')
    let view = panel.render(120).map(stripAnsi).join('\n')
    assert.ok(view.includes('Filter: we_'), 'engaged input shows the live query')
    assert.ok(view.includes('Enter apply · Esc clear filter'), 'input-mode footer is up')
    // Resize: the budget re-derives and the list panel is rebuilt…
    process.stdout.rows = 44
    view = panel.render(120).map(stripAnsi).join('\n')
    // …and the filter input is STILL engaged, query intact.
    assert.ok(view.includes('Filter: we_'), 'engaged state survives the rebuild')
    assert.ok(view.includes('Enter apply · Esc clear filter'), 'input-mode footer survives')
  } finally {
    process.stdout.rows = prevRows
    process.stdout.columns = prevColumns
  }
})
