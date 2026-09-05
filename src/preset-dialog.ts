/**
 * The preset-switch confirmation dialog + the switch orchestration.
 *
 * Switching presets is an EXPLICIT action with a visible cost: the preset is
 * baked into a session at creation time, so applying a new selection means
 * starting a NEW session — the current one is detached (and stays resumable
 * via /resume). Whenever a live session exists, the switch therefore goes
 * through this confirmation gate first (mirroring the /resume repair
 * dialog's pure-reducer split, src/repair-dialog.ts, so the decision matrix
 * stays unit-testable without a terminal); on a fresh TUI without a session
 * there is nothing to leave behind and the selection applies directly.
 *
 * The dialog offers exactly three ways out: FORK the current conversation
 * into the new session on the preset (context weight included), start FRESH
 * (an empty session on the preset), or CANCEL. Title/body wording
 * distinguishes a switch to a different preset from a restart on the
 * current one. ↑↓ moves the selection, `1`/`2`/`3` select directly, Enter
 * confirms, Esc = cancel. Framing/focus follow the shared overlay contract:
 * PanelHost framing, close re-focuses the CURRENT editor instance through
 * `restoreFocus`.
 */

import { getKeybindings, type Component, type TUI } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PresetEntry, PresetState } from './preset.ts'
import { PanelHost, panelThemeFns } from './panels.ts'
import { BOLD, RESET, ansiFg, type TuiTheme } from './theme/index.ts'
import { clipToWidth, wrapText } from './text.ts'

/** The three choices in display order; index 0 is preselected. */
export const PRESET_CONFIRM_OPTION_IDS: ReadonlyArray<'fork' | 'fresh' | 'cancel'> = ['fork', 'fresh', 'cancel']

/**
 * How the dialog words one target: a move to a DIFFERENT preset vs a
 * restart on the already-selected one. The three outcomes are the same
 * either way — only the labels and the title change.
 */
export interface PresetConfirmWording {
  title: string
  /** The fork option's row text (carries the conversation). */
  fork: string
  /** The fresh option's row text (empty new session). */
  fresh: string
  /** The first body point (what "applying" means here). */
  firstPoint: string
}

/** The dialog wording for `name`: `restart` marks a re-selection of the current preset. */
export function presetConfirmWording(name: string, restart: boolean): PresetConfirmWording {
  return restart
    ? {
        title: `● Restart session on ${name}?`,
        fork: `Fork & restart — new session on ${name}, carrying this conversation`,
        fresh: `Restart now — new empty session on ${name}`,
        firstPoint: `Restarting starts a NEW session on ${name}.`,
      }
    : {
        title: `● Switch preset to ${name}?`,
        fork: `Fork & switch — new session on ${name}, carrying this conversation`,
        fresh: `Fresh start — new empty session on ${name}`,
        firstPoint: `Switching starts a NEW session on ${name}.`,
      }
}

/** The fixed option rows for one wording. */
export function presetConfirmOptions(wording: PresetConfirmWording): ReadonlyArray<{ id: 'fork' | 'fresh' | 'cancel'; text: string }> {
  return [
    { id: 'fork', text: wording.fork },
    { id: 'fresh', text: wording.fresh },
    { id: 'cancel', text: 'Cancel — stay on the current session' },
  ]
}

/** Accent-BOLD dialog title. */
export function presetConfirmTitle(wording: PresetConfirmWording): string {
  return wording.title
}

/**
 * The fixed body points, one entry per bullet — each wrapped to the terminal
 * width by the panel before painting.
 */
export function presetConfirmBody(wording: PresetConfirmWording): readonly string[] {
  return [
    wording.firstPoint,
    'Fork carries this conversation into the new session (compacted context included) — fresh starts empty.',
  ]
}

/** Footer hint — hardcoded like every other panel footer (English-only). */
export const PRESET_CONFIRM_FOOTER = '↑↓ select · 1/2/3 pick · Enter confirm · Esc cancel'

/** Pure dialog state: which row is highlighted, and the terminal outcome. */
export interface PresetConfirmState {
  selected: number
  /**
   * Set once by a terminal key: `'confirm'` (Enter on a selection) or
   * `'cancel'` (Esc). Further input is ignored afterwards.
   */
  settled?: 'confirm' | 'cancel'
}

export function initialPresetConfirmState(): PresetConfirmState {
  return { selected: 0 }
}

/**
 * Apply one raw key sequence to the dialog state. Unknown keys are no-ops;
 * anything after a settle is ignored (single terminal outcome guard).
 */
