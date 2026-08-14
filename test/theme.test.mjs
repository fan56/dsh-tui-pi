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

test('dark muted backgrounds are blended solids (20% tint over canvas)', () => {
  // accentMuted = blend(#0d1117, #1f6feb, 0.2)
  assert.equal(githubDark.accentMuted, '#112441')
  assert.equal(githubDark.successMuted, '#173322')
  assert.equal(githubDark.dangerMuted, '#3c1e21')
  assert.equal(githubDark.attentionMuted, '#342c19')
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
    if (key === 'name') continue
    assert.match(value, /^#[0-9a-fA-F]{6}$/, `palette.${key} must be a hex color`)
  }
})
