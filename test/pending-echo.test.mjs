/**
 * Pending-badge prompt echoes (src/messages.ts → lib/messages.js): a prompt
 * routed while the agent runs echoes locally with a display-only badge
 * (`⏳ queued` / `↪ steer`), and the claim `user/message` event restyles that
 * SAME bubble back to the ordinary style in place — no new line, and the
 * buffered replay op loses its badge so theme rebuilds reflect the consumed
 * state (docs/design-steer-followup.md §三). The badge never enters any
 * persisted text. Runs against the built lib/ (pretest builds).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Container } from '@earendil-works/pi-tui'
import { TranscriptRenderer } from '../lib/messages.js'
import { ansiFg, darkTheme, lightTheme } from '../lib/theme/index.js'

const stripAnsi = line => line.replace(/\x1b\[[0-9;]*m/g, '')

/** Rendered plain text of every doc child (the banner carries none of the
 *  badge vocabulary asserted here, so post-/new empty docs work too). */
function transcriptText(doc) {
  return stripAnsi(doc.children.map(child => child.render(200).join('\n')).join('\n'))
}

function claimEvent(text, seq) {
  return {
    type: 'user/message',
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
    ts: 0,
    seq,
  }
}

test('a pending echo renders its badge on the first line of the bubble', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPendingEcho('fix the tests', 'queued')
  const text = transcriptText(doc)
  assert.ok(text.includes('▎ ⏳ queued · fix the tests'), `badge prefixes the bubble: ${text}`)
})

test('the steer badge reads ↪ steer', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPendingEcho('change course', 'steer')
  assert.ok(transcriptText(doc).includes('↪ steer · change course'))
})

test('the claim event restyles the SAME bubble in place — nothing appended', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPendingEcho('fix the tests', 'queued')
  const childrenBefore = doc.children.length
  renderer.applyEvent(claimEvent('fix the tests', 1))
  assert.equal(doc.children.length, childrenBefore, 'claim adds no new bubble')
  const text = transcriptText(doc)
  assert.ok(text.includes('▎ fix the tests'), 'bubble content stays')
  assert.ok(!text.includes('queued'), 'badge is gone once claimed')
})

test('a SECOND identical claim renders an ordinary new bubble (duplicate texts)', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPendingEcho('again', 'queued')
  renderer.applyEvent(claimEvent('again', 1))
  const childrenAfterFirstClaim = doc.children.length
  renderer.applyEvent(claimEvent('again', 2))
  assert.ok(doc.children.length > childrenAfterFirstClaim, 'second claim gets its own bubble')
  const text = transcriptText(doc)
  // Exactly one badge ever existed and it was consumed by the first claim.
  assert.equal((text.match(/⏳/g) ?? []).length, 0)
  assert.ok(text.includes('▎ again'))
})

test('theme rebuild mid-pending keeps the badge; after the claim it is gone everywhere', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPendingEcho('still pending', 'queued')
  renderer.setTheme(darkTheme)
  assert.ok(transcriptText(doc).includes('⏳ queued · still pending'), 'rebuild reproduces the pending state')

  renderer.applyEvent(claimEvent('still pending', 1))
  renderer.setTheme(lightTheme)
  const rebuilt = transcriptText(doc)
  assert.ok(rebuilt.includes('▎ still pending'))
  assert.ok(!rebuilt.includes('queued'), 'replay ops lost their badges on consume')
})

test('/new clear() drops pending registration — a later claim renders normally', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPendingEcho('ghost', 'queued')
  renderer.clear()
  renderer.applyEvent(claimEvent('ghost', 1))
  const text = transcriptText(doc)
  assert.ok(text.includes('▎ ghost'))
  assert.ok(!text.includes('queued'), 'no phantom badge consumption across /new')
})

test('trimmed-key matching: the claim matches even when the echo carried surrounding spaces', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  // The dialog path echoes the raw submitted line; the session trims.
  renderer.renderPendingEcho('  padded prompt ', 'steer')
  renderer.applyEvent(claimEvent('padded prompt', 1))
  const text = transcriptText(doc)
  assert.ok(text.includes('padded prompt'))
  assert.ok(!text.includes('steer'), 'badge consumed via the trimmed key')
})

test('legacy idle path unchanged: local echo + matching session event still dedupe silently', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPromptEcho('plain prompt')
  const before = doc.children.length
  renderer.applyEvent(claimEvent('plain prompt', 1))
  assert.equal(doc.children.length, before, 'session echo suppressed as before')
})

