/**
 * Terminal write-stream decorator painting the canvas via BCE.
 *
 * pi-tui renders rows as `\x1b[{row};1H\x1b[2K{line}` and full redraws as
 * `\x1b[2J` — no background of their own. Injections make the whole screen
 * carry the theme colors without touching pi-tui:
 *
 * 1. Before every erase sequence (`\x1b[2K`/`\x1b[2J`): terminals with BCE
 *    (back color erase) fill the erased region with the current SGR
 *    background, painting row tails the erase never reaches.
 * 2. After every color-clearing SGR reset (`\x1b[0m`, `\x1b[m`,
 *    `\x1b[0;…m`, `\x1b[39m`, `\x1b[49m`): content following a reset would
 *    otherwise print with the terminal default colors, punching holes into
 *    the canvas — most visibly the editor input and unselected picker rows
 *    falling back to the terminal's default FOREGROUND, which is dark text
 *    when the host terminal is light-themed (pi itself never paints a
 *    canvas, so its unstyled text always matches; we paint, so we must own
 *    both channels). Re-injecting restores the canvas; spans that set their
 *    own colors still override it.
 *
 * Rows the diff renderer skips keep the colors of their last paint, which
 * is correct until the canvas changes — the caller must then force a full
 * redraw (requestRender(true)).
 */

import type { Terminal } from '@earendil-works/pi-tui'

const ENTER_ALT_SCREEN = '\x1b[?1049h'
const EXIT_ALT_SCREEN = '\x1b[?1049l'
const SGR = /\x1b\[([0-9;]*)m/g

/**
 * Which color channels an SGR parameter list resets to the terminal
 * default: full resets (`\x1b[0m`, `\x1b[m`, `\x1b[0;…m`) clear both,
 * `\x1b[39m`/`\x1b[49m` clear one each. Color-set parameters are skipped
 * so a 0 channel (`\x1b[48;2;0;121;107m`, `\x1b[38;5;0m`) never reads as
 * a reset — treating those as clears would paint over intentional
 * surfaces.
 */
function sgrClears(params: string): { bg: boolean; fg: boolean } {
  if (params === '') return { bg: true, fg: true }
  const p = params.split(';')
  let bg = false
  let fg = false
  for (let i = 0; i < p.length; i++) {
    const token = p[i]
    if (token === '0' || token === '') {
      bg = true
      fg = true
    } else if (token === '39') {
      fg = true
    } else if (token === '49') {
      bg = true
    } else if (token === '38' || token === '48') {
      // Skip the color spec (5;n or 2;r;g;b, plus legacy 3;/4; forms).
      if (p[i + 1] === '5') i += 2
      else if (p[i + 1] === '2') i += 4
      else if (p[i + 1] === '3' || p[i + 1] === '4') i += 1
    }
  }
  return { bg, fg }
}

export class CanvasTerminal implements Terminal {
  /** '' = transparent passthrough (DSH_TUI_TRANSPARENT). */
  private background = ''
  private foreground = ''
  /** False once the alt-screen exit sequence is seen — the main-screen document dump that follows stays unpainted. */
  private active = true
  private readonly inner: Terminal

  constructor(inner: Terminal) {
    this.inner = inner
  }

  /** Set the canvas background SGR; undefined reverts to transparent. */
  setCanvasBackground(bg: string | undefined): void {
    this.background = bg ?? ''
  }

  /** Set the canvas foreground SGR (the app's default text color); undefined disables. */
  setCanvasForeground(fg: string | undefined): void {
    this.foreground = fg ?? ''
  }

  write(data: string): void {
    if (data.includes(EXIT_ALT_SCREEN)) {
      // The exit buffer starts with EXIT_ALT_SCREEN; write it (and anything
      // after, until the next enter) unchanged so quitting leaves no themed
      // background behind on the shell.
      this.active = false
      this.inner.write(data)
      return
    }
    if (data.includes(ENTER_ALT_SCREEN)) this.active = true
    if ((this.background === '' && this.foreground === '') || !this.active) {
      this.inner.write(data)
      return
    }
    // Injection happens only at erase-sequence boundaries and after
    // color-clearing resets; kitty image payloads are APC base64/hex and
    // never contain ESC bytes.
    const bg = this.background
    const fg = this.foreground
    this.inner.write(data
      .replaceAll('\x1b[2K', `${bg}\x1b[2K`)
      .replaceAll('\x1b[2J', `${bg}\x1b[2J`)
      .replace(SGR, (seq, params: string) => {
        const clears = sgrClears(params)
        return seq + (clears.bg ? bg : '') + (clears.fg ? fg : '')
      }))
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inner.start(onInput, onResize)
  }

  stop(): void {
    this.inner.stop()
  }

  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.inner.drainInput(maxMs, idleMs)
  }

  get columns(): number {
    return this.inner.columns
  }

  get rows(): number {
    return this.inner.rows
  }

  get kittyProtocolActive(): boolean {
    return this.inner.kittyProtocolActive
  }

  moveBy(lines: number): void {
    this.inner.moveBy(lines)
  }

  hideCursor(): void {
    this.inner.hideCursor()
  }

  showCursor(): void {
    this.inner.showCursor()
  }

  clearLine(): void {
    this.inner.clearLine()
  }

  clearFromCursor(): void {
    this.inner.clearFromCursor()
  }

  clearScreen(): void {
    this.inner.clearScreen()
  }

  setTitle(title: string): void {
    this.inner.setTitle(title)
  }

  setProgress(active: boolean): void {
    this.inner.setProgress(active)
  }
}
