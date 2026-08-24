/**
 * Custom provider login — the /login flow's hand-declared-route entry
 * ("Custom provider…"): the terminal counterpart of the web Models page's
 * add-custom-provider form for enterprise/third-party gateways pi-ai does
 * not ship.
 *
 * The entry composes the same hand-declared llm-pi-ai profile shape the
 * upstream package documents (`providers.<id>` with `apiKeyEnv`, `api`,
 * `baseURL`, `models`, `displayName`) — see the llm-pi-ai README's
 * `acme-gateway` example — and commits through the SAME `commitProvider`
 * chain as a catalog login (profile write + credentials.set). After the
 * write the llm service re-registers the route in place, so the provider's
 * models appear in /model without a restart.
 *
 * UI: a chained sequence of `EditField` windows (one field per step, the
 * Add-provider key-editor pattern) inside the SAME framed overlay the
 * /login picker already owns — step N's commit advances to step N+1, Esc
 * abandons the whole flow, and the final step (the masked API key) commits
 * for real. Pure parse/validate/build helpers live at the top so the field
 * contracts stay unit-testable without a TTY.
 */

import type { Component, TUI } from '@earendil-works/pi-tui'
import { EditField, type CommitResult } from './settings.ts'
import type { ProviderCatalogEntry } from './provider-catalog.ts'
import type { TuiTheme } from './theme/index.ts'

/** Route id of the synthetic "Custom provider…" picker entry. */
export const CUSTOM_PROVIDER_ID = 'custom'

/**
 * The wire protocols a hand-declared route may name (llm-pi-ai's
 * `supportedProtocols`, most-reached first — the first is the form default).
 */
export const SUPPORTED_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

/** The synthetic directory entry the /login picker prepends. */
export function customProviderEntry(): ProviderCatalogEntry {
  return {
    id: CUSTOM_PROVIDER_ID,
    name: 'Custom provider…',
    hint: 'base URL + API key + models — any OpenAI/Anthropic-compatible gateway',
    catalogRoute: false,
  }
}

// ------------------------------------------------------ pure field parsers --

/** Parse outcome shared by every field (EditField's `parse` contract). */
export type FieldOutcome =
  | { kind: 'value'; value: string }
  | { kind: 'error'; error: string }

/**
 * Route id validation: a settings path segment (`providers.<id>`), so it
 * must be a lowercase slug — letters, digits, dashes; 2–40 chars; no dots
 * (a dot would nest the yaml path), no uppercase, and it must not collide
 * with an existing catalog/configured route (a colliding hand-declared
 * profile would shadow the pi-ai catalog route of the same name).
 */
export function parseCustomProviderId(text: string, takenIds: ReadonlySet<string>): FieldOutcome {
  const id = text.trim().toLowerCase()
  if (id === '') return { kind: 'error', error: 'Provider id must not be empty' }
  if (id.length < 2 || id.length > 40) return { kind: 'error', error: 'Provider id must be 2–40 characters' }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return { kind: 'error', error: 'Use lowercase letters, digits and dashes only (no dots, no spaces)' }
  }
  if (takenIds.has(id)) return { kind: 'error', error: `"${id}" already exists — pick another route id` }
  return { kind: 'value', value: id }
}

/** Display name validation: optional, one line, capped. */
export function parseCustomDisplayName(text: string): FieldOutcome {
  const name = text.trim().replace(/\s+/g, ' ')
  if (name === '') return { kind: 'value', value: '' }
  if (name.length > 40) return { kind: 'error', error: 'Display name must be at most 40 characters' }
  return { kind: 'value', value: name }
}

/**
 * Protocol validation: empty falls back to the default (the most-reached
 * protocol, first of `supportedProtocols`); anything else must name one of
 * the supported ids (case-insensitive).
 */
