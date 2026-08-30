/**
 * Clipboard helper tests — src/clipboard.ts's writeClipboard / readClipboard
 * and the per-platform command ladders. Runs against the built lib/
 * (pretest builds). Every I/O seam is injected via ClipboardImpl: no real
 * process is spawned, no real stdout is touched, no real env is read.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import {
  __resetClipboardUnavailableForTest,
  COPY_ON_SELECT_ENV,
  defaultImpl,
  readClipboard,
  readCommandsForPlatform,
  resolveCopyOnSelect,
  writeClipboard,
  writeCommandsForPlatform,
} from '../lib/clipboard.js'

// A minimal but real ExecFileFn that returns whatever the test queued.
// The body of the queue is `{ cmd, args, stdinPayload, resolve, reject }`;
// tests push entries and call the corresponding resolver. The default
// resolver default-resolves pending entries on every call (so a
// test that doesn't care about a rung can still complete); the
// explicit `resolveLatest` is for tests that need to drive a rung
// deterministically.
function makeFakeExecFile() {
  const queue = []
  const calls = [] // every (cmd, args, stdinPayload) we attempted
  const fn = (file, args, options, stdinPayload) => {
    calls.push({ cmd: file, args: [...args], stdinPayload })
    return new Promise((resolve, reject) => {
      queue.push({ cmd: file, args: [...args], stdinPayload, resolve, reject })
    })
  }
  return {
    fn,
    calls,
    /** Resolve the most recent queued call (the ladder pushes in order). */
    resolveLatest(stdout = '', err = null) {
      const entry = queue.shift()
      if (entry === undefined) throw new Error('no queued execFile call to resolve')
      if (err !== null) entry.reject(err)
      else entry.resolve({ stdout })
      return entry
    },
    /** Resolve any still-pending rungs as successful (default stdout). */
    drainPending(stdout = '') {
      while (queue.length > 0) {
        const entry = queue.shift()
        entry.resolve({ stdout })
      }
    },
  }
}

function makeFakeImpl(overrides = {}) {
  const env = overrides.env ?? {
    platform: 'linux',
    waylandDisplay: undefined,
    display: ':0',
  }
  const exec = overrides.execFile ?? makeFakeExecFile()
  const writes = []
  return {
    env,
    impl: {
      env,
      execFile: exec.fn,
      write: chunk => { writes.push(chunk) },
    },
    writes,
    exec,
  }
}

// ---------------------------------------------------- OSC52 write path --

test('writeClipboard: small payload writes OSC 52 sequence to the stdout seam (base64 of text)', async () => {
  __resetClipboardUnavailableForTest()
  // Linux + $DISPLAY only → ladder is [xclip, xsel] (serial). We resolve
  // xclip successfully so the short-circuit fires before xsel is ever
  // spawned — that proves both the serial ladder and the OSC 52 emission
  // in one go. The rung outcome for the OSC 52 path itself is irrelevant;
  // the rung exists only so the awaited promise can settle.
  const exec = makeFakeExecFile()
  const env = { platform: 'linux', waylandDisplay: '', display: ':0' }
  const writes = []
  const impl = { env, execFile: exec.fn, write: chunk => { writes.push(chunk) } }
  const promise = writeClipboard('hello', impl)
  assert.equal(exec.calls.length, 1, 'only the first rung is spawned (xclip short-circuits the ladder)')
  assert.equal(exec.calls[0].cmd, 'xclip')
  exec.resolveLatest('')
  const ok = await promise
  assert.equal(ok, true, 'OSC 52 path returns true on success')
  assert.equal(writes.length, 1, 'exactly one stdout write fired')
  const expected = `\x1b]52;c;${Buffer.from('hello', 'utf8').toString('base64')}\x07`
  assert.equal(writes[0], expected, `OSC 52 sequence matches (got ${JSON.stringify(writes[0])})`)
  assert.ok(writes[0].startsWith('\x1b]52;c;'), 'OSC 52 prefix present')
  assert.ok(writes[0].endsWith('\x07'), 'OSC 52 terminator present')
})

