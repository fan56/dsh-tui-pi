/**
 * Live widget tests — the live surfaces of src/live-widgets.ts:
 *
 *  - `todosDoc` (the widgets slot ABOVE the chat input): the Todos boxed
 *    panel PLUS the fixed ThinkPanel/ToolPanel (src/activity.ts, driven by
 *    `applyEvent`). One panel of each kind exists for the whole run: every
 *    event refreshes it in place (never a transcript block), no content →
 *    zero rows (hidden). Default height is ONE row — identifier + elapsed +
 *    last content line, right-truncated; '5'/'7'/'10'/'all' box the panel.
 *  - `activityDoc` (the lastRequest container BELOW the editor): the
 *    ` ● <last request>` line (persisting across agent churn), followed by
 *    ONE compact line PER RUNNING agent — `├─ `/`└─ `-prefixed, name-first,
 *    no box chrome, no provider, plus the child's latest CONTENT line
 *    (` · <tail>`, live-refreshed, never a tool name) when one exists. A
 *    settled child drops off; when none run and there is no last-request
 *    line the slot collapses to zero rows.
 *
 * Runs against the built lib/ (npm test → pretest build).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Container } from '@earendil-works/pi-tui'
import { ALL_TOOL_RESULT_LINES, STREAMING_TAIL_LINES } from '../lib/activity.js'
import { AGENT_SPINNER_FRAMES, LiveWidgets } from '../lib/live-widgets.js'
import { SPAWN_TOOLS } from '../lib/subagent-policy.js'
import { ansiFg, darkTheme, lightTheme } from '../lib/theme/index.js'
import { visibleWidth } from '../lib/text.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

/**
 * ANSI-stripped terminal rows of `doc`, or [] when it renders nothing.
 * Each row keeps its leading paddingX margin stripped and its trailing
 * right-margin padding dropped; interior padding is preserved (so boxed rows
 * keep their `│ ` chrome, compact agent lines keep their `├─ `/`└─ ` prefix).
 */
function widgetRows(doc, width = 200) {
  return doc.render(width).map(stripAnsi).map(line => line.replace(/^ /, '').replace(/\s+$/, ''))
}

/**
 * Boxed rows only, without the box chrome: `│` rows dropped to their
 * content, the top/bottom borders dropped too. Only meaningful on `todosDoc`
 * (the boxed panel); compact activity rows are NOT `│`-bordered.
 */
function panelBody(doc, width = 200) {
  return widgetRows(doc, width)
    .filter(row => row.startsWith('│'))
    .map(row => row.replace(/^│ /, '').replace(/\s+$/, '').replace(/\s+│$/, ''))
}

/** Two-doc widget: a boxed panels doc above the input + the activity doc below. */
function makeWidget(theme = darkTheme, panelHeight) {
  const todosDoc = new Container()
  const activityDoc = new Container()
  const widget = panelHeight === undefined
    ? new LiveWidgets(todosDoc, activityDoc, theme, () => {})
    : new LiveWidgets(todosDoc, activityDoc, theme, () => {}, panelHeight)
  return { todosDoc, activityDoc, widget }
}

function runningView(over = {}) {
  return {
    childId: 'child-1',
    provider: 'workhorse',
    label: 'Agent ① sleep 20s',
    startedAt: Date.now() - 13600,
    tokens: 562,
    retries: 1,
    maxRetries: 60,
    lastTool: 'command',
    contextWindow: 14000,
    ...over,
  }
}

// ------------------------------------------------------------ todo panel ----

test('todos render as a bordered table panel with status icons, counts and aligned columns', () => {
  const { todosDoc, activityDoc, widget } = makeWidget()
  widget.renderTodos([
    { content: 'first', status: 'pending' },
    { content: 'second', status: 'in_progress' },
    { content: 'third', status: 'completed' },
  ])
  const rows = widgetRows(todosDoc)
  assert.ok(rows[0].startsWith('┌'), 'panel has a top border')
  assert.ok(rows[rows.length - 1].startsWith('└'), 'panel has a bottom border')
  // The panel-framework table: header row + column header + one aligned row
  // per todo (index right-aligned, status icon column, flex content).
  assert.deepEqual(panelBody(todosDoc), [
    '● Todos (1/3)',
    '  # │ ✓  │ Task',
    '  1 │ ☐  │ first',
    '  2 │ ◐  │ second',
    '  3 │ ☑  │ third',
  ])
  // Only the boxed Todos panel is up; the activity doc stays empty.
  assert.deepEqual(widgetRows(activityDoc), [], 'no last request, no agents → activity empty')
})

test('todos table header row is painted in fgSubtle', () => {
  const { todosDoc, widget } = makeWidget()
  widget.renderTodos([{ content: 'a', status: 'pending' }])
  const headerRow = todosDoc.render(200).find(row => stripAnsi(row).includes('Task'))
  assert.ok(headerRow, 'header row renders')
  assert.ok(headerRow.includes(ansiFg(darkTheme.palette.fgSubtle)), 'header painted with fgSubtle')
})

