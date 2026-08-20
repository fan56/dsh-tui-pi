/**
 * Nerd Font detection for the icon-set self-adaptation — a
 * zero-dependency probe that tells `src/icons.ts` whether the terminal can
 * render the powerline PUA glyph U+E0B0 (and the other weak-terminal glyphs)
 * before the `auto` icon-set mode picks between 'nerdfont' and 'plain'.
 *
 * Detection is per-platform and deliberately approximate:
 *
 *   - Linux: `fc-list -q <name>` for each candidate family. fc-list exits 0
 *     when the family is installed (quiet mode prints nothing either way).
 *     When `fc-list` itself is missing (ENOENT — a fontconfig-less system),
 *     every probe fails and the probe reports "no Nerd Font".
 *   - macOS: scan `~/Library/Fonts` and `/Library/Fonts` and match file names
 *     against a Nerd/Powerline heuristic (the real Core Text registry is not
 *     reachable without Objective-C bindings — a file-name scan is the
 *     reasonable zero-dependency approximation; it also recognises the TUI's
 *     own bundled font `dsh-tui-pi-nerd.ttf`, so `node scripts/install-font.mjs`
 *     flipping the terminal to it is enough to flip `auto` → nerdfont).
 *   - Windows / anything else: false (no free probe; the conservative answer
 *     is the plain glyphs).
 *
 * The result is memoised at module level — the TUI probes once at startup and
 * hot-applied 'auto' settings changes resolve against that same snapshot. All
 * failure paths return `false`; the probe never throws.
 */

import { execFile as execFileCb } from 'node:child_process'
import { readdir as readdirCb } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)
const readdir = promisify(readdirCb)

/** Candidate font families probed with `fc-list -q` on Linux. */
export const NERD_FONT_CANDIDATES: readonly string[] = [
  'JetBrainsMono Nerd Font',
  'Hack Nerd Font',
  'MesloLGS NF',
  'Cascadia Mono PL',
  'PowerlineSymbols',
  '0xProto Nerd Font',
]

/**
 * macOS font-file-name heuristic for a Nerd/Powerline-capable font, incl. the
 * TUI's own bundled subset (`dsh-tui-pi-nerd.ttf`). `MesloLGS` mirrors the
 * Linux candidate list (MesloLGS NF ships as `MesloLGS NF Regular.ttf`).
 */
export const NERD_FONT_FILE_RE = /Nerd|Powerline|Cascadia.*PL|MesloLGS|dsh-tui-pi-nerd/i

/**
 * The environment the probe reads — injected for tests (see
 * test/font-detect.test.mjs), defaulting to the real platform/fs.
 */
export interface FontDetectEnv {
  platform: NodeJS.Platform
  /** `os.homedir()` — `~/Library/Fonts` is derived from it. */
  home: string
  /** Resolves with the directory's entry names, rejects when unreadable. */
  readdir: (dir: string) => Promise<string[]>
  /**
   * Resolves when the command exits 0, rejects on a missing/nonzero exit or
   * on timeout — a stale fontconfig / hung fc-list must not block startup.
   */
  execFile: (file: string, args: readonly string[], options?: { timeout?: number }) => Promise<unknown>
}

/** The real environment: this process's platform, home and filesystem. */
const realEnv: FontDetectEnv = {
  platform: process.platform,
  home: homedir(),
  readdir: (dir) => readdir(dir),
  execFile: (file, args, options) => execFile(file, args, options),
}

/** Probe one platform with `fc-list -q`; `false` when fc-list is absent. */
async function probeLinux(env: FontDetectEnv): Promise<boolean> {
  for (const candidate of NERD_FONT_CANDIDATES) {
    try {
      // 2s cap: a broken fontconfig / stale NFS font dir must fall through to
      // the plain glyphs instead of hanging the TUI startup.
      await env.execFile('fc-list', ['-q', candidate], { timeout: 2000 })
      return true
    } catch {
      // fc-list missing (ENOENT), timed out, or the family not installed —
      // try the next.
    }
  }
  return false
}

/** Probe macOS by scanning the two font directories for matching file names. */
async function probeDarwin(env: FontDetectEnv): Promise<boolean> {
  for (const dir of [join(env.home, 'Library', 'Fonts'), '/Library/Fonts']) {
    let names: string[]
    try {
      names = await env.readdir(dir)
    } catch {
      continue // missing/unreadable directory — try the next
    }
    for (const name of names) {
      if (NERD_FONT_FILE_RE.test(name)) return true
    }
  }
  return false
}

/**
 * The full probe against an injected environment: Linux uses fc-list, macOS
 * uses the font-directory scan, every other platform reports `false`. Never
 * throws — every platform path is wrapped or falls through to `false`.
 */
export async function probeNerdFont(env: FontDetectEnv): Promise<boolean> {
  switch (env.platform) {
    case 'linux':
      return probeLinux(env)
    case 'darwin':
      return probeDarwin(env)
    default:
      // Windows and the rest: no free probe, conservative plain answer.
      return false
  }
}

/** Module-level memo: the TUI probes once per process, never again. */
let cachedNerdFont: boolean | undefined

/**
 * Detect whether a Nerd/Powerline font is available, memoised. The first call
 * (TUI startup, src/index.ts) runs the platform probe and caches the result;
 * every later call — including a hot-applied 'auto' iconSet change — resolves
 * against the same startup snapshot. Never throws.
 */
export function detectNerdFontAvailable(env: FontDetectEnv = realEnv): Promise<boolean> {
  if (cachedNerdFont !== undefined) return Promise.resolve(cachedNerdFont)
  return probeNerdFont(env).then((value) => {
    cachedNerdFont = value
    return value
  })
}

/** Drop the memoised result — a test seam (deterministic probe tests). */
export function resetNerdFontCache(): void {
  cachedNerdFont = undefined
}
