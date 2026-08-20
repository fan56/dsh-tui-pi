/**
 * Nerd Font detection tests — src/font-detect.ts. The probe is
 * environment-injected (FontDetectEnv) so every platform path is exercised
 * deterministically: Linux `fc-list -q` probing per candidate (including the
 * fc-list-missing ENOENT case), the macOS font-directory file-name scan
 * (incl. the bundled `dsh-tui-pi-nerd.ttf`), the conservative `false` for
 * every other platform, and the "no font environment" answers. Also locks the
 * module-level memoisation: detectNerdFontAvailable probes once per process
 * and resetNerdFontCache clears it.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectNerdFontAvailable,
  NERD_FONT_CANDIDATES,
  NERD_FONT_TERMINALS,
  probeNerdFont,
  resetNerdFontCache,
} from '../lib/font-detect.js'

/** A linux env whose fc-list answers per candidate ('ok' installs it). */
function linuxEnv({ installed = [] } = {}) {
  const fcList = new Map(installed.map(candidate => [candidate, true]))
  return {
    platform: 'linux',
    home: '/home/tester',
    readdir: async () => [],
    execFile: async (file, args) => {
      assert.equal(file, 'fc-list', 'probes fc-list')
      assert.equal(args[0], '-q', 'quiet flag')
      if (fcList.get(args[1])) return ''
      throw new Error(`fc-list: family not installed: ${args[1]}`)
    },
  }
}

test('linux probes fc-list per candidate and short-circuits on the first hit', async () => {
  // No candidate installed → false.
  assert.equal(await probeNerdFont(linuxEnv({ installed: [] })), false, 'no installed candidate → false')

  // The third candidate installed → true (and only it needs to match).
  const third = NERD_FONT_CANDIDATES[2]
  assert.equal(await probeNerdFont(linuxEnv({ installed: [third] })), true, 'installed candidate → true')
})

test('linux returns false when fc-list itself is missing (ENOENT)', async () => {
  const env = {
    platform: 'linux',
    home: '/home/tester',
    readdir: async () => [],
    execFile: async () => { throw Object.assign(new Error('spawn fc-list ENOENT'), { code: 'ENOENT' }) },
  }
  assert.equal(await probeNerdFont(env), false, 'fc-list missing → false')
})

test('macOS scans the font directories for a Nerd/Powerline file name', async () => {
  const base = { platform: 'darwin', home: '/Users/tester', execFile: async () => { throw new Error('no exec on darwin') } }

  // Both directories empty → false.
  assert.equal(await probeNerdFont({ ...base, readdir: async () => [] }), false, 'no matching file → false')

  // ~/Library/Fonts holds a Nerd Font → true.
  const user = { ...base, readdir: async dir => (dir.endsWith('Library/Fonts') ? ['JetBrainsMonoNerdFont-Regular.ttf'] : []) }
  assert.equal(await probeNerdFont(user), true, 'match in ~/Library/Fonts')

  // Only /Library/Fonts holds the bundled font → true.
  const system = { ...base, readdir: async dir => (dir === '/Library/Fonts' ? ['dsh-tui-pi-nerd.ttf'] : []) }
  assert.equal(await probeNerdFont(system), true, 'own bundled font name matched')

  // MesloLGS NF ships as "MesloLGS NF Regular.ttf" — must match too.
  const meslo = { ...base, readdir: async dir => (dir.endsWith('Library/Fonts') ? ['MesloLGS NF Regular.ttf'] : []) }
  assert.equal(await probeNerdFont(meslo), true, 'MesloLGS NF file name matched')

  // Plain system fonts (Menlo / SFNSMono) do not match → false.
  const none = { ...base, readdir: async () => ['Menlo.ttc', 'SFNSMono.ttf'] }
  assert.equal(await probeNerdFont(none), false, 'plain system fonts do not match')
})

test('terminal with built-in Nerd symbol fallback short-circuits to true', async () => {
  const noFont = {
    platform: 'darwin',
    home: '/Users/tester',
    readdir: async () => [],  // no Nerd fonts in system dirs
    execFile: async () => { throw new Error('no exec') },
  }

  // Every whitelisted terminal returns true even with empty font dirs.
  for (const term of NERD_FONT_TERMINALS) {
    assert.equal(await probeNerdFont({ ...noFont, termProgram: term }), true, `termProgram=${term} → true`)
  }

  // A non-whitelisted terminal falls through to the font-directory scan.
  assert.equal(await probeNerdFont({ ...noFont, termProgram: 'Apple_Terminal' }), false, 'Apple_Terminal → font scan → false')
  assert.equal(await probeNerdFont({ ...noFont, termProgram: 'iTerm2' }), false, 'iTerm2 → font scan → false')
  assert.equal(await probeNerdFont({ ...noFont, termProgram: undefined }), false, 'undefined termProgram → font scan → false')
})

test('other platforms report false (the conservative Windows answer)', async () => {
  const win = { platform: 'win32', home: 'C:\\Users\\tester', readdir: async () => [], execFile: async () => { throw new Error('no exec on win32') } }
  assert.equal(await probeNerdFont(win), false)
  const other = { platform: 'freebsd', home: '/home/tester', readdir: async () => [], execFile: async () => { throw new Error('no exec') } }
  assert.equal(await probeNerdFont(other), false)
})

test('probeNerdFont never throws on unreadable directories', async () => {
  const env = {
    platform: 'darwin',
    home: '/Users/tester',
    readdir: async () => { throw new Error('EACCES') },
    execFile: async () => { throw new Error('no exec') },
  }
  assert.equal(await probeNerdFont(env), false, 'unreadable dirs → false, not a throw')
})

test('detectNerdFontAvailable memoises and resetNerdFontCache clears', async () => {
  resetNerdFontCache()
  let readdirCalls = 0
  const env = {
    platform: 'darwin',
    home: '/Users/tester',
    readdir: async () => { readdirCalls += 1; return ['dsh-tui-pi-nerd.ttf'] },
    execFile: async () => { throw new Error('no exec') },
  }
  assert.equal(await detectNerdFontAvailable(env), true)
  assert.equal(await detectNerdFontAvailable(env), true)
  assert.equal(readdirCalls, 1, 'second call reuses the memoised snapshot')
  resetNerdFontCache()
  assert.equal(await detectNerdFontAvailable(env), true)
  assert.equal(readdirCalls, 2, 'reset forces a fresh probe')
  resetNerdFontCache()
})

test('detectNerdFontAvailable with the real env never throws', async () => {
  resetNerdFontCache()
  const value = await detectNerdFontAvailable()
  assert.equal(typeof value, 'boolean', 'real probe settles to a boolean, never throws')
  resetNerdFontCache()
})
