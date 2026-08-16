/**
 * Session preview logic lock — /resume rows are labelled with the session's
 * first-message preview so sessions are distinguishable at a glance. Runs
 * against the built lib/ (npm run build && npm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePreview, previewOfEvents } from '../lib/sessions.js'
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
