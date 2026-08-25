/**
 * Session preview logic lock — /resume rows are labelled with the session's
 * first-message preview so sessions are distinguishable at a glance. Runs
 * against the built lib/ (npm run build && npm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RESUME_MAX_AGE_DAYS,
  RESUME_MIN_BYTES,
  filterSessionsByLastActivity,
  loadSessionLastUpdates,
  normalizePreview,
  pickPersistedSession,
  previewOfEvents,
  isResumableSessionHeader,
  resolveResumeConfig,
  sessionInfoRows,
  sortSessionsByLastUpdate,
} from '../lib/sessions.js'
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

// ------------------------------------------------- last-update ordering --

/** Minimal resumable header fixture. */
function headerOf(id, createdAt) {
  return { version: 0, id: { toString: () => id }, sessionId: id, createdAt, cwd: '/tmp' }
}

test('sortSessionsByLastUpdate: mtime wins over createdAt, newest first', () => {
  const old = headerOf('old-but-fresh', 1_000)
  const fresh = headerOf('created-newer', 9_000)
  const stale = headerOf('created-older', 5_000)
  const updates = new Map([
    // created earliest, touched latest → first
    ['old-but-fresh', { mtimeMs: 99_000, size: 4096 }],
    ['created-older', { mtimeMs: 50_000, size: 4096 }],
    // 'created-newer' has no stat → falls back to createdAt 9_000 → last
  ])
  const ordered = sortSessionsByLastUpdate([old, fresh, stale], updates)
  assert.deepEqual(ordered.map(h => h.sessionId), ['old-but-fresh', 'created-older', 'created-newer'])
})

test('sortSessionsByLastUpdate: empty map degrades to createdAt desc with deterministic ties', () => {
  const a = headerOf('a', 100)
  const b = headerOf('b', 200)
  const ordered = sortSessionsByLastUpdate([a, b], new Map())
  assert.deepEqual(ordered.map(h => h.sessionId), ['b', 'a'])
})

