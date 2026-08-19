/**
 * Canvas e2e fixture — a plain node script spawned by
 * theme-canvas.test.mjs. startTui news up a real ProcessTerminal bound to
 * process.stdout; capturing those writes means hijacking
 * process.stdout.write, which is safe HERE but would corrupt a *.test.mjs
 * file's own node:test reporting (under process isolation the runner pipes
 * test events over stdout).
 *
 * Flow: startTui on the dark theme → wait for a painted frame → applyTheme
 * (the opposite theme) → wait for the forced full redraw → dispose → print
 * a JSON verdict on the restored stdout.
 */

import { startTui } from '../lib/tui.js'
import { ansiBg, darkTheme, lightTheme } from '../lib/theme/index.js'

const EXIT_ALT_SCREEN = '\x1b[?1049l'

const chunks = []
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = data => {
  chunks.push(String(data))
  return true
}

async function waitFor(predicate, ms = 3000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return predicate()
}

const out = () => chunks.join('')
const verdict = { startupPainted: false, forcedRedraw: false, rowsRepainted: false, exitClean: false }

const handle = startTui({ onSubmit: () => {}, themePreference: 'dark' })
try {
  const startupBg = ansiBg(handle.theme.palette.canvas)
  const target = handle.theme.palette.dark ? lightTheme : darkTheme
  const targetBg = ansiBg(target.palette.canvas)
  verdict.startupPainted = await waitFor(() => out().includes(`${startupBg}\x1b[2K`))
  handle.applyTheme(target)
  verdict.forcedRedraw = await waitFor(() => out().includes(`${targetBg}\x1b[2J`))
  verdict.rowsRepainted = await waitFor(() => out().includes(`${targetBg}\x1b[2K`))
} finally {
  try {
    handle.dispose()
  } catch { /* best effort */ }
}

const buffer = out()
const exitAt = buffer.lastIndexOf(EXIT_ALT_SCREEN)
if (exitAt >= 0) {
  const afterExit = buffer.slice(exitAt)
  verdict.exitClean = !/\x1b\[48;2;\d+;\d+;\d+m\x1b\[2K/.test(afterExit)
}

process.stdout.write = realWrite
process.stdout.write(`${JSON.stringify(verdict)}\n`)
