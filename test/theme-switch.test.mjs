/**
 * Theme hot-switch tests — TranscriptRenderer's replay buffer and setTheme
 * rebuild, plus the theme-identity guard. Pure component tests, no TTY
 * needed; expected ANSI colors are derived from the palette constants at
 * runtime so the assertions survive palette redesigns.
 * Runs against the built lib/ (pnpm build && pnpm test).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Container } from '@earendil-works/pi-tui'
import { TranscriptRenderer, panelBoxWidth } from '../lib/messages.js'
import { ansiBg, ansiFg, darkTheme, lightTheme } from '../lib/theme/index.js'
import { githubDark, githubLight } from '../lib/theme/palette.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

/** Render every doc child into one plain text blob (ANSI stripped off). */
function renderDoc(doc, width = 200) {
  return doc.children.map(child => child.render(width).join('\n')).join('\n')
}

/** Render every doc child's styled output (ANSI kept). */
function renderDocStyled(doc, width = 200) {
  return doc.children.map(child => child.render(width).join('\n')).join('\n')
}

/** A render width that fits one full boxed panel row from the current env. */
function panelRenderWidth() {
  return panelBoxWidth(process.stdout.columns) + 2
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

test('setTheme rebuilds tool cards, thinking panels and todos against the new theme', () => {
  const { doc, renderer } = makeRenderer()
  renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'read', arguments: '{"file_path":"a.txt"}' }, ts: 0, seq: 2 })
  renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: 'thinking line' } }, ts: 0, seq: 3 })
  renderer.applyEvent({ type: 'todo/write', data: { todos: [{ content: 'task one', status: 'in_progress' }] }, ts: 0, seq: 4 })

  const width = panelRenderWidth()
  const dark = renderDocStyled(doc, width)
  assert.ok(dark.includes(ansiBg(githubDark.thinkingPanelBg)), 'dark think panel surface')
  assert.ok(dark.includes(ansiBg(githubDark.toolPanelBg)), 'dark tool card surface')

  renderer.setTheme(lightTheme)

  const light = renderDocStyled(doc, width)
  assert.ok(light.includes(ansiBg(githubLight.thinkingPanelBg)), 'think panel repainted to its light purple surface')
  assert.ok(light.includes(ansiBg(githubLight.toolPanelBg)), 'tool card repainted to its light blue surface')
  assert.ok(!light.includes(ansiBg(githubDark.thinkingPanelBg)) && !light.includes(ansiBg(githubDark.toolPanelBg)),
    'no dark panel surfaces left behind')
  assert.ok(light.includes(ansiFg(githubLight.attention)), 'in-progress todo repainted to the light attention')
  assert.ok(light.includes('task one'), 'todo content survives')
  assert.ok(light.includes('thinking line'), 'think body survives')
  assert.ok(light.includes('read'), 'tool card header survives')
})

test('tool card settles with new-theme colors after a switch', () => {
  const { doc, renderer } = makeRenderer()
  renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'grep', arguments: '{"pattern":"x"}' }, ts: 0, seq: 2 })
  renderer.setTheme(lightTheme)
  renderer.applyEvent({
    type: 'tool/result',
    data: {
      turn: 0,
      step: 0,
      callId: 'c1',
      message: { content: [{ toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'two matches' }] }] },
    },
    ts: 0,
    seq: 5,
  })
  const out = renderDocStyled(doc, panelRenderWidth())
  assert.ok(out.includes(ansiFg(githubLight.success)), 'settled card uses the light success color')
  assert.ok(out.includes('two matches'), 'result detail survives')
  assert.ok(out.includes('✔ grep'), 'header flipped to the success icon')
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
  const textChildren = doc.children.filter(child => child.constructor.name === 'Text')
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

  // New content after the switch applies normally.
  renderer.applyEvent({ type: 'todo/write', data: { todos: [{ content: 'fresh', status: 'pending' }] }, ts: 0, seq: 8 })
  const out = renderDocStyled(doc)
  assert.ok(renderDoc(doc).includes('fresh'), 'fresh todo renders')
  assert.ok(out.includes(ansiFg(githubLight.fgSubtle)), 'pending todo painted with the light subtle fg')
  assert.ok(!renderDoc(doc).includes('old session'), 'cleared content never returns')
})

