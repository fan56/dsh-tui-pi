/**
 * Built-in provider directory for the Models category's add-provider flow —
 * pure data plus pure functions, no TTY and no services touched.
 *
 * The shape mirrors the web Models page and pi-agent's /login flow: the user
 * picks a provider from a curated built-in directory (never free-form JSON),
 * enters exactly one secret, and the flow finishes. The directory entry
 * carries everything the write needs so the TUI never asks for a field the
 * user should not have to see:
 *
 * - friendly display name (row label; the pi-ai route key stays internal),
 * - one-line auth hint (the oauth-selector `[API key]` idea),
 * - whether pi-ai ships the route (a catalog route needs only the credential;
 *   a hand-declared route must also carry `api`/`baseURL`/`models`),
 * - the credential reference, derived by convention from the route key
 *   (`deriveKeyRef` — the user never types an env-var name).
 *
 * Every entry is a catalog route today: `opencode-go` is one of them (pi-ai
 * ships its endpoint and model catalog — the user's own settings.yaml stores
 * nothing but `apiKeyEnv: OPENCODE_GO_API_KEY` for it), and the hand-declared
 * write shape is kept exercised by unit tests only. A future gateway entry
 * that pi-ai does not ship just sets `catalogRoute: false` plus its
 * `api`/`baseURL`/`models` — no TUI change needed.
 */

/** One model line of a hand-declared route's default catalog. */
export interface CatalogModel {
  /** Wire model id, as the provider would echo it back. */
  id: string
  /** Optional human name; omitted lines show the id everywhere. */
  name?: string
}

/** One entry of the built-in provider directory. */
export interface ProviderCatalogEntry {
  /** llm-pi-ai providers dict key — also the stem of the derived key ref. */
  id: string
  /** Friendly display name for rows and pickers. */
  name: string
  /** One-line hint for the picker row (auth style / route kind). */
  hint: string
  /** Whether pi-ai ships this route: a catalog route stores only the key. */
  catalogRoute: boolean
  /** Wire protocol for a hand-declared route (`catalogRoute: false` only). */
  api?: string
  /** Endpoint for a hand-declared route (`catalogRoute: false` only). */
  baseURL?: string
  /** Default models for a hand-declared route (`catalogRoute: false` only). */
  models?: readonly CatalogModel[]
}

/**
 * The built-in provider directory the Add-provider picker offers. Sorted by
 * display name; every route key names a pi-ai catalog provider that takes an
 * api key, so each entry stores nothing but the credential.
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  { id: 'anthropic', name: 'Anthropic', hint: 'API key', catalogRoute: true },
  { id: 'deepseek', name: 'DeepSeek', hint: 'API key', catalogRoute: true },
  { id: 'google', name: 'Google Gemini', hint: 'API key', catalogRoute: true },
  { id: 'groq', name: 'Groq', hint: 'API key', catalogRoute: true },
  { id: 'mistral', name: 'Mistral', hint: 'API key', catalogRoute: true },
  { id: 'openai', name: 'OpenAI', hint: 'API key', catalogRoute: true },
  { id: 'opencode-go', name: 'OpenCode Go', hint: 'API key · OpenAI-compatible gateway', catalogRoute: true },
  { id: 'openrouter', name: 'OpenRouter', hint: 'API key', catalogRoute: true },
  { id: 'together', name: 'Together AI', hint: 'API key', catalogRoute: true },
  { id: 'xai', name: 'xAI', hint: 'API key', catalogRoute: true },
]

/** One directory entry by route key, or `undefined` for an unknown route. */
export function catalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find(entry => entry.id === id)
}

/**
 * Derive the conventional credential reference for a provider route — the
 * same convention the web Models page uses: the route key uppercased with
 * every non-alphanumeric run collapsed to `_`, suffixed `_API_KEY`. The
 * user never supplies a ref; profile and credential share this one name.
 * @param provider - provider route id (e.g. `anthropic`, `opencode-go`).
 * @returns the derived reference (e.g. `ANTHROPIC_API_KEY`, `OPENCODE_GO_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * The llm-pi-ai providers.<id> value an entry writes as: a catalog route
 * stores only the derived credential reference (endpoint, protocol, and
 * models come from the installed pi-ai catalog); a hand-declared route
 * carries its `api`, `baseURL`, and default models alongside the reference.
 */
