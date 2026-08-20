/**
 * /login and /logout — the terminal counterparts of pi-agent's credential
 * management, built on the Models category's add-provider flow.
 *
 * /login opens a searchable provider directory (including already-configured
 * routes, so a re-login can overwrite a key), collects one API key through the
 * masked EditField, and commits the provider profile + credential the same way
 * the web Models page does. An optional argument names a provider directly:
 * `/login openai` jumps straight to the key editor on a unique match and opens
 * the picker filtered to the matches otherwise.
 *
 * /logout lists the providers with a stored credential (an async
 * credentials.describe probe per ref), lets the user pick one, and removes
 * only the credential — the settings.yaml provider entry stays, exactly like
 * pi's /logout removes auth but keeps the model configuration.
 *
 * The pure decision logic (`resolveLoginTarget`, `listLogoutCandidates`) is
 * unit-tested in test/login.test.mjs.
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings'
import { type OverlayHandle, type TUI } from '@earendil-works/pi-tui'
import { wrapFramedOverlay } from './frame.ts'
import { fitColumnWidth, TablePanel } from './panels.ts'
import {
  catalogEntry,
  deriveKeyRef,
  directoryProviderEntries,
  PROVIDER_CATALOG,
  providerProfileFor,
  type ProviderCatalogEntry,
} from './provider-catalog.ts'
import { AddProviderFlow, commitProvider } from './settings.ts'
import type { TuiTheme } from './theme/index.ts'

/** The llm-pi-ai settings namespace (same id the /settings browser uses). */
const LLM_PI_AI_NS = settingsNamespace('llm-pi-ai')

/**
 * Resolve a `/login <provider>` argument against the picker directory:
 * case-insensitive exact match on the route id or display name first, then a
 * case-insensitive prefix match on either. Returns the matching entries in
 * directory order — the caller reads the length: 0 = unknown, 1 = unique
 * (jump straight to the key editor), >1 = show the picker filtered to the
 * matches.
 */
export function resolveLoginTarget(
  input: string,
  entries: readonly ProviderCatalogEntry[],
): ProviderCatalogEntry[] {
  const needle = input.trim().toLowerCase()
  if (needle === '') return []
  const exact = entries.filter(
    entry => entry.id.toLowerCase() === needle || entry.name.toLowerCase() === needle,
  )
  if (exact.length > 0) return exact
  return entries.filter(
    entry => entry.id.toLowerCase().startsWith(needle) || entry.name.toLowerCase().startsWith(needle),
  )
}

/** One configured llm-pi-ai provider considered by the /logout picker. */
export interface LogoutProvider {
  /** llm-pi-ai providers dict key (also the credential ref stem). */
  id: string
  /** Derived credential reference (e.g. `ANTHROPIC_API_KEY`). */
  ref: string
  /** Profile displayName, when set. */
  displayName?: string
}

/** A logout candidate: a logged-in provider with its picker label. */
export interface LogoutCandidate {
  id: string
  ref: string
  /** Picker label: displayName, else catalog name, else the route key. */
  name: string
}

/**
 * Filter the configured llm-pi-ai providers down to the logged-in ones — a
 * provider is a logout candidate when its credential ref is configured. The
 * caller supplies the configured judgment (from async credentials.describe
 * probes); the filtering and label resolution stay pure.
 */
export function listLogoutCandidates(
  providers: readonly LogoutProvider[],
  configuredRefs: ReadonlySet<string>,
): LogoutCandidate[] {
  return providers
    .filter(provider => configuredRefs.has(provider.ref))
    .map(provider => ({
      id: provider.id,
      ref: provider.ref,
      name: provider.displayName !== undefined && provider.displayName !== ''
        ? provider.displayName
        : catalogEntry(provider.id)?.name ?? provider.id,
    }))
}

/** Outcome of the /login flow. */
export type LoginFlowResult =
  | { kind: 'unknown'; target: string }
  | { kind: 'cancelled' }
  | { kind: 'configured'; name: string }

