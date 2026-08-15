/**
 * TUI bootstrap: owns the terminal and the pi-tui component tree.
 *
 * Layout (alt-screen, mirrors pi interactive mode):
 *
 *   ┌──────────────────────────────────────┐
 *   │ scrollable transcript (ScrollView)   │  basis 0 / grow 1 — fills the rest
 *   ├──────────────────────────────────────┤
 *   │ statusContainer                      │  ┐
 *   │ editor                               │  │ dock — basis auto / grow 0,
 *   │ footerContainer                      │  ┘ sized to its content
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
import { CwdBorderEditor } from './editor.ts'
import { ansiFg, RESET, resolveTheme, type ThemePreference, type TuiTheme } from './theme/index.ts'
import { clipToWidth } from './text.ts'

export interface StartTuiOptions {
  /** Submit handler for the editor. Defaults to a local echo (smoke-test mode). */
  onSubmit?: (text: string) => void
  /** Ctrl+C handler. Defaults to a plain exit (smoke-test mode). */
  onInterrupt?: () => void
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
   * Hot-swap the theme bundle: repaints the editor border, the last-request
   * line and (when empty) the placeholder, and updates every subsequent
   * `theme` read. Transcript repainting is the TranscriptRenderer's job
   * (`setTheme`), owned by the caller; call it before `applyTheme` so the
   * one throttled render frame paints everything at once. No-op when the
   * bundle is unchanged (themes are module singletons).
   */
  applyTheme(theme: TuiTheme): void
  /** Autocomplete provider for the editor; re-applied across editor rebuilds. */
  setEditorAutocompleteProvider(provider: AutocompleteProvider): void
  /** Live git-branch source for the editor; re-applied across editor rebuilds. */
  setEditorBranchProvider(provider: () => string | undefined): void
  /** Live permission-preset display-name source for the editor; re-applied across editor rebuilds. */
  setEditorPermissionProvider(provider: () => string | undefined): void
  /** Show/hide the "last request" widget below the editor. */
  setLastRequest(text: string | undefined): void
}

export function startTui(options: StartTuiOptions = {}): TuiHandle {
  const terminal = new ProcessTerminal()
  const tui = new TuiAltScreen(terminal, true)
  // Mutable theme ref: `applyTheme` swaps it and every later read (handle
  // getter, baked closures below) observes the new bundle on the next call.
  let themeRef: TuiTheme = resolveTheme(process.env, options.themePreference ?? 'auto')

  // ------------------------------------------------------------- component tree --
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
  const lastRequest = new Container()
  const footer = new Container()
  let lastRequestText: Text | undefined
  let lastRequestDisplay: string | undefined

  const dock = new VStack([
    { component: status, shrink: 1, minSize: 0 },
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
      if (lastRequestDisplay !== undefined && lastRequestText !== undefined) {
        lastRequestText.setText(ansiFg(themeRef.palette.fgMuted) + ` ↳ ${lastRequestDisplay}` + RESET)
      }
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
    setLastRequest(text: string | undefined) {
      if (text === undefined || text.trim() === '') {
        if (lastRequestText !== undefined) {
          lastRequest.removeChild(lastRequestText)
          lastRequestText = undefined
          lastRequestDisplay = undefined
        }
      } else {
        const display = clipToWidth(text, 200)
        if (lastRequestText === undefined) {
          lastRequestText = new Text('', 1, 0)
          lastRequest.addChild(lastRequestText)
        }
        lastRequestDisplay = display
        lastRequestText.setText(ansiFg(themeRef.palette.fgMuted) + ` ↳ ${display}` + RESET)
      }
      tui.requestRender()
    },
  }

  // ------------------------------------------------------------- input & focus --
  tui.setFocus(editor)

  tui.addInputListener((data: string) => {
    if (matchesKey(data, 'ctrl+c')) {
      if (options.onInterrupt !== undefined) {
        options.onInterrupt()
      } else {
        handle.dispose()
        process.exit(130)
      }
      return { consume: true }
    }
    return undefined
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