test('empty todos render no panel; the widgets doc collapses to zero rows', () => {
  const { todosDoc, activityDoc, widget } = makeWidget()
  widget.renderTodos([])
  assert.deepEqual(widgetRows(todosDoc), [])
  widget.renderTodos([{ content: 'x', status: 'pending' }])
  assert.ok(widgetRows(todosDoc).length > 0)
  widget.renderTodos([])
  assert.deepEqual(widgetRows(todosDoc), [])
  // Agents alone still keep activity (elsewhere); todos-empty leaves it alone.
  assert.deepEqual(widgetRows(activityDoc), [], 'activity doc is independent of todos')
})

test('an all-completed todo list hides the panel (clear-when-done)', () => {
  const { todosDoc, widget } = makeWidget()
  widget.renderTodos([
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
  ])
  assert.deepEqual(panelBody(todosDoc), [
    '● Todos (1/2)',
    '  # │ ✓  │ Task',
    '  1 │ ☑  │ a',
    '  2 │ ◐  │ b',
  ])
  widget.renderTodos([
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'completed' },
  ])
  assert.deepEqual(widgetRows(todosDoc), [], 'all-completed todos hide the panel')
  widget.renderTodos([{ content: 'c', status: 'pending' }])
  assert.deepEqual(panelBody(todosDoc), [
    '● Todos (0/1)',
    '  # │ ✓  │ Task',
    '  1 │ ☐  │ c',
  ])
})

test('the panel re-lays out at the current width - content is clipped per render (resize-follow)', () => {
  // The regression this locks in: the old widget baked one clipped snapshot
  // into a Text at build time, so a terminal resize either wrapped the rows
  // (narrower) or left them truncated (wider). The table now re-renders at
  // the CURRENT width every frame - render(40) must keep one physical row
  // per todo (content clipped), render(120) must show the content untruncated.
  const long = 'a task whose description is far longer than any narrow column could fit on one row'
  const { todosDoc, widget } = makeWidget()
  widget.renderTodos([{ content: long, status: 'in_progress' }])

  const narrow = widgetRows(todosDoc, 40)
  assert.equal(narrow.length, 5, 'one physical row per panel row at a narrow width (no wrap)')
  const narrowContent = panelBody(todosDoc, 40)[2]
  assert.ok(!narrowContent.includes(long), 'long content is clipped at a narrow width')

  const wide = panelBody(todosDoc, 120)
  assert.ok(wide[2].includes(long), 'the same content renders in full once the terminal widens')
})

// --------------------------------------------------------- running agents ----

test('running agent line: └─ prefix (single, last), spinner + name first, compact meta, no provider', () => {
  const { todosDoc, activityDoc, widget } = makeWidget()
  widget.setLastRequest('帮我把排序算法改成快排')
  widget.renderAgents([runningView()])
  // Compact line in the activity doc, no box chrome at all.
  const rows = widgetRows(activityDoc)
  assert.equal(rows.length, 2, '● line + one compact agent line')
  assert.ok(rows[0].startsWith(' ● '), 'last-request echo renders above the agents')
  assert.equal(rows[0], ' ● 帮我把排序算法改成快排')
  assert.match(rows[1], new RegExp(`^└─ ${AGENT_SPINNER_FRAMES[0]} Agent ① sleep 20s · ↻1≤60 · 562/14k · 13\\.[0-9]s$`),
    'compact line: └─ prefix (the only agent is last) + spinner + name + compact meta, no provider')
  // The line starts with the todo-style connector and prominently shows the NAME.
  assert.ok(rows[1].startsWith('└─ ⠋ '), 'compact line starts with \'└─ \' + spinner + space')
  assert.ok(rows[1].includes('Agent ① sleep 20s'), 'the agent name appears in the line')
  assert.ok(!rows[1].includes('workhorse'), 'the provider is dropped from the line')
  // No box chrome anywhere.
  assert.ok(!rows.join('\n').includes('┌'), 'no top border')
  assert.ok(!rows.join('\n').includes('● Agents'), 'no Agents header')
  assert.ok(!rows.join('\n').includes('⎿'), 'no activity sub-line')
  // Only the activity doc is up; the todos doc stays empty.
  assert.deepEqual(widgetRows(todosDoc), [], 'todos doc empty while only agents run')
})

