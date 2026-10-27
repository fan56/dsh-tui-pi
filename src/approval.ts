import type { Context } from '@deepseek-ai/cordis'
import { matchesKey, Text, type Component } from '@earendil-works/pi-tui'
import type { AskUserPanelDeps } from './ask-user.ts'
import { ansiFg, RESET } from './theme/index.ts'
import { clipToWidth, visibleWidth } from './text.ts'
import type { DialogQueue } from './dialog-queue.ts'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export interface ApprovalRequest {
  agent: { session: { id: unknown; seq?: number; eventAt?: (seq: number) => unknown } }
  toolName: string
  callId?: string
  reason?: string
  signal?: AbortSignal
}

/** Keep the exact tool arguments visible; the reason alone is not the operation. */
export function approvalDetails(request: ApprovalRequest): string {
  const lines = ['Tool: ' + request.toolName]
  if (request.reason) lines.push('Reason: ' + request.reason)
  if (request.callId) {
    lines.push('Call: ' + request.callId)
    const session = request.agent.session
    for (let seq = (session.seq ?? 0) - 1; seq >= 0; seq--) {
      const event = session.eventAt?.(seq) as { type?: string; data?: { callId?: string; arguments?: string } } | undefined
      if (event?.type === 'tool/call' && event.data?.callId === request.callId) {
        if (event.data.arguments) lines.push('Arguments: ' + event.data.arguments)
        break
      }
    }
  }
  return lines.join('\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
}

/** A one-shot decision. Enter defaults to deny; paste never implies consent. */
export function openApprovalPanel(deps: AskUserPanelDeps, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalOutcome> {
  if (signal.aborted) return Promise.resolve('cancelled')
  return new Promise(resolve => {
    let selected = 0
    let offset = 0
    let settled = false
    let unmount: (() => void) | undefined
    const details = approvalDetails(request)
    const detailText = new Text(details, 0, 0)
    let detailsWidth = -1
    let content: string[] = []
    const finish = (outcome: ApprovalOutcome): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      unmount?.()
      deps.setModalActive(false)
      deps.restoreFocus()
      resolve(outcome)
    }
    const abort = (): void => finish('cancelled')
    const panel: Component = {
      invalidate() {},
      render(width) {
        const inner = Math.max(1, width - 4)
        const theme = deps.theme()
        const border = ansiFg(theme.palette.borderDefault)
        const row = (text: string): string => {
          const clipped = clipToWidth(text, inner)
          return border + '│ ' + RESET + clipped + ' '.repeat(Math.max(0, inner - visibleWidth(clipped))) + border + ' │' + RESET
        }
        if (inner !== detailsWidth) {
          content = detailText.render(inner)
          detailsWidth = inner
        }
        const budget = Math.max(1, Math.min(10, (deps.tui.terminal.rows || 24) - 16))
        offset = Math.max(0, Math.min(offset, content.length - budget))
        return [
          border + '┌' + '─'.repeat(Math.max(0, width - 2)) + '┐' + RESET,
          row('Approval required'),
          ...content.slice(offset, offset + budget).map(row),
          row('Details ' + (offset + 1) + '–' + Math.min(offset + budget, content.length) + '/' + content.length + ' · PgUp/PgDn scroll'),
          row((selected === 0 ? '▸ ' : '  ') + '1. Deny'),
          row((selected === 1 ? '▸ ' : '  ') + '2. Allow once'),
          row('↑↓ choose · Enter confirm · Esc/Ctrl+C deny'),
          border + '└' + '─'.repeat(Math.max(0, width - 2)) + '┘' + RESET,
        ]
      },
      handleInput(data) {
        if (data.startsWith('\x1b[200~')) return
        if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { finish('rejected'); return }
        if (data === '1') { finish('rejected'); return }
        if (data === '2') { selected = 1 }
        else if (matchesKey(data, 'up') || matchesKey(data, 'down')) selected = selected === 0 ? 1 : 0
        else if (matchesKey(data, 'pageUp')) offset = Math.max(0, offset - 5)
        else if (matchesKey(data, 'pageDown')) offset += 5
        else if (matchesKey(data, 'enter')) { finish(selected === 1 ? 'allowed-once' : 'rejected'); return }
        deps.tui.requestRender()
      },
    }
    try {
      unmount = deps.mount(panel)
      deps.tui.hideOverlay()
      deps.tui.setFocus(panel)
      deps.setModalActive(true)
      signal.addEventListener('abort', abort, { once: true })
    } catch {
      finish('unavailable')
    }
  })
}

/** Claim only the active session; other answerers can serve other sessions. */
export function registerApprovalProvider(ctx: Context, deps: AskUserPanelDeps, queue: DialogQueue): () => void {
  const register = (ctx as unknown as {
    on(event: 'approval/request', listener: (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>): () => void
  }).on.bind(ctx)
  return register('approval/request', (request, next) => {
    const mine = deps.getSessionId?.()
    if (mine === undefined || String(request.agent.session.id) !== mine) return next()
    return queue.run(signal => openApprovalPanel(deps, request, signal), request.signal)
      .catch(error => error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'unavailable')
  })
}