test('writeClipboard: >64KB payload skips the OSC 52 path but still spawns the local command', async () => {
  __resetClipboardUnavailableForTest()
  const big = 'x'.repeat(70 * 1024) // 70 KiB > 64 KiB
  const exec = makeFakeExecFile()
  const env = { platform: 'darwin', waylandDisplay: undefined, display: undefined }
  const writes = []
  const impl = {
    env,
    execFile: exec.fn,
    write: chunk => { writes.push(chunk) },
  }
  // Race the write ladder: resolve the (only) pbcopy rung.
  const promise = writeClipboard(big, impl)
  // The local ladder has exactly one rung on darwin (pbcopy).
  assert.equal(exec.calls.length, 1, 'one local rung spawned')
  assert.equal(exec.calls[0].cmd, 'pbcopy', 'darwin uses pbcopy')
  assert.equal(exec.calls[0].stdinPayload, big, 'the full text is handed off on stdin')
  exec.resolveLatest('')
  const ok = await promise
  assert.equal(ok, true, 'local command success is enough to report true')
  assert.equal(writes.length, 0, 'no OSC 52 sequence was emitted for the oversize payload')
})

test('writeClipboard: OSC 52 cap is on UTF-8 byte length, not on JS string length (CJK gate)', async () => {
  __resetClipboardUnavailableForTest()
  // 16 384 CJK characters encode to 16 384 * 3 = 49 152 bytes in UTF-8,
  // comfortably under the 64 KiB cap. The OSC 52 sequence MUST be emitted.
  // The non-ASCII test is the whole point of the byteLength check: a naive
  // `text.length <= 64 * 1024` gate would let this through as well, but
  // the next test below (49 152 chars) would have slipped past 64 KiB in
  // UTF-8 and spammed the terminal. This test pins the under-budget side
  // of the boundary; the next one pins the over-budget side.
  const cjk16k = '你'.repeat(16 * 1024) // 16 384 chars, 49 152 bytes UTF-8
  const exec = makeFakeExecFile()
  const env = { platform: 'darwin', waylandDisplay: undefined, display: undefined }
  const writes = []
  const impl = { env, execFile: exec.fn, write: chunk => { writes.push(chunk) } }
  const promise = writeClipboard(cjk16k, impl)
  exec.resolveLatest('')
  const ok = await promise
  assert.equal(ok, true)
  assert.equal(writes.length, 1, 'CJK under the byte cap still writes OSC 52')
  // The base64 of 49 152 bytes is 65 536 chars — the OSC 52 sequence is
  // \x1b]52;c;<b64>\x07, so the whole emitted chunk is 71 100 bytes.
  assert.ok(writes[0].startsWith('\x1b]52;c;'), 'OSC 52 prefix present')
  assert.equal(Buffer.byteLength(writes[0], 'utf8'), 7 /*prefix*/ + Buffer.from(cjk16k, 'utf8').toString('base64').length + 1 /*ST*/ )
})

test('writeClipboard: a CJK string whose UTF-8 byte length exceeds 64 KiB skips OSC 52 (text.length alone would have lied)', async () => {
  __resetClipboardUnavailableForTest()
  // 22 000 CJK characters encode to 22 000 * 3 = 66 000 bytes in UTF-8,
  // just over the 64 KiB cap. The JS string length is 22 000, well under
  // any naive char-based gate; the byteLength check is the one that
  // catches this. OSC 52 MUST be skipped — emitting ~88 KB of base64
  // into a terminal escape sequence is exactly the spam the cap exists
  // to prevent. The local pbcopy rung still receives the full text.
  const cjkOversize = '你'.repeat(22 * 1024) // 22 000 chars, 66 000 bytes UTF-8
  assert.ok(cjkOversize.length < 64 * 1024, 'char count under 64 KiB (would slip a naive gate)')
  assert.ok(Buffer.byteLength(cjkOversize, 'utf8') > 64 * 1024, 'byte count over 64 KiB (the real gate)')
  const exec = makeFakeExecFile()
  const env = { platform: 'darwin', waylandDisplay: undefined, display: undefined }
  const writes = []
  const impl = { env, execFile: exec.fn, write: chunk => { writes.push(chunk) } }
  const promise = writeClipboard(cjkOversize, impl)
  // Sanity: the local rung still gets the FULL payload (no truncation).
  assert.equal(exec.calls[0].stdinPayload, cjkOversize, 'pbcopy receives the entire text')
  exec.resolveLatest('')
  const ok = await promise
  assert.equal(ok, true, 'local command success is enough to report true')
  assert.equal(writes.length, 0, 'OSC 52 skipped for byte-oversize CJK payload (the bug the byteLength check fixes)')
})

