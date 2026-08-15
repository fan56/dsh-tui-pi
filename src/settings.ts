/**
 * Text-based settings browser — the terminal counterpart of the web GUI's
 * settings surface (schema-form driven there, pi-tui overlays here).
 *
 * Walks `ctx.settings.describe()` (registered namespaces → serialized
 * schemastery schemas → resolved values) and renders it as nested
 * SettingsList overlays, one level per schema depth:
 *
 *   level 0   category list (searchable): general / models / plugins / agent,
 *             then `other` for unmapped namespaces. Namespace→category comes
 *             from a static mapping (categorizeNamespaces) mirroring the web
 *             settings page: the web client slots namespaces into categories
 *             client-side and the data plane carries no category field, so
 *             the mapping is maintained here by hand; `other` is hidden when
 *             empty.
 *   level 1   namespace list for the chosen category (searchable);
 *             description shows applies timing
 *   level 2+  schema walk, dispatched on node type:
 *             - object/dict → drill in (nested list; dicts get an add-key row)
 *             - boolean / all-literal union → Enter cycles the value
 *             - string/number/mixed union → inline Input editor
 *             - array / literal / const / unknown → read-only viewer
 *             - role('secret') fields are masked and edited without prefill
 *             - every group row resets its subtree to defaults (Esc confirms)
 *
 * Writes go through `settings.mutate(ns, pathOps, expectedRevision)` so the
 * user layer is edited by path without restating sections the UI never saw;
 * the descriptor (and with it the revision) is re-read after every committed
 * write, and failed writes revert the on-screen row and surface the error.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  getPath,
  nodeAtPath,
  rehydrateSchema,
  type SchemaNode,
} from '@deepseek-ai/dsh-client-schema-form'
import type {
  SettingsDescriptor,
  SettingsNamespace,
  SettingsPathOp,
  SettingsProvider,
} from '@deepseek-ai/dsh-settings'
import {
  getKeybindings,
  Input,
  SettingsList,
  type Component,
  type OverlayHandle,
  type SettingItem,
  type SettingsListTheme,
  type TUI,
} from '@earendil-works/pi-tui'
import { ansiFg, BOLD, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'

// ------------------------------------------------------- category mapping --

export interface SettingsCategory {
  id: string
  label: string
  namespaces: readonly string[]
}

/**
 * Static namespace→category mapping, mirroring the web settings page's
 * client-side slot structure (see the module header): the data plane carries
 * no category field, so the slots are maintained here by hand. Namespaces not
 * listed anywhere fall into the trailing `other` category.
 *
 * Labels are English-only: pi-tui's SettingsList search matches the label
 * text, so English queries (model, shell, permission, …) hit directly.
 */
export const CATEGORY_MAP: readonly SettingsCategory[] = [
  { id: 'general', label: 'General', namespaces: ['permission', 'dsh-tui'] },
  { id: 'models', label: 'Models', namespaces: ['llm-deepseek', 'llm-pi-ai', 'agent-default-model'] },
  { id: 'plugins', label: 'Plugins', namespaces: ['shell', 'agent-loop', 'web-search-deepseek'] },
  { id: 'agent', label: 'Agent Presets', namespaces: ['agent-presets'] },
]

/** Cap for a category row's member-name description line. */
export const CATEGORY_DESC_MAX = 60

/**
 * Group a describe() namespace list into ordered categories — general, models,
 * plugins, agent, then `other` for everything unmapped. Categories with no
 * members are dropped, including `other` when nothing falls into it.
 *
 * Defensive: duplicate namespaces in the input count once (a namespace
 * registered twice must not be listed twice), and the `mapped` guard resolves
 * CATEGORY_MAP overlap — a namespace listed in several categories goes to the
 * first one, by category order.
 */
export function categorizeNamespaces(nses: string[]): SettingsCategory[] {
  const categories: SettingsCategory[] = []
  const mapped = new Set<string>()
  const input = new Set(nses)
  for (const def of CATEGORY_MAP) {
    const members = [...new Set(def.namespaces)].filter(ns => input.has(ns) && !mapped.has(ns))
    if (members.length === 0) continue
    for (const ns of members) mapped.add(ns)
    categories.push({ id: def.id, label: def.label, namespaces: members })
  }
  const others = [...input].filter(ns => !mapped.has(ns))
  if (others.length > 0) categories.push({ id: 'other', label: 'Other', namespaces: others })
  return categories
}

