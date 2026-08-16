/**
 * `/hotkeys` — view and customize the app-level keybindings.
 *
 * pi's convention is a `/hotkeys` command (full markdown table) plus a
 * user-editable `~/.pi/agent/keybindings.json`, applied with `/reload`.
 * dsh side: `$DSH_HOME/keybindings.json` (default `~/.dsh/keybindings.json`),
 * read at TUI startup and re-read by `/reload`. The file is a PARTIAL map of
 * the four app keys ({@link APP_KEY_FIELDS}) to pi-tui key ids; anything
 * missing falls back to the defaults (`src/keymap.ts`). Invalid entries are
 * skipped with a warning notice — a broken file never breaks the TUI.
 *
 * The decision logic stays in `keymap.ts` (pure); this module only owns the
 * file contract, the validation, the display table, and the panel component.
 */

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getKeybindings, type Component, type KeyId, type TUI } from '@earendil-works/pi-tui'
import { DEFAULT_KEYBINDINGS, type KeyBindings } from './keymap.ts'
import { wrapFramedOverlay } from './frame.ts'
import { ansiFg, BOLD, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'

/** The user-editable keybindings file name inside the dsh home. */
export const KEYBINDINGS_FILE = 'keybindings.json'

/** Absolute path of the keybindings file under a dsh home directory. */
export function keybindingsPath(home: string): string {
  return join(home, KEYBINDINGS_FILE)
}

/** The four app-level bindings the file may remap (order = display order). */
export const APP_KEY_FIELDS: readonly (keyof KeyBindings)[] = ['escape', 'ctrlC', 'ctrlD', 'modelPicker']

/** Action descriptions for the `/hotkeys` table. */
const KEY_ACTIONS: Record<keyof KeyBindings, string> = {
  escape: 'stop the current task',
  ctrlC: 'running: cancel turn · idle: clear editor · second press quits',
  ctrlD: 'quit — only on an empty editor',
  modelPicker: 'open the model / think picker',
}

// ------------------------------------------------------------- validation --

const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'super'])
const NAMED_KEYS = new Set([
  'escape', 'esc', 'enter', 'return', 'tab', 'space', 'backspace', 'delete',
  'insert', 'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left',
  'right', 'clear',
])

/**
 * Conservative check of one pi-tui key id as a user might type it:
 * `modifier+key` where every modifier is ctrl/shift/alt/super and the key is
 * a named key (`escape`, `pageUp`, `f5`, …) or a single printable character.
 * pi-tui's own `parseKeyId` is lenient (unknown ids just never match), so we
 * reject obvious typos up front and let a warning surface them.
 */
export function isValidKeyId(value: unknown): value is KeyId {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) return false
  const parts = value.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  if (key === '') return false
  for (const modifier of parts.slice(0, -1)) {
    if (!MODIFIERS.has(modifier)) return false
  }
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return true
  if (NAMED_KEYS.has(key)) return true
  return [...key].length === 1
}

/** Human display of a key id: `escape`→`Esc`, `ctrl+shift+p`→`Ctrl+Shift+P`. */
export function displayKey(id: KeyId): string {
  const parts = id.split('+')
  const modifiers = parts.slice(0, -1).map(m => m[0].toUpperCase() + m.slice(1))
  const last = parts[parts.length - 1]
  const key = last === 'escape' || last === 'esc'
    ? 'Esc'
    : last.length === 1
      ? last.toUpperCase()
      : last.charAt(0).toUpperCase() + last.slice(1)
  return [...modifiers, key].join('+')
}

// ------------------------------------------------------------------- load --

/** Result of reading the user keybindings file. */
export interface LoadedKeyBindings {
  /** Valid entries only; may be empty when the file is absent or broken. */
  bindings: Partial<KeyBindings>
  /** Human-readable problems (invalid entries, bad JSON) — shown as notices. */
  warnings: string[]
  /** Whether the file existed and parsed (a JSON object). */
  exists: boolean
}

const EMPTY: LoadedKeyBindings = { bindings: {}, warnings: [], exists: false }

/** Read + validate `$DSH_HOME/keybindings.json`. Never throws. */
export function loadKeyBindings(path: string): LoadedKeyBindings {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return EMPTY
  }
  const label = basename(path)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { bindings: {}, warnings: [`${label}: invalid JSON — ${(error as Error).message}`], exists: true }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { bindings: {}, warnings: [`${label}: expected a JSON object of app-key → key id`], exists: true }
  }
  const record = raw as Record<string, unknown>
  const bindings: Partial<KeyBindings> = {}
  const warnings: string[] = []
  for (const field of APP_KEY_FIELDS) {
    const value = record[field]
    if (value === undefined) continue
    if (!isValidKeyId(value)) {
      warnings.push(`${label}: "${field}" = ${JSON.stringify(value)} is not a valid key id — keeping the default`)
    } else {
      bindings[field] = value
    }
  }
  for (const field of Object.keys(record)) {
    if (!(APP_KEY_FIELDS as readonly string[]).includes(field)) {
      warnings.push(`${label}: unknown field "${field}" — ignored`)
    }
  }
  return { bindings, warnings, exists: true }
}

// --------------------------------------------------------------- the table --

/** One row of the `/hotkeys` table. */
export interface HotkeyRow {
  /** Display key text (custom override reflected). */
  key: string
  /** What the key does. */
  action: string
  /** True when the key comes from the user's keybindings file. */
  custom: boolean
}