test('writeClipboard: local-command failure is swallowed; OSC 52 success keeps writeClipboard returning true', async () => {
  __resetClipboardUnavailableForTest()
  // Linux + $DISPLAY → ladder is [xclip, xsel] (serial). We reject the
  // FIRST rung (xclip) with a non-ENOENT error — that ends the ladder
  // (no fallback to xsel: a non-ENOENT failure means "this run is
  // broken", not "binary missing"). The OSC 52 path still succeeds, so
  // writeClipboard returns true.
  const exec = makeFakeExecFile()
  const env = { platform: 'linux', waylandDisplay: '', display: ':0' }
  const writes = []
  const impl = {
    env,
    execFile: exec.fn,
    write: chunk => { writes.push(chunk) },
  }
  const failure = Object.assign(new Error('exit 1'), { code: null })
  const promise = writeClipboard('x', impl)
  assert.equal(exec.calls.length, 1, 'first rung spawned (xclip)')
  assert.equal(exec.calls[0].cmd, 'xclip')
  exec.resolveLatest('', failure)
  const ok = await promise
  assert.equal(ok, true, 'OSC 52 success is enough to report true')
  assert.equal(writes.length, 1, 'OSC 52 still fires')
  assert.equal(exec.calls.length, 1, 'no fallback to xsel after a non-ENOENT failure')
})

test('writeClipboard: OSC 52 success alone is enough when every local rung is missing', async () => {
  __resetClipboardUnavailableForTest()
  // Linux + $DISPLAY only: ladder is [xclip, xsel] (serial). ENOENT on
  // xclip falls through to xsel; ENOENT on xsel ends the ladder. The
  // OSC 52 path already wrote a base64 sequence, so the function still
  // returns true.
  const exec = makeFakeExecFile()
  const env = { platform: 'linux', waylandDisplay: '', display: ':0' }
  const writes = []
  const impl = {
    env,
    execFile: exec.fn,
    write: chunk => { writes.push(chunk) },
  }
  const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' })
  const promise = writeClipboard('hi', impl)
  // First rung: xclip, ENOENT.
  assert.equal(exec.calls[0].cmd, 'xclip')
  exec.resolveLatest('', enoent)
  // The catch block runs in a microtask; await a tick so the next
  // iteration of the serial loop has time to fire xsel.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(exec.calls.length, 2, 'ladder fell through to the next rung')
  assert.equal(exec.calls[1].cmd, 'xsel')
  exec.resolveLatest('', enoent)
  const ok = await promise
  assert.equal(ok, true, 'OSC 52 alone is enough on its own')
  assert.equal(writes.length, 1)
  const expected = `\x1b]52;c;${Buffer.from('hi', 'utf8').toString('base64')}\x07`
  assert.equal(writes[0], expected)
})

test('writeClipboard: linux with no wayland/display has no local rung (OSC 52 alone decides)', async () => {
  __resetClipboardUnavailableForTest()
  // Linux + empty env → writeCommandsForPlatform returns []. No local
  // spawn ever fires; the OSC 52 path decides the return value.
  const exec = makeFakeExecFile()
  const env = { platform: 'linux', waylandDisplay: '', display: '' }
  const writes = []
  const impl = { env, execFile: exec.fn, write: chunk => { writes.push(chunk) } }
  const ok = await writeClipboard('hi', impl)
  assert.equal(ok, true, 'OSC 52 alone is enough on its own')
  assert.equal(exec.calls.length, 0, 'no local rung spawned')
  assert.equal(writes.length, 1)
})

