#!/usr/bin/env node
/**
 * repair-session-log.mjs — offline surgery for session logs corrupted by
 * concurrent writers. When two dsh processes append to one session log
 * (the cross-process double-resume incident) the storage rows interleave
 * two seq sequences and the loader refuses the log: "corrupt session log:
 * seq gap in committed region …".
 *
 * Storage model (mirrors @deepseek-ai/dsh-session packChunkRuns +
 * dsh-session-persistence-jsonl framing):
 *   `<name>.jsonl.zstd` = concatenated independent zstd frames, each holding
 *   ≥1 storage rows joined by "\n". A row is either
 *   - a plain event `{type, seq?, time?, data}` (seq absent only on the very
 *     first identity rows), or
 *   - a packed delta run `{type:"text-chunks"|"reasoning-chunks"|
 *     "tool-call-chunks", seq0, time0, data:{…, dt:[…]}}`, occupying the seq
 *     span `[seq0, seq0 + payload.length - 1]`.
 *
 * Repair policy (deterministic, conservative):
 *   1. Identity rows without seq are kept verbatim at the top.
 *   2. Every seq-bearing row maps onto its span; rows are then processed in
 *      ascending (seqStart, originalIndex) order — duplicate COVERAGE is
 *      dropped ("loser writer" copies arrive behind the same slots), while
 *      every event slot never seen before survives, whichever writer wrote it.
 *      A row that only PARTIALLY overlaps already-covered slots is still
 *      kept whole (its fresh slots win; the shadowed middle slots stay
 *      duplicated inside the repaired log) — splitting packed rows is
 *      deliberately deferred; such rows are reported explicitly.
 *   3. Survivors are renumbered into one dense seq space (packed rows keep
 *      their internal span width) and written to `<name>.repaired.jsonl[.zstd]`
 *      beside the original. The original is NEVER modified or deleted; to
 *      actually LOAD the repair you must move it over the corrupted name
 *      yourself (the success line prints the exact mv command).
 *
 * Torn/truncated lines (another artifact of concurrent appends) abort the
 * run unless --skip-bad-lines is given, which drops and reports them.
 *
 * Usage:
 *   node scripts/repair-session-log.mjs <log.jsonl.zstd | log.jsonl> [--apply] [--skip-bad-lines]
 *
 * Exit codes: 0 clean/repaired · 3 corrupt (diagnosed; repaired only with
 * --apply) · 2 usage/environment/unparseable-input error. Stop the processes
 * driving the live session BEFORE repairing — this fixes bytes, not agents.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const PACKED_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

function fail(message) {
  console.error(`repair-session-log: ${message}`)
  process.exit(2)
}

function parseRow(line, index) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return undefined // caller decides: fatal without --skip-bad-lines
  }
  const type = typeof value.type === 'string' ? value.type : '(none)'
  const row = { index, line, type, start: null, end: null, slots: 0, hash: '' }
  const payloadLen = () => {
    const data = value.data ?? {}
    const payload = Array.isArray(data.texts) ? data.texts : Array.isArray(data.args) ? data.args : []
    return Math.max(payload.length, 1)
  }
  if (PACKED_TYPES.has(type)) {
    if (!Number.isSafeInteger(value.seq0)) return row // treated as identity-row companion
    row.slots = payloadLen()
    row.start = value.seq0
    row.end = value.seq0 + row.slots - 1
  } else if (Number.isSafeInteger(value.seq)) {
    row.slots = 1
    row.start = value.seq
    row.end = value.seq
  }
  row.hash = createHash('sha256').update(line).digest('hex').slice(0, 12)
  return row
}

function analyze(rows) {
  let prevEnd = -1
  const violations = []
  for (const r of rows) {
    if (r.start === null) continue
    if (r.start <= prevEnd) {
      violations.push({ index: r.index, start: r.start, end: r.end, prevEnd, type: r.type })
    }
    if (r.end > prevEnd) prevEnd = r.end
  }
  return violations
}

/**
 * Survivor selection: identity rows ride along; seq rows sorted by
 * (start, originalIndex) keep every previously-unseen slot. Deterministic
 * across runs, never biased toward a particular writer. Rows whose span
 * crosses the frontier are kept whole AND reported (their shadowed middle
 * slots stay duplicated; see the header note on splitting).
 */
function selectSurvivors(rows) {
  const identity = rows.filter(r => r.start === null)
  const carriers = rows.filter(r => r.start !== null).sort((a, b) => a.start - b.start || a.index - b.index)
  const survivors = []
  const dropped = []
  const partialOverlaps = []
  let frontier = -1
  for (const r of carriers) {
    if (r.end <= frontier) {
      dropped.push({ index: r.index, start: r.start, end: r.end, type: r.type, hash: r.hash })
      continue
    }
    if (r.start <= frontier && r.end > frontier) {
      partialOverlaps.push({ index: r.index, start: r.start, end: r.end })
    }
    survivors.push(r)
    frontier = r.end
  }
  return { identity, survivors, dropped, partialOverlaps }
}

