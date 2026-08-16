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
 *   │ footerContainer                      │  ┘
 *   └──────────────────────────────────────┘
 *
 * Design rules inherited from the pi-turbo findings — never re-scan the
 * session log during render; all session-derived state (messages, usage,
 * counts) is maintained incrementally by event listeners and read O(1) here.
 */

import {
  Container,
  ProcessTerminal,
  ScrollView,
  Spacer,
  Text,
  TuiAltScreen,
  VStack,
  type AutocompleteProvider,
  type TUI,
} from '@earendil-works/pi-tui'
import { CwdBorderEditor } from './editor.ts'
import { resolveKeyAction, type KeyAction, type KeyBindings } from './keymap.ts'
import { ansiFg, RESET, resolveTheme, type ThemePreference, type TuiTheme } from './theme/index.ts'

export interface StartTuiOptions {
  /** Submit handler for the editor. Defaults to a local echo (smoke-test mode). */
  onSubmit?: (text: string) => void
  /**
   * Executes an app-level key action (see keymap.ts for the pi-aligned
   * interrupt chain: Esc stop, windowed Ctrl+C, empty-editor Ctrl+D quit).
   * Absent (smoke-test mode): Ctrl+C family and Ctrl+D quit fall back to a
   * plain exit(130); interrupt-arm/double are no-ops.
   */
  onKeyAction?: (action: KeyAction) => void
  /** Whether the agent is mid-turn; feeds the Esc/Ctrl+C decision. Defaults to false. */
  isRunning?: () => boolean
  /** User keybindings overrides (`~/.dsh/keybindings.json`); partial merge. */
  keyBindings?: Partial<KeyBindings>
  /** Persisted theme preference; 'auto' falls back to terminal detection. */
  themePreference?: ThemePreference
}

export interface TuiHandle {
  /** Stop the render loop and leave raw mode. */
  dispose(): void
  /** The underlying pi-tui instance (for Loader/overlay construction). */
  readonly tui: TUI
  /** The scrollable transcript document container. */
  readonly transcript: Container
  /** Fixed slot pinned above the chat window — the live Todos widget. */
  readonly widgets: Container
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
   * Hot-swap the theme bundle: repaints the editor border and the placeholder,
   * and updates every subsequent `theme` read. Transcript repainting is the
   * TranscriptRenderer's job (`setTheme`), and the last-request / running-agent
   * lines are the LiveWidgets' job (`setTheme`) — both owned by the caller;
   * call them before `applyTheme` so the one throttled render frame paints
   * everything at once. No-op when the bundle is unchanged (themes are module
   * singletons).
   */
  applyTheme(theme: TuiTheme): void
  /** Autocomplete provider for the editor; re-applied across editor rebuilds. */
  setEditorAutocompleteProvider(provider: AutocompleteProvider): void
  /** Live git-branch source for the editor; re-applied across editor rebuilds. */
  setEditorBranchProvider(provider: () => string | undefined): void
  /** Live permission-preset display-name source for the editor; re-applied across editor rebuilds. */
  setEditorPermissionProvider(provider: () => string | undefined): void
}

