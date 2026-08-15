/**
 * Live Todos/Agents widget tests — the fixed slot pinned ABOVE the chat
 * window (see src/live-widgets.ts): it shows the `● Todos (done/total)` tree
 * and the running `● Agents` board while the model has content, and collapses
 * to zero rows when everything is done (/new, todo/write [], all subagents
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
 * Rendered rows of the widget doc, or [] when the widget is empty (no Text
 * child → zero rows). The widget Text is built with paddingX = 1, so every
 * rendered row carries exactly one leading margin space: strip that (and the
 * trailing full-width padding) while PRESERVING the intentional activity-line
 * indentation (`     ⎿ …` / `│    ⎿ …`).
 */
function widgetRows(doc, width = 200) {
  return doc.render(width).map(stripAnsi).map(line => line.replace(/^ /, '').trimEnd())
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
    seq: 1,
    startedAt: Date.now() - 13600,
    tokens: 562,
    retries: 1,
    maxRetries: 60,
    lastTool: 'command',
    contextWindow: 14000,
    ...over,
  }
}

// ------------------------------------------------------------ todo tree ----

test('todos render as a tree with status icons, counts and connectors', () => {
  const { doc, widget } = makeWidget()
  widget.renderTodos([
    { content: 'first', status: 'pending' },
    { content: 'second', status: 'in_progress' },
    { content: 'third', status: 'completed' },
  ])
  // Exact ANSI-stripped rendering: the header counts done/total, every item
  // is a tree line, the last one uses the └─ connector, and the status icons
  // follow the input order (☐ pending, ◐ in_progress, ☑ completed).
  assert.deepEqual(widgetRows(doc), [
    '● Todos (1/3)',
    '├─ ☐ first',
    '├─ ◐ second',
    '└─ ☑ third',
  ])
})

test('empty todos render no section; the widget collapses to zero rows', () => {
  const { doc, widget } = makeWidget()
  widget.renderTodos([])
  assert.deepEqual(widgetRows(doc), [])
  // Clearing an existing block also removes the Text entirely.
  widget.renderTodos([{ content: 'x', status: 'pending' }])
  assert.ok(widgetRows(doc).length > 0)
  widget.renderTodos([])
  assert.deepEqual(widgetRows(doc), [])
})

// -------------------------------------------------------------- agents ----

test('running agent line: spinner, provider + label, meta and activity', () => {
  const { doc, widget } = makeWidget()
  widget.renderAgents([runningView()])
  const rows = widgetRows(doc)
  // Header + main line + activity line.
  assert.equal(rows.length, 3)
  assert.equal(rows[0], '● Agents')
  // Elapsed depends on Date.now(); startedAt was set 13.6s ago.
  assert.match(rows[1], new RegExp(`^└─ ${AGENT_SPINNER_FRAMES[0]} workhorse  Agent ① sleep 20s · ↻1≤60 · 562 token \\(4%\\) · 13\\.[0-9]s$`))
  assert.equal(rows[2], '     ⎿  running command…')
})

test('multiple running agents use ├─/└─ connectors and │ activity indents', () => {
  const { doc, widget } = makeWidget()
  widget.renderAgents([
    runningView({ childId: 'a', label: 'A' }),
    runningView({ childId: 'b', label: 'B' }),
  ])
  const rows = widgetRows(doc)
  assert.equal(rows[0], '● Agents')
  assert.match(rows[1], /^├─ ⠋ workhorse  A /)
  assert.equal(rows[2], '│    ⎿  running command…')
  assert.match(rows[3], /^└─ ⠋ workhorse  B /)
  assert.equal(rows[4], '     ⎿  running command…')
})

test('a view without provider renders just the label', () => {
  const { doc, widget } = makeWidget()
  widget.renderAgents([runningView({ provider: undefined })])
  assert.match(widgetRows(doc)[1], /^└─ ⠋ Agent ① sleep 20s ·/)
})

test('settled agents drop off the board — clear-when-done', () => {
  const { doc, widget } = makeWidget()
  // A settled view alone: the agents section (and the whole widget) vanishes.
  widget.renderAgents([runningView({ outcome: 'completed' })])
  assert.deepEqual(widgetRows(doc), [])
  // While another child still runs, the settled one is hidden, not shown.
  widget.renderAgents([
    runningView({ childId: 'done', label: 'Done', outcome: 'completed' }),
    runningView({ childId: 'live', label: 'Live' }),
  ])
  const rows = widgetRows(doc)
  const mainLines = rows.filter(row => row.startsWith('├─') || row.startsWith('└─'))
  assert.equal(mainLines.length, 1, 'only the running child is listed')
  assert.match(mainLines[0], /Live/)
})

test('tickLive advances the spinner while running; no-op when nothing runs', () => {
  const { doc, widget } = makeWidget()
  widget.renderAgents([runningView()])
  const before = widgetRows(doc)[1]
  widget.tickLive()
  const after = widgetRows(doc)[1]
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

test('todos + agents render together with a blank separator line', () => {
  const { doc, widget } = makeWidget()
  widget.renderTodos([{ content: 't', status: 'in_progress' }])
  widget.renderAgents([runningView()])
  const rows = widgetRows(doc)
  assert.deepEqual(rows.slice(0, 4), ['● Todos (0/1)', '└─ ◐ t', '', '● Agents'])
  assert.match(rows[4], /^└─ ⠋ workhorse  Agent ① sleep 20s · ↻1≤60 · 562 token \(4%\) · 13\.[0-9]s$/)
  assert.equal(rows[5], '     ⎿  running command…')
})

// ------------------------------------------------------ width + lifecycle ----

test('every rendered row fits the terminal width (pathological content)', () => {
  const width = 80
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
})

test('setTheme recolors the widget and keeps its content', () => {
  const { doc, widget } = makeWidget()
  widget.renderTodos([{ content: 't', status: 'in_progress' }])
  widget.renderAgents([runningView()])
  // A different bundle object — setTheme is a no-op on the identical bundle.
  widget.setTheme(buildTheme(githubDark))
  const rows = widgetRows(doc)
  assert.deepEqual(rows.slice(0, 4), ['● Todos (0/1)', '└─ ◐ t', '', '● Agents'])
  assert.match(rows[4], /^└─ ⠋ workhorse  Agent ① sleep 20s · ↻1≤60 · 562 token \(4%\) · 13\.[0-9]s$/)
  assert.equal(rows[5], '     ⎿  running command…')
})

test('clear() drops todos and agents at once', () => {
  const { doc, widget } = makeWidget()
  widget.renderTodos([{ content: 't', status: 'pending' }])
  widget.renderAgents([runningView()])
  assert.ok(widgetRows(doc).length > 0)
  widget.clear()
  assert.deepEqual(widgetRows(doc), [])
})