test('multiple running agents: one compact line each, last one closes with └─', () => {
  const { activityDoc, widget } = makeWidget()
  widget.renderAgents([
    runningView({ childId: 'a', label: 'A' }),
    runningView({ childId: 'b', label: 'B' }),
  ])
  const rows = widgetRows(activityDoc)
  assert.equal(rows.length, 2, 'one line per running agent')
  assert.match(rows[0], /^├─ ⠋ A ·/)
  assert.match(rows[1], /^└─ ⠋ B ·/)
  // The last row uses the todo `└─ ` connector and the non-last uses `├─ `.
  assert.ok(!rows[0].startsWith('└─'), 'non-last agent line is ├─ ')
  assert.ok(rows[1].startsWith('└─'), 'last agent line closes with └─ ')
})

test('an empty label falls back to `subagent`; provider is dropped', () => {
  const { activityDoc, widget } = makeWidget()
  // No provider on the view — the line still renders, name first.
  widget.renderAgents([runningView({ provider: undefined })])
  assert.match(widgetRows(activityDoc)[0], /^└─ ⠋ Agent ① sleep 20s ·/)
  // A blank label must never render an empty name — fall back to `subagent`
  // (no child id suffix).
  widget.renderAgents([runningView({ label: '   ', childId: 'deadbeef1234' })])
  assert.match(widgetRows(activityDoc)[0], /^└─ ⠋ subagent ·/)
  // Whitespace-only labels are treated as empty too.
  widget.renderAgents([runningView({ label: '', childId: 'abc' })])
  assert.match(widgetRows(activityDoc)[0], /^└─ ⠋ subagent ·/)
})

test('compact token meta: tokens[/contextWindow] with fmtCompact, no percent/unit', () => {
  const { activityDoc, widget } = makeWidget()
  const base = { childId: 't', label: 'T', tokens: 0, retries: 0 }
  // 20_965 tokens, 1_000_000 window → `20k/1m` (floor for k).
  widget.renderAgents([runningView({ ...base, tokens: 20_965, contextWindow: 1_000_000 })])
  assert.match(widgetRows(activityDoc)[0], /^└─ ⠋ T · 20k\/1m · \d+\.\ds$/)
  // 1_500_000 window → `1.5m` (1 decimal, no trailing .0).
  widget.renderAgents([runningView({ ...base, tokens: 20_965, contextWindow: 1_500_000 })])
  assert.match(widgetRows(activityDoc)[0], /^└─ ⠋ T · 20k\/1\.5m · \d+\.\ds$/)
  // No contextWindow → only the compact token count.
  widget.renderAgents([runningView({ ...base, tokens: 20_965, contextWindow: undefined })])
  assert.match(widgetRows(activityDoc)[0], /^└─ ⠋ T · 20k · \d+\.\ds$/)
  // tokens === 0 → the token segment is dropped (unchanged guard).
  widget.renderAgents([runningView({ ...base, tokens: 0, contextWindow: 1_000_000 })])
  assert.match(widgetRows(activityDoc)[0], /^└─ ⠋ T · \d+\.\ds$/)
})

test('the child\'s latest CONTENT line renders as a ` · <tail>` suffix, right-truncated', () => {
  const { activityDoc, widget } = makeWidget()
  const base = { childId: 't', label: 'T', tokens: 0, retries: 0 }
  widget.renderAgents([runningView({ ...base, lastLine: 'compiling src/main.ts' })])
  assert.match(widgetRows(activityDoc)[0], /^└─ ⠋ T · \d+\.\ds · compiling src\/main\.ts$/)
  // Over-wide tail: takes everything the row has left and is truncated at the
  // RIGHT edge (clipToWidth's ellipsis), one row, never wrapped, no tool name.
  const width = 80
  const prev = process.stdout.columns
  process.stdout.columns = width
  try {
    const longTail = 'x'.repeat(200)
    widget.renderAgents([runningView({ ...base, lastLine: longTail })])
    const row = widgetRows(activityDoc)[0]
    assert.ok(visibleWidth(row) <= width, `row stays within ${width} cols`)
    assert.ok(row.includes(' · ' + 'x'.repeat(20)), 'tail fills the row to the right edge')
    assert.ok(!row.includes('⚙'), 'a tool name never appears in the tail')
  } finally {
    process.stdout.columns = prev
  }
})

test('settled agents drop off — clear-when-done', () => {
  const { activityDoc, widget } = makeWidget()
  widget.renderAgents([runningView({ outcome: 'completed' })])
  assert.deepEqual(widgetRows(activityDoc), [], 'all settled → activity collapses')
  widget.renderAgents([
    runningView({ childId: 'done', label: 'Done', outcome: 'completed' }),
    runningView({ childId: 'live', label: 'Live' }),
  ])
  const rows = widgetRows(activityDoc)
  assert.equal(rows.length, 1, 'only the running child is listed')
  assert.match(rows[0], /Live/)
})

test('tickLive advances the spinner while running; no-op when nothing runs', () => {
  const { activityDoc, widget } = makeWidget()
  widget.renderAgents([runningView()])
  const before = widgetRows(activityDoc)[0]
  widget.tickLive()
  const after = widgetRows(activityDoc)[0]
  assert.notEqual(before, after, 'spinner frame advanced')
  widget.renderAgents([runningView({ outcome: 'completed' })])
  widget.tickLive()
  assert.deepEqual(widgetRows(activityDoc), [])
})

