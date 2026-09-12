/**
 * Theme registry tests — the themes/ file layer: parsing the theme JSON
 * contract (required fields + derived optional fields), directory scans with
 * warn-skip on invalid files, the builtin themes/ + user theme directory
 * discovery merge, and resolveTheme's registry-aware name resolution.
 * Pure functions + fs against real temp dirs — no TTY needed. Runs against
 * the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  builtinThemesDir,
  discoverThemes,
  parseThemeFile,
  scanThemeDir,
  userThemesDir,
} from '../lib/theme/registry.js'
import { resolveTheme } from '../lib/theme/index.js'

/**
 * The required JSON keys (the Palette fields every theme file must carry;
 * everything else in the Palette is derived — see the derivation tests).
 * The canvas/fg/border/status values mirror the github-light / github-dark
 * bases so the blend expectations below are exact (verified against the
 * existing theme.test.mjs contract values: #283d51 / #3e3751 / #598bb9 …).
 */
function minimalThemeJson(name, dark) {
  return {
    name,
    dark,
    canvas: dark ? '#0d1117' : '#fcfdfc',
    canvasSubtle: dark ? '#161b22' : '#eef3ee',
    canvasInset: dark ? '#010409' : '#e5ebe5',
    fgDefault: dark ? '#e6edf3' : '#1f2a24',
    fgMuted: dark ? '#b1bac4' : '#5a6b60',
    fgSubtle: dark ? '#8b949e' : '#637269',
    borderDefault: dark ? '#6e7681' : '#829087',
    borderMuted: dark ? '#3d444d' : '#b8c1b9',
    accent: dark ? '#79c0ff' : '#0a60b5',
    success: dark ? '#56d364' : '#1e843b',
    danger: dark ? '#ffa198' : '#b64550',
    attention: dark ? '#e3b341' : '#9a6700',
    thinking: dark ? '#d2a8ff' : '#7b4fae',
  }
}

// ---------------------------------------------------------------- parseThemeFile --

