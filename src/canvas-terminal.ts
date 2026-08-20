/**
 * Terminal write-stream decorator painting the canvas via BCE.
 *
 * pi-tui renders rows as `\x1b[{row};1H\x1b[2K{line}` and full redraws as
 * `\x1b[2J` — no background of their own. Two injections make the whole
 * screen carry the theme canvas color without touching pi-tui:
 *
 * 1. Before every erase sequence (`\x1b[2K`/`\x1b[2J`): terminals with BCE
 *    (back color erase) fill the erased region with the current SGR
 *    background, painting row tails the erase never reaches.
 * 2. After every background-clearing SGR reset (`\x1b[0m`, `\x1b[m`,
 *    `\x1b[0;…m`, `\x1b[49m`): content following a reset would otherwise
 *    print with the terminal default background, punching holes into the
 *    canvas (invisible with a dark theme on a dark terminal, glaring after
 *    a switch to light). Re-injecting restores the canvas so every printed
 *    cell keeps it; spans that set their own background still override it.
 *
 * Rows the diff renderer skips keep the background of their last paint,
 * which is correct until the canvas color changes — the caller must then
 * force a full redraw (requestRender(true)).
 */

import type { Terminal } from '@earendil-works/pi-tui'

const ENTER_ALT_SCREEN = '\x1b[?1049h'
const EXIT_ALT_SCREEN = '\x1b[?1049l'
const SGR = /\x1b\[([0-9;]*)m/g

/**
 * Whether an SGR sequence clears the background: the full reset forms
 * (`\x1b[0m`, `\x1b[m`, `\x1b[0;…m` combined resets) and the explicit
 * background-default (`\x1b[49m`). Color-set sequences whose parameter list
 * merely contains a 0 channel (`\x1b[38;5;0m`, `\x1b[48;2;0;121;107m`) do
 * NOT clear — treating them as resets paints over intentional surfaces.
 */
function clearsBackground(params: string): boolean {
  if (params === '' || params === '49') return true
  return params.split(';', 1)[0] === '0'
}

export class CanvasTerminal implements Terminal {
  /** '' = transparent passthrough (DSH_TUI_TRANSPARENT). */
  private background = ''
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
    if (this.background === '' || !this.active) {
      this.inner.write(data)
      return
    }
    // Injection happens only at erase-sequence boundaries and after
    // background-clearing resets; kitty image payloads are APC base64/hex
    // and never contain ESC bytes.
    const bg = this.background
    this.inner.write(data
      .replaceAll('\x1b[2K', `${bg}\x1b[2K`)
      .replaceAll('\x1b[2J', `${bg}\x1b[2J`)
      .replace(SGR, (seq, params: string) => (clearsBackground(params) ? seq + bg : seq)))
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