/**
 * Build the app-key rows from the effective bindings — defaults, with any
 * file override replacing the key display and flagging the row as custom.
 * Pure, so the table content is unit-testable without a terminal.
 */
export function appHotkeyRows(custom: Partial<KeyBindings>): HotkeyRow[] {
  const rows: HotkeyRow[] = []
  for (const field of APP_KEY_FIELDS) {
    const override = custom[field]
    rows.push({
      key: displayKey(override ?? DEFAULT_KEYBINDINGS[field]),
      action: KEY_ACTIONS[field],
      custom: override !== undefined,
    })
  }
  rows.push({ key: 'Enter', action: 'send the prompt', custom: false })
  rows.push({ key: 'Tab', action: 'autocomplete', custom: false })
  return rows
}

// ------------------------------------------------------------------ panel --

/** Everything the `/hotkeys` overlay renders. */
export interface HotkeysPanelData {
  /** Absolute path of the user keybindings file. */
  filePath: string
  /** Whether a custom file is active. */
  fileExists: boolean
  /** Load/validation problems to surface in the panel. */
  warnings: readonly string[]
  /** The app-key rows (defaults + overrides). */
  rows: readonly HotkeyRow[]
}

/** Width of the key column in the table (fits Ctrl+Shift+PageUp). */
const KEY_COLUMN_WIDTH = 17

/**
 * One-shot read-only panel; Esc/Enter hides the overlay and resolves.
 * Mirrors the `/session` info panel: rows clipped to the framed content
 * width, the file status + editor-keys summary at the bottom.
 */
class HotkeysPanel implements Component {
  private readonly theme: TuiTheme
  private readonly data: HotkeysPanelData
  private readonly onClose: () => void

  constructor(theme: TuiTheme, data: HotkeysPanelData, onClose: () => void) {
    this.theme = theme
    this.data = data
    this.onClose = onClose
  }

  invalidate(): void {}

  render(width: number): string[] {
    const fg = (hex: string) => (text: string) => ansiFg(hex) + text + RESET
    const p = this.theme.palette
    const lines: string[] = [
      fg(p.accent)(BOLD + '⚙ hotkeys' + RESET),
      '',
    ]
    // Table header.
    lines.push(fg(p.fgSubtle)('key'.padEnd(KEY_COLUMN_WIDTH)) + fg(p.fgSubtle)('action'))
    // Separator under the header, full width.
    const max = Math.max(4, width - KEY_COLUMN_WIDTH - 2)
    const clip = (text: string): string => clipToWidth(text, max)
    lines.push(fg(p.borderDefault)('─'.repeat(Math.min(width - 1, KEY_COLUMN_WIDTH + max + 1))))
    for (const row of this.data.rows) {
      // Pad the PLAIN key text first, then style — padEnd on ANSI-styled
      // text would count the SGR escapes as visible columns (same rule as
      // the /session panel; see AGENTS.md iron rule 3).
      const keyText = row.custom
        ? row.key.padEnd(KEY_COLUMN_WIDTH - 1) + '*'
        : row.key.padEnd(KEY_COLUMN_WIDTH)
      const styledKey = row.custom
        ? fg(p.accent)(BOLD + keyText + RESET)
        : fg(p.accent)(keyText)
      lines.push(styledKey + fg(p.fgDefault)(clip(row.action)))
    }
    // Custom file status + warnings.
    lines.push('')
    const fileLabel = this.data.fileExists
      ? fg(p.fgMuted)('custom:') + fg(p.fgDefault)(' ' + this.data.filePath)
      : fg(p.fgSubtle)(`custom: ${this.data.filePath} (not found — defaults in use)`)
    lines.push(clipToWidth(fileLabel, Math.max(20, width - 1)))
    for (const warning of this.data.warnings) {
      lines.push(clipToWidth(fg('#d1242f')('! ' + warning), Math.max(20, width - 1)))
    }
    // Editor keys come from pi-tui itself — one line, not a row per key.
    lines.push('')
    lines.push(clipToWidth(
      fg(p.fgSubtle)('editor: pi-tui defaults — arrows · Ctrl+B/F · Alt+←→ word · Home/End · Ctrl+W/U/K delete · Ctrl+- undo · Shift+Enter newline'),
      Math.max(20, width - 1),
    ))
    lines.push('')
    lines.push(clipToWidth(
      fg(p.fgSubtle)(`edit ${this.data.filePath} then /reload to apply — Esc to close`),
      Math.max(20, width - 1),
    ))
    return lines
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, 'tui.select.cancel') || getKeybindings().matches(data, 'tui.select.confirm')) {
      this.onClose()
    }
  }
}

/**
 * Open the `/hotkeys` panel; resolves when the user closes it. Focus returns
 * to `restoreFocus` on close (re-focus the CURRENT editor instance — it is
 * rebuilt on theme hot-swap, so a stale reference would swallow input).
 */
export function showHotkeysPanel(
  tui: TUI,
  theme: TuiTheme,
  data: HotkeysPanelData,
  restoreFocus: () => void,
): Promise<void> {
  return new Promise(resolve => {
    const panel = new HotkeysPanel(theme, data, () => {
      overlay.hide()
      restoreFocus()
      resolve()
    })
    const overlay = tui.showOverlay(wrapFramedOverlay(theme, panel), { width: '78%', maxHeight: '100%' })
  })
}