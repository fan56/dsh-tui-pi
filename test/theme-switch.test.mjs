/**
 * Theme hot-switch tests — TranscriptRenderer's replay buffer and setTheme
 * rebuild, plus the theme-identity guard. Pure component tests, no TTY
 * needed; expected ANSI colors are derived from the palette constants at
 * runtime so the assertions survive palette redesigns. (The think/tool
 * panels are fixed live widgets now — their theme/shape coverage lives in
 * live.test.mjs; the transcript here carries the conversation only.)
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Container } from '@earendil-works/pi-tui'
import { TranscriptRenderer } from '../lib/messages.js'
import { ansiBg, ansiFg, darkTheme, lightTheme } from '../lib/theme/index.js'
import { githubDark, githubLight } from '../lib/theme/palette.js'
import { WHALE_COLOR } from '../lib/welcome.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

/** Render every doc child into one plain text blob (ANSI stripped off). */
function renderDoc(doc, width = 200) {
  return doc.children.map(child => child.render(width).join('\n')).join('\n')
}

/** Render every doc child's styled output (ANSI kept). */
function renderDocStyled(doc, width = 200) {
  return doc.children.map(child => child.render(width).join('\n')).join('\n')
}

function makeRenderer() {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, darkTheme, () => {})
  return { doc, renderer }
}

test('setTheme repaints existing content with the new theme', () => {
  const { doc, renderer } = makeRenderer()
  renderer.renderPromptEcho('hello')
  renderer.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, ts: 0, seq: 1 })
  renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'text-delta', text: 'Hi there' } } })

  const dark = renderDocStyled(doc)
  assert.ok(dark.includes(ansiBg(githubDark.canvasSubtle)), 'dark bubble bg before switch')
  assert.ok(dark.includes(ansiFg(githubDark.fgDefault)), 'dark streaming fg before switch')

  renderer.setTheme(lightTheme)

  const light = renderDocStyled(doc)
  assert.ok(light.includes(ansiBg(githubLight.canvasSubtle)), 'bubble bg repainted to the light canvas')
  assert.ok(light.includes(ansiFg(githubLight.fgDefault)), 'streaming fg repainted to the light fg')
  assert.ok(!light.includes(ansiBg(githubDark.canvasSubtle)), 'no dark bubble bg left behind')
  assert.ok(renderDoc(doc).includes('hello'), 'content survives the repaint')
  assert.ok(renderDoc(doc).includes('Hi there'), 'streaming content survives the repaint')
})

test('in-flight stream continues on the rebuilt component after setTheme', () => {
  const { doc, renderer } = makeRenderer()
  renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'text-delta', text: 'Hi ' } }, ts: 0, seq: 3 })
  renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'text-delta', text: 'there' } }, ts: 0, seq: 4 })
  renderer.setTheme(lightTheme)
  // The stream continues: exactly one streaming text component, accumulated
  // text preserved, further deltas keep landing in it.
  renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'text-delta', text: '!' } }, ts: 0, seq: 5 })

  const text = renderDoc(doc)
  assert.ok(text.includes('Hi there!'), 'accumulated stream text survives the switch')
  const styled = renderDocStyled(doc)
  assert.ok(styled.includes(ansiFg(githubLight.fgDefault)), 'streaming text painted with the light fg')
  // Count only the content Texts — the welcome banner Text is identified by
  // its whale-blue pixels and the daily-quote caption by its CJK brackets
  // rather than assuming child positions.
  const textChildren = doc.children.filter(child =>
    child.constructor.name === 'Text'
    && !child.render(200).join('').includes(ansiFg(WHALE_COLOR))
    && !child.render(200).join('').includes('「')
  )
  assert.equal(textChildren.length, 1, 'one streaming text component — no duplicates after the switch')
})

test('prompt-echo dedup survives a theme switch (no duplicated bubble)', () => {
  const { doc, renderer } = makeRenderer()
  renderer.renderPromptEcho('the prompt')
  renderer.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'the prompt' }], source: { kind: 'user' } }, ts: 0, seq: 1 })
  assert.equal(renderDoc(doc).match(/▎ the prompt/g)?.length ?? 0, 1, 'one bubble before the switch')

  renderer.setTheme(lightTheme)
  assert.equal(renderDoc(doc).match(/▎ the prompt/g)?.length ?? 0, 1, 'still one bubble after the switch')

  // A later user message with new content renders normally (dedup key reset).
  renderer.applyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }, ts: 0, seq: 7 })
  assert.equal(renderDoc(doc).match(/▎ second/g)?.length ?? 0, 1, 'later message renders once')
})

test('command echoes replay with the new accent', () => {
  const { doc, renderer } = makeRenderer()
  renderer.renderCommandEcho('/model', undefined, 'Model: deepseek/deepseek-v4')
  renderer.renderCommandEcho('/think', 'something broke')
  assert.ok(renderDocStyled(doc).includes(ansiFg(githubDark.accent)), 'dark accent before switch')

  renderer.setTheme(lightTheme)
  const out = renderDocStyled(doc)
  assert.ok(out.includes(ansiFg(githubLight.accent)), 'command echo repainted to the light accent')
  assert.ok(out.includes(ansiFg(githubLight.danger)), 'error echo repainted to the light danger')
  assert.ok(renderDoc(doc).includes('/model') && renderDoc(doc).includes('something broke'), 'echo text survives')
})

