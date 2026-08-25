/**
 * notice-bridge.ts — the shared, terminal-safe channel for operator traces.
 *
 * The plugin runs IN-PROCESS with the TUI, which owns stdout for the
 * alt-screen render; a stray stdout OR stderr line lands on the frame as
 * garbage (raw bytes are pasted between render passes and scribble over
 * the session body). Every diagnostic this plugin used to print with
 * `console.warn` — invalid settings values (retention/resume), the
 * settings-namespace registration failure, the missing userQuestions
 * service, the retention result line — now rides this bridge instead:
 *
 *   sink registered   → delivered immediately, one sink call per message;
 *   sink not yet up   → held pending, the whole batch drained (in emission
 *                       order) when the TUI registers its sink;
 *   sink never comes  → silently dropped (headless run, failed startup).
 *
 * Deliberately NO flush timer and NO stderr fallback for the never-registered
 * case: a timer firing after a slow-starting TUI has already entered the
 * alt-screen would write raw bytes over the frame — the exact failure this
 * bridge exists to prevent — and a headless process has no reader worth
 * spamming. The pending queue is bounded (FIFO, oldest dropped) as
 * pathological-burst insurance; every known producer is startup-scoped.
 *
 * `/reload` semantics, stated precisely: what prevents old messages from
 * being replayed is ESM module-cache eviction on a SUCCESSFUL reload (the
 * evicted module's bridge state dies with it; the freshly imported module
 * starts empty) combined with each producer's own re-entry guard (e.g. the
 * janitor's process-global one-shot) — NOT "pending is cleared on delivery"
 * per se. On a reload that FAILS and rolls back (the same module instance
 * re-starts), effect teardown has cleared the sink but module state
 * survives, so still-pending messages are consumed exactly once by the
 * restarted TUI's registration — by design, bounded to at most one batch.
 */

/** Consumer of one notice message (the running TUI's notice surface). */
export type NoticeSink = (message: string) => void

/**
 * Undelivered-message cap. The five known producers are startup-scoped and
 * emit at most a handful each (worst realistic batch ≈ 8 lines), so this is
 * insurance against a runaway producer in a process whose sink never
 * registers — not an expected limit.
 */
const MAX_PENDING_NOTICES = 16

let noticeSink: NoticeSink | undefined
let pendingNotices: string[] = []

/**
 * Register (or clear) the sink that displays notices. Registering drains
 * every message still pending — each as its own sink call, in emission
 * order, at most once. The batch is detached from the queue before the
 * first call (a throwing or re-entrant sink can never see a message
 * twice); `noticeSink` is re-read per iteration so a sink that unregisters
 * itself mid-drain stops delivery — the undelivered remainder goes back to
 * the front of the queue instead of being written into a dead surface. A
 * sink call that THROWS propagates out and the rest of its batch stays
 * consumed (delivery stops; retrying against a broken sink is futile).
 * Clearing (`undefined`) never delivers anything; later messages queue up
 * for the next registration.
 */
export function setNoticeSink(sink: NoticeSink | undefined): void {
  noticeSink = sink
  if (sink === undefined || pendingNotices.length === 0) return
  const batch = pendingNotices
  pendingNotices = []
  while (batch.length > 0) {
    const current = noticeSink
    if (current === undefined) break
    const message = batch.shift()
    if (message !== undefined) current(message)
  }
  if (batch.length > 0) pendingNotices = batch.concat(pendingNotices)
}

/**
 * Emit one notice: straight to the sink when one is registered, otherwise
 * queued (bounded FIFO) until registration — or dropped forever when no
 * sink ever arrives. Never writes to the terminal directly.
 */
export function emitNotice(text: string): void {
  if (noticeSink !== undefined) {
    noticeSink(text)
    return
  }
  pendingNotices.push(text)
  if (pendingNotices.length > MAX_PENDING_NOTICES) pendingNotices.shift()
}

/**
 * Take (and clear) every message still waiting for a sink, in emission
 * order. Test seam and drain valve — guarantees stale pending messages
 * can never outlive the module state they belong to.
 */
export function takePendingNotices(): string[] {
  const batch = pendingNotices
  pendingNotices = []
  return batch
}

/**
 * Test seam: drop the sink AND every pending message, restoring the
 * module to its import-time state so test-order leakage is impossible.
 */
export function resetNoticeBridge(): void {
  noticeSink = undefined
  pendingNotices = []
}
