/**
 * Clipboard helper for the ask-user "Type something." sentinel editor.
 *
 * The editor only ever needs to push free-text into the system clipboard
 * (Ctrl+Shift+C) and read it back (right-click → paste). Terminal-side
 * paste is already handled by the bracketed-paste path in `handleCustomInput`
 * (see ask-user.ts); this module is the bridge to a real OS clipboard.
 *
 * Strategy:
 * - `writeClipboard` writes the OSC 52 "set primary clipboard" sequence so a
 *   host terminal that follows the convention picks the text up without
 *   touching the OS. The sequence is capped at 64 KiB to keep the terminal
 *   from being spammed with a multi-MB escape run for a pathological paste;
 *   a >64 KiB OSC 52 is skipped and the local command alone is relied on.
 *   In parallel, the best-matching local command for the platform is tried
 *   (`pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip`). Whichever path lands
 *   first resolves `true`; the local failure is swallowed (the OSC 52 path
 *   may still succeed, the next call may not, we never want a thrown error
 *   to interrupt the user's keystroke).
 * - `readClipboard` is a fall-back ladder. WAYLAND-aware first
 *   (`wl-paste` when `WAYLAND_DISPLAY` is set), then the X11 ladder
 *   (`xclip` → `xsel`), then macOS `pbpaste`, then Windows PowerShell.
 *   The same command is not retried within a single process: when a binary
 *   is missing (`ENOENT`) the platform is cached as "unavailable" and the
 *   read is short-circuited to `null` for the remainder of the run.
 *
 * Every command runs through `execFile` (no shell, parameter-array argv,
 * bounded timeout, large-enough buffer). The text path itself is raw —
 * the ask-user side (which is the only in-tree caller) sanitizes the
 * payload through `sanitizePastedText` before it lands in the editor
 * buffer. Splitting the sanitize to the call site means a future caller
 * of `readClipboard` (e.g. a feature that streams the clipboard into
 * the chat composer) gets a faithful copy of what the OS gave us, and
 * the editor gets its one sanitization pass.
 *
 * Everything is injectable through `ClipboardImpl` so the module is fully
 * unit-testable without spawning real clipboard processes.
 */

import { execFile as execFileCb } from 'node:child_process'
import { Buffer } from 'node:buffer'

/** Max UTF-8 byte length we accept into the OSC 52 write sequence. */
const OSC52_MAX_BYTES = 65536

/**
 * execFile envelope. The result is `{ stdout }` on success; for write
 * commands the caller passes a non-null `stdinPayload` that is piped in
 * before the process exits. A `null` payload skips the stdin pipe (read
 * commands).
 */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
  stdinPayload: string | null,
) => Promise<{ stdout: string }>

/**
 * Subset of the platform the resolver reads. Pulled out so tests can fake
 * darwin/linux/win32 without touching `process.platform` / `process.env`.
 */
export interface ClipboardEnv {
  platform: NodeJS.Platform
  waylandDisplay: string | undefined
  display: string | undefined
}

/** All I/O the helper needs: command execution + stdout writing. */
export interface ClipboardImpl {
  execFile: ExecFileFn
  write: (chunk: string) => void
  env: ClipboardEnv
}

/**
 * Default `execFile` wrapper built on the real `node:child_process`. The
 * callback form gives us stdin for write commands (pbcopy / wl-copy / xclip
 * / xsel / clip all consume the text on stdin); a `null` payload skips the
 * stdin pipe entirely (read commands) and returns the collected stdout.
 */
function makeDefaultExecFile(): ExecFileFn {
  return (file, args, options, stdinPayload) => new Promise<{ stdout: string }>((resolve, reject) => {
    const child = execFileCb(file, [...args], options, (error, stdout) => {
      if (error === null) resolve({ stdout })
      else reject(error)
    })
    if (stdinPayload !== null) {
      // A child that exists but exits before draining stdin (e.g. xclip
      // printing "Can't open display" on Linux without an X server) raises
      // an uncaught EPIPE on the stream; swallow it here so the helper
      // keeps its best-effort "never throw" contract.
      child.stdin?.on('error', () => { /* swallowed: stream-layer errors never escape */ })
      child.stdin?.end(stdinPayload)
    }
  })
}

/** Default impl: real process, real env. */
export const defaultImpl: ClipboardImpl = {
  execFile: makeDefaultExecFile(),
  write: chunk => { process.stdout.write(chunk) },
  env: {
    platform: process.platform,
    waylandDisplay: process.env.WAYLAND_DISPLAY,
    display: process.env.DISPLAY,
  },
}

/**
 * Cache of platforms whose read-binary ladder is fully missing: we still
 * retry the write path every call (a copy without a way to read it back is
 * still useful), but a read that would just re-spawn a missing ENOENT
 * short-circuits to `null` so the right-click path stays snappy.
 */
const readUnavailable = new Set<NodeJS.Platform>()

/**
 * Pick the write ladder for a platform. The ladder is tried SERIALLY in
 * order — the helper short-circuits on the first rung that exits cleanly
 * and treats a missing binary (`ENOENT`) as "try the next rung". This
 * mirrors the read-side ladder and avoids two problems the old parallel
 * shape had on a real Wayland + XWayland desktop:
 *   1. `wl-copy` (Wayland) and `xclip` (X11) write the same `CLIPBOARD`
 *      selection through different protocols; spawning them concurrently
 *      races the two ends and the loser's payload can win.
 *   2. `wl-copy` forks a background helper that lingers after the
 *      `execFile` resolves; running it in parallel with every other
 *      rung accumulated helpers with each Ctrl+Shift+C.
 */
