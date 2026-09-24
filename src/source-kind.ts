/**
 * dsh-tui-pi's producer declaration for the user-role messages it injects on
 * its own behalf — the btw side-question, the maxRounds wrap-up, and the
 * Ctrl+G steer.
 *
 * dsh 0.1.7 removed the shared `plugin` MessageSource kind: MessageSourceMap
 * is a merge-extensible sum type where each producer declares its own `kind`
 * in its own module (there is no catch-all anymore; see dsh-llm's
 * message.d.ts — "user messages carry any producer's kind, and consumers
 * fall through unknown kinds"). This module is that declaration for this
 * plugin. Consumers recognize our injections structurally through
 * `isTuiPluginInjection` (dsh-events.ts), which ALSO accepts the pre-0.1.7
 * `{ kind: 'plugin', plugin: 'dsh-tui-pi' }` shape still present in
 * persisted V3-era session logs replayed on resume.
 */

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-tui-pi': TuiPiMessageSource
  }
}

/** The producer source of one dsh-tui-pi-injected user message. */
export interface TuiPiMessageSource {
  kind: 'dsh-tui-pi'
  /** Which tui-pi surface produced the injection. */
  surface: 'btw' | 'steer' | 'wrapup'
}
