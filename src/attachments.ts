/**
 * Transcript rendering for user-message image attachments (pi-tui Image).
 *
 * dsh records attached images in user content as `ImageBlock`s whose
 * attachment is a REFERENCE (attachmentId/mediaType/bytes/width/height),
 * never inline bytes. The reference is content-addressed: the attachmentId
 * embeds the sha256 of the stored bytes, and the durable store lives at
 * `$DSH_HOME/attachments/v1/objects/<aa>/<sha256>` (dsh-attachment-local).
 * The TUI renders a muted placeholder the moment the event arrives, then
 * loads the bytes out of band and swaps the placeholder for a pi-tui
 * `Image` component — kitty/iterm2 terminals paint the real bitmap,
 * everything else falls back to the component's text placeholder
 * (shortened path-style name + OSC 8 file:// link). A failed load (missing
 * object, corrupt digest, metadata mismatch) degrades to a muted
 * "unavailable" note; the transcript never blocks or throws on images.
 *
 * Session replay covers this automatically: resume feeds historical
 * `user/message` events through the same TranscriptRenderer.applyEvent
 * path, so past images render (and re-load) like live ones.
 *
 * Budget: alt-screen image surfaces cost real rows and (under kitty)
 * placements, so a message renders at most {@link MAX_IMAGES_PER_MESSAGE}
 * bitmaps; the rest collapse into a single "+N more" line.
 */

import { Container, Image, Spacer, Text } from '@earendil-works/pi-tui'
import { readImageFile } from '@deepseek-ai/dsh-attachment-local'
import { join } from 'node:path'
import { dshHome } from './append-system.ts'
import { ansiFg, RESET, type TuiTheme } from './theme/index.ts'

/** Bitmaps rendered per message; extra image blocks collapse to a "+N more" line. */
export const MAX_IMAGES_PER_MESSAGE = 8

/** The versioned attachment storage root (`$DSH_HOME/attachments/v1`). */
export function attachmentsRoot(home: string = dshHome()): string {
  return join(home, 'attachments', 'v1')
}

/** The image block shape dsh carries in user-message content (structural). */
export interface ImageBlockLike {
  type: 'image'
  attachment: {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }
}

export function isImageBlock(block: unknown): block is ImageBlockLike {
  return (
    typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'image'
    && typeof (block as { attachment?: unknown }).attachment === 'object'
  )
}

/** Verified stored bytes — the slice of dsh-attachment-local's result we use. */
interface StoredImage {
  data: Uint8Array
}

/**
 * Test seam for the byte loader: TranscriptRenderer calls the render path
 * without deps, so tests swap the loader here instead of faking a dsh
 * attachment store. `undefined` restores the real verified reader.
 */
let testReader: AttachmentReader | undefined
export function __setImageReaderForTest(reader: AttachmentReader | undefined): void {
  testReader = reader
}

/**
 * The byte-loading seam. Structural twin of dsh-attachment-local's
 * `readImageFile(root, ref, signal)` (its branded `ImageAttachmentRef` is
 * the same shape; the cast lives at the default-deps site below).
 */
export type AttachmentReader = (
  root: string,
  ref: ImageBlockLike['attachment'],
  signal?: AbortSignal,
) => Promise<StoredImage>

export interface ImageRenderDeps {
  /** Attachment storage root; defaults to {@link attachmentsRoot}. */
  root?: string
  /** Byte loader; defaults to dsh-attachment-local's verified reader. */
  read?: AttachmentReader
  /** Repaint hook fired when an async load settles; defaults to a no-op. */
  requestRender?: () => void
}

/**
 * Render a message's image blocks into the transcript doc: one slot per
 * image (placeholder → loaded bitmap / unavailable note), then a trailing
 * Spacer. Never throws — a bad attachment degrades to a note.
 */
export function renderImageAttachments(
  doc: Container,
  blocks: readonly ImageBlockLike[],
  theme: TuiTheme,
  deps: ImageRenderDeps = {},
): void {
  if (blocks.length === 0) return
  const read = deps.read ?? testReader ?? (readImageFile as unknown as AttachmentReader)
  const root = deps.root ?? attachmentsRoot()
  const requestRender = deps.requestRender ?? (() => {})
  const muted = (text: string) => new Text(ansiFg(theme.palette.fgMuted) + text + RESET, 1, 0)
  // The component's own text fallback (unsupported terminal) carries the
  // same muted paint as our loading/unavailable notes.
  const imageTheme = { fallbackColor: (str: string) => ansiFg(theme.palette.fgMuted) + str + RESET }
  const shown = blocks.slice(0, MAX_IMAGES_PER_MESSAGE)
  for (const block of shown) {
    const slot = new Container()
    const name = block.attachment.name ?? block.attachment.attachmentId
    const placeholder = muted(`🖼 ${name} — loading (${block.attachment.width}×${block.attachment.height})`)
    slot.addChild(placeholder)
    doc.addChild(slot)
    void loadImageSlot(slot, placeholder, block, { read, root, requestRender, muted, imageTheme })
  }
  if (blocks.length > shown.length) {
    doc.addChild(muted(`🖼 +${blocks.length - shown.length} more images not shown`))
  }
  doc.addChild(new Spacer(1))
}

/**
 * Settle one slot: swap the placeholder for the loaded Image (the
 * component itself decides bitmap vs text fallback by terminal capability)
 * or, on failure, for a muted "unavailable" note carrying the attachment
 * error code. Fire-and-forget by contract — every rejection is caught.
 */
async function loadImageSlot(
  slot: Container,
  placeholder: Text,
  block: ImageBlockLike,
  deps: {
    read: AttachmentReader
    root: string
    requestRender: () => void
    muted: (text: string) => Text
    imageTheme: { fallbackColor: (str: string) => string }
  },
): Promise<void> {
  const name = block.attachment.name ?? block.attachment.attachmentId
  let loaded: StoredImage
  try {
    loaded = await deps.read(deps.root, block.attachment)
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code
      ?? (error as { detailCode?: string } | undefined)?.detailCode
    slot.removeChild(placeholder)
    slot.addChild(deps.muted(`🖼 ${name} — unavailable${code ? ` (${code})` : ''}`))
    try { deps.requestRender() } catch { /* TUI already disposed */ }
    return
  }
  const base64 = Buffer.from(loaded.data).toString('base64')
  slot.removeChild(placeholder)
  slot.addChild(new Image(
    base64,
    block.attachment.mediaType,
    deps.imageTheme,
    { filename: block.attachment.name },
  ))
  try { deps.requestRender() } catch { /* TUI already disposed */ }
}
