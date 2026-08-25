/**
 * TUI bootstrap: owns the terminal and the pi-tui component tree.
 *
 * Layout (alt-screen, mirrors pi interactive mode):
 *
 *   ┌──────────────────────────────────────┐
 *   │ scrollable transcript (ScrollView)   │  basis 0 / grow 1 — fills the rest
 *   ├──────────────────────────────────────┤
 *   │ statusContainer                      │  ┐
 *   │ widgetsContainer (Todos)             │  │ dock — basis auto / grow 0,
 *   │ editor                               │  │ sized to its content
 *   │ lastRequestContainer                 │  │  ← also hosts the merged
 *   │   (last-request + activity lines)    │  │    running-agent activity
 *   │ noticesContainer                     │  │  ← transient notice slot:
 *   │   (stacked muted lines,              │  │    zero rows while empty
 *   │    each auto-dismisses)              │  │
 *   │ footerContainer                      │  ┘
 *   └──────────────────────────────────────┘
 *
 * Design rules inherited from the pi-turbo findings — never re-scan the
 * session log during render; all session-derived state (messages, usage,
 * counts) is maintained incrementally by event listeners and read O(1) here.
 */

import {
  Container,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Spacer,
  Text,
  TuiAltScreen,
  VStack,
  type AutocompleteProvider,
  type TUI,
} from '@earendil-works/pi-tui'
import { CanvasTerminal } from './canvas-terminal.ts'
import { CwdBorderEditor } from './editor.ts'
import { mergeKeyBindings, resolveKeyAction, type KeyAction, type KeyBindings } from './keymap.ts'
import { ansiBg, ansiFg, RESET, resolveTheme, type ThemePreference, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'

export interface StartTuiOptions {
  /** Submit handler for the editor. Defaults to a local echo (smoke-test mode). */
  onSubmit?: (text: string) => void
  /**
   * Executes an app-level key action (see keymap.ts for the pi-aligned
   * interrupt chain: double-Esc stop, windowed Ctrl+C, empty-editor Ctrl+D
   * quit). Absent (smoke-test mode): Ctrl+C family and Ctrl+D quit fall back
   * to a plain exit(130); interrupt-arm-stop/cancel are no-ops.
   */
  onKeyAction?: (action: KeyAction) => void
  /** Whether the agent is mid-turn; feeds the Esc/Ctrl+C decision. Defaults to false. */
  isRunning?: () => boolean
  /** Live running-subagent count; feeds the Ctrl+G viewer decision. Defaults to 0. */
  getRunningAgents?: () => number
  /** Whether a session exists (agent handle); gates the Ctrl+O queue panel. Defaults to false. */
  hasSession?: () => boolean
  /**
   * Whether a docked modal panel (the ask-user questions panel in the dock
   * slot above the editor) currently owns the keyboard. Composed into the
   * keymap's `overlayOpen`: while active, app keys and the Esc/Ctrl+C chains
   * yield to the focused panel exactly like an open overlay — Esc never arms
   * the running-task stop from inside the modal.
   */
  dockedModalActive?: () => boolean
  /** User keybindings overrides (`~/.dsh/keybindings.json`); partial merge. */
  keyBindings?: Partial<KeyBindings>
  /** Persisted theme preference; 'auto' falls back to terminal detection. */
  themePreference?: ThemePreference
}

export interface TuiHandle {
  /** Stop the render loop and leave raw mode. */
  dispose(): void
  /**
   * Show a transient notice line pinned directly above the footer —
   * shell-level diagnostics (the shared notice bridge's messages: config
   * warnings, registration failures, the session-retention report) that
   * must neither write raw bytes to the terminal nor persist as transcript
   * content. Lines stack (a startup batch arrives as several calls) and
   * each auto-dismisses after a short timeout; feedback, not state.
   */
  showNotice(text: string): void
  /** The underlying pi-tui instance (for Loader/overlay construction). */
  readonly tui: TUI
  /** The scrollable transcript document container. */
  readonly transcript: Container
  /** Fixed slot pinned above the chat window — the live Todos widget. */
  readonly widgets: Container
  /**
   * Fixed slot between the live widgets and the editor — the docked ask-user
   * questions panel mounts here (modal while open: it takes focus and the
   * keymap yields to it; zero rows when closed).
   */
  readonly askUser: Container
  /**
   * Fixed dock slot below the editor — the last-request line + merged
   * running-agent activity (LiveWidgets owns both).
   */
  readonly lastRequest: Container
  /** Fixed dock slot rendered between transcript and editor. */
  readonly status: Container
  /** The input editor. */
  readonly editor: CwdBorderEditor
  /** Fixed dock slot rendered below the editor. */
  readonly footer: Container
  /** Request a re-render. */
  requestRender(): void
  /**
   * Active theme bundle — swaps live under `applyTheme`; every read goes
   * through the getter, so post-switch code always sees the new theme.
   */
  readonly theme: TuiTheme
  /**
   * Hot-swap the theme bundle: repaints the canvas background, the editor
   * border and the placeholder, and updates every subsequent `theme` read.
   * Transcript repainting is the TranscriptRenderer's job (`setTheme`), and
   * the last-request / running-agent lines are the LiveWidgets' job
   * (`setTheme`) — both owned by the caller; call them before `applyTheme`
   * so the one throttled render frame paints everything at once. No-op when
   * the bundle is unchanged (themes are module singletons).
   */
  applyTheme(theme: TuiTheme): void
  /** Autocomplete provider for the editor; re-applied across editor rebuilds. */
  setEditorAutocompleteProvider(provider: AutocompleteProvider): void
  /** Live git-branch source for the editor; re-applied across editor rebuilds. */
  setEditorBranchProvider(provider: () => string | undefined): void
  /** Live permission-preset display-name source for the editor; re-applied across editor rebuilds. */
  setEditorPermissionProvider(provider: () => string | undefined): void
  /** Swap the user keybindings live (`/hotkeys` writes → apply immediately). */
  setKeyBindings(bindings: Partial<KeyBindings>): void
}

export function startTui(options: StartTuiOptions = {}): TuiHandle {
  const terminal = new CanvasTerminal(new ProcessTerminal())
  const tui = new TuiAltScreen(terminal, true)
  // Mutable theme ref: `applyTheme` swaps it and every later read (handle
  // getter, baked closures below) observes the new bundle on the next call.
  let themeRef: TuiTheme = resolveTheme(process.env, options.themePreference ?? 'auto')
  // App-owned canvas: the write-stream decorator injects the palette's
  // canvas colors around every erase sequence and after every color reset
  // (BCE + re-injection — see canvas-terminal.ts), so a theme switch
  // recolors the WHOLE screen, not only the surfaces that paint their own
  // colors. The foreground matters as much as the background: unstyled
  // content (editor input, unselected picker rows) would otherwise fall
  // back to the terminal's default foreground — dark text when the host
  // terminal is light-themed (pi never paints a canvas so its unstyled
  // text always matches; we paint, so we own both channels). Without the
  // canvas the terminal default background shows through and "freezes" on
  // switch — most visible inside cmux/gostty, where the pane background
  // belongs to the multiplexer. DSH_TUI_TRANSPARENT=1 opts back into the
  // old see-through canvas for users who want their terminal theme to stay
  // visible.
  const paintCanvas = process.env.DSH_TUI_TRANSPARENT !== '1'
  if (paintCanvas) {
    terminal.setCanvasBackground(ansiBg(themeRef.palette.canvas))
    terminal.setCanvasForeground(ansiFg(themeRef.palette.fgDefault))
  }

  // ------------------------------------------------------------- component tree --
  // Live Todos widget, pinned ABOVE the chat input: a plain Container with
  // auto height — it renders zero rows while empty and grows to its
  // (bordered-panel) content while the model has todos. The askUser slot
  // below it hosts the docked questions panel (zero rows when no question is
  // pending).
  const widgets = new Container()
  const askUser = new Container()
  const transcript = new Container()
  const transcriptView = new ScrollView(transcript, {
    follow: 'end',
    primary: true,
    overscroll: 'chain',
  })

  const status = new Container()
  // The editor is rebuilt under `applyTheme` (its border/info colors are
  // baked at construction), so it must be a mutable binding and the dock
  // must be rebuilt in place below.
  let editor = new CwdBorderEditor(tui, themeRef.editor, process.cwd(), {
    infoColor: text => ansiFg(themeRef.palette.fgMuted) + text + RESET,
  })
  // User keybindings overrides — mutable so `/hotkeys` can live-apply a
  // write without restarting the TUI (see `setKeyBindings`).
  let keyBindingsRef: Partial<KeyBindings> | undefined = options.keyBindings
  // External wiring that must survive editor rebuilds.
  let autocompleteProvider: AutocompleteProvider | undefined
  let branchProvider: (() => string | undefined) | undefined
  let permissionProvider: (() => string | undefined) | undefined
  // Last-request + merged running-agent activity, pinned BELOW the editor: a
  // plain Container with auto height; LiveWidgets owns the ` ↳ ` line and the
  // compact agent lines it hosts. It collapses to zero rows when both the
  // last-request line is cleared and no subagent runs.
  const lastRequest = new Container()
  // Transient notice slot, pinned directly ABOVE the footer: zero rows while
  // empty; `showNotice` stacks one Text per live notice here until each
  // auto-dismisses. A dedicated slot (not a footer child) keeps it immune to
  // the caller's `footer.clear()` during footer wiring. Under dock squeeze
  // pi-tui clips this slot from the bottom, so the newest line is the
  // visually lost one — accepted.
  const notices = new Container()
  const footer = new Container()

  const dock = new VStack([
    { component: status, shrink: 1, minSize: 0 },
    { component: widgets, shrink: 1, minSize: 0 },
    { component: askUser, shrink: 1, minSize: 0 },
    { component: editor, shrink: 1, minSize: 3 },
    { component: lastRequest, shrink: 1, minSize: 0 },
    { component: notices, shrink: 1, minSize: 0 },
    { component: footer, shrink: 1, minSize: 1 },
  ])

  const root = new VStack([
    { component: transcriptView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
  ])

  // -------------------------------------------------------------- placeholder UI --
  const PLACEHOLDER = 'dsh-tui-pi — pi-style TUI for DeepSeek Harness'
  const placeholder = new Text(ansiFg(themeRef.palette.fgDefault) + PLACEHOLDER + RESET, 1, 0)
  transcript.addChild(placeholder)
  transcript.addChild(new Spacer(1))

  editor.onSubmit = (text: string) => {
    if (text.trim() === '') return
    // Record the submitted message for Up/Down browse before dispatching —
    // covers both the real path and the smoke-test fallback echo path. The
    // editor's own `submitValue()` never calls `addToHistory` in pi-tui 0.84.2.
    editor.addToHistory(text)
    if (options.onSubmit !== undefined) {
      options.onSubmit(text)
      return
    }
    // Smoke-test fallback: local echo only.
    transcript.addChild(new Text(themeRef.chat.userMessageText('▎' + text), 1, 0))
    transcript.addChild(new Spacer(1))
    tui.requestRender()
  }

  /**
   * Swap the editor for a fresh instance carrying the new theme's baked
   * colors, preserving the input buffer, submit handler and provider wiring.
   * Focus moves to the replacement only when the editor was the focus
   * target: with an overlay open (e.g. the settings browser), the overlay
   * keeps focus and its own close path re-focuses the (new) editor.
   * VStack has no insert-at, so the dock is re-assembled in order with the
   * same sizing options as the initial tree.
   */
  function rebuildEditor(): void {
    const text = editor.getText()
    // Preserve the Up/Down browse history AND the mid-browse cursor/draft
    // across a theme-swap rebuild: the rebuild fires asynchronously (settings
    // watch, CSI 997 terminal-follow) — precisely while the user may be sitting
    // mid-browse with a pre-browse draft saved in the base. Copies `history`
    // and `browse` so the swap restores exactly where the user was.
    const history = editor.getHistory()
    const browse = editor.getBrowseState()
    const hadFocus = editor.focused
    const next = new CwdBorderEditor(tui, themeRef.editor, process.cwd(), {
      infoColor: text => ansiFg(themeRef.palette.fgMuted) + text + RESET,
    })
    next.setText(text)
    next.onSubmit = editor.onSubmit
    // `addToHistory` unshifts, so reseed oldest→newest to land in the same
    // order on the new instance; then restore the browse cursor/draft.
    next.reseedHistory(history)
    next.restoreBrowseState(browse)
    if (autocompleteProvider !== undefined) next.setAutocompleteProvider(autocompleteProvider)
    if (branchProvider !== undefined) next.setBranchProvider(branchProvider)
    if (permissionProvider !== undefined) next.setPermissionProvider(permissionProvider)
    dock.clear()
    dock.addChild(status, { shrink: 1, minSize: 0 })
    dock.addChild(widgets, { shrink: 1, minSize: 0 })
    dock.addChild(askUser, { shrink: 1, minSize: 0 })
    dock.addChild(next, { shrink: 1, minSize: 3 })
    dock.addChild(lastRequest, { shrink: 1, minSize: 0 })
    dock.addChild(notices, { shrink: 1, minSize: 0 })
    dock.addChild(footer, { shrink: 1, minSize: 1 })
    editor = next
    if (hadFocus) tui.setFocus(editor)
  }

  // ---------------------------------------------------------- lifecycle handle --
  // Transient shell notice state (see showNotice below). Retirement is
  // timer-driven only — deliberately NOT "next keypress" like the subagent
  // viewer's notice. The color-scheme replies (OSC 11, CSI ?997;1|2n) are
  // NOT the hazard: pi-tui consumes a pure reply BEFORE inputListeners, so
  // it never reaches a key hook. The real hazards are the cell-size reply
  // (to the CSI 16 t query pi-tui always sends at startup on images-capable
  // terminals), which is consumed only AFTER the listeners — its bytes flow
  // through any key hook — and a reply sharing a stdin chunk with a real
  // keypress: the pure-reply matchers are whole-chunk anchored, so the
  // entire mixed chunk passes through. A key hook would retire the notice
  // before a human ever touches the keyboard.
  //
  // Lines STACK instead of replacing each other: the notice bridge drains
  // its startup batch (config warnings that fired before the first frame)
  // as several showNotice calls back-to-back, and replace-on-arrival would
  // leave only the last line visible. Each line retires independently
  // after its own window, and the stack is capped so a pathological burst
  // cannot eat the dock on a 24-row terminal (the OLDEST line drops — the
  // freshest diagnostics keep their full window). Under dock squeeze pi-tui
  // clips this slot from the bottom, so the newest line is the visually
  // lost one — accepted.
  const NOTICE_AUTO_DISMISS_MS = 8000
  const NOTICE_MAX_LINES = 8
  type ShellNotice = { line: Text; timer: ReturnType<typeof setTimeout>; retired: boolean }
  const shellNotices: ShellNotice[] = []
  const retireNotice = (notice: ShellNotice): void => {
    if (notice.retired) return
    notice.retired = true
    clearTimeout(notice.timer)
    const index = shellNotices.indexOf(notice)
    if (index >= 0) shellNotices.splice(index, 1)
    notices.removeChild(notice.line)
    tui.requestRender()
  }

  const handle: TuiHandle = {
    dispose() {
      for (const notice of [...shellNotices]) retireNotice(notice)
      tui.stop()
    },
    showNotice(text: string): void {
      while (shellNotices.length >= NOTICE_MAX_LINES) {
        const oldest = shellNotices[0]
        if (oldest === undefined) break
        retireNotice(oldest)
      }
      // Clip plain text BEFORE applying ANSI (iron rule 3). paddingX=1 on
      // both sides (Text(..., 1, 0)) leaves columns-2 of content width.
      const clipped = clipToWidth(text, Math.max(20, (process.stdout.columns ?? 80) - 2))
      const notice: ShellNotice = {
        line: new Text(ansiFg(themeRef.palette.fgMuted) + clipped + RESET, 1, 0),
        timer: setTimeout(() => retireNotice(notice), NOTICE_AUTO_DISMISS_MS),
        retired: false,
      }
      notice.timer.unref?.()
      shellNotices.push(notice)
      notices.addChild(notice.line)
      // The baked fgMuted color survives an ~8s theme hot-swap at worst;
      // not worth a re-tint hook for such short-lived lines.
      tui.requestRender()
    },
    tui,
    transcript,
    widgets,
    askUser,
    lastRequest,
    status,
    get editor() {
      return editor
    },
    footer,
    requestRender() {
      tui.requestRender()
    },
    get theme() {
      return themeRef
    },
    applyTheme(theme: TuiTheme): void {
      if (theme === themeRef) return
      themeRef = theme
      if (paintCanvas) {
        terminal.setCanvasBackground(ansiBg(theme.palette.canvas))
        terminal.setCanvasForeground(ansiFg(theme.palette.fgDefault))
      }
      rebuildEditor()
      // Forced full redraw: the diff renderer skips content-unchanged rows
      // (blank fillers render as '' under both themes), which would leave
      // them painted with the previous canvas color.
      tui.requestRender(true)
    },
    setEditorAutocompleteProvider(provider: AutocompleteProvider) {
      autocompleteProvider = provider
      editor.setAutocompleteProvider(provider)
    },
    setEditorBranchProvider(provider: () => string | undefined) {
      branchProvider = provider
      editor.setBranchProvider(provider)
    },
    setEditorPermissionProvider(provider: () => string | undefined) {
      permissionProvider = provider
      editor.setPermissionProvider(provider)
    },
    setKeyBindings(bindings: Partial<KeyBindings>) {
      keyBindingsRef = bindings
    },
  }

  // ------------------------------------------------------------- input & focus --
  tui.setFocus(editor)

  /**
   * App-level key dispatch — the pi interrupt chain (see keymap.ts):
   * popup/overlay first (a popup closes itself and never stops the running
   * task), then the editor's autocomplete, then the running agent — where a
   * DOUBLE Esc within `DOUBLE_PRESS_MS` stops the whole task (parent +
   * subagents; the first press only arms the stop window). An idle Esc is a
   * no-op. Every decision is delegated to the pure `resolveKeyAction`; the
   * listener only composes live state, advances the double-press timestamps,
   * and reports whether the key was consumed.
   * `matchesKey('escape')` is true for the lone ESC byte `\x1b` — and,
   * because legacy terminal Ctrl+[ sends the same byte, for Ctrl+[ too
   * (pi-tui keys.js normalizes both to `escape`).
   */
  let lastRunningEscPress = 0
  let lastCtrlCPress = 0
  let lastOverlayEscPress = 0
  const isRunning = options.isRunning ?? (() => false)
  const getRunningAgents = options.getRunningAgents ?? (() => 0)
  const hasSession = options.hasSession ?? (() => false)
  // Docked modal (ask-user panel): owns the keyboard like an open overlay, so
  // the whole app-key chain (Esc stop, Ctrl+C, pickers, Tab) yields to it.
  const dockedModalActive = options.dockedModalActive ?? (() => false)

  tui.addInputListener((data: string) => {
    const now = Date.now()
    const action = resolveKeyAction(data, {
      running: isRunning(),
      overlayOpen: tui.hasOverlay() || dockedModalActive(),
      editorHasText: editor.getText() !== '',
      autocompleteOpen: editor.isShowingAutocomplete(),
      runningAgents: getRunningAgents(),
      hasSession: hasSession(),
      lastRunningEscPress,
      lastCtrlCPress,
      lastOverlayEscPress,
    }, now, keyBindingsRef)
    // Advance the double-press windows for the keys this chain owns. The
    // running-stop arm (`interrupt-arm-stop` -> `interrupt-cancel`) owns the
    // only Esc clock. A fired stop re-arms the clock at the cancel timestamp:
    // lashes of held-key Esc after the cancel land <80ms later and resolve as
    // swallowable `key-repeat` instead of re-noticing another arm. Esc
    // `key-repeat` never advances the window - a held key must not arm or
    // complete an Esc double press. A popup-owned Esc (`overlay-esc`) arms
    // ONLY the post-popup guard clock - never the stop window.
    if (action.kind === 'interrupt-arm-stop' || action.kind === 'interrupt-cancel') {
      lastRunningEscPress = now
    } else if (action.kind === 'overlay-esc') {
      lastOverlayEscPress = now
    }
    // The ctrl+c clock advances on EVERY arrival (press, swallowed repeat,
    // popup-owned - anything but a key-release) so the quit gap measures
    // CONSECUTIVE key events: a held key's repeats keep the gap small and can
    // never reach the QUIT_MIN_GAP_MS floor (see resolveCtrlC in keymap.ts).
    if (action.kind !== 'key-release' && matchesKey(data, mergeKeyBindings(keyBindingsRef).ctrlC)) {
      lastCtrlCPress = now
    }
    // Pass-through outcomes (popup, autocomplete, unbound keys) let the
    // focused component handle the key; inert swallows (key-release,
    // overlay-esc, esc-after-overlay) go nowhere; actionable ones
    // (key-repeat included, so the executor can abort a pending quit
    // confirmation on it) go to the caller.
    if (action.kind !== 'overlay' && action.kind !== 'autocomplete-close' && action.kind !== 'noop'
      && action.kind !== 'key-release' && action.kind !== 'overlay-esc' && action.kind !== 'esc-after-overlay') {
      if (options.onKeyAction !== undefined) {
        options.onKeyAction(action)
      } else if (action.kind === 'ctrl-c-cancel' || action.kind === 'ctrl-c-clear'
        || action.kind === 'ctrl-c-quit' || action.kind === 'ctrl-d-quit') {
        // Smoke-test fallback: any Ctrl+C family press, or an empty-editor
        // Ctrl+D, exits - Ctrl+C behaves like the pre-keymap build. (key-repeat
        // deliberately excluded: no terminal is attached in smoke mode, but a
        // repeat must never be an exit path by itself.)
        handle.dispose()
        process.exit(130)
      }
    }
    return action.consumes ? { consume: true } : undefined
  })

  tui.setLayoutRoot(root)

  try {
    tui.start()
  } catch (error) {
    // Never leave the terminal stuck in raw mode on a render crash.
    try { tui.stop() } catch { /* best effort */ }
    throw error
  }

  return handle
}
