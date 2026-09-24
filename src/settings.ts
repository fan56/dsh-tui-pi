/**
 * Text-based settings browser — the terminal counterpart of the web GUI's
 * settings surface (schema-form driven there, pi-tui overlays here).
 *
 * Walks `ctx.settings.describe()` (settings-bearing plugin entries →
 * serialized volatile-only schemastery schemas → resolved values) and renders it as nested FW list
 * panels (src/panels.ts SettingsListPanel), one level per schema depth:
 *
 *   level 0   category list (searchable), alphabetical by canonical label:
 *             Agent Presets / General / Models / Other / Plugins / TUI,
 *             with `other` hidden when no namespace falls into it. Namespace→category comes
 *             from a static mapping (categorizeNamespaces) mirroring the web
 *             settings page: the web client slots namespaces into categories
 *             client-side and the data plane carries no category field, so
 *             the mapping is maintained here by hand; `other` is hidden when
 *             empty.
 *   level 1   entry list for the chosen category (searchable);
 *             description shows the override state. The Models category is
 *             special-cased: it lists configured llm-pi-ai providers (label,
 *             model summary, API-key state) instead of the raw namespace —
 *             the original schema surface is hidden — plus dedicated
 *             llm-deepseek / agent-default-model rows and an add-provider
 *             flow (built-in directory → one API key → write). The
 *             single-namespace dsh-tui category drills straight through to
 *             its field list, titled by the category label.
 *   level 2+  schema walk, dispatched on node type:
 *             - object/dict → drill in (nested list; dicts get an add-key
 *               row); at a grouped namespace's root (FIELD_GROUPS) member
 *               fields collapse into one virtual group drill row
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
import { getPath, nodeAtPath, rehydrateSchema, type SchemaNode } from './schema-model.ts'
import type {
  SettingsDescriptor,
  SettingsForms,
  SettingsPathOp,
} from '@deepseek-ai/dsh-settings'
import {
  getKeybindings,
  Input,
  matchesKey,
  type Component,
  type OverlayHandle,
  type TUI,
} from '@earendil-works/pi-tui'
import {
  columnWidths,
  MARKER_W,
  padCell,
  panelThemeFns,
  SettingsListPanel,
  type SettingsRow,
  TABLE_SEP,
  tableHeaderLine,
  tableRuleLine,
  ViewerPanel,
  type TableColumn,
} from './panels.ts'
import { ansiFg, BOLD, RESET, type TuiTheme } from './theme/index.ts'
import { t } from './i18n/index.ts'
import { clipToWidth, visibleWidth } from './text.ts'
import { wrapFramedOverlay } from './frame.ts'
import { languagePickerPanel } from './selectors.ts'
import { THEME_SETTINGS_NAMESPACE } from './theme-settings.ts'
import {
  catalogEntry,
  deriveKeyRef,
  directoryProviderEntries,
  providerProfileFor,
  providerRowView,
  resolveCatalogHint,
  unconfiguredCatalogEntries,
  type ProviderCatalogEntry,
} from './provider-catalog.ts'

/**
 * Structural face of the credential seam (`ctx.credentials`) the add-provider
 * flow writes the API key through. Kept local so the browser does not
 * hard-depend on the `@deepseek-ai/dsh-credentials` package: the seam is a
 * cordis Service registered under `credentials` with the CredentialProvider
 * operations — `set` is all the add-provider flow needs, `describe` (present
 * in the real service, optional here) is the read-only probe the Models
 * category uses to show real key state from the credentials document.
 */
interface CredentialSeam {
  set(ref: string, value: string): Promise<void>
  /** Probe one reference: `configured: true` means a value would resolve. */
  describe?(ref: string): Promise<{ configured: boolean }>
}

// ------------------------------------------------------- category mapping --

export interface SettingsCategory {
  id: string
  label: string
  namespaces: readonly string[]
}

/**
 * Static entry→category mapping, mirroring the web settings page's
 * client-side slot structure (see the module header): the data plane carries
 * no category field, so the slots are maintained here by hand. Entry ids not
 * listed anywhere fall into the trailing `other` category. Beyond the web
 * page's own slots, the plugins category enumerates the settings-bearing
 * entry ids of the dsh plugins installed in this ecosystem (dsh-mcp-adapter,
 * dsh-topics-memory, dsh-vault, dsh-model-sync, dsh-feishu, dsh-llm-proxy) so
 * their rows group under Plugins instead of leaking into `other`. Under
 * dsh 0.1.7 the descriptor's `ns` IS the profile entry id (declare-Config
 * model), so the table speaks entry ids: host entries keep their historical
 * names (permission / llm-deepseek / llm-pi-ai / agent-default-model /
 * bash-sandbox / pwsh-sandbox), while the migrated third-party plugins use
 * their package-derived ids (the old `mcp-adapter`/`topics`/`vault`/
 * `model-sync`/`shell` namespace spellings are gone).
 *
 * The `label`s here are the English source of truth: rows render through
 * `categoryLabel()` (t() at render time, keyed by category id), so the active
 * UI language translates them while search keeps matching whatever is
 * displayed. The first level is ordered by this canonical label
 * (categorizeNamespaces sorts), not by map order.
 */
export const CATEGORY_MAP: readonly SettingsCategory[] = [
  { id: 'dsh-tui', label: 'TUI', namespaces: ['dsh-tui'] },
  { id: 'general', label: 'General', namespaces: ['permission'] },
  { id: 'models', label: 'Models', namespaces: ['llm-deepseek', 'llm-pi-ai', 'agent-default-model'] },
  {
    id: 'plugins',
    label: 'Plugins',
    namespaces: [
      'bash-sandbox',
      'pwsh-sandbox',
      'agent-loop',
      'web-search-deepseek',
      // Settings-bearing entry ids of installed dsh plugins (the descriptor
      // ns IS the profile entry id under the declare-Config model); a plugin
      // without a volatile Config field never reaches the settings browser.
      'dsh-mcp-adapter',
      'dsh-topics-memory',
      'dsh-vault',
      'dsh-model-sync',
      'dsh-feishu',
      'dsh-llm-proxy',
    ],
  },
  // The 0.1.7 agent-preset registry's profile entry id (`agent-preset-registry`
  // in the official bundle): its volatile Config fields (`selectedDefault` —
  // the new-task default, `modeSelectionEnabled` — the new-session picker
  // toggle) are the settings face of agent presets. The old `agent-presets`
  // settings namespace died with settings.yaml in 0.1.7.
  { id: 'agent', label: 'Agent Presets', namespaces: ['agent-preset-registry'] },
]

