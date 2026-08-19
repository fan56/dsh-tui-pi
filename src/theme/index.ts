/**
 * Theme assembly: turns a GitHub Palette into the pi-tui theme objects
 * (EditorTheme / MarkdownTheme / SelectListTheme) plus our own chat and
 * powerline roles. The powerline segment palette is theme-agnostic — vivid
 * segment backgrounds carry their own white bold text on both themes.
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui'
import { detectDarkPalette, githubDark, githubLight, type Palette } from './palette.ts'

/** Truecolor ANSI foreground for a hex color. */
export function ansiFg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `\x1b[38;2;${r};${g};${b}m`
}

/** Truecolor ANSI background for a hex color. */
export function ansiBg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `\x1b[48;2;${r};${g};${b}m`
}

export const BOLD = '\x1b[1m'
export const RESET = '\x1b[0m'

/** Chat surface roles (our own component set, modeled on pi's theme JSON). */
export interface ChatTheme {
  userMessageBg: (text: string) => string
  userMessageText: (text: string) => string
  toolPendingBg: (text: string) => string
  toolSuccessBg: (text: string) => string
  toolErrorBg: (text: string) => string
  /** Background of the fixed-height thinking panel (header + body rows). */
  thinkingPanelBg: (text: string) => string
  /** Background of the tool card body rows. */
  toolBodyBg: (text: string) => string
  thinkingText: (text: string) => string
  todoDone: (text: string) => string
  todoOpen: (text: string) => string
}

/** Powerline footer segment backgrounds, ported from pi-powerline-footer. */
export interface ThinkingLevelColors {
  off: string
  minimal: string
  low: string
  medium: string
  high: string
  xhigh: string
  max: string
}

export const POWERLINE = {
  /** Fixed brand segment ("dsh") pinned to the footer's left edge. */
  brand: '#4D6BFE',
  provider: '#6A1B9A',
  thinking: {
    off: '#616161',
    minimal: '#78909C',
    low: '#5C6BC0',
    medium: '#42A5F5',
    high: '#26A69A',
    xhigh: '#FFA726',
    max: '#EF5350',
  } satisfies ThinkingLevelColors,
  contextOk: '#4CAF50',
  contextWarn: '#FFC107',
  contextOrange: '#FF9800',
  contextDanger: '#F44336',
  cache: '#00796B',
  messages: '#7B1FA2',
  tools: '#E64A19',
} as const

/** Complete theme bundle handed to the TUI. */
export interface TuiTheme {
  readonly palette: Palette
  readonly editor: EditorTheme
  readonly markdown: MarkdownTheme
  readonly selectList: SelectListTheme
  readonly chat: ChatTheme
}

/** Build a TuiTheme from a GitHub palette. */
export function buildTheme(palette: Palette): TuiTheme {
  const fg = (hex: string) => (text: string) => ansiFg(hex) + text + RESET
  const bg = (hex: string) => (text: string) => ansiBg(hex) + text + RESET
  const bold = (text: string) => BOLD + text + RESET

  // canvasSubtle backdrop behind every picker line. pi-tui 0.84.2 patched
  // (see patches/@earendil-works__pi-tui.patch): SelectList renderItem now
  // routes unselected rows through the optional `unselectedText` theme hook
  // (they used to be raw `prefix + value` with no theme call), so every
  // row — selected, unselected, description, scroll info — gets the
  // backdrop. Editor-inline slash autocomplete shares this selectList
  // theme, so its rows get the same full-row treatment.
  const selectList: SelectListTheme = {
    selectedPrefix: text => bg(palette.canvasSubtle)(fg(palette.accent)(bold(`▸ ${text}`))),
    selectedText: text => bg(palette.canvasSubtle)(fg(palette.fgDefault)(bold(text))),
    description: text => bg(palette.canvasSubtle)(fg(palette.fgSubtle)(text)),
    scrollInfo: text => bg(palette.canvasSubtle)(fg(palette.fgSubtle)(text)),
    noMatch: text => bg(palette.canvasSubtle)(fg(palette.danger)(text)),
    unselectedText: text => bg(palette.canvasSubtle)(fg(palette.fgDefault)(text)),
  }

  const editor: EditorTheme = {
    borderColor: fg(palette.borderDefault),
    // The editor's input rows are otherwise unstyled (terminal default
    // foreground), which is invisible on the app-painted dark canvas — theme
    // the typed text with the palette's body color (light text on dark).
    textColor: fg(palette.fgDefault),
    selectList,
  }

  const markdown: MarkdownTheme = {
    heading: text => fg(palette.fgDefault)(bold(text)),
    link: text => fg(palette.accent)(text),
    linkUrl: text => fg(palette.fgSubtle)(text),
    code: text => fg(palette.fgDefault)(bg(palette.canvasSubtle)(text)),
    codeBlock: text => fg(palette.fgDefault)(bg(palette.canvasSubtle)(text)),
    codeBlockBorder: text => fg(palette.borderDefault)(text),
    quote: text => fg(palette.fgMuted)(text),
    quoteBorder: text => fg(palette.borderDefault)(text),
    hr: text => fg(palette.borderDefault)(text),
    listBullet: text => fg(palette.accent)(text),
    bold,
    italic: text => `\x1b[3m${text}\x1b[0m`,
    strikethrough: text => `\x1b[9m${text}\x1b[0m`,
    underline: text => `\x1b[4m${text}\x1b[0m`,
    codeBlockIndent: '  ',
  }

  const chat: ChatTheme = {
    userMessageBg: bg(palette.canvasSubtle),
    // Foreground-only reset (\x1b[39m): the bubble's right padding is added
    // after the text and wrapped by userMessageBg, so a full \x1b[0m reset
    // here would drop that padding back to the canvas background. Resetting
    // only the foreground keeps the canvasSubtle backdrop across the row.
    userMessageText: text => ansiFg(palette.fgDefault) + text + '\x1b[39m',
    // Tool card surfaces share the blue tool surface; only the settle status
    // swaps the header tint (success green / error red).
    toolPendingBg: bg(palette.toolPanelBg),
    toolSuccessBg: bg(palette.successMuted),
    toolErrorBg: bg(palette.dangerMuted),
    // The thinking panel has its own purple surface, distinct from the blue
    // tool cards and the green-gray message bubbles.
    thinkingPanelBg: bg(palette.thinkingPanelBg),
    toolBodyBg: bg(palette.toolPanelBg),
    thinkingText: text => `\x1b[3m${fg(palette.thinking)(text)}\x1b[0m`,
    todoDone: text => fg(palette.success)(`☑ ${text}`),
    todoOpen: text => fg(palette.fgSubtle)(`☐ ${text}`),
  }

  return { palette, editor, markdown, selectList, chat }
}

export const lightTheme: TuiTheme = buildTheme(githubLight)
export const darkTheme: TuiTheme = buildTheme(githubDark)

/** Theme selection: 'auto' falls back to terminal detection. */
export type ThemePreference = 'auto' | 'light' | 'dark'

/**
 * Resolve the active theme bundle: the DSH_TUI_THEME env override wins, then
 * an explicit light/dark preference, then terminal detection for 'auto'.
 */
export function resolveTheme(
  env: NodeJS.ProcessEnv = process.env,
  preference: ThemePreference = 'auto',
): TuiTheme {
  if (env.DSH_TUI_THEME === 'light') return lightTheme
  if (env.DSH_TUI_THEME === 'dark') return darkTheme
  if (preference === 'light') return lightTheme
  if (preference === 'dark') return darkTheme
  return detectDarkPalette(env) ? darkTheme : lightTheme
}
