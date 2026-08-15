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
import {
  ALL_TOOL_RESULT_LINES,
  STREAMING_TAIL_LINES,
  TranscriptRenderer,
  panelBoxWidth,
} from '../lib/messages.js'
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

/** A render width that fits one full boxed panel row from the current env. */
function panelRenderWidth() {
  return panelBoxWidth(process.stdout.columns) + 2
}

function makeRenderer(panelHeight) {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, darkTheme, () => {}, panelHeight)
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

test('setTheme rebuilds tool cards and thinking panels against the new theme', () => {
  const { doc, renderer } = makeRenderer()
  renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'read', arguments: '{"file_path":"a.txt"}' }, ts: 0, seq: 2 })
  renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: 'thinking line' } }, ts: 0, seq: 3 })

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

  // New content after the switch applies normally (todo/write now renders in
  // the fixed live widget, not the transcript — a prompt echo stands in).
  renderer.renderPromptEcho('fresh')
  const out = renderDocStyled(doc)
  assert.ok(renderDoc(doc).includes('fresh'), 'fresh content renders')
  assert.ok(!renderDoc(doc).includes('old session'), 'cleared content never returns')
})

test('thinking panel keeps its fixed displayed-5-row box shape after a switch', () => {
  const { doc, renderer } = makeRenderer()
  renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: 'one\ntwo\nthree' } }, ts: 0, seq: 3 })
  const width = panelRenderWidth()
  const panel = () => doc.children.find(child => child.constructor.name === 'Container')
  assert.equal(panel().render(width).length, 7, 'top border + header + 4 content rows (displayed 5) + bottom border')

  renderer.setTheme(lightTheme)
  const after = panel().render(width)
  assert.equal(after.length, 7, 'panel keeps its 7-row box after the switch')
  assert.ok(after.join('\n').includes(ansiBg(githubLight.thinkingPanelBg)), 'body rows carry the light purple panel bg')
})

test('thinking panel renders the full box border shape', () => {
  const { doc, renderer } = makeRenderer()
  renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: 'one\ntwo\nthree' } }, ts: 0, seq: 3 })
  const width = panelRenderWidth()
  const plain = doc.children.find(child => child.constructor.name === 'Container').render(width).map(stripAnsi)
  assert.equal(plain.length, 7)
  // Text renders with paddingX = 1, so the box is inset by one column.
  assert.match(plain[0], /^\s*┌─+┐\s*$/, 'top border spans the box width')
  assert.match(plain[6], /^\s*└─+┘\s*$/, 'bottom border spans the box width')
  assert.ok(plain[1].trim().startsWith('│ 💭 thinking'), 'header row carries the left border')
  assert.ok(plain[1].trimEnd().endsWith('│'), 'header row carries the right border')
  for (const row of plain.slice(2, 6)) {
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
  assert.equal(pending.length, 7, 'pending card is a full box (displayed 5 + 2 borders)')
  assert.match(pending[0], /^\s*┌─+┐\s*$/, 'top border')
  assert.match(pending[6], /^\s*└─+┘\s*$/, 'bottom border')
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
  assert.equal(settled.length, 7, 'settled card keeps the box shape (displayed 5 + 2 borders)')
  assert.match(settled[0], /^\s*┌─+┐\s*$/, 'top border survives the settle')
  assert.match(settled[6], /^\s*└─+┘\s*$/, 'bottom border survives the settle')
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

/** Every Container doc child is a panel; assert each renders exactly the displayed-5 box (7 rows). */
function assertPanelsDisplayedFiveRows(doc, width) {
  const panels = doc.children.filter(child => child.constructor.name === 'Container')
  assert.ok(panels.length > 0, 'at least one panel rendered')
  for (const panel of panels) {
    assert.equal(panel.render(width).length, 7, `panel stays 7 rows (displayed 5) at width ${width}`)
  }
}

test('panels stay exactly 7 rows (displayed 5) on narrow terminals (10/16/20 columns)', () => {
  for (const columns of [10, 16, 20]) {
    const { doc, renderer } = makeRenderer()
    withColumns(columns, () => {
      renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: 'x'.repeat(120) } }, ts: 0, seq: 3 })
      renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, ts: 0, seq: 2 })
      // The render width equals the real column count: the box width is
      // columns - 2, which is exactly the Text content width at render.
      assertPanelsDisplayedFiveRows(doc, columns)
      assert.ok(renderDoc(doc).includes('💭'), `thinking header keeps its icon at ${columns} columns`)
    })
  }
})

test('a 300-character tool name still settles the card at exactly 7 rows (displayed 5)', () => {
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
    assertPanelsDisplayedFiveRows(doc, 80)
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
    assertPanelsDisplayedFiveRows(doc, 80)
    assert.ok(renderDoc(doc).includes('finished'), 'result content survives')
  })
})

