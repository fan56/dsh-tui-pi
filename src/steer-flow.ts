/**
 * Main-session steer / follow-up flow — the pure decision layer behind the
 * submit routing dialog and the pending-message queue panel
 * (docs/design-steer-followup.md).
 *
 * Terminology (design §一):
 * - `steer` — inject into the CURRENT turn at the next step boundary
 *   (`agent.steer()`, inbox target `'next-step'`).
 * - `followup` — queue as the first message of the NEXT turn
 *   (`agent.followup()`, inbox target `'next-turn'`).
 * - pending — submitted but not yet claimed by the agent's inbox; the only
 *   removable / re-routeable stage.
 *
 * Everything here is data-in/data-out over a structural agent slice so the
 * whole matrix is unit-testable without a terminal or a live dsh tree; the
 * real registry handle is assignable as-is. Delivery mirrors the subagent
 * viewer's timing defense: callers defer to a microtask and re-resolve
 * liveness at flush time, and this module re-checks `status` again so a turn
 * that ended between the dialog choice and delivery degrades to a queued
 * follow-up instead of failing (design §二.2 race fallback).
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** How the user chose to route a submitted prompt. */
export type PromptRoute = 'followup' | 'steer'

/**
 * Structural slice of a live agent handle the main-prompt delivery needs
 * (`Agent.status` + the two send primitives). Kept structural so tests can
 * pass plain fakes; the real handle is assignable as-is.
 */
export interface DeliverableAgent {
  /** Lifecycle signal: `'idle' | 'running'` on real handles; unknown fails closed. */
  readonly status?: unknown
  /** Submit for the nearest step boundary (running driver) / start a turn (idle). */
  steer(message: unknown): void
  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: unknown): void
}

/** Outcome of one routed main-prompt delivery. */
export type MainDelivery =
  | { outcome: 'sent'; via: PromptRoute }
  | { outcome: 'degraded' }
  | { outcome: 'error'; error: string }

/** The submit path for one line: direct send when idle, dialog when running. */
export function decideSubmitPath(running: boolean): 'direct' | 'dialog' {
  return running ? 'dialog' : 'direct'
}

/**
 * Build the user prompt message — the exact shape `DshSessionBridge.prompt`
 * has always sent (`source: { kind: 'user' }`, plain text content).
 */
