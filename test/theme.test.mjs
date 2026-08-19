/**
 * Theme module tests — pure functions, no TTY needed.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ansiBg,
  ansiFg,
  buildTheme,
  darkTheme,
  lightTheme,
  POWERLINE,
  resolveTheme,
} from '../lib/theme/index.js'
import { githubDark, githubLight, hexContrast, hexIsLight } from '../lib/theme/palette.js'

test('ansiFg emits truecolor SGR', () => {
  assert.equal(ansiFg('#ff0000'), '\x1b[38;2;255;0;0m')
  assert.equal(ansiFg('#0d1117'), '\x1b[38;2;13;17;23m')
})

test('ansiBg emits truecolor SGR', () => {
  assert.equal(ansiBg('#4CAF50'), '\x1b[48;2;76;175;80m')
})

test('palette ids are stable', () => {
  assert.equal(githubLight.name, 'github-light')
  assert.equal(githubDark.name, 'github-dark')
})

test('dark muted backgrounds are blended solids (25% tint over canvas)', () => {
  // accentMuted = blend(#0d1117, #79c0ff, 0.25)
  assert.equal(githubDark.accentMuted, '#283d51')
  assert.equal(githubDark.successMuted, '#1f422a')
  assert.equal(githubDark.dangerMuted, '#4a3537')
  assert.equal(githubDark.attentionMuted, '#433a22')
})

test('dark status hues are the bright cmux GitHub Dark set (no dim text roles)', () => {
  assert.equal(githubDark.accent, '#79c0ff')
  assert.equal(githubDark.success, '#56d364')
  assert.equal(githubDark.attention, '#e3b341')
  assert.equal(githubDark.danger, '#ffa198')
  assert.equal(githubDark.thinking, '#d2a8ff')
  // Secondary/de-emphasized grays stay clearly legible on the dark canvas.
  assert.equal(githubDark.fgMuted, '#b1bac4')
  assert.equal(githubDark.fgSubtle, '#8b949e')
})

test('hexIsLight flags bright fills for dark segment text', () => {
  assert.equal(hexIsLight(POWERLINE.contextWarn), true, 'amber warn is a bright fill')
  assert.equal(hexIsLight(POWERLINE.contextOk), false, 'green ok keeps white text')
  assert.equal(hexIsLight('#0d1117'), false)
})

test('panel surfaces and border roles exist in both themes', () => {
  assert.equal(githubLight.thinkingPanelBg, '#f4effa')
  assert.equal(githubLight.toolPanelBg, '#eef4fb')
  assert.equal(githubLight.panelBorder, '#6f8c72')
  // FramedOverlay box border = accent tinted over canvas (blend 0.7).
  assert.equal(githubLight.panelBoxBorder, '#538fca')
  // Dark tints follow the existing blend convention (25% over canvas):
  // thinkingPanelBg = blend(#0d1117, #d2a8ff, 0.25); toolPanelBg matches
  // accentMuted's 25% blue tint.
  assert.equal(githubDark.thinkingPanelBg, '#3e3751')
  assert.equal(githubDark.toolPanelBg, '#283d51')
  assert.equal(githubDark.panelBorder, '#64766b')
  // FramedOverlay box border = accent tinted over canvas (blend 0.70).
  assert.equal(githubDark.panelBoxBorder, '#598bb9')
})

test('panel chrome tokens have visible contrast against the canvas', () => {
  // borderDefault: neutral gray, ≥3:1 against the canvas (UI component min).
  // panelBoxBorder: accent-tinted, ≥3:1 — gives select panels a theme color.
  // panelBorder: think/tool panel border, ≥3:1 against canvasSubtle.
  assert.ok(hexContrast('#6e7681', githubDark.canvas) >= 3, 'dark borderDefault is visible')
  assert.ok(hexContrast('#598bb9', githubDark.canvas) >= 3, 'dark panelBoxBorder is visible + themed')
  assert.ok(hexContrast('#64766b', githubDark.canvasSubtle) >= 3, 'dark panelBorder is visible on subtle')
  // light
  assert.ok(hexContrast('#829087', githubLight.canvas) >= 3, 'light borderDefault is visible')
  assert.ok(hexContrast('#538fca', githubLight.canvas) >= 3, 'light panelBoxBorder is visible + themed')
  assert.ok(hexContrast('#6f8c72', githubLight.canvasSubtle) >= 3, 'light panelBorder is visible on subtle')
})

test('chat panel bg roles wire to the distinct panel surfaces', () => {
  const light = buildTheme(githubLight)
  assert.ok(light.chat.thinkingPanelBg('x').startsWith(ansiBg(githubLight.thinkingPanelBg)))
  assert.ok(light.chat.toolPendingBg('x').startsWith(ansiBg(githubLight.toolPanelBg)))
  assert.ok(light.chat.toolBodyBg('x').startsWith(ansiBg(githubLight.toolPanelBg)))
  // The settle status tints stay on their own surfaces (unchanged).
  assert.ok(light.chat.toolSuccessBg('x').startsWith(ansiBg(githubLight.successMuted)))
  assert.ok(light.chat.toolErrorBg('x').startsWith(ansiBg(githubLight.dangerMuted)))
  // User message bubbles keep the canvasSubtle surface.
  assert.ok(light.chat.userMessageBg('x').startsWith(ansiBg(githubLight.canvasSubtle)))
})

test('resolveTheme respects explicit override', () => {
  assert.equal(resolveTheme({ DSH_TUI_THEME: 'light' }).palette.name, 'github-light')
  assert.equal(resolveTheme({ DSH_TUI_THEME: 'dark' }).palette.name, 'github-dark')
})

test('resolveTheme defaults to dark without terminal signals', () => {
  assert.equal(resolveTheme({}).palette.name, 'github-dark')
})

test('resolveTheme follows COLORFGBG when no override', () => {
  assert.equal(resolveTheme({ COLORFGBG: '0;15' }).palette.name, 'github-light')
  assert.equal(resolveTheme({ COLORFGBG: '15;0' }).palette.name, 'github-dark')
})

test('resolveTheme honors an explicit light preference', () => {
  assert.equal(resolveTheme({}, 'light').palette.name, 'github-light')
})

test('resolveTheme honors an explicit dark preference', () => {
  assert.equal(resolveTheme({}, 'dark').palette.name, 'github-dark')
})

test('resolveTheme env override beats an explicit preference', () => {
  assert.equal(resolveTheme({ DSH_TUI_THEME: 'dark' }, 'light').palette.name, 'github-dark')
  assert.equal(resolveTheme({ DSH_TUI_THEME: 'light' }, 'dark').palette.name, 'github-light')
})

test('resolveTheme auto preference falls back to terminal detection', () => {
  assert.equal(resolveTheme({}, 'auto').palette.name, 'github-dark')
  assert.equal(resolveTheme({ COLORFGBG: '0;15' }, 'auto').palette.name, 'github-light')
})

test('buildTheme produces all pi-tui theme roles', () => {
  const theme = buildTheme(githubLight)
  assert.equal(typeof theme.editor.borderColor, 'function')
  assert.equal(typeof theme.editor.selectList.selectedText, 'function')
  assert.equal(typeof theme.markdown.heading, 'function')
  assert.equal(typeof theme.markdown.code, 'function')
  assert.equal(typeof theme.chat.userMessageText, 'function')
  assert.equal(typeof theme.chat.toolSuccessBg, 'function')
})

test('theme style functions wrap text with SGR + reset', () => {
  const out = lightTheme.chat.userMessageText('hi')
  assert.ok(out.startsWith('\x1b[38;2;'))
  // Foreground-only reset (\x1b[39m): the bubble's right padding keeps the
  // canvasSubtle background — a full \x1b[0m would drop it to the canvas.
  assert.ok(out.endsWith('\x1b[39m'))
  assert.ok(out.includes('hi'))
})

test('powerline palette carries all segment colors', () => {
  assert.equal(Object.keys(POWERLINE.thinking).length, 7)
  for (const key of ['provider', 'contextOk', 'contextWarn', 'contextOrange', 'contextDanger', 'cache', 'messages', 'tools']) {
    assert.match(POWERLINE[key], /^#[0-9A-Fa-f]{6}$/)
  }
})

test('dark theme is usable (no empty color roles)', () => {
  for (const [key, value] of Object.entries(darkTheme.palette)) {
    if (key === 'name' || key === 'dark') continue // name id + dark boolean flag
    assert.match(value, /^#[0-9a-fA-F]{6}$/, `palette.${key} must be a hex color`)
  }
})

test('palette dark flag flips with the theme', () => {
  assert.equal(githubLight.dark, false, 'light palette is not dark')
  assert.equal(githubDark.dark, true, 'dark palette is dark')
})
