#!/usr/bin/env node
/**
 * Install the bundled terminal font and point the user's terminal at it.
 *
 * The TUI's icon-set self-adaptation (src/icons.ts) resolves 'auto' to the
 * powerline glyphs only when a Nerd/Powerline-capable font is the terminal's
 * MAIN font — no default terminal font ships the powerline separator U+E0B0,
 * so without one 'auto' falls back to the plain Unicode stand-ins. This
 * script installs the tiny bundled subset (assets/fonts/dsh-tui-pi-nerd.ttf,
 * ASCII + U+E0B0 + the whole project glyph set, ~170KB) and flips the
 * terminal to it, preserving the current font size where the terminal
 * expresses one.
 *
 * Zero dependencies and fully best-effort: every step is wrapped in
 * try/catch — a failure logs a warning and the script moves on. It never
 * aborts mid-way and never corrupts user configuration (config files are
 * backed up before editing and restored on failure; preferences are only
 * written through PlistBuddy/gsettings/defaults with the original value
 * read first).
 *
 *   - Font install
 *       macOS  → cp → ~/Library/Fonts/        (physical copy, never a symlink)
 *       Linux  → cp → ~/.local/share/fonts/ + fc-cache -f
 *       other  → skipped (no free font directory)
 *
 *   - Terminal config (best-effort, per platform/terminal)
 *       macOS iTerm2        → PlistBuddy against the Default Bookmark's
 *                             "Normal Font" (PostScript name DSHTUINerd,
 *                             keeping the current size); `defaults write
 *                             com.googlecode.iterm2 "Normal Font"` as an
 *                             extra best-effort key.
 *       macOS Terminal.app  → skipped — its font is a binary blob in the
 *                             plist; set it by hand (Settings → Profiles →
 *                             Text → Font).
 *       Linux GNOME Terminal → gsettings set use-system-font=false + font on
 *                             the default profile.
 *       Linux kitty / alacritty / wezterm → edit the config file
 *                             (font_family / [font] family / wezterm.font),
 *                             backing the file up first and restoring on
 *                             failure.
 *       SSH / xterm / urxvt / unknown / Windows → skipped (no safe write).
 *
 * Usage:  node scripts/install-font.mjs
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const FONT_SRC = join(repoRoot, 'assets', 'fonts', 'dsh-tui-pi-nerd.ttf')
const FONT_FILE = 'dsh-tui-pi-nerd.ttf'
/** Family name (font nameID 1) — GNOME/kitty/alacritty/wezterm use this. */
const FONT_FAMILY = 'DSH TUI Nerd'
/** PostScript name (font nameID 6) — iTerm2's "Normal Font" key uses this. */
const FONT_POSTSCRIPT = 'DSHTUINerd'

/**
 * The install environment — the real platform/home by default, injected by
 * tests (test scripts point it at a sandbox home / a fake platform to drive
 * the copy + config paths without touching the real home).
 */
export const env = {
  platform: process.platform,
  home: homedir(),
}

const PLISTBUDDY = '/usr/libexec/PlistBuddy'

const log = {
  info: (msg) => console.log(`[install-font] ${msg}`),
  ok: (msg) => console.log(`[install-font] ✓ ${msg}`),
  warn: (msg) => console.warn(`[install-font] ! ${msg}`),
}

/** Run a command; `null` on failure (missing binary, nonzero exit). */
export function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** True when the script runs inside an SSH session (terminal config would hit the remote). */
function isSsh() {
  return Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY)
}

// ------------------------------------------------------------- font install --