export function buildUserPrompt(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Deliver a built message honoring the chosen route, with the design's race
 * fallback: a requested steer that cannot land (the turn ended before
 * delivery — fail-closed on an unexpected/missing status — or the primitive
 * threw) automatically degrades to a queued follow-up. A throwing follow-up
 * surfaces as `{ outcome: 'error' }`; nothing is ever lost silently.
 */
export function deliverToAgent(
  agent: DeliverableAgent,
  message: unknown,
  route: PromptRoute,
): MainDelivery {
  if (route === 'steer') {
    // Flush-time liveness re-check (mirrors resolveInjectionRoute): only a
    // RUNNING driver consumes steering at a step boundary. Anything else —
    // including an unexpected status shape on a foreign handle — reads as
    // "turn no longer in flight" and takes the queued path directly.
    if (agent.status === 'running') {
      try {
        agent.steer(message)
        return { outcome: 'sent', via: 'steer' }
      } catch {
        // steer-unavailable race: fall through to the queued fallback.
      }
    }
    try {
      agent.followup(message)
      return { outcome: 'degraded' }
    } catch (error) {
      return { outcome: 'error', error: errorText(error) }
    }
  }
  try {
    agent.followup(message)
    return { outcome: 'sent', via: 'followup' }
  } catch (error) {
    return { outcome: 'error', error: errorText(error) }
  }
}

// ----------------------------------------------------------- queue actions --

/**
 * One pending (unclaimed) main-session prompt, projected from the live
 * agent inbox by the bridge. `message` keeps the original identity so a
 * promote re-sends the exact object that was queued.
 */
export interface PendingPromptView {
  /** Stable message id (display). */
  readonly id: string
  /** Whitespace-folded single-line preview of the text content. */
  readonly text: string
  /** Which inbox boundary holds it right now. */
  readonly target: 'next-step' | 'next-turn'
  /** The live pending message (promote re-sends this exact object). */
  readonly message: { readonly id: unknown }
}

/** Structural slice of the agent-side inbox projection the actions need. */
export interface RemovableInbox {
  /** Remove one pending message; false when it was already claimed/removed. */
  remove(messageId: unknown): boolean
}

/** Result of one queue-panel action on a pending item. */
export type QueueActionResult =
  | { kind: 'removed' }
  | { kind: 'promoted'; via: PromptRoute; degraded: boolean }
  | { kind: 'not-found' }
  | { kind: 'error'; error: string }

/**
 * Shared degrade notices — one wording source for the submit dialog path,
 * the queue panel and the transcript mirrors (review nit: the copy was
 * duplicated in three places and could drift).
 */
export const STEER_UNAVAILABLE_NOTICE = 'Steering was unavailable — the message stayed queued as a follow-up.'
export const TURN_ENDED_QUEUED_NOTICE = 'The turn ended before the steer could land — queued as a follow-up instead.'

/** Remove one pending message from the inbox (queue panel `d`). */
export function removeFromInbox(inbox: RemovableInbox, view: PendingPromptView): QueueActionResult {
  let removed: boolean
  try {
    removed = inbox.remove(view.message.id)
  } catch (error) {
    return { kind: 'error', error: errorText(error) }
  }
  return removed ? { kind: 'removed' } : { kind: 'not-found' }
}

/**
 * Promote one pending follow-up out of the queue and inject it NOW (strict
 * steer, queue panel `s`): remove from the inbox first, then deliver with
 * `deliverToAgent`'s steer semantics — including the same race fallback, so
 * a promote racing the turn end lands as a queued follow-up instead of
 * failing. A `not-found` means the item was claimed or already removed
 * between render and keypress; the caller refreshes the panel.
 *
 * Double-failure safety (review S2): promote is remove → deliver, so if the
 * delivery fails outright the message would be orphaned OUT of the queue and
 * UNDELIVERED. Before surfacing an error, one recovery `followup` of the
 * original object re-queues it; only when even that throws does the result
 * become an error that says explicitly the message was not delivered and is
 * no longer queued (the user must submit it again).
 */
export function promotePending(
  agent: DeliverableAgent & { readonly inbox: RemovableInbox },
  view: PendingPromptView,
): QueueActionResult {
  const removed = removeFromInbox(agent.inbox, view)
  if (removed.kind !== 'removed') return removed
  const delivery = deliverToAgent(agent, view.message, 'steer')
  switch (delivery.outcome) {
    case 'sent':
      return { kind: 'promoted', via: delivery.via, degraded: false }
    case 'degraded':
      return { kind: 'promoted', via: 'followup', degraded: true }
    case 'error':
      // Recovery window: put the original object back into the next-turn
      // queue before admitting loss.
      try {
        agent.followup(view.message)
        return { kind: 'promoted', via: 'followup', degraded: true }
      } catch {
        return {
          kind: 'error',
          error: `${delivery.error} — the message left the queue but was NOT delivered; submit it again.`,
        }
      }
  }
}

/**
 * Human-readable transcript notice for one queue action result (UI text is
 * English-only per AGENTS.md). The degrade wording states the ACTUAL route
 * the message took, per design §二.2/§二.4.
 */
export function describeQueueActionResult(result: QueueActionResult): string {
  switch (result.kind) {
    case 'removed':
      return 'Removed from the pending queue.'
    case 'promoted':
      return result.degraded
        ? STEER_UNAVAILABLE_NOTICE
        : 'Promoted — steering the current turn now.'
    case 'not-found':
      return 'Already claimed or removed — list refreshed.'
    case 'error':
      return `✘ ${result.error}`
  }
}