test('writeClipboard: serial ladder short-circuits on the first successful rung (no later spawn)', async () => {
  __resetClipboardUnavailableForTest()
  // Linux + $DISPLAY only: ladder is [xclip, xsel] (serial). xclip
  // succeeds — xsel must NOT be spawned, parallel-style leakage is
  // what the serial rewrite prevents.
  const exec = makeFakeExecFile()
  const env = { platform: 'linux', waylandDisplay: '', display: ':0' }
  const writes = []
  const impl = { env, execFile: exec.fn, write: chunk => { writes.push(chunk) } }
  const promise = writeClipboard('hi', impl)
  assert.equal(exec.calls.length, 1, 'only the first rung is spawned')
  assert.equal(exec.calls[0].cmd, 'xclip')
  exec.resolveLatest('')
  const ok = await promise
  assert.equal(ok, true)
  assert.equal(exec.calls.length, 1, 'short-circuit: xsel never spawned')
})

test('writeClipboard: non-ENOENT failure on the only rung ends the ladder (no fallback)', async () => {
  __resetClipboardUnavailableForTest()
  // Linux + $WAYLAND_DISPLAY: ladder is [wl-copy] only — a non-ENOENT
  // failure means "this run is broken", not "binary missing", so the
  // ladder must not try to fall back onto xclip.
  const exec = makeFakeExecFile()
  const env = { platform: 'linux', waylandDisplay: 'wayland-0', display: ':0' }
  const writes = []
  const impl = { env, execFile: exec.fn, write: chunk => { writes.push(chunk) } }
  const failure = Object.assign(new Error('exit 1'), { code: null })
  const promise = writeClipboard('hi', impl)
  exec.resolveLatest('', failure)
  const ok = await promise
  assert.equal(ok, true, 'OSC 52 success is enough on its own')
  assert.equal(exec.calls.length, 1, 'no fallback to xclip after a non-ENOENT failure')
})

// ----------------------------------------- readCommandsForPlatform ladder --

test('readCommandsForPlatform: darwin uses pbpaste (no flags)', () => {
  const ladder = readCommandsForPlatform({ platform: 'darwin', waylandDisplay: undefined, display: undefined })
  assert.equal(ladder.length, 1)
  assert.equal(ladder[0].cmd, 'pbpaste')
  assert.deepEqual([...ladder[0].args], [])
})

test('readCommandsForPlatform: win32 uses powershell Get-Clipboard', () => {
  const ladder = readCommandsForPlatform({ platform: 'win32', waylandDisplay: undefined, display: undefined })
  assert.equal(ladder.length, 1)
  assert.equal(ladder[0].cmd, 'powershell.exe')
  // Verify the args carry the right -command body.
  const commandArg = ladder[0].args.find(a => a.toLowerCase().includes('get-clipboard'))
  assert.ok(commandArg !== undefined, 'powershell -command Get-Clipboard present')
})

test('readCommandsForPlatform: linux without wayland/display is just xsel', () => {
  const ladder = readCommandsForPlatform({ platform: 'linux', waylandDisplay: '', display: '' })
  assert.equal(ladder.length, 1)
  assert.equal(ladder[0].cmd, 'xsel')
})

test('readCommandsForPlatform: linux with $WAYLAND_DISPLAY prefers wl-paste over xclip', () => {
  const ladder = readCommandsForPlatform({ platform: 'linux', waylandDisplay: 'wayland-0', display: ':0' })
  assert.equal(ladder.length, 3, 'wayland + x11 + xsel')
  assert.equal(ladder[0].cmd, 'wl-paste')
  assert.equal(ladder[1].cmd, 'xclip')
  assert.equal(ladder[2].cmd, 'xsel')
})

test('readCommandsForPlatform: linux with only $DISPLAY is xclip then xsel', () => {
  const ladder = readCommandsForPlatform({ platform: 'linux', waylandDisplay: '', display: ':0' })
  assert.equal(ladder.length, 2)
  assert.equal(ladder[0].cmd, 'xclip')
  assert.equal(ladder[1].cmd, 'xsel')
})