test('renderAgents([]) empties the agent lines but keeps the last-request line', () => {
  const { activityDoc, widget } = makeWidget()
  widget.setLastRequest('hello')
  widget.renderAgents([runningView()])
  assert.equal(widgetRows(activityDoc).length, 2)
  widget.renderAgents([])
  const rows = widgetRows(activityDoc)
  assert.deepEqual(rows, [' ● hello'], 'agents dropped, ● line persists')
})

// ------------------------------------------------------------ combined ----

test('todos boxed panel + compact activity lines coexist on their own docs', () => {
  const { todosDoc, activityDoc, widget } = makeWidget()
  widget.setLastRequest('defrag the index')
  widget.renderTodos([{ content: 't', status: 'in_progress' }])
  widget.renderAgents([runningView()])
  const todoRows = widgetRows(todosDoc)
  assert.ok(todoRows[0].startsWith('┌'), 'todos stay boxed')
  assert.equal(panelBody(todosDoc)[0], '● Todos (0/1)')
  const activityRows = widgetRows(activityDoc)
  assert.equal(activityRows[0], ' ● defrag the index')
  assert.match(activityRows[1], /^└─ ⠋ Agent ① sleep 20s · ↻1≤60 · 562\/14k · 13\.[0-9]s$/)
})

// ------------------------------------------------------ width + lifecycle ----

test('every rendered row fits the terminal width (pathological content)', () => {
  const width = 80
  const prev = process.stdout.columns
  process.stdout.columns = width
  try {
    const { todosDoc, activityDoc, widget } = makeWidget()
    widget.setLastRequest('x')
    widget.renderTodos([{ content: 'x'.repeat(500), status: 'pending' }])
    widget.renderAgents([
      runningView({
        provider: 'p'.repeat(200),
        label: 'y'.repeat(500),
        lastTool: 'z'.repeat(500),
      }),
    ])
    for (const row of todosDoc.render(width)) {
      assert.ok(visibleWidth(stripAnsi(row)) <= width, `todos row exceeds ${width}: ${JSON.stringify(stripAnsi(row))}`)
    }
    for (const row of activityDoc.render(width)) {
      assert.ok(visibleWidth(stripAnsi(row)) <= width, `activity row exceeds ${width}: ${JSON.stringify(stripAnsi(row))}`)
    }
    // The compact agent line stays a single physical row (no wrap).
    assert.equal(widgetRows(activityDoc).length, 2, '● line + one agent row, no wrap')
    // A long last-request prompt is clipped to the one-row terminal budget
    // (` columns - 5`: 2 padding cols + 3 ` ● ` prefix cols) so it NEVER wraps.
    const budget = Math.max(1, (process.stdout.columns ?? 200) - 5)
    const longRequest = 'x'.repeat(200)
    widget.setLastRequest(longRequest)
    const longRows = widgetRows(activityDoc)
    assert.equal(longRows.length, 2, 'long last-request line + one agent row, no wrap')
    assert.equal(longRows[0], ` ● ${'x'.repeat(budget)}`,
      `request display clipped to the ${budget}-col plain-text budget`)
    assert.ok(visibleWidth(longRows[0]) <= width - 2,
      `request line fits the <= columns-2 one-row budget (${visibleWidth(longRows[0])} <= ${width - 2})`)
    // A long CJK prompt is width-clipped whole-grapheme and never splits a
    // full-width character or wraps onto a second row.
    widget.setLastRequest('务'.repeat(200))
    const cjkRow = widgetRows(activityDoc)[0]
    assert.equal(widgetRows(activityDoc).length, 2, 'long CJK request line still one row')
    assert.ok(visibleWidth(cjkRow) <= width - 2,
      `CJK request line fits the <= columns-2 budget (${visibleWidth(cjkRow)} <= ${width - 2})`)
  } finally {
    process.stdout.columns = prev
  }
})

test('boxed todos never wrap; each compact agent line stays one row', () => {
  const width = 80
  const prev = process.stdout.columns
  process.stdout.columns = width
  try {
    const { todosDoc, activityDoc, widget } = makeWidget()
    widget.setLastRequest('query')
    widget.renderTodos([{ content: 'x'.repeat(500), status: 'pending' }])
    // 5 rows at the new table shape: top border, panel header, column header,
    // one data row, bottom border - no row wraps no matter the content width.
    assert.equal(todosDoc.render(width).length, 5, 'boxed todos: no row wraps')
    widget.renderAgents([runningView({ label: 'y'.repeat(500), provider: 'p'.repeat(200) })])
    assert.equal(widgetRows(activityDoc).length, 2, '● line + one compact agent row, no wrap')
  } finally {
    process.stdout.columns = prev
  }
})

