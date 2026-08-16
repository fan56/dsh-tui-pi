/**
 * Agent-manager module tests — pure data and pure functions, no TTY needed.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  convertZcodeModel,
  listAgentFiles,
  parseAgentMarkdown,
  renderAgentMarkdown,
  seedFromZcode,
  updateAgentFrontmatter,
} from '../lib/agent-manager.js'

const SAMPLE = [
  '---',
  'name: oldfox',
  'display_name: 老法师',
  'description: "顾问角色：review、挑刺。"',
  'color: red',
  'model: volc-ark-plan/glm-5.3',
  'thinking: high',
  'deep: 2',
  '---',
  '',
  '你是「老法师」——顾问角色。',
  '## 核心职责',
  'review 把关。',
].join('\n')

test('parseAgentMarkdown: full agent exposes every frontmatter field', () => {
  const result = parseAgentMarkdown(SAMPLE, '/agents/oldfox.md')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.agent.meta.name, 'oldfox')
  assert.equal(result.agent.meta.displayName, '老法师')
  assert.equal(result.agent.meta.description, '顾问角色：review、挑刺。')
  assert.equal(result.agent.meta.color, 'red')
  assert.equal(result.agent.meta.model, 'volc-ark-plan/glm-5.3')
  assert.equal(result.agent.meta.thinking, 'high')
  assert.equal(result.agent.meta.deep, 2)
  assert.equal(result.agent.path, '/agents/oldfox.md')
  assert.ok(result.agent.body.includes('你是「老法师」'))
  assert.ok(result.agent.body.includes('## 核心职责'))
})

test('parseAgentMarkdown: name is required; missing frontmatter is rejected', () => {
  const noName = parseAgentMarkdown('---\ndescription: x\n---\nbody', '/a.md')
  assert.equal(noName.ok, false)
  const noFence = parseAgentMarkdown('name: x\n', '/a.md')
  assert.equal(noFence.ok, false)
  const unterminated = parseAgentMarkdown('---\nname: x\n', '/a.md')
  assert.equal(unterminated.ok, false)
})

test('parseAgentMarkdown: deep defaults to 1, accepts 0, rejects negatives/non-integers', () => {
  const absent = parseAgentMarkdown('---\nname: a\n---\nbody', '/a.md')
  assert.equal(absent.ok, true)
  if (absent.ok) assert.equal(absent.agent.meta.deep, 1)
  const zero = parseAgentMarkdown('---\nname: a\ndeep: 0\n---\nbody', '/a.md')
  assert.equal(zero.ok, true)
  if (zero.ok) assert.equal(zero.agent.meta.deep, 0)
  for (const bad of ['-1', '1.5', 'inf', 'unlimited', 'x', '']) {
    const result = parseAgentMarkdown(`---\nname: a\ndeep: ${bad}\n---\nbody`, '/a.md')
    assert.equal(result.ok, false, `deep "${bad}" must be rejected`)
  }
})

test('parseAgentMarkdown: CRLF input and quoted values are tolerated', () => {
  const crlf = '---\r\nname: a\r\ndescription: "hello world"\r\ndeep: 3\r\n---\r\n\r\nbody line\r\n'
  const result = parseAgentMarkdown(crlf, '/a.md')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.agent.meta.name, 'a')
  assert.equal(result.agent.meta.description, 'hello world')
  assert.equal(result.agent.meta.deep, 3)
  assert.equal(result.agent.body, 'body line')
})

test('renderAgentMarkdown round-trips through parseAgentMarkdown', () => {
  const result = parseAgentMarkdown(SAMPLE, '/a.md')
  assert.equal(result.ok, true)
  if (!result.ok) return
  const rendered = renderAgentMarkdown(result.agent.meta, result.agent.body)
  const again = parseAgentMarkdown(rendered, '/a.md')
  assert.equal(again.ok, true)
  if (!again.ok) return
  assert.deepEqual(again.agent.meta, result.agent.meta)
  assert.equal(again.agent.body, result.agent.body)
})

test('updateAgentFrontmatter: inserts missing keys, replaces in place, removes on null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-test-'))
  const path = join(dir, 'a.md')
  writeFileSync(path, '---\nname: a\ndeep: 1\n---\n\nbody\n')
  try {
    assert.equal(updateAgentFrontmatter(path, { model: 'opencode-go/deepseek-v4-flash' }), undefined)
    assert.equal(updateAgentFrontmatter(path, { thinking: 'high' }), undefined)
    assert.equal(updateAgentFrontmatter(path, { deep: 0 }), undefined)
    const text = readFileSync(path, 'utf8')
    assert.ok(text.includes('model: opencode-go/deepseek-v4-flash'))
    assert.ok(text.includes('thinking: high'))
    assert.ok(text.includes('deep: 0'))
    assert.ok(text.endsWith('body\n'))

    // in-place replace keeps position
    assert.equal(updateAgentFrontmatter(path, { model: 'volc-ark-plan/glm-5.3' }), undefined)
    const replaced = readFileSync(path, 'utf8')
    assert.ok(replaced.includes('model: volc-ark-plan/glm-5.3'))
    assert.ok(!replaced.includes('model: opencode-go/deepseek-v4-flash'))

    // null removes the line (inherit)
    assert.equal(updateAgentFrontmatter(path, { thinking: null }), undefined)
    const removed = readFileSync(path, 'utf8')
    assert.ok(!removed.includes('thinking:'))
    assert.ok(removed.includes('deep: 0'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateAgentFrontmatter: no-op leaves the file byte-identical and CRLF intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-test-'))
  const path = join(dir, 'a.md')
  const original = '---\r\nname: a\r\nmodel: x/y\r\n---\r\n\r\nbody\r\n'
  writeFileSync(path, original)
  try {
    assert.equal(updateAgentFrontmatter(path, { model: 'x/y' }), undefined)
    assert.equal(readFileSync(path, 'utf8'), original, 'no-op must not rewrite the file')
    assert.equal(updateAgentFrontmatter(path, { deep: 2 }), undefined)
    const updated = readFileSync(path, 'utf8')
    assert.ok(updated.includes('deep: 2'))
    assert.ok(updated.includes('\r\n'), 'CRLF must be preserved')
    assert.ok(updated.includes('model: x/y'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateAgentFrontmatter: rejects files without frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-test-'))
  const path = join(dir, 'a.md')
  writeFileSync(path, 'no frontmatter here\n')
  try {
    assert.ok(updateAgentFrontmatter(path, { model: 'x/y' }) !== undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('convertZcodeModel: known providers map to dsh routes', () => {
  assert.equal(convertZcodeModel('custom:builtin%3Abigmodel:GLM-5.3'), 'volc-ark-plan/glm-5.3')
  assert.equal(
    convertZcodeModel('custom:9524bbc9-01a6-4e24-9ea2-a0a076ef518b:deepseek-v4-flash'),
    'opencode-go/deepseek-v4-flash',
  )
  assert.equal(
    convertZcodeModel('custom:d7ef608b-857f-4960-9a4f-380e851fdedb:MiniMax-M3'),
    'minimax-cn/MiniMax-M3',
  )
})

test('convertZcodeModel: unknown providers and non-custom values stay untouched', () => {
  assert.equal(convertZcodeModel('custom:some-unknown-provider:model-x'), undefined)
  assert.equal(convertZcodeModel('custom:builtin%3Abigmodel:other-model'), undefined)
  assert.equal(convertZcodeModel('volc-ark-plan/glm-5.3'), 'volc-ark-plan/glm-5.3')
})

test('seedFromZcode: copies parseable agents with converted models, idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-seed-'))
  const source = join(root, 'zcode-agents')
  const target = join(root, 'dsh-agents')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'workhorse.md'), [
    '---',
    'name: workhorse',
    'description: "牛马狗：干活的主力。"',
    'model: custom:9524bbc9-01a6-4e24-9ea2-a0a076ef518b:deepseek-v4-flash',
    '---',
    '',
    '你是牛马狗。',
  ].join('\n'))
  writeFileSync(join(source, 'broken.md'), 'no frontmatter at all\n')
  try {
    const first = seedFromZcode(target, source)
    assert.equal(first.seeded, 1)
    assert.equal(first.errors.length, 1)
    const { agents, broken } = listAgentFiles(target)
    assert.equal(agents.length, 1)
    assert.equal(agents[0].meta.name, 'workhorse')
    assert.equal(agents[0].meta.model, 'opencode-go/deepseek-v4-flash')
    assert.equal(broken.length, 0)
    const second = seedFromZcode(target, source)
    assert.equal(second.seeded, 0, 'seeding must be a no-op once agents exist')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listAgentFiles: skips broken files and reports them aside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-list-'))
  writeFileSync(join(dir, 'good.md'), '---\nname: good\n---\nbody\n')
  writeFileSync(join(dir, 'bad.md'), 'no frontmatter\n')
  writeFileSync(join(dir, 'notes.txt'), '---\nname: ignored\n---\n')
  try {
    const { agents, broken } = listAgentFiles(dir)
    assert.deepEqual(agents.map(agent => agent.meta.name), ['good'])
    assert.equal(broken.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