// ------------------------------------------------- B1: badge terminal states --

test('B1: resolvePendingEcho(canceled) restyles the SAME bubble in place — no ghost badge', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPendingEcho('revoke me', 'queued', 'm-10')
  const before = doc.children.length
  assert.equal(renderer.resolvePendingEcho({ id: 'm-10' }, 'canceled'), true)
  assert.equal(doc.children.length, before, 'terminal state restyles in place, nothing appended')
  const text = transcriptText(doc)
  assert.ok(text.includes('✕ canceled · revoke me'), 'explicit canceled label replaces the badge')
  assert.ok(!text.includes('queued'), 'no ⏳ ghost remains')
})

test('B1: resolvePendingEcho(failed) marks the bubble as not delivered', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPendingEcho('doomed prompt', 'steer', 'm-11')
  renderer.resolvePendingEcho({ id: 'm-11' }, 'failed')
  const text = transcriptText(doc)
  assert.ok(text.includes('✘ not delivered · doomed prompt'))
  assert.ok(!text.includes('↪ steer'), 'no ↪ ghost remains')
})

test('B1: a canceled echo survives theme rebuilds via the replay op', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPendingEcho('cancel then reskin', 'queued', 'm-12')
  renderer.resolvePendingEcho({ id: 'm-12' }, 'canceled')
  renderer.setTheme(darkTheme)
  const rebuilt = transcriptText(doc)
  assert.ok(rebuilt.includes('✕ canceled · cancel then reskin'), 'canceled state reproduced after rebuild')
  assert.ok(!rebuilt.includes('⏳'), 'badge never resurrects on rebuild')
})

test('B1: prunePendingEchoes cancels dead echoes and keeps alive ones pending', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPendingEcho('still queued', 'queued', 'm-alive')
  renderer.renderPendingEcho('lost to abort', 'steer', 'm-dead')
  const pruned = renderer.prunePendingEchoes(messageId => messageId === 'm-alive')
  assert.equal(pruned, 1, 'exactly the dead entry resolved')
  const text = transcriptText(doc)
  assert.ok(!text.includes('↪ steer · lost to abort'), 'dead badge gone')
  assert.ok(text.includes('✕ canceled · lost to abort'), 'dead echo shows the canceled end state')
  assert.ok(text.includes('⏳ queued · still queued'), 'alive entry stays pending')
  // A later claim of the surviving message still consumes it in place.
  const before = doc.children.length
  renderer.applyEvent(claimEvent('still queued', 2))
  assert.equal(doc.children.length, before)
  assert.ok(!transcriptText(doc).includes('⏳'))
})

test('B1: claim matching prefers the message id; a foreign id with equal text does not consume', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPendingEcho('same text', 'queued', 'm-mine')
  // A DIFFERENT message echoing the same text must not eat our badge.
  const foreign = claimEvent('same text', 3)
  foreign.data.id = 'm-theirs'
  renderer.applyEvent(foreign)
  assert.ok(transcriptText(doc).includes('⏳ queued · same text'), 'foreign claim leaves the badge alone')
  // The real owner (id match) consumes it; an id-less event falls back to text.
  const owner = claimEvent('same text', 4)
  owner.data.id = 'm-mine'
  renderer.applyEvent(owner)
  assert.ok(!transcriptText(doc).includes('⏳'), 'owner claim consumes the badge')
})

// ------------------------------------------------------------- S3: degrade flip --

test('S3: rebadgePendingEcho flips ↪ steer to ⏳ queued in place after a degrade', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPendingEcho('slow down', 'steer', 'm-13')
  const before = doc.children.length
  assert.equal(renderer.rebadgePendingEcho({ id: 'm-13' }, 'queued'), true)
  assert.equal(doc.children.length, before, 'flip happens in place')
  const text = transcriptText(doc)
  assert.ok(text.includes('⏳ queued · slow down'), 'badge now says queued')
  assert.ok(!text.includes('↪ steer'), 'stale steer label gone')
  // The flipped bubble still consumes like any queued echo afterwards.
  renderer.applyEvent(claimEvent('slow down', 5))
  assert.ok(!transcriptText(doc).includes('queued'), 'claim consumes the flipped badge')
})