test('setTheme recolors the widget and keeps its content', () => {
  const { todosDoc, activityDoc, widget } = makeWidget()
  widget.setLastRequest('theme me')
  widget.renderTodos([{ content: 't', status: 'in_progress' }])
  widget.renderAgents([runningView()])
  const beforeDark = activityDoc.render(200).join('')
  // A genuinely different bundle (light palette) — setTheme is a no-op on the
  // identical bundle, but changing bundles must re-render with new colors.
  widget.setTheme(lightTheme)
  // Todos boxed panel intact.
  assert.equal(panelBody(todosDoc)[0], '● Todos (0/1)')
  // Compact agent line + ● line intact after recolor.
  const rows = widgetRows(activityDoc)
  assert.equal(rows[0], ' ● theme me')
  assert.match(rows[1], /^└─ ⠋ Agent ① sleep 20s · ↻1≤60 · 562\/14k · 13\.[0-9]s$/)
  // The ● line's fgMuted changed with the new (light) theme palette.
  const after = activityDoc.render(200).join('')
  assert.notEqual(after, beforeDark, 'recolored away from the original dark palette')
  assert.ok(after.includes(ansiFg(lightTheme.palette.fgMuted)), '● line recolored with the new theme')
})

test('clear() drops todos and agent lines but keeps the last-request echo', () => {
  const { todosDoc, activityDoc, widget } = makeWidget()
  widget.setLastRequest('keep me')
  widget.renderTodos([{ content: 't', status: 'pending' }])
  widget.renderAgents([runningView()])
  assert.ok(widgetRows(todosDoc).length > 0)
  assert.ok(widgetRows(activityDoc).length > 0)
  widget.clear()
  assert.deepEqual(widgetRows(todosDoc), [], '/new clears the todos panel')
  assert.deepEqual(widgetRows(activityDoc), [' ● keep me'], '/new keeps the last-request echo')
})

// ---------------------------------------------- fixed think/tool panels ----

/** Event factories for the panel phase machine (plain shapes, log order irrelevant). */
const chunkEvent = (type, text) => ({
  type: 'assistant/chunk',
  data: { turn: 0, step: 0, chunk: { type, text } },
})
const toolCallEvent = (callId, name, rawArguments) => ({
  type: 'tool/call',
  data: { turn: 0, step: 0, callId, name, arguments: rawArguments },
})
const toolResultEvent = (callId, text, isError = false) => ({
  type: 'tool/result',
  data: { turn: 0, step: 0, message: { content: [{ toolCallId: callId, isError, content: [{ type: 'text', text }] }] } },
})

test('think panel: one row — identifier + elapsed + last content line, refreshed in place', () => {
  const { todosDoc, widget } = makeWidget()
  assert.deepEqual(widgetRows(todosDoc), [], 'hidden while no content')
  widget.applyEvent(chunkEvent('reasoning-delta', 'first thought'))
  let rows = widgetRows(todosDoc)
  assert.equal(rows.length, 1, 'exactly one borderless row')
  assert.match(rows[0], /^💭 thinking · \d+\.\ds · first thought$/, 'identifier + elapsed + last line')
  // More deltas refresh the SAME row: the newest non-blank line wins.
  widget.applyEvent(chunkEvent('reasoning-delta', '\nsecond thought'))
  rows = widgetRows(todosDoc)
  assert.equal(rows.length, 1, 'still ONE row — the same panel refreshed, no new blocks')
  assert.match(rows[0], /second thought$/, 'the last content line wins')
  assert.ok(!rows[0].includes('first thought'), 'older lines do not render in the 1-line row')
})

test('think panel hides on the next phase event; reopens on the next burst', () => {
  const { todosDoc, widget } = makeWidget()
  widget.applyEvent(chunkEvent('reasoning-delta', 'thinking'))
  assert.equal(widgetRows(todosDoc).length, 1)
  // The answer streams into the transcript — the panel hides.
  widget.applyEvent(chunkEvent('text-delta', 'the answer'))
  assert.deepEqual(widgetRows(todosDoc), [], 'text delta hides the think panel')
  widget.applyEvent(chunkEvent('reasoning-delta', 'again'))
  assert.equal(widgetRows(todosDoc).length, 1, 'a new burst reopens the SAME panel')
  // Assembled message, user message and turn end all hide it.
  widget.applyEvent({ type: 'assistant/message', data: { turn: 0, step: 0, message: { content: [] } } })
  assert.deepEqual(widgetRows(todosDoc), [], 'assembled message hides the think panel')
  widget.applyEvent(chunkEvent('reasoning-delta', 'burst'))
  widget.applyEvent({ type: 'turn/end', data: { turn: 0, reason: { kind: 'stop' } } })
  assert.deepEqual(widgetRows(todosDoc), [], 'turn end hides the think panel')
})

