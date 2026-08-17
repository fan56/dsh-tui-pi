/**
 * Live widget tests — the two live surfaces of src/live-widgets.ts:
 *
 *  - `todosDoc` (the widgets slot ABOVE the chat input): the Todos boxed
 *    panel (top border + header row + body rows + bottom border) that appears
 *    only while it has content and collapses to zero rows when done (/new,
 *    todo/write [], an all-completed snapshot).
 *  - `activityDoc` (the lastRequest container BELOW the editor): the
 *    ` ● <last request>` line (persisting across agent churn), followed by
 *    ONE compact line PER RUNNING agent — `├─ `/`└─ `-prefixed (todo-style
 *    tree connectors in the same column as the todo rows, the last running
 *    agent closing the list with `└─ `), name-first, NO box chrome, NO
 *    `● Agents` header, NO provider, plus the child's latest output line
 *    (` · <tail>`) when one exists. A settled child drops off; when none run
 *    and there is no last-request line the slot collapses to zero rows.
 *
 * Runs against the built lib/ (npm test → pretest build).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Container } from '@earendil-works/pi-tui'
import { AGENT_SPINNER_FRAMES, LiveWidgets } from '../lib/live-widgets.js'
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

/** Two-doc widget: a boxed Todos doc above the input + the activity doc below. */
function makeWidget(theme = darkTheme) {
  const todosDoc = new Container()
  const activityDoc = new Container()
  const widget = new LiveWidgets(todosDoc, activityDoc, theme, () => {})
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

test('the child\'s latest line renders as a ` · <tail>` suffix, truncated with `..`', () => {
  const { activityDoc, widget } = makeWidget()
  const base = { childId: 't', label: 'T', tokens: 0, retries: 0 }
  widget.renderAgents([runningView({ ...base, lastLine: 'compiling src/main.ts' })])
  assert.match(widgetRows(activityDoc)[0], /^└─ ⠋ T · \d+\.\ds · compiling src\/main\.ts$/)
  // Over-wide tail: clipped to tailBudget-2 + `..` (80 cols → budget 24 → 22+2).
  const width = 80
  const prev = process.stdout.columns
  process.stdout.columns = width
  try {
    const longTail = 'x'.repeat(200)
    widget.renderAgents([runningView({ ...base, lastLine: longTail })])
    const row = widgetRows(activityDoc)[0]
    assert.ok(row.endsWith('..'), `over-wide tail ends with ..: ${JSON.stringify(row)}`)
    assert.ok(visibleWidth(row) <= width, `row stays within ${width} cols`)
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