test('parseThemeFile returns the complete palette for a full JSON', () => {
  // Every Palette field spelled out — including the optional ones, which must
  // round-trip UNCHANGED (explicit values are never re-derived).
  const full = {
    name: 'full-theme',
    dark: true,
    canvas: '#0d1117',
    canvasSubtle: '#161b22',
    canvasInset: '#010409',
    fgDefault: '#e6edf3',
    fgMuted: '#b1bac4',
    fgSubtle: '#8b949e',
    borderDefault: '#6e7681',
    borderMuted: '#3d444d',
    accent: '#79c0ff',
    accentMuted: '#112233',
    success: '#56d364',
    successMuted: '#334455',
    danger: '#ffa198',
    dangerMuted: '#445566',
    attention: '#e3b341',
    attentionMuted: '#556677',
    thinking: '#d2a8ff',
    thinkingPanelBg: '#667788',
    toolPanelBg: '#778899',
    panelBorder: '#8899aa',
    panelBoxBorder: '#99aabb',
  }
  const palette = parseThemeFile(JSON.stringify(full), 'full.json')
  assert.equal(palette.name, 'full-theme')
  assert.equal(palette.dark, true)
  for (const [key, expected] of Object.entries(full)) {
    assert.equal(palette[key], expected, `palette.${key} round-trips the explicit value`)
  }
  // Every color role is a well-formed #rrggbb hex.
  for (const [key, value] of Object.entries(palette)) {
    if (key === 'name' || key === 'dark') continue
    assert.match(value, /^#[0-9a-fA-F]{6}$/, `palette.${key} is a hex color`)
  }
})

test('parseThemeFile derives the optional fields for a dark theme', () => {
  // Omitted optional fields derive per contract: the muted tints blend over
  // canvas at 0.25, thinkingPanelBg at 0.25 (dark), toolPanelBg = accentMuted,
  // panelBorder = borderDefault, panelBoxBorder = blend(canvas, accent, 0.70).
  const palette = parseThemeFile(JSON.stringify(minimalThemeJson('derived-dark', true)), 'derived-dark.json')
  assert.equal(palette.accentMuted, '#283d51', 'accentMuted = blend(canvas, accent, 0.25)')
  assert.equal(palette.successMuted, '#1f422a', 'successMuted = blend(canvas, success, 0.25)')
  assert.equal(palette.dangerMuted, '#4a3537', 'dangerMuted = blend(canvas, danger, 0.25)')
  assert.equal(palette.attentionMuted, '#433a22', 'attentionMuted = blend(canvas, attention, 0.25)')
  assert.equal(palette.thinkingPanelBg, '#3e3751', 'thinkingPanelBg = blend(canvas, thinking, 0.25)')
  assert.equal(palette.toolPanelBg, palette.accentMuted, 'toolPanelBg = accentMuted')
  assert.equal(palette.panelBorder, '#6e7681', 'panelBorder = borderDefault')
  assert.equal(palette.panelBoxBorder, '#598bb9', 'panelBoxBorder = blend(canvas, accent, 0.70)')
})

test('parseThemeFile derives the optional fields for a light theme', () => {
  // Light alpha conventions: accentMuted blends at 0.18, thinkingPanelBg at
  // 0.12; the status mutes stay at 0.25 and panelBoxBorder at 0.70.
  const palette = parseThemeFile(JSON.stringify(minimalThemeJson('derived-light', false)), 'derived-light.json')
  assert.equal(palette.accentMuted, '#d0e1ef', 'accentMuted = blend(canvas, accent, 0.18)')
  assert.equal(palette.successMuted, '#c5dfcc', 'successMuted = blend(canvas, success, 0.25)')
  assert.equal(palette.dangerMuted, '#ebcfd1', 'dangerMuted = blend(canvas, danger, 0.25)')
  assert.equal(palette.attentionMuted, '#e4d8bd', 'attentionMuted = blend(canvas, attention, 0.25)')
  assert.equal(palette.thinkingPanelBg, '#ede8f3', 'thinkingPanelBg = blend(canvas, thinking, 0.12)')
  assert.equal(palette.toolPanelBg, palette.accentMuted, 'toolPanelBg = accentMuted')
  assert.equal(palette.panelBorder, '#829087', 'panelBorder = borderDefault')
  assert.equal(palette.panelBoxBorder, '#538fca', 'panelBoxBorder = blend(canvas, accent, 0.70)')
})

test('parseThemeFile throws on invalid JSON syntax', () => {
  assert.throws(() => parseThemeFile('{ not json', 'broken.json'))
  assert.throws(() => parseThemeFile('42', 'number.json'))
})

test('parseThemeFile throws on missing required fields', () => {
  const json = minimalThemeJson('missing-canvas', true)
  delete json.canvas
  assert.throws(() => parseThemeFile(JSON.stringify(json), 'missing-canvas.json'))
  // A completely empty object is missing every required key.
  assert.throws(() => parseThemeFile('{}', 'empty.json'))
})

test('parseThemeFile throws on invalid hex colors', () => {
  const json = minimalThemeJson('bad-hex', true)
  json.canvas = 'not-a-color'
  assert.throws(() => parseThemeFile(JSON.stringify(json), 'bad-hex.json'))
  const short = minimalThemeJson('short-hex', true)
  short.accent = '#fff'
  assert.throws(() => parseThemeFile(JSON.stringify(short), 'short-hex.json'))
})

test('parseThemeFile throws on a non-boolean dark flag', () => {
  const json = minimalThemeJson('bad-dark', true)
  json.dark = 'yes'
  assert.throws(() => parseThemeFile(JSON.stringify(json), 'bad-dark.json'))
})

// ----------------------------------------------------------------- scanThemeDir --

test('scanThemeDir collects valid files and skips invalid ones with warn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-themes-scan-'))
  try {
    writeFileSync(join(dir, 'good.json'), JSON.stringify(minimalThemeJson('scan-good', true)))
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    writeFileSync(join(dir, 'missing.json'), JSON.stringify({ name: 'no-fields' }))
    const warns = []
    const map = scanThemeDir(dir, msg => warns.push(msg))
    assert.ok(map.has('scan-good'), 'valid theme registered')
    assert.equal(map.get('scan-good').dark, true)
    assert.ok(!map.has('broken'), 'syntax-broken file skipped')
    assert.ok(!map.has('missing'), 'schema-invalid file skipped')
    assert.equal(warns.length, 2, 'one warn per skipped file')
    for (const warn of warns) assert.equal(typeof warn, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanThemeDir on a missing directory returns an empty Map without throwing', () => {
  const missing = join(tmpdir(), `dsh-themes-missing-${Date.now()}`)
  const map = scanThemeDir(missing)
  assert.ok(map instanceof Map)
  assert.equal(map.size, 0)
})

// ----------------------------------------------------------------- discoverThemes --

test('userThemesDir joins home with themes', () => {
  assert.equal(userThemesDir('/tmp/example-home'), join('/tmp/example-home', 'themes'))
})