/**
 * Description line for a category row: member names joined with ", ", capped
 * at `max` columns. Namespace names are ASCII, so visible width equals char
 * count here; the width-aware clip is used anyway so the cap semantics stay
 * uniform with every other truncation in the TUI (an exactly-fitting string
 * is kept whole, an ellipsis appears only when a column is free).
 */
export function categoryDescription(namespaces: readonly string[], max = 60): string {
  const joined = [...new Set(namespaces)].join(', ')
  return clipToWidth(joined, max)
}

// ----------------------------------------------------------------- pure helpers --

/** Human display for a resolved value (row value column; never re-scans anything). */
export function formatValue(value: unknown): string {
  if (value === undefined) return '(unset)'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${value.length} items]`
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    return keys.length === 0 ? '{}' : `{${keys.length} keys}`
  }
  return String(value)
}

/** Display string for one union literal (the SettingsList cycle vocabulary). */
export function displayValue(value: unknown): string {
  return value === null ? 'null' : String(value)
}

export interface UnionLiterals {
  /** Raw literal values (strings, numbers, booleans, …) in schema order. */
  values: unknown[]
  /** Whether every union branch is a plain literal (cycle-eligible). */
  all: boolean
}

/** Extract literal branches of a union node (`literal`/`const` members). */
export function unionLiterals(node: SchemaNode): UnionLiterals {
  const list = node.list ?? []
  const values: unknown[] = []
  let all = list.length > 0
  for (const member of list) {
    if (member.type === 'literal' || member.type === 'const') values.push(member.value)
    else all = false
  }
  return { values, all }
}

/** One parsed Input outcome: commit a value, unset (reset), or reject. */
export type ParseOutcome =
  | { kind: 'value'; value: unknown }
  | { kind: 'unset' }
  | { kind: 'keep' }
  | { kind: 'error'; error: string }

export function parseNumberInput(text: string): ParseOutcome {
  if (text.trim() === '') return { kind: 'unset' }
  // Literal decimal subset: hex/octal/binary prefixes and trailing garbage
  // are rejected; decimal scientific notation stays (1e3 = 1000).
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text.trim())) {
    return { kind: 'error', error: `expected a number, got "${text}"` }
  }
  const n = Number(text)
  if (!Number.isFinite(n)) return { kind: 'error', error: `expected a number, got "${text}"` }
  return { kind: 'value', value: n }
}

export function parseStringInput(text: string): ParseOutcome {
  if (text.trim() === '') return { kind: 'unset' }
  // Keep the user's text verbatim — only the emptiness check trims.
  return { kind: 'value', value: text }
}

/** Mixed (non-literal) union editing: JSON values, else a raw string branch. */
export function parseUnionInput(text: string, node: SchemaNode): ParseOutcome {
  if (text.trim() === '') return { kind: 'unset' }
  try {
    return { kind: 'value', value: JSON.parse(text) as unknown }
  } catch { /* not JSON — fall through to the string-branch path */ }
  const hasStringBranch = (node.list ?? []).some(
    member => member.type === 'string' || (member.type === 'literal' && typeof member.value === 'string'),
  )
  if (hasStringBranch) return { kind: 'value', value: text }
  return { kind: 'error', error: 'expected a JSON value (number, boolean, string, …)' }
}

/** Seed value for a newly added dict key, from the inner schema. */
export function defaultValueFor(node: SchemaNode): unknown {
  const meta = (node.meta ?? {}) as FieldMeta
  if (meta.default !== undefined) return meta.default
  switch (node.type) {
    case 'boolean': return false
    case 'number': return 0
    case 'string': return ''
    case 'array': return []
    case 'object':
    case 'dict': return {}
    case 'union': {
      const { values } = unionLiterals(node)
      return values.length > 0 ? values[0] : null
    }
    default: return null
  }
}

/** Meta surface we read off schema nodes (subset of schemastery's Meta). */
interface FieldMeta {
  description?: string | Record<string, string>
  comment?: string | Record<string, string>
  required?: boolean
  default?: unknown
  min?: number
  max?: number
  step?: number
  pattern?: { source: string; flags?: string }
  role?: string
  hidden?: boolean
  disabled?: boolean
  /** Badge markers (`deprecated()`/`experimental()` push here). */
  badges?: Array<{ text?: string; type?: string }>
}

function fieldMeta(node: SchemaNode): FieldMeta {
  return (node.meta ?? {}) as FieldMeta
}

/** Description line for one field row (static — built once per row). */
export function fieldDescription(node: SchemaNode, userOverride: boolean): string {
  const meta = fieldMeta(node)
  const parts: string[] = []
  const raw = meta.description ?? meta.comment
  if (typeof raw === 'string') parts.push(raw)
  else if (raw !== undefined && typeof raw === 'object') {
    parts.push(raw['en'] ?? raw[''] ?? Object.values(raw)[0] ?? '')
  }
  if (meta.required === true) parts.push('required')
  if (meta.default !== undefined) parts.push(`default: ${formatValue(meta.default)}`)
  if (meta.min !== undefined) parts.push(`min: ${meta.min}`)
  if (meta.max !== undefined) parts.push(`max: ${meta.max}`)
  if (meta.step !== undefined) parts.push(`step: ${meta.step}`)
  if (meta.pattern !== undefined) parts.push(`pattern: ${meta.pattern.source}`)
  if (meta.role === 'secret') parts.push('secret')
  if (meta.disabled === true) parts.push('disabled')
  for (const badge of meta.badges ?? []) {
    if (typeof badge.text === 'string') parts.push(badge.text)
  }
  if (userOverride) parts.push('user-set')
  return parts.filter(part => part !== '').join(' · ')
}

// ---------------------------------------------------------------- browser state --

type RowKind = 'cycle' | 'input' | 'drill' | 'readonly' | 'reset' | 'addkey'

interface RowSpec {
  id: string
  ns: SettingsNamespace
  path: string[]
  label: string
  kind: RowKind
  node: SchemaNode
  /** Raw resolved value at `path` (kept fresh by refreshRows). */
  value: unknown
  /** Display string for the value column (kept fresh by refreshRows). */
  display: string
  values?: string[]
  toRaw?: (display: string) => unknown
  secret?: boolean
}

interface EditOptions {
  title: string
  subtitle: string
  initial: string
  parse: (text: string) => ParseOutcome
  onCommit: (outcome: ParseOutcome) => Promise<string | undefined>
  onDone: () => void
  /** Error sink for writes that fail after the editor already closed (Esc). */
  onError?: (message: string) => void
}

/** Inline value editor: title, current-value line, error line, Input. */
class EditField implements Component {
  private readonly tui: TUI
  private readonly options: EditOptions
  private readonly input: Input
  private error: string | undefined
  /** Set while a commit write is in flight; extra Enter presses are ignored. */
  private pending = false
  /** Guards onDone: exactly one terminal transition (submit success/keep/escape). */
  private done = false
  private readonly fg: (text: string) => string
  private readonly fgMuted: (text: string) => string
  private readonly fgDanger: (text: string) => string

  constructor(tui: TUI, options: EditOptions, theme: TuiTheme) {
    this.tui = tui
    this.options = options
    this.fg = text => ansiFg(theme.palette.accent) + text + RESET
    this.fgMuted = text => ansiFg(theme.palette.fgMuted) + text + RESET
    this.fgDanger = text => ansiFg(theme.palette.danger) + text + RESET
    this.input = new Input()
    this.input.setValue(options.initial)
    // A fresh pi Input starts with the cursor at position 0, so typed
    // characters would PREPEND to the prefilled value and Ctrl+U (delete to
    // line start) would delete nothing. Park the cursor at the end instead —
    // the usual expectation for a prefilled editor.
    ;(this.input as unknown as { cursor: number }).cursor = options.initial.length
    // Not the TUI's focused component (the overlay list is) — flip the flag
    // so Input renders its cursor marker inside the submenu.
    this.input.focused = true
    this.input.onSubmit = (text: string) => {
      if (this.pending) return
      const parsed = options.parse(text)
      if (parsed.kind === 'error') {
        this.error = parsed.error
        this.tui.requestRender()
        return
      }
      if (parsed.kind === 'keep') {
        this.finish()
        return
      }
      this.pending = true
      void options.onCommit(parsed).then(error => {
        this.pending = false
        if (this.done) {
          // Esc already closed the editor while the write was in flight —
          // the component renders for nobody, so a late failure is surfaced
          // through onError instead of this.error.
          if (error !== undefined) options.onError?.(error)
          return
        }
        if (error !== undefined) {
          this.error = error
          this.tui.requestRender()
        } else {
          this.finish()
        }
      })
    }
    this.input.onEscape = () => {
      // Closing during a pending write is allowed (the write is already in
      // the serialized chain — its outcome is undeliverable through this
      // component either way); the done flag keeps onDone single-shot.
      this.finish()
    }
  }

  /** Terminal transition — runs the caller's onDone exactly once. */
  private finish(): void {
    if (this.done) return
    this.done = true
    this.options.onDone()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = []
    lines.push(this.fg(BOLD + `✎ ${this.options.title}` + RESET))
    lines.push(this.fgMuted(this.options.subtitle))
    if (this.error !== undefined) lines.push(this.fgDanger(`✘ ${this.error}`))
    lines.push('')
    lines.push(...this.input.render(width))
    return lines
  }

  handleInput(data: string): void {
    this.input.handleInput(data)
  }
}

/** Two-line confirmation for destructive resets (Enter confirms, Esc cancels). */
class ConfirmReset implements Component {
  private readonly theme: TuiTheme
  private readonly label: string
  private readonly onConfirm: () => void
  private readonly onCancel: () => void
  /** Set while the confirmed write is in flight; extra Enter presses are ignored. */
  private pending = false

  constructor(theme: TuiTheme, label: string, onConfirm: () => void, onCancel: () => void) {
    this.theme = theme
    this.label = label
    this.onConfirm = onConfirm
    this.onCancel = onCancel
  }

  invalidate(): void {}

  render(_width: number): string[] {
    const fg = (hex: string) => (text: string) => ansiFg(hex) + text + RESET
    return [
      fg(this.theme.palette.attention)(BOLD + `↺ ${this.label}` + RESET),
      '',
      fg(this.theme.palette.fgMuted)(this.pending
        ? '  resetting…'
        : '  Enter: reset to defaults · Esc: cancel'),
    ]
  }

  handleInput(data: string): void {
    // While the confirmed write is in flight the commit is already in the
    // serialized chain and cannot be undone — pretending Esc cancels would
    // be a lie, so every key is ignored until the write settles.
    if (this.pending) return
    if (getKeybindings().matches(data, 'tui.select.confirm')) {
      this.pending = true
      this.onConfirm()
    } else if (getKeybindings().matches(data, 'tui.select.cancel')) {
      this.onCancel()
    }
  }
}

/** Read-only JSON view for array / literal / unknown nodes. */
class ReadOnlyViewer implements Component {
  private readonly theme: TuiTheme
  private readonly label: string
  private readonly json: unknown
  private readonly onClose: () => void

  constructor(theme: TuiTheme, label: string, json: unknown, onClose: () => void) {
    this.theme = theme
    this.label = label
    this.json = json
    this.onClose = onClose
  }

  invalidate(): void {}

  render(width: number): string[] {
    const fg = (hex: string) => (text: string) => ansiFg(hex) + text + RESET
    const lines: string[] = [
      fg(this.theme.palette.accent)(BOLD + `ⓘ ${this.label}` + RESET),
      '',
    ]
    const text = JSON.stringify(this.json, null, 2)
    const max = Math.max(2, width - 2)
    for (const line of text.split('\n').slice(0, 40)) {
      lines.push(fg(this.theme.palette.fgMuted)(clipToWidth(line, max)))
    }
    lines.push('')
    lines.push(fg(this.theme.palette.fgSubtle)(
      '  read-only in the TUI — edit the settings document to change it · Esc to close',
    ))
    return lines
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, 'tui.select.cancel')
      || getKeybindings().matches(data, 'tui.select.confirm')) {
      this.onClose()
    }
  }
}

// -------------------------------------------------------------------- the browser --

export interface OpenSettingsBrowserOptions {
  ctx: Context
  tui: TUI
  theme: TuiTheme
  /** Focus target to restore when the browser closes (usually the editor). */
  restoreFocus: () => void
  /** Error sink for writes that fail outside an inline editor (transcript). */
  onError: (message: string) => void
}

/**
 * Open the modal settings browser. Resolves when it closes with the number of
 * committed writes, or -1 when no namespace is registered (nothing to show).
 */
export async function openSettingsBrowser(options: OpenSettingsBrowserOptions): Promise<number> {
  const settings = options.ctx.get('settings')
  if (settings === undefined) throw new Error('settings service is not available')
  const browser = new SettingsBrowser({ ...options, settings })
  return browser.open()
}

class SettingsBrowser {
  private readonly ctx: Context
  private readonly tui: TUI
  private readonly theme: TuiTheme
  private readonly listTheme: SettingsListTheme
  private readonly settings: SettingsProvider
  private readonly restoreFocus: () => void
  private readonly onError: (message: string) => void

  private descriptors: SettingsDescriptor[] = []
  /** Rehydrated schema roots, cached per namespace (schemas never change). */
  private readonly roots = new Map<string, SchemaNode>()
  private readonly changes = { value: 0 }
  private overlay: OverlayHandle | undefined
  private catList: SettingsList | undefined
  private nsList: SettingsList | undefined
  private writeChain: Promise<void> = Promise.resolve()
  private closed: Promise<void>
  private closeResolve!: () => void

  constructor(options: OpenSettingsBrowserOptions & { settings: SettingsProvider }) {
    this.ctx = options.ctx
    this.tui = options.tui
    this.theme = options.theme
    this.settings = options.settings
    this.restoreFocus = options.restoreFocus
    this.onError = options.onError
    // Assigned here, not as a field initializer: a later field declaration
    // would `defineProperty(…, undefined)` over the promise's resolve.
    this.closed = new Promise<void>(resolve => { this.closeResolve = resolve })
    const p = options.theme.palette
    const fg = (hex: string) => (text: string) => ansiFg(hex) + text + RESET
    this.listTheme = {
      label: (text, selected) => fg(p.fgDefault)(selected ? BOLD + text + RESET : text),
      value: (text, selected) => fg(selected ? p.accent : p.fgMuted)(text),
      description: text => fg(p.fgSubtle)(text),
      cursor: fg(p.accent)(BOLD + '▸ '),
      hint: text => fg(p.fgSubtle)(text),
    }
  }

  async open(): Promise<number> {
    this.refresh()
    if (this.categories().length === 0) return -1
    const list = this.categoryList()
    this.catList = list
    this.overlay = this.tui.showOverlay(list, { width: '80%', maxHeight: '70%' })
    await this.closed
    return this.changes.value
  }

  private close(): void {
    this.overlay?.hide()
    this.overlay = undefined
    this.catList = undefined
    this.nsList = undefined
    this.restoreFocus()
    this.closeResolve()
  }

  /** Re-read descriptors (and with them revisions) from the service. */
  private refresh(): void {
    this.descriptors = this.settings.describe()
  }

  private descriptor(ns: SettingsNamespace): SettingsDescriptor | undefined {
    return this.descriptors.find(d => d.ns === ns)
  }

  private root(ns: SettingsNamespace): SchemaNode | undefined {
    const cached = this.roots.get(ns)
    if (cached !== undefined) return cached
    const desc = this.descriptor(ns)
    if (desc === undefined) return undefined
    const root = rehydrateSchema(desc.schema)
    this.roots.set(ns, root)
    return root
  }

  // ------------------------------------------------------------ category level --

  private categories(): SettingsCategory[] {
    return categorizeNamespaces(this.descriptors.map(d => d.ns))
  }

  private categorySummary(cat: SettingsCategory): string {
    return `${cat.namespaces.length} namespaces`
  }

  private categoryDescription(cat: SettingsCategory): string {
    return categoryDescription(cat.namespaces, CATEGORY_DESC_MAX)
  }

  private categoryList(): SettingsList {
    const items: SettingItem[] = this.categories().map(cat => ({
      id: cat.id,
      label: cat.label,
      currentValue: this.categorySummary(cat),
      description: this.categoryDescription(cat),
      submenu: (_current, done) => {
        const list = this.namespaceList(
          this.descriptors.filter(d => cat.namespaces.includes(d.ns)),
          done,
        )
        this.nsList = list
        return list
      },
    }))
    const list = new SettingsList(
      items,
      10,
      this.listTheme,
      () => {},
      () => this.close(),
      { enableSearch: true },
    )
    return list
  }

  private refreshCategoryList(): void {
    if (this.catList === undefined) return
    this.refresh()
    for (const cat of this.categories()) {
      this.catList.updateValue(cat.id, this.categorySummary(cat))
    }
  }

  // ------------------------------------------------------------ namespace level --

  private nsSummary(desc: SettingsDescriptor): string {
    const root = this.root(desc.ns)
    if (root !== undefined && root.type === 'object') {
      return `${Object.keys(root.dict ?? {}).length} fields`
    }
    return formatValue(desc.value)
  }

  private nsDescription(desc: SettingsDescriptor): string {
    const parts = [`applies: ${desc.applies}`]
    if (desc.user !== undefined) parts.push('user-set')
    return parts.join(' · ')
  }

  /** Namespace list for one category; Esc pops back to the category level. */
  private namespaceList(descriptors: readonly SettingsDescriptor[], onExit: () => void): SettingsList {
    const items: SettingItem[] = descriptors.map(desc => ({
      id: desc.ns,
      label: desc.ns,
      currentValue: this.nsSummary(desc),
      description: this.nsDescription(desc),
      submenu: (_current, done) => {
        const section = this.sectionList(desc.ns, [], () => {
          this.refreshNsList()
          done()
        })
        return section.list
      },
    }))
    const list = new SettingsList(
      items,
      10,
      this.listTheme,
      () => {},
      () => {
        this.refreshCategoryList()
        onExit()
      },
      { enableSearch: true },
    )
    return list
  }

  private refreshNsList(): void {
    if (this.nsList === undefined) return
    this.refresh()
    for (const desc of this.descriptors) {
      this.nsList.updateValue(desc.ns, this.nsSummary(desc))
    }
  }

  // ------------------------------------------------------------- section levels --

  /**
   * Build the SettingsList for one schema node at `path` of `ns`.
   * `onExit` runs when the list is popped (Esc) — it must refresh the parent
   * level and call the parent's submenu `done()`.
   */
  private sectionList(
    ns: SettingsNamespace,
    path: string[],
    onExit: () => void,
  ): { list: SettingsList; refresh: () => void } {
    const root = this.root(ns)
    const desc = this.descriptor(ns)
    const node = root !== undefined && path.length > 0
      ? (nodeAtPath(root, path) ?? root)
      : root
    const rows = node === undefined ? [] : this.buildRows(ns, node, path, desc?.value)
    const refresh = (): void => { this.refreshRows(rows, list) }
    const items = rows.map(row => this.rowItem(row, refresh))
    const list = new SettingsList(
      items,
      12,
      this.listTheme,
      (id, newValue) => { void this.onCycle(rows, list, id, newValue) },
      () => {
        refresh()
        onExit()
      },
      { enableSearch: true },
    )
    return { list, refresh }
  }

  private buildRows(ns: SettingsNamespace, node: SchemaNode, path: string[], value: unknown): RowSpec[] {
    const rows: RowSpec[] = []
    if (node.type === 'object' || node.type === 'dict') {
      rows.push({
        id: '\u0000reset',
        ns,
        path,
        label: `↺ Reset ${path.length === 0 ? 'this namespace' : path.join('.')} to defaults`,
        kind: 'reset',
        node,
        value: undefined,
        display: '',
      })
      if (node.type === 'dict') {
        rows.push({
          id: '\u0000add',
          ns,
          path,
          label: '+ Add key…',
          kind: 'addkey',
          node,
          value: undefined,
          display: '',
        })
      }
    }
    if (node.type === 'object') {
      for (const [key, child] of Object.entries(node.dict ?? {})) {
        if (fieldMeta(child).hidden === true) continue
        rows.push(this.fieldRow(ns, child, [...path, key], key))
      }
    } else if (node.type === 'dict') {
      const entries = Object.entries((getPath(value, path) ?? {}) as Record<string, unknown>)
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      const inner = node.inner ?? node
      for (const [key] of entries) {
        rows.push(this.fieldRow(ns, inner, [...path, key], key))
      }
    }
    return rows
  }

  private fieldRow(ns: SettingsNamespace, node: SchemaNode, path: string[], label: string): RowSpec {
    const desc = this.descriptor(ns)
    const meta = fieldMeta(node)
    const value = getPath(desc?.value, path)
    const secret = meta.role === 'secret'
    const kind = this.rowKindFor(node)
    const row: RowSpec = {
      // JSON-encoded path: a dict key containing '.' must not collide with
      // the nested-path row id of the same spelling.
      id: JSON.stringify(path),
      ns,
      path,
      label,
      kind,
      node,
      value,
      display: this.computeDisplay(kind, node, value, secret),
      secret,
    }
    if (kind === 'cycle') {
      row.values = this.cycleValues(node)
      row.toRaw = display => this.cycleToRaw(node, display)
    }
    return row
  }

  private rowKindFor(node: SchemaNode): RowKind {
    switch (node.type) {
      case 'object':
      case 'dict': return 'drill'
      case 'array': return 'readonly'
      case 'boolean': return 'cycle'
      case 'string': return 'input'
      case 'number': return 'input'
      case 'union': return unionLiterals(node).all ? 'cycle' : 'input'
      case 'transform': return node.inner === undefined ? 'readonly' : this.rowKindFor(node.inner)
      default: return 'readonly' // literal, const, is, intersect, tuple, …
    }
  }

  private cycleValues(node: SchemaNode): string[] {
    if (node.type === 'boolean') return ['true', 'false']
    return unionLiterals(node).values.map(displayValue)
  }

  private cycleToRaw(node: SchemaNode, display: string): unknown {
    if (node.type === 'boolean') return display === 'true'
    const { values } = unionLiterals(node)
    const literal = values.find(value => displayValue(value) === display)
    if (literal === undefined) throw new Error(`unexpected cycle value: ${display}`)
    return literal
  }

  private computeDisplay(kind: RowKind, node: SchemaNode, value: unknown, secret: boolean): string {
    if (secret) return value === undefined || value === null || value === '' ? '(unset)' : '••••••'
    switch (kind) {
      case 'drill': {
        if (node.type === 'object') return `{${Object.keys(node.dict ?? {}).length} fields}`
        if (node.type === 'dict') {
          const entries = Object.keys((value ?? {}) as Record<string, unknown>)
          return `dict · ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`
        }
        return formatValue(value)
      }
      default: return formatValue(value)
    }
  }

  /** SettingItem for one row; drill/input/reset/addkey attach their submenus. */
  private rowItem(row: RowSpec, refresh: () => void): SettingItem {
    const base: SettingItem = {
      id: row.id,
      label: row.label,
      currentValue: row.display,
      description: this.rowDescription(row),
    }
    switch (row.kind) {
      case 'cycle': return { ...base, values: row.values }
      case 'drill': return {
        ...base,
        submenu: (_current, done) => {
          const child = this.sectionList(row.ns, row.path, () => { refresh(); done() })
          return child.list
        },
      }
      case 'input': return { ...base, submenu: (_current, done) => this.inputSubmenu(row, refresh, done) }
      case 'addkey': return { ...base, submenu: (_current, done) => this.addKeySubmenu(row, refresh, done) }
      case 'reset': return {
        ...base,
        submenu: (_current, done) => this.resetSubmenu(row, refresh, done),
      }
      // Read-only rows still open the JSON viewer — Enter shows the value in
      // full instead of silently doing nothing (the module header's promise).
      default: return {
        ...base,
        submenu: (_current, done) => new ReadOnlyViewer(this.theme, row.path.join('.'), row.value, done),
      }
    }
  }

  private rowDescription(row: RowSpec): string {
    if (row.kind === 'reset' || row.kind === 'addkey') return ''
    const desc = this.descriptor(row.ns)
    const userOverride = desc?.user !== undefined && this.hasPath(desc.user, row.path)
    return fieldDescription(row.node, userOverride)
  }

  private hasPath(user: unknown, path: string[]): boolean {
    if (path.length === 0) return user !== undefined
    let current: unknown = user
    for (const key of path) {
      if (Array.isArray(current)) {
        current = current[Number(key)]
        continue
      }
      if (typeof current !== 'object' || current === null) return false
      current = (current as Record<string, unknown>)[key]
    }
    return true
  }

  /** Recompute every row's value/display from a fresh descriptor. */
  private refreshRows(rows: RowSpec[], list: SettingsList): void {
    const ns = rows[0]?.ns
    if (ns === undefined) return
    this.refresh()
    const desc = this.descriptor(ns)
    if (desc === undefined) return
    for (const row of rows) {
      if (row.kind === 'reset' || row.kind === 'addkey') continue
      row.value = getPath(desc.value, row.path)
      row.display = this.computeDisplay(row.kind, row.node, row.value, row.secret === true)
      list.updateValue(row.id, row.display)
    }
  }

  // ------------------------------------------------------------------- write path --

  /** Serialized settings write; resolves with an error message, or undefined. */
  private write(ns: SettingsNamespace, ops: readonly SettingsPathOp[]): Promise<string | undefined> {
    const task = this.writeChain.then(async () => {
      try {
        // Revision read at execution time: the previous write in the chain has
        // already refreshed descriptors, so rapid consecutive writes never
        // conflict with themselves.
        await this.settings.mutate(ns, [...ops], this.descriptor(ns)?.revision)
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      this.changes.value += 1
      this.refresh()
      return undefined
    })
    this.writeChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private onCycle(rows: RowSpec[], list: SettingsList, id: string, newValue: string): void {
    const row = rows.find(r => r.id === id)
    if (row === undefined || row.kind !== 'cycle' || row.toRaw === undefined) return
    let raw: unknown
    try {
      raw = row.toRaw(newValue)
    } catch {
      this.refreshRows(rows, list)
      return
    }
    void this.write(row.ns, [{ op: 'set', path: row.path, value: raw }]).then(error => {
      // Success and failure alike re-read the descriptor: the service's
      // resolved value is the single source of truth for the row display,
      // never a local snapshot (which concurrent writes may have aged).
      if (error !== undefined) this.onError(error)
      this.refreshRows(rows, list)
    })
  }

  /** Build the edit submenu for a leaf row; commits write to settings. */
  private inputSubmenu(row: RowSpec, refresh: () => void, done: () => void): Component {
    const meta = fieldMeta(row.node)
    const initial = row.secret === true || row.value === undefined || row.value === null
      ? ''
      : String(row.value)
    return new EditField(this.tui, {
      title: row.path.join('.'),
      subtitle: row.secret === true
        ? 'secret — leave empty to keep the current value'
        : `current: ${row.display}${meta.required === true ? ' · required' : ''}`,
      initial,
      parse: text => this.parseFor(row, text),
      onCommit: outcome => this.commitInput(row, refresh, outcome),
      onDone: done,
      onError: message => this.onError(message),
    }, this.theme)
  }

  private parseFor(row: RowSpec, text: string): ParseOutcome {
    // Whitespace-only input on a secret also means "keep" — an accidental
    // space must not unset (delete) the stored secret; clearing a secret is
    // the reset row's job, not the editor's empty submit.
    if (row.secret === true && text.trim() === '') return { kind: 'keep' }
    switch (row.node.type) {
      case 'number': return parseNumberInput(text)
      case 'string': return parseStringInput(text)
      case 'union': return parseUnionInput(text, row.node)
      case 'transform':
        return row.node.inner === undefined
          ? { kind: 'error', error: `cannot edit ${row.node.type} value` }
          : this.parseFor({ ...row, node: row.node.inner }, text)
      default: return { kind: 'error', error: `cannot edit ${row.node.type} value` }
    }
  }

  private async commitInput(row: RowSpec, refresh: () => void, outcome: ParseOutcome): Promise<string | undefined> {
    if (outcome.kind !== 'value' && outcome.kind !== 'unset') return undefined
    const ops: SettingsPathOp[] = outcome.kind === 'unset'
      ? [{ op: 'unset', path: row.path }]
      : [{ op: 'set', path: row.path, value: outcome.value }]
    const error = await this.write(row.ns, ops)
    if (error === undefined) refresh()
    return error
  }

  /** Add-key editor for dict sections; commits a default-valued entry. */
  private addKeySubmenu(row: RowSpec, refresh: () => void, done: () => void): Component {
    const inner = row.node.inner ?? row.node
    const existing = (getPath(this.descriptor(row.ns)?.value, row.path) ?? {}) as Record<string, unknown>
    return new EditField(this.tui, {
      title: `+ key in ${row.path.length === 0 ? '…' : row.path.join('.')}`,
      subtitle: `default: ${formatValue(defaultValueFor(inner))} · Enter to add · Esc to cancel`,
      initial: '',
      parse: text => {
        const key = text.trim()
        if (key === '') return { kind: 'error', error: 'key must not be empty' }
        if (key in existing) return { kind: 'error', error: `key "${key}" already exists` }
        return { kind: 'value', value: key }
      },
      onCommit: async outcome => {
        if (outcome.kind !== 'value') return undefined
        const key = String(outcome.value)
        const error = await this.write(row.ns, [{ op: 'set', path: [...row.path, key], value: defaultValueFor(inner) }])
        if (error === undefined) refresh()
        return error
      },
      onDone: done,
      onError: message => this.onError(message),
    }, this.theme)
  }

  /** Reset-to-defaults confirmation for group/namespace rows. */
  private resetSubmenu(row: RowSpec, refresh: () => void, done: () => void): Component {
    return new ConfirmReset(
      this.theme,
      row.path.length === 0
        ? `Reset "${row.ns}" to defaults`
        : `Reset ${row.path.join('.')} to defaults`,
      () => {
        void this.write(row.ns, [{ op: 'unset', path: row.path }]).then(error => {
          if (error !== undefined) this.onError(error)
          else refresh()
          done()
        })
      },
      () => done(),
    )
  }
}
