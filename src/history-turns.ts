/**
 * /history turn grouping — the pure `SessionEvent[] → HistoryTurn[]` fold
 * behind the history browser (docs/features/history.md, ADR 0003).
 *
 * The session log is a linear seq-keyed append-only stream; turns are the
 * `turn/start … turn/end` brackets over it. One completed bracket becomes one
 * HistoryTurn carrying everything the browser's two panes need:
 *
 * - the turn's user prompts (`user/message`, seq order — claimed steer and
 *   follow-up messages land here as ordinary kind-'user' messages; injected
 *   context of other source kinds is NOT a prompt and is excluded, matching
 *   the /resume preview's vocabulary);
 * - the turn's assembled LLM replies (`assistant/message` text blocks, seq
 *   order — a tool-using turn has one per step; the last is the final reply);
 * - the tool-invocation names (`tool/call`, seq order) for the per-tool count
 *   summary line.
 *
 * A `turn/start` whose `turn/end` never arrives (the currently streaming /
 * running turn of a live session) is INCOMPLETE and never reaches the output —
 * a cold-read log has every turn closed, a live snapshot legitimately drops
 * its in-flight tail. Streaming chunks (`assistant/chunk`) are skipped
 * outright: the replay-path rule (iron rule 9) — the assembled message carries
 * the full text.
 *
 * Pure and dependency-free apart from the event types, so it is unit-testable
 * without a terminal or a session store.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One completed `turn/start … turn/end` bracket of a session log. */
export interface HistoryTurn {
  /** The log's turn number (`turn/start` data). Display identity of the row. */
  turn: number
  /** Seq of the `turn/start` event. */
  seqStart: number
  /** Seq of the closing `turn/end` event. */
  seqEnd: number
  /** Kind of the closing `turn/end` reason (`completed`, `aborted`, …). */
  endReason: string
  /** Error message of an `error`-kind turn end, when the log carried one. */
  endError: string | undefined
  /** True when any assembled message of the turn was flagged `interrupted`. */
  interrupted: boolean
  /**
   * Text of every human prompt in the turn, seq order — direct prompts and
   * claimed steer/follow-up messages alike (all source kind 'user').
   */
  userTexts: string[]
  /**
   * One-line preview of the turn: the first human prompt's text, falling back
   * to the first text of any user/message kind (an injected-only turn still
   * gets a readable row). Whitespace as logged.
   */
  previewText: string
  /** Text-bearing assistant message bodies, seq order (one per step). */
  assistantTexts: string[]
  /** Tool invocation names, seq order (repeats included). */
  toolCallNames: string[]
}

/**
 * Join the `text` blocks of a message content array into one trimmed string
 * (multi-block bodies join with newlines so copy stays faithful). Defensive
 * over the erased shape — a malformed log row yields '' instead of throwing.
 */
function blocksText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    const typed = block as { type?: unknown; text?: unknown } | null
    if (typed?.type === 'text' && typeof typed.text === 'string') {
      text += (text === '' ? '' : '\n') + typed.text
    }
  }
  return text.trim()
}

/** Mutable accumulator for one open turn bracket. */
interface OpenTurn {
  turn: number
  seqStart: number
  seqEnd: number
  endReason: string
  endError: string | undefined
  interrupted: boolean
  userEntries: Array<{ kind: string; text: string }>
  assistantTexts: string[]
  toolCallNames: string[]
}

/**
 * Fold a session event snapshot into the completed turns, in log order.
 * Unclosed brackets (the live turn still streaming when the snapshot was
 * taken) and events outside any bracket are dropped.
 */