export function writeCommandsForPlatform(env: ClipboardEnv): readonly { cmd: string; args: readonly string[] }[] {
  if (env.platform === 'darwin') {
    return [{ cmd: 'pbcopy', args: [] }]
  }
  if (env.platform === 'win32') {
    return [{ cmd: 'clip', args: [] }]
  }
  // Linux and friends: ONE rung per session, picked from the env. WAYLAND
  // wins over X11 outright (a Wayland session that also exposes $DISPLAY
  // for XWayland apps still has its native clipboard on `wl-copy`; the
  // X11 rung would be the XWayland clipboard, a different selection).
  // X11 falls back from xclip to xsel when xclip is not installed.
  if (env.waylandDisplay !== undefined && env.waylandDisplay !== '') {
    return [{ cmd: 'wl-copy', args: [] }]
  }
  if (env.display !== undefined && env.display !== '') {
    return [
      { cmd: 'xclip', args: ['-selection', 'clipboard'] },
      { cmd: 'xsel', args: ['--clipboard', '--input'] },
    ]
  }
  return []
}

/** Read-ladder resolver: returns the commands to try in order. */
export function readCommandsForPlatform(env: ClipboardEnv): readonly { cmd: string; args: readonly string[] }[] {
  if (env.platform === 'darwin') {
    return [{ cmd: 'pbpaste', args: [] }]
  }
  if (env.platform === 'win32') {
    return [{ cmd: 'powershell.exe', args: ['-NoProfile', '-command', 'Get-Clipboard'] }]
  }
  const ladder: { cmd: string; args: readonly string[] }[] = []
  if (env.waylandDisplay !== undefined && env.waylandDisplay !== '') {
    ladder.push({ cmd: 'wl-paste', args: ['--no-newline'] })
  }
  if (env.display !== undefined && env.display !== '') {
    ladder.push({ cmd: 'xclip', args: ['-o', '-selection', 'clipboard'] })
  }
  ladder.push({ cmd: 'xsel', args: ['--clipboard', '--output'] })
  return ladder
}

/**
 * Copy `text` to the system clipboard.
 *
 * Returns `true` when either the OSC 52 path succeeded AND we wrote a small
 * enough buffer, OR any local command exited cleanly. Returns `false`
 * when every path failed. Errors are swallowed; the helper must never
 * throw from a key handler.
 */
export async function writeClipboard(text: string, impl: ClipboardImpl = defaultImpl): Promise<boolean> {
  let osc52Ok = false
  // Cap is on UTF-8 byte length, not on the JS string length (which is
  // a UTF-16 code-unit count): 65 536 CJK characters are ~192 KiB in
  // UTF-8, and the terminal would still be spammed with a multi-MB
  // escape run even though `text.length` looked in-budget. The base64
  // step then doubles that again, so `Buffer.byteLength` is the right
  // pre-encode gate.
  if (Buffer.byteLength(text, 'utf8') <= OSC52_MAX_BYTES) {
    const payload = Buffer.from(text, 'utf8').toString('base64')
    try {
      impl.write(`\x1b]52;c;${payload}\x07`)
      osc52Ok = true
    } catch { /* terminal may have closed — give up on this path */ }
  }
  const ladder = writeCommandsForPlatform(impl.env)
  const localOk = await runWriteLadder(ladder, text, impl)
  return osc52Ok || localOk
}

/**
 * Read the system clipboard and return its text. The payload is the raw
 * stdout of whichever rung landed first — the ask-user side sanitizes
 * it through `sanitizePastedText` before the editor buffer sees it, so
 * a future caller of this helper gets a faithful copy of what the OS
 * gave us. Returns `null` when no read path succeeds or the platform
 * has been cached as "unavailable" (no command found on the ladder).
 */
export async function readClipboard(impl: ClipboardImpl = defaultImpl): Promise<string | null> {
  if (readUnavailable.has(impl.env.platform)) return null
  const ladder = readCommandsForPlatform(impl.env)
  for (const { cmd, args } of ladder) {
    try {
      const { stdout } = await impl.execFile(cmd, args, {
        timeout: 5000,
        maxBuffer: 1 << 20,
        windowsHide: true,
      }, null)
      return stdout
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code
      if (code === 'ENOENT') {
        // Binary missing on this ladder rung; try the next.
        continue
      }
      // Any other failure (nonzero exit, timeout, signal) — give up.
      return null
    }
  }
  // The whole ladder was missing — cache the platform and bail.
  readUnavailable.add(impl.env.platform)
  return null
}

/**
 * Run the write ladder SERIALLY against the same text payload. Resolve
 * `true` as soon as one rung exits cleanly; treat a missing binary
 * (`ENOENT`) as "try the next rung" and any other failure as
 * terminal. The serial order keeps Wayland and X11 from racing on the
 * same `CLIPBOARD` selection, and avoids the wl-copy helper-process
 * leak that parallel `Promise.all` caused.
 */
async function runWriteLadder(
  ladder: readonly { cmd: string; args: readonly string[] }[],
  text: string,
  impl: ClipboardImpl,
): Promise<boolean> {
  for (const { cmd, args } of ladder) {
    try {
      await impl.execFile(cmd, args, {
        timeout: 5000,
        maxBuffer: 1 << 20,
        windowsHide: true,
      }, text)
      return true
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code
      if (code === 'ENOENT') continue // binary missing on this rung; try the next.
      return false
    }
  }
  return false
}

/**
 * Test seam: drop the cached "platform has no read command" state. Tests
 * inject a different `ClipboardImpl` per case, so the cache can be left
 * full from a previous run; the seam keeps the test order independent.
 */
export function __resetClipboardUnavailableForTest(): void {
  readUnavailable.clear()
}
