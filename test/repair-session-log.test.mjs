/**
 * repair-session-log fixtures: synthetic two-writer corruptions (generic
 * payloads only) exercised through the script's CLI surface. Plain-mode
 * covers the policy end-to-end without a zstd dependency; one zstd round
 * trip proves the framing layer. Real ~/.dsh is never touched — every
 * fixture lives in mkdtemp dirs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = new URL('../scripts/repair-session-log.mjs', import.meta.url).pathname

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `repair-${name}-`))
}

function run(file, extra = []) {
  const proc = spawnSync(process.execPath, [SCRIPT, file, ...extra], { encoding: 'utf8' })
  return { code: proc.status, out: proc.stdout ?? '', err: proc.stderr ?? '' }
}

const headerLine = JSON.stringify({ type: 'session', version: 0, id: 'fix-1', createdAt: 1 })

/** A plain durable row; `data` kept tiny but distinct per seq. */
function plain(seq, type = 'assistant/message') {
  return JSON.stringify({ type, seq, time: 1000 + seq * 10, data: { turn: 1, step: 1, note: `evt-${seq}` } })
}

/** A packed delta run occupying slots [seq0, seq0+len-1]. */
function packed(seq0, len) {
  return JSON.stringify({
    type: 'text-chunks',
    seq0,
    time0: 500,
    data: { turn: 1, step: 1, index: 0, dt: Array.from({ length: len - 1 }, () => 5), texts: Array.from({ length: len }, (_, i) => `t${i}`) },
  })
}

test('a clean log is diagnosed CLEAN and nothing is written', () => {
  const dir = tempDir('clean')
  const file = join(dir, 's.jsonl')
  writeFileSync(file, `${[headerLine, plain(0), plain(1), plain(2)].join('\n')}\n`)
  const res = run(file)
  assert.equal(res.code, 0)
  assert.match(res.out, /CLEAN/)
  assert.deepEqual(readdirSync(dir), ['s.jsonl'])
  rmSync(dir, { recursive: true, force: true })
})