test('S3: the flip survives a theme rebuild (replay op carries the new badge)', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPendingEcho('flip me', 'steer', 'm-14')
  renderer.rebadgePendingEcho({ id: 'm-14' }, 'queued')
  renderer.setTheme(darkTheme)
  const rebuilt = transcriptText(doc)
  assert.ok(rebuilt.includes('⏳ queued · flip me'))
  assert.ok(!rebuilt.includes('↪ steer'), 'rebuild never resurrects the steer badge')
})

test('resolve/rebadge return false without a matching pending echo (unknown id)', () => {
  const renderer = new TranscriptRenderer(new Container(), lightTheme, () => {})
  assert.equal(renderer.resolvePendingEcho({ id: 'nope' }, 'canceled'), false)
  assert.equal(renderer.rebadgePendingEcho({ id: 'nope' }, 'queued'), false)
})

// --------------------------------------- v0.20.1: prune on EVERY turn/end --

/**
 * Mirror of the index.ts bridgeCallback turn/end branch under test: the
 * alive set is exactly the agent inbox snapshot (getPendingPrompts =
 * next-step ∪ next-turn message ids), whatever the end reason was.
 */
function pruneOnTurnEnd(renderer, inboxIds) {
  const alive = new Set(inboxIds.map(String))
  return renderer.prunePendingEchoes(messageId => alive.has(String(messageId)))
}

/** One test case per turn/end reason kind — all must sweep dead badges. */
for (const reasonKind of ['blocked', 'completed', 'aborted', 'error']) {
  test(`turn/end ${reasonKind}: stranded badge becomes canceled, no ghost remains`, () => {
    const doc = new Container()
    const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
    renderer.renderPendingEcho('claimed then blocked', 'queued', 'm-claim')
    // The pre-step rejecter scenario: the claimed batch left the inbox and
    // never produced a user/message — nothing is alive anymore.
    const pruned = pruneOnTurnEnd(renderer, [])
    assert.equal(pruned, 1, `${reasonKind} end sweeps the stranded badge`)
    const text = transcriptText(doc)
    assert.ok(text.includes('✕ canceled · claimed then blocked'), `${reasonKind}: explicit canceled end state`)
    assert.ok(!text.includes('⏳'), `${reasonKind}: no ⏳ ghost remains`)
  })

  test(`turn/end ${reasonKind}: an entry still in the inbox keeps its pending badge`, () => {
    const doc = new Container()
    const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
    renderer.renderPendingEcho('still queued for next turn', 'queued', 'm-alive')
    renderer.renderPendingEcho('vanished from the inbox', 'steer', 'm-dead')
    const pruned = pruneOnTurnEnd(renderer, ['m-alive'])
    assert.equal(pruned, 1, 'exactly the not-in-inbox entry resolved')
    const text = transcriptText(doc)
    assert.ok(text.includes('⏳ queued · still queued for next turn'), `${reasonKind}: queued entry untouched`)
    assert.ok(!text.includes('↪ steer · vanished from the inbox'), `${reasonKind}: only the dead badge goes`)
    assert.ok(text.includes('✕ canceled · vanished from the inbox'))
    // The surviving entry must remain claimable by a later user/message.
    const before = doc.children.length
    renderer.applyEvent(claimEvent('still queued for next turn', 7))
    assert.equal(doc.children.length, before, 'survivor consumes in place')
    assert.ok(!transcriptText(doc).includes('⏳'), `${reasonKind}: survivor's badge consumed normally`)
  })
}

test('steer entries still in nextStep survive a completed turn-end prune too', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderPendingEcho('waiting to steer', 'steer', 'm-steer')
  pruneOnTurnEnd(renderer, ['m-steer'])
  assert.ok(transcriptText(doc).includes('↪ steer · waiting to steer'), 'alive steer badge stays pending')
})

test('a warning notice renders with ⚠ + attention color and survives theme rebuilds', () => {
  const doc = new Container()
  const renderer = new TranscriptRenderer(doc, lightTheme, () => {})
  renderer.renderNotice('Queue status refresh failed', 'warning')
  // Raw (non-stripped) render for the color assertions.
  const raw = doc.children.map(child => child.render(200).join('\n')).join('\n')
  assert.ok(stripAnsi(raw).includes('⚠ Queue status refresh failed'), 'warning prefix present')
  assert.ok(raw.includes(ansiFg(lightTheme.palette.attention)), 'attention-colored')
  assert.ok(!raw.includes(`✘`), 'not styled as an error')
  renderer.setTheme(darkTheme)
  const rebuilt = transcriptText(doc)
  assert.ok(rebuilt.includes('⚠ Queue status refresh failed'), 'warning survives the replay rebuild')
})