test('notice lines survive a theme switch (buffered as replay ops)', () => {
  const { doc, renderer } = makeRenderer()
  renderer.renderNotice('settings write failed', 'error')
  renderer.renderNotice('⏹ canceling current turn…', 'info')
  const dark = renderDocStyled(doc)
  assert.ok(dark.includes(ansiFg(githubDark.danger)) && dark.includes('✘ settings write failed'), 'error notice painted dark danger')
  assert.ok(dark.includes(ansiFg(githubDark.attention)), 'info notice painted dark attention')

  renderer.setTheme(lightTheme)
  const light = renderDocStyled(doc)
  assert.ok(light.includes(ansiFg(githubLight.danger)) && light.includes('✘ settings write failed'), 'error notice repainted with the light danger')
  assert.ok(light.includes(ansiFg(githubLight.attention)) && light.includes('⏹ canceling current turn…'), 'info notice repainted with the light attention')
  assert.ok(!light.includes(ansiBg(githubDark.canvasSubtle)), 'no dark surface left behind')
})

test('setTheme on the same bundle is a no-op', () => {
  const { doc, renderer } = makeRenderer()
  renderer.renderPromptEcho('hi')
  const before = [...doc.children]
  renderer.setTheme(darkTheme) // identical module singleton
  assert.equal(doc.children.length, before.length)
  for (let i = 0; i < before.length; i++) {
    assert.equal(doc.children[i], before[i], 'component instances untouched')
  }
})

test('clear() drops the replay buffer — nothing resurrects on setTheme', () => {
  const { doc, renderer } = makeRenderer()
  renderer.renderPromptEcho('old session')
  renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'read', arguments: '{}' }, ts: 0, seq: 2 })
  renderer.clear()
  renderer.setTheme(lightTheme)
  assert.equal(doc.children.length, 0, 'cleared transcript stays empty across the switch')

  // New content after the switch applies normally (tool/think/todo render in
  // the fixed live widgets, not the transcript — a prompt echo stands in).
  renderer.renderPromptEcho('fresh')
  const out = renderDocStyled(doc)
  assert.ok(renderDoc(doc).includes('fresh'), 'fresh content renders')
  assert.ok(!renderDoc(doc).includes('old session'), 'cleared content never returns')
})

test('turn-end error line repaints on switch', () => {
  const { doc, renderer } = makeRenderer()
  renderer.applyEvent({ type: 'turn/end', data: { turn: 0, reason: { kind: 'error', error: { message: 'provider down' } } }, ts: 0, seq: 9 })
  assert.ok(renderDocStyled(doc).includes(ansiFg(githubDark.danger)))
  renderer.setTheme(lightTheme)
  assert.ok(renderDocStyled(doc).includes(ansiFg(githubLight.danger)))
  assert.ok(renderDoc(doc).includes('provider down'))
})

test('assistant markdown message repaints through the rebuild', () => {
  const { doc, renderer } = makeRenderer()
  renderer.applyEvent({
    type: 'assistant/message',
    data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: '# head\n\nsome **bold** text' }] } },
    ts: 0,
    seq: 10,
  })
  const before = renderDocStyled(doc)
  assert.ok(before.includes(ansiFg(githubDark.fgDefault)), 'dark markdown color before switch')
  renderer.setTheme(lightTheme)
  const after = renderDocStyled(doc)
  assert.ok(after.includes(ansiFg(githubLight.fgDefault)), 'markdown repainted to the light fg')
  assert.ok(renderDoc(doc).includes('head'), 'markdown content survives')
  assert.ok(renderDoc(doc).includes('bold'), 'markdown content survives')
})

// ------------------------------------------------------------------- resize --

/**
 * Shadow `process.stdout.columns` for the duration of `fn` (the welcome
 * banner is width-dependent, so a controlled width exercises the real
 * narrow-terminal budget). Restored afterwards.
 */
function withColumns(columns, fn) {
  const hadOwn = Object.hasOwn(process.stdout, 'columns')
  const previous = process.stdout.columns
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true })
  try {
    return fn()
  } finally {
    if (hadOwn) {
      Object.defineProperty(process.stdout, 'columns', { value: previous, configurable: true })
    } else {
      delete process.stdout.columns
    }
  }
}

test('relayout rebuilds the transcript at the new width (content survives)', () => {
  const { doc, renderer } = makeRenderer()
  withColumns(120, () => renderer.renderPromptEcho('hello'))
  assert.ok(renderDoc(doc).includes('hello'))
  // The terminal narrows: relayout re-applies the buffered operations.
  withColumns(20, () => renderer.relayout())
  assert.ok(renderDoc(doc).includes('hello'), 'content survives the relayout rebuild')
})

test('relayout with an empty transcript is a no-op (placeholder stays)', () => {
  const { doc, renderer } = makeRenderer()
  renderer.renderPromptEcho('hello')
  renderer.clear()
  assert.equal(doc.children.length, 0)
  renderer.relayout()
  assert.equal(doc.children.length, 0, 'nothing re-rendered into an empty transcript')
})
