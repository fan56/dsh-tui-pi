/**
 * User-message image attachment rendering (src/attachments.ts + the
 * renderUserMessage wiring in src/messages.ts).
 *
 * dsh records attached images in user content as ImageBlocks whose
 * attachment is a content-addressed REFERENCE (attachmentId embeds the
 * sha256); the bytes live under $DSH_HOME/attachments/v1/objects/. The
 * transcript renders a muted placeholder the moment the event arrives,
 * then loads bytes out of band and swaps in a pi-tui Image component —
 * bitmap on kitty/iterm2 terminals, text fallback elsewhere, a muted
 * "unavailable" note on load failure. Every load is fire-and-forget: the
 * transcript never blocks or throws on a bad attachment.
 *
 * The reader is injected per test (__setImageReaderForTest) so no real
 * store is touched. Runs against the built lib/ (pretest builds).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Container, getPngDimensions } from '@earendil-works/pi-tui'
import {
  MAX_IMAGES_PER_MESSAGE,
  __setImageReaderForTest,
  attachmentsRoot,
  isImageBlock,
  renderImageAttachments,
} from '../lib/attachments.js'
import { TranscriptRenderer } from '../lib/messages.js'
import { darkTheme } from '../lib/theme/index.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

function imageBlock(overrides = {}) {
  return {
    type: 'image',
    attachment: {
      attachmentId: 'sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      mediaType: 'image/png',
      bytes: 128,
      width: 320,
      height: 240,
      name: 'photo.png',
      ...overrides,
    },
  }
}

/** Flush microtasks so the fire-and-forget slot loads settle. */
async function settle(times = 3) {
  for (let i = 0; i < times; i++) await new Promise(resolve => setImmediate(resolve))
}

/**
 * Poll until `predicate` holds or ~1s elapses. The real-reader tests do
 * actual filesystem I/O inside the fire-and-forget load, which takes real
 * macrotasks — microtask flushing alone cannot wait for it.
 */
async function eventually(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('attachmentsRoot resolves from DSH_HOME or the injected home', async () => {
  const { join } = await import('node:path')
  const real = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/dsh-somewhere'
    assert.equal(attachmentsRoot(), join('/tmp/dsh-somewhere', 'attachments', 'v1'))
    assert.equal(attachmentsRoot('/custom/home'), join('/custom/home', 'attachments', 'v1'))
  } finally {
    if (real === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = real
  }
})

test('isImageBlock accepts image blocks and rejects everything else', () => {
  assert.equal(isImageBlock(imageBlock()), true)
  assert.equal(isImageBlock({ type: 'text', text: 'hi' }), false)
  assert.equal(isImageBlock({ type: 'image' }), false, 'image without attachment is not a block')
  assert.equal(isImageBlock(null), false)
  assert.equal(isImageBlock('image'), false)
})

test('placeholder renders synchronously; a successful load swaps in the Image component', async () => {
  const doc = new Container()
  const renders = []
  const reader = (root, ref) => {
    renders.push({ root, ref })
    return Promise.resolve({ data: new Uint8Array([1, 2, 3]) })
  }
  renderImageAttachments(doc, [imageBlock()], darkTheme, {
    root: '/fake/root',
    read: reader,
    requestRender: () => {},
  })
  // Synchronous phase: one slot with the loading placeholder (+ trailing spacer).
  const slot = doc.children[0]
  const immediate = slot.render(120).join('\n')
  assert.ok(immediate.includes('🖼 photo.png — loading (320×240)'), `placeholder present (${stripAnsi(immediate)})`)
  // The loader is invoked in loadImageSlot's synchronous prefix (only the
  // swap waits on the promise) — bytes are requested immediately.
  assert.equal(renders.length, 1, 'bytes requested in the sync prefix')
  assert.equal(renders[0].root, '/fake/root')
  assert.equal(renders[0].ref.attachmentId, 'sha256-' + 'a'.repeat(64))

  await settle()
  assert.equal(renders.length, 1, 'bytes requested exactly once')
  const settled = slot.render(120).join('\n')
  assert.ok(!settled.includes('— loading'), 'placeholder replaced after the load')
  // Stub terminals report no image protocol, so the component renders its
  // own text fallback carrying the filename and mime type.
  assert.ok(settled.includes('photo.png'), `fallback text shows the filename (${stripAnsi(settled)})`)
  assert.ok(settled.includes('[image/png]'), 'fallback text shows the mime type')
})

test('a failed load degrades to a muted unavailable note with the error code', async () => {
  const doc = new Container()
  const failure = Object.assign(new Error('Attachment object is missing.'), { code: 'ATTACHMENT_NOT_FOUND' })
  renderImageAttachments(doc, [imageBlock({ name: undefined })], darkTheme, {
    root: '/fake/root',
    read: () => Promise.reject(failure),
    requestRender: () => {},
  })
  await settle()
  const out = stripAnsi(doc.children[0].render(160).join('\n'))
  assert.ok(out.includes('unavailable (ATTACHMENT_NOT_FOUND)'), `note carries the code (${out})`)
  // Unnamed attachments fall back to the attachment id for the label.
  assert.ok(out.includes('sha256-'), 'label falls back to the attachment id')
})

test('a code-less failure still degrades to a note (never throws)', async () => {
  const doc = new Container()
  renderImageAttachments(doc, [imageBlock()], darkTheme, {
    root: '/fake/root',
    read: () => Promise.reject(new Error('boom')),
    requestRender: () => {},
  })
  await settle()
  const out = stripAnsi(doc.children[0].render(160).join('\n'))
  assert.ok(out.includes('unavailable'), 'plain note without a code')
  assert.ok(!out.includes('boom'), 'error message is not leaked into the transcript')
})

test('more than MAX_IMAGES_PER_MESSAGE blocks collapse into a "+N more" line', async () => {
  const doc = new Container()
  const blocks = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 3 }, (_, i) => imageBlock({ name: `img${i}.png` }))
  let loads = 0
  renderImageAttachments(doc, blocks, darkTheme, {
    root: '/fake/root',
    read: () => {
      loads++
      return Promise.resolve({ data: new Uint8Array([9]) })
    },
    requestRender: () => {},
  })
  await settle()
  assert.equal(loads, MAX_IMAGES_PER_MESSAGE, 'only the capped slot count loads bytes')
  const text = doc.children.map(child => stripAnsi(child.render(200).join('\n'))).join('\n')
  assert.ok(text.includes('+3 more images not shown'), 'overflow collapses into one line')
})

