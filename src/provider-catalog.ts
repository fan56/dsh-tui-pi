/**
 * Built-in provider directory for the Models category's add-provider flow —
 * pure data plus pure functions, no TTY and no services touched.
 *
 * The directory mirrors the web Models page: it lists every installed
 * llm-pi-ai catalog route that takes an API key (36 routes in pi-ai 0.82.1),
 * and the add-provider flow prefers the live `listConfigurableProviders()`
 * directory at runtime (see `directoryProviderEntries`) with this static
 * mirror as the fallback. The shape matches the web Models page and
 * pi-agent's /login flow: the user picks a provider from the directory
 * (never free-form JSON), enters exactly one secret, and the flow finishes.
 * A directory entry carries everything the write needs so the TUI never asks
 * for a field the user should not have to see:
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
  /**
   * Profile `displayName` for hand-declared routes (the web Models page's
   * custom-provider field): written into the llm-pi-ai profile so /model and
   * the Models category show it instead of the route key.
   */
  displayName?: string
}

/**
 * The built-in provider directory the Add-provider picker offers — mirrors
 * the web Models directory: every installed llm-pi-ai catalog route that
 * takes an API key (36 routes in pi-ai 0.82.1). Sorted by display name; every
 * route key names a pi-ai catalog provider, so each entry stores nothing but
 * the credential. At runtime the add flow prefers the live directory (see
 * `directoryProviderEntries`); this list is the static fallback and the
 * friendly name/hint source.
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  { id: 'amazon-bedrock', name: 'Amazon Bedrock', hint: 'AWS credentials or bearer token', catalogRoute: true },
  { id: 'ant-ling', name: 'Ant Ling', hint: 'API key', catalogRoute: true },
  { id: 'anthropic', name: 'Anthropic', hint: 'API key', catalogRoute: true },
  { id: 'azure-openai-responses', name: 'Azure OpenAI', hint: 'API key', catalogRoute: true },
  { id: 'cerebras', name: 'Cerebras', hint: 'API key', catalogRoute: true },
  { id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway', hint: 'API key', catalogRoute: true },
  { id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', hint: 'API key', catalogRoute: true },
  { id: 'deepseek', name: 'DeepSeek', hint: 'API key', catalogRoute: true },
  { id: 'fireworks', name: 'Fireworks', hint: 'API key', catalogRoute: true },
  { id: 'github-copilot', name: 'GitHub Copilot', hint: 'GitHub Copilot token', catalogRoute: true },
  { id: 'google', name: 'Google Gemini', hint: 'API key', catalogRoute: true },
  { id: 'google-vertex', name: 'Google Vertex AI', hint: 'Google Cloud credentials', catalogRoute: true },
  { id: 'groq', name: 'Groq', hint: 'API key', catalogRoute: true },
  { id: 'huggingface', name: 'Hugging Face', hint: 'Hugging Face token', catalogRoute: true },
  { id: 'kimi-coding', name: 'Kimi For Coding', hint: 'API key', catalogRoute: true },
  { id: 'minimax', name: 'MiniMax', hint: 'API key', catalogRoute: true },
  { id: 'minimax-cn', name: 'MiniMax CN', hint: 'API key', catalogRoute: true },
  { id: 'mistral', name: 'Mistral', hint: 'API key', catalogRoute: true },
  { id: 'moonshotai', name: 'Moonshot AI', hint: 'API key', catalogRoute: true },
  { id: 'moonshotai-cn', name: 'Moonshot AI CN', hint: 'API key', catalogRoute: true },
  { id: 'nvidia', name: 'NVIDIA', hint: 'API key', catalogRoute: true },
  { id: 'openai', name: 'OpenAI', hint: 'API key', catalogRoute: true },
  { id: 'opencode-go', name: 'OpenCode Go', hint: 'API key · OpenAI-compatible gateway', catalogRoute: true },
  { id: 'opencode', name: 'OpenCode Zen', hint: 'API key', catalogRoute: true },
  { id: 'openrouter', name: 'OpenRouter', hint: 'API key', catalogRoute: true },
  { id: 'qwen-token-plan', name: 'Qwen Token Plan', hint: 'API key', catalogRoute: true },
  { id: 'qwen-token-plan-cn', name: 'Qwen Token Plan CN', hint: 'API key', catalogRoute: true },
  { id: 'together', name: 'Together AI', hint: 'API key', catalogRoute: true },
  { id: 'vercel-ai-gateway', name: 'Vercel AI Gateway', hint: 'API key', catalogRoute: true },
  { id: 'xiaomi', name: 'Xiaomi', hint: 'API key', catalogRoute: true },
  { id: 'xiaomi-token-plan-ams', name: 'Xiaomi Token Plan AMS', hint: 'API key', catalogRoute: true },
  { id: 'xiaomi-token-plan-cn', name: 'Xiaomi Token Plan CN', hint: 'API key', catalogRoute: true },
  { id: 'xiaomi-token-plan-sgp', name: 'Xiaomi Token Plan SGP', hint: 'API key', catalogRoute: true },
  { id: 'zai', name: 'Z.AI', hint: 'API key', catalogRoute: true },
  { id: 'zai-coding-cn', name: 'Z.AI Coding CN', hint: 'API key', catalogRoute: true },
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
  displayName?: string
} {
  const ref = deriveKeyRef(entry.id)
  if (entry.catalogRoute) return { apiKeyEnv: ref }
  const models = (entry.models ?? []).map(model => (
    model.name === undefined ? { id: model.id } : { id: model.id, name: model.name }
  ))
  return {
    apiKeyEnv: ref,
    ...(entry.displayName !== undefined && entry.displayName !== '' ? { displayName: entry.displayName } : {}),
    ...(entry.api !== undefined ? { api: entry.api } : {}),
    ...(entry.baseURL !== undefined ? { baseURL: entry.baseURL } : {}),
    ...(models.length > 0 ? { models } : {}),
  }
}

/** Directory entries the user has not configured yet (in directory order). */
export function unconfiguredCatalogEntries(configured: ReadonlySet<string>): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.filter(entry => !configured.has(entry.id))
}

/**
 * Build the add-provider picker entries from the live configurable-provider
 * directory, in directory order — the same source the web Models page
 * renders, so the TUI stays in lockstep with pi-ai without a hardcoded
 * mirror. Static catalog entries supply the friendly name/hint when a route
 * is known; unknown routes fall back to the route key itself. Configured and
 * hand-declared routes are excluded (declared routes come from profiles, so
 * the `configured` filter already covers them; `declared` is a defensive
 * second guard). Callers fall back to `unconfiguredCatalogEntries` when the
 * live directory is unavailable.
 */
export function directoryProviderEntries(
  directory: ReadonlyArray<{ provider: string; declared?: boolean }>,
  configured: ReadonlySet<string>,
): ProviderCatalogEntry[] {
  return directory
    .filter(entry => !configured.has(entry.provider) && entry.declared !== true)
    .map(entry => catalogEntry(entry.provider) ?? {
      id: entry.provider,
      name: entry.provider,
      hint: 'API key',
      catalogRoute: true,
    })
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