/**
 * Category id → i18n key resolver for the user-facing label. The static
 * labels in CATEGORY_MAP stay English (module data must not freeze a
 * language at import time); rows resolve through these literal t() call
 * sites at render time and fall back to the static label for an id without
 * an entry.
 */
const CATEGORY_LABEL_KEYS: Readonly<Record<string, () => string>> = {
  'dsh-tui': () => t('settingsui.category.dsh-tui'),
  general: () => t('settingsui.category.general'),
  models: () => t('settingsui.category.models'),
  plugins: () => t('settingsui.category.plugins'),
  agent: () => t('settingsui.category.agent'),
  other: () => t('settingsui.category.other'),
}

/** User-facing label of one category (t()-resolved; English fallback). */
function categoryLabel(cat: SettingsCategory): string {
  const make = CATEGORY_LABEL_KEYS[cat.id]
  return make === undefined ? cat.label : make()
}

/** Cap for a category row's member-name description line. */
export const CATEGORY_DESC_MAX = 60

// --------------------------------------------------------------- field groups --

/**
 * UI-only virtual field groups: at the root of a grouped namespace, member
 * fields collapse into one drill row (positioned at the group's first
 * member) instead of sitting flat in the field list. Purely a settings
 * BROWSER display regroup — the schema and the settings document keep their
 * flat shape, so user config paths (`dsh-tui.maxAgents` etc.) never move.
 *
 * A virtual group has no single path of its own: its list carries no reset
 * row (the namespace-level reset still covers the whole subtree), and its
 * value column shows a member count.
 */
export interface FieldGroupDef {
  id: string
  /** i18n key of the group label (resolved through resolveFieldGroupLabel). */
  labelKey: string
  /** Schema field names grouped under this row, in display order. */
  fields: readonly string[]
}

export const FIELD_GROUPS: Readonly<Record<string, readonly FieldGroupDef[]>> = {
  'dsh-tui': [
    {
      id: 'subagent',
      labelKey: 'settingsui.group.subagent',
      fields: ['maxAgents', 'maxRounds', 'maxRoundsGrace', 'disableSubagent', 'registeredOnly'],
    },
  ],
}

/**
 * Resolve one group's label to display text. The static tables carry i18n
 * KEYS (module data must not freeze a language at import time); this switch
 * enumerates them as literal t() call sites — which is also what the i18n
 * coverage guard matches against. Anything else passes through `t()`
 * unchanged, since a non-key falls back to itself.
 */
export function resolveFieldGroupLabel(labelKey: string): string {
  switch (labelKey) {
    case 'settingsui.group.subagent': return t('settingsui.group.subagent')
    default: return t(labelKey)
  }
}

/** One walked field: a plain schema key, or a collapsed group slot. */
export type FieldSlot =
  | { kind: 'field'; key: string }
  | { kind: 'group'; group: FieldGroupDef; members: readonly string[] }

/**
 * Order schema field keys for display: grouped fields collapse into a single
 * group slot at the position of the group's FIRST member present (members
 * list only the keys actually present, in group-declaration order). Keys in
 * no group pass through in order. Unknown/hidden keys never reach this
 * function — the caller walks already-filtered rows.
 */
export function slotFieldKeys(ns: string, keys: readonly string[]): FieldSlot[] {
  const groups = FIELD_GROUPS[ns]
  if (groups === undefined || groups.length === 0) {
    return keys.map(key => ({ kind: 'field' as const, key }))
  }
  const keySet = new Set(keys)
  const emitted = new Set<string>()
  const slots: FieldSlot[] = []
  for (const key of keys) {
    const group = groups.find(def => def.fields.includes(key))
    if (group === undefined) {
      slots.push({ kind: 'field', key })
      continue
    }
    if (emitted.has(group.id)) continue
    emitted.add(group.id)
    slots.push({ kind: 'group', group, members: group.fields.filter(field => keySet.has(field)) })
  }
  return slots
}

/**
 * Profile entry ids the Models category reads and writes. Under dsh 0.1.7
 * the descriptor `ns` IS the profile entry id; these three host entries keep
 * their historical spellings.
 */
const NS_LLM_PI_AI = 'llm-pi-ai'
const NS_LLM_DEEPSEEK = 'llm-deepseek'
const NS_AGENT_DEFAULT_MODEL = 'agent-default-model'

/**
 * Group a describe() namespace list into ordered categories. The result is
 * sorted alphabetically by the canonical (English) label — Agent Presets,
 * General, Models, Other, Plugins, TUI — so the first level reads the same
 * regardless of CATEGORY_MAP order or the active UI language (sorting keys on
 * the canonical label, never the t()-translated one). Categories with no
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
  return categories.sort((a, b) => {
    const la = a.label.toLowerCase()
    const lb = b.label.toLowerCase()
    return la < lb ? -1 : la > lb ? 1 : 0
  })
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
  if (value === undefined) return t('settingsui.value.unset')
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.length === 0 ? '[]' : t('settingsui.value.items', { count: value.length })
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    return keys.length === 0 ? '{}' : `{${t('settingsui.value.keys', { count: keys.length })}}`
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
    return { kind: 'error', error: t('settingsui.parse.number', { text }) }
  }
  const n = Number(text)
  if (!Number.isFinite(n)) return { kind: 'error', error: t('settingsui.parse.number', { text }) }
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
  return { kind: 'error', error: t('settingsui.parse.json') }
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
  if (meta.required === true) parts.push(t('settingsui.meta.required'))
  if (meta.default !== undefined) parts.push(t('settingsui.meta.default', { value: formatValue(meta.default) }))
  if (meta.min !== undefined) parts.push(t('settingsui.meta.min', { value: meta.min }))
  if (meta.max !== undefined) parts.push(t('settingsui.meta.max', { value: meta.max }))
  if (meta.step !== undefined) parts.push(t('settingsui.meta.step', { value: meta.step }))
  if (meta.pattern !== undefined) parts.push(t('settingsui.meta.pattern', { value: meta.pattern.source }))
  if (meta.role === 'secret') parts.push(t('settingsui.meta.secret'))
  if (meta.disabled === true) parts.push(t('settingsui.meta.disabled'))
  for (const badge of meta.badges ?? []) {
    if (typeof badge.text === 'string') parts.push(badge.text)
  }
  if (userOverride) parts.push(t('settingsui.meta.userSet'))
  return parts.filter(part => part !== '').join(' · ')
}

// ---------------------------------------------------------------- browser state --

type RowKind = 'cycle' | 'input' | 'drill' | 'readonly' | 'reset' | 'addkey'

interface RowSpec {
  id: string
  ns: string
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

/**
 * Outcome of one commit write: an `error` (shown with the ✘ marker and
 * danger color), a `notice` (shown as a plain hint — the write succeeded but
 * needs a follow-up, e.g. "provider added, key must come from the
 * environment"), or `undefined` (clean success → the editor closes). Exactly
 * one of `error`/`notice` is set.
 */
