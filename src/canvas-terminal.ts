/**
 * Terminal write-stream decorator painting the canvas via BCE.
 *
 * pi-tui renders rows as `\x1b[{row};1H\x1b[2K{line}` and full redraws as
 * `\x1b[2J` — no background of their own. Terminals with BCE (back color
 * erase) fill erased regions with the current SGR background, so prefixing
 * the canvas background before every erase sequence paints the whole screen
 * without touching pi-tui. Rows the diff renderer skips keep the background
 * of their last paint, which is correct until the canvas color changes —
 * the caller must then force a full redraw (requestRender(true)).
 */

import type { Terminal } from '@earendil-works/pi-tui'

const ENTER_ALT_SCREEN = '\x1b[?1049h'
const EXIT_ALT_SCREEN = '\x1b[?1049l'

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
    // Injection happens only at erase-sequence boundaries; kitty image
    // payloads are APC base64/hex and never contain ESC bytes.
    this.inner.write(data
      .replaceAll('\x1b[2K', `${this.background}\x1b[2K`)
      .replaceAll('\x1b[2J', `${this.background}\x1b[2J`))
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