test('tool panel: pending row with name + subject, settles with status icon and last result line', () => {
  const { todosDoc, widget } = makeWidget()
  assert.deepEqual(widgetRows(todosDoc), [], 'hidden while no content')
  widget.applyEvent(toolCallEvent('c1', 'read', '{"path": "src/welcome.ts"}'))
  let rows = widgetRows(todosDoc)
  assert.equal(rows.length, 1)
  assert.match(rows[0], /^⚙ read src\/welcome\.ts · \d+\.\ds · src\/welcome\.ts$/, 'pending: icon + name + subject + elapsed + args tail')
  widget.applyEvent(toolResultEvent('c1', 'line one\nline two'))
  rows = widgetRows(todosDoc)
  assert.equal(rows.length, 1, 'the SAME panel settled — refreshed, no new block')
  assert.match(rows[0], /^✔ read src\/welcome\.ts · \d+\.\ds · line two$/, 'settled: success icon, last result line')
  // A second call refreshes the same panel (pending again), an error settles with ✘.
  widget.applyEvent(toolCallEvent('c2', 'bash', '{"command": "ls"}'))
  assert.match(widgetRows(todosDoc)[0], /^⚙ bash ls · \d+\.\ds · \$ ls$/, 'a new call refreshes the same panel')
  widget.applyEvent(toolResultEvent('c2', 'boom', true))
  assert.match(widgetRows(todosDoc)[0], /^✘ bash ls · \d+\.\ds · boom$/, 'error settle swaps the icon')
})

test('tool panel: a result for a non-tracked call is ignored (parallel calls)', () => {
  const { todosDoc, widget } = makeWidget()
  widget.applyEvent(toolCallEvent('a', 'read', '{"path": "one"}'))
  widget.applyEvent(toolCallEvent('b', 'read', '{"path": "two"}'))
  assert.match(widgetRows(todosDoc)[0], /two/, 'the panel tracks the newest call')
  widget.applyEvent(toolResultEvent('a', 'late result'))
  assert.match(widgetRows(todosDoc)[0], /^⚙ read two/, 'the stale result does not settle the tracked tool')
  widget.applyEvent(toolResultEvent('b', 'right result'))
  assert.match(widgetRows(todosDoc)[0], /^✔ read two .* right result$/, 'the matching result settles it')
})

test('tool panel hides on turn end / user message / text delta; reasoning swaps to the think panel', () => {
  const { todosDoc, widget } = makeWidget()
  widget.applyEvent(toolCallEvent('c1', 'bash', '{"command": "ls"}'))
  assert.equal(widgetRows(todosDoc).length, 1)
  widget.applyEvent(chunkEvent('reasoning-delta', 'next thought'))
  const rows = widgetRows(todosDoc)
  assert.equal(rows.length, 1, 'one panel at a time — think replaced tool')
  assert.match(rows[0], /^💭 thinking/)
  widget.applyEvent(toolCallEvent('c2', 'bash', '{"command": "pwd"}'))
  assert.match(widgetRows(todosDoc)[0], /^⚙ bash pwd/, 'tool replaced think')
  widget.applyEvent({ type: 'turn/end', data: { turn: 0, reason: { kind: 'stop' } } })
  assert.deepEqual(widgetRows(todosDoc), [], 'turn end hides the tool panel')
  widget.applyEvent(toolCallEvent('c3', 'bash', '{"command": "ls"}'))
  widget.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } })
  assert.deepEqual(widgetRows(todosDoc), [], 'user message hides the tool panel')
})

test('delegation spawn tools never open the tool panel (their subagent shows below the editor)', () => {
  const { todosDoc, widget } = makeWidget()
  // Every spawn/delegation tool family member renders no tool block.
  for (const name of SPAWN_TOOLS) {
    widget.applyEvent(toolCallEvent(`d-${name}`, name, '{"description": "delegate this"}' ))
    assert.deepEqual(widgetRows(todosDoc), [], `${name} opens no tool block`)
  }
  // A delegation call also clears a stale settled tool panel.
  widget.applyEvent(toolCallEvent('c1', 'bash', '{"command": "ls"}'))
  widget.applyEvent(toolResultEvent('c1', 'done'))
  assert.equal(widgetRows(todosDoc).length, 1, 'a real tool renders')
  widget.applyEvent(toolCallEvent('d2', 'use_agent', '{"name": "workhorse"}'))
  assert.deepEqual(widgetRows(todosDoc), [], 'delegation clears any stale tool panel')
  // Its result does not resurrect a panel; non-spawn tools still render.
  widget.applyEvent(toolResultEvent('d2', 'delegation returned'))
  assert.deepEqual(widgetRows(todosDoc), [], 'a delegation result never opens a panel')
  widget.applyEvent(toolCallEvent('c2', 'bash', '{"command": "pwd"}'))
  assert.equal(widgetRows(todosDoc).length, 1, 'non-spawn tools still render')
})

