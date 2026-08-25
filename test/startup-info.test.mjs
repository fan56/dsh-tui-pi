/**
 * Startup summary tests — the config readout under the welcome banner
 * (mcp/skills/plugin-tree classification and formatting) plus the exit-time
 * resume hint's pure helpers (launcher flag parsing, command formatting).
 * collectStartupSummary is exercised hermetically too: a fake loader service
 * plus DSH_HOME/DSH_AGENTS_HOME pointed at temp directories. Runs against
 * the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Container } from '@earendil-works/pi-tui'
import { TranscriptRenderer } from '../lib/messages.js'
import { darkTheme, lightTheme } from '../lib/theme/index.js'
import { visibleWidth } from '../lib/text.js'
import {
  classifyPluginEntries,
  collectStartupSummary,
  countSkills,
  detectProfileFlag,
  formatResumeCommand,
  formatStartupInfoLines,
  parseResumeArg,
  profileFromBaseUrl,
  skillNamesFromListing,
} from '../lib/startup-info.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

const entry = (id, name, extra = {}) => ({
  id,
  name,
  disabled: false,
  group: false,
  ...extra,
})

// ------------------------------------------------------------- skills ----

test('skillNamesFromListing folds .md files and bundles, skips dotfiles', () => {
  const names = skillNamesFromListing(['bailian-cli.md', 'agent-browser', '.DS_Store', '.hidden', 'eli5'])
  assert.deepEqual([...names].sort(), ['agent-browser', 'bailian-cli', 'eli5'])
})

test('countSkills counts installed as the public catalog subset present in curated', () => {
  const counts = countSkills(
    ['alpha.md', 'beta', 'gamma.md'],
    ['alpha.md', 'beta', 'unrelated.md'],
  )
  assert.equal(counts.total, 3)
  assert.equal(counts.installed, 2)
})

test('countSkills is zero over zero on an empty public catalog', () => {
  const counts = countSkills([], ['curated.md'])
  assert.deepEqual(counts, { installed: 0, total: 0 })
})

// ------------------------------------------------------------ plugins ----

test('classifyPluginEntries splits mcp servers, base count and user rows, skipping groups', () => {
  const view = classifyPluginEntries([
    entry('llm', '@deepseek-ai/dsh-llm'),
    entry('include', 'cordis:include'),
    entry('anysearch', '@deepseek-ai/dsh-mcp-client', { config: { serverName: 'anysearch' } }),
    entry('dify', '@deepseek-ai/dsh-mcp-client', { config: { serverName: 'dify' } }),
    entry('off', '@deepseek-ai/dsh-mcp-client', { config: { serverName: 'off' }, disabled: true }),
    entry('skills', '@deepseek-ai/dsh-skill'),
    entry('dcp', '@aiwayds/dsh-dcp'),
    entry('feishu', '@aiwayds/dsh-feishu', { disabled: true }),
    entry('tui', '@aiwayds/dsh-tui-pi'),
    entry('local', './plugins/mine.ts'),
    { id: 'grp', name: 'group', disabled: false, group: true },
  ])
  assert.equal(view.pluginTotal, 10, 'group rows never count')
  // mcp-client instances surface in the mcp list, not in the base count;
  // cordis: loader builtins are harness plumbing, not user plugins.
  assert.equal(view.baseCount, 3)
  assert.deepEqual(view.mcp.map(s => [s.name, s.disabled]), [
    ['anysearch', false],
    ['dify', false],
    ['off', true],
  ])
  assert.deepEqual(view.userPlugins, [
    '@aiwayds/dsh-dcp',
    '@aiwayds/dsh-feishu (disabled)',
    '@aiwayds/dsh-tui-pi',
    './plugins/mine.ts',
  ])
})

test('an mcp entry without serverName falls back to its entry id', () => {
  const view = classifyPluginEntries([entry('anysearch', '@deepseek-ai/dsh-mcp-client')])
  assert.deepEqual(view.mcp, [{ name: 'anysearch', disabled: false }])
})

// ---------------------------------------------------------- formatting ----

test('formatStartupInfoLines renders the header and the collapsed plugin tree', () => {
  const lines = formatStartupInfoLines({
    mcp: [{ name: 'anysearch', disabled: false }, { name: 'off', disabled: true }],
    skills: { installed: 96, total: 105 },
    userPlugins: ['@aiwayds/dsh-dcp', '@aiwayds/dsh-feishu (disabled)'],
    baseCount: 86,
    pluginTotal: 89,
  }, undefined)
  assert.equal(lines[0], 'mcp 1 (anysearch) · skills 96/105 · plugins 89')
  assert.deepEqual(lines.slice(1), [
    '├─ @aiwayds/dsh-dcp',
    '├─ @aiwayds/dsh-feishu (disabled)',
    '└─ dsh-base (86)',
  ])
})

test('the header names every enabled mcp server', () => {
  const lines = formatStartupInfoLines({
    mcp: [{ name: 'anysearch', disabled: false }, { name: 'dify', disabled: false }],
    skills: { installed: 0, total: 0 },
    userPlugins: [],
    baseCount: 5,
    pluginTotal: 7,
  }, undefined)
  assert.equal(lines[0], 'mcp 2 (anysearch, dify) · skills 0/0 · plugins 7')
})

test('a zero-mcp header still states the count', () => {
  const lines = formatStartupInfoLines({
    mcp: [], skills: { installed: 3, total: 9 }, userPlugins: [], baseCount: 9, pluginTotal: 9,
  }, undefined)
  assert.equal(lines[0], 'mcp 0 · skills 3/9 · plugins 9')
})

test('an empty plugin tree renders the header alone', () => {
  const lines = formatStartupInfoLines({
    mcp: [], skills: { installed: 0, total: 0 }, userPlugins: [], baseCount: 0, pluginTotal: 0,
  }, undefined)
  assert.equal(lines.length, 1)
  assert.equal(lines[0], 'mcp 0 · skills 0/0 · plugins 0')
})

test('every line clips to the usable width instead of wrapping', () => {
  const lines = formatStartupInfoLines({
    mcp: [{ name: 'a-very-long-server-name', disabled: false }],
    skills: { installed: 96, total: 105 },
    userPlugins: ['@aiwayds/an-extremely-long-plugin-name-that-keeps-going'],
    baseCount: 86,
    pluginTotal: 88,
  }, 40)
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 38, `line fits the budget: ${line}`)
  }
})

// ------------------------------------------------------- resume hint ----

test('detectProfileFlag reads both launcher forms, valueless stays undefined', () => {
  assert.equal(detectProfileFlag(['node', '/bin/dsh', '--profile', 'tui']), 'tui')
  assert.equal(detectProfileFlag(['dsh', '--profile=web', '--resume', 'x']), 'web')
  assert.equal(detectProfileFlag(['dsh', 'web']), undefined)
  assert.equal(detectProfileFlag(['dsh', '--profile']), undefined)
})

test('parseResumeArg reads both inner-arg forms', () => {
  assert.equal(parseResumeArg(['--resume', '01a036dc']), '01a036dc')
  assert.equal(parseResumeArg(['--resume=01a036dc']), '01a036dc')
  assert.equal(parseResumeArg(['--profile', 'tui']), undefined)
  assert.equal(parseResumeArg(['--resume']), undefined)
})

test('profileFromBaseUrl names only real profile directories', () => {
  assert.equal(profileFromBaseUrl('file:///root/.dsh/profiles/tui/'), 'tui')
  // The profile name is the first segment after /profiles/ — nested paths
  // below a profile directory never leak into the name.
  assert.equal(profileFromBaseUrl('file:///root/.dsh/profiles/a/b/'), 'a')
  assert.equal(profileFromBaseUrl('file:///home/me/project/'), undefined)
  assert.equal(profileFromBaseUrl(undefined), undefined)
  assert.equal(profileFromBaseUrl(''), undefined)
})

test('formatResumeCommand reproduces the launcher invocation, or the bare flag family', () => {
  assert.equal(
    formatResumeCommand('tui', '01a036dc-29d8'),
    'dsh --profile tui --resume 01a036dc-29d8',
  )
  assert.equal(
    formatResumeCommand(undefined, '01a036dc'),
    'dsh --resume 01a036dc',
  )
  assert.equal(
    formatResumeCommand('', '01a036dc'),
    'dsh --resume 01a036dc',
  )
})

// --------------------------------------------------------- collector ----

test('collectStartupSummary snapshots loader entries and both skill dirs', () => {
  const home = mkdtempSync(join(tmpdir(), 'startup-info-'))
  const agentsHome = mkdtempSync(join(tmpdir(), 'startup-agents-'))
  const prevDsh = process.env.DSH_HOME
  const prevAgents = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = home
  process.env.DSH_AGENTS_HOME = agentsHome
  try {
    mkdirSync(join(home, 'skills'), { recursive: true })
    mkdirSync(join(agentsHome, 'skills'), { recursive: true })
    writeFileSync(join(agentsHome, 'skills', 'installed.md'), 'x')
    writeFileSync(join(agentsHome, 'skills', 'available.md'), 'x')
    writeFileSync(join(home, 'skills', 'installed.md'), 'x')

    const fakeLoader = {
      entries: function* () {
        yield { id: 'llm', disabled: false, options: { name: '@deepseek-ai/dsh-llm' } }
        yield { id: 'anysearch', disabled: false, options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'anysearch' } } }
        yield { id: 'dcp', disabled: false, options: { name: '@aiwayds/dsh-dcp' } }
      },
    }
    const ctx = { get: name => (name === 'loader' ? fakeLoader : undefined) }
    const summary = collectStartupSummary(ctx)
    assert.deepEqual(summary.mcp, [{ name: 'anysearch', disabled: false }])
    assert.deepEqual(summary.skills, { installed: 1, total: 2 })
    assert.deepEqual(summary.userPlugins, ['@aiwayds/dsh-dcp'])
    assert.equal(summary.baseCount, 1)
    assert.equal(summary.pluginTotal, 3)

    // Without a loader service the summary degrades to undefined — startup
    // never depends on this readout.
    assert.equal(collectStartupSummary({ get: () => undefined }), undefined)
  } finally {
    if (prevDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDsh
    if (prevAgents === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = prevAgents
    rmSync(home, { recursive: true, force: true })
    rmSync(agentsHome, { recursive: true, force: true })
  }
})

// ------------------------------------------------- renderer integration ----

test('the welcome banner renders the summary lines between banner and quote, rebuilt with the theme', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {}, {
    mcp: [{ name: 'anysearch', disabled: false }],
    skills: { installed: 96, total: 105 },
    userPlugins: ['@aiwayds/dsh-dcp'],
    baseCount: 86,
    pluginTotal: 88,
  })
  // spacer, banner, spacer, header, tree ×2, spacer, quote, spacer
  assert.equal(doc.children.length, 9, 'summary block slots in before the quote')
  const plain = stripAnsi(doc.children.map(c => c.render(200).join('\n')).join('\n'))
  assert.ok(plain.includes('mcp 1 (anysearch) · skills 96/105 · plugins 88'))
  assert.ok(plain.includes('├─ @aiwayds/dsh-dcp'))
  assert.ok(plain.includes('└─ dsh-base (86)'))
  // The summary survives a theme rebuild: the welcome replay op re-renders
  // the stored snapshot with the new palette at the same width.
  renderer.setTheme(darkTheme)
  const rebuilt = stripAnsi(doc.children.map(c => c.render(200).join('\n')).join('\n'))
  assert.ok(rebuilt.includes('mcp 1 (anysearch) · skills 96/105 · plugins 88'))
  assert.ok(rebuilt.includes('└─ dsh-base (86)'))
})

test('a renderer built without a summary keeps the plain 5-child welcome', () => {
  const doc = new Container()
  new TranscriptRenderer(doc, darkTheme, () => {})
  assert.equal(doc.children.length, 5, 'no summary block when the snapshot is undefined')
})