export function parseCustomProtocol(text: string): FieldOutcome {
  const value = text.trim().toLowerCase()
  if (value === '') return { kind: 'value', value: SUPPORTED_PROTOCOLS[0] }
  const match = SUPPORTED_PROTOCOLS.find(protocol => protocol === value)
  if (match === undefined) {
    return { kind: 'error', error: `Protocol must be one of: ${SUPPORTED_PROTOCOLS.join(', ')}` }
  }
  return { kind: 'value', value: match }
}

/** Base URL validation: an http(s) URL without spaces or a fragment. */
export function parseCustomBaseUrl(text: string): FieldOutcome {
  const url = text.trim()
  if (url === '') return { kind: 'error', error: 'Base URL must not be empty' }
  if (!/^https?:\/\/\S+$/.test(url)) {
    return { kind: 'error', error: 'Base URL must start with http:// or https:// and contain no spaces' }
  }
  return { kind: 'value', value: url }
}

/**
 * Model list validation: comma- or whitespace-separated ids, de-duplicated
 * in entry order, at least one, each 1–80 chars. The ids are wire model ids
 * exactly as the gateway echoes them back.
 */
export function parseCustomModels(text: string): FieldOutcome {
  const ids = [...new Set(text.split(/[\s,]+/).map(id => id.trim()).filter(id => id !== ''))]
  if (ids.length === 0) return { kind: 'error', error: 'List at least one model id (comma-separated)' }
  if (ids.some(id => id.length > 80)) return { kind: 'error', error: 'Each model id must be at most 80 characters' }
  if (ids.length > 50) return { kind: 'error', error: 'At most 50 models in the initial list' }
  return { kind: 'value', value: ids.join(',') }
}

/** The collected form state the final entry is built from. */
export interface CustomProviderDraft {
  id: string
  /** Empty string = no display name (the route id shows instead). */
  displayName: string
  api: string
  baseURL: string
  /** Comma-joined model ids (parsed form of the models field). */
  models: string
}

/** Build the hand-declared catalog entry the commit chain consumes. */
export function buildCustomEntry(draft: CustomProviderDraft): ProviderCatalogEntry {
  return {
    id: draft.id,
    name: draft.displayName !== '' ? draft.displayName : draft.id,
    hint: 'hand-declared route',
    catalogRoute: false,
    api: draft.api,
    baseURL: draft.baseURL,
    models: draft.models.split(',').map(id => ({ id })),
    ...(draft.displayName !== '' ? { displayName: draft.displayName } : {}),
  }
}

// ------------------------------------------------------------- the flow --

/** Options for the chained custom-provider form. */
export interface CustomProviderFlowOptions {
  tui: TUI
  theme: TuiTheme
  /** Route ids the custom id must not collide with (catalog + configured). */
  takenIds: ReadonlySet<string>
  /**
   * Commit the built entry + API key — the SAME chain the /login key editor
   * uses (profile write through the caller's serialized settings mutate,
   * then `commitProvider`'s credentials.set).
   */
  onCommit: (entry: ProviderCatalogEntry, key: string) => Promise<CommitResult | undefined>
  /** Pop the whole flow (Esc anywhere, or right after a successful commit). */
  onExit: () => void
  /** Error sink for writes that fail after the form already closed. */
  onError: (message: string) => void
}

interface StepSpec {
  /** Field label shown in the editor title. */
  label: string
  /** One-line guidance under the title. */
  subtitle: string
  /** Prefill (already-committed value when re-entering a step). */
  initial: string
  secret?: boolean
  /** Validate the typed text; intermediate steps just normalize + accept. */
  parse: (text: string) => FieldOutcome
}

/**
 * The chained form: one EditField at a time, advanced on each step's
 * successful commit. The final step (the masked API key) runs the real
 * `onCommit`; a failed commit keeps the editor open with the inline ✘ (Enter
 * retries). Esc at any step abandons the whole flow — same contract as the
 * add-provider key editor. Rendered inside the /login flow's framed overlay
 * (the caller hosts this component).
 */