test('1-line rows never wrap: long last lines truncate at the right edge', () => {
  const width = 80
  const prev = process.stdout.columns
  process.stdout.columns = width
  try {
    const { todosDoc, widget } = makeWidget()
    widget.applyEvent(chunkEvent('reasoning-delta', 'x'.repeat(300)))
    let rows = widgetRows(todosDoc, width)
    assert.equal(rows.length, 1, 'think row stays one physical row')
    assert.ok(visibleWidth(rows[0]) <= width, `think row fits ${width} cols`)
    widget.applyEvent(toolCallEvent('c1', 'bash', '{"command": "ls"}'))
    widget.applyEvent(toolResultEvent('c1', Array.from({ length: 50 }, () => 'y'.repeat(30)).join('\n')))
    rows = widgetRows(todosDoc, width)
    assert.equal(rows.length, 1, 'tool row stays one physical row')
    assert.ok(visibleWidth(rows[0]) <= width, `tool row fits ${width} cols`)
    // A long CJK content line is clipped whole-grapheme and never wraps.
    widget.applyEvent(toolCallEvent('c2', 'bash', '{"command": "ls"}'))
    widget.applyEvent(toolResultEvent('c2', '务'.repeat(200)))
    rows = widgetRows(todosDoc, width)
    assert.equal(rows.length, 1, 'CJK tail stays one row')
    assert.ok(visibleWidth(rows[0]) <= width, `CJK row fits ${width} cols`)
  } finally {
    process.stdout.columns = prev
  }
})

test('tickLive repaints while a panel is visible even with no running agents', () => {
  const { todosDoc, activityDoc, widget } = makeWidget()
  widget.applyEvent(chunkEvent('reasoning-delta', 'x'))
  widget.tickLive()
  assert.equal(widgetRows(todosDoc).length, 1, 'the panel survives the tick (elapsed refresh)')
  widget.applyEvent({ type: 'turn/end', data: { turn: 0, reason: { kind: 'stop' } } })
  widget.tickLive()
  assert.deepEqual(widgetRows(todosDoc), [], 'nothing live — tick is a no-op')
  assert.deepEqual(widgetRows(activityDoc), [], 'no stray activity rows')
})

test('clear() (/new) hides both panels', () => {
  const { todosDoc, widget } = makeWidget()
  widget.applyEvent(chunkEvent('reasoning-delta', 'x'))
  widget.applyEvent(toolCallEvent('c1', 'bash', '{"command": "ls"}'))
  widget.clear()
  assert.deepEqual(widgetRows(todosDoc), [])
})

// ------------------------------------------------------- boxed heights ----

test("boxed '5': full box (border + header + 4 content rows + border), settle keeps the shape", () => {
  const { todosDoc, widget } = makeWidget(darkTheme, '5')
  widget.applyEvent(toolCallEvent('c1', 'bash', '{"command": "ls"}'))
  let rows = widgetRows(todosDoc, 200)
  assert.equal(rows.length, 7, 'displayed 5 + 2 borders')
  assert.match(rows[0], /^┌─+┐$/, 'top border')
  assert.match(rows[6], /^└─+┘$/, 'bottom border')
  assert.ok(rows[1].includes('⚙ bash'), 'pending header')
  assert.ok(rows[2].includes('$ ls'), 'detail row inside the box')
  widget.applyEvent(toolResultEvent('c1', 'a.txt'))
  rows = widgetRows(todosDoc, 200)
  assert.equal(rows.length, 7, 'settled box keeps its shape')
  assert.ok(rows[1].includes('✔ bash'), 'header flipped to the success icon')
  assert.ok(rows.join('\n').includes('a.txt'), 'result row inside the box')
})

test('boxed think panel carries the thinking color and italic header, box shape at every fixed height', () => {
  const { todosDoc, widget } = makeWidget(darkTheme, '7')
  widget.applyEvent(chunkEvent('reasoning-delta', 'one\ntwo\nthree\nfour\nfive\nsix'))
  let rows = widgetRows(todosDoc, 200)
  assert.equal(rows.length, 9, 'displayed 7 + 2 borders')
  assert.ok(rows[1].includes('💭 thinking'), 'header row')
  assert.ok(rows.join('\n').includes('three'), 'body keeps the tail at the row budget')
  widget.setPanelHeight('10')
  rows = widgetRows(todosDoc, 200)
  assert.equal(rows.length, 12, 'displayed 10 + 2 borders')
  widget.setPanelHeight('1')
  rows = widgetRows(todosDoc, 200)
  assert.equal(rows.length, 1, 'back to the 1-line row')
})