/** Copy the bundled font into the platform font directory; false when skipped. */
export function installFont() {
  if (env.platform === 'darwin') {
    const dir = join(env.home, 'Library', 'Fonts')
    mkdirSync(dir, { recursive: true })
    copyFileSync(FONT_SRC, join(dir, FONT_FILE))
    return dir
  }
  if (env.platform === 'linux') {
    const dir = join(env.home, '.local', 'share', 'fonts')
    mkdirSync(dir, { recursive: true })
    copyFileSync(FONT_SRC, join(dir, FONT_FILE))
    // Refresh the fontconfig cache so the family resolves immediately.
    const refreshed = sh('fc-cache', ['-f', dir])
    if (refreshed === null) log.warn('fc-cache refresh skipped (fc-cache not found)')
    return dir
  }
  log.warn(`font install skipped on ${env.platform} (no free font directory; copy ${FONT_FILE} by hand)`)
  return null
}

// --------------------------------------------------------- config file edit --

/** Edit a text config file under a backup; restore on failure. Returns true when changed. */
function editConfigWithBackup(path, transform) {
  if (!existsSync(path)) return false
  const backup = `${path}.dsh-tui.bak`
  try {
    if (!existsSync(backup)) copyFileSync(path, backup)
    const changed = transform(readFileSync(path, 'utf8'))
    if (changed === null) return false
    writeFileSync(path, changed)
    return true
  } catch (error) {
    // Restore the original so a botched edit never leaves a broken config.
    try { copyFileSync(backup, path) } catch { /* best effort */ }
    throw error
  }
}

/** kitty: `font_family` (replace the existing line, or append one). */
export function kittyTransform(text) {
  const line = `font_family ${FONT_FAMILY}`
  if (/^\s*font_family\b/m.test(text)) return text.replace(/^\s*font_family\s+.*$/m, line)
  return `${text.replace(/\s*$/, '')}\n${line}\n`
}

