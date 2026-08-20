/**
 * install-font.mjs pure-function tests — scripts/install-font.mjs (icon-set
 * font install). The injectable exports — parseFontSize, gnomeSizeToPreserve
 * and the kitty/alacritty/wezterm config transforms — are exercised directly
 * against the source module (a pure ESM .mjs; no build step involved):
 * parsing and fallback, GNOME font-size preservation, family replacement vs.
 * block append, and wezterm font_with_fallback handling.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  alacrittyTomlTransform,
  alacrittyYmlTransform,
  gnomeSizeToPreserve,
  kittyTransform,
  parseFontSize,
  weztermTransform,
} from '../scripts/install-font.mjs'

test('parseFontSize extracts the trailing size and falls back to 12', () => {
  assert.equal(parseFontSize('Menlo-Regular 13'), '13', 'iTerm2 "Normal Font" value')
  assert.equal(parseFontSize('Ubuntu Mono 11'), '11', 'GNOME profile font')
  assert.equal(parseFontSize('SF Mono 14.5'), '14.5', 'decimal sizes survive')
  assert.equal(parseFontSize('Menlo-Regular'), '12', 'no trailing size → 12')
  assert.equal(parseFontSize(null), '12', 'unreadable value → 12')
})

test('gnomeSizeToPreserve reads the font in use and strips gsettings quotes', () => {
  // use-system-font off → the profile font is the one in use.
  assert.equal(gnomeSizeToPreserve('false', "'Ubuntu Mono 11'", "'JetBrains Mono 13'"), '11')
  // use-system-font on → the desktop monospace font is the one in use.
  assert.equal(gnomeSizeToPreserve('true', "'Ubuntu Mono 11'", "'JetBrains Mono 13'"), '13')
  // Unquoted values work too.
  assert.equal(gnomeSizeToPreserve('false', 'Menlo 13', 'Menlo 13'), '13')
  // Nothing readable → 12.
  assert.equal(gnomeSizeToPreserve('false', null, null), '12')
  assert.equal(gnomeSizeToPreserve('true', null, "'Monospace 16'"), '16')
})

test('kittyTransform replaces an existing font_family or appends one', () => {
  assert.equal(
    kittyTransform('font_size 13\nfont_family Fira Code\n'),
    'font_size 13\nfont_family DSH TUI Nerd\n',
    'existing family replaced in place',
  )
  assert.equal(
    kittyTransform('font_size 13'),
    'font_size 13\nfont_family DSH TUI Nerd\n',
    'missing family → appended',
  )
})

test('alacrittyTomlTransform replaces an existing family or appends [font.normal]', () => {
  assert.equal(
    alacrittyTomlTransform('[font]\nsize = 13\n'),
    '[font]\nsize = 13\n[font.normal]\nfamily = "DSH TUI Nerd"\n',
    '[font] present, no family → [font.normal] block appended',
  )
  assert.equal(
    alacrittyTomlTransform('window.decorations = "none"\n'),
    'window.decorations = "none"\n[font.normal]\nfamily = "DSH TUI Nerd"\n',
    'no [font] section → [font.normal] block appended',
  )
  assert.equal(
    alacrittyTomlTransform('[font]\nsize = 13\n\n[font.normal]\nfamily = "Fira Code"\n'),
    '[font]\nsize = 13\n\n[font.normal]\nfamily = "DSH TUI Nerd"\n',
    'existing family replaced',
  )
})

test('alacrittyYmlTransform replaces an existing family or appends the font block', () => {
  assert.equal(
    alacrittyYmlTransform('font:\n  normal:\n    family: "Fira Code"\n'),
    'font:\n  normal:\n    family: "DSH TUI Nerd"\n',
    'existing family replaced',
  )
  assert.equal(
    alacrittyYmlTransform('window:\n  opacity: 0.9\n'),
    'window:\n  opacity: 0.9\nfont:\n  normal:\n    family: "DSH TUI Nerd"\n',
    'no font block → appended',
  )
})

test('weztermTransform swaps wezterm.font, keeps font_with_fallback primary, or appends', () => {
  assert.equal(
    weztermTransform('config.font = wezterm.font("Fira Code")\n'),
    'config.font = wezterm.font("DSH TUI Nerd")\n',
    'wezterm.font replaced',
  )
  assert.equal(
    weztermTransform('config.font = wezterm.font_with_fallback("Fira Code", "Menlo")\n'),
    'config.font = wezterm.font_with_fallback("DSH TUI Nerd", "Menlo")\n',
    'font_with_fallback: only the primary font is replaced, fallbacks survive',
  )
  assert.equal(
    weztermTransform("local wezterm = require('wezterm')\n"),
    "local wezterm = require('wezterm')\nconfig.font = wezterm.font(\"DSH TUI Nerd\")\n",
    'no font line → appended',
  )
})
