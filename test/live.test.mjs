/**
 * Live Todos/Agents widget tests — the bordered panels pinned above the chat
 * input (see src/live-widgets.ts): each panel is a box (top border + header
 * row + body rows + bottom border) that appears only while it has content and
 * collapses to zero rows when done (/new, todo/write [], all subagents
 * settled — settled children drop off the board immediately).
 * Runs against the built lib/ (npm test → pretest build).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Container } from '@earendil-works/pi-tui'
import { AGENT_SPINNER_FRAMES, LiveWidgets } from '../lib/live-widgets.js'
import { buildTheme, darkTheme } from '../lib/theme/index.js'
import { githubDark } from '../lib/theme/palette.js'
import { visibleWidth } from '../lib/text.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

/**
 * ANSI-stripped terminal rows of the widget doc, or [] when the widget is
 * empty (no Text child → zero rows). Each row keeps its leading paddingX
 * margin stripped; interior box padding is preserved.
 */
function widgetRows(doc, width = 200) {
  return doc.render(width).map(stripAnsi).map(line => line.replace(/^ /, ''))
}

/**
 * The widget's content rows without the box chrome: borders dropped, every
 * `│` row's leading `│ ` and trailing padding+border stripped. Ideal for
 * exact content assertions. (Rows carry trailing width-padding after the
 * right border, so strip that first.)
 */
function panelBody(doc, width = 200) {
  return widgetRows(doc, width)
    .filter(row => row.startsWith('│'))
    .map(row => row.replace(/^│ /, '').replace(/\s+$/, '').replace(/\s+│$/, ''))
}