export function updatePresetConfirm(state: PresetConfirmState, data: string): PresetConfirmState {
  if (state.settled !== undefined) return state
  const kb = getKeybindings()
  if (kb.matches(data, 'tui.select.cancel')) return { ...state, settled: 'cancel' }
  if (kb.matches(data, 'tui.input.submit')) return { ...state, settled: 'confirm' }
  if (kb.matches(data, 'tui.select.up')) {
    return { ...state, selected: Math.max(0, state.selected - 1) }
  }
  if (kb.matches(data, 'tui.select.down')) {
    return { ...state, selected: Math.min(PRESET_CONFIRM_OPTION_IDS.length - 1, state.selected + 1) }
  }
  // Digit direct-select (1-based): selects the row, Enter still confirms —
  // same select-then-confirm split as the routing dialog.
  const digit = /^([1-9])$/.exec(data)
  if (digit !== null) {
    const index = Number(digit[1]) - 1
    if (index < PRESET_CONFIRM_OPTION_IDS.length) return { ...state, selected: index }
  }
  return state
}

/** Resolved dialog outcome: the chosen action, or undefined on cancel. */
export function presetConfirmOutcome(state: PresetConfirmState): 'fork' | 'fresh' | 'cancel' | undefined {
  if (state.settled !== 'confirm') return undefined
  return PRESET_CONFIRM_OPTION_IDS[state.selected]
}

/**
 * The framed overlay component. Renders the title, the wrapped body points
 * and the three option rows; every key goes through
 * {@link updatePresetConfirm}, and the first terminal key fires `onFinish`
 * exactly once.
 */
export class PresetConfirmPanel implements Component {
  private readonly theme: TuiTheme
  private readonly wording: PresetConfirmWording
  private readonly onFinish: (outcome: 'fork' | 'fresh' | 'cancel' | undefined) => void
  private readonly requestRenderFn: () => void
  private state: PresetConfirmState = initialPresetConfirmState()

  constructor(
    theme: TuiTheme,
    wording: PresetConfirmWording,
    onFinish: (outcome: 'fork' | 'fresh' | 'cancel' | undefined) => void,
    requestRender: () => void,
  ) {
    this.theme = theme
    this.wording = wording
    this.onFinish = onFinish
    this.requestRenderFn = requestRender
  }

  invalidate(): void {}

  render(width: number): string[] {
    const fns = panelThemeFns(this.theme)
    const wrap = Math.max(2, width - 2)
    // Word-wrap the body FIRST, then paint (iron rule: width math runs on
    // plain text, ANSI goes on after clipping).
    const lines: string[] = [
      fns.accent(BOLD + clipToWidth(presetConfirmTitle(this.wording), wrap) + RESET),
      ...presetConfirmBody(this.wording).flatMap(point =>
        wrapText(point, wrap).map(segment => fns.muted(clipToWidth(segment, wrap)))),
      '',
    ]
    const options = presetConfirmOptions(this.wording)
    for (let i = 0; i < options.length; i++) {
      const option = options[i]!
      const marker = i === this.state.selected ? '▸' : ' '
      const row = clipToWidth(`${marker} ${i + 1}. ${option.text}`, wrap)
      lines.push(i === this.state.selected
        ? ansiFg(this.theme.palette.accent) + BOLD + row + RESET
        : fns.muted(row))
    }
    lines.push('')
    lines.push(fns.subtle(clipToWidth(PRESET_CONFIRM_FOOTER, wrap)))
    return lines
  }

  handleInput(data: string): void {
    const previous = this.state
    this.state = updatePresetConfirm(this.state, data)
    if (this.state === previous) return
    if (this.state.settled === undefined) {
      this.requestRenderFn()
      return
    }
    this.onFinish(presetConfirmOutcome(this.state))
  }
}

/**
 * Open the preset-switch confirmation dialog for one target preset.
 * Resolves the chosen action (`'fork'` / `'fresh'`) or `'cancelled'` (Esc,
 * or an overlay that failed to mount — treated as cancel so a half-mounted
 * dialog can never imply consent). Closing always hands focus back through
 * `restoreFocus` before the promise settles.
 */
