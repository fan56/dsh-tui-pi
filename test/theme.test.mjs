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
import { githubDark, githubLight } from '../lib/theme/palette.js'

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
  // accentMuted = blend(#0d1117, #58a6ff, 0.25)
  assert.equal(githubDark.accentMuted, '#203651')
  assert.equal(githubDark.successMuted, '#1a3b25')
  assert.equal(githubDark.dangerMuted, '#4a2c2e')
  assert.equal(githubDark.attentionMuted, '#3e331a')
})

test('panel surfaces and border roles exist in both themes', () => {
  assert.equal(githubLight.thinkingPanelBg, '#f4effa')
  assert.equal(githubLight.toolPanelBg, '#eef4fb')
  assert.equal(githubLight.panelBorder, '#a9c0ab')
  // Dark tints follow the existing blend convention (25% over canvas):
  // thinkingPanelBg = blend(#0d1117, #bc8cff, 0.25); toolPanelBg matches
  // accentMuted's 25% blue tint.
  assert.equal(githubDark.thinkingPanelBg, '#393051')
  assert.equal(githubDark.toolPanelBg, '#203651')
  assert.equal(githubDark.panelBorder, '#34433b')
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
  assert.ok(out.endsWith('\x1b[0m'))
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