/** Dense renumbering in survivor emission order. */
function renumber(identity, survivors) {
  const out = [...identity.map(r => r.line)]
  let next = 0
  for (const r of survivors) {
    const value = JSON.parse(r.line)
    if (PACKED_TYPES.has(r.type)) {
      value.seq0 = next
      next += r.slots
    } else {
      value.seq = next
      next += 1
    }
    out.push(JSON.stringify(value))
  }
  return { lines: out, lastIndex: next - 1 }
}

function decompress(file) {
  const proc = spawnSync('zstd', ['-dc', file], { maxBuffer: 1 << 30 })
  if (proc.error) fail(`cannot run zstd: ${proc.error.message}`)
  if (proc.status !== 0) fail(`zstd -dc failed on ${file}: ${String(proc.stderr).slice(0, 200)}`)
  return proc.stdout.toString('utf8')
}

function compressTo(text, outPathTmp) {
  const proc = spawnSync('zstd', ['-19'], { input: Buffer.from(text, 'utf8'), maxBuffer: 1 << 30 })
  if (proc.error) fail(`cannot run zstd: ${proc.error.message}`)
  if (proc.status !== 0) fail(`zstd compress failed: ${String(proc.stderr).slice(0, 200)}`)
  writeFileSync(outPathTmp, proc.stdout)
}

function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const skipBadLines = args.includes('--skip-bad-lines')
  const positional = args.filter(a => !a.startsWith('--'))
  if (positional.length !== 1) {
    fail('usage: repair-session-log.mjs <log.jsonl.zstd|log.jsonl> [--apply] [--skip-bad-lines]')
  }
  const file = positional[0]

  const isZstd = file.endsWith('.jsonl.zstd')
  const text = isZstd ? decompress(file) : readFileSync(file, 'utf8')
  const rawLines = text.split('\n').filter(l => l.trim() !== '')
  const rows = []
  const badLines = []
  for (let i = 0; i < rawLines.length; i++) {
    const parsed = parseRow(rawLines[i], i)
    if (parsed === undefined) {
      badLines.push({ index: i + 1, preview: rawLines[i].slice(0, 120) })
      continue
    }
    rows.push(parsed)
  }
  if (badLines.length > 0 && !skipBadLines) {
    for (const bad of badLines.slice(0, 5)) {
      console.error(`repair-session-log: line ${bad.index} unparseable: ${bad.preview}`)
    }
    fail(`${badLines.length} torn/unparseable line(s) — re-run with --skip-bad-lines to drop and report them`)
  }

  const violations = analyze(rows)
  const maxSeq = rows.reduce((m, r) => Math.max(m, r.end ?? -1), -1)

  console.log(`rows: ${rows.length}${badLines.length > 0 ? ` (+${badLines.length} skipped bad lines)` : ''} | maxSeq: ${maxSeq} | seq violations: ${violations.length}`)
  for (const v of violations.slice(0, 10)) {
    console.log(`  ✗ line ${v.index + 1}: ${v.type} covers ${v.start}..${v.end} after coverage through ${v.prevEnd}`)
  }
  if (violations.length > 10) console.log(`  … and ${violations.length - 10} more`)

  if (violations.length === 0) {
    console.log('verdict: CLEAN — nothing to do.')
    return
  }

  const { identity, survivors, dropped, partialOverlaps } = selectSurvivors(rows)
  console.log(`plan: keep ${identity.length} identity + ${survivors.length} event rows (${dropped.length} duplicate-coverage rows dropped), renumber dense.`)
  for (const d of dropped.slice(0, 10)) {
    console.log(`  − line ${d.index + 1}: ${d.type} ${d.start}..${d.end} (shadowed copy [${d.hash}])`)
  }
  for (const p of partialOverlaps.slice(0, 10)) {
    console.log(`  ⚠ line ${p.index + 1}: spans ${p.start}..${p.end}, partially overlapping covered slots — kept whole; the shadowed middle slots stay duplicated in the repaired log`)
  }

  if (!apply) {
    console.log('dry-run: nothing written. Re-run with --apply to write *.repaired beside the original.')
    process.exit(3)
  }

  const { lines: fixedLines, lastIndex } = renumber(identity, survivors)
  const body = `${fixedLines.join('\n')}\n`
  const check = analyze(body.split('\n').filter(l => l.trim() !== '').map(parseRow))
  if (check.length > 0) fail('internal: repaired output still violates seq order — refusing to write')

  const stem = basename(file).replace(/\.jsonl(\.zstd)?$/, '')
  const outPath = join(dirname(file), `${stem}.repaired.jsonl${isZstd ? '.zstd' : ''}`)
  const tmpPath = `${outPath}.tmp`
  if (isZstd) compressTo(body, tmpPath)
  else writeFileSync(tmpPath, body)
  renameSync(tmpPath, outPath)
  console.log(`wrote ${outPath} (${fixedLines.length} rows, dense seq 0..${lastIndex}). Original untouched.`)
  console.log(`activate with:  mv '${outPath}' '${file}'   # only while no process is writing that session`)
}

main()