test("'all' boxes the full body: think keeps a bounded live tail, tool results cap at 2000 lines", () => {
  const { todosDoc, widget } = makeWidget(darkTheme, 'all')
  // Think: 500 streamed lines → only the newest 200 are boxed (bounded tail).
  const thinkLines = Array.from({ length: 500 }, (_, i) => `think ${i + 1}`)
  widget.applyEvent(chunkEvent('reasoning-delta', thinkLines.join('\n')))
  let rows = widgetRows(todosDoc, 400)
  assert.equal(rows.length, STREAMING_TAIL_LINES + 3, 'top border + header + bounded tail + bottom border')
  assert.ok(!rows.join('\n').includes('think 1'), 'the head is not boxed while streaming')
  assert.ok(rows[2].includes(`think ${500 - STREAMING_TAIL_LINES + 1}`), 'the tail starts at the newest 200 lines')
  widget.applyEvent({ type: 'turn/end', data: { turn: 0, reason: { kind: 'stop' } } })

  // Tool: 2100 result lines + 1 detail → capped at 2000 with the drop marker.
  widget.setPanelHeight('all')
  widget.applyEvent(toolCallEvent('c1', 'bash', '{"command": "ls"}'))
  const resultLines = Array.from({ length: 2100 }, (_, i) => `result ${i + 1}`)
  widget.applyEvent(toolResultEvent('c1', resultLines.join('\n')))
  rows = widgetRows(todosDoc, 400)
  assert.equal(rows.length, ALL_TOOL_RESULT_LINES + 3, '2000 body rows + chrome — capped')
  assert.ok(rows[2].includes('(+101 lines)'), 'marker reports the dropped count')
  assert.ok(rows[3].includes('result 102'), 'newest result rows stay on screen')
  assert.match(rows[ALL_TOOL_RESULT_LINES + 2], /^└─+┘$/, 'bottom border closes the box')
})

test('boxed panels keep their shape on narrow terminals (10/16/20 columns)', () => {
  const prev = process.stdout.columns
  try {
    for (const columns of [10, 16, 20]) {
      process.stdout.columns = columns
      const { todosDoc, widget } = makeWidget(darkTheme, '5')
      widget.applyEvent(chunkEvent('reasoning-delta', 'x'.repeat(120)))
      widget.applyEvent({ type: 'turn/end', data: { turn: 0, reason: { kind: 'stop' } } })
      widget.applyEvent(toolCallEvent('c1', 'bash', '{"command": "ls"}'))
      const rows = widgetRows(todosDoc, columns)
      assert.equal(rows.length, 7, `tool panel stays 7 rows at ${columns} columns`)
      for (const row of rows) {
        assert.ok(visibleWidth(row) <= columns, `row fits ${columns} cols: ${JSON.stringify(row)}`)
      }
      // Carriage returns in a result never split the fixed rows either.
      widget.applyEvent(toolResultEvent('c1', '50%|----|\r60%|----|\r\nfinished'))
      const settled = widgetRows(todosDoc, columns)
      assert.equal(settled.length, 7, 'carriage returns keep the 7-row shape')
    }
  } finally {
    process.stdout.columns = prev
  }
})

test('panels re-render at the current width each frame (resize-follow, no baked rows)', () => {
  const { todosDoc, widget } = makeWidget(darkTheme, '5')
  widget.applyEvent(toolCallEvent('c1', 'bash', '{"command": "ls"}'))
  const narrow = widgetRows(todosDoc, 40)
  assert.equal(narrow.length, 7, 'box survives a narrow render')
  const wide = widgetRows(todosDoc, 120)
  assert.equal(wide.length, 7, 'box survives a wide render')
  assert.ok(visibleWidth(wide[0]) > visibleWidth(narrow[0]), 'the box re-lays out at the live width')
})

// -------------------------------------------------------- theme + panels ----

test('setTheme recolors the panels in place (live state, no rebuild)', () => {
  const { todosDoc, widget } = makeWidget(darkTheme, '1')
  widget.applyEvent(chunkEvent('reasoning-delta', 'colorful thought'))
  const before = todosDoc.render(200).join('')
  assert.ok(before.includes(ansiFg(darkTheme.palette.thinking)), 'think identifier painted with the dark thinking color')
  widget.setTheme(lightTheme)
  const after = todosDoc.render(200).join('')
  assert.ok(after.includes(ansiFg(lightTheme.palette.thinking)), 'think identifier recolored to the light thinking color')
  assert.ok(!after.includes(ansiFg(darkTheme.palette.thinking)), 'no dark thinking color left behind')
  assert.ok(after.includes('colorful thought'), 'content survives the recolor')
  // Boxed mode recolors its surfaces too.
  widget.setPanelHeight('5')
  widget.applyEvent(toolCallEvent('c1', 'bash', '{"command": "ls"}'))
  widget.applyEvent(toolResultEvent('c1', 'ok'))
  const toolRows = todosDoc.render(200).join('')
  assert.ok(toolRows.includes('✔'), 'settled tool renders after the recolor')
})
