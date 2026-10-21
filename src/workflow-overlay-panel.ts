/**
 * The workflow overlay panel — the generic DRIVER behind ticket 07's Graph
 * mode. All rendering logic lives in the dsh-workflow package (its overlay
 * state machine, imported through the widget manifest written at
 * `$DSH_HOME/tui-widgets/manifest.json`); this module only detects the
 * manifest, resolves the freshest run, pumps keyboard events into the state
 * machine, and slices the viewport. Zero workflow semantics here.
 *
 * @module @aiwayds/dsh-tui-pi/workflow-overlay-panel
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getKeybindings, matchesKey, type Component, type TUI } from '@earendil-works/pi-tui'
import { PanelHost, panelThemeFns } from './panels.ts'
import type { TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'

/** The manifest dsh-workflow writes next to its widget lines file. */
export interface WorkflowOverlayManifest {
  /** Absolute path of the state-machine module (a bare specifier would resolve from OUR node_modules). */
  module: string
  exportName?: string
}

/** Read the seam manifest, or undefined when dsh-workflow is not installed. */
export function readWorkflowOverlayManifest(): WorkflowOverlayManifest | undefined {
  const dir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const path = join(dir, 'tui-widgets', 'manifest.json')
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { module?: string; exportName?: string }
    if (typeof manifest.module !== 'string' || manifest.module === '') return undefined
    return { module: manifest.module, ...(manifest.exportName !== undefined ? { exportName: manifest.exportName } : {}) }
  } catch {
    return undefined
  }
}

/** The freshest run directory under `<cwd>/.dsh/workflow-runs` (mtime newest with a run.json). */
export function latestWorkflowRunDir(cwd: string): string | undefined {
  const root = join(cwd, '.dsh', 'workflow-runs')
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return undefined
  }
  let best: { dir: string; mtime: number } | undefined
  for (const entry of entries) {
    const runJson = join(root, entry, 'run.json')
    try {
      if (!existsSync(runJson)) continue
      const mtime = statSync(runJson).mtimeMs
      if (best === undefined || mtime > best.mtime) best = { dir: join(root, entry), mtime }
    } catch {
      /* skip */
    }
  }
  return best?.dir
}

/** Visible row budget of the overlay body (the rest scrolls via the overlay's offset). */
const MAX_ROWS = 16

/** The contract this driver expects from the dsh-workflow state machine. */
interface OverlayStateMachine {
  title(): string
  segmentsRow(): string
  renderLine(index: number, width: number): string
  lineCount(width: number): number
  onKey(key: string): 'handled' | 'passthrough'
  scrollOffset(): number
}

class WorkflowOverlayPanel implements Component {
  private notice: string | undefined

  private readonly theme: TuiTheme
  private readonly overlay: OverlayStateMachine
  private readonly requestRenderFn: () => void
  private readonly closeFn: () => void

  constructor(theme: TuiTheme, overlay: OverlayStateMachine, requestRender: () => void, close: () => void) {
    this.theme = theme
    this.overlay = overlay
    this.requestRenderFn = requestRender
    this.closeFn = close
  }

  invalidate(): void { /* per-frame stateless */ }

  render(width: number): string[] {
    const fns = panelThemeFns(this.theme)
    const lines: string[] = [fns.accent(clipToWidth(this.overlay.title(), width))]
    const segments = this.overlay.segmentsRow()
    if (segments !== '') lines.push(fns.subtle(clipToWidth(segments, width)))
    lines.push('')

    const total = this.overlay.lineCount(width)
    const offset = Math.min(this.overlay.scrollOffset(), Math.max(0, total - MAX_ROWS))
    const visible = Math.min(MAX_ROWS, total - offset)
    for (let i = 0; i < visible; i++) {
      lines.push(clipToWidth(this.overlay.renderLine(offset + i, width - 2), width - 2))
    }
    if (total > visible) {
      lines.push(fns.subtle(clipToWidth(`· ${offset + 1}-${offset + visible} / ${total} · ↑↓ scroll`, width)))
    }
    if (this.notice !== undefined) lines.push(fns.subtle(clipToWidth(this.notice, width)))
    lines.push(fns.subtle(clipToWidth('Tab segments · ↑↓ scroll · ←→ fold · f follow · q close', width)))
    return lines
  }

  handleInput(data: string): void {
    this.notice = undefined
    const kb = getKeybindings()
    if (kb.matches(data, 'tui.select.cancel') || data.toLowerCase() === 'q') {
      this.closeFn()
      return
    }
    let key: string | undefined
    if (kb.matches(data, 'tui.select.up')) key = 'up'
    else if (kb.matches(data, 'tui.select.down')) key = 'down'
    else if (data === '\t' || data.toLowerCase() === 'tab') key = 'tab'
    else if (data.toLowerCase() === 'shift+tab' || data === '\x1b[Z') key = 'shift+tab'
    else if (data.toLowerCase() === 'left') key = 'left'
    else if (data.toLowerCase() === 'right') key = 'right'
    else if (data.toLowerCase() === 'f') key = 'f'
    if (key === undefined) return
    void this.overlay.onKey(key)
    this.requestRenderFn()
  }
}

/**
 * Open the workflow overlay. Returns false when the manifest is missing, the
 * module fails to load, or the run directory holds no snapshot — the caller
 * surfaces a notice instead of an empty panel.
 */
export async function openWorkflowOverlayPanel(
  tui: TUI,
  theme: TuiTheme,
  deps: {
    manifest: WorkflowOverlayManifest
    runDir: string
    locale: 'en' | 'zh'
    restoreFocus(): void
  },
): Promise<boolean> {
  let buildOverlay: (runDir: string, locale: 'en' | 'zh') => unknown
  try {
    const mod = (await import(pathToFileURL(deps.manifest.module).href)) as Record<string, unknown>
    const fn = mod[deps.manifest.exportName ?? 'buildOverlay']
    if (typeof fn !== 'function') return false
    buildOverlay = fn as typeof buildOverlay
  } catch {
    return false
  }
  const overlay = buildOverlay(deps.runDir, deps.locale) as OverlayStateMachine | null
  if (overlay === null) return false

  return new Promise(resolve => {
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      resolve(true)
    }
    const host = new PanelHost(tui, theme, () => {
      deps.restoreFocus()
      settle()
    })
    const finish = (): void => {
      host.close()
      deps.restoreFocus()
      settle()
    }
    const panel = new WorkflowOverlayPanel(theme, overlay, () => tui.requestRender(), finish)
    host.open(panel, '70%', '70%')
  })
}