test('renderUserMessage renders the bubble AND the image slots for a mixed message', async () => {
  const doc = new Container()
  const renders = []
  const renderer = new TranscriptRenderer(doc, darkTheme, () => {})
  __setImageReaderForTest((root, ref) => {
    renders.push(ref)
    return Promise.resolve({ data: new Uint8Array([1]) })
  })
  try {
    renderer.applyEvent({
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: 'look at this' }, imageBlock()],
        source: { kind: 'user' },
      },
      ts: 0,
      seq: 1,
    })
    const text = doc.children.map(child => stripAnsi(child.render(200).join('\n'))).join('\n')
    assert.ok(text.includes('▎ look at this'), 'text bubble renders')
    assert.ok(text.includes('🖼 photo.png — loading'), 'image slot renders')
    await settle()
    assert.equal(renders.length, 1, 'bytes loaded for the attachment')
  } finally {
    __setImageReaderForTest(undefined)
  }
})

test('an image-only user message (no text) still renders its slots', async () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, darkTheme, () => {})
  __setImageReaderForTest(() => Promise.resolve({ data: new Uint8Array([1]) }))
  try {
    renderer.applyEvent({
      type: 'user/message',
      data: { content: [imageBlock()], source: { kind: 'user' } },
      ts: 0,
      seq: 1,
    })
    const text = doc.children.map(child => stripAnsi(child.render(200).join('\n'))).join('\n')
    assert.ok(!text.includes('▎'), 'no empty text bubble')
    assert.ok(text.includes('🖼 photo.png — loading'), 'image slot renders')
  } finally {
    __setImageReaderForTest(undefined)
  }
})

