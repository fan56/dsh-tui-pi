/**
 * /history turn-grouping tests — the pure SessionEvent[] → HistoryTurn[]
 * fold (src/history-turns.ts) behind the history browser: turn/start…turn/end
 * brackets, per-turn user prompts (claimed steer/follow-up included, injected
 * context excluded from userTexts), assembled assistant messages (one per
 * step), tool/call name tally, unclosed-turn exclusion and the row filter.
 * Pure module — runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  groupHistoryTurns,
  matchesTurnFilter,
  toolCallSummary,
  turnPrimaryUserText,
} from '../lib/history-turns.js'

/** Event builders shaped like the dsh-session log rows (structural — the
 * declaring packages are type-only for this plugin). */
const start = (seq, turn) => ({ type: 'turn/start', seq, time: seq, data: { turn } })
const end = (seq, turn, reason = { kind: 'completed' }) => ({
  type: 'turn/end', seq, time: seq, data: { turn, reason },
})
const user = (seq, text, kind = 'user') => ({
  type: 'user/message', seq, time: seq,
  data: { source: { kind }, content: [{ type: 'text', text }] },
})
const assistant = (seq, turn, step, text, extra = {}) => ({
  type: 'assistant/message', seq, time: seq,
  data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra },
})
const toolCall = (seq, turn, step, callId, name) => ({
  type: 'tool/call', seq, time: seq,
  data: { turn, step, callId, name, arguments: '{}' },
})
const chunk = (seq, turn, step, text) => ({
  type: 'assistant/chunk', seq, time: seq,
  data: { turn, step, chunk: { type: 'text-delta', text } },
})

test('groupHistoryTurns: multiple turns group in seq order with their brackets', () => {
  const turns = groupHistoryTurns([
    start(0, 0),
    user(1, 'first question'),
    assistant(2, 0, 0, 'first answer'),
    end(3, 0),
    start(4, 1),
    user(5, 'second question'),
    assistant(6, 1, 0, 'second answer'),
    end(7, 1),
  ])
  assert.equal(turns.length, 2)
  assert.equal(turns[0].turn, 0)
  assert.equal(turns[0].seqStart, 0)
  assert.equal(turns[0].seqEnd, 3)
  assert.deepEqual(turns[0].userTexts, ['first question'])
  assert.deepEqual(turns[0].assistantTexts, ['first answer'])
  assert.equal(turns[1].turn, 1)
  assert.equal(turns[1].seqStart, 4)
  assert.equal(turns[1].seqEnd, 7)
})

test('groupHistoryTurns: several user messages in one turn land in seq order', () => {
  // A steer and a claimed follow-up are ordinary kind-'user' user/messages
  // inside the turn — v1 marks none of them specially.
  const turns = groupHistoryTurns([
    start(0, 3),
    user(1, 'main prompt'),
    assistant(2, 3, 0, 'working'),
    user(3, 'steered addition'),
    user(4, 'queued follow-up'),
    assistant(5, 3, 1, 'final answer'),
    end(6, 3),
  ])
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0].userTexts, ['main prompt', 'steered addition', 'queued follow-up'])
  // Copy refills the editor with the turn's FIRST human prompt.
  assert.equal(turnPrimaryUserText(turns[0]), 'main prompt')
})

test('groupHistoryTurns: injected context is not a prompt (preview falls back, copy declines)', () => {
  const turns = groupHistoryTurns([
    start(0, 0),
    user(1, 'file-change notice', 'plugin'),
    user(2, 'skill content', 'agent-instructions'),
    assistant(3, 0, 0, 'ack'),
    end(4, 0),
  ])
  assert.deepEqual(turns[0].userTexts, [])
  // The row preview still falls back to the injected text (a readable row)…
  assert.equal(turns[0].previewText, 'file-change notice')
  // …but copy declines: refilling the editor with a notice would let one
  // Enter submit it as a prompt.
  assert.equal(turnPrimaryUserText(turns[0]), undefined)
})

test('groupHistoryTurns: an unclosed turn (still streaming) never enters the list', () => {
  const turns = groupHistoryTurns([
    start(0, 0),
    user(1, 'done turn'),
    end(2, 0),
    start(3, 1),
    user(4, 'in-flight turn'),
    chunk(5, 1, 0, 'partial'),
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].turn, 0)
  // Events outside any turn bracket are ignored too.
  assert.equal(groupHistoryTurns([user(0, 'orphan')]).length, 0)
  assert.equal(groupHistoryTurns([]).length, 0)
})

test('groupHistoryTurns: a tool-using turn keeps every step reply and the tool names', () => {
  const turns = groupHistoryTurns([
    start(0, 0),
    user(1, 'do the thing'),
    assistant(2, 0, 0, 'let me look'),
    toolCall(3, 0, 0, 'c1', 'read'),
    toolCall(4, 0, 0, 'c2', 'read'),
    toolCall(5, 0, 0, 'c3', 'edit'),
    toolCall(6, 0, 1, 'c4', 'bash'),
    assistant(7, 0, 1, 'all done'),
    end(8, 0),
  ])
  assert.deepEqual(turns[0].assistantTexts, ['let me look', 'all done'])
  assert.deepEqual(turns[0].toolCallNames, ['read', 'read', 'edit', 'bash'])
})

test('groupHistoryTurns: multi-text-block messages join with newlines', () => {
  const turns = groupHistoryTurns([
    start(0, 0),
    {
      type: 'user/message', seq: 1, time: 1,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }],
      },
    },
    end(2, 0),
  ])
  assert.deepEqual(turns[0].userTexts, ['line one\nline two'])
})

test('groupHistoryTurns: interrupted flag and error end reason are carried', () => {
  const turns = groupHistoryTurns([
    start(0, 0),
    user(1, 'stop me'),
    assistant(2, 0, 0, 'partial', { interrupted: true }),
    end(3, 0, { kind: 'aborted' }),
    start(4, 1),
    user(5, 'boom'),
    end(6, 1, { kind: 'error', error: { message: 'provider exploded' } }),
  ])
  assert.equal(turns[0].endReason, 'aborted')
  assert.equal(turns[0].interrupted, true)
  assert.equal(turns[1].endReason, 'error')
  assert.equal(turns[1].endError, 'provider exploded')
  assert.equal(turns[1].interrupted, false)
})

test('toolCallSummary: counts per tool in first-appearance order, singular aware', () => {
  assert.equal(toolCallSummary(['read', 'read', 'edit', 'bash']), '4 tool calls: read×2, edit×1, bash×1')
  assert.equal(toolCallSummary(['read']), '1 tool call: read×1')
  assert.equal(toolCallSummary([]), '')
})

test('matchesTurnFilter: case-insensitive substring over the preview and the number', () => {
  const turn = {
    turn: 12,
    seqStart: 0, seqEnd: 9, endReason: 'completed', endError: undefined,
    interrupted: false,
    userTexts: ['Fix the WebSocket retry'],
    previewText: 'Fix the WebSocket retry',
    assistantTexts: [], toolCallNames: [],
  }
  assert.equal(matchesTurnFilter(turn, 'websocket'), true)
  assert.equal(matchesTurnFilter(turn, 'FIX'), true)
  assert.equal(matchesTurnFilter(turn, '12'), true)
  assert.equal(matchesTurnFilter(turn, '1'), true)
  assert.equal(matchesTurnFilter(turn, 'kerberos'), false)
  assert.equal(matchesTurnFilter(turn, ''), true)
  assert.equal(matchesTurnFilter(turn, '   '), true)
})
