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
  type TUI,
} from '@earendil-works/pi-tui'
import { CwdBorderEditor } from './editor.ts'
import { ansiFg, RESET, resolveTheme, type TuiTheme } from './theme/index.ts'

export interface StartTuiOptions {
  /** Submit handler for the editor. Defaults to a local echo (smoke-test mode). */
  onSubmit?: (text: string) => void
  /** Ctrl+C handler. Defaults to a plain exit (smoke-test mode). */
  onInterrupt?: () => void
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
  /** Active theme bundle. */
  readonly theme: TuiTheme
  /** Show/hide the "last request" widget below the editor. */
  setLastRequest(text: string | undefined): void
}

export function startTui(options: StartTuiOptions = {}): TuiHandle {
  const terminal = new ProcessTerminal()
  const tui = new TuiAltScreen(terminal, true)
  const theme = resolveTheme()

  // ------------------------------------------------------------- component tree --
  const transcript = new Container()
  const transcriptView = new ScrollView(transcript, {
    follow: 'end',
    primary: true,
    overscroll: 'chain',
  })

  const status = new Container()
  const editor = new CwdBorderEditor(tui, theme.editor, process.cwd(), {
    infoColor: text => ansiFg(theme.palette.fgMuted) + text + RESET,
  })
  const lastRequest = new Container()
  const footer = new Container()
  let lastRequestText: Text | undefined

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
  transcript.addChild(new Text(ansiFg(theme.palette.fgDefault) + 'dsh-tui-pi — pi-style TUI for DeepSeek Harness' + RESET, 1, 0))
  transcript.addChild(new Spacer(1))
  footer.addChild(new Text(ansiFg(theme.palette.fgMuted) + '⌨ Enter: send · Ctrl+C: quit' + RESET, 1, 0))

  editor.onSubmit = (text: string) => {
    if (text.trim() === '') return
    if (options.onSubmit !== undefined) {
      options.onSubmit(text)
      return
    }
    // Smoke-test fallback: local echo only.
    transcript.addChild(new Text(theme.chat.userMessageText('▎' + text), 1, 0))
    transcript.addChild(new Spacer(1))
    tui.requestRender()
  }

  // ---------------------------------------------------------- lifecycle handle --
  const handle: TuiHandle = {
    dispose() {
      tui.stop()
    },
    tui,
    transcript,
    status,
    editor,
    footer,
    requestRender() {
      tui.requestRender()
    },
    theme,
    setLastRequest(text: string | undefined) {
      if (text === undefined || text.trim() === '') {
        if (lastRequestText !== undefined) {
          lastRequest.removeChild(lastRequestText)
          lastRequestText = undefined
        }
      } else {
        const display = text.length > 200 ? text.slice(0, 200) + '…' : text
        if (lastRequestText === undefined) {
          lastRequestText = new Text('', 1, 0)
          lastRequest.addChild(lastRequestText)
        }
        lastRequestText.setText(ansiFg(theme.palette.fgMuted) + ` ↳ ${display}` + RESET)
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