export interface LoginFlowOptions {
  ctx: Context
  tui: TUI
  theme: TuiTheme
  /** Focus target to restore when the flow closes (usually the editor). */
  restoreFocus: () => void
  /** Error sink for writes that fail after the editor already closed. */
  onError: (message: string) => void
  /** Optional `/login <provider>` target (route id or display name). */
  target?: string
}

/** Outcome of the /logout flow. */
export type LogoutFlowResult =
  | { kind: 'none' }
  | { kind: 'cancelled' }
  | { kind: 'removed'; name: string }
  | { kind: 'failed'; name: string }

export interface LogoutFlowOptions {
  ctx: Context
  tui: TUI
  theme: TuiTheme
  /** Focus target to restore when the flow closes (usually the editor). */
  restoreFocus: () => void
  /** Error sink for a failed credential removal (transcript notice). */
  onError: (message: string) => void
}

/**
 * Structural face of the credentials seam the /logout flow needs: the async
 * configured probe and the unset. Kept local like settings.ts's CredentialSeam
 * so this module does not hard-depend on `@deepseek-ai/dsh-credentials`.
 */
interface LogoutCredentialSeam {
  describe?(ref: string): Promise<{ configured: boolean }>
  unset(ref: string): Promise<void>
}

/** Structural face of the llm service's configurable-provider directory. */
interface LlmDirectorySeam {
  listConfigurableProviders?: () => Array<{ provider: string; settingsNs?: string; declared?: boolean }>
}

/** Live llm-pi-ai configurable-provider directory entries, or `undefined`. */
function llmPiAiDirectory(ctx: Context): ReadonlyArray<{ provider: string; declared?: boolean }> | undefined {
  const llm = ctx.get('llm') as LlmDirectorySeam | undefined
  if (llm?.listConfigurableProviders === undefined) return undefined
  try {
    return llm.listConfigurableProviders()
      .filter(entry => entry.settingsNs === LLM_PI_AI_NS)
      .map(entry => (
        entry.declared !== undefined
          ? { provider: entry.provider, declared: entry.declared }
          : { provider: entry.provider }
      ))
  } catch {
    return undefined
  }
}

/**
 * Every picker entry for /login: all configurable routes, including
 * already-configured ones (a re-login overwrites the key), but never
 * hand-declared routes — a re-login must not overwrite a hand-declared
 * api/baseURL/models profile with the catalog's.
 */
function loginDirectoryEntries(ctx: Context): readonly ProviderCatalogEntry[] {
  const directory = llmPiAiDirectory(ctx)
  return directory !== undefined && directory.length > 0
    ? directoryProviderEntries(directory, new Set())
    : PROVIDER_CATALOG
}

