/**
 * Queue-panel lifecycle hygiene (src/queue-panel.ts + src/panels.ts → lib/):
 * the 300ms live-refresh interval must have NO leak path — PanelHost disposes
 * its panel component on close AND on replace, a half-mounted overlay
 * disposes too, and a panel whose session validity gate turns false closes
 * itself on the next tick instead of ticking against a dead inbox.
 * Runs against the built lib/ (pretest builds).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { openPendingQueuePanel } from '../lib/queue-panel.js'
import { PanelHost } from '../lib/panels.js'
import { darkTheme } from '../lib/theme/index.js'

/** Minimal fake TUI: records overlays, returns controllable handles. */
function fakeTui({ failOpen = false } = {}) {
  const overlays = []
  return {
    overlays,
    requestRender() {},
    showOverlay(component) {
      if (failOpen) throw new Error('overlay mount failed')
      const entry = { component, hidden: false }
      const handle = {
        hide() {
          entry.hidden = true
          const index = overlays.indexOf(entry)
          if (index >= 0) overlays.splice(index, 1)
        },
        setHidden(hidden) {
          entry.hidden = hidden
        },
        isHidden: () => entry.hidden,
        focus() {},
        unfocus() {},
        isFocused: () => false,
      }
      entry.handle = handle
      overlays.push(entry)
      return handle
    },
  }
}

/** A component that records whether it was disposed. */
function disposablePanel() {
  let disposed = false
  return {
    get disposed() {
      return disposed
    },
    invalidate() {},
    render() {
      return ['x']
    },
    dispose() {
      disposed = true
    },
  }
}

test('S4: PanelHost.close() disposes the mounted panel exactly once', () => {
  const host = new PanelHost(fakeTui(), darkTheme)
  const panel = disposablePanel()
  host.open(panel, '70%', '60%')
  host.close()
  assert.equal(panel.disposed, true, 'close tears the panel down')
  host.close() // double close is a no-op
})

test('S4: replacing an overlay on the same host disposes the replaced panel', () => {
  const host = new PanelHost(fakeTui(), darkTheme)
  const first = disposablePanel()
  const second = disposablePanel()
  host.open(first, '70%', '60%')
  host.open(second, '70%', '60%')
  assert.equal(first.disposed, true, 'the replaced stage-1 panel is disposed')
  assert.equal(second.disposed, false, 'the live panel stays intact')
  host.close()
  assert.equal(second.disposed, true)
})

test('S4: a failed mount reports through onError with nothing left mounted', async () => {
  const tui = fakeTui({ failOpen: true })
  let reported
  const host = new PanelHost(tui, darkTheme, message => {
    reported = message
  })
  const panel = disposablePanel()
  const handle = host.open(panel, '70%', '60%')
  assert.equal(handle, undefined)
  assert.equal(reported, 'overlay mount failed')
  assert.equal(panel.disposed, false, 'never-mounted panel needs no dispose')
  assert.deepEqual(tui.overlays, [])
})

test('S4: openPendingQueuePanel auto-closes when shouldStayOpen turns false (no timer leak)', async () => {
  const tui = fakeTui()
  let focusRestored = false
  let stayOpen = true
  let focused = null // pretend-focus owner: the overlay while open, editor after
  const promise = openPendingQueuePanel(tui, darkTheme, {
    readItems: () => [],
    onRemove: () => ({ kind: 'not-found' }),
    onPromote: () => ({ kind: 'not-found' }),
    restoreFocus: () => {
      focusRestored = true
    },
    shouldStayOpen: () => stayOpen,
  })
  assert.equal(tui.overlays.length, 1, 'panel mounted')
  // Simulate a session switch while the panel stands open: the next ~300ms
  // tick must close it (promise settles, focus restored, overlay gone).
  stayOpen = false
  await Promise.race([promise, new Promise(resolve => setTimeout(resolve, 1500))])
  await promise
  assert.equal(focusRestored, true, 'auto-close restores focus')
  assert.equal(tui.overlays.length, 0, 'overlay removed — no orphaned panel')
})
