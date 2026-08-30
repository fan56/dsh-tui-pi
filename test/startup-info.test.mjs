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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Container } from '@earendil-works/pi-tui'
import { TranscriptRenderer } from '../lib/messages.js'
import { darkTheme, lightTheme } from '../lib/theme/index.js'
import { visibleWidth } from '../lib/text.js'
import {
  classifyPluginEntries,
  moduleVersionResolver,
  collectStartupSummary,
  countSkills,
  detectProfileFlag,
  formatResumeCommand,
  formatStartupInfoLines,
  parseResumeArg,
  profileFromBaseUrl,
  resolveProfileName,
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

test('formatStartupInfoLines renders the profile root, the tree, then the counts line', () => {
  const lines = formatStartupInfoLines({
    profile: 'tui',
    mcp: [{ name: 'anysearch', disabled: false }, { name: 'off', disabled: true }],
    skills: { installed: 96, total: 105 },
    userPlugins: ['@aiwayds/dsh-dcp', '@aiwayds/dsh-feishu (disabled)'],
    baseCount: 86,
    pluginTotal: 89,
  }, undefined)
  assert.deepEqual(lines, [
    'tui',
    '├─ @aiwayds/dsh-dcp',
    '├─ @aiwayds/dsh-feishu (disabled)',
    '└─ dsh-base (86)',
    // plugins counts ONLY the profile's own additions (the tree's user rows)
    // — the mcp instances have their own segment, the base none at all.
    'mcp 1 · skills 96/105 · plugins 2',
  ])
})

test('an unresolvable profile name omits the root line', () => {
  const lines = formatStartupInfoLines({
    profile: undefined,
    mcp: [], skills: { installed: 0, total: 0 },
    userPlugins: ['@aiwayds/dsh-dcp'], baseCount: 5, pluginTotal: 6,
  }, undefined)
  assert.equal(lines[0], '├─ @aiwayds/dsh-dcp')
  assert.equal(lines[lines.length - 1], 'mcp 0 · skills 0/0 · plugins 1')
})

test('without a base row the last user row takes the tree corner', () => {
  const lines = formatStartupInfoLines({
    profile: 'tui',
    mcp: [], skills: { installed: 0, total: 0 },
    userPlugins: ['@aiwayds/dsh-dcp', '@aiwayds/dsh-tui-pi'],
    baseCount: 0,
    pluginTotal: 2,
  }, undefined)
  assert.deepEqual(lines, [
    'tui',
    '├─ @aiwayds/dsh-dcp',
    '└─ @aiwayds/dsh-tui-pi',
    'mcp 0 · skills 0/0 · plugins 2',
  ])
})

test('a summary with no plugins renders the counts line alone', () => {
  const lines = formatStartupInfoLines({
    profile: 'tui',
    mcp: [], skills: { installed: 3, total: 9 }, userPlugins: [], baseCount: 0, pluginTotal: 0,
  }, undefined)
  assert.deepEqual(lines, ['tui', 'mcp 0 · skills 3/9 · plugins 0'])
})

test('the counts line excludes disabled mcp servers', () => {
  const lines = formatStartupInfoLines({
    profile: 'tui',
    mcp: [{ name: 'anysearch', disabled: false }, { name: 'off', disabled: true }],
    skills: { installed: 0, total: 0 }, userPlugins: [], baseCount: 5, pluginTotal: 8,
  }, undefined)
  assert.equal(lines[lines.length - 1], 'mcp 1 · skills 0/0 · plugins 0')
})

test('every line clips to the usable width instead of wrapping', () => {
  const lines = formatStartupInfoLines({
    profile: 'an-extremely-long-profile-name-that-keeps-going-and-going',
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

test('resolveProfileName falls back to the loader base URL when argv has no --profile', () => {
  // The test runner's argv carries no --profile, so the fallback path runs.
  const ctx = { root: { baseUrl: 'file:///root/.dsh/profiles/tui/' } }
  assert.equal(resolveProfileName(ctx), 'tui')
  assert.equal(resolveProfileName({ root: { baseUrl: 'file:///home/me/project/' } }), undefined)
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
    const ctx = {
      get: name => (name === 'loader' ? fakeLoader : undefined),
      root: { baseUrl: 'file:///root/.dsh/profiles/tui/' },
    }
    const summary = collectStartupSummary(ctx)
    assert.equal(summary.profile, 'tui')
    assert.deepEqual(summary.mcp, [{ name: 'anysearch', disabled: false }])
    assert.deepEqual(summary.skills, { installed: 1, total: 2 })
    // The collector wires the real version resolver (anchored at this built
    // lib, inside the repo): @aiwayds/dsh-dcp is a real dependency here, so
    // the row carries the installed version. End-to-end proof of the suffix.
    const dcpVersion = JSON.parse(
      readFileSync(new URL('../node_modules/@aiwayds/dsh-dcp/package.json', import.meta.url), 'utf8'),
    ).version
    assert.deepEqual(summary.userPlugins, [`@aiwayds/dsh-dcp@${dcpVersion}`])
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
    profile: 'tui',
    mcp: [{ name: 'anysearch', disabled: false }],
    skills: { installed: 96, total: 105 },
    userPlugins: ['@aiwayds/dsh-dcp'],
    baseCount: 86,
    pluginTotal: 88,
  })
  // spacer, banner, spacer, profile, tree ×2, counts, spacer, quote, spacer
  assert.equal(doc.children.length, 10, 'summary block slots in before the quote')
  const plain = stripAnsi(doc.children.map(c => c.render(200).join('\n')).join('\n'))
  // The profile name is the tree root (first summary line, before the rows).
  assert.equal(stripAnsi(doc.children[3].render(200).join('\n')).trim(), 'tui')
  assert.ok(plain.includes('├─ @aiwayds/dsh-dcp'))
  assert.ok(plain.includes('└─ dsh-base (86)'))
  assert.ok(plain.includes('mcp 1 · skills 96/105 · plugins 1'))
  // The summary survives a theme rebuild: the welcome replay op re-renders
  // the stored snapshot with the new palette at the same width.
  renderer.setTheme(darkTheme)
  const rebuilt = stripAnsi(doc.children.map(c => c.render(200).join('\n')).join('\n'))
  assert.ok(rebuilt.includes('mcp 1 · skills 96/105 · plugins 1'))
  assert.ok(rebuilt.includes('└─ dsh-base (86)'))
})

test('a renderer built without a summary keeps the plain 5-child welcome', () => {
  const doc = new Container()
  new TranscriptRenderer(doc, darkTheme, () => {})
  assert.equal(doc.children.length, 5, 'no summary block when the snapshot is undefined')
})

// ------------------------------------------------- plugin row versions ----

test('classifyPluginEntries suffixes user rows with the resolved version', () => {
  const versions = { '@aiwayds/dsh-feishu': '0.5.0', '@aiwayds/dsh-dcp': '0.5.1' }
  const view = classifyPluginEntries(
    [
      entry('feishu', '@aiwayds/dsh-feishu'),
      entry('dcp', '@aiwayds/dsh-dcp', { disabled: true }),
      entry('mystery', '@aiwayds/dsh-no-version'),
      entry('llm', '@deepseek-ai/dsh-llm'),
    ],
    name => versions[name],
  )
  assert.deepEqual(view.userPlugins, [
    '@aiwayds/dsh-feishu@0.5.0',
    '@aiwayds/dsh-dcp@0.5.1 (disabled)',
    '@aiwayds/dsh-no-version',
  ])
  assert.equal(view.baseCount, 1, 'base rows stay collapsed (never versioned)')
})

test('classifyPluginEntries without a resolver keeps the plain-name rows', () => {
  const view = classifyPluginEntries([entry('feishu', '@aiwayds/dsh-feishu'), entry('dcp', '@aiwayds/dsh-dcp', { disabled: true })])
  assert.deepEqual(view.userPlugins, ['@aiwayds/dsh-feishu', '@aiwayds/dsh-dcp (disabled)'])
})

test('moduleVersionResolver resolves a real sibling package and degrades on unknown names', () => {
  const resolveVersion = moduleVersionResolver(import.meta.url)
  // The test file sits inside the repo, whose node_modules holds the real
  // @earendil-works/pi-tui — the walk-up must find ITS package.json, not a
  // nearer one, and the value must match what npm installed.
  const expected = JSON.parse(readFileSync(new URL('../node_modules/@earendil-works/pi-tui/package.json', import.meta.url), 'utf8')).version
  assert.equal(resolveVersion('@earendil-works/pi-tui'), expected)
  assert.equal(resolveVersion('definitely-not-a-real-pkg-xyz'), undefined, 'unresolvable name → no version')
})
