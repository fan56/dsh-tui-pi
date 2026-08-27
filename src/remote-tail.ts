/**
 * RemoteSessionTail — a READ-ONLY view over a session log that another
 * dsh PROCESS is driving. Firehose events do not cross the process
 * boundary, so a surface refusing to fork the log (single-writer guard)
 * can still satisfy "both ends eventually show the final reply" by
 * watching persisted bytes: poll-decode the whole jsonl.zstd (frames are
 * independent concatenations, so full decode is append-correct), and emit
 * only the durable suffix rows that appeared since the previous tick.
 *
 * Display contract (deliberately lossy): streaming deltas are skipped;
 * durable rows only — user/message, assistant/message (the FINAL LLM text),
 * tool/call + tool/result, plus turn/start|end so the viewer can
 * synthesize a working/idle indicator from the driver's lifecycle.
 * Latency is the poll interval; detail may be coarser than the driving
 * surface's live view — but every turn's final assistant message arrives.
 */

import { execFile } from 'node:child_process'
import { join } from 'node:path'

const TURN_START = 'turn/start'
const TURN_END = 'turn/end'

/** Durable row types rendered in a remote view, in log order — streaming
 * deltas excluded (see module doc for the display contract). */
const DURABLE_TYPES: ReadonlySet<string> = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  TURN_START,
  TURN_END,
])

export interface RemoteTailEvent {
  type?: string
  seq?: number
}

export interface RemoteTailCallbacks {
  /** New durable events, in log-append order (possibly empty per tick). */
  onEvents(events: RemoteTailEvent[]): void
  /** Decode failure tick — transient IO hiccups are non-fatal noise. */
  onError?(error: unknown): void
}

export interface RemoteTailOptions {
  /** Poll cadence; defaults to 2s (cross-process latency is accepted). */
  intervalMs?: number
  /** Decoder seam — tests substitute a pure function; default shells zstd. */
  decode?(file: string): Promise<string>
}

function defaultDecode(file: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('zstd', ['-dc', file], { maxBuffer: 1 << 30 }, (error, stdout) => {
      if (error !== null && error !== undefined) rejectPromise(error)
      else resolvePromise(Buffer.from(stdout as unknown as string, 'utf8').toString('utf8'))
    })
  })
}

export class RemoteSessionTail {
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking: boolean = false
  /** Rows already emitted — append-only watermark across ticks. */
  private seenRows: number = 0
  private readonly file: string
  private readonly callbacks: RemoteTailCallbacks
  private readonly options: RemoteTailOptions

  constructor(file: string, callbacks: RemoteTailCallbacks, options: RemoteTailOptions = {}) {
    this.file = file
    this.callbacks = callbacks
    this.options = options
  }

  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 2000)
  }

  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Force one poll immediately — the deterministic backfill entry point. */
  tickOnce(): Promise<void> {
    return this.tick(true)
  }

  /** Where the watched log lives — tests assert on it. */
  getWatchedFile(): string {
    return join(this.file)
  }

  private async tick(force: boolean = false): Promise<void> {
    if (this.ticking) return
    if (!force && this.timer === undefined) return
    this.ticking = true
    try {
      const decode = this.options.decode ?? defaultDecode
      const text = await decode(this.file)
      const lines = text.split('\n').filter(line => line.trim() !== '')
      // Log shrank underneath us (repair/rename) — treat as a fresh stream
      // rather than emitting a bogus negative diff.
      if (lines.length < this.seenRows) this.seenRows = 0
      const fresh: RemoteTailEvent[] = []
      for (let i = this.seenRows; i < lines.length; i++) {
        let value: unknown
        try {
          value = JSON.parse(lines[i])
        } catch {
          continue // torn trailing frame mid-decode — next tick re-reads it
        }
        if (typeof value !== 'object' || value === null) continue
        const event = value as RemoteTailEvent
        if (event.type !== undefined && DURABLE_TYPES.has(event.type)) fresh.push(event)
      }
      this.seenRows = lines.length
      if (fresh.length > 0) this.callbacks.onEvents(fresh)
    } catch (error) {
      this.callbacks.onError?.(error)
    } finally {
      this.ticking = false
    }
  }
}
