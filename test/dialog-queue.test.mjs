import test from 'node:test'
import assert from 'node:assert/strict'
import { DialogQueue } from '../lib/dialog-queue.js'
const tick = () => new Promise(resolve => setImmediate(resolve))

test('questions and approvals open in order, never concurrently', async () => {
  const queue = new DialogQueue(); const opened = []; let close
  const first = queue.run(() => { opened.push('question'); return new Promise(resolve => close = resolve) })
  const second = queue.run(async () => { opened.push('approval'); return 'denied' })
  await tick(); assert.deepEqual(opened, ['question'])
  close('answer'); assert.equal(await first, 'answer'); assert.equal(await second, 'denied')
  assert.deepEqual(opened, ['question', 'approval'])
})
test('queued cancellation settles without opening or blocking later dialogs', async () => {
  const queue = new DialogQueue(); let close
  const first = queue.run(() => new Promise(resolve => close = resolve))
  const controller = new AbortController()
  const second = queue.run(async () => assert.fail('cancelled dialog mounted'), controller.signal)
  const rejected = assert.rejects(second, /cancelled/)
  controller.abort(); await rejected
  await tick(); close(); await first
  assert.equal(await queue.run(async () => 'next'), 'next')
})
test('active cancellation reaches the panel', async () => {
  const queue = new DialogQueue(); const controller = new AbortController(); let aborted = false
  const result = queue.run(signal => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve() })), controller.signal)
  await tick(); const rejected = assert.rejects(result, /cancelled/); controller.abort(); await rejected
  assert.equal(aborted, true)
})
test('failed dialog does not block later work', async () => {
  const queue = new DialogQueue()
  await assert.rejects(queue.run(async () => { throw new Error('broken') }), /broken/)
  assert.equal(await queue.run(async () => 2), 2)
})
test('teardown cancels active and queued dialogs and refuses new work', async () => {
  const queue = new DialogQueue()
  const first = queue.run(signal => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })))
  const second = queue.run(async () => assert.fail('queued dialog mounted'))
  const assertions = [assert.rejects(first, /cancelled/), assert.rejects(second, /cancelled/)]
  await tick(); queue.dispose(); await Promise.all(assertions)
  await assert.rejects(queue.run(async () => 1), /cancelled/)
})
test('already aborted request never opens', async () => {
  const queue = new DialogQueue(); const controller = new AbortController(); controller.abort()
  await assert.rejects(queue.run(async () => assert.fail('opened'), controller.signal), /cancelled/)
})
