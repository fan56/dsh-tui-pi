/**
 * End-to-end keymap wiring check (tui.ts listener + resolveKeyAction):
 * with a mock terminal, simulate kitty-protocol press/repeat/release events
 * and confirm the reported bugs are gone.
 *
 *  1. Esc to close a detail panel: press closes it, the RELEASE event must
 *     not re-trigger the main Esc chain, and the trailing Esc of a
 *     close-mash is swallowed (never arms the running-stop).
 *  2. Ctrl+C: a single press + slow release must NOT quit (the old bug).
 *     Held-key repeats must not quit either. A deliberate double press
 *     (>= QUIT_MIN_GAP_MS apart) still quits.
 */
import { TuiAltScreen } from '@earendil-works/pi-tui'
import { resolveKeyAction } from '../lib/keymap.js'
import { PanelHost } from '../lib/panels.js'
import { CwdBorderEditor } from '../lib/editor.js'
import { lightTheme } from '../lib/theme/index.js'

class MockTerminal {
  columns = 100
  rows = 30
  inputHandler = undefined
  write() {}
  hideCursor() {}
  showCursor() {}
  start(onInput) { this.inputHandler = onInput }
  stop() { this.inputHandler = undefined }
  send(data) { this.inputHandler?.(data) }
}

const tui = new TuiAltScreen(new MockTerminal(), false)
const editor = new CwdBorderEditor(tui, lightTheme.editor, process.cwd(), {})
let lastRunningEsc = 0
let lastCtrlC = 0
let lastOverlayEsc = 0
const log = []
const running = true // agent mid-turn

const KITTY_CTRL_C_RELEASE = '\x1b[99;5:3u'
const KITTY_CTRL_C_REPEAT = '\x1b[99;5:2u'

tui.addInputListener(data => {
  const now = Date.now()
  const action = resolveKeyAction(data, {
    running,
    overlayOpen: tui.hasOverlay(),
    editorHasText: editor.getText() !== '',
    autocompleteOpen: false,
    runningAgents: 1,
    lastRunningEscPress: lastRunningEsc,
    lastCtrlCPress: lastCtrlC,
    lastOverlayEscPress: lastOverlayEsc,
  }, now)
  if (action.kind === 'interrupt-arm-stop' || action.kind === 'interrupt-cancel') lastRunningEsc = now
  else if (action.kind === 'overlay-esc') lastOverlayEsc = now
  if (action.kind !== 'key-release' && (data === '\x1b[99;5u' || data === '\x03')) lastCtrlC = now
  if (action.kind !== 'key-release' && action.kind !== 'overlay-esc' && action.kind !== 'esc-after-overlay' && action.kind !== 'noop') {
    log.push(`${JSON.stringify(data)} -> ${action.kind}`)
  }
  return action.consumes ? { consume: true } : undefined
})

tui.setFocus(editor)
tui.setLayoutRoot(editor)
tui.start()

const host = new PanelHost(tui, undefined, () => {})
let panelOpen = true
const panel = {
  invalidate() {},
  render: () => ['detail panel'],
  handleInput(data) {
    if (data === '\x1b') {
      host.close()
      panelOpen = false
      tui.setFocus(editor)
    }
  },
}
host.open(panel)

const results = []
const check = (name, cond) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}`)

// --- 1. Esc press closes the panel; release + a trailing mash must not arm ---
log.length = 0
tui.terminal.send('\x1b')                       // press: closes the detail panel
await new Promise(r => setTimeout(r, 120))
tui.terminal.send('\x1b[27;1:3u')               // release event (kitty flag 3)
await new Promise(r => setTimeout(r, 80))
tui.terminal.send('\x1b')                       // habitual trailing Esc, inside the guard
await new Promise(r => setTimeout(r, 20))
check('Esc close: release+trailing mash never arms the running stop',
  log.every(a => !a.includes('interrupt-arm-stop')) && log.every(a => !a.includes('interrupt-cancel')))

// --- 2. Ctrl+C single press + slow release must not quit ---
log.length = 0
lastCtrlC = 0
tui.terminal.send('\x03')                       // press (running) -> cancel
await new Promise(r => setTimeout(r, 320))      // slow release ~300ms later
tui.terminal.send(KITTY_CTRL_C_RELEASE)
await new Promise(r => setTimeout(r, 20))
check('Ctrl+C press+release is one cancel, never a quit',
  log.length === 1 && log[0].includes('ctrl-c-cancel'))

// --- 3. Held-key repeats (slow 100ms gap) must not quit ---
log.length = 0
lastCtrlC = 0
tui.terminal.send('\x03')                       // press -> cancel
await new Promise(r => setTimeout(r, 100))
tui.terminal.send('\x03')                       // repeat @100ms (slow rate)
await new Promise(r => setTimeout(r, 100))
tui.terminal.send('\x03')                       // repeat @200ms
await new Promise(r => setTimeout(r, 50))
check('slow held-key repeats (100ms gaps) never quit',
  log.every(a => !a.includes('ctrl-c-quit')))

// --- 4. Deliberate double press still quits ---
log.length = 0
lastCtrlC = 0
tui.terminal.send('\x03')                       // press -> cancel
await new Promise(r => setTimeout(r, 320))      // human-paced second press
tui.terminal.send('\x03')
await new Promise(r => setTimeout(r, 20))
check('deliberate Ctrl+C double (320ms gap) quits', log.some(a => a.includes('ctrl-c-quit')))

console.log(results.join('\n'))
console.log(`\n${results.filter(r => r.startsWith('PASS')).length}/${results.length} checks passed`)
tui.stop()
process.exit(results.every(r => r.startsWith('PASS')) ? 0 : 1)