test('writeCommandsForPlatform: darwin uses pbcopy', () => {
  const ladder = writeCommandsForPlatform({ platform: 'darwin', waylandDisplay: undefined, display: undefined })
  assert.equal(ladder.length, 1)
  assert.equal(ladder[0].cmd, 'pbcopy')
})

test('writeCommandsForPlatform: linux wayland session uses wl-copy exclusively (no X11 rung)', () => {
  // Serial env-priority: a Wayland session wins outright — spawning
  // xclip alongside wl-copy races the CLIPBOARD selection and leaks
  // a wl-copy helper process on every Ctrl+Shift+C.
  const ladder = writeCommandsForPlatform({ platform: 'linux', waylandDisplay: 'wayland-0', display: ':0' })
  assert.equal(ladder.length, 1, 'wayland session is ONE rung, not parallel with X11')
  assert.equal(ladder[0].cmd, 'wl-copy')
})

test('writeCommandsForPlatform: linux X11-only falls back from xclip to xsel', () => {
  const ladder = writeCommandsForPlatform({ platform: 'linux', waylandDisplay: '', display: ':0' })
  assert.equal(ladder.length, 2)
  assert.equal(ladder[0].cmd, 'xclip')
  assert.deepEqual([...ladder[0].args], ['-selection', 'clipboard'])
  assert.equal(ladder[1].cmd, 'xsel')
  assert.deepEqual([...ladder[1].args], ['--clipboard', '--input'])
})

test('writeCommandsForPlatform: linux without wayland or display has no rung', () => {
  const ladder = writeCommandsForPlatform({ platform: 'linux', waylandDisplay: '', display: '' })
  assert.equal(ladder.length, 0, 'no session → no local command to spawn')
})

// -------------------------------------------- readClipboard: happy + ENOENT --

test('readClipboard: first rung success returns raw stdout and does not hit later rungs', async () => {
  __resetClipboardUnavailableForTest()
  // Clean linux: no wayland, no display → ladder is just [xsel], so we
  // know exactly one rung was awaited and the second was NOT spawned.
  // The result is the raw stdout — the ask-user caller is the one that
  // sanitizes the payload through sanitizePastedText before it lands
  // in the editor buffer (see consumeRightClickPaste / appendCustomText).
  const env = { platform: 'linux', waylandDisplay: '', display: '' }
  const exec = makeFakeExecFile()
  const impl = { env, execFile: exec.fn, write: () => {} }
  const promise = readClipboard(impl)
  assert.equal(exec.calls.length, 1, 'only the first rung is awaited')
  assert.equal(exec.calls[0].cmd, 'xsel')
  exec.resolveLatest('pasted content')
  const out = await promise
  assert.equal(out, 'pasted content', 'raw stdout is passed through unchanged (sanitize lives at the call site)')
})

test('readClipboard: ENOENT on every rung returns null and caches the platform as unavailable', async () => {
  __resetClipboardUnavailableForTest()
  const env = { platform: 'linux', waylandDisplay: '', display: '' }
  const exec = makeFakeExecFile()
  const impl = {
    env,
    execFile: exec.fn,
    write: () => {},
  }
  const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' })
  // The only rung on this ladder is xsel; ENOENT → empty ladder → cache.
  const promise = readClipboard(impl)
  assert.equal(exec.calls.length, 1)
  exec.resolveLatest('', enoent)
  const out = await promise
  assert.equal(out, null, 'every rung missing → null')
  // Second call must NOT spawn anything: the platform is cached.
  const out2 = await readClipboard(impl)
  assert.equal(out2, null)
  assert.equal(exec.calls.length, 1, 'no new spawns on the second call')
})

