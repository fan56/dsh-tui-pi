/**
 * `/hotkeys` — view and customize the app-level keybindings, in the /agents
 * select-panel style (src/panels.ts).
 *
 * pi's convention is a `/hotkeys` command plus a user-editable
 * `~/.pi/agent/keybindings.json`. dsh side: `$DSH_HOME/keybindings.json`
 * (default `~/.dsh/keybindings.json`). The file is a PARTIAL map of the four
 * app keys ({@link APP_KEY_FIELDS}) to pi-tui key ids; anything missing falls
 * back to the defaults (`src/keymap.ts`).
 *
 * UI (mirrors `/agents`): a FieldPanel lists the app keys — binding, custom
 * star, action, file path + warnings; Enter opens an EditField to type a new
 * key id (empty input resets the key to its default). A commit writes the
 * file AND live-applies the new bindings to the running TUI (no /reload
 * needed). Invalid entries never block: they warn and keep the default.
 *
 * The decision logic stays in `keymap.ts` (pure); this module owns the file
 * contract, the validation, the display table and the interactive flow.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { KeyId, TUI } from '@earendil-works/pi-tui'
import { DEFAULT_KEYBINDINGS, type KeyBindings } from './keymap.ts'
import { FieldPanel, PanelHost } from './panels.ts'
import { EditField, type CommitResult, type ParseOutcome } from './settings.ts'
import { ansiFg, BOLD, RESET, type TuiTheme } from './theme/index.ts'

/** The user-editable keybindings file name inside the dsh home. */
export const KEYBINDINGS_FILE = 'keybindings.json'

/** Absolute path of the keybindings file under a dsh home directory. */
export function keybindingsPath(home: string): string {
  return join(home, KEYBINDINGS_FILE)
}

/** The six app-level bindings the file may remap (order = display order). */
export const APP_KEY_FIELDS: readonly (keyof KeyBindings)[] = ['escape', 'ctrlC', 'ctrlD', 'modelPicker', 'subagentViewer', 'presetCycle']

/** Action descriptions for the `/hotkeys` table. */
const KEY_ACTIONS: Record<keyof KeyBindings, string> = {
  escape: 'stop the current task — requires two presses (1st arms, 2nd within 500ms fires)',
  ctrlC: 'running: cancel turn · idle: clear editor · second press quits',
  ctrlD: 'quit — only on an empty editor',
  modelPicker: 'open the model / think picker',
  subagentViewer: 'open the subagent picker / viewer',
  presetCycle: 'cycle through agent presets',
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

/**
 * Merge-write the keybindings file: each `[field, value]` sets a binding,
 * `null` removes it (reset to default). Unknown fields already in the file
 * are preserved (the user's other keys survive). Missing file → fresh object;
 * an unreadable/broken EXISTING file is an error — never clobbered silently.
 * Returns an error message, or `undefined` on success.
 */
export function updateKeyBindingsFile(
  path: string,
  updates: ReadonlyArray<readonly [keyof KeyBindings, KeyId | null]>,
): string | undefined {
  const label = basename(path)
  const existing: Record<string, unknown> = {}
  let fileExisted = false
  try {
    const text = readFileSync(path, 'utf8')
    fileExisted = true
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return `${label}: expected a JSON object — fix or delete the file, then retry`
    }
    Object.assign(existing, parsed)
  } catch (error) {
    if (fileExisted) return `${label}: ${(error as Error).message} — fix or delete the file, then retry`
    // Absent file: start fresh.
  }
  for (const [field, value] of updates) {
    if (value === null) delete existing[field]
    else existing[field] = value
  }
  try {
    writeFileSync(path, JSON.stringify(existing, null, 2) + '\n')
  } catch (error) {
    return `${label}: cannot write — ${(error as Error).message}`
  }
  return undefined
}

/** The `/hotkeys` EditField parse: empty = reset, else a validated key id. */
export function parseKeyInput(text: string): ParseOutcome {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'unset' }
  if (!isValidKeyId(trimmed)) {
    return { kind: 'error', error: `not a key id — ctrl/shift/alt/super + key (e.g. ctrl+x, f5, escape)` }
  }
  return { kind: 'value', value: trimmed }
}

// --------------------------------------------------------------- the table --

/** One row of the `/hotkeys` table. */
export interface HotkeyRow {
  /** The app-key field this row edits. */
  field: keyof KeyBindings
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
  return APP_KEY_FIELDS.map(field => {
    const override = custom[field]
    return {
      field,
      key: displayKey(override ?? DEFAULT_KEYBINDINGS[field]),
      action: KEY_ACTIONS[field],
      custom: override !== undefined,
    }
  })
}

// ------------------------------------------------------------- the manager --