export class CustomProviderFlow implements Component {
  private readonly tui: TUI
  private readonly theme: TuiTheme
  private readonly options: CustomProviderFlowOptions
  private readonly draft: CustomProviderDraft
  private step = 0
  private editor: EditField

  constructor(options: CustomProviderFlowOptions) {
    this.tui = options.tui
    this.theme = options.theme
    this.options = options
    this.draft = { id: '', displayName: '', api: '', baseURL: '', models: '' }
    this.editor = this.buildEditor()
  }

  /** The step specs, in form order; index 5 (the key) commits for real. */
  private specs(): StepSpec[] {
    return [
      {
        label: 'Provider id',
        subtitle: 'route key for settings.yaml — also derives the credential ref (e.g. acme-gateway → ACME_GATEWAY_API_KEY)',
        initial: this.draft.id,
        parse: text => parseCustomProviderId(text, this.options.takenIds),
      },
      {
        label: 'Display name (optional)',
        subtitle: 'shown in /model and Models — empty uses the route id',
        initial: this.draft.displayName,
        parse: parseCustomDisplayName,
      },
      {
        label: 'API protocol',
        subtitle: `one of ${SUPPORTED_PROTOCOLS.join(' · ')} — empty defaults to ${SUPPORTED_PROTOCOLS[0]}`,
        initial: this.draft.api,
        parse: parseCustomProtocol,
      },
      {
        label: 'Base URL',
        subtitle: 'the gateway endpoint, e.g. https://gateway.internal.example/v1',
        initial: this.draft.baseURL,
        parse: parseCustomBaseUrl,
      },
      {
        label: 'Models',
        subtitle: 'comma-separated wire model ids, e.g. acme-large, acme-think',
        initial: this.draft.models,
        parse: parseCustomModels,
      },
      {
        label: 'API key',
        subtitle: `stored as the derived ref — never written to settings.yaml`,
        initial: '',
        secret: true,
        parse: text => text.trim() === ''
          ? { kind: 'error', error: 'API key must not be empty' }
          : { kind: 'value', value: text.trim() },
      },
    ]
  }

  /** Build the EditField for the current step; commits advance or finalize. */
  private buildEditor(): EditField {
    const specs = this.specs()
    const spec = specs[this.step]!
    const total = specs.length
    // Set once THIS editor's onCommit ran (a plain advance or the real
    // commit): EditField's onDone fires for both a successful commit AND an
    // Esc, and only the former may advance the chain — an Esc before any
    // commit abandons the whole flow (the key-editor contract).
    let committedThisStep = false
    return new EditField(this.tui, {
      title: `Custom provider ${this.step + 1}/${total} · ${spec.label}`,
      subtitle: spec.subtitle,
      initial: spec.initial,
      ...(spec.secret === true ? { secret: true } : {}),
      parse: spec.parse,
      onCommit: async outcome => {
        if (outcome.kind !== 'value') return undefined
        const value = String(outcome.value)
        // Stash the normalized value (comma-joined models, default protocol…)
        // so re-entering the step prefills it. The final step (the API key)
        // carries no draft field — it goes straight into the commit.
        const field = (['id', 'displayName', 'api', 'baseURL', 'models'] as const)[this.step]
        if (field !== undefined) this.draft[field] = value
        committedThisStep = true
        if (this.step < total - 1) return undefined // plain advance
        return this.options.onCommit(buildCustomEntry(this.draft), value)
      },
      onDone: () => {
        // Esc (or a submit that never reached onCommit) abandons the whole
        // flow; closing during a pending final write also lands here with
        // the write already in the chain — exit either way.
        if (!committedThisStep || this.step >= specs.length - 1) {
          this.options.onExit()
          return
        }
        this.step += 1
        this.editor = this.buildEditor()
        this.tui.requestRender()
      },
      onError: message => this.options.onError(message),
    }, this.theme)
  }

  invalidate(): void {
    this.editor.invalidate()
  }

  render(width: number): string[] {
    return this.editor.render(width)
  }

  handleInput(data: string): void {
    this.editor.handleInput(data)
  }
}