test('thinking panel keeps its fixed 6-row box shape after a switch', () => {
  const { doc, renderer } = makeRenderer()
  renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: 'one\ntwo\nthree' } }, ts: 0, seq: 3 })
  const width = panelRenderWidth()
  const panel = () => doc.children.find(child => child.constructor.name === 'Container')
  assert.equal(panel().render(width).length, 6, 'top border + header + 3 body rows + bottom border')

  renderer.setTheme(lightTheme)
  const after = panel().render(width)
  assert.equal(after.length, 6, 'panel keeps 6 rows after the switch')
  assert.ok(after.join('\n').includes(ansiBg(githubLight.thinkingPanelBg)), 'body rows carry the light purple panel bg')
})

test('thinking panel renders the full box border shape', () => {
  const { doc, renderer } = makeRenderer()
  renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: 'one\ntwo\nthree' } }, ts: 0, seq: 3 })
  const width = panelRenderWidth()
  const plain = doc.children.find(child => child.constructor.name === 'Container').render(width).map(stripAnsi)
  assert.equal(plain.length, 6)
  // Text renders with paddingX = 1, so the box is inset by one column.
  assert.match(plain[0], /^\s*┌─+┐\s*$/, 'top border spans the box width')
  assert.match(plain[5], /^\s*└─+┘\s*$/, 'bottom border spans the box width')
  assert.ok(plain[1].trim().startsWith('│ 💭 thinking'), 'header row carries the left border')
  assert.ok(plain[1].trimEnd().endsWith('│'), 'header row carries the right border')
  for (const row of plain.slice(2, 5)) {
    assert.ok(row.trim().startsWith('│ '), 'body row carries the left border')
    assert.ok(row.trimEnd().endsWith('│'), 'body row carries the right border')
  }
})

test('thinking italic never leaks into the box chrome', () => {
  const { doc, renderer } = makeRenderer()
  renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: 'one\ntwo\nthree' } }, ts: 0, seq: 3 })
  const width = panelRenderWidth()
  const styled = doc.children.find(child => child.constructor.name === 'Container').render(width)
  // wrapTextWithAnsi carries SGR state across lines within one Text: without
  // the targeted italic-off the row borders and the bottom border render
  // italic. Every border-bearing line must therefore reset italic after its
  // last italic-on.
  for (const line of styled) {
    if (!line.includes('│') && !line.includes('└')) continue
    const italicOn = line.lastIndexOf('\x1b[3m')
    if (italicOn === -1) continue // border-only line (top border)
    const italicOff = line.lastIndexOf('\x1b[23m')
    assert.ok(italicOff > italicOn, 'italic is reset before the box chrome renders')
  }
})

test('tool card renders the full box and keeps its shape when it settles', () => {
  const { doc, renderer } = makeRenderer()
  renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, ts: 0, seq: 2 })
  const width = panelRenderWidth()
  const panel = doc.children.find(child => child.constructor.name === 'Container')

  const pending = panel.render(width).map(stripAnsi)
  assert.equal(pending.length, 6, 'pending card is a full box')
  assert.match(pending[0], /^\s*┌─+┐\s*$/, 'top border')
  assert.match(pending[5], /^\s*└─+┘\s*$/, 'bottom border')
  assert.ok(pending[1].trim().startsWith('│ ⚙ bash'), 'pending header row')

  renderer.applyEvent({
    type: 'tool/result',
    data: {
      turn: 0,
      step: 0,
      callId: 'c1',
      message: { content: [{ toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'a.txt' }] }] },
    },
    ts: 0,
    seq: 5,
  })
  const settled = panel.render(width).map(stripAnsi)
  assert.equal(settled.length, 6, 'settled card keeps the box shape')
  assert.match(settled[0], /^\s*┌─+┐\s*$/, 'top border survives the settle')
  assert.match(settled[5], /^\s*└─+┘\s*$/, 'bottom border survives the settle')
  assert.ok(settled[1].trim().startsWith('│ ✔ bash'), 'header flipped to the success icon')
  assert.ok(settled[2].includes('  $ ls'), 'tool detail row keeps its 2-column indent')
  assert.ok(settled[3].includes('a.txt'), 'result row inside the box')
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
 * Shadow `process.stdout.columns` for the duration of `fn`: the renderer's
 * panel box size and clipPanelLine read it at apply time, so a controlled
 * width exercises the real narrow-terminal budget. Restored afterwards (the
 * property is an inherited getter here — a shadowed own property is
 * deleted).
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

/** Every Container doc child is a panel; assert each renders exactly 6 rows. */
function assertPanelsSixRows(doc, width) {
  const panels = doc.children.filter(child => child.constructor.name === 'Container')
  assert.ok(panels.length > 0, 'at least one panel rendered')
  for (const panel of panels) {
    assert.equal(panel.render(width).length, 6, `panel stays 6 rows at width ${width}`)
  }
}