test('the session echo of a locally submitted prompt dedupes the bubble but still renders new attachments', async () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, darkTheme, () => {})
  __setImageReaderForTest(() => Promise.resolve({ data: new Uint8Array([1]) }))
  try {
    // Local submit path renders the echo bubble immediately.
    renderer.renderPromptEcho('hello attached')
    // The session echo carries the SAME text plus an image attached from
    // another surface (web/feishu): the bubble must not duplicate, the
    // image must still arrive.
    renderer.applyEvent({
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: 'hello attached' }, imageBlock()],
        source: { kind: 'user' },
      },
      ts: 0,
      seq: 2,
    })
    await settle()
    const text = doc.children.map(child => stripAnsi(child.render(200).join('\n'))).join('\n')
    assert.equal(text.split('▎ hello attached').length - 1, 1, 'echo bubble not duplicated')
    // After the swap the Image component's fallback carries the filename
    // (no 🖼 lead — that is the placeholder/unavailable note's shape).
    assert.ok(text.includes('photo.png'), 'attachment from the echoed message renders')
  } finally {
    __setImageReaderForTest(undefined)
  }
})

test('injected (non-user) messages never render image slots', async () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, darkTheme, () => {})
  __setImageReaderForTest(() => Promise.resolve({ data: new Uint8Array([1]) }))
  try {
    renderer.applyEvent({
      type: 'user/message',
      data: {
        content: [imageBlock()],
        source: { kind: 'plugin', plugin: 'dsh-test', form: 'notice' },
      },
      ts: 0,
      seq: 1,
    })
    await settle()
    const text = doc.children.map(child => stripAnsi(child.render(200).join('\n'))).join('\n')
    assert.ok(!text.includes('🖼'), 'injected content renders no image slots')
  } finally {
    __setImageReaderForTest(undefined)
  }
})

test('real attachment store: the default reader loads verified bytes from $DSH_HOME layout', async () => {
  // Canonical 1x1 PNG — the fixture self-checks that pi-tui parses its
  // dimensions, so readImageFile's probeImage verification must agree.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  )
  assert.deepEqual(getPngDimensions(png.toString('base64')), { widthPx: 1, heightPx: 1 })
  const sha = createHash('sha256').update(png).digest('hex')
  const home = join(tmpdir(), `dsh-tui-att-${process.pid}-${Date.now()}`)
  const root = join(home, 'attachments', 'v1')
  // dsh-attachment-local's content-addressed layout: objects/<aa>/<sha256>.
  const objectPath = join(root, 'objects', sha.slice(0, 2), sha)
  mkdirSync(dirname(objectPath), { recursive: true })
  writeFileSync(objectPath, png)
  const doc = new Container()
  try {
    // NO injected reader — the real dsh-attachment-local path runs.
    renderImageAttachments(
      doc,
      [{
        type: 'image',
        attachment: {
          attachmentId: `sha256:${sha}`,
          mediaType: 'image/png',
          bytes: png.byteLength,
          width: 1,
          height: 1,
          name: 'pixel.png',
        },
      }],
      darkTheme,
      { root, requestRender: () => {} },
    )
    await eventually(() => !stripAnsi(doc.children[0].render(200).join('\n')).includes('— loading'))
    const out = stripAnsi(doc.children[0].render(200).join('\n'))
    assert.ok(!out.includes('unavailable'), `real read verified and loaded (${out})`)
    assert.ok(out.includes('pixel.png'), 'fallback text shows the stored filename')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('real attachment store: a corrupt object degrades to the unavailable note', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  )
  const sha = createHash('sha256').update(png).digest('hex')
  const home = join(tmpdir(), `dsh-tui-att-corrupt-${process.pid}-${Date.now()}`)
  const root = join(home, 'attachments', 'v1')
  const objectPath = join(root, 'objects', sha.slice(0, 2), sha)
  mkdirSync(dirname(objectPath), { recursive: true })
  writeFileSync(objectPath, Buffer.from('not the bytes you verified')) // digest mismatch
  const doc = new Container()
  try {
    renderImageAttachments(
      doc,
      [{
        type: 'image',
        attachment: {
          attachmentId: `sha256:${sha}`,
          mediaType: 'image/png',
          bytes: png.byteLength,
          width: 1,
          height: 1,
          name: 'broken.png',
        },
      }],
      darkTheme,
      { root, requestRender: () => {} },
    )
    await eventually(() => !stripAnsi(doc.children[0].render(200).join('\n')).includes('— loading'))
    const out = stripAnsi(doc.children[0].render(200).join('\n'))
    assert.ok(out.includes('unavailable'), `integrity failure degrades to a note (${out})`)
    assert.ok(out.includes('ATTACHMENT_CORRUPT'), 'the dsh error code surfaces in the transcript')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
