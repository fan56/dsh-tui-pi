/**
 * Host floor guard: this plugin compiles against a single dsh host line and
 * crashes deeper in boot with raw TypeErrors on older hosts (the rc and alpha
 * host APIs diverged — see docs/adr/0002-target-dsh-0.1.2-alpha.3-single-target.md).
 * This module resolves the @deepseek-ai closure version the plugin actually
 * loads against, judges it against the peer floor, and hands apply() a
 * one-line verdict so an unsupported host can be met with a plain-language
 * warning and a clean exit instead of a stack trace.
 */

import { createRequire } from 'node:module'

/**
 * Same floor as the peerDependencies range in package.json — keep the two in
 * lockstep (the package.json field stays the npm-facing source of truth).
 */
export const HOST_FLOOR = '0.1.2-alpha.4'

/**
 * The @deepseek-ai package the peer range is declared against; resolving its
 * package.json through the plugin's own module URL reads the closure the
 * loader actually wired (profile symlink or the shared profile-level
 * fallback), so the version mirrors the running host line.
 */
const HOST_PROBE = '@deepseek-ai/dsh-user-questions/package.json'

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** Dotted prerelease identifiers, numeric ones parsed (`alpha.5` → ['alpha', 5]); empty for a stable release. */
  pre: Array<number | string>
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function parseVersion(v: string): ParsedVersion | undefined {
  const m = VERSION_RE.exec(v.trim())
  if (!m) return undefined
  const pre: Array<number | string> = m[4] === undefined
    ? []
    : m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre }
}

/**
 * semver precedence on the shapes dsh ships (numeric core plus dotted
 * prerelease identifiers): numeric fields compare numerically; a prerelease
 * loses to its own stable release; identifiers compare pairwise — numeric <
 * alphanumeric, same-kind compares naturally, and when the shared prefix is
 * equal the version with fewer identifiers loses.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const len = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < len; i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = typeof x === 'number'
    const yNumeric = typeof y === 'number'
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function hostSupported(version: string): boolean {
  const parsed = parseVersion(version)
  // HOST_FLOOR is a compile-time constant and always parses.
  const floor = parseVersion(HOST_FLOOR)!
  if (!parsed) return false
  return compareVersions(parsed, floor) >= 0
}

export type HostCheck =
  | { ok: true; version: string | undefined }
  | { ok: false; version: string; message: string }

/**
 * Judge the host version against HOST_FLOOR. `readVersion` is injectable for
 * tests; the default reads the closure next to this module. An unresolvable
 * or unparsable version fails OPEN — this guard's job is a human-readable
 * exit on a known-old host, not install validation; a broken closure
 * surfaces on its own moments later with its own error.
 */
export function checkHostSupport(readVersion: () => string | undefined = readHostVersion): HostCheck {
  const version = readVersion()
  if (version === undefined || !parseVersion(version)) return { ok: true, version: undefined }
  if (hostSupported(version)) return { ok: true, version }
  const message =
    `[dsh-tui-pi] requires dsh >= ${HOST_FLOOR} (the rolling @alpha line) but found ${version}. ` +
    `Upgrade with: npm install -g @deepseek-ai/dsh@alpha — exiting.`
  return { ok: false, version, message }
}

export function readHostVersion(): string | undefined {
  try {
    const req = createRequire(import.meta.url)
    const pkg = req(HOST_PROBE) as { version?: unknown }
    if (typeof pkg?.version === 'string' && parseVersion(pkg.version)) return pkg.version
    return undefined
  } catch {
    return undefined
  }
}