export function openPresetConfirmDialog(
  tui: TUI,
  theme: TuiTheme,
  presetName: string,
  restart: boolean,
  restoreFocus: () => void,
): Promise<'fork' | 'fresh' | 'cancelled'> {
  return new Promise(resolve => {
    let settled = false
    const settle = (outcome: 'fork' | 'fresh' | 'cancelled'): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    // A half-mounted overlay must not strand the keyboard: PanelHost's
    // onError closes + calls restoreFocus, then we settle as cancelled.
    const host = new PanelHost(tui, theme, () => {
      restoreFocus()
      settle('cancelled')
    })
    const finish = (outcome: 'fork' | 'fresh' | 'cancel' | undefined): void => {
      host.close()
      restoreFocus()
      settle(outcome === 'fork' || outcome === 'fresh' ? outcome : 'cancelled')
    }
    const panel = new PresetConfirmPanel(
      theme,
      presetConfirmWording(presetName, restart),
      outcome => finish(outcome),
      () => tui.requestRender(),
    )
    // maxHeight is a hard slice in pi-tui: title + 2 wrapped body points +
    // 3 options + footer ≈ 9 content rows + 4 frame rows; 75% of the 24-row
    // e2e floor is 18 (the /resume picker's headroom).
    host.open(panel, '70%', '75%')
  })
}

// ------------------------------------------------------------ the switch flow --

/** What one switch attempt ended as (the command echo rides on `message`). */
export interface PresetSwitchOutcome {
  /** True when the selection was committed and the session restarted. */
  switched: boolean
  /** The user-facing echo line (English-only). */
  message: string
}

/**
 * The live seams the switch needs — structural so tests can pass fakes; the
 * index.ts wiring assigns the real closures once.
 */
export interface PresetSwitchDeps {
  /** Whether a live session exists right now (drives the confirmation gate). */
  hasLiveSession(): boolean
  /**
   * Show the confirmation dialog; resolves the user's choice. `restart` is
   * true when the target equals the current selection (session restart, not
   * a switch) — the dialog wording says so.
   */
  confirmSwitch(presetName: string, restart: boolean): Promise<'fork' | 'fresh' | 'cancel'>
  /**
   * Fresh start: record the selection (`bridge.setAgentPreset`) and start a
   * new EMPTY session on it (the /new detach path), then refresh the footer.
   */
  commit(presetId: string): Promise<void> | void
  /**
   * Fork & switch: record the selection and start the new session on it
   * SEEDED with the current conversation (snapshot → `agents.create` with
   * seed + fork lineage → bridge rebind → transcript replay), then refresh
   * the footer.
   */
  forkCommit(presetId: string): Promise<void> | void
}

/**
 * One preset switch, from any entry path (picker Enter, `/preset <name>`,
 * `/preset next`): with a live session the confirmation dialog gates the
 * switch — cancelling changes NOTHING (selection index untouched, no
 * detach); `fresh` commits an empty new session (the /new path); `fork`
 * commits a new session seeded with the current conversation. Without a
 * live session the selection applies directly (the first submit already
 * creates the session on it). Pure with respect to `state` apart from the
 * commit-index write, and fully injectable.
 */
export async function performPresetSwitch(
  state: PresetState,
  target: PresetEntry,
  deps: PresetSwitchDeps,
): Promise<PresetSwitchOutcome> {
  if (deps.hasLiveSession()) {
    const restart = state.roster[state.index]?.id === target.id
    const action = await deps.confirmSwitch(target.name, restart)
    if (action === 'cancel') {
      return { switched: false, message: 'Preset unchanged — still on the current session.' }
    }
    // Snapshot BEFORE the index write: a commit that throws must not leave
    // the selection (and with it the footer) advertising a preset the live
    // session is not on.
    const previousIndex = state.index
    const index = state.roster.findIndex(preset => preset.id === target.id)
    try {
      if (index >= 0) state.index = index
      if (action === 'fork') {
        await deps.forkCommit(target.id)
        return { switched: true, message: `Preset → ${target.name} — new session forked from this conversation.` }
      }
      await deps.commit(target.id)
      return { switched: true, message: `Preset → ${target.name} — new empty session started on it.` }
    } catch (error) {
      state.index = previousIndex
      throw error
    }
  }
  const index = state.roster.findIndex(preset => preset.id === target.id)
  if (index >= 0) state.index = index
  await deps.commit(target.id)
  return { switched: true, message: `Preset → ${target.name} — new session started on it.` }
}

/**
 * The balanced completed-turn prefix of a session snapshot: every event up
 * to and including the last `turn/end` — the in-flight turn is unbalanced
 * and cannot replay as a valid seed. Contiguous from seq 0 (live sequence
 * numbers equal array indexes) and empty before any completed turn, in which
 * case a fork degrades to a fresh session. The same slice the host's fork
 * subagent backend (`dsh-subagent-fork-in-process`) takes.
 */
export function completedTurnSeed(events: readonly SessionEvent[]): readonly SessionEvent[] {
  let lastEnd = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === 'turn/end') {
      lastEnd = i
      break
    }
  }
  return lastEnd < 0 ? [] : events.slice(0, lastEnd + 1)
}