export function providerProfileFor(entry: ProviderCatalogEntry): {
  apiKeyEnv: string
  api?: string
  baseURL?: string
  models?: Array<{ id: string; name?: string }>
} {
  const ref = deriveKeyRef(entry.id)
  if (entry.catalogRoute) return { apiKeyEnv: ref }
  const models = (entry.models ?? []).map(model => (
    model.name === undefined ? { id: model.id } : { id: model.id, name: model.name }
  ))
  return {
    apiKeyEnv: ref,
    ...(entry.api !== undefined ? { api: entry.api } : {}),
    ...(entry.baseURL !== undefined ? { baseURL: entry.baseURL } : {}),
    ...(models.length > 0 ? { models } : {}),
  }
}

/** Directory entries the user has not configured yet (in directory order). */
export function unconfiguredCatalogEntries(configured: ReadonlySet<string>): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.filter(entry => !configured.has(entry.id))
}

/** One llm-pi-ai provider profile as stored in settings — the subset we read. */
export interface ProviderProfile {
  displayName?: string
  apiKeyEnv?: string
  models?: ReadonlyArray<{ id?: string }>
}

/** Display facts for one provider row of the Models category. */
export interface ProviderRowView {
  /** Route key (also the row id stem). */
  id: string
  /** Row label: profile displayName, else catalog name, else the route key. */
  label: string
  /** Row value column: first listed model, a count, or `catalog`. */
  summary: string
  /** Row description: one-line API-key state. */
  status: string
}

/**
 * Build the display facts for one provider row. Pure — the caller supplies
 * the environment lookup (`process.env`) and the (possibly undefined) profile
 * read out of the llm-pi-ai descriptor, so nothing here touches services.
 *
 * The summary rule: a profile with models shows the first model id (or a
 * count when the id is missing); a catalog route with no models serves the
 * installed catalog, so `catalog` is more honest than `0 models`; anything
 * else has no models at all. The status rule: no `apiKeyEnv` means the route
 * has no key address at all; otherwise the reference's presence in the
 * supplied environment decides `API key set` vs `API key missing`.
 */
export function providerRowView(
  id: string,
  entry: ProviderCatalogEntry | undefined,
  profile: unknown,
  env: Readonly<Record<string, string | undefined>>,
): ProviderRowView {
  const p = (typeof profile === 'object' && profile !== null ? profile : undefined) as
    | ProviderProfile
    | undefined
  const displayName = p?.displayName
  const label = displayName !== undefined && displayName !== '' ? displayName : entry?.name ?? id

  const models = p?.models
  let summary: string
  if (models !== undefined && models.length > 0) {
    const first = models[0]?.id
    const count = `${models.length} model${models.length === 1 ? '' : 's'}`
    summary = typeof first === 'string' && first !== '' ? first : count
  } else if (entry?.catalogRoute === true) {
    // No models listed — including the implicit `models: []` that schema
    // defaults put into every resolved profile: a catalog route serves the
    // installed pi-ai catalog, so `catalog` beats a misleading `0 models`.
    summary = 'catalog'
  } else {
    // Hand-declared route (or unknown route key): nothing to serve without
    // an explicit model list — `0 models` is the honest read here.
    summary = '0 models'
  }

  const ref = p?.apiKeyEnv
  // Truthy presence: an empty-string env value means the key is not usable
  // (the add flow merges 'stored', never ''). An unset/empty env var is
  // 'missing', an undefined ref is 'not configured'.
  const status = ref === undefined || ref === ''
    ? 'API key not configured'
    : env[ref]
      ? 'API key set'
      : 'API key missing'

  return { id, label, summary, status }
}
