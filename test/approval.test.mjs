import test from 'node:test'
import assert from 'node:assert/strict'
import { approvalDetails, openApprovalPanel, registerApprovalProvider } from '../lib/approval.js'
import { DialogQueue } from '../lib/dialog-queue.js'

function harness(rows = 24) {
  const state = { mounted: [], unmounted: 0, restored: 0, active: false }
  const deps = {
    tui: { terminal: { rows }, requestRender() {}, hideOverlay() {}, setFocus(panel) { state.focus = panel } },
    theme: () => ({ palette: { borderDefault: '#888888' } }),
    mount(panel) { state.mounted.push(panel); return () => state.unmounted++ },
    restoreFocus() { state.restored++ },
    setModalActive(active) { state.active = active },
    getSessionId: () => 'mine',
  }
  return { deps, state }
}
const request = extra => ({ agent: { session: { id: 'mine' } }, toolName: 'write', callId: 'call-a', reason: 'Write outside workspace', ...extra })
const tick = () => new Promise(resolve => setImmediate(resolve))

test('approval shows exact matching tool arguments', () => {
  const events = [{ type: 'tool/call', data: { callId: 'call-a', arguments: '{"file_path":"/example","content":"text"}' } }]
  assert.match(approvalDetails(request({ agent: { session: { id: 'mine', seq: 1, eventAt: n => events[n] } } })), /Arguments:.*\/example/)
})
test('approval never displays another call as the requested operation', () => {
  assert.doesNotMatch(approvalDetails(request({ agent: { session: { id: 'mine', seq: 1, eventAt: () => ({ type: 'tool/call', data: { callId: 'other', arguments: 'wrong' } }) } } })), /wrong/)
})
for (const [name, keys, outcome] of [
  ['default Enter denies', ['\r'], 'rejected'],
  ['Escape denies', ['\x1b'], 'rejected'],
  ['Ctrl+C denies', ['\x03'], 'rejected'],
  ['one denies', ['1'], 'rejected'],
  ['allow requires selection then confirmation', ['2', '\r'], 'allowed-once'],
  ['arrow selection permits allow once', ['\x1b[B', '\r'], 'allowed-once'],
]) test(name, async () => {
  const { deps, state } = harness()
  const result = openApprovalPanel(deps, request(), new AbortController().signal)
  for (const key of keys) state.focus.handleInput(key)
  assert.equal(await result, outcome)
  assert.equal(state.unmounted, 1)
  assert.equal(state.restored, 1)
  assert.equal(state.active, false)
})
test('paste cannot grant approval', async () => {
  const { deps, state } = harness()
  const controller = new AbortController()
  let settled = false
  const result = openApprovalPanel(deps, request(), controller.signal).then(x => { settled = true; return x })
  state.focus.handleInput('\x1b[200~2\r\x1b[201~')
  await tick()
  assert.equal(settled, false)
  controller.abort()
  assert.equal(await result, 'cancelled')
})
test('already cancelled request does not mount', async () => {
  const { deps, state } = harness()
  const controller = new AbortController(); controller.abort()
  assert.equal(await openApprovalPanel(deps, request(), controller.signal), 'cancelled')
  assert.equal(state.mounted.length, 0)
})
test('24-row panel keeps bounded scrollable details', async () => {
  const { deps, state } = harness()
  const controller = new AbortController()
  const result = openApprovalPanel(deps, request({ reason: 'x '.repeat(2000) }), controller.signal)
  const before = state.focus.render(80)
  assert.ok(before.length <= 24)
  state.focus.handleInput('\x1b[6~')
  assert.notDeepEqual(state.focus.render(80), before)
  controller.abort(); await result
})
test('mount failure cannot grant consent', async () => {
  const { deps } = harness()
  deps.mount = () => { throw new Error('no terminal') }
  assert.equal(await openApprovalPanel(deps, request(), new AbortController().signal), 'unavailable')
})
test('provider delegates another session and missing current session', async () => {
  const { deps } = harness(); let listener
  registerApprovalProvider({ on(event, fn) { assert.equal(event, 'approval/request'); listener = fn; return () => {} } }, deps, new DialogQueue())
  const next = async () => 'other'
  assert.equal(await listener(request({ agent: { session: { id: 'other' } } }), next), 'other')
  deps.getSessionId = () => undefined
  assert.equal(await listener(request(), next), 'other')
})
test('provider claims current session and releases its listener', async () => {
  const { deps, state } = harness(); let listener; let disposed = false
  const unregister = registerApprovalProvider({ on(_, fn) { listener = fn; return () => { disposed = true } } }, deps, new DialogQueue())
  const result = listener(request(), async () => assert.fail('must claim'))
  await tick(); state.focus.handleInput('2'); state.focus.handleInput('\r')
  assert.equal(await result, 'allowed-once')
  unregister(); assert.equal(disposed, true)
})

test('terminal controls in approval details render as visible escapes', () => {
  const details = approvalDetails(request({ reason: '\x1b[2J\rhidden\x07' }))
  assert.doesNotMatch(details, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
  assert.match(details, /\\u001b\[2J/)
})
test('provider teardown cancels an active approval without granting it', async () => {
  const { deps, state } = harness(); const queue = new DialogQueue(); let listener
  registerApprovalProvider({ on(_, fn) { listener = fn; return () => {} } }, deps, queue)
  const result = listener(request(), async () => assert.fail('must claim'))
  await tick(); queue.dispose()
  assert.equal(await result, 'cancelled')
  assert.equal(state.unmounted, 1)
})
test('approval remains usable after a terminal resize', async () => {
  const { deps, state } = harness(40); const controller = new AbortController()
  const result = openApprovalPanel(deps, request({ reason: 'long '.repeat(200) }), controller.signal)
  const tall = state.focus.render(120)
  deps.tui.terminal.rows = 24
  assert.ok(state.focus.render(60).length <= 24)
  deps.tui.terminal.rows = 40
  assert.deepEqual(state.focus.render(120), tall)
  state.focus.handleInput('\r'); assert.equal(await result, 'rejected')
})