test('the (+N lines) marker stays on one row at 20 columns with a large drop', () => {
  const { doc, renderer } = makeRenderer()
  withColumns(20, () => {
    renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, ts: 0, seq: 2 })
    // 1002 result lines + 1 detail line → 999 dropped (4 visible); the
    // marker text (17 columns) exceeds the 12-column row budget at 20
    // columns, so it must be clipped, never wrapped.
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
    assertPanelsDisplayedFiveRows(doc, 20)
    const rows = doc.children.find(child => child.constructor.name === 'Container').render(20).map(stripAnsi)
    assert.ok(rows[2].includes('(+999'), 'marker row reports the dropped count')
  })
})

test('relayout rebuilds panels at the new width after a terminal shrink', () => {
  const { doc, renderer } = makeRenderer()
  withColumns(120, () => {
    renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: 'think line' } }, ts: 0, seq: 3 })
    renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, ts: 0, seq: 2 })
  })
  withColumns(120, () => assertPanelsDisplayedFiveRows(doc, 120))

  // The terminal narrows: relayout rebuilds every panel at the new width.
  withColumns(20, () => renderer.relayout())

  withColumns(20, () => {
    assertPanelsDisplayedFiveRows(doc, 20)
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

// ------------------------------------------------------------ panel height --

test('setPanelHeight + relayout rebuild every panel at the new height', () => {
  const { doc, renderer } = makeRenderer()
  renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: 'one\ntwo\nthree\nfour' } }, ts: 0, seq: 3 })
  renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, ts: 0, seq: 2 })
  const width = panelRenderWidth()
  const panels = () => doc.children.filter(child => child.constructor.name === 'Container')
  assert.ok(panels().every(p => p.render(width).length === 7), 'default displayed 5 → 7-row box before the change')

  assert.equal(renderer.setPanelHeight('7'), true, 'height change reported')
  renderer.relayout()
  assert.ok(panels().every(p => p.render(width).length === 9), 'panels rebuilt at displayed 7 → 9-row box (6 content rows)')

  assert.equal(renderer.setPanelHeight('10'), true, 'height change reported')
  renderer.relayout()
  assert.ok(panels().every(p => p.render(width).length === 12), 'panels rebuilt at displayed 10 → 12-row box (9 content rows)')
  // The taller thinking panel shows more of the tail: four reasoning lines
  // fit entirely, in order, no truncation marker.
  const thinkRows = panels()[0].render(width).map(stripAnsi)
  assert.ok(thinkRows[2].includes('one'), 'first reasoning line visible at 10 rows')
  assert.ok(thinkRows[5].includes('four'), 'last reasoning line visible at 10 rows')

  assert.equal(renderer.setPanelHeight('10'), false, 'unchanged height is a no-op')
  const before = panels()[0].render(width).join('\n')
  assert.equal(renderer.setPanelHeight('7'), true, 'change detected without a relayout')
  assert.equal(panels()[0].render(width).join('\n'), before, 'without relayout the panels keep the old height')
  renderer.relayout()
  assert.equal(panels()[0].render(width).length, 9, 'relayout applies the stored height')
})

test("'all' panel height prints the full body and closes the box", () => {
  const { doc, renderer } = makeRenderer()
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
  renderer.applyEvent({ type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: lines.join('\n') } }, ts: 0, seq: 3 })
  renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, ts: 0, seq: 2 })
  const width = panelRenderWidth()
  assert.equal(renderer.setPanelHeight('all'), true)
  renderer.relayout()
  const panels = doc.children.filter(child => child.constructor.name === 'Container')
  // Thinking panel: 30 body lines + top border + header + bottom border.
  const thinkRows = panels[0].render(width).map(stripAnsi)
  assert.equal(thinkRows.length, 33, 'all 30 reasoning lines rendered — nothing dropped')
  assert.ok(thinkRows[2].includes('line 1'), 'first reasoning line kept')
  assert.ok(thinkRows[31].includes('line 30'), 'last reasoning line kept')
  assert.match(thinkRows[32], /└─+┘/, 'bottom border closes the box')
  // Tool card (pending): single detail line, no padding added in 'all'.
  const toolRows = panels[1].render(width).map(stripAnsi)
  assert.equal(toolRows.length, 4, '1 detail line + chrome, no pad rows in all mode')
  assert.match(toolRows[3], /└─+┘/, 'tool box stays closed')
})

test("'all' mode shows no marker under the 2000-line tool-result cap", () => {
  const { doc, renderer } = makeRenderer('all')
  const lines = Array.from({ length: 25 }, (_, i) => `result ${i + 1}`)
  renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, ts: 0, seq: 2 })
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
  const width = panelRenderWidth()
  const rows = doc.children.find(child => child.constructor.name === 'Container').render(width).map(stripAnsi)
  assert.equal(rows.length, 29, '1 detail + 25 result rows + chrome — nothing dropped under the cap')
  assert.ok(rows[2].includes('$ ls'), 'detail row kept')
  assert.ok(rows[3].includes('result 1'), 'first result line kept')
  assert.ok(rows[27].includes('result 25'), 'last result line kept')
  assert.ok(!rows.join('\n').includes('… (+'), 'no truncation marker under the cap')
  assert.match(rows[28], /└─+┘/, 'bottom border closes the box')
})