test('discoverThemes defaults to scanning the builtin themes/ directory', () => {
  // Deterministic: point the user-theme resolution at a clean temp home so
  // this machine's real ~/.dsh/themes can never leak in.
  const savedHome = process.env.HOME
  const savedDshHome = process.env.DSH_HOME
  const cleanHome = mkdtempSync(join(tmpdir(), 'dsh-clean-home-'))
  try {
    process.env.HOME = cleanHome
    delete process.env.DSH_HOME
    const map = discoverThemes()
    // The canonical github pair is always seeded, even before themes/ lands.
    assert.ok(map.has('github-light'), 'github-light discovered')
    assert.ok(map.has('github-dark'), 'github-dark discovered')
    const dir = builtinThemesDir()
    if (existsSync(dir)) {
      // Loose on the total: another agent may still be landing the 20-file
      // roster. Whenever the set is complete, require all 20.
      if (map.size >= 20) assert.equal(map.size, 20, 'full 20-theme roster')
      else assert.ok(map.size >= 2, 'at least the two guaranteed github themes')
    } else {
      // No themes/ dir yet: discovery still yields the canonical pair.
      assert.equal(map.size, 2, 'github pair seeded without themes/')
    }
  } finally {
    process.env.HOME = savedHome
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    rmSync(cleanHome, { recursive: true, force: true })
  }
})

test('discoverThemes merges user themes over builtin by name', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  try {
    mkdirSync(join(home, 'themes'), { recursive: true })
    const custom = { ...minimalThemeJson('github-dark', true), canvas: '#101010' }
    writeFileSync(join(home, 'themes', 'github-dark.json'), JSON.stringify(custom))
    const map = discoverThemes({ home })
    assert.ok(map.has('github-dark'), 'github-dark present (builtin or user)')
    assert.equal(map.get('github-dark').canvas, '#101010', 'user github-dark overrides the builtin')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('discoverThemes reports invalid user theme files through warn', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  try {
    mkdirSync(join(home, 'themes'), { recursive: true })
    writeFileSync(join(home, 'themes', 'broken.json'), '{ nope')
    const warns = []
    const map = discoverThemes({ home, warn: msg => warns.push(msg) })
    assert.ok(!map.has('broken'), 'invalid user file not registered')
    assert.ok(warns.length >= 1, 'invalid user theme surfaced through warn')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------- resolveTheme + registry --

test('resolveTheme with a registry resolves registered theme names', () => {
  const myDark = parseThemeFile(JSON.stringify(minimalThemeJson('my-dark', true)), 'my-dark.json')
  const myLight = parseThemeFile(JSON.stringify(minimalThemeJson('my-light', false)), 'my-light.json')
  const registry = new Map([
    ['my-dark', myDark],
    ['my-light', myLight],
  ])

  // A named preference resolves through the registry.
  assert.equal(resolveTheme({}, 'my-dark', registry).palette.name, 'my-dark')
  assert.equal(resolveTheme({}, 'my-light', registry).palette.name, 'my-light')
  // DSH_TUI_THEME accepts the same registered names.
  assert.equal(resolveTheme({ DSH_TUI_THEME: 'my-dark' }, 'auto', registry).palette.name, 'my-dark')
  assert.equal(resolveTheme({ DSH_TUI_THEME: 'my-light' }, 'auto', registry).palette.name, 'my-light')
  // The resolved bundle is a full TuiTheme, not just a palette.
  const resolved = resolveTheme({}, 'my-dark', registry)
  assert.equal(typeof resolved.chat.userMessageText, 'function')
})

test('resolveTheme with a registry keeps light/dark and falls back for unknown names', () => {
  const registry = new Map([
    ['my-dark', parseThemeFile(JSON.stringify(minimalThemeJson('my-dark', true)), 'my-dark.json')],
  ])
  // The special light/dark names keep resolving to the singletons.
  assert.equal(resolveTheme({}, 'light', registry).palette.name, 'github-light')
  assert.equal(resolveTheme({}, 'dark', registry).palette.name, 'github-dark')
  assert.equal(resolveTheme({ DSH_TUI_THEME: 'light' }, 'auto', registry).palette.name, 'github-light')
  // Unknown names (and auto) fall back to terminal detection — {} is dark.
  assert.equal(resolveTheme({}, 'nope', registry).palette.name, 'github-dark')
  assert.equal(resolveTheme({ DSH_TUI_THEME: 'nope' }, 'auto', registry).palette.name, 'github-dark')
  assert.equal(resolveTheme({}, 'auto', registry).palette.name, 'github-dark')
  // ...and the detection still honors terminal signals.
  assert.equal(resolveTheme({ COLORFGBG: '0;15' }, 'nope', registry).palette.name, 'github-light')
})
