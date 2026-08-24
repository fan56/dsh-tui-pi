/**
 * Session preview logic lock — /resume rows are labelled with the session's
 * first-message preview so sessions are distinguishable at a glance. Runs
 * against the built lib/ (npm run build && npm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePreview, previewOfEvents, isResumableSessionHeader, sessionInfoRows } from '../lib/sessions.js'
import { stashSessionIdForReload, takeStashedSessionId } from '../lib/session.js'

const userMsg = (text, sourceKind = 'user', extra = {}) => ({
  type: 'user/message',
  seq: 1,
  time: 0,
  data: { role: 'user', source: { kind: sourceKind }, content: [{ type: 'text', text }], ...extra },
})

const assistantMsg = text => ({
  type: 'assistant/message',
  seq: 2,
  time: 0,
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

test('previewOfEvents returns the first direct human prompt, skipping earlier injects', () => {
  const events = [
    userMsg('<system-reminder>\nworkspace instructions…', 'agent-instructions'),
    userMsg('Current runtime context…', 'plugin'),
    userMsg('帮我改一下 rms-locations 的接口', 'user'),
    userMsg('（后续的人类消息不参与第一句）', 'user'),
  ]
  assert.equal(previewOfEvents(events), '帮我改一下 rms-locations 的接口')
})

test('previewOfEvents ignores tool-result user messages', () => {
  const events = [
    { type: 'user/message', seq: 1, time: 0, data: { role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool_result', toolCallId: 'c1' }] } },
    userMsg('真正的问题在这里', 'user'),
  ]
  assert.equal(previewOfEvents(events), '真正的问题在这里')
})

test('previewOfEvents prefers the human prompt over an earlier assistant reply', () => {
  const events = [assistantMsg('我看到了工作区说明。'), userMsg('继续做 geo-service 的 TTL 检查')]
  assert.equal(previewOfEvents(events), '继续做 geo-service 的 TTL 检查')
})

test('previewOfEvents falls back to the first assistant message when only injects exist', () => {
  const events = [userMsg('<system-reminder>…', 'agent-instructions'), assistantMsg('收到，我先检查这几个服务。')]
  assert.equal(previewOfEvents(events), '收到，我先检查这几个服务。')
})

test('previewOfEvents prefers real non-injected user text (goal/cron) over the assistant reply', () => {
  const events = [assistantMsg('收到。'), userMsg('每天分析一次 friction 数据并出报表', 'goal')]
  assert.equal(previewOfEvents(events), '每天分析一次 friction 数据并出报表')
})

test('previewOfEvents returns undefined for logs without messages', () => {
  assert.equal(previewOfEvents([{ type: 'command/run', seq: 0, time: 0, data: {} }]), undefined)
  assert.equal(previewOfEvents([]), undefined)
})

test('normalizePreview collapses whitespace and control chars to one line', () => {
  assert.equal(normalizePreview('  你好呀,\n\n介绍一下 你自己  '), '你好呀, 介绍一下 你自己')
  assert.equal(normalizePreview('a\x00b\tc'), 'a b c')
})

test('normalizePreview clips over-long previews with an ellipsis', () => {
  const long = 'x'.repeat(200)
  const clipped = normalizePreview(long)
  assert.equal(clipped.length, 141)
  assert.ok(clipped.endsWith('…'))
  assert.equal(normalizePreview('短文本'), '短文本')
  // Folded reload stash round-trip (no extra test block): process-global
  // stash holds the current session id across a hot-reload.
  assert.equal(takeStashedSessionId(), undefined)
  assert.equal(takeStashedSessionId(), undefined)
  stashSessionIdForReload('session-a')
  assert.equal(takeStashedSessionId(), 'session-a')
  assert.equal(takeStashedSessionId(), undefined)
  stashSessionIdForReload('session-b')
  stashSessionIdForReload(undefined)
  assert.equal(takeStashedSessionId(), undefined)
  assert.equal(takeStashedSessionId(), undefined)
})


// ---------------------------------------------------------------------------
// /resume filter: `isResumableSessionHeader` excludes every delegated child
// (spawn AND fork-driven — both carry `origin: 'subagent'` +
// `delegationDepth >= 1`); resuming one as the TUI's main conversation would
// misplace it in the recursion budget. Everything else stays resumable.
// The budget test is a VALUE test on purpose — see the persisted-shapes test
// below for why field presence would break /resume entirely.

test('isResumableSessionHeader excludes spawn subagent children', () => {
  assert.equal(isResumableSessionHeader({ origin: 'subagent' }), false)
  assert.equal(isResumableSessionHeader({ origin: 'subagent', delegationDepth: 2 }), false)
})

test('isResumableSessionHeader excludes budget-marked children even without the origin', () => {
  // Defensive shape (current dsh always writes the origin too): a header
  // carrying only a positive budget is still a delegated child.
  assert.equal(isResumableSessionHeader({ delegationDepth: 1, parentSession: 'p' }), false)
})

test('isResumableSessionHeader keeps user-facing forks and root sessions resumable', () => {
  // In-memory `Session.fork` lineage is parentSession + seedLength only — a
  // forked conversation is a real session the user may want to resume.
  assert.equal(isResumableSessionHeader({ parentSession: 'p', seedLength: 2 }), true)
  assert.equal(isResumableSessionHeader({}), true)
})

test('isResumableSessionHeader handles persisted shapes (jsonl round-trip materialises delegationDepth: 0)', () => {
  // Regression guard: the jsonl persistence backend writes
  // `delegationDepth: header.delegationDepth ?? 0` and reads the field back
  // unconditionally, so EVERY header from persistence.list() carries it —
  // non-child sessions as 0. These are the exact shapes observed on disk
  // (590-session survey of ~/.dsh/sessions). A field-presence test
  // (`delegationDepth === undefined`) returns false for all of them and
  // leaves /resume with an empty list.
  const persistedRoot = { delegationDepth: 0 } // top-level conversation
  const persistedUserFork = { parentSession: 'p', seedLength: 112416, delegationDepth: 0 }
  const persistedSpawn = { origin: 'subagent', parentSession: 'p', delegationDepth: 1 }
  const persistedForkChild = { origin: 'subagent', parentSession: 'p', seedLength: 4, delegationDepth: 1 }
  assert.equal(isResumableSessionHeader(persistedRoot), true)
  assert.equal(isResumableSessionHeader(persistedUserFork), true)
  assert.equal(isResumableSessionHeader(persistedSpawn), false)
  assert.equal(isResumableSessionHeader(persistedForkChild), false)
})


// ---------------------------------------------------------------------------
// /session info rows: `sessionInfoRows` is the pure data contract of the
// /session panel's auto table (the FW table language shared with every other
// panel). The panel clips/pads/paints these plain values; here we lock the
// row set, the order and the missing-value fallbacks.

const fullPanelData = {
  id: '12345678-9abc-def0-1234-56789abcdef0',
  cwd: '/tmp/work',
  createdAt: new Date('2026-01-02T03:04:05').getTime(),
  model: 'deepseek/v4-flash',
  effort: 'medium',
  msgCount: 3,
  toolCallCount: 7,
  inputTokens: 100,
  outputTokens: 200,
  cacheReadTokens: 300,
  cacheWriteTokens: 400,
  status: 'running',
  eventCount: 42,
  parentSession: 'parent-session-id',
}

test('sessionInfoRows renders every stat in display order with plain values', () => {
  const rows = sessionInfoRows(fullPanelData)
  assert.deepEqual(rows.map(row => row.field), [
    'session', 'cwd', 'created', 'model', 'think', 'status', 'messages',
    'tool calls', 'tokens in', 'tokens out', 'cache read', 'cache write',
    'events', 'parent',
  ])
  const byField = Object.fromEntries(rows.map(row => [row.field, row.value]))
  assert.equal(byField.session, fullPanelData.id) // full id — the flex VALUE column clips, never hides it
  assert.equal(byField.cwd, '/tmp/work')
  assert.ok(byField.created.length > 0)
  assert.equal(byField.model, 'deepseek/v4-flash')
  assert.equal(byField.think, 'medium')
  assert.equal(byField.status, 'running')
  assert.equal(byField.messages, '3')
  assert.equal(byField['tool calls'], '7')
  assert.equal(byField['tokens in'], '100')
  assert.equal(byField['tokens out'], '200')
  assert.equal(byField['cache read'], '300')
  assert.equal(byField['cache write'], '400')
  assert.equal(byField.events, '42')
})

test('sessionInfoRows falls back to em-dash and clips the parent id to 8 columns', () => {
  const rows = sessionInfoRows({
    ...fullPanelData,
    id: undefined,
    cwd: undefined,
    createdAt: undefined,
    model: undefined,
    effort: undefined,
    eventCount: undefined,
    parentSession: 'parent-session-id',
  })
  const byField = Object.fromEntries(rows.map(row => [row.field, row.value]))
  for (const field of ['session', 'cwd', 'created', 'model', 'think', 'events']) {
    assert.equal(byField[field], '—', field)
  }
  assert.equal(byField.parent, 'parent-s') // same short form the /resume rows use
})

// Narrow-width regression (review B1): the panel must clip the plain VALUE
// text BEFORE painting it with ANSI. When the terminal is narrower than the
// content, the MIN_FLEX_WIDTH floor can push the layout past `width`; a
// clip applied to the painted line would cut mid-SGR and leave a dangling
// `\x1b[38;2;` fragment on screen.
test('SessionInfoPanel at narrow width clips plain text before ANSI — no dangling SGR fragment', async () => {
  const { SessionInfoPanel } = await import('../lib/sessions.js')
  const { buildTheme } = await import('../lib/theme/index.js')
  const { githubDark } = await import('../lib/theme/palette.js')
  const theme = buildTheme(githubDark)
  const panel = new SessionInfoPanel(theme, fullPanelData, () => {})
  for (const width of [20, 24, 30, 40, 80]) {
    for (const line of panel.render(width)) {
      // No unterminated SGR: every escape sequence is a complete CSI …m
      assert.doesNotMatch(line, /\x1b\[[0-9;]*(?:$|[^0-9;m])/, `width ${width}: dangling escape in ${JSON.stringify(line)}`)
      // Visible width never exceeds the requested width
      const { visibleWidth } = await import('../lib/text.js')
      assert.ok(visibleWidth(line) <= width, `width ${width}: line too wide (${visibleWidth(line)})`)
    }
  }
})

// Token scope note (review S2): the token totals are per provider/model route
// segment (they reset on a route change), unlike messages/events which count
// the whole session — the title line must say so, without costing a row (the
// panel is height-budgeted for a 24-row terminal).
test('SessionInfoPanel title annotates the per-route token scope', async () => {
  const { SessionInfoPanel } = await import('../lib/sessions.js')
  const { buildTheme } = await import('../lib/theme/index.js')
  const { githubDark } = await import('../lib/theme/palette.js')
  const theme = buildTheme(githubDark)
  const panel = new SessionInfoPanel(theme, fullPanelData, () => {})
  const lines = panel.render(80)
  assert.match(lines[0], /tokens: current route/, 'title carries the token scope note')
  // The note rides on the title line itself — no extra row was added.
  assert.equal(lines.length, 20)
})
