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

import { t } from './i18n/index.ts'

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
 *
 * `hint` carries an i18n KEY (module data must not freeze a language at
 * import time); render sites resolve it with `t(entry.hint)` — see
 * `directoryProviderEntries` for the resolving-clone pattern. `name` stays a
 * literal: provider names are proper nouns.
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  { id: 'amazon-bedrock', name: 'Amazon Bedrock', hint: 'provcatalog.hint.aws', catalogRoute: true },
  { id: 'ant-ling', name: 'Ant Ling', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'anthropic', name: 'Anthropic', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'azure-openai-responses', name: 'Azure OpenAI', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'cerebras', name: 'Cerebras', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'deepseek', name: 'DeepSeek', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'fireworks', name: 'Fireworks', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'github-copilot', name: 'GitHub Copilot', hint: 'provcatalog.hint.copilot', catalogRoute: true },
  { id: 'google', name: 'Google Gemini', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'google-vertex', name: 'Google Vertex AI', hint: 'provcatalog.hint.googleCloud', catalogRoute: true },
  { id: 'groq', name: 'Groq', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'huggingface', name: 'Hugging Face', hint: 'provcatalog.hint.huggingface', catalogRoute: true },
  { id: 'kimi-coding', name: 'Kimi For Coding', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'minimax', name: 'MiniMax', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'minimax-cn', name: 'MiniMax CN', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'mistral', name: 'Mistral', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'moonshotai', name: 'Moonshot AI', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'moonshotai-cn', name: 'Moonshot AI CN', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'nvidia', name: 'NVIDIA', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'openai', name: 'OpenAI', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'opencode-go', name: 'OpenCode Go', hint: 'provcatalog.hint.apiKey.gateway', catalogRoute: true },
  { id: 'opencode', name: 'OpenCode Zen', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'openrouter', name: 'OpenRouter', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'qwen-token-plan', name: 'Qwen Token Plan', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'qwen-token-plan-cn', name: 'Qwen Token Plan CN', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'together', name: 'Together AI', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'vercel-ai-gateway', name: 'Vercel AI Gateway', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'xiaomi', name: 'Xiaomi', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'xiaomi-token-plan-ams', name: 'Xiaomi Token Plan AMS', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'xiaomi-token-plan-cn', name: 'Xiaomi Token Plan CN', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'xiaomi-token-plan-sgp', name: 'Xiaomi Token Plan SGP', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'zai', name: 'Z.AI', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'zai-coding-cn', name: 'Z.AI Coding CN', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
  { id: 'xai', name: 'xAI', hint: 'provcatalog.hint.apiKey', catalogRoute: true },
]

/** One directory entry by route key, or `undefined` for an unknown route. */
export function catalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find(entry => entry.id === id)
}

/**
 * Resolve one entry's hint to display text. The static catalog's hint fields
 * carry i18n KEYS (module data must not freeze a language at import time);
 * this switch enumerates them as literal t() call sites — which is also what
 * the i18n coverage guard matches against. Anything else (an already-resolved
 * hint from a runtime-built entry) passes through `t()` unchanged, since a
 * non-key falls back to itself.
 */
export function resolveCatalogHint(hint: string): string {
  switch (hint) {
    case 'provcatalog.hint.apiKey': return t('provcatalog.hint.apiKey')
    case 'provcatalog.hint.aws': return t('provcatalog.hint.aws')
    case 'provcatalog.hint.copilot': return t('provcatalog.hint.copilot')
    case 'provcatalog.hint.googleCloud': return t('provcatalog.hint.googleCloud')
    case 'provcatalog.hint.huggingface': return t('provcatalog.hint.huggingface')
    case 'provcatalog.hint.apiKey.gateway': return t('provcatalog.hint.apiKey.gateway')
    default: return t(hint)
  }
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
    .map(entry => {
      // Known route: clone the static entry with the hint RESOLVED (the
      // static table carries hint keys; picker rows display text). Unknown
      // route: the route key names itself and the generic key hint.
      const known = catalogEntry(entry.provider)
      return known !== undefined
        ? { ...known, hint: resolveCatalogHint(known.hint) }
        : {
            id: entry.provider,
            name: entry.provider,
            hint: t('provcatalog.hint.apiKey'),
            catalogRoute: true,
          }
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
    const count = models.length === 1
      ? t('provcatalog.summary.model', { count: models.length })
      : t('provcatalog.summary.models', { count: models.length })
    summary = typeof first === 'string' && first !== '' ? first : count
  } else if (entry?.catalogRoute === true) {
    // No models listed — including the implicit `models: []` that schema
    // defaults put into every resolved profile: a catalog route serves the
    // installed pi-ai catalog, so `catalog` beats a misleading `0 models`.
    summary = t('provcatalog.summary.catalog')
  } else {
    // Hand-declared route (or unknown route key): nothing to serve without
    // an explicit model list — `0 models` is the honest read here.
    summary = t('provcatalog.summary.none')
  }

  const ref = p?.apiKeyEnv
  // Truthy presence: an empty-string env value means the key is not usable
  // (the add flow merges 'stored', never ''). An unset/empty env var is
  // 'missing', an undefined ref is 'not configured'.
  const status = ref === undefined || ref === ''
    ? t('provcatalog.status.notConfigured')
    : env[ref]
      ? t('provcatalog.status.set')
      : t('provcatalog.status.missing')

  return { id, label, summary, status }
}