export function groupHistoryTurns(events: readonly SessionEvent[]): HistoryTurn[] {
  const turns: HistoryTurn[] = []
  let open: OpenTurn | undefined
  const close = (): void => {
    if (open === undefined) return
    const userTexts = open.userEntries
      .filter(entry => entry.kind === 'user' && entry.text !== '')
      .map(entry => entry.text)
    const anyText = open.userEntries.find(entry => entry.text !== '')?.text ?? ''
    turns.push({
      turn: open.turn,
      seqStart: open.seqStart,
      seqEnd: open.seqEnd,
      endReason: open.endReason,
      endError: open.endError,
      interrupted: open.interrupted,
      userTexts,
      previewText: userTexts[0] ?? anyText,
      assistantTexts: open.assistantTexts,
      toolCallNames: open.toolCallNames,
    })
    open = undefined
  }
  for (const event of events) {
    if (event.type === 'turn/start') {
      // A new bracket while one is open means the previous one never closed —
      // drop it (incomplete) and start fresh; well-formed logs never hit this.
      open = {
        turn: Number(event.data.turn),
        seqStart: Number(event.seq),
        seqEnd: Number(event.seq),
        endReason: 'completed',
        endError: undefined,
        interrupted: false,
        userEntries: [],
        assistantTexts: [],
        toolCallNames: [],
      }
      continue
    }
    if (open === undefined) continue
    switch (event.type) {
      case 'user/message': {
        const message = event.data as { source?: { kind?: string }; content?: unknown }
        const kind = message.source?.kind ?? ''
        const text = blocksText(message.content)
        open.userEntries.push({ kind, text })
        break
      }
      case 'assistant/message': {
        const message = event.data.message
        const text = blocksText(message.content)
        if (text !== '') open.assistantTexts.push(text)
        if (event.data.interrupted === true) open.interrupted = true
        break
      }
      case 'tool/call':
        open.toolCallNames.push(event.data.name)
        break
      case 'turn/end': {
        open.seqEnd = Number(event.seq)
        open.endReason = event.data.reason.kind
        const error = event.data.reason as { error?: { message?: string } }
        open.endError = typeof error.error?.message === 'string' ? error.error.message : undefined
        close()
        break
      }
      default:
        // assistant/chunk (iron rule 9: replay paths never consume chunks),
        // step/start|end, request/*, command/*, todo/write, … — no turn pane
        // needs them.
        break
    }
  }
  // A trailing unclosed bracket (the live turn mid-flight) is dropped by
  // never closing it.
  return turns
}

/**
 * The user prompt text a `c`/Enter copy refills the editor with: the turn's
 * first human prompt. `undefined` when the turn carries NO human prompt —
 * an injected-only turn (file-change notices, skill content) must never be
 * refillable into the editor, where one Enter would submit the notice as a
 * prompt. The LEFT-LIST preview keeps its own fallback (`previewText`), so
 * such turns still show a readable row; only the copy path declines.
 */
export function turnPrimaryUserText(turn: HistoryTurn): string | undefined {
  return turn.userTexts[0]
}

/**
 * Case-insensitive substring filter over the row vocabulary: the preview text
 * and the turn number (typing "3" narrows to turn 3xx too — a feature, the
 * number is the row's identity). Empty query matches everything. Mirrors the
 * /model filter's matching convention (matchesModelFilter).
 */
export function matchesTurnFilter(turn: HistoryTurn, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return turn.previewText.toLowerCase().includes(needle)
    || String(turn.turn).includes(needle)
}

/**
 * The `⚙ N tool calls: read×2, edit×1` summary of one turn's tool/call names,
 * in first-appearance order. Empty string for a tool-less turn.
 */
export function toolCallSummary(names: readonly string[]): string {
  if (names.length === 0) return ''
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  const parts = [...counts.entries()].map(([name, count]) => `${name}×${count}`)
  const total = names.length
  return `${total} tool call${total === 1 ? '' : 's'}: ${parts.join(', ')}`
}

/**
 * The fork-at-turn seed: the session events from seq 0 through the selected
 * turn's `turn/end` (inclusive) — the state as that turn finished; later
 * turns stay out of the new session. `seq === array index` holds for live
 * snapshots and persisted `inspect` events alike (restore validates the same
 * contiguity), so a plain slice is exact. Returns [] when the turn is
 * unknown or never closed — only completed turns are forkable. The same
 * balanced-prefix shape the host's fork subagent backend seeds with.
 */
export function turnSeedSlice(events: readonly SessionEvent[], turn: number): readonly SessionEvent[] {
  for (const grouped of groupHistoryTurns(events)) {
    if (grouped.turn === turn) return events.slice(0, grouped.seqEnd + 1)
  }
  return []
}