test('loadSessionLastUpdates walks <root>/<project>/<session>/session.jsonl mtimes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-sess-'))
  try {
    const when = (ms) => new Date(ms)
    await mkdir(join(dir, 'proj-a', 'sess-1'), { recursive: true })
    await writeFile(join(dir, 'proj-a', 'sess-1', 'session.jsonl'), 'x'.repeat(2048), 'utf8')
    await utimes(join(dir, 'proj-a', 'sess-1', 'session.jsonl'), when(111), when(111))
    // zstd-compressed sibling naming (raw magic bytes — 4 bytes on disk)
    await mkdir(join(dir, 'proj-b', 'sess-2'), { recursive: true })
    await writeFile(join(dir, 'proj-b', 'sess-2', 'session.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
    await utimes(join(dir, 'proj-b', 'sess-2', 'session.jsonl.zstd'), when(222), when(222))
    // Empty project dir and a plain file must not break the walk.
    await mkdir(join(dir, 'proj-empty'), { recursive: true })
    await writeFile(join(dir, 'stray.txt'), 'x', 'utf8')

    const updates = await loadSessionLastUpdates(dir)
    // One stat per log: mtime AND the compressed on-disk size (byte-exact).
    assert.deepEqual(updates.get('sess-1'), { mtimeMs: 111, size: 2048 })
    assert.deepEqual(updates.get('sess-2'), { mtimeMs: 222, size: 4 })
    assert.equal(updates.size, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadSessionLastUpdates resolves an empty map for a missing root', async () => {
  const updates = await loadSessionLastUpdates(join(tmpdir(), 'dsh-tui-nope-' + Date.now()))
  assert.equal(updates.size, 0)
})

test('loadSessionLastUpdates: raw + zstd coexist → the NEWEST mtime wins and carries its own size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-dual-'))
  try {
    const when = (ms) => new Date(ms)
    const session = join(dir, 'proj', 'sess-dual')
    await mkdir(session, { recursive: true })
    await writeFile(join(session, 'session.jsonl'), 'x'.repeat(4096), 'utf8')
    await utimes(join(session, 'session.jsonl'), when(100), when(100))
    await writeFile(join(session, 'session.jsonl.zstd'), 'y'.repeat(64), 'utf8')
    await utimes(join(session, 'session.jsonl.zstd'), when(300), when(300))
    const updates = await loadSessionLastUpdates(dir)
    // The compressed sibling is the NEWER log: its mtime AND its size win
    // (same last-activity vocabulary as retention's walk). Break-on-first
    // would have kept the stale raw mtime and hidden the session behind
    // its old sibling.
    assert.deepEqual(updates.get('sess-dual'), { mtimeMs: 300, size: 64 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('filter + walk: an active zstd sibling rescues a session whose raw log went stale', async () => {
  // The review's failure shape: raw (8 days idle) + fresh zstd (1 day)
  // coexist — break-on-first keyed the STALE raw mtime and the age filter
  // dropped an actively-written session from /resume. The max-across-both
  // walk keeps it visible.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-rescue-'))
  try {
    const when = (ms) => new Date(ms)
    const NOW2 = 2_000_000_000_000
    const session = join(dir, 'proj', 'rescued')
    await mkdir(session, { recursive: true })
    await writeFile(join(session, 'session.jsonl'), 'x'.repeat(20 * 1024), 'utf8')
    await utimes(join(session, 'session.jsonl'), when(NOW2 - 8 * DAY), when(NOW2 - 8 * DAY))
    await writeFile(join(session, 'session.jsonl.zstd'), 'z'.repeat(20 * 1024), 'utf8')
    await utimes(join(session, 'session.jsonl.zstd'), when(NOW2 - DAY), when(NOW2 - DAY))
    const stats = await loadSessionLastUpdates(dir)
    assert.deepEqual(stats.get('rescued'), { mtimeMs: NOW2 - DAY, size: 20 * 1024 })
    const kept = filterSessionsByLastActivity(
      [headerOf('rescued', 0)],
      stats,
      { maxAgeDays: 7, minBytes: 20 * 1024, now: NOW2 },
    )
    assert.deepEqual(kept.map(h => h.sessionId), ['rescued'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------ resume knob resolution --
// `resolveResumeConfig` is the precedence chain behind the display filter
// above: settings.yaml `dsh-tui.resume.*` (explicit, user layer) > the
// DSH_TUI_RESUME_* environment variables > the defaults. Same chain and
// same warn contract as retention (test/retention.test.mjs).

test('resolveResumeConfig: defaults when the environment is silent', () => {
  assert.deepEqual(resolveResumeConfig({}), { maxAgeDays: 7, minBytes: 20 * 1024 })
  // An empty settings section is not an override either.
  assert.deepEqual(resolveResumeConfig({}, {}), {
    maxAgeDays: RESUME_MAX_AGE_DAYS,
    minBytes: RESUME_MIN_BYTES,
  })
})

test('resolveResumeConfig: valid env overrides apply; a 0-byte floor legitimately lifts the size gate', () => {
  assert.deepEqual(
    resolveResumeConfig({
      DSH_TUI_RESUME_MAX_AGE_DAYS: '30',
      DSH_TUI_RESUME_MIN_BYTES: '4096',
    }),
    { maxAgeDays: 30, minBytes: 4096 },
  )
  // minBytes 0 is a legal explicit choice: every walked session passes the
  // size gate (stubs and false starts included).
  assert.deepEqual(resolveResumeConfig({ DSH_TUI_RESUME_MIN_BYTES: '0' }), {
    maxAgeDays: RESUME_MAX_AGE_DAYS,
    minBytes: 0,
  })
})

test('resolveResumeConfig: invalid env values fall back SILENTLY to the defaults', () => {
  // Non-numeric, empty, fractional bytes, or out of range (age must be
  // > 0 — 0 would empty the picker; bytes must be an integer >= 0). A
  // typo must never silently empty or gut the picker, and env fallbacks
  // never warn (only settings do).
  const bad = [
    { DSH_TUI_RESUME_MAX_AGE_DAYS: 'abc' },
    { DSH_TUI_RESUME_MAX_AGE_DAYS: '' },
    { DSH_TUI_RESUME_MAX_AGE_DAYS: '0' },
    { DSH_TUI_RESUME_MAX_AGE_DAYS: '-7' },
    { DSH_TUI_RESUME_MAX_AGE_DAYS: 'one week' },
    { DSH_TUI_RESUME_MIN_BYTES: 'small' },
    { DSH_TUI_RESUME_MIN_BYTES: '-1' },
    { DSH_TUI_RESUME_MIN_BYTES: '' },
    { DSH_TUI_RESUME_MIN_BYTES: '20480.5' },
    { DSH_TUI_RESUME_MIN_BYTES: '-0.5' },
  ]
  const warnings = []
  const originalWarn = console.warn
  console.warn = line => { warnings.push(line) }
  try {
    for (const env of bad) {
      assert.deepEqual(
        resolveResumeConfig(env),
        { maxAgeDays: RESUME_MAX_AGE_DAYS, minBytes: RESUME_MIN_BYTES },
        JSON.stringify(env),
      )
    }
    assert.deepEqual(warnings, [], 'env-level fallbacks are silent')
  } finally {
    console.warn = originalWarn
  }
})

test('resolveResumeConfig: explicit settings outrank env; env outranks defaults', () => {
  // Settings is what the user deliberately persisted — it wins on every
  // knob over the ambient environment.
  assert.deepEqual(
    resolveResumeConfig(
      {
        DSH_TUI_RESUME_MAX_AGE_DAYS: '90',
        DSH_TUI_RESUME_MIN_BYTES: '65536',
      },
      { maxAgeDays: 14, minBytes: 1024 },
    ),
    { maxAgeDays: 14, minBytes: 1024 },
    'settings wins on every knob',
  )
  // No settings section: the env layer governs.
  assert.deepEqual(
    resolveResumeConfig({ DSH_TUI_RESUME_MAX_AGE_DAYS: '90' }, undefined),
    { maxAgeDays: 90, minBytes: RESUME_MIN_BYTES },
  )
  // A partial settings section overrides only the PRESENT fields; the
  // absent one keeps flowing through env → default.
  assert.deepEqual(
    resolveResumeConfig(
      { DSH_TUI_RESUME_MAX_AGE_DAYS: '90', DSH_TUI_RESUME_MIN_BYTES: '65536' },
      { maxAgeDays: 3 },
    ),
    { maxAgeDays: 3, minBytes: 65536 },
  )
})

test('resolveResumeConfig: invalid settings values warn exactly one line each and fall to the next level', () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = line => { warnings.push(line) }
  try {
    // Type error and negative byte floor: each present-but-invalid field
    // is rejected with exactly one stderr line, and the chain continues
    // at the env layer.
    const config = resolveResumeConfig(
      {
        DSH_TUI_RESUME_MAX_AGE_DAYS: '21',
        DSH_TUI_RESUME_MIN_BYTES: '8192',
      },
      { maxAgeDays: 'week', minBytes: -1 },
    )
    assert.deepEqual(
      config,
      { maxAgeDays: 21, minBytes: 8192 },
      'invalid settings fell through to env on every knob',
    )
    assert.equal(warnings.length, 2, 'one line per invalid field')
    assert.match(warnings[0], /^\[dsh-tui-pi\] settings dsh-tui\.resume\.maxAgeDays: invalid value "week" — falling back to environment\/default$/)
    assert.match(warnings[1], /dsh-tui\.resume\.minBytes: invalid value -1 —/)

    // Invalid settings with no env either → the defaults (still one line
    // per field).
    warnings.length = 0
    assert.deepEqual(
      resolveResumeConfig({}, { maxAgeDays: Number.NaN, minBytes: 'later' }),
      { maxAgeDays: RESUME_MAX_AGE_DAYS, minBytes: RESUME_MIN_BYTES },
    )
    assert.equal(warnings.length, 2)

    // Absent fields never warn; valid values never warn.
    warnings.length = 0
    resolveResumeConfig({}, { maxAgeDays: 3, minBytes: undefined })
    assert.deepEqual(warnings, [])
  } finally {
    console.warn = originalWarn
  }
})

test('resolveResumeConfig: boundaries — fractional age is a window, byte floor must be an integer >= 0', () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = line => { warnings.push(line) }
  try {
    // The age window only needs to be a finite number > 0: 0.5 days is a
    // legitimate (aggressive) window.
    assert.deepEqual(resolveResumeConfig({}, { maxAgeDays: 0.5 }), {
      maxAgeDays: 0.5,
      minBytes: RESUME_MIN_BYTES,
    })
    // maxAgeDays 0 would empty the picker — invalid, one warn, default.
    assert.deepEqual(resolveResumeConfig({}, { maxAgeDays: 0 }), {
      maxAgeDays: RESUME_MAX_AGE_DAYS,
      minBytes: RESUME_MIN_BYTES,
    })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /dsh-tui\.resume\.maxAgeDays: invalid value 0 —/)
    warnings.length = 0
    // A fractional byte floor is garbage even though positive (a
    // stat().size is integral) — rejected, one warn, default.
    assert.deepEqual(resolveResumeConfig({}, { minBytes: 20480.5 }), {
      maxAgeDays: RESUME_MAX_AGE_DAYS,
      minBytes: RESUME_MIN_BYTES,
    })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /dsh-tui\.resume\.minBytes: invalid value 20480\.5 —/)
    warnings.length = 0
    // Integer 0 is the documented "show every walked session" choice —
    // valid, no warn.
    assert.deepEqual(resolveResumeConfig({}, { minBytes: 0 }), {
      maxAgeDays: RESUME_MAX_AGE_DAYS,
      minBytes: 0,
    })
    assert.deepEqual(warnings, [])
  } finally {
    console.warn = originalWarn
  }
})

test('resolveResumeConfig: a fractional env MIN_BYTES is invalid env — the floor stays the default boundary', () => {
  // The env-layer twin of the settings case above: 20480.5 parses finite
  // and positive, so the old env layer accepted it — and because
  // `stat().size` is integral, exactly-20480-byte logs silently failed
  // the floor (20480 < 20480.5). A fractional byte floor is invalid env:
  // silent fall to the default, and the boundary stays inclusive.
  const warnings = []
  const originalWarn = console.warn
  console.warn = line => { warnings.push(line) }
  try {
    const config = resolveResumeConfig({ DSH_TUI_RESUME_MIN_BYTES: '20480.5' })
    assert.deepEqual(config, {
      maxAgeDays: RESUME_MAX_AGE_DAYS,
      minBytes: RESUME_MIN_BYTES,
    }, 'fractional env floor falls to the default 20480')
    assert.deepEqual(warnings, [], 'env-level fallbacks are silent')
    // The resolved default floor keeps its inclusive boundary: exactly
    // 20480B passes, 20479B does not (had 20480.5 won, 'at-min' would
    // have been dropped — the silent bar-raise symptom).
    const now = 2_000_000_000_000
    const headers = [headerOf('at-min', now), headerOf('one-short', now)]
    const stats = new Map([
      ['at-min', { mtimeMs: now, size: 20 * 1024 }],
      ['one-short', { mtimeMs: now, size: 20 * 1024 - 1 }],
    ])
    const kept = filterSessionsByLastActivity(headers, stats, {
      maxAgeDays: config.maxAgeDays,
      minBytes: config.minBytes,
      now,
    })
    assert.deepEqual(kept.map(h => h.sessionId), ['at-min'], 'exactly-20480B logs still pass the default floor')
  } finally {
    console.warn = originalWarn
  }
})

// --------------------------------------------------- /resume display filter --

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000
const BIG = { mtimeMs: NOW, size: 100 * 1024 }

test('filterSessionsByLastActivity: age boundary — 6d23h kept, exactly 7d kept, 7d+1s dropped', () => {
  const headers = [
    headerOf('almost-7d', NOW),
    headerOf('exactly-7d', NOW),
    headerOf('past-7d', NOW),
  ]
  const stats = new Map([
    ['almost-7d', { ...BIG, mtimeMs: NOW - 7 * DAY + 60 * 60 * 1000 }], // 6d23h
    ['exactly-7d', { ...BIG, mtimeMs: NOW - 7 * DAY }], // boundary survives
    ['past-7d', { ...BIG, mtimeMs: NOW - 7 * DAY - 1000 }], // strictly older
  ])
  const kept = filterSessionsByLastActivity(headers, stats, { maxAgeDays: 7, minBytes: 20 * 1024, now: NOW })
  assert.deepEqual(kept.map(h => h.sessionId), ['almost-7d', 'exactly-7d'])
})

test('filterSessionsByLastActivity: size boundary — exactly 20480B kept, 20479B dropped', () => {
  const headers = [headerOf('at-min', NOW), headerOf('one-short', NOW)]
  const stats = new Map([
    ['at-min', { mtimeMs: NOW, size: 20 * 1024 }],
    ['one-short', { mtimeMs: NOW, size: 20 * 1024 - 1 }],
  ])
  const kept = filterSessionsByLastActivity(headers, stats, { maxAgeDays: 7, minBytes: 20 * 1024, now: NOW })
  assert.deepEqual(kept.map(h => h.sessionId), ['at-min'])
})

test('filterSessionsByLastActivity: missing stat fails open on size, ages by createdAt', () => {
  const headers = [
    headerOf('unwalked-fresh', NOW - DAY), // no stat, recent createdAt → kept
    headerOf('unwalked-stale', NOW - 30 * DAY), // no stat, old createdAt → dropped
  ]
  const kept = filterSessionsByLastActivity(headers, new Map(), { maxAgeDays: 7, minBytes: 20 * 1024, now: NOW })
  assert.deepEqual(kept.map(h => h.sessionId), ['unwalked-fresh'])
})

test('filter + walk integration: sizes and mtimes come from the same stat on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-resume-'))
  try {
    const when = (ms) => new Date(ms)
    const NOW2 = 2_000_000_000_000
    const cases = [
      // [id, mtime, bytes, survives]
      ['fresh-big', NOW2 - DAY, 20 * 1024, true], // boundary size + fresh age
      ['fresh-small', NOW2 - DAY, 20 * 1024 - 1, false], // one byte short
      ['stale-big', NOW2 - 8 * DAY, 20 * 1024, false], // past the age window
      ['edge-age', NOW2 - 7 * DAY, 21 * 1024, true], // exactly 7d survives
    ]
    for (const [id, mtime, bytes] of cases) {
      await mkdir(join(dir, 'proj', id), { recursive: true })
      await writeFile(join(dir, 'proj', id, 'session.jsonl'), 'x'.repeat(bytes), 'utf8')
      await utimes(join(dir, 'proj', id, 'session.jsonl'), when(mtime), when(mtime))
    }
    const stats = await loadSessionLastUpdates(dir)
    assert.equal(stats.size, cases.length)
    const headers = cases.map(([id]) => headerOf(id, 0))
    const kept = filterSessionsByLastActivity(headers, stats, { maxAgeDays: 7, minBytes: 20 * 1024, now: NOW2 })
    assert.deepEqual(
      kept.map(h => h.sessionId),
      cases.filter(c => c[3] === true).map(c => c[0]),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------- picker empty-branch differentiation --
// `pickPersistedSession` must tell the caller WHY the list is empty: a
// store with no other resumable session resolves `empty`, while a store
// the age/size display filter emptied resolves `empty-filtered` with the
// effective knobs — the caller's reply names the window and the
// `dsh-tui.resume.*` knobs instead of "nothing to resume" (src/index.ts).
// Both branches return BEFORE any TUI surface is touched, so the tui and
// theme arguments are dummies here.

/** Minimal ctx fake exposing one fixed `sessionPersistence.list() result. */
function pickerContext(headers) {
  return {
    get(name) {
      return name === 'sessionPersistence'
        ? { list: async () => headers, inspect: async () => { throw new Error('not reached') } }
        : undefined
    },
  }
}

/** Pin $DSH_SESSION_ROOT at a temp store for one picker test body. */
async function withSessionRoot(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-pick-'))
  const prev = process.env.DSH_SESSION_ROOT
  process.env.DSH_SESSION_ROOT = dir
  try {
    await fn(dir)
  } finally {
    if (prev === undefined) delete process.env.DSH_SESSION_ROOT
    else process.env.DSH_SESSION_ROOT = prev
    await rm(dir, { recursive: true, force: true })
  }
}

test('pickPersistedSession: an empty store resolves plain empty — nothing filtered, no TUI touched', async () => {
  await withSessionRoot(async () => {
    // No persisted session at all.
    assert.deepEqual(
      await pickPersistedSession(pickerContext([]), null, null, undefined, () => {}),
      { kind: 'empty' },
      'no other session → plain empty',
    )
    // The only persisted session IS the current one (excluded upstream of
    // the filter): still a plain empty, not a filtered one.
    assert.deepEqual(
      await pickPersistedSession(pickerContext([headerOf('current', 1)]), null, null, 'current', () => {}),
      { kind: 'empty' },
      'only the excluded current session → plain empty',
    )
  })
})

test('pickPersistedSession: candidates hidden by the filter resolve empty-filtered with the effective knobs', async () => {
  await withSessionRoot(async (dir) => {
    // One resumable session whose log is 100 days idle and comfortably
    // above the byte floor: inside the store, outside every window tried
    // below — the branch is genuinely the display filter's.
    const when = ms => new Date(ms)
    const session = join(dir, 'proj', 'stale')
    await mkdir(session, { recursive: true })
    await writeFile(join(session, 'session.jsonl'), 'x'.repeat(50 * 1024), 'utf8')
    const old = Date.now() - 100 * DAY
    await utimes(join(session, 'session.jsonl'), when(old), when(old))

    // Default knobs (7d / 20KB): the age window hid the only candidate.
    assert.deepEqual(
      await pickPersistedSession(pickerContext([headerOf('stale', 0)]), null, null, undefined, () => {}),
      {
        kind: 'empty-filtered',
        hidden: 1,
        maxAgeDays: RESUME_MAX_AGE_DAYS,
        minBytes: RESUME_MIN_BYTES,
      },
      'the age window hid the only candidate — knobs ride along',
    )

    // Explicit settings knobs are the ones reported (still filtered:
    // 100d idle > the 90d window) — the caller's reply names the window
    // that is actually in force.
    assert.deepEqual(
      await pickPersistedSession(
        pickerContext([headerOf('stale', 0)]), null, null, undefined, () => {},
        { maxAgeDays: 90 },
      ),
      { kind: 'empty-filtered', hidden: 1, maxAgeDays: 90, minBytes: RESUME_MIN_BYTES },
      'explicit settings knobs are the ones reported',
    )
  })
})
