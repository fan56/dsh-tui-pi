/**
 * Thin wrapper around `npm view <pkg> dist-tags.latest --json`. Kept separate
 * from the policy module so the policy stays pure and the subprocess can be
 * replaced by a fake `npm` shim in tests.
 *
 * Contract:
 *   - query the `latest` DIST-TAG (not "newest published version"): when a
 *     maintainer moves the tag these two diverge, and `latest` is the defined
 *     source of truth;
 *   - inherit the exact cwd/env the install uses, so a profile-level .npmrc
 *     (private registry / auth) is seen by both the query and the install;
 *   - fail SOFT: any timeout, spawn error, non-zero exit or unparsable output
 *     returns null and the caller installs the declared range (never throws,
 *     never blocks onboard).
 */

import { execFileSync } from 'node:child_process'

// npm dist-tags are usually bare but occasionally carry a leading `v`. Accept
// both here; the caller normalises the value before building the install spec.
const VERSION_RE = /^v?\d+\.\d+\.\d+/
const QUERY_TIMEOUT_MS = 15_000

export function queryDistTagLatest(packageName, { cwd, env = process.env, timeout = QUERY_TIMEOUT_MS } = {}) {
  if (!packageName) return null
  try {
    const out = execFileSync('npm', ['view', packageName, 'dist-tags.latest', '--json'], {
      encoding: 'utf8',
      timeout,
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (!out) return null

    // Real npm --json prints a quoted string ("0.21.0"); tolerate a bare
    // value too, but reject objects (e.g. a dist-tags map) — that is a
    // different query shape and must not be mistaken for a single version.
    let value = out
    try {
      value = JSON.parse(out)
    } catch {
      /* bare version, keep as-is */
    }
    if (typeof value !== 'string') return null
    const version = value.trim()
    return VERSION_RE.test(version) ? version : null
  } catch {
    return null
  }
}