test('panels stay exactly 6 rows on narrow terminals (10/16/20 columns)', () => {
  for (const columns of [10, 16, 20]) {
    const { doc, renderer } = makeRenderer()
    withColumns(columns, () => {
      renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: 'x'.repeat(120) } }, ts: 0, seq: 3 })
      renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, ts: 0, seq: 2 })
      // The render width equals the real column count: the box width is
      // columns - 2, which is exactly the Text content width at render.
      assertPanelsSixRows(doc, columns)
      assert.ok(renderDoc(doc).includes('💭'), `thinking header keeps its icon at ${columns} columns`)
    })
  }
})

test('a 300-character tool name still settles the card at exactly 6 rows', () => {
  const { doc, renderer } = makeRenderer()
  withColumns(80, () => {
    renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'x'.repeat(300), arguments: '{}' }, ts: 0, seq: 2 })
    renderer.applyEvent({
      type: 'tool/result',
      data: {
        turn: 0,
        step: 0,
        callId: 'c1',
        message: { content: [{ toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'done' }] }] },
      },
      ts: 0,
      seq: 5,
    })
    assertPanelsSixRows(doc, 80)
    const rows = doc.children.find(child => child.constructor.name === 'Container').render(80).map(stripAnsi)
    assert.ok(rows[1].trim().startsWith('│ ✔'), 'header keeps the icon and status after the settle')
  })
})

test('carriage returns in a tool result never split the fixed rows', () => {
  const { doc, renderer } = makeRenderer()
  withColumns(80, () => {
    renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"curl"}' }, ts: 0, seq: 2 })
    // Progress-bar \r updates plus a CRLF line ending: wrapTextWithAnsi would
    // split on each \r — the panel line must stay one physical row instead.
    renderer.applyEvent({
      type: 'tool/result',
      data: {
        turn: 0,
        step: 0,
        callId: 'c1',
        message: { content: [{ toolCallId: 'c1', isError: false, content: [{ type: 'text', text: '50%|----|\r60%|----|\r100%|----|\r\nfinished' }] }] },
      },
      ts: 0,
      seq: 5,
    })
    assertPanelsSixRows(doc, 80)
    assert.ok(renderDoc(doc).includes('finished'), 'result content survives')
  })
})

test('the (+N lines) marker stays on one row at 20 columns with a large drop', () => {
  const { doc, renderer } = makeRenderer()
  withColumns(20, () => {
    renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, ts: 0, seq: 2 })
    // 1002 result lines + 1 detail line → 1000 dropped; the marker text
    // (17 columns) exceeds the 12-column row budget at 20 columns, so it
    // must be clipped, never wrapped.
    const lines = Array.from({ length: 1002 }, (_, i) => `line ${i + 1}`)
    renderer.applyEvent({
      type: 'tool/result',
      data: {
        turn: 0,
        step: 0,
        callId: 'c1',
        message: { content: [{ toolCallId: 'c1', isError: false, content: [{ type: 'text', text: lines.join('\n') }] }] },
      },
      ts: 0,
      seq: 5,
    })
    assertPanelsSixRows(doc, 20)
    const rows = doc.children.find(child => child.constructor.name === 'Container').render(20).map(stripAnsi)
    assert.ok(rows[2].includes('(+1000'), 'marker row reports the dropped count')
  })
})

test('relayout rebuilds panels at the new width after a terminal shrink', () => {
  const { doc, renderer } = makeRenderer()
  withColumns(120, () => {
    renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: 'think line' } }, ts: 0, seq: 3 })
    renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, ts: 0, seq: 2 })
  })
  withColumns(120, () => assertPanelsSixRows(doc, 120))

  // The terminal narrows: relayout rebuilds every panel at the new width.
  withColumns(20, () => renderer.relayout())

  withColumns(20, () => {
    assertPanelsSixRows(doc, 20)
    assert.ok(renderDoc(doc).includes('think line'), 'thinking content survives the relayout')
    assert.ok(renderDoc(doc).includes('bash'), 'tool card survives the relayout')
  })
})

test('relayout with an empty transcript is a no-op (placeholder stays)', () => {
  const { doc, renderer } = makeRenderer()
  renderer.renderPromptEcho('hello')
  renderer.clear()
  assert.equal(doc.children.length, 0)
  renderer.relayout()
  assert.equal(doc.children.length, 0, 'nothing re-rendered into an empty transcript')
})