/** Options for the `/hotkeys` interactive flow. */
export interface HotkeysManagerOptions {
  /** Absolute path of the user keybindings file. */
  filePath: string
  /** Live-apply new bindings to the running TUI (called after every write). */
  apply: (bindings: Partial<KeyBindings>) => void
  /** Re-focus the CURRENT editor instance on close. */
  restoreFocus: () => void
}

/**
 * Open the `/hotkeys` manager: a FieldPanel of the five app keys (binding,
 * custom star, action, file status + warnings), Enter opens an EditField that
 * writes the file and live-applies the change. Resolves with a summary when
 * the user changed something and closed, or `undefined` when nothing changed.
 */
export async function openHotkeysManager(
  tui: TUI,
  theme: TuiTheme,
  options: HotkeysManagerOptions,
): Promise<string | undefined> {
  let changed = false
  /** Live status line of the FieldPanel (last commit result). */
  let status: string | undefined
  /** Settles the manager promise (assigned inside the executor below). */
  let settle: ((value: string | undefined) => void) | undefined

  const host = new PanelHost(tui, theme, message => {
    options.restoreFocus()
    settle?.(`✘ failed to open the hotkeys view: ${message}`)
  })

  /** Re-read the file after a write and push the change into the running TUI. */
  const applyBindings = (): void => {
    const loaded = loadKeyBindings(options.filePath)
    options.apply(loaded.bindings)
  }

  /** Rebuild the field panel from the current file state. */
  const show = (): void => {
    const loaded = loadKeyBindings(options.filePath)
    const fields = appHotkeyRows(loaded.bindings).map(row => ({
      key: row.field,
      value: `${row.key}${row.custom ? '*' : ''} — ${row.action}`,
      editable: true,
    }))
    const customCount = Object.keys(loaded.bindings).length
    const content: string[] = [
      loaded.exists
        ? `custom: ${options.filePath} (${customCount} override${customCount === 1 ? '' : 's'})`
        : `custom: ${options.filePath} (not found — defaults in use)`,
      'format: ctrl/shift/alt/super+key · Enter edits · empty input resets to the default',
      'editor: pi-tui defaults — arrows · Ctrl+B/F · Alt+←→ word · Home/End · Ctrl+W/U/K delete · Ctrl+- undo',
      ...loaded.warnings.map(warning => `! ${warning}`),
    ]
    const panel = new FieldPanel(theme, {
      title: ansiFg(theme.palette.accent) + BOLD + '⚙ hotkeys' + RESET,
      content,
      fields,
      status: () => status,
      footer: '↑↓ key · Enter change · Esc close',
      onEdit: index => edit(fields[index].key),
      onCancel: () => {
        host.close()
        options.restoreFocus()
        resolve(changed ? 'Keybindings updated.' : undefined)
      },
    })
    host.open(panel)
  }

  const resolve = (value: string | undefined): void => {
    settle?.(value)
  }

  /** EditField for one app key: type a key id, empty = reset to default. */
  const edit = (field: keyof KeyBindings): void => {
    const loaded = loadKeyBindings(options.filePath)
    const current = loaded.bindings[field]
    const editor = new EditField(tui, {
      title: `Key for ${field} — default ${displayKey(DEFAULT_KEYBINDINGS[field])}`
        + (current !== undefined ? ` · custom ${displayKey(current)}` : ''),
      subtitle: 'ctrl/shift/alt/super + key · empty resets to the default',
      initial: current ?? '',
      parse: parseKeyInput,
      onCommit: async (outcome): Promise<CommitResult | undefined> => {
        if (outcome.kind === 'value') {
          const id = outcome.value as string
          // Writing the default is a reset: keep the file minimal.
          const reset = id === DEFAULT_KEYBINDINGS[field]
          const fresh = loadKeyBindings(options.filePath)
          if (reset && fresh.bindings[field] === undefined) return undefined // already default — no write
          const error = updateKeyBindingsFile(options.filePath, [[field, reset ? null : (id as KeyId)]])
          if (error !== undefined) return { error }
          changed = true
          applyBindings()
          status = reset
            ? `${field} → default (${displayKey(DEFAULT_KEYBINDINGS[field])}) — applied`
            : `${field} → ${id} — applied`
          return undefined
        }
        if (outcome.kind === 'unset') {
          const fresh = loadKeyBindings(options.filePath)
          if (fresh.bindings[field] === undefined) return undefined // nothing custom to reset
          const error = updateKeyBindingsFile(options.filePath, [[field, null]])
          if (error !== undefined) return { error }
          changed = true
          applyBindings()
          status = `${field} → default (${displayKey(DEFAULT_KEYBINDINGS[field])}) — applied`
          return undefined
        }
        return undefined
      },
      onDone: () => show(),
      onError: message => {
        status = `✘ ${message}`
        show()
      },
    }, theme)
    host.open(editor)
  }

  return new Promise<string | undefined>(resolve => {
    settle = resolve
    // First render inside the executor: a synchronous showOverlay failure in
    // the initial show() must be able to settle the promise through settle.
    show()
  })
}