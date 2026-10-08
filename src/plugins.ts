/**
 * The /plugins manager — the terminal counterpart of the web profile's
 * plugin-management page, over the SAME base service (`ctx.pluginManager`,
 * dsh-plugin-manager): bundles from `listBundles()`, Enter toggles
 * `setBundleEnabled`, `d` uninstalls through `removeBundle` behind a
 * confirm, `i` installs a spec (`inspect` preview → `installBundle`).
 * `/` engages the shared TablePanel filter; every mutation reloads the
 * list and the ChangeResult surfaces on the in-panel status line
 * (`applied` / `restart-required` / `overridden` / `failed`…).
 *
 * Pure row/notice builders live at the top (unit-testable); the panel is
 * the PanelHost glue, exercised on a terminal (same split as btw-overlay).
 */

import { getKeybindings, type Component, type TUI } from '@earendil-works/pi-tui'
import { t } from './i18n/index.ts'
import { EditField } from './settings.ts'
import { autoColumns, panelThemeFns, PanelHost, TablePanel, type TablePanelOptions } from './panels.ts'
import { BOLD, RESET, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'

/**
 * Structural face of one bundle from `pluginManager.listBundles()` — the
 * fields this panel renders. Kept local so the plugin never hard-depends on
 * the `@deepseek-ai/dsh-plugin-manager` package at typecheck time.
 */
export interface PluginBundleInfo {
  name: string
  version?: string
  description?: string
  enabled: boolean
  /** Profile-owned dependency (`true`) vs installation-supplied optional. */
  installed: boolean
  optional: boolean
  removable: boolean
  readOnlyReason?: 'management-required' | 'unaddressable'
  error?: { message?: string } & Record<string, unknown>
}

/** Structural face of `pluginManager`'s ChangeResult. */
export interface PluginChangeResult {
  changed: boolean
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  target: string
  error?: { message?: string } & Record<string, unknown>
}

/** Structural face of `pluginManager.inspect()`'s answer. */
export type PluginInspection =
  | { status: 'accepted'; name?: string; version?: string; description?: string; bundle: boolean | null }
  | { status: 'refused'; problem: string; reason: string }

/** The service surface the panel drives (base bundle, keyed `pluginManager`). */
export interface PluginManagerSeam {
  listBundles(): Promise<readonly PluginBundleInfo[]>
  setBundleEnabled(name: string, enabled: boolean): Promise<PluginChangeResult>
  removeBundle(name: string): Promise<PluginChangeResult>
  installBundle(spec: string, options?: { enabled?: boolean }): Promise<PluginChangeResult>
  inspect(spec: string): Promise<PluginInspection>
}

// ------------------------------------------------------------ pure builders --

/** One rendered row of the plugin table. */
export interface PluginRowView {
  name: string
  /** Name + @version (the PLUGIN column). */
  label: string
  /** STATE column text (on/off/not installed + badges). */
  state: string
  /** Enter may toggle (not read-only, no load error). */
  toggleable: boolean
  removable: boolean
}

/** STATE text of one bundle: on/off/not-installed plus error/readonly badges. */
export function bundleStateText(bundle: PluginBundleInfo): string {
  const base = !bundle.installed && bundle.optional
    ? t('plugins.state.available')
    : bundle.enabled
      ? t('plugins.state.on')
      : t('plugins.state.off')
  if (bundle.error !== undefined) return `${base} ${t('plugins.state.error')}`
  if (bundle.readOnlyReason !== undefined) return `${base} ${t('plugins.state.readOnly')}`
  return base
}

/**
 * Bundle rows for the table: alphabetical by name (the web page groups
 * Official/Installed cards; a flat sorted table reads better in a terminal
 * and the `/` filter narrows it anyway).
 */
export function pluginRowViews(bundles: readonly PluginBundleInfo[]): PluginRowView[] {
  return [...bundles]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(bundle => ({
      name: bundle.name,
      label: bundle.version !== undefined && bundle.version !== '' ? `${bundle.name}@${bundle.version}` : bundle.name,
      state: bundleStateText(bundle),
      toggleable: bundle.readOnlyReason === undefined && bundle.error === undefined,
      removable: bundle.removable,
    }))
}

/**
 * Status-line wording of one ChangeResult — the application outcome the
 * web page toasts, phrased for the TUI status row.
 */
export function pluginChangeNotice(result: PluginChangeResult): string {
  const suffix = result.error?.message !== undefined && result.error.message !== ''
    ? `: ${result.error.message}`
    : ''
  switch (result.application) {
    case 'applied': return t('plugins.notice.applied', { target: result.target })
    case 'restart-required': return t('plugins.notice.restartRequired', { target: result.target })
    case 'overridden': return t('plugins.notice.overridden', { target: result.target })
    case 'failed': return t('plugins.notice.failed', { target: result.target }) + suffix
    case 'cancelled': return t('plugins.notice.cancelled')
  }
}

// ---------------------------------------------------------------- the panel --

/** Options for the /plugins manager entry point. */
export interface OpenPluginsPanelOptions {
  tui: TUI
  theme: TuiTheme
  /** The pluginManager service (already narrowed to the seam); undefined = unavailable. */
  manager?: PluginManagerSeam
  restoreFocus: () => void
  /** Esc exit — closes the hosting overlay (wired by openPluginsPanel). */
  onExit?: () => void
  /** Error sink for failures that outlive the panel (transcript). */
  onError: (message: string) => void
}

/**
 * One-line confirm (Enter/Esc) for destructive plugin actions — the
 * ConfirmReset shape with plugin copy.
 */
class PluginConfirm implements Component {
  private readonly theme: TuiTheme
  private readonly label: string
  private readonly body: readonly string[]
  private readonly onConfirm: () => void
  private readonly onCancel: () => void

  constructor(theme: TuiTheme, label: string, body: readonly string[], onConfirm: () => void, onCancel: () => void) {
    this.theme = theme
    this.label = label
    this.body = body
    this.onConfirm = onConfirm
    this.onCancel = onCancel
  }

  invalidate(): void {}

  render(width: number): string[] {
    const fns = panelThemeFns(this.theme)
    const lines = [fns.accent(BOLD + clipToWidth(this.label, width) + RESET)]
    lines.push('')
    for (const line of this.body) lines.push(fns.muted(clipToWidth(`  ${line}`, width)))
    lines.push('')
    lines.push(fns.subtle(clipToWidth(t('plugins.confirm.hints'), width)))
    return lines
  }

  handleInput(data: string): void {
    const kb = getKeybindings()
    if (kb.matches(data, 'tui.select.confirm')) this.onConfirm()
    else if (kb.matches(data, 'tui.select.cancel')) this.onCancel()
  }
}

/**
 * The manager panel: a filterable bundle table plus in-place swap modes
 * (install editor, install preview, uninstall confirm) and a status line
 * carrying busy state and ChangeResult notices.
 */
class PluginsPanel implements Component {
  private readonly tui: TUI
  private readonly theme: TuiTheme
  private readonly manager: PluginManagerSeam
  private readonly onExit: () => void
  private readonly onError: (message: string) => void
  private bundles: readonly PluginBundleInfo[] = []
  private query = ''
  /** The active table; rebuilt on every reload/keep-focus path. */
  private table: TablePanel<PluginRowView>
  private tableOptions: TablePanelOptions<PluginRowView>
  /** In-place swap mode (install editor / preview / uninstall confirm). */
  private mode: Component | undefined
  /** Status line: busy text or a change notice (auto-clearing). */
  private status: string | undefined
  private statusTimer: ReturnType<typeof setTimeout> | undefined
  private busy = false
  private readonly rerender = (): void => { this.tui.requestRender() }

  constructor(options: OpenPluginsPanelOptions) {
    if (options.manager === undefined) throw new Error('pluginManager service is required')
    this.tui = options.tui
    this.theme = options.theme
    this.manager = options.manager
    this.onExit = options.onExit ?? (() => {})
    this.onError = options.onError
    this.tableOptions = {
      title: t('plugins.title'),
      columns: [],
      rows: [],
      renderCell: (row, column) => (column.key === 'state' ? row.state : row.label),
      isSelectable: () => true,
      onSelect: row => { void this.toggle(row) },
      onCancel: () => this.onExit(),
      footer: t('plugins.footer'),
      status: () => this.status,
      emptyHint: t('plugins.empty'),
      filter: {
        getQuery: () => this.query,
        onQueryChange: next => {
          this.query = next
          this.rebuild()
        },
      },
      shortcuts: {
        i: () => { void this.beginInstall() },
        d: () => { void this.confirmRemove(this.table.selectedRow()) },
      },
    }
    this.table = new TablePanel<PluginRowView>(this.theme, this.tableOptions)
  }

  invalidate(): void {
    this.mode?.invalidate()
    this.table.invalidate()
  }

  /** PanelHost teardown hook: drop any pending status-clear timer. */
  dispose(): void {
    clearTimeout(this.statusTimer)
  }

  render(width: number): string[] {
    return (this.mode ?? this.table).render(width)
  }

  handleInput(data: string): void {
    // A running mutation already holds the write path — extra keys must not
    // stack a second one (the notice would lie about the first).
    if (this.busy) return
    const target = this.mode ?? this.table
    target.handleInput?.(data)
  }

  /** Initial load; returns an error string when the listing fails. */
  async load(): Promise<string | undefined> {
    try {
      this.bundles = await this.manager.listBundles()
    } catch (cause) {
      return t('plugins.listFailed', { message: cause instanceof Error ? cause.message : String(cause) })
    }
    this.rebuild()
    return undefined
  }

  /** Rebuild the table rows from the current bundles + filter. */
  private rebuild(keepName?: string): void {
    const rows = pluginRowViews(this.bundles).filter(row =>
      row.label.toLowerCase().includes(this.query.trim().toLowerCase())
      || row.name.toLowerCase().includes(this.query.trim().toLowerCase()))
    this.tableOptions.columns = autoColumns(
      [
        { key: 'plugin', title: t('plugins.col.plugin'), cap: 36 },
        { key: 'state', title: t('plugins.col.state') },
      ],
      rows,
      (row, key) => (key === 'state' ? row.state : row.label),
    )
    this.tableOptions.rows = rows
    const followed = keepName !== undefined && this.table.focusRow(row => row.name === keepName)
    if (!followed && this.query.trim() !== '') this.table.focusRow(() => true)
    else if (!followed) this.table.resyncCursor()
  }

  /** Show one status line; busy text persists, notices auto-clear. */
  private flash(message: string, autoClearMs?: number): void {
    this.status = message
    clearTimeout(this.statusTimer)
    if (autoClearMs !== undefined) {
      this.statusTimer = setTimeout(() => {
        this.status = undefined
        this.rerender()
      }, autoClearMs)
    }
    this.rerender()
  }

  /** Reload the bundle list, keeping the cursor on `keepName` when present. */
  private async reload(keepName?: string): Promise<void> {
    try {
      this.bundles = await this.manager.listBundles()
    } catch (cause) {
      this.onError(t('plugins.listFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    }
    this.rebuild(keepName)
    this.rerender()
  }

  /** Enter: toggle the bundle on/off (guarded), then reload + notice. */
  private async toggle(row: PluginRowView | undefined): Promise<void> {
    if (row === undefined || !row.toggleable) {
      if (row !== undefined) this.flash(t('plugins.notice.readOnly', { name: row.name }), 4000)
      return
    }
    const bundle = this.bundles.find(entry => entry.name === row.name)
    if (bundle === undefined) return
    this.busy = true
    this.flash(t('plugins.busy.toggling', { name: row.name }))
    try {
      const result = await this.manager.setBundleEnabled(row.name, !bundle.enabled)
      this.flash(pluginChangeNotice(result), 6000)
    } catch (cause) {
      this.flash(t('plugins.notice.failed', {
        target: row.name,
      }) + `: ${cause instanceof Error ? cause.message : String(cause)}`, 6000)
    }
    this.busy = false
    await this.reload(row.name)
  }

  /** `d`: uninstall behind a one-line confirm. */
  private async confirmRemove(row: PluginRowView | undefined): Promise<void> {
    if (row === undefined) return
    if (!row.removable) {
      this.flash(t('plugins.notice.notRemovable', { name: row.name }), 4000)
      return
    }
    const name = row.name
    this.mode = new PluginConfirm(
      this.theme,
      t('plugins.confirm.removeTitle', { name }),
      [t('plugins.confirm.removeBody')],
      () => { void this.remove(name) },
      () => { this.mode = undefined; this.rerender() },
    )
    this.rerender()
  }

  private async remove(name: string): Promise<void> {
    this.mode = undefined
    this.busy = true
    this.flash(t('plugins.busy.removing', { name }))
    try {
      const result = await this.manager.removeBundle(name)
      this.flash(pluginChangeNotice(result), 6000)
    } catch (cause) {
      this.flash(t('plugins.notice.failed', { target: name }) + `: ${cause instanceof Error ? cause.message : String(cause)}`, 6000)
    }
    this.busy = false
    await this.reload()
  }

  /** `i`: spec editor → inspect preview → confirm → install. */
  private async beginInstall(): Promise<void> {
    this.mode = new EditField(this.tui, {
      title: t('plugins.install.title'),
      subtitle: t('plugins.install.hint'),
      initial: '',
      parse: text => (text.trim() === ''
        ? { kind: 'error' as const, error: t('plugins.install.empty') }
        : { kind: 'value' as const, value: text.trim() }),
      onCommit: async outcome => {
        if (outcome.kind !== 'value') return undefined
        // Fire-and-forget: closing the editor immediately hands the screen
        // back to the table, whose status line carries the install phases.
        void this.runInstall(String(outcome.value))
        return undefined
      },
      // Enter and Esc both return to the table; the install (when started)
      // continues on the status line.
      onDone: () => { this.mode = undefined; this.rerender() },
      onError: message => this.onError(message),
    }, this.theme)
    this.rerender()
  }

  private async runInstall(spec: string): Promise<void> {
    this.mode = undefined
    this.busy = true
    this.flash(t('plugins.busy.inspecting', { spec }))
    let inspection: PluginInspection
    try {
      inspection = await this.manager.inspect(spec)
    } catch (cause) {
      this.busy = false
      this.flash(t('plugins.install.inspectFailed', {
        message: cause instanceof Error ? cause.message : String(cause),
      }), 6000)
      return
    }
    if (inspection.status === 'refused') {
      this.busy = false
      this.flash(t('plugins.install.refused', {
        problem: inspection.problem,
        reason: inspection.reason,
      }), 8000)
      return
    }
    this.flash(t('plugins.busy.installing', { spec }))
    try {
      const result = await this.manager.installBundle(spec, { enabled: true })
      this.flash(pluginChangeNotice(result), 8000)
    } catch (cause) {
      this.flash(t('plugins.notice.failed', { target: spec }) + `: ${cause instanceof Error ? cause.message : String(cause)}`, 8000)
    }
    this.busy = false
    await this.reload()
  }
}

/**
 * Open the /plugins manager. Returns `undefined` once the panel closed
 * normally, or an error string when plugin management is unavailable in
 * this profile (no pluginManager service) or the first listing failed —
 * the caller turns that into the command's error reply.
 */
export async function openPluginsPanel(options: OpenPluginsPanelOptions): Promise<string | undefined> {
  if (options.manager === undefined) return t('plugins.unavailable')
  const restoreFocus = options.restoreFocus
  // The panel's Esc exit closes the host BEFORE refocusing — the shared
  // overlay contract (a half-torn-down overlay must not strand focus).
  const exit = (): void => {
    host.close()
    restoreFocus()
  }
  // A half-mounted overlay must not strand the keyboard (PanelHost calls
  // onError first, then we settle through the same exit path).
  const host = new PanelHost(options.tui, options.theme, () => {
    restoreFocus()
  })
  const panel = new PluginsPanel({
    ...options,
    onExit: exit,
  })
  const loadError = await panel.load()
  if (loadError !== undefined) {
    restoreFocus()
    return loadError
  }
  host.open(panel, '75%', '80%')
  return undefined
}