/** alacritty (TOML): `family = "…"` under `[font]`; append a `[font.normal]` block when absent. */
export function alacrittyTomlTransform(text) {
  if (text.includes('[font')) {
    if (/^\s*family\s*=/m.test(text)) return text.replace(/^(\s*family\s*=\s*")[^"]*(".*)$/m, `$1${FONT_FAMILY}$2`)
    return `${text.replace(/\s*$/, '')}\n[font.normal]\nfamily = "${FONT_FAMILY}"\n`
  }
  return `${text.replace(/\s*$/, '')}\n[font.normal]\nfamily = "${FONT_FAMILY}"\n`
}

/** alacritty (legacy YAML): `family: "…"` under `font: normal:`; append otherwise. */
export function alacrittyYmlTransform(text) {
  if (/^font:\s*\n(\s*)normal:\s*\n\s*family:/m.test(text)) {
    return text.replace(/^(font:\s*\n\s*normal:\s*\n\s*family:).*$/m, `$1 "${FONT_FAMILY}"`)
  }
  return `${text.replace(/\s*$/, '')}\nfont:\n  normal:\n    family: "${FONT_FAMILY}"\n`
}

/** wezterm: replace `wezterm.font("…")` calls / `config.font`, or append a font line. */
export function weztermTransform(text) {
  // wezterm.font_with_fallback("Primary", "Fallback", …) — replace only the
  // primary font so the user's fallback list survives.
  if (/wezterm\.font_with_fallback\(\s*"[^"]*"/.test(text)) {
    return text.replace(/wezterm\.font_with_fallback\(\s*"[^"]*"/g, `wezterm.font_with_fallback("${FONT_FAMILY}"`)
  }
  if (/wezterm\.font\(\s*"[^"]*"\s*\)/.test(text)) {
    return text.replace(/wezterm\.font\(\s*"[^"]*"\s*\)/g, `wezterm.font("${FONT_FAMILY}")`)
  }
  const append = `config.font = wezterm.font("${FONT_FAMILY}")`
  if (/^\s*config\.font\s*=/m.test(text)) return text.replace(/^\s*config\.font\s*=.*$/m, append)
  return `${text.replace(/\s*$/, '')}\n${append}\n`
}

// ------------------------------------------------------------- iTerm2 (mac) --

/** PlistBuddy read of one key; `null` when the key/file is absent. */
function pbGet(plist, key) {
  return sh(PLISTBUDDY, ['-c', `Print :${key}`, plist])
}

/** The trailing font-size number of an iTerm2 "Normal Font" value ("Menlo-Regular 13" → "13"). */
export function parseFontSize(value) {
  const match = value === null ? null : value.match(/(\d+(?:\.\d+)?)\s*$/)
  return match === null ? '12' : match[1]
}

/** macOS iTerm2: point the default bookmark's "Normal Font" at the bundled font. */
export function configureIterm2() {
  const plist = join(env.home, 'Library', 'Preferences', 'com.googlecode.iterm2.plist')
  if (!existsSync(plist)) return 'iTerm2 plist not found (start iTerm2 once, then re-run)'
  // PlistBuddy paths: keys with spaces MUST be quoted (`:"New Bookmarks"`).
  const guid = pbGet(plist, '"Default Bookmark Guid"')
  if (guid === null) return 'no Default Bookmark Guid in the iTerm2 plist'
  // Find the bookmark index carrying the default guid (bounded scan).
  let index = -1
  for (let i = 0; i < 128; i++) {
    const candidate = pbGet(plist, `"New Bookmarks":${i}:Guid`)
    if (candidate === null) break
    if (candidate === guid) { index = i; break }
  }
  if (index < 0) return `default bookmark (${guid}) not found in New Bookmarks`
  const size = parseFontSize(pbGet(plist, `"New Bookmarks":${index}:"Normal Font"`))
  const value = `${FONT_POSTSCRIPT} ${size}`
  // Prefer a targeted write on the default bookmark; a direct `defaults write`
  // of the legacy "Normal Font" key is a harmless best-effort extra.
  const pb = sh(PLISTBUDDY, ['-c', `Set :"New Bookmarks":${index}:"Normal Font" "${value}"`, plist])
  const dw = sh('defaults', ['write', 'com.googlecode.iterm2', 'Normal Font', '-string', value])
  if (pb === null && dw === null) return `could not write iTerm2 "Normal Font" (${value})`
  return `iTerm2 default bookmark → "${value}" (size preserved)`
}

// ------------------------------------------------------ GNOME Terminal (linux) --

/** Strip the surrounding quotes gsettings wraps string values in (`'Ubuntu Mono 11'`). */
function unquote(value) {
  return value === null ? null : value.replace(/^'|'$/g, '')
}

/**
 * The font size to preserve when switching a GNOME Terminal profile to the
 * bundled font — the font actually in use: the profile's `font` while
 * `use-system-font` is false, else the desktop monospace font. Raw gsettings
 * string values (possibly null / quoted) in, a numeric size string out, '12'
 * fallback when nothing readable.
 */
export function gnomeSizeToPreserve(useSystemFont, profileFont, desktopMono) {
  if (useSystemFont === 'true') return parseFontSize(unquote(desktopMono))
  return parseFontSize(unquote(profileFont))
}

/** Linux GNOME Terminal: switch the default profile off system font + set ours. */
export function configureGnomeTerminal() {
  const profileId = sh('gsettings', ['get', 'org.gnome.Terminal.ProfilesList', 'default'])
  if (profileId === null) return 'gsettings not available (no GNOME Terminal?)'
  const id = profileId.replace(/^'|'$/g, '')
  if (id === '') return 'no default GNOME Terminal profile'
  const base = `org.gnome.Terminal.Legacy.Profile:/org/gnome/terminal/legacy/profiles:/:${id}/`
  // Preserve the current font size: read the font in use before flipping
  // use-system-font off, then backfill our family at that size.
  const size = gnomeSizeToPreserve(
    sh('gsettings', ['get', base, 'use-system-font']),
    sh('gsettings', ['get', base, 'font']),
    sh('gsettings', ['get', 'org.gnome.desktop.interface', 'monospace-font-name']),
  )
  const s1 = sh('gsettings', ['set', base, 'use-system-font', 'false'])
  const s2 = sh('gsettings', ['set', base, 'font', `${FONT_FAMILY} ${size}`])
  if (s1 === null || s2 === null) return `gsettings write failed for profile ${id}`
  return `GNOME Terminal profile ${id} → "${FONT_FAMILY} ${size}" (use-system-font off)`
}

// ------------------------------------------------------ linux config terminals --

/** Linux kitty/alacritty/wezterm: edit the detected config files (best-effort). */
export function configureLinuxConfigFiles() {
  const candidates = [
    [join(env.home, '.config', 'kitty', 'kitty.conf'), kittyTransform, 'kitty'],
    [join(env.home, '.config', 'alacritty', 'alacritty.toml'), alacrittyTomlTransform, 'alacritty'],
    [join(env.home, '.config', 'alacritty', 'alacritty.yml'), alacrittyYmlTransform, 'alacritty'],
    [join(env.home, '.config', 'wezterm', 'wezterm.lua'), weztermTransform, 'wezterm'],
  ]
  const changed = []
  for (const [path, transform, name] of candidates) {
    if (!existsSync(path)) continue
    try {
      if (editConfigWithBackup(path, transform)) changed.push(`${name} (${path})`)
    } catch (error) {
      log.warn(`${name} config edit failed (${path} restored): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return changed
}

// --------------------------------------------------------------- dispatcher --

/** Best-effort per-platform terminal configuration; returns the summary line. */
export function configureTerminal() {
  if (isSsh()) {
    log.warn('SSH session detected — skipping terminal config (set the font in the local terminal)')
    return null
  }
  if (env.platform === 'darwin') {
    const result = (() => { try { return configureIterm2() } catch (error) { return `iTerm2 config failed: ${error instanceof Error ? error.message : String(error)}` } })()
    log.ok(result)
    log.warn('Terminal.app is not supported (its font is a binary blob) — set it in Settings → Profiles → Text')
    return result
  }
  if (env.platform === 'linux') {
    const gnome = (() => { try { return configureGnomeTerminal() } catch (error) { return `GNOME Terminal config failed: ${error instanceof Error ? error.message : String(error)}` } })()
    log.ok(gnome)
    const changed = configureLinuxConfigFiles()
    if (changed.length === 0) log.warn('no kitty/alacritty/wezterm config file found to edit')
    for (const entry of changed) log.ok(`config updated: ${entry}`)
    return `${gnome}${changed.length > 0 ? `; ${changed.length} config file(s) updated` : ''}`
  }
  log.warn(`terminal config not supported on ${env.platform} (xterm/urxvt/Windows) — set the font by hand`)
  return null
}

// ------------------------------------------------------------------- main --

function main() {
  log.info('dsh-tui-pi font installer (icon-set "auto" needs a Nerd/Powerline font)')
  if (!existsSync(FONT_SRC)) {
    log.warn(`bundled font not found: ${FONT_SRC}`)
    log.warn('generate it first with: node assets/fonts-gen.mjs')
    return
  }

  let installDir = null
  try {
    installDir = installFont()
    if (installDir !== null) log.ok(`installed ${FONT_FILE} → ${installDir}`)
  } catch (error) {
    log.warn(`font install failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const summary = installDir !== null ? configureTerminal() : null

  log.info('--- result ---')
  log.info(installDir !== null
    ? `font installed: ${FONT_FILE} (${FONT_FAMILY} / ${FONT_POSTSCRIPT})`
    : 'font NOT installed — see the warnings above')
  log.info(summary !== null ? `terminal config: ${summary}` : 'terminal config: skipped — see the notes above')
  log.info('restart the terminal (or open a new tab) — auto icon-set now resolves to the powerline glyphs')
}

// Run directly (`node scripts/install-font.mjs`); importable for tests otherwise.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
