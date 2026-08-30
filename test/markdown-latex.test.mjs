/**
 * LaTeX → Unicode math rendering in transcript markdown.
 *
 * pi-tui's Markdown component (since 0.84.0) renders `$...$` inline and
 * `$$...$$` display LaTeX as terminal-friendly Unicode via renderLatex().
 * Assistant messages already render through that component
 * (src/messages.ts renderAssistantMessage), so the capability arrives with
 * the 0.84.4 dependency bump — these tests pin the behavior against OUR
 * theme bundle and OUR call shape so a future theme/MarkdownTheme refactor
 * cannot silently break (or silently disable) it.
 *
 * Known upstream quirk (pi itself shares it): a literal `$$` pair in prose
 * is consumed as display-math delimiters. Documented in the README; do not
 * "fix" here — it is upstream semantics.
 * Runs against the built lib/ (pretest builds).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Markdown } from '@earendil-works/pi-tui'
import { ansiFg, resolveTheme } from '../lib/theme/index.js'
import { RESET } from '../lib/theme/index.js'

const theme = resolveTheme(process.env, 'dark')

/** The exact shape messages.ts uses for assistant text blocks. */
function renderMd(text, width = 80) {
  const md = new Markdown(text, 1, 0, theme.markdown, {
    color: t => ansiFg(theme.palette.fgDefault) + t + RESET,
  })
  return md.render(width).join('\n')
}

test('inline LaTeX renders as Unicode math through the plugin theme', () => {
  const out = renderMd('Euler: $e^{i\\pi}+1=0$ identity')
  assert.ok(out.includes('π'), `pi glyph present (got ${JSON.stringify(out)})`)
  assert.ok(!out.includes('$e^{'), 'raw source delimiters are gone')
  assert.ok(out.includes('Euler:') && out.includes('identity'), 'surrounding prose survives')
})

test('display LaTeX renders as Unicode math (integral with sub/superscripts)', () => {
  const out = renderMd('area: $$\\int_0^1 x\\,dx$$ done')
  assert.ok(out.includes('∫'), `integral glyph present (got ${JSON.stringify(out)})`)
  assert.ok(!out.includes('$$'), 'display delimiters are gone')
})

test('unpaired dollar amounts in prose are left untouched', () => {
  const out = renderMd('it costs $100 or $200 total')
  assert.ok(out.includes('$100'), 'first price intact')
  assert.ok(out.includes('$200'), 'second price intact')
})

test('dollar variables inside code spans are left untouched', () => {
  const out = renderMd('run `echo $HOME` now')
  assert.ok(out.includes('$HOME'), 'code-span dollar intact')
})

test('plain math-free prose renders unchanged', () => {
  const out = renderMd('no math here, just words.')
  assert.ok(out.includes('no math here, just words.'))
  assert.ok(!out.includes('$'))
})
