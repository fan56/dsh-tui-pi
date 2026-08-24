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
import { openPendingQueuePanel, QUEUE_REFRESH_FAILED_NOTICE, QUEUE_REFRESH_FAIL_THRESHOLD } from '../lib/queue-panel.js'
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

// --------------------------- v0.20.1: persistent tick failures surface once --

/** Base deps whose readItems can be switched between throwing and working.
 *  Starts healthy: the CONSTRUCTOR also reads items (unguarded by design —
 *  an inbox that fails before the panel even mounts must not open at all),
 *  so these tests exercise the tick path only. */
function failingDeps() {
  const deps = {
    fail: false,
    stayOpen: true,
    refreshErrors: [],
    readItems: () => {
      if (deps.fail) throw new Error('inbox read exploded')
      return []
    },
    onRemove: () => ({ kind: 'not-found' }),
    onPromote: () => ({ kind: 'not-found' }),
    onRefreshError: message => deps.refreshErrors.push(message),
    shouldStayOpen: () => deps.stayOpen,
    restoreFocus: () => {},
  }
  return deps
}

test('tick failures: ONE warning at the threshold, no spam afterwards, reset on success', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const deps = failingDeps()
  const tui = fakeTui()
  const promise = openPendingQueuePanel(tui, darkTheme, deps)
  assert.equal(tui.overlays.length, 1, 'panel mounted')
  // Now the inbox reads start failing persistently (the v0.20.1 bug case).
  deps.fail = true

  // Fewer than the threshold → silent (transient blips never warn).
  t.mock.timers.tick(300 * (QUEUE_REFRESH_FAIL_THRESHOLD - 1))
  assert.deepEqual(deps.refreshErrors, [], 'below the threshold nothing surfaces')

  // Reaching the threshold raises exactly one durable warning.
  t.mock.timers.tick(300)
  assert.deepEqual(deps.refreshErrors, [QUEUE_REFRESH_FAILED_NOTICE],
    'one warning at the threshold')

  // A persistent outage must NOT spam: further failing ticks stay quiet.
  t.mock.timers.tick(300 * 10)
  assert.deepEqual(deps.refreshErrors, [QUEUE_REFRESH_FAILED_NOTICE],
    'still exactly one warning after many more failures')

  // Recovery resets the streak — a later outage warns again.
  deps.fail = false
  t.mock.timers.tick(300)
  deps.fail = true
  t.mock.timers.tick(300 * QUEUE_REFRESH_FAIL_THRESHOLD)
  assert.equal(deps.refreshErrors.length, 2,
    'after a success the counter is zeroed and a new streak can warn')

  // Clean up: close the panel so the promise settles and timers die.
  deps.stayOpen = false
  t.mock.timers.tick(300)
  await promise
  assert.equal(tui.overlays.length, 0)
})

test('tick failures also leave an in-panel notice line once reported', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const deps = failingDeps()
  const tui = fakeTui()
  const promise = openPendingQueuePanel(tui, darkTheme, deps)
  const panel = tui.overlays[0].component

  // The inbox reads start failing: no stale-data line below the threshold.
  deps.fail = true
  t.mock.timers.tick(300 * (QUEUE_REFRESH_FAIL_THRESHOLD - 1))
  assert.equal(panel.render(80).some(line => line.includes('may be stale')), false)

  t.mock.timers.tick(300)
  assert.ok(panel.render(80).some(line => line.includes('may be stale')),
    'the panel itself admits it may be stale')

  // Clean up: auto-close so the promise settles and timers die.
  deps.stayOpen = false
  t.mock.timers.tick(300)
  await promise
  assert.equal(tui.overlays.length, 0)
})
