/**
 * Pure decision table for the "install companion latest" onboarding step.
 *
 * No I/O, no process.env, no clock: every input is passed in, so the whole
 * table is unit-testable (same shape as src/host-version.ts's pure functions).
 * The caller (bin/onboard-core.mjs) owns the registry query, the profile
 * reads and the actual install; this module only answers one question:
 * given a declared range, a resolved latest version and the currently
 * mounted pin, what exact spec (if any) should be handed to `dsh plugin add`?
 */

export const REASONS = Object.freeze({
  LATEST: 'latest',
  DISABLED: 'disabled',
  UNRESOLVED: 'unresolved',
  CROSS_MAJOR: 'cross_major',
  DOWNGRADE: 'downgrade',
  IDEMPOTENT: 'idempotent',
})

// Companions are 0.x packages: major is the only hard boundary, a 0.x minor
// jump (0.9 → 0.10, 0.20 → 0.21) is exactly the case this feature must allow.
// We only need the numeric core for the guard; prerelease suffixes are kept
// verbatim in the spec but ignored for comparisons.
// npm dist-tags are usually bare (`0.14.9`) but occasionally carry a leading
// `v` (`v0.14.9`). The version recorded in an installed manifest never has the
// `v`, so normalise before building the spec — otherwise the post-install
// self-check compares `0.14.9` against `v0.14.9` and fails spuriously.
// Prerelease suffixes (`0.3.0-rc.1`) are part of the version and kept verbatim.
export function normalizeVersion(version) {
  return String(version).trim().replace(/^v/, '')
}

function parseCore(version) {
  if (typeof version !== 'string') return null
  // Declared ranges carry an operator prefix (^0.14.0, ~0.9.0, >=1.2.3);
  // resolved pins are bare (0.14.5, possibly v-prefixed). Only the numeric
  // core is needed for the major guard.
  const match = /^[v^~><=\s]*(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function compareCore(a, b) {
  const pa = parseCore(a)
  const pb = parseCore(b)
  if (!pa || !pb) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key]
  }
  return 0
}

/**
 * Decide one companion's install action.
 *
 * Inputs:
 *   packageName   — e.g. '@aiwayds/dsh-dcp' (used to build the exact spec)
 *   declaredRange — the caret range from package.json.dependencies
 *   resolved      — dist-tags.latest from the registry, or null on failure
 *   currentPin    — version mounted in the profile, or null on a fresh install
 *   enabled       — the bin-layer kill switch (DSH_TUI_COMPANION_LATEST)
 *
 * Output:
 *   { action, spec, reason }
 *   action 'latest'   → spec is 'pkg@<resolved>'; pass it to plugin add
 *   action 'fallback' → spec is null; install the declared range (today's path)
 *   action 'skip'     → spec is null; no-op (already pinned / never downgrade)
 *
 * Decision order matters: the kill switch wins first, then an unusable
 * resolution, then the cross-major guard, then the current-pin comparison.
 */
export function decideCompanionInstall({
  packageName,
  declaredRange,
  resolved,
  currentPin = null,
  enabled = true,
} = {}) {
  const fallback = (reason) => ({ action: 'fallback', spec: null, reason })
  const skip = (reason) => ({ action: 'skip', spec: null, reason })
  const latest = () => ({ action: 'latest', spec: `${packageName}@${normalizeVersion(resolved)}`, reason: REASONS.LATEST })

  if (!enabled) return fallback(REASONS.DISABLED)

  const resolvedCore = parseCore(resolved)
  const declaredCore = parseCore(declaredRange)
  // Without a trustworthy resolved version or a declared range to guard
  // against, fall back — never send a half-checked spec to plugin add.
  if (!resolvedCore || !declaredCore) return fallback(REASONS.UNRESOLVED)

  if (resolvedCore.major !== declaredCore.major) return fallback(REASONS.CROSS_MAJOR)

  if (currentPin) {
    const cmp = compareCore(resolved, currentPin)
    if (cmp === null) return fallback(REASONS.UNRESOLVED)
    if (cmp < 0) return skip(REASONS.DOWNGRADE)
    if (cmp === 0) return skip(REASONS.IDEMPOTENT)
  }

  return latest()
}