/** Serialized llm-pi-ai profile write for /login (revision read at execution time). */
async function writeProviderProfile(settings: SettingsProvider, entry: ProviderCatalogEntry): Promise<string | undefined> {
  try {
    await settings.mutate(
      LLM_PI_AI_NS,
      [{ op: 'set', path: ['providers', entry.id], value: providerProfileFor(entry) }],
      settings.describe().find(desc => desc.ns === LLM_PI_AI_NS)?.revision,
    )
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return undefined
}

/**
 * Open the provider login flow. Resolves when the flow closes: `configured`
 * names the provider whose key was stored (a `notice` outcome — committed
 * profile without a credentials service — counts as configured too),
 * `cancelled` when the user escaped without committing, and `unknown` when a
 * `/login <provider>` argument matched no route. Focus returns to
 * `restoreFocus` on close.
 */
export async function openLoginFlow(options: LoginFlowOptions): Promise<LoginFlowResult> {
  const settings = options.ctx.get('settings')
  if (settings === undefined) throw new Error('settings service is not available')

  const entries = loginDirectoryEntries(options.ctx)
  const target = options.target?.trim() ?? ''
  let pickerEntries = entries
  let initialEntry: ProviderCatalogEntry | undefined
  if (target !== '') {
    const matches = resolveLoginTarget(target, entries)
    if (matches.length === 1) {
      initialEntry = matches[0]!
    } else if (matches.length > 1) {
      pickerEntries = matches
    } else {
      return { kind: 'unknown', target }
    }
  }

  let committedName: string | undefined
  let overlay: OverlayHandle | undefined
  return new Promise<LoginFlowResult>(resolve => {
    const flow = new AddProviderFlow(options.tui, options.theme, {
      entries: pickerEntries,
      ...(initialEntry !== undefined ? { initialEntry } : {}),
      onCommit: (entry, key) => commitProvider(
        options.ctx,
        () => writeProviderProfile(settings, entry),
        entry,
        key,
      ).then(result => {
        // A full success (undefined), and the no-credentials-service `notice`
        // alike, mean the provider is configured now.
        if (result === undefined || result.notice !== undefined) committedName = entry.name
        return result
      }),
      onExit: () => {
        overlay?.hide()
        options.restoreFocus()
        resolve(committedName === undefined ? { kind: 'cancelled' } : { kind: 'configured', name: committedName })
      },
      onError: options.onError,
    })
    overlay = options.tui.showOverlay(wrapFramedOverlay(options.theme, flow), { width: '80%', maxHeight: '80%' })
  })
}

/**
 * Open the provider logout flow: list the providers with a stored credential,
 * remove only the key on selection (the settings.yaml provider entry stays).
 * Resolves `removed` with the provider label after the unset lands, `failed`
 * when the unset rejects, `none` when nothing is logged in, and `cancelled`
 * when the user escapes. Focus returns to `restoreFocus` on close.
 */
export async function openLogoutFlow(options: LogoutFlowOptions): Promise<LogoutFlowResult> {
  const settings = options.ctx.get('settings')
  if (settings === undefined) throw new Error('settings service is not available')
  const credentials = options.ctx.get('credentials') as LogoutCredentialSeam | undefined

  const piDesc = settings.describe().find(desc => desc.ns === LLM_PI_AI_NS)
  const providers = (piDesc?.value ?? {}) as { providers?: Record<string, unknown> }
  const candidates = Object.entries(providers.providers ?? {}).map(([id, profile]) => {
    const displayName = typeof profile === 'object' && profile !== null
      ? (profile as { displayName?: unknown }).displayName
      : undefined
    return {
      id,
      ref: deriveKeyRef(id),
      displayName: typeof displayName === 'string' && displayName !== '' ? displayName : undefined,
    }
  })

  // No credential store in this process → there is nothing to unset.
  if (credentials?.describe === undefined) return { kind: 'none' }
  const probes = await Promise.all(candidates.map(async provider => {
    try {
      const info = await credentials.describe!(provider.ref)
      return info.configured === true
    } catch {
      // A failing probe must not break the list — the provider reads as
      // logged out, same as the Models status column.
      return false
    }
  }))
  const configuredRefs = new Set(candidates.filter((_, index) => probes[index]).map(provider => provider.ref))
  const loggedIn = listLogoutCandidates(candidates, configuredRefs)
  if (loggedIn.length === 0) return { kind: 'none' }

  return new Promise(resolve => {
    const list = new TablePanel(options.theme, {
      title: '● Log out',
      columns: [
        { key: 'label', title: 'Provider', flex: true },
        { key: 'description', title: 'Key ref', width: fitColumnWidth('Key ref', loggedIn.map(candidate => candidate.ref), 28) },
      ],
      rows: loggedIn,
      renderCell: (candidate, column) => (column.key === 'description' ? candidate.ref : candidate.name),
      onSelect: candidate => finish(candidate),
      onCancel: () => finish(undefined),
    })
    // Framed overlay: 13 list rows + 4 frame rows fit inside 75% of 24 rows.
    const overlay = options.tui.showOverlay(wrapFramedOverlay(options.theme, list), { width: '80%', maxHeight: '75%' })
    function finish(candidate: LogoutCandidate | undefined): void {
      overlay.hide()
      options.restoreFocus()
      if (candidate === undefined) {
        resolve({ kind: 'cancelled' })
        return
      }
      void credentials!.unset(candidate.ref).then(
        () => resolve({ kind: 'removed', name: candidate.name }),
        (cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause)
          options.onError(`Failed to remove stored key for ${candidate.name}: ${message}`)
          resolve({ kind: 'failed', name: candidate.name })
        },
      )
    }
  })
}
