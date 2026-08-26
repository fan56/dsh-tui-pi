/**
 * Mouse tracking mode selection (`DSH_TUI_MOUSE`). dsh owns the terminal's
 * mouse modes instead of delegating to pi-tui's auto choice: pi-tui enables
 * all-motion tracking (`?1003h`) whenever it does not recognize the host as a
 * multiplexer, and its multiplexer probe (TMUX/ZELLIJ/STY/TERM prefix) does
 * not know cmux — so inside cmux every pointer movement is forwarded, and a
 * fast-moving pointer coalesces into one stdin chunk that escapes pi-tui's
 * single-sequence SGR parsers and lands in the editor as literal text.
 *
 * Button-motion mode (the default, and what pi-tui itself picks under
 * tmux/zellij/screen) keeps clicks, wheel, drag-selection, and scrollbar
 * dragging while sending no events for idle pointer movement.
 */

/** Terminal mouse modes dsh may enable; mirrors pi-tui 0.84.2's mode sets. */
export type MouseMode = 'buttons' | 'all' | 'off'

/** Environment variable selecting the mode; unset/invalid falls back to buttons. */
export const MOUSE_MODE_ENV = 'DSH_TUI_MOUSE'

/** `?1000h ?1002h ?1004h ?1006h` — press/release/wheel/drag, no idle motion. */
const ENABLE_BUTTONS = '\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h'
/** `?1000h ?1002h ?1003h ?1004h ?1006h` — adds any-motion tracking (`?1003h`). */
const ENABLE_ALL = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h'
/** Reverse of {@link ENABLE_BUTTONS}, in reverse mode order like pi-tui. */
const DISABLE_BUTTONS = '\x1b[?1006l\x1b[?1004l\x1b[?1002l\x1b[?1000l'
/** Reverse of {@link ENABLE_ALL}. */
const DISABLE_ALL = '\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l'

/**
 * Resolve the mouse mode from the environment. Unknown or empty values fall
 * back to `buttons` — an invalid value must never re-enable all-motion by
 * accident.
 */
export function resolveMouseMode(env: NodeJS.ProcessEnv = process.env): MouseMode {
  const raw = env[MOUSE_MODE_ENV]?.trim().toLowerCase()
  if (raw === 'all' || raw === 'buttons' || raw === 'off') return raw
  return 'buttons'
}

/** The DEC private-mode sequence enabling a mode (empty for `off`). */
export function mouseEnableSequence(mode: MouseMode): string {
  if (mode === 'buttons') return ENABLE_BUTTONS
  if (mode === 'all') return ENABLE_ALL
  return ''
}

/** The matching disable sequence (empty for `off`). */
export function mouseDisableSequence(mode: MouseMode): string {
  if (mode === 'buttons') return DISABLE_BUTTONS
  if (mode === 'all') return DISABLE_ALL
  return ''
}
