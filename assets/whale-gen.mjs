#!/usr/bin/env node
/**
 * Regenerate the welcome banner's whale pixel art from the source image.
 *
 * Usage: node assets/whale-gen.mjs
 * Prints the generated art as a JSON array of 10 strings (one per banner
 * row) on stdout. The output must be character-for-character identical to
 * WHALE_ART in src/welcome.ts — test/welcome.test.mjs asserts this.
 *
 * Parameters (the ones used to generate the current WHALE_ART):
 * - bbox x0=108 x1=822 y0=176 y1=718: the source-image crop that bounds the
 *   whale (the image is 936x846; the crop is the whale plus a small margin).
 * - SAMPLE_COLS=28, SAMPLE_ROWS=20: the art grid is 28 cells wide; each of
 *   the 10 banner rows is two half-cells (top half + bottom half, rendered
 *   as the upper/lower half of a block glyph), so 20 half-cell bands are
 *   sampled vertically.
 * - Sampling: one pixel per cell at the BAND CENTER, i.e. column j samples
 *   x = x0 + floor((x1-x0) * (j+0.5) / SAMPLE_COLS) and band k samples
 *   y = y0 + floor((y1-y0) * (k+0.5) / SAMPLE_ROWS).
 * - Classification: a sampled pixel is WHALE when alpha >= 128 and it is
 *   blue (b > r+10 and b > g+10 and b > 140); otherwise TRANSPARENT.
 * - Half-block mapping per cell: top AND bottom whale -> '█', top only ->
 *   '▀', bottom only -> '▄', neither -> ' '.
 * - Post-pass: all-transparent rows are dropped and the column range is
 *   cropped to the bounding box of the whale glyphs. With the parameters
 *   above the whale already fills the crop edge-to-edge, so this is a no-op
 *   (it only matters if the source image or the bbox changes).
 *
 * The PNG is decoded with node built-ins only (zlib inflate of the IDAT
 * stream + the five PNG scanline filters), so the script has no runtime
 * dependencies.
 */

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'whale-source.png')

// ------------------------------------------------------------------ png --

/** Decode an 8-bit RGBA PNG into { width, height, data } (data is RGBA, row-major). */
function decodePng(path) {
  const buf = readFileSync(path)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG (bad signature)`)
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let idat = Buffer.alloc(0)
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat = Buffer.concat([idat, data]) // IDAT may be split across chunks
    }
    pos += 12 + len // chunk length + type + data + CRC
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`${path}: expected 8-bit RGBA, got bit depth ${bitDepth}, color type ${colorType}`)
  }
  const bpp = 4
  const stride = width * bpp
  const raw = inflateSync(idat)
  const out = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] // one filter byte per scanline
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0
      const up = prev[i]
      const upLeft = i >= bpp ? prev[i - bpp] : 0
      let v = line[i]
      switch (filter) {
        case 0: break // None
        case 1: v += left; break // Sub
        case 2: v += up; break // Up
        case 3: v += (left + up) >> 1; break // Average
        case 4: { // Paeth
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          break
        }
        default: throw new Error(`${path}: unknown scanline filter ${filter}`)
      }
      cur[i] = v & 0xff
    }
    prev = cur
  }
  return { width, height, data: out }
}

// ------------------------------------------------------------ sampling --

// Source-crop bbox of the whale (see the header comment).
const X0 = 108
const X1 = 822
const Y0 = 176
const Y1 = 718
const SAMPLE_COLS = 28
const SAMPLE_ROWS = 20 // 2 half-cells per banner row -> 10 rows

/** Blue? The classification rule: opaque (alpha >= 128) and blue-dominant. */
function isWhalePixel(img, x, y) {
  const o = (y * img.width + x) * 4
  const a = img.data[o + 3]
  const r = img.data[o]
  const g = img.data[o + 1]
  const b = img.data[o + 2]
  return a >= 128 && b > r + 10 && b > g + 10 && b > 140
}

/** Sample the pixel at the center of cell column j / half-row band k. */
function sampleHalf(img, j, k) {
  const x = X0 + Math.floor(((X1 - X0) * (j + 0.5)) / SAMPLE_COLS)
  const y = Y0 + Math.floor(((Y1 - Y0) * (k + 0.5)) / SAMPLE_ROWS)
  return isWhalePixel(img, x, y)
}

// ---------------------------------------------------------------- art --

/** Build the 28x10 art grid, then crop all-transparent rows/columns. */
function generateArt(img) {
  const rows = []
  for (let i = 0; i < SAMPLE_ROWS / 2; i++) {
    let row = ''
    for (let j = 0; j < SAMPLE_COLS; j++) {
      const top = sampleHalf(img, j, 2 * i)
      const bottom = sampleHalf(img, j, 2 * i + 1)
      row += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    rows.push(row)
  }
  // Crop: drop all-transparent rows, then narrow to the whale's column range.
  const kept = rows.filter(row => /[█▀▄]/.test(row))
  let left = SAMPLE_COLS
  let right = -1
  for (const row of kept) {
    const first = row.search(/[█▀▄]/)
    if (first === -1) continue
    left = Math.min(left, first)
    let last = first
    for (let j = row.length - 1; j >= 0; j--) {
      if (row[j] !== ' ') { last = j; break }
    }
    right = Math.max(right, last)
  }
  return kept.map(row => row.slice(left, right + 1))
}

// ----------------------------------------------------------------- main --

const img = decodePng(SOURCE)
const art = generateArt(img)
console.log(JSON.stringify(art))