export function startTui(options: StartTuiOptions = {}): TuiHandle {
  const terminal = new ProcessTerminal()
  const tui = new TuiAltScreen(terminal, true)
  // Mutable theme ref: `applyTheme` swaps it and every later read (handle
  // getter, baked closures below) observes the new bundle on the next call.
  let themeRef: TuiTheme = resolveTheme(process.env, options.themePreference ?? 'auto')

  // ------------------------------------------------------------- component tree --
  // Live Todos widget, pinned ABOVE the chat input: a plain Container with
  // auto height — it renders zero rows while empty and grows to its
  // (bordered-panel) content while the model has todos.
  const widgets = new Container()
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
  // External wiring that must survive editor rebuilds.
  let autocompleteProvider: AutocompleteProvider | undefined
  let branchProvider: (() => string | undefined) | undefined
  let permissionProvider: (() => string | undefined) | undefined
  // Last-request + merged running-agent activity, pinned BELOW the editor: a
  // plain Container with auto height; LiveWidgets owns the ` ↳ ` line and the
  // compact agent lines it hosts. It collapses to zero rows when both the
  // last-request line is cleared and no subagent runs.
  const lastRequest = new Container()
  const footer = new Container()

  const dock = new VStack([
    { component: status, shrink: 1, minSize: 0 },
    { component: widgets, shrink: 1, minSize: 0 },
    { component: editor, shrink: 1, minSize: 3 },
    { component: lastRequest, shrink: 1, minSize: 0 },
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
    const hadFocus = editor.focused
    const next = new CwdBorderEditor(tui, themeRef.editor, process.cwd(), {
      infoColor: text => ansiFg(themeRef.palette.fgMuted) + text + RESET,
    })
    next.setText(text)
    next.onSubmit = editor.onSubmit
    if (autocompleteProvider !== undefined) next.setAutocompleteProvider(autocompleteProvider)
    if (branchProvider !== undefined) next.setBranchProvider(branchProvider)
    if (permissionProvider !== undefined) next.setPermissionProvider(permissionProvider)
    dock.clear()
    dock.addChild(status, { shrink: 1, minSize: 0 })
    dock.addChild(widgets, { shrink: 1, minSize: 0 })
    dock.addChild(next, { shrink: 1, minSize: 3 })
    dock.addChild(lastRequest, { shrink: 1, minSize: 0 })
    dock.addChild(footer, { shrink: 1, minSize: 1 })
    editor = next
    if (hadFocus) tui.setFocus(editor)
  }

  // ---------------------------------------------------------- lifecycle handle --
  const handle: TuiHandle = {
    dispose() {
      tui.stop()
    },
    tui,
    transcript,
    widgets,
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
      rebuildEditor()
      tui.requestRender()
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
  }

  // ------------------------------------------------------------- input & focus --
  tui.setFocus(editor)

  /**
   * App-level key dispatch — the pi interrupt chain (see keymap.ts):
   * popup/overlay first, then the editor's autocomplete, then the running
   * agent, then the empty-editor double-press windows. Every decision is
   * delegated to the pure `resolveKeyAction`; the listener only composes
   * live state, advances the double-press timestamps, and reports whether
   * the key was consumed. `matchesKey('escape')` is true for the lone ESC
   * byte `\x1b` — and, because legacy terminal Ctrl+[ sends the same byte,
   * for Ctrl+[ too (pi-tui keys.js normalizes both to `escape`).
   */
  let lastEscPress = 0
  let lastCtrlCPress = 0
  const isRunning = options.isRunning ?? (() => false)

  tui.addInputListener((data: string) => {
    const action = resolveKeyAction(data, {
      running: isRunning(),
      overlayOpen: tui.hasOverlay(),
      editorHasText: editor.getText() !== '',
      autocompleteOpen: editor.isShowingAutocomplete(),
      lastEscPress,
      lastCtrlCPress,
    }, Date.now(), options.keyBindings)
    // Advance the double-press windows for the keys this chain owns. Only
    // the EMPTY-editor idle chain arms the double-Esc timer: an Esc that
    // cancels a running turn must not count as the first press of a pair,
    // or mashing Esc while stopping would pop /session right after (pi arms
    // the double-escape only from the empty-editor branch too).
    if (action.kind === 'interrupt-arm' || action.kind === 'interrupt-double') {
      lastEscPress = Date.now()
    } else if (action.kind === 'ctrl-c-cancel' || action.kind === 'ctrl-c-clear' || action.kind === 'ctrl-c-quit') {
      lastCtrlCPress = Date.now()
    }
    // Pass-through outcomes (popup, autocomplete, unbound keys) let the
    // focused component handle the key; actionable ones go to the caller.
    if (action.kind !== 'overlay' && action.kind !== 'autocomplete-close' && action.kind !== 'noop') {
      if (options.onKeyAction !== undefined) {
        options.onKeyAction(action)
      } else if (action.kind === 'ctrl-c-cancel' || action.kind === 'ctrl-c-clear'
        || action.kind === 'ctrl-c-quit' || action.kind === 'ctrl-d-quit') {
        // Smoke-test fallback: any Ctrl+C family press, or an empty-editor
        // Ctrl+D, exits — Ctrl+C behaves like the pre-keymap build.
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