export interface CommitResult {
  error?: string
  notice?: string
}

export interface EditOptions {
  title: string
  subtitle: string
  initial: string
  parse: (text: string) => ParseOutcome
  onCommit: (outcome: ParseOutcome) => Promise<CommitResult | undefined>
  onDone: () => void
  /** Error sink for writes that fail after the editor already closed (Esc). */
  onError?: (message: string) => void
  /**
   * Masked rendering: the value is shown as a dot row instead of plaintext
   * (secrets never echo). Editing semantics are unaffected — the internal
   * Input still owns input/delete/paste/submit.
   */
  secret?: boolean
}

/** Inline value editor: title, current-value line, error/notice line, Input. */
export class EditField implements Component {
  private readonly tui: TUI
  private readonly theme: TuiTheme
  private readonly options: EditOptions
  private readonly input: Input
  private error: string | undefined
  /** Non-error commit message (success with a follow-up hint, see CommitResult). */
  private notice: string | undefined
  /** Set while a commit write is in flight; extra Enter presses are ignored. */
  private pending = false
  /** Guards onDone: exactly one terminal transition (submit success/keep/escape). */
  private done = false
  private readonly fgDanger: (text: string) => string

  constructor(tui: TUI, options: EditOptions, theme: TuiTheme) {
    this.tui = tui
    this.theme = theme
    this.options = options
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
        this.notice = undefined
        this.tui.requestRender()
        return
      }
      if (parsed.kind === 'keep') {
        this.finish()
        return
      }
      this.pending = true
      void options.onCommit(parsed).then(result => {
        this.pending = false
        if (this.done) {
          // Esc already closed the editor while the write was in flight —
          // the component renders for nobody, so a late failure is surfaced
          // through onError instead of this.error.
          if (result?.error !== undefined) options.onError?.(result.error)
          return
        }
        if (result?.error !== undefined) {
          this.error = result.error
          this.notice = undefined
          this.tui.requestRender()
        } else if (result?.notice !== undefined) {
          // Success with a hint: stay open so the hint is readable (Enter
          // re-runs the commit idempotently, Esc exits) — no ✘ marker.
          this.error = undefined
          this.notice = result.notice
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
    const fns = panelThemeFns(this.theme)
    const wrap = Math.max(2, width - 2)
    const lines: string[] = [
      fns.accent(BOLD + clipToWidth(this.options.title, wrap) + RESET),
      fns.muted(clipToWidth(this.options.subtitle, wrap)),
    ]
    if (this.error !== undefined) lines.push(this.fgDanger(`✘ ${this.error}`))
    else if (this.notice !== undefined) lines.push(fns.muted(clipToWidth(this.notice, wrap)))
    lines.push('')
    if (this.options.secret === true) {
      lines.push(this.maskLine(width))
    } else {
      lines.push(...this.input.render(width))
    }
    lines.push('')
    lines.push(fns.subtle(clipToWidth(t('settingsui.edit.footer'), wrap)))
    return lines
  }

  /**
   * Masked input line for secret fields: a dot row (one dot per visible
   * column of the value, capped to the popup width) with a `▎` marker at the
   * cursor position. The real cursor is not rendered — the marker only hints
   * at the editing position; input semantics live in the internal Input. The
   * row needs no background of its own — FramedOverlay fills the canvasSubtle
   * backdrop.
   */
  private maskLine(width: number): string {
    const maxDots = Math.max(0, width - 2)
    const dots = '•'.repeat(Math.min(maxDots, visibleWidth(this.input.getValue())))
    const cursor = Math.min((this.input as unknown as { cursor: number }).cursor, dots.length)
    return dots.slice(0, cursor) + '▎' + dots.slice(cursor)
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
    const fns = panelThemeFns(this.theme)
    return [
      fns.accent(BOLD + this.label + RESET),
      '',
      fns.subtle(this.pending ? `  ${t('settingsui.reset.working')}` : `  ${t('settingsui.reset.hints')}`),
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

/**
 * Swappable shell around the Models category's FW list panel. Provider rows
 * change structurally — a new provider row must appear after an add, and
 * SettingsListPanel.updateValue cannot express that — so the shell swaps in a
 * freshly built list while staying the category list's stable submenu
 * component.
 */
class ModelsCategoryView implements Component {
  private list: SettingsListPanel | undefined

  swap(list: SettingsListPanel): void {
    this.list = list
  }

  invalidate(): void {
    this.list?.invalidate()
  }

  render(width: number): string[] {
    return this.list === undefined ? [] : this.list.render(width)
  }

  handleInput(data: string): void {
    this.list?.handleInput(data)
  }
}



/** Commit a provider (profile + key); resolves with an outcome or none. */
export interface AddProviderOptions {
  /** Catalog entries the picker offers, in directory order. */
  entries: readonly ProviderCatalogEntry[]
  /**
   * When set, skip the picker and open the key editor for this entry
   * directly — the `/login <provider>` fast path. Esc in the editor pops the
   * whole flow.
   */
  initialEntry?: ProviderCatalogEntry
  /**
   * The custom-provider form factory + the entry id that routes to it: the
   * entry with this id opens `customFlow` (the chained hand-declared-route
   * form, see custom-provider.ts) instead of the plain key editor. Passed as
   * an id (not an import) so settings.ts stays free of the cycle
   * custom-provider.ts → settings.ts (EditField).
   */
  customEntryId?: string
  customFlow?: (done: () => void) => Component
  /** Commit the provider: write the profile, then store the key. */
  onCommit: (entry: ProviderCatalogEntry, key: string) => Promise<CommitResult | undefined>
  /** Pop the whole flow (Esc, or right after a successful commit). */
  onExit: () => void
  /** Error sink for writes that fail after the editor already closed. */
  onError: (message: string) => void
}

/**
 * Add-provider flow for the Models category — the terminal counterpart of
 * pi-agent's /login, trimmed to the information a user actually needs: pick
 * a provider from the built-in directory (searchable FW list panel, accent
 * BOLD title), enter exactly one API key, done. The key editor reuses
 * EditField (pending guard, late-error sink); the picker is a searchable
 * SettingsListPanel of the directory entries. `/login <provider>` reuses this
 * flow through `initialEntry`, which swaps the picker for a direct key
 * editor. Exported because /login instantiates it as a top-level overlay.
 */
export class AddProviderFlow implements Component {
  private readonly tui: TUI
  private readonly theme: TuiTheme
  private readonly list: SettingsListPanel | undefined
  /** Direct-launch key editor (`initialEntry` set); replaces the picker list. */
  private readonly direct: Component | undefined
  private readonly empty: boolean
  private readonly onExit: () => void

  constructor(tui: TUI, theme: TuiTheme, options: AddProviderOptions) {
    this.tui = tui
    this.theme = theme
    this.empty = options.entries.length === 0
    this.onExit = options.onExit
    const isCustom = (entry: ProviderCatalogEntry): boolean =>
      options.customFlow !== undefined && entry.id === options.customEntryId
    if (options.initialEntry !== undefined && isCustom(options.initialEntry)) {
      // Direct launch into the custom form: the picker never shows. The
      // form's `done` is a no-op (there is no list submenu to close); its
      // onExit pops the whole flow through the form's own exit path.
      this.direct = options.customFlow!(() => {})
      this.list = undefined
      return
    }
    if (options.initialEntry !== undefined) {
      // Direct launch: the picker never shows. The key editor's `done` is a
      // no-op (there is no list submenu to close); Esc pops the whole flow
      // through onDone → onExit.
      this.direct = this.keyEditor(options.initialEntry, options, () => {})
      this.list = undefined
      return
    }
    this.list = new SettingsListPanel(theme, {
      title: t('settingsui.addProvider.title'),
      rows: options.entries.map(entry => ({
        id: entry.id,
        label: entry.name,
        value: '',
        description: resolveCatalogHint(entry.hint),
        submenu: (_current, done) => isCustom(entry)
          ? options.customFlow!(done)
          : this.keyEditor(entry, options, done),
      })),
      maxVisible: 12,
      enableSearch: true,
      onCancel: () => options.onExit(),
    })
    this.direct = undefined
  }

  /** Key editor for one directory entry; commits through the write chain. */
  private keyEditor(entry: ProviderCatalogEntry, options: AddProviderOptions, done: () => void): Component {
    const ref = deriveKeyRef(entry.id)
    return new EditField(this.tui, {
      title: t('settingsui.addProvider.keyTitle', { name: entry.name }),
      subtitle: t('settingsui.addProvider.keySubtitle', { ref }),
      initial: '',
      // Never echo the key — masked dot row (B2).
      secret: true,
      parse: text => {
        // Unlike an edit of a stored secret, the key is required here: a
        // route with no key address cannot serve a request.
        if (text.trim() === '') return { kind: 'error', error: t('settingsui.addProvider.keyRequired') }
        return { kind: 'value', value: text.trim() }
      },
      onCommit: async outcome => {
        if (outcome.kind !== 'value') return undefined
        return options.onCommit(entry, String(outcome.value))
      },
      // Enter and Esc both leave the flow (the commit is already in the
      // serialized chain either way); the Models list refreshes on the way
      // out so the new row is visible immediately.
      onDone: () => {
        done()
        options.onExit()
      },
      onError: message => options.onError(message),
    }, this.theme)
  }

  invalidate(): void {
    this.direct?.invalidate()
    this.list?.invalidate()
  }

  render(width: number): string[] {
    if (this.direct !== undefined) return this.direct.render(width)
    if (this.empty) {
      const fns = panelThemeFns(this.theme)
      return [
        fns.accent(BOLD + t('settingsui.addProvider.title') + RESET),
        '',
        fns.muted(t('settingsui.addProvider.empty')),
        '',
        fns.subtle(`  ${t('settingsui.escClose')}`),
      ]
    }
    return this.list!.render(width)
  }

  handleInput(data: string): void {
    if (this.empty) {
      if (getKeybindings().matches(data, 'tui.select.cancel')) this.onExit()
      return
    }
    if (this.direct !== undefined) {
      this.direct.handleInput?.(data)
      return
    }
    this.list!.handleInput(data)
  }
}

// -------------------------------------------------------------------- the browser --

/**
 * Commit a provider (profile + key) through the settings + credentials seams —
 * the same two writes the web Models page performs. Shared by the Models
 * category's add flow and the /login command; the caller supplies the profile
 * write (each surface keeps its own serialized settings chain). A missing
 * credentials service still commits the profile (it names the derived ref; the
 * key then has to come from the environment).
 *
 * Outcome surface: a write failure is an `error`; a committed profile whose
 * key could not be stored is an `error` with the manual fallback spelled out
 * (B3); a committed profile with no credentials service at all is a `notice`
 * (success + hint, no ✘ — C11). Resolves `undefined` on a full success.
 */
export async function commitProvider(
  ctx: Context,
  writeProfile: () => Promise<string | undefined>,
  entry: ProviderCatalogEntry,
  key: string,
): Promise<CommitResult | undefined> {
  const ref = deriveKeyRef(entry.id)
  const error = await writeProfile()
  if (error !== undefined) return { error }
  const credentials = ctx.get('credentials') as CredentialSeam | undefined
  if (credentials === undefined) {
    // No credential store in this process — the row is configured and the
    // key must come from the environment; this is a success with a hint,
    // never an error. Enter re-runs the commit idempotently.
    return { notice: t('settingsui.commit.noCredentials', { ref }) }
  }
  try {
    await credentials.set(ref, key)
  } catch (cause) {
    // The profile is committed but the key did not land: the row already
    // counts as configured, so the user needs the manual path. The error
    // stays retryable in place — Enter re-runs the whole commit (B3).
    return {
      error: t('settingsui.commit.keyFailed', {
        cause: cause instanceof Error ? cause.message : String(cause),
        ref,
      }),
    }
  }
  return undefined
}

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
 * committed writes, or -1 when no settings-bearing entry exists (nothing to show).
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
  private readonly settings: SettingsForms
  private readonly restoreFocus: () => void
  private readonly onError: (message: string) => void

  private descriptors: SettingsDescriptor[] = []
  /** Rehydrated schema roots, cached per namespace (schemas never change). */
  private readonly roots = new Map<string, SchemaNode>()
  private readonly changes = { value: 0 }
  private overlay: OverlayHandle | undefined
  private catList: SettingsListPanel | undefined
  private nsList: SettingsListPanel | undefined
  private modelsView: ModelsCategoryView | undefined
  private modelsExit: (() => void) | undefined
  /**
   * Credential refs just stored by the add flow (possibly several in one
   * browser session) — their rows read as key set via the merged env.
   */
  private readonly justStoredRefs = new Set<string>()
  /**
   * Credential-document configuration snapshot, prefetched once per Models
   * category open: ref → a value would resolve (`describe().configured`).
   * Row building stays synchronous — the prefetch only fills this map and
   * re-swaps the list when it settles.
   */
  private readonly credentialConfigured = new Map<string, boolean>()
  private writeChain: Promise<void> = Promise.resolve()
  private closed: Promise<void>
  private closeResolve!: () => void

  constructor(options: OpenSettingsBrowserOptions & { settings: SettingsForms }) {
    this.ctx = options.ctx
    this.tui = options.tui
    this.theme = options.theme
    this.settings = options.settings
    this.restoreFocus = options.restoreFocus
    this.onError = options.onError
    // Assigned here, not as a field initializer: a later field declaration
    // would `defineProperty(…, undefined)` over the promise's resolve.
    this.closed = new Promise<void>(resolve => { this.closeResolve = resolve })
  }

  async open(): Promise<number> {
    this.refresh()
    if (this.categories().length === 0) return -1
    const list = this.categoryList()
    this.catList = list
    // The framed overlay adds 4 rows (borders + spacers) on top of the list;
    // the cap must leave them room or the bottom border is sliced off on
    // small terminals (24 rows: ~15 list rows + 4 frame rows ≤ 19).
    this.overlay = this.tui.showOverlay(wrapFramedOverlay(this.theme, list), { width: '80%', maxHeight: '80%' })
    await this.closed
    return this.changes.value
  }

  private close(): void {
    this.overlay?.hide()
    this.overlay = undefined
    this.catList = undefined
    this.nsList = undefined
    this.modelsView = undefined
    this.modelsExit = undefined
    this.justStoredRefs.clear()
    this.restoreFocus()
    this.closeResolve()
  }

  /** Re-read descriptors (and with them revisions) from the service. */
  private refresh(): void {
    this.descriptors = this.settings.describe()
  }

  private descriptor(ns: string): SettingsDescriptor | undefined {
    return this.descriptors.find(d => d.ns === ns)
  }

  private root(ns: string): SchemaNode | undefined {
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
    return t('settingsui.summary.namespaces', { count: cat.namespaces.length })
  }

  private categoryDescription(cat: SettingsCategory): string {
    return categoryDescription(cat.namespaces, CATEGORY_DESC_MAX)
  }

  private categoryList(): SettingsListPanel {
    const items: SettingsRow[] = this.categories().map(cat => ({
      id: cat.id,
      label: categoryLabel(cat),
      value: this.categorySummary(cat),
      description: this.categoryDescription(cat),
      submenu: cat.id === 'models'
        ? (_current, done) => this.openModelsSubmenu(done)
        : cat.id === 'dsh-tui'
          // Single-namespace category: drill straight into the config
          // fields — no intermediate namespace list repeating the namespace
          // name under the category that names it.
          ? (_current, done) => {
                const section = this.sectionList(THEME_SETTINGS_NAMESPACE, [], () => {
                  this.refreshCategoryList()
                  done()
                }, categoryLabel(cat))
                return section.list
              }
          : (_current, done) => {
                const list = this.namespaceList(
                  categoryLabel(cat),
                  this.descriptors.filter(d => cat.namespaces.includes(d.ns)),
                  done,
                )
                this.nsList = list
                return list
              },
    }))
    return new SettingsListPanel(this.theme, {
      title: t('settingsui.title'),
      rows: items,
      maxVisible: 10,
      enableSearch: true,
      onCancel: () => this.close(),
    })
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
      return t('settingsui.fields.count', { count: Object.keys(root.dict ?? {}).length })
    }
    return formatValue(desc.value)
  }

  private nsDescription(desc: SettingsDescriptor): string {
    const parts = [t('settingsui.ns.applies', { applies: desc.applies })]
    if (desc.user !== undefined) parts.push(t('settingsui.meta.userSet'))
    return parts.join(' · ')
  }

  /** Namespace list for one category; Esc pops back to the category level. */
  private namespaceList(categoryLabel: string, descriptors: readonly SettingsDescriptor[], onExit: () => void): SettingsListPanel {
    const items: SettingsRow[] = descriptors.map(desc => ({
      id: desc.ns,
      label: desc.ns,
      value: this.nsSummary(desc),
      description: this.nsDescription(desc),
      submenu: (_current, done) => {
        const section = this.sectionList(desc.ns, [], () => {
          this.refreshNsList()
          done()
        })
        return section.list
      },
    }))
    return new SettingsListPanel(this.theme, {
      title: categoryLabel,
      rows: items,
      maxVisible: 10,
      enableSearch: true,
      onCancel: () => {
        this.refreshCategoryList()
        onExit()
      },
    })
  }

  private refreshNsList(): void {
    if (this.nsList === undefined) return
    this.refresh()
    for (const desc of this.descriptors) {
      this.nsList.updateValue(desc.ns, this.nsSummary(desc))
    }
  }

  // ------------------------------------------------------------ models category --

  /**
   * The Models category does not expose the raw llm-pi-ai namespace: it
   * lists one row per configured provider (label, model summary, API-key
   * state), keeps dedicated rows for llm-deepseek and agent-default-model
   * (each drilling into its original field editor), and ends with the
   * Add-provider action. The list is rebuilt on every return because adding
   * a provider changes it structurally.
   */
  private openModelsSubmenu(done: () => void): ModelsCategoryView {
    this.modelsExit = () => {
      this.refreshCategoryList()
      done()
    }
    const view = new ModelsCategoryView()
    this.modelsView = view
    view.swap(this.buildModelsList())
    // The status column reads env + just-stored refs synchronously; the
    // credentials document (`.credentials.yaml`) needs one async probe per
    // ref, prefetched here so rows built later show the real state.
    this.prefetchCredentialStatus()
    return view
  }

  /**
   * Probe the credentials service for every provider ref the llm-pi-ai
   * namespace references and remember the outcome. Called when the Models
   * category opens (and again on each re-open, so keys added through other
   * surfaces show up); row building stays synchronous. A settling probe
   * re-swaps the Models list only while the category is still open.
   */
  private prefetchCredentialStatus(): void {
    const credentials = this.ctx.get('credentials') as CredentialSeam | undefined
    if (credentials?.describe === undefined) return
    const view = this.modelsView
    if (view === undefined) return
    const piDesc = this.descriptor(NS_LLM_PI_AI)
    const providers = (piDesc?.value ?? {}) as { providers?: Record<string, unknown> }
    const refs = [...new Set(
      Object.values(providers.providers ?? {})
        .map(p => (
          typeof p === 'object' && p !== null ? (p as { apiKeyEnv?: unknown }).apiKeyEnv : undefined
        ))
        .filter((ref): ref is string => typeof ref === 'string' && ref !== ''),
    )]
    if (refs.length === 0) return
    void Promise.all(refs.map(async ref => {
      try {
        const info = await credentials.describe!(ref)
        this.credentialConfigured.set(ref, info.configured === true)
      } catch {
        // A failing probe must not break the Models view — the row keeps
        // its env-based read.
      }
    })).then(() => {
      if (this.modelsView === view) this.refreshModelsView()
    })
  }

  /**
   * Rebuild the Models list in place after a structural change.
   * `justStoredRefs` survives the rebuild (cleared on close): the merged env
   * marks the just-added rows as configured — the keys are stored in the
   * credentials document, not in process.env — and stays accurate as long as
   * the credentials do. Idempotent: each call re-reads descriptors and swaps
   * one freshly built list.
   */
  private refreshModelsView(): void {
    const view = this.modelsView
    if (view === undefined) return
    this.refresh()
    view.swap(this.buildModelsList())
  }

  /**
   * Environment view handed to providerRowView: process.env, plus every
   * ref the add flow stored this session and every ref the credential probe
   * found configured — both live in the credentials document, not in
   * process.env, so their rows would otherwise read `API key missing`.
   */
  private mergedEnv(): Record<string, string | undefined> {
    const extra: Record<string, string> = {}
    for (const ref of this.justStoredRefs) extra[ref] = 'stored'
    for (const [ref, configured] of this.credentialConfigured) {
      if (configured) extra[ref] = 'stored'
    }
    return Object.keys(extra).length === 0 ? process.env : { ...process.env, ...extra }
  }

  /**
   * Live configurable-provider directory: route key → catalog-served? The
   * llm service owns the catalog distinction for routes the static catalog
   * does not name, so a web-added gateway row still gets an honest summary.
   * Only llm-pi-ai's own directory entries are consulted — another namespace's
   * configurable providers (e.g. llm-deepseek) configure a different surface.
   * Structural face kept local like the credentials seam; absent or failing
   * service degrades to an empty map (rows then fall back to the static
   * catalog).
   */
  private providerDirectory(): ReadonlyMap<string, boolean> {
    const llm = this.ctx.get('llm') as
      | { listConfigurableProviders?: () => Array<{ provider: string; settingsNs?: string; declared?: boolean }> }
      | undefined
    if (llm?.listConfigurableProviders === undefined) return new Map()
    try {
      return new Map(llm.listConfigurableProviders()
        .filter(entry => entry.settingsNs === NS_LLM_PI_AI)
        .map(entry => [entry.provider, entry.declared !== true]))
    } catch {
      return new Map()
    }
  }

  /**
   * Live llm-pi-ai configurable-provider directory entries, or `undefined`
   * when the service is missing or throws (the caller then falls back to the
   * static catalog). Same structural guard as `providerDirectory()`.
   */
  private llmPiAiDirectory(): ReadonlyArray<{ provider: string; declared?: boolean }> | undefined {
    const llm = this.ctx.get('llm') as
      | { listConfigurableProviders?: () => Array<{ provider: string; settingsNs?: string; declared?: boolean }> }
      | undefined
    if (llm?.listConfigurableProviders === undefined) return undefined
    try {
      return llm.listConfigurableProviders()
        .filter(entry => entry.settingsNs === NS_LLM_PI_AI)
        .map(entry => (
          entry.declared !== undefined
            ? { provider: entry.provider, declared: entry.declared }
            : { provider: entry.provider }
        ))
    } catch {
      return undefined
    }
  }

  /** Add-provider picker entries: live directory when available, else the static catalog. */
  private addProviderEntries(configured: ReadonlySet<string>): readonly ProviderCatalogEntry[] {
    const directory = this.llmPiAiDirectory()
    return directory !== undefined && directory.length > 0
      ? directoryProviderEntries(directory, configured)
      : unconfiguredCatalogEntries(configured)
  }

  private buildModelsList(): SettingsListPanel {
    const exit = this.modelsExit ?? (() => {})
    const items: SettingsRow[] = []
    const directory = this.providerDirectory()

      const piDesc = this.descriptor(NS_LLM_PI_AI)
      if (piDesc !== undefined) {
        const providers = (piDesc.value ?? {}) as { providers?: Record<string, unknown> }
        const entries = Object.entries(providers.providers ?? {})
        entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        // Keys stored by the add flow live in the credentials document, not
        // in process.env — merge them all so their rows read as configured
        // right away (a second provider added in the same session too), and
        // merge the prefetched credential state so keys stored earlier (e.g.
        // through the web Models page) read as set instead of missing.
        const env = this.mergedEnv()
      for (const [id, profile] of entries) {
        // The static catalog names the routes the TUI can add; the live llm
        // directory tells catalog-served from hand-declared for every other
        // configured route (e.g. one added through the web Models page), so
        // the summary does not claim `0 models` for a route the catalog
        // actually serves.
        const entry = catalogEntry(id) ?? {
          id,
          name: id,
          hint: '',
          catalogRoute: directory.get(id) ?? false,
        }
        const view = providerRowView(id, entry, profile, env)
        items.push({
          id: `provider:${id}`,
          label: view.label,
          value: view.summary,
          description: view.status,
          // Read-only: the raw llm-pi-ai fields are deliberately not editable
          // here — Enter shows the stored profile, nothing more. A "re-store
          // the key" action (reusing keyEditor's EditField, credentials.set
          // only) was considered for rows whose key never landed (B3) but
          // needs a multi-action submenu component (~60 lines); skipped —
          // the commit failure text names the manual fallback instead.
          submenu: (_current, done) => new ViewerPanel(this.theme, {
            title: `providers.${id}`,
            lines: [
              t('settingsui.models.readonly'),
              '',
              ...JSON.stringify(profile, null, 2).split('\n'),
            ],
            maxLines: 40,
            onClose: done,
          }),
        })
      }
    }

    const deepseekDesc = this.descriptor(NS_LLM_DEEPSEEK)
    if (deepseekDesc !== undefined) {
      items.push({
        id: 'llm-deepseek',
        label: t('settingsui.models.deepseek'),
        value: this.nsSummary(deepseekDesc),
        description: this.nsDescription(deepseekDesc),
        submenu: (_current, done) => {
          const section = this.sectionList(deepseekDesc.ns, [], () => {
            this.refreshModelsView()
            done()
          })
          return section.list
        },
      })
    }

    const agentDesc = this.descriptor(NS_AGENT_DEFAULT_MODEL)
    if (agentDesc !== undefined) {
      items.push({
        id: 'agent-default-model',
        label: t('settingsui.models.defaultModel'),
        value: this.defaultModelSummary(agentDesc),
        description: this.nsDescription(agentDesc),
        submenu: (_current, done) => {
          const section = this.sectionList(agentDesc.ns, [], () => {
            this.refreshModelsView()
            done()
          })
          return section.list
        },
      })
    }

    if (piDesc !== undefined) {
      const providers = (piDesc.value ?? {}) as { providers?: Record<string, unknown> }
      const configured = new Set(Object.keys(providers.providers ?? {}))
      items.push({
        id: '\u0000add-provider',
        label: t('settingsui.models.add'),
        value: '',
        description: t('settingsui.models.addDesc'),
        submenu: (_current, done) => new AddProviderFlow(
          this.tui,
          this.theme,
          {
            entries: this.addProviderEntries(configured),
            onCommit: (entry, key) => this.commitNewProvider(entry, key),
            onExit: () => {
              done()
              this.refreshModelsView()
            },
            onError: message => this.onError(message),
          },
        ),
      })
    }

    return new SettingsListPanel(this.theme, {
      title: t('settingsui.models.title'),
      rows: items,
      maxVisible: 12,
      enableSearch: true,
      // exit() (the modelsExit hook) already refreshes the category list —
      // calling it again here would double-refresh (C8).
      onCancel: () => { exit() },
    })
  }

  /** Value column of the Default model row: provider/model · think level. */
  private defaultModelSummary(desc: SettingsDescriptor): string {
    const value = desc.value as
      | { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
      | undefined
    const provider = value?.provider
    const model = value?.model
    if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
      const effort = value?.reasoningEffort
      return typeof effort === 'string' && effort !== ''
        ? t('settingsui.route.think', { provider, model, effort })
        : `${provider}/${model}`
    }
    return formatValue(desc.value)
  }

  // ------------------------------------------------------------- section levels --

  /**
   * Build the FW list panel for one schema node at `path` of `ns`.
   * `onExit` runs when the list is popped (Esc) — it must refresh the parent
   * level and call the parent's submenu `done()`. `title` overrides the
   * default panel title (the namespace or path spelling) — the TUI category's
   * direct drill uses it to title the fields with the category label instead
   * of the raw namespace name.
   */
  private sectionList(
    ns: string,
    path: string[],
    onExit: () => void,
    title?: string,
  ): { list: SettingsListPanel; refresh: () => void } {
    const root = this.root(ns)
    const desc = this.descriptor(ns)
    const node = root !== undefined && path.length > 0
      ? (nodeAtPath(root, path) ?? root)
      : root
    const rows = node === undefined ? [] : this.buildRows(ns, node, path, desc?.value)
    const refresh = (): void => { this.refreshRows(rows, list) }
    // Reset/add-key rows always lead; the field rows after them collapse
    // into virtual groups at a grouped namespace's root (FIELD_GROUPS).
    const structural = rows.filter(row => row.kind === 'reset' || row.kind === 'addkey')
    const fields = rows.filter(row => row.kind !== 'reset' && row.kind !== 'addkey')
    const slots = path.length === 0 && node?.type === 'object'
      ? slotFieldKeys(ns, fields.map(row => row.path[row.path.length - 1]))
      : undefined
    let fieldItems: SettingsRow[]
    if (slots === undefined) {
      fieldItems = fields.map(row => this.rowItem(row, refresh))
    } else {
      const byKey = new Map(fields.map(row => [row.path[row.path.length - 1], row]))
      fieldItems = []
      for (const slot of slots) {
        if (slot.kind === 'field') {
          const row = byKey.get(slot.key)
          if (row !== undefined) fieldItems.push(this.rowItem(row, refresh))
        } else {
          fieldItems.push(this.fieldGroupRow(ns, slot))
        }
      }
    }
    const items = [...structural.map(row => this.rowItem(row, refresh)), ...fieldItems]
    const list = new SettingsListPanel(this.theme, {
      title: title ?? (path.length === 0 ? ns : path.join('.')),
      rows: items,
      maxVisible: 12,
      enableSearch: true,
      onChange: (id, newValue) => { void this.onCycle(rows, list, id, newValue) },
      onCancel: () => {
        refresh()
        onExit()
      },
    })
    return { list, refresh }
  }

  /**
   * The drill row of one virtual field group (see FIELD_GROUPS): value shows
   * the member count, the description names the members, and Enter opens the
   * group's field list.
   */
  private fieldGroupRow(ns: string, slot: { kind: 'group'; group: FieldGroupDef; members: readonly string[] }): SettingsRow {
    const label = resolveFieldGroupLabel(slot.group.labelKey)
    return {
      id: `group:${slot.group.id}`,
      label,
      value: `{${t('settingsui.fields.count', { count: slot.members.length })}}`,
      description: slot.members.join(' · '),
      submenu: (_current, done) => {
        const child = this.fieldGroupList(ns, label, slot.members, done)
        return child.list
      },
    }
  }

  /**
   * Field list of one virtual group: the member schema fields exactly as
   * they would render flat, with the same cycle/input editing — minus the
   * reset/add-key rows (a virtual group has no single path to reset; the
   * namespace level still resets the whole subtree).
   */
  private fieldGroupList(
    ns: string,
    label: string,
    members: readonly string[],
    onExit: () => void,
  ): { list: SettingsListPanel; refresh: () => void } {
    const root = this.root(ns)
    const rows: RowSpec[] = []
    for (const name of members) {
      const child = root !== undefined && root.type === 'object' ? root.dict?.[name] : undefined
      if (child === undefined || fieldMeta(child).hidden === true) continue
      rows.push(this.fieldRow(ns, child, [name], name))
    }
    const refresh = (): void => { this.refreshRows(rows, list) }
    const items = rows.map(row => this.rowItem(row, refresh))
    const list = new SettingsListPanel(this.theme, {
      title: label,
      rows: items,
      maxVisible: 12,
      enableSearch: true,
      onChange: (id, newValue) => { void this.onCycle(rows, list, id, newValue) },
      onCancel: () => {
        refresh()
        onExit()
      },
    })
    return { list, refresh }
  }

  private buildRows(ns: string, node: SchemaNode, path: string[], value: unknown): RowSpec[] {
    const rows: RowSpec[] = []
    if (node.type === 'object' || node.type === 'dict') {
      rows.push({
        id: '\u0000reset',
        ns,
        path,
        label: path.length === 0
          ? t('settingsui.reset.namespace')
          : t('settingsui.reset.path', { path: path.join('.') }),
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
          label: t('settingsui.addKey.label'),
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

  private fieldRow(ns: string, node: SchemaNode, path: string[], label: string): RowSpec {
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
    if (secret) return value === undefined || value === null || value === '' ? t('settingsui.value.unset') : '••••••'
    switch (kind) {
      case 'drill': {
        if (node.type === 'object') return `{${t('settingsui.fields.count', { count: Object.keys(node.dict ?? {}).length })}}`
        if (node.type === 'dict') {
          const entries = Object.keys((value ?? {}) as Record<string, unknown>)
          return entries.length === 1
            ? t('settingsui.dict.one', { count: entries.length })
            : t('settingsui.dict.many', { count: entries.length })
        }
        return formatValue(value)
      }
      default: return formatValue(value)
    }
  }

  /** SettingsRow for one row; drill/input/reset/addkey attach their submenus. */
  private rowItem(row: RowSpec, refresh: () => void): SettingsRow {
    const base: SettingsRow = {
      id: row.id,
      label: row.label,
      value: row.display,
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
        submenu: (_current, done) => new ViewerPanel(this.theme, {
          title: row.path.join('.'),
          lines: [
            t('settingsui.models.readonly'),
            '',
            ...JSON.stringify(row.value, null, 2).split('\n'),
          ],
          maxLines: 40,
          onClose: done,
        }),
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
  private refreshRows(rows: RowSpec[], list: SettingsListPanel): void {
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
  private write(ns: string, ops: readonly SettingsPathOp[]): Promise<string | undefined> {
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

  /**
   * Add-provider commit: write the llm-pi-ai profile through the serialized
   * settings chain (revision read at execution time), then store the key
   * through the credentials seam — the same two writes the web Models page
   * performs. See `commitProvider` for the outcome surface; on success the
   * browser also records the ref so the Models rows read as key set and
   * rebuilds the list (B5).
   */
  private async commitNewProvider(entry: ProviderCatalogEntry, key: string): Promise<CommitResult | undefined> {
    const result = await commitProvider(this.ctx, () => this.write(NS_LLM_PI_AI, [{
      op: 'set',
      path: ['providers', entry.id],
      value: providerProfileFor(entry),
    }]), entry, key)
    if (result !== undefined) return result
    this.justStoredRefs.add(deriveKeyRef(entry.id))
    // Settle-time rebuild: if Esc closed the editor while the write was in
    // flight, the onExit refresh already ran against stale descriptors and
    // nothing else would repaint the new row. Idempotent (B5); on the normal
    // path the onExit refresh repeats it harmlessly.
    if (this.modelsView !== undefined) this.refreshModelsView()
    return undefined
  }

  private onCycle(rows: RowSpec[], list: SettingsListPanel, id: string, newValue: string): void {
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
    // dsh-tui.language: pick from the discovered locales instead of typing a
    // raw id — the same panel the /language command opens, writing through
    // the standard mutate path (the watch hook applies the language live).
    if (row.ns === THEME_SETTINGS_NAMESPACE && row.path.length === 1 && row.path[0] === 'language') {
      return this.languageSubmenu(row, refresh, done)
    }
    const meta = fieldMeta(row.node)
    const initial = row.secret === true || row.value === undefined || row.value === null
      ? ''
      : String(row.value)
    return new EditField(this.tui, {
      title: row.path.join('.'),
      subtitle: row.secret === true
        ? t('settingsui.edit.secret')
        : t('settingsui.edit.current', {
            value: row.display + (meta.required === true ? ` · ${t('settingsui.meta.required')}` : ''),
          }),
      initial,
      // role('secret') rows get the masked dot-row renderer too (B2).
      secret: row.secret === true,
      parse: text => this.parseFor(row, text),
      onCommit: outcome => this.commitInput(row, refresh, outcome),
      onDone: done,
      onError: message => this.onError(message),
    }, this.theme)
  }

  /**
   * The language picker as the dsh-tui.language edit submenu: Enter picks
   * and commits through the standard mutate path, Esc pops back. A failed
   * write keeps the picker open with the error on the status line (the
   * EditField ✘ contract, transplanted onto a table).
   */
  private languageSubmenu(row: RowSpec, refresh: () => void, done: () => void): Component {
    let status: string | undefined
    // A pick is single-shot: the commit is async, and a second Enter landing
    // before it resolves would close the submenu twice — the second close
    // returning to the LIST would then re-open the picker on the same row.
    let settled = false
    // Esc may close the picker while a commit is in flight (the EditField
    // contract); a late failure then has no status line to land on and goes
    // through onError instead of vanishing.
    let closed = false
    const cancel = (): void => { closed = true; done() }
    return languagePickerPanel(
      this.theme,
      typeof row.value === 'string' ? row.value : '',
      async picked => {
        if (settled) return
        settled = true
        const result = await this.commitInput(row, refresh, { kind: 'value', value: picked })
        if (result?.error !== undefined) {
          if (closed) {
            this.onError(result.error)
            return
          }
          // The write failed with the picker still open — re-arm for a retry.
          settled = false
          status = t('sel.status.saveFailed', { message: result.error })
          this.tui.requestRender()
          return
        }
        if (!closed) done()
      },
      cancel,
      () => status,
    )
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
          ? { kind: 'error', error: t('settingsui.parse.type', { type: row.node.type }) }
          : this.parseFor({ ...row, node: row.node.inner }, text)
      default: return { kind: 'error', error: t('settingsui.parse.type', { type: row.node.type }) }
    }
  }

  private async commitInput(row: RowSpec, refresh: () => void, outcome: ParseOutcome): Promise<CommitResult | undefined> {
    if (outcome.kind !== 'value' && outcome.kind !== 'unset') return undefined
    const ops: SettingsPathOp[] = outcome.kind === 'unset'
      ? [{ op: 'unset', path: row.path }]
      : [{ op: 'set', path: row.path, value: outcome.value }]
    const error = await this.write(row.ns, ops)
    if (error === undefined) refresh()
    return error === undefined ? undefined : { error }
  }

  /** Add-key editor for dict sections; commits a default-valued entry. */
  private addKeySubmenu(row: RowSpec, refresh: () => void, done: () => void): Component {
    const inner = row.node.inner ?? row.node
    const existing = (getPath(this.descriptor(row.ns)?.value, row.path) ?? {}) as Record<string, unknown>
    return new EditField(this.tui, {
      title: t('settingsui.addKey.title', { path: row.path.length === 0 ? '…' : row.path.join('.') }),
      subtitle: t('settingsui.addKey.subtitle', { default: formatValue(defaultValueFor(inner)) }),
      initial: '',
      parse: text => {
        const key = text.trim()
        if (key === '') return { kind: 'error', error: t('settingsui.addKey.empty') }
        if (key in existing) return { kind: 'error', error: t('settingsui.addKey.exists', { key }) }
        return { kind: 'value', value: key }
      },
      onCommit: async outcome => {
        if (outcome.kind !== 'value') return undefined
        const key = String(outcome.value)
        const error = await this.write(row.ns, [{ op: 'set', path: [...row.path, key], value: defaultValueFor(inner) }])
        if (error === undefined) refresh()
        return error === undefined ? undefined : { error }
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
        ? t('settingsui.reset.ns', { ns: row.ns })
        : t('settingsui.reset.path', { path: row.path.join('.') }),
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