test("'all' mode caps tool results at 2000 lines with the drop marker", () => {
  const { doc, renderer } = makeRenderer('all')
  const width = panelRenderWidth()
  renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, ts: 0, seq: 2 })
  // 2100 result lines + 1 detail line → 101 dropped beyond ALL_TOOL_RESULT_LINES:
  // the newest rows stay, the head is replaced by the marker, the box stays closed.
  const lines = Array.from({ length: 2100 }, (_, i) => `result ${i + 1}`)
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
  const rows = doc.children.find(child => child.constructor.name === 'Container').render(width).map(stripAnsi)
  assert.equal(rows.length, ALL_TOOL_RESULT_LINES + 3, `${ALL_TOOL_RESULT_LINES} body rows + chrome — capped in all mode`)
  assert.ok(rows[2].includes('(+101 lines)'), 'marker reports the dropped count (2100 results + 1 detail − 2000)')
  assert.ok(rows[3].includes('result 102'), 'newest result rows stay on screen')
  assert.ok(rows[ALL_TOOL_RESULT_LINES + 1].includes('result 2100'), 'last result row inside the box')
  assert.ok(!/result 100(?!\d)/.test(rows.join('\n')),
    'head dropped beyond the cap (detail + results 1..100 cut, marker in result 101\'s slot)')
  assert.match(rows[ALL_TOOL_RESULT_LINES + 2], /└─+┘/, 'bottom border closes the box')
})

test("'all' streaming boxes only a bounded live tail; finalize renders the full body", () => {
  const { doc, renderer } = makeRenderer('all')
  const width = panelRenderWidth()
  // 500 reasoning lines streamed in chunks: while the stream is in flight the
  // panel must box only the bounded live tail (STREAMING_TAIL_LINES), so the
  // per-chunk cost never grows with the accumulated text.
  const lines = Array.from({ length: 500 }, (_, i) => `think ${i + 1}`)
  for (let start = 0; start < lines.length; start += 25) {
    renderer.applyEvent({
      type: 'assistant/chunk',
      data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: lines.slice(start, start + 25).join('\n') + '\n' } },
      ts: 0,
      seq: start / 25 + 3,
    })
  }
  const streamingRows = doc.children.find(child => child.constructor.name === 'Container').render(width).map(stripAnsi)
  assert.equal(streamingRows.length, STREAMING_TAIL_LINES + 3,
    'top border + header + bounded tail body + bottom border while streaming')
  assert.ok(!streamingRows.join('\n').includes('think 1'), 'head of the reasoning is not boxed while streaming')
  assert.ok(streamingRows[2].includes('think 301'), 'bounded tail starts at the newest 200 lines')
  assert.ok(streamingRows[STREAMING_TAIL_LINES + 1].includes('think 500'), 'newest reasoning line is on screen')
  assert.match(streamingRows[STREAMING_TAIL_LINES + 2], /└─+┘/, 'bottom border closes the streaming box')

  // Finalize: the assembled assistant/message renders the FULL reasoning body
  // (the streaming panel is replaced, nothing is lost).
  renderer.applyEvent({
    type: 'assistant/message',
    data: {
      turn: 0,
      step: 0,
      message: { content: [{ type: 'reasoning', text: lines.join('\n') }] },
    },
    ts: 0,
    seq: 30,
  })
  const finalRows = doc.children.find(child => child.constructor.name === 'Container').render(width).map(stripAnsi)
  assert.equal(finalRows.length, 503, 'all 500 reasoning lines rendered after finalize')
  assert.ok(finalRows[2].includes('think 1'), 'head of the reasoning renders after finalize')
  assert.ok(finalRows[501].includes('think 500'), 'tail of the reasoning renders after finalize')
  assert.match(finalRows[502], /└─+┘/, 'bottom border closes the final box')
})

test('settle with a taller fixed height keeps the tail and reports the drop', () => {
  const { doc, renderer } = makeRenderer('7')
  renderer.applyEvent({ type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, ts: 0, seq: 2 })
  const lines = Array.from({ length: 10 }, (_, i) => `result ${i + 1}`)
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
  const width = panelRenderWidth()
  const rows = doc.children.find(child => child.constructor.name === 'Container').render(width).map(stripAnsi)
  assert.equal(rows.length, 9, 'displayed-7 panel keeps its shape after the settle (border + header + 6 content + border)')
  assert.ok(rows[2].includes('(+5'), 'marker reports 11 lines − 6 visible = 5 dropped')
  assert.ok(rows[3].includes('result 6'), 'newest result rows stay on screen')
  assert.ok(rows[7].includes('result 10'), 'last result row inside the box')
  assert.match(rows[8], /└─+┘/, 'bottom border closes the box')
})