function makeWidget(theme = darkTheme) {
  const doc = new Container()
  const widget = new LiveWidgets(doc, theme, () => {})
  return { doc, widget }
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

test('todos render as a bordered panel with status icons, counts and connectors', () => {
  const { doc, widget } = makeWidget()
  widget.renderTodos([
    { content: 'first', status: 'pending' },
    { content: 'second', status: 'in_progress' },
    { content: 'third', status: 'completed' },
  ])
  const rows = widgetRows(doc)
  assert.ok(rows[0].startsWith('┌'), 'panel has a top border')
  assert.ok(rows[rows.length - 1].startsWith('└'), 'panel has a bottom border')
  // Header counts done/total; tree lines with connectors; status icons follow
  // the input order (☐ pending, ◐ in_progress, ☑ completed).
  assert.deepEqual(panelBody(doc), [
    '● Todos (1/3)',
    '├─ ☐ first',
    '├─ ◐ second',
    '└─ ☑ third',
  ])
})

test('empty todos render no panel; the widget collapses to zero rows', () => {
  const { doc, widget } = makeWidget()
  widget.renderTodos([])
  assert.deepEqual(widgetRows(doc), [])
  // Clearing an existing panel also removes the Text entirely.
  widget.renderTodos([{ content: 'x', status: 'pending' }])
  assert.ok(widgetRows(doc).length > 0)
  widget.renderTodos([])
  assert.deepEqual(widgetRows(doc), [])
})

// ------------------------------------------------------------- agents panel ----

test('running agent line: spinner, provider + label, meta and activity', () => {
  const { doc, widget } = makeWidget()
  widget.renderAgents([runningView()])
  const rows = widgetRows(doc)
  assert.ok(rows[0].startsWith('┌'), 'agents panel has a top border')
  assert.equal(rows.length, 5) // top + header + main + activity + bottom
  const body = panelBody(doc)
  assert.equal(body[0], '● Agents')
  // Elapsed depends on Date.now(); startedAt was set 13.6s ago.
  assert.match(body[1], new RegExp(`^└─ ${AGENT_SPINNER_FRAMES[0]} workhorse  Agent ① sleep 20s · ↻1≤60 · 562 token \\(4%\\) · 13\\.[0-9]s$`))
  assert.equal(body[2], '     ⎿  running command…')
})

test('multiple running agents use ├─/└─ connectors and │ activity indents', () => {
  const { doc, widget } = makeWidget()
  widget.renderAgents([
    runningView({ childId: 'a', label: 'A' }),
    runningView({ childId: 'b', label: 'B' }),
  ])
  const body = panelBody(doc)
  assert.equal(body[0], '● Agents')
  assert.match(body[1], /^├─ ⠋ workhorse  A /)
  assert.equal(body[2], '│    ⎿  running command…')
  assert.match(body[3], /^└─ ⠋ workhorse  B /)
  assert.equal(body[4], '     ⎿  running command…')
})

test('a view without provider renders just the label', () => {
  const { doc, widget } = makeWidget()
  widget.renderAgents([runningView({ provider: undefined })])
  assert.match(panelBody(doc)[1], /^└─ ⠋ Agent ① sleep 20s ·/)
})

test('settled agents drop off the board — clear-when-done', () => {
  const { doc, widget } = makeWidget()
  // A settled view alone: the agents panel (and the whole widget) vanishes.
  widget.renderAgents([runningView({ outcome: 'completed' })])
  assert.deepEqual(widgetRows(doc), [])
  // While another child still runs, the settled one is hidden, not shown.
  widget.renderAgents([
    runningView({ childId: 'done', label: 'Done', outcome: 'completed' }),
    runningView({ childId: 'live', label: 'Live' }),
  ])
  const mainLines = panelBody(doc).filter(row => row.startsWith('├─') || row.startsWith('└─'))
  assert.equal(mainLines.length, 1, 'only the running child is listed')
  assert.match(mainLines[0], /Live/)
})

test('tickLive advances the spinner while running; no-op when nothing runs', () => {
  const { doc, widget } = makeWidget()
  widget.renderAgents([runningView()])
  const before = panelBody(doc)[1]
  widget.tickLive()
  const after = panelBody(doc)[1]
  assert.notEqual(before, after, 'spinner frame advanced')
  // All settled → tickLive is a no-op.
  widget.renderAgents([runningView({ outcome: 'completed' })])
  widget.tickLive()
  assert.deepEqual(widgetRows(doc), [])
})

test('renderAgents([]) removes the block', () => {
  const { doc, widget } = makeWidget()
  widget.renderAgents([runningView()])
  assert.ok(widgetRows(doc).length > 0)
  widget.renderAgents([])
  assert.deepEqual(widgetRows(doc), [])
})

// ------------------------------------------------------------ combined ----

test('todos + agents render as two stacked bordered panels', () => {
  const { doc, widget } = makeWidget()
  widget.renderTodos([{ content: 't', status: 'in_progress' }])
  widget.renderAgents([runningView()])
  const rows = widgetRows(doc)
  // Two boxes: todos top border … its bottom border, then agents top border…
  assert.ok(rows[0].startsWith('┌'), 'first panel top border')
  const topBorders = rows.filter(row => row.startsWith('┌')).length
  const bottomBorders = rows.filter(row => row.startsWith('└')).length
  assert.equal(topBorders, 2, 'two panels stacked')
  assert.equal(bottomBorders, 2, 'two bottom borders')
  const body = panelBody(doc)
  assert.deepEqual(body.slice(0, 3), ['● Todos (0/1)', '└─ ◐ t', '● Agents'])
  assert.match(body[3], /^└─ ⠋ workhorse  Agent ① sleep 20s · ↻1≤60 · 562 token \(4%\) · 13\.[0-9]s$/)
  assert.equal(body[4], '     ⎿  running command…')
})

// ------------------------------------------------------ width + lifecycle ----

test('every rendered row fits the terminal width (pathological content)', () => {
  const width = 80
  const prev = process.stdout.columns
  process.stdout.columns = width
  try {
    const { doc, widget } = makeWidget()
    widget.renderTodos([{ content: 'x'.repeat(500), status: 'pending' }])
    widget.renderAgents([
      runningView({
        provider: 'p'.repeat(200),
        label: 'y'.repeat(500),
        lastTool: 'z'.repeat(500),
      }),
    ])
    for (const row of doc.render(width)) {
      assert.ok(visibleWidth(stripAnsi(row)) <= width, `row exceeds ${width}: ${JSON.stringify(stripAnsi(row))}`)
    }
  } finally {
    process.stdout.columns = prev
  }
})

test('boxed rows never wrap inside the panel width', () => {
  const width = 80
  const prev = process.stdout.columns
  process.stdout.columns = width
  try {
    const { doc, widget } = makeWidget()
    widget.renderTodos([{ content: 'x'.repeat(500), status: 'pending' }])
    // Pathological content must still produce exactly one boxed row per line
    // (top + header + body + bottom = 4 rows); a wrapped content line would add
    // extra rows.
    assert.equal(doc.render(width).length, 4, 'no row wraps at the panel width')
    widget.renderAgents([runningView({ label: 'y'.repeat(500), provider: 'p'.repeat(200) })])
    assert.equal(doc.render(width).length, 9, 'todos (4) + agents (5) boxes, no wrapped rows')
  } finally {
    process.stdout.columns = prev
  }
})

test('setTheme recolors the widget and keeps its content', () => {
  const { doc, widget } = makeWidget()
  widget.renderTodos([{ content: 't', status: 'in_progress' }])
  widget.renderAgents([runningView()])
  // A different bundle object — setTheme is a no-op on the identical bundle.
  widget.setTheme(buildTheme(githubDark))
  const body = panelBody(doc)
  assert.deepEqual(body.slice(0, 3), ['● Todos (0/1)', '└─ ◐ t', '● Agents'])
  assert.match(body[3], /^└─ ⠋ workhorse  Agent ① sleep 20s · ↻1≤60 · 562 token \(4%\) · 13\.[0-9]s$/)
  assert.equal(body[4], '     ⎿  running command…')
})

test('clear() drops todos and agents at once', () => {
  const { doc, widget } = makeWidget()
  widget.renderTodos([{ content: 't', status: 'pending' }])
  widget.renderAgents([runningView()])
  assert.ok(widgetRows(doc).length > 0)
  widget.clear()
  assert.deepEqual(widgetRows(doc), [])
})