test('readClipboard: non-ENOENT failure (e.g. nonzero exit) returns null immediately, no cache', async () => {
  __resetClipboardUnavailableForTest()
  const env = { platform: 'linux', waylandDisplay: '', display: '' }
  const exec = makeFakeExecFile()
  const impl = {
    env,
    execFile: exec.fn,
    write: () => {},
  }
  const failure = Object.assign(new Error('exit 1'), { code: null })
  const promise = readClipboard(impl)
  exec.resolveLatest('', failure)
  const out = await promise
  assert.equal(out, null)
  // Platform should NOT be cached (non-ENOENT is "this run is broken,
  // not 'this platform has no clipboard'"): a follow-up call respawns.
  const exec2 = makeFakeExecFile()
  const impl2 = { env, execFile: exec2.fn, write: () => {} }
  const p2 = readClipboard(impl2)
  exec2.resolveLatest('ok')
  const out2 = await p2
  assert.equal(out2, 'ok', 'platform re-attempts after a non-ENOENT failure')
})

test('readClipboard: skips ENOENT rungs and tries the next one', async () => {
  __resetClipboardUnavailableForTest()
  // Linux + $DISPLAY → ladder is [xclip, xsel]. ENOENT on xclip falls
  // through to xsel.
  const env = { platform: 'linux', waylandDisplay: '', display: ':0' }
  const exec = makeFakeExecFile()
  const impl = { env, execFile: exec.fn, write: () => {} }
  const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' })
  const promise = readClipboard(impl)
  // First rung: xclip — ENOENT.
  assert.equal(exec.calls[0].cmd, 'xclip')
  exec.resolveLatest('', enoent)
  // The catch block runs in a microtask; await a tick so the next
  // iteration of the readClipboard loop has time to fire xsel.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(exec.calls.length, 2, 'ladder fell through to the next rung')
  assert.equal(exec.calls[1].cmd, 'xsel')
  exec.resolveLatest('via xsel')
  const out = await promise
  assert.equal(out, 'via xsel', 'first successful rung wins')
})

test('readClipboard: defaultImpl is a real-IO object but the test injects a fake so no real process is touched', () => {
  // Sanity: the default impl is wired to process.stdout / process.platform
  // / process.env. We must NEVER exercise it in tests — just assert its
  // shape so a refactor cannot accidentally drop the env without us
  // noticing.
  assert.equal(typeof defaultImpl.execFile, 'function')
  assert.equal(typeof defaultImpl.write, 'function')
  assert.equal(typeof defaultImpl.env.platform, 'string')
  // The platform field is one of the supported values.
  assert.ok(['darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix'].includes(defaultImpl.env.platform))
})

// ------------------------------------------------- copy-on-select env ----

test('resolveCopyOnSelect: unset env defaults to enabled (release-copies behavior)', () => {
  assert.equal(resolveCopyOnSelect({}), true, 'no variable → copy on select stays on')
  assert.equal(resolveCopyOnSelect({ [COPY_ON_SELECT_ENV]: '' }), true, 'empty value → on')
  assert.equal(resolveCopyOnSelect({ [COPY_ON_SELECT_ENV]: '   ' }), true, 'whitespace → on')
})

test('resolveCopyOnSelect: only explicit off values disable; invalid values stay on', () => {
  for (const off of ['0', 'false', 'off', '  OFF ', 'False']) {
    assert.equal(resolveCopyOnSelect({ [COPY_ON_SELECT_ENV]: off }), false, `${JSON.stringify(off)} → off`)
  }
  for (const on of ['1', 'true', 'on', 'yes', 'garbage', '-1']) {
    assert.equal(resolveCopyOnSelect({ [COPY_ON_SELECT_ENV]: on }), true, `${JSON.stringify(on)} → on (invalid must never disable)`)
  }
})

test('resolveCopyOnSelect: real process env does not leak into injected env reads', () => {
  // resolveCopyOnSelect must only read the env it is handed — a machine
  // with DSH_TUI_COPY_ON_SELECT exported must not flip an injected {} read.
  const real = process.env[COPY_ON_SELECT_ENV]
  try {
    process.env[COPY_ON_SELECT_ENV] = '0'
    assert.equal(resolveCopyOnSelect({}), true, 'injected env is authoritative')
    assert.equal(resolveCopyOnSelect(), false, 'default env read picks up the process value')
  } finally {
    if (real === undefined) delete process.env[COPY_ON_SELECT_ENV]
    else process.env[COPY_ON_SELECT_ENV] = real
  }
})