test('two-writer interleave: unique rows on both sides survive, shadowed copies drop, dense renumber holds', () => {
  const dir = tempDir('interleave')
  const file = join(dir, 's.jsonl')
  // Committed prefix … then writer B re-emits its own stream while writer A
  // continues past the fork; both climb over the same slots with different
  // content, and only B reaches the tail.
  const rows = [
    headerLine,
    plain(0), plain(1),
    plain(2), plain(3), plain(4), plain(5),
    plain(2), plain(3),
    plain(6), plain(7),
    plain(4), plain(5), plain(6), plain(7),
    plain(8), plain(9),
  ]
  writeFileSync(file, `${rows.join('\n')}\n`)
  const before = readFileSync(file)

  const dry = run(file)
  assert.equal(dry.code, 3, 'corrupt diagnosis exits 3 in dry-run')
  assert.match(dry.out, /dry-run/)
  assert.deepEqual(readFileSync(file), before, 'dry-run writes nothing')

  const apply = run(file, ['--apply'])
  assert.equal(apply.code, 0, apply.err)
  assert.deepEqual(readFileSync(file), before, '--apply never touches the original')

  const fixed = readFileSync(join(dir, 's.repaired.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const seqs = fixed.filter(r => Number.isSafeInteger(r.seq)).map(r => r.seq)
  assert.deepEqual(seqs, seqs.map((_, i) => i), 'renumbered dense from 0')
  const notes = fixed.filter(r => r.data?.note !== undefined).map(r => r.data.note)
  for (let s = 0; s <= 9; s++) {
    assert.ok(notes.includes(`evt-${s}`), `unique slot ${s} survived`)
  }
  assert.equal(notes.length, new Set(notes).size, 'no shadowed copy survives')
  rmSync(dir, { recursive: true, force: true })
})

test('packed chunk runs occupy their full span during dedupe and keep that width after renumbering', () => {
  const dir = tempDir('packed')
  const file = join(dir, 's.jsonl')
  const rows = [
    headerLine,
    plain(0),
    packed(1, 3), // covers slots 1..3
    plain(4),
    // Second writer duplicates some coverage and adds one unique slot:
    plain(2), plain(3),
    plain(5),
    packed(1, 3),
  ]
  writeFileSync(file, `${rows.join('\n')}\n`)
  const apply = run(file, ['--apply'])
  assert.equal(apply.code, 0, apply.err)

  const fixed = readFileSync(join(dir, 's.repaired.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const packedRows = fixed.filter(r => r.type === 'text-chunks')
  assert.equal(packedRows.length, 1, 'shadowed packed copy drops')
  assert.equal(packedRows[0].seq0, 1, 'renumbered into place after prefix row 0')
  assert.equal(packedRows[0].data.texts.length, 3, 'internal span width preserved')
  const afterSpan = fixed.find(r => Number.isSafeInteger(r.seq) && r.seq === 4)
  assert.ok(afterSpan, 'row after the packed span lands at slot 4 (span width honored)')
  rmSync(dir, { recursive: true, force: true })
})

test('zstd input produces .repaired.jsonl.zstd output that decompresses clean', () => {
  const dir = tempDir('zstd')
  const file = join(dir, 's.jsonl.zstd')
  const rows = [headerLine, plain(0), plain(1), plain(2), plain(3), plain(3), plain(4)]
  const raw = spawnSync('zstd', ['-19'], { input: Buffer.from(`${rows.join('\n')}\n`), maxBuffer: 1 << 20 })
  assert.equal(raw.status, 0)
  writeFileSync(file, raw.stdout)
  const apply = run(file, ['--apply'])
  assert.equal(apply.code, 0, apply.err)
  const back = spawnSync('zstd', ['-dc', join(dir, 's.repaired.jsonl.zstd')], { maxBuffer: 1 << 20 })
  assert.equal(back.status, 0)
  const seqs = back.stdout.toString('utf8').trim().split('\n').map(JSON.parse)
    .filter(r => Number.isSafeInteger(r.seq)).map(r => r.seq)
  assert.deepEqual(seqs, [0, 1, 2, 3, 4], 'the shadowed duplicate of slot 3 dropped; dense order restored')
  rmSync(dir, { recursive: true, force: true })
})

test('apply output honors the loader frame contract: frame 1 is the header line alone', () => {
  const dir = tempDir('frames')
  const file = join(dir, 's.jsonl.zstd')
  const rows = [headerLine, plain(0), plain(1), packed(2, 5), plain(7), plain(7), plain(8)]
  const raw = spawnSync('zstd', ['-19'], { input: Buffer.from(`${rows.join('\n')}\n`), maxBuffer: 1 << 20 })
  assert.equal(raw.status, 0)
  writeFileSync(file, raw.stdout)
  const apply = run(file, ['--apply'])
  assert.equal(apply.code, 0, apply.err)

  const out = readFileSync(join(dir, 's.repaired.jsonl.zstd'))
  const magics = []
  for (let i = 0; i <= out.length - 4; i++) {
    if (out[i] === 0x28 && out[i + 1] === 0xB5 && out[i + 2] === 0x2F && out[i + 3] === 0xFD) magics.push(i)
  }
  // dsh's jsonl loader requires the FIRST frame to hold exactly one header
  // line; a single-frame rewrite is rejected with "first frame is not exactly
  // one header line" and bricks /resume listing for the whole workspace.
  assert.ok(magics.length >= 2, `expected multiple frames, got ${magics.length}`)
  const firstSlice = out.subarray(magics[0], magics[1])
  const firstBack = spawnSync('zstd', ['-dc'], { input: firstSlice, maxBuffer: 1 << 20 })
  assert.equal(firstBack.status, 0)
  const firstLines = firstBack.stdout.toString('utf8').trim().split('\n')
  assert.equal(firstLines.length, 1, 'frame 1 must be the header line alone')
  assert.equal(JSON.parse(firstLines[0]).seq, undefined, 'frame 1 is the identity row')

  const back = spawnSync('zstd', ['-dc', join(dir, 's.repaired.jsonl.zstd')], { maxBuffer: 1 << 20 })
  assert.equal(back.status, 0)
  // Expand covered slots: plain rows carry `seq`, packed runs carry `seq0` +
  // a dt span (`dt.length + 1` slots starting at seq0).
  const seqs = back.stdout.toString('utf8').trim().split('\n').map(JSON.parse)
    .flatMap(r => Number.isSafeInteger(r.seq)
      ? [r.seq]
      : Number.isSafeInteger(r.seq0)
        ? Array.from({ length: r.data.dt.length + 1 }, (_, i) => r.seq0 + i)
        : []) // identity/header rows occupy no seq slot
  assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5, 6, 7, 8])
  rmSync(dir, { recursive: true, force: true })
})

test('torn lines abort with exit 2 by default and are droppable with --skip-bad-lines', () => {
  const dir = tempDir('torn')
  const file = join(dir, 's.jsonl')
  // A concurrent-append artifact: a row cut off mid-write.
  const torn = '{"type":"assistant/mess'

  // Case 1: otherwise-clean log — the flag merely tolerates the tear; the
  // remaining rows are healthy, so nothing needs repairing.
  writeFileSync(file, `${[headerLine, plain(0), plain(1)].join('\n')}\n${torn}\n`)
  const strict = run(file)
  assert.equal(strict.code, 2, 'unparseable input is fatal without the flag')
  assert.match(strict.err, /--skip-bad-lines/)
  assert.equal(readdirSync(dir).includes('s.repaired.jsonl'), false)

  const lenient = run(file, ['--apply', '--skip-bad-lines'])
  assert.equal(lenient.code, 0, lenient.err)
  assert.match(lenient.out, /skipped bad lines/)
  assert.match(lenient.out, /CLEAN/, 'healthy remainder needs no artifact')
  rmSync(dir, { recursive: true, force: true })

  // Case 2: corrupt log WITH a tear — the flag unblocks the actual repair.
  const dir2 = tempDir('torn-corrupt')
  const file2 = join(dir2, 's.jsonl')
  const corrupted = [headerLine, plain(0), plain(1), plain(3), plain(3), plain(4)]
  writeFileSync(file2, `${corrupted.join('\n')}\n${torn}\n`)
  const repair = run(file2, ['--apply', '--skip-bad-lines'])
  assert.equal(repair.code, 0, repair.err)
  const fixed = readFileSync(join(dir2, 's.repaired.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const seqs = fixed.filter(r => Number.isSafeInteger(r.seq)).map(r => r.seq)
  assert.deepEqual(seqs, [0, 1, 2, 3], 'shadowed duplicate dropped, tear gone, dense from 0')
  rmSync(dir2, { recursive: true, force: true })
})

test('partial overlaps of kept rows are reported explicitly instead of silently duplicated', () => {
  const dir = tempDir('overlap')
  const file = join(dir, 's.jsonl')
  // Writer A owns 0..1; writer B's packed run starts AT slot 1 and reaches 3 —
  // slot 1 is shadowed middle, slots 2..3 are fresh. Kept whole + reported.
  const rows = [headerLine, plain(0), plain(1), packed(1, 3)]
  writeFileSync(file, `${rows.join('\n')}\n`)
  const dry = run(file)
  assert.equal(dry.code, 3)
  assert.match(dry.out, /partially overlapping covered slots/)
  const apply = run(file, ['--apply'])
  assert.equal(apply.code, 0, apply.err)
  const fixed = readFileSync(join(dir, 's.repaired.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const packedRow = fixed.find(r => r.type === 'text-chunks')
  assert.equal(packedRow.seq0, 2, 'packed row lands after the two prefix plain rows')
  assert.equal(packedRow.data.texts.length, 3, 'span width preserved')
  rmSync(dir, { recursive: true, force: true })
})
