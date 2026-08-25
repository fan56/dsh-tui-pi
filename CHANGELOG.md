# Changelog

All notable changes to dsh-tui-pi are documented here, grouped by release.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.22.1] - 2026-08-25

### Fixed

- **No operator trace writes raw stderr into the TUI frame anymore — all
  five traces ride one shared notice bridge** (`src/notice-bridge.ts`,
  new; `src/retention.ts`, `src/sessions.ts`, `src/theme-settings.ts`,
  `src/ask-user.ts`, `src/tui.ts`, `src/index.ts`). The plugin runs
  in-process with the TUI, which owns the terminal for the alt-screen
  render, so every bare `console.warn` was pasting raw stderr bytes onto
  the frame and scribbling over the session body. The five converted
  call sites: the session-retention result line, invalid
  `dsh-tui.retention.*` settings values (one per field), invalid
  `dsh-tui.resume.*` settings values, the `dsh-tui` settings-namespace
  registration failure, and the missing `ctx.userQuestions` service
  warning. Each now goes through `emitNotice`: delivered immediately as a
  transient muted notice stacked above the footer when the TUI's sink is
  registered, held pending (bounded FIFO, order-preserving) until the
  sink registers after the first frame — a startup batch of config
  warnings surfaces as stacked lines instead of one replace-on-arrival
  line — and silently dropped when no sink ever registers (headless).
  There is deliberately NO flush timer and NO stderr fallback: a timer
  firing after a slow-starting TUI entered the alt-screen would write raw
  bytes over the frame — the exact failure this fixes. `/reload` safety
  comes from ESM module-cache eviction plus each producer's own one-shot
  guard; a reload that fails and rolls back leaves still-pending messages
  to be consumed exactly once (≤ 1 batch) by the restarted TUI. Message
  text keeps its readable body but drops the `[dsh-tui-pi]` bracket
  prefix — a muted in-TUI notice does not need the log-source tag.

## [0.22.0] - 2026-08-25

### Added

- **Startup session-log retention janitor** (`src/retention.ts`). On
  startup the plugin walks the session store and removes stale session
  logs before they grow unbounded: the age rule deletes logs older than
  the window and always keeps newer ones, while the count rule trims the
  oldest beyond a keep-limit behind a 24h idle guard; the current session
  and an in-flight /resume target are exempt and never occupy slots.
  Thresholds are dual-layer configurable — settings.yaml `dsh-tui.retention.*`
  explicit values take precedence over `DSH_TUI_RETENTION_MAX_COUNT` /
  `_MAX_AGE_DAYS` / `_MIN_IDLE_HOURS` env over defaults — and setting
  `DSH_TUI_RETENTION_MAX_COUNT=0` (or its settings counterpart) at the
  winning layer disables the janitor entirely, the escape hatch for
  long-lived read-attach processes. The result line goes to stderr only,
  and the pass is fire-and-forget behind a per-process one-shot.
- **Startup config summary + exit resume hint** (`src/startup-info.ts`).
  The welcome banner gains a best-effort readout line (mcp count, skills
  installed/total, collapsed plugin tree) plus the profile root row, so
  the effective configuration is visible at a glance; on clean exit the
  TUI prints a pi-style hint naming the exact `/resume` command to pick
  the session back up in the next shell.
- **DeepSeek brand icon asset** (`assets/deepseek-icon.svg`). The official
  DeepSeek whale logo (brand blue #4D6BFE) is added to the repo for future
  branding/README use; it is not referenced by code yet. Source: DeepSeek
  (deepseek.com) brand asset; © DeepSeek.

### Changed

- **The /resume picker filters what it displays** (`src/sessions.ts`).
  Rows for sessions that have been inactive beyond `maxAgeDays` or whose
  logs are smaller than `minBytes` are hidden from the picker, keeping it
  focused on live work instead of stubs and archaeology. The knobs share
  retention's dual-layer chain — settings.yaml `dsh-tui.resume.*`
  explicit > `DSH_TUI_RESUME_MAX_AGE_DAYS` / `_MIN_BYTES` env > defaults
  (7 days / 20KB) — resolved each time the picker opens.
- **/resume column layout: DIR capped, SESSION flexes**
  (`src/sessions.ts`). The DIR column is capped at 32 columns instead of
  swallowing wide store paths, and the SESSION column takes the freed
  space as its flexible tail, so long titles survive narrow terminals.
- e2e hardening around the new startup surface: the autocomplete
  assertion now matches the completion-row shape (bracketed kind badge +
  slash value) rather than bare command-name substrings, which the
  startup summary's `skills` token used to hit permanently;
  `esc_until_gone` relaxes to six rounds of Esc + 1.5s with a stuck-pane
  dump on failure; a new `66-retention-resume` scenario covers the
  janitor and the display filter end-to-end against zstd-frame fixtures.

### Fixed

- **Skill installation is idempotent** (`src/skills-manager.ts`).
  Re-applying an unchanged skill symlink is now a no-op (including
  relative-target equivalence), different-source or physical-destination
  installs are refused instead of clobbered, dangling-link repair is
  gated to ENOENT/ELOOP, and one failing item no longer aborts the
  remaining pending changes in the batch.

## [0.21.0] - 2026-08-25

### Added

- **`/login` custom provider support** (`src/custom-provider.ts`,
  `src/login.ts`, `src/settings.ts`). The provider picker gains a
  "Custom provider…" entry (also reachable as `/login custom`) for
  enterprise/third-party gateways pi-ai does not ship — the web Models
  page's add-custom-provider counterpart. Selecting it opens a chained
  six-field form (route id → display name → API protocol → base URL →
  model list → masked API key) that composes the hand-declared
  `llm-pi-ai.providers.<id>` profile (`api`/`baseURL`/`models`/
  `displayName` + derived `apiKeyEnv`) and commits through the same
  `commitProvider` chain as a catalog login; the route's models appear in
  `/model` without a restart. Field validation is pure and unit-tested
  (slug ids with collision guard against catalog + configured routes,
  protocol membership, http(s) URLs, de-duplicated model ids).
- **maxRounds wrap-up injections are now visible** (`src/session.ts`,
  `src/dsh-events.ts`, `src/live-widgets.ts`, `src/subagent-viewer.ts`).
  A `dsh-tui-pi`-sourced injection into a child (the maxRounds wrap-up, a
  Ctrl+G steer) stamps the child's view (`injectedAt`): the compact
  running-agent line, the Ctrl+G picker row and the viewer header show a
  `⚡` marker, and the viewer transcript renders the injected message as
  `⚡ <text>` (instead of the generic `ⓘ`) — a silently-ignored wrap-up is
  now distinguishable from one that never fired.

### Changed

- **Ask-user questions render as a docked panel, not a floating popup**
  (`src/ask-user.ts`, `src/tui.ts`, `src/index.ts`). The questions panel
  now mounts in a new dock slot directly above the chat input (the
  Todos-panel bordered-box look) instead of a framed overlay: it takes
  keyboard focus while open, the app keymap treats it exactly like an open
  overlay (Esc/Ctrl+C/app keys yield to the panel — Esc never arms the
  running-task stop from inside the modal), and the scroll window derives
  from the dock budget (terminal rows minus editor/footer/transcript
  reserve). Focus returns to the current editor on close; a capturing
  overlay open beneath is dismissed on open (the question is a hard modal).
- **maxRounds wrap-up delivery is routed by the child's live status**
  (`src/subagent-policy.ts`). The injection used `followup()` — queued as
  the child's next TURN — so a running child could burn many more rounds
  inside its current turn before the wrap-up landed (the cap visibly never
  bit). A running child now takes `steer()` (consumed at the next step
  boundary, i.e. the very next LLM round-trip), matching the Ctrl+G steer
  routing; an idle-but-unsettled child still takes `followup()`. The
  message is a directive English wrap-up naming the limit and forbidding
  further tool calls (the soft one-line request was routinely ignored).
- **/resume orders sessions by last update, newest first**
  (`src/sessions.ts`). The picker used creation time; a session the user
  touched recently now surfaces above newer-created stale ones. The
  last-update source is the jsonl log file's mtime (best-effort walk of
  `$DSH_SESSION_ROOT` / `$DSH_HOME/sessions`; unknown roots or non-jsonl
  backends degrade to the previous createdAt ordering). The WHEN column
  is retitled `Updated` and shows the effective sort time.
- **The registered-subagents iron rule ships in the default
  APPEND_SYSTEM.md template** (`templates/APPEND_SYSTEM.md`,
  `src/append-system.ts`). "When the user says 'subagent', they mean the
  registered subagents only; never use unregistered subagents" is now
  Core rule 6 of the shipped orchestrator template, and
  `ensureAppendSystemFile` appends it idempotently (case-insensitive
  phrase check) to pre-existing files that do not phrase it yet — a
  hand-edited rule is never duplicated.

## [0.20.1] - 2026-08-24

### Fixed

- **Pending badges are pruned on EVERY turn end** (`src/index.ts`). The
  transcript sweep for stranded routed-badge echoes (`⏳ queued` / `↪ steer`
  ghosts) used to run only when a turn ended `aborted`/`error`. Two more
  end reasons strand badges just as permanently: `blocked` (the pre-step
  rejecter removes the claimed batch from the inbox without ever producing
  a `user/message`) and an empty-enter `completed`. The sweep now runs on
  all turn ends; it stays safe because its alive-check resolves only echo
  message ids that are gone from BOTH inbox boundaries (next-step ∪
  next-turn), so entries still queued for a later turn keep their pending
  badge and remain claimable.
- **Queue-panel refresh failures surface instead of going silent**
  (`src/queue-panel.ts`, `src/messages.ts`, `src/index.ts`). The live
  panel's tick swallowed every `readItems` error, so a persistent failure
  left the panel silently showing stale data forever. Consecutive failures
  are now counted: at the third (`QUEUE_REFRESH_FAIL_THRESHOLD`) one
  warning is raised per streak — an in-panel "may be stale" notice line
  plus a durable ⚠ warning in the buffered transcript via the new
  `renderNotice(…, 'warning')` level — and any successful tick resets the
  counter so a later outage can warn again. Transient single-tick blips
  never warn and a persistent outage never spams.

## [0.20.0] - 2026-08-24

### Added

- **Submit routing dialog while the agent runs** (`src/route-dialog.ts`,
  `src/index.ts`). Submitting a prompt mid-turn now opens a two-option
  overlay — "Queue as follow-up" / "Steer now" — instead of silently
  queuing: ↑↓ or `1`/`2` select, Enter confirms, Esc cancels and restores
  the draft into the editor untouched (nothing is sent). An idle agent
  keeps the direct-send path.
- **Race fallback for steering** (`src/steer-flow.ts`). A chosen "Steer now"
  re-checks the driver status at flush time; when the turn ended in between
  (or the steer primitive rejects), the message automatically degrades to a
  queued follow-up with an info notice stating the actual route taken.
  Delivery runs deferred out of the keypress stack (subagent steer-input
  timing defense).
- **Pending-message queue panel** (`src/queue-panel.ts`, Ctrl+O). Lists every
  pending (unclaimed) prompt from the live agent inbox — next-step steering
  (`↪ steer`) and queued follow-ups (`⏳ queued`). On an entry: `d` removes it
  (core `Inbox.remove`; a claimed/removed item reports not-found and the list
  refreshes), `s` promotes it out of the queue into an immediate strict
  steer — with the same race fallback, so a promote racing the turn end
  stays queued as a follow-up and says so. Esc closes; the list re-reads
  live (~300 ms). The binding registers in the app keymap layer and the
  `/hotkeys` `keybindings.json` contract (remappable).
- **Pending badge on routed echoes** (`src/messages.ts`). A prompt routed
  while the agent runs echoes locally with a display-only badge prefix on
  its bubble (`⏳ queued · …` / `↪ steer · …`). When the agent's inbox claims
  the message, the SAME bubble restyles back to the ordinary user bubble in
  place (no new line), theme rebuilds reflect the consumed state, and the
  badge never enters any persisted text.

### Changed

- `/hotkeys` now lists seven app keys (new `queuePanel`, default Ctrl+O).
- The ` ● last-request` line under the editor now tracks model prompts only —
  slash commands and cancelled routing dialogs no longer leave stale residue.
- Degrade notices share one wording source (`steer-flow.ts` constants) across
  the dialog path, the queue panel and the transcript mirrors.
- **Ask-user overlay: separated confirm zone, inline selection marks, word
  wrap** (`src/ask-user.ts` + new `wrapText` in `src/text.ts`). The
  `⏎ Confirm answers` row now sits in its own block, split from the question
  list by a blank line; the dedicated State column is gone — options carry
  their selection inline (`●` selected / `○` unselected, `✓` on the confirm
  row once every question is answered); and long question headers, option
  labels, descriptions and details word-wrap to the pane width (CJK-aware,
  grapheme-safe) instead of being clipped at the terminal edge.

### Fixed

- **Badge terminal states (no more ghost badges)** (`src/messages.ts`,
  `src/index.ts`). A pending badge previously had only one exit — the claim
  event. Now every other ending resolves the bubble explicitly: a revoke in
  the queue panel turns it into a faded struck-through `✕ canceled · …` line,
  a delivery that failed for good becomes `✘ not delivered · …`, and a turn
  aborted/failed prunes echoes whose messages no longer exist in the inbox.
  All terminal states restyle the SAME bubble in place, survive theme
  rebuilds via the replay op, and matching keys off the delivered message id
  first (trimmed text only as fallback).
- **Degrade flips the badge** (`src/index.ts`, review S3). A steer that
  raced into a degrade used to keep advertising `↪ steer`; the bubble now
  flips to `⏳ queued` in place (dialog path and queue-panel promote alike)
  so it tells the truth until the follow-up is claimed.
- **Promote double-failure can no longer orphan a message**
  (`src/steer-flow.ts`, review S2). Promote removes from the inbox before
  delivering; if steer AND its built-in follow-up fallback both failed, the
  message was left neither queued nor delivered. One recovery `followup` of
  the original object now re-queues it first; only when even that throws
  does an error surface — stating plainly that the message was NOT delivered
  and must be submitted again.
- **Multi-line draft survives a routing-dialog cancel** (`src/index.ts`,
  `src/route-dialog.ts`, review S1). Esc restores the RAW submitted text
  (the trimmed form mangled drafts with leading/trailing blank lines), and
  the dialog's draft preview folds onto one clipped row instead of breaking
  the overlay layout with raw newlines.
- **Queue-panel live-refresh timer has no leak path** (`src/panels.ts`,
  `src/queue-panel.ts`, review S4). `PanelHost` now disposes its panel
  component on close AND on replace (plus the half-mounted-overlay error
  path), and the panel closes itself when its session-validity gate
  (`shouldStayOpen`) turns false mid-view instead of ticking against a dead
  inbox.
- **Ask-user focus preemption no longer orphans flow overlays**
  (`src/index.ts`, review S6). Every overlay close funnels through a guarded
  refocus: while another capturing overlay (the ask-user panel preempting
  the route dialog / queue panel) still holds the keyboard, focus stays with
  it instead of being yanked to the editor, leaving the underlying panel
  visible but keyboard-dead.

## [0.19.1] - 2026-08-24

### Changed

- **Footer cache-hit stats are now per provider/model route**
  (`src/session.ts` + `src/footer.ts` + new
  `test/session-header-reset.test.mjs`). A `request/header` event whose
  provider or model VALUE differs from the running baseline restarts the CH
  accumulators (`inputTokens` / `cacheReadTokens` / `cacheWriteTokens` and
  the derived `cacheHitRate`) — a new route owns a fresh prompt cache, so
  mixing its tokens into the previous route's totals diluted both sides'
  rates. Same-value headers (a resume re-emitting an identical header) keep
  the totals growing; the first header only establishes the baseline.
  Route-independent stats (`outputTokens`, `msgCount`, `toolCallCount`,
  context occupancy) survive the reset untouched. Replay feeds persisted
  header events through the same `applyEvent` case, so a resumed session
  re-segments its history identically to the live run (double-replay is
  idempotent). The README's DCP section documents the new semantics.
- **/session panel token scope note** (`src/sessions.ts`). With tokens now
  per-route-segment, the panel title reads `ⓘ session · tokens: current
  route` — the note rides on the existing title line (no extra row: the
  panel stays height-budgeted for a 24-row terminal), while messages/events
  remain session-wide. Regression tests cover both the reset semantics (6
  cases incl. live/replay parity and route-independent survival) and the
  title note. Suite total 687 across 41 files.

## [0.19.0] - 2026-08-24

### Added

- **Ask-user scrolling window** (`src/ask-user.ts` + `test/ask-user.test.mjs`).
  pi-tui overlays are hard-clipped at `maxHeight` (`tui.js` `slice(0, maxHeight)`),
  so on short terminals or with many questions the tail options were off-screen
  while the cursor could still reach them — the "unselectable" bug. The body
  now renders through a scroll window that follows the cursor:
  `clampScrollWindow` (new pure function, semantics aligned with
  `skills.ts clampScrollOffset`) slides the offset so the cursor row is
  always visible. The window size adapts to the live terminal: new pure
  helper `askUserMaxVisibleForRows(termRows, maxHeight)` parses the overlay
  `maxHeight` budget like pi-tui's `parseSizeValue` then subtracts the
  fixed chrome (`ASK_USER_VIEW_OVERHEAD = 10` for the two borders, title,
  table chrome, footer rule, blank line, footer, and a hint of slack),
  matching `skills-manager.maxVisibleRows()`. A 24-row terminal resolves to
  9 (the prior constant), larger terminals scale up, unknown row counts
  fall back to `ASK_USER_MAX_VISIBLE`. While content overflows the
  footer gains a `(n/m)` position readout so the user can see the total
  option count at a glance.
- **Per-question numbered options with cursor marker** (`rowNumber` /
  `rowIndexForNumber` shared vocabulary). Every selectable row now renders
  `▸ 1. staging` / `  2. production`, with the sentinel row continuing the
  numbering and the confirm row keeping its fixed `⏎` glyph. `1`-`9` now
  jump straight to that row within the current question and follow the
  same confirm path as Enter — toggle a multi-select option, open the
  sentinel for editing, or auto-submit on a single-select. Out-of-range
  digits and digits on the confirm row are ignored; the footer hint
  gains `· 1-9 pick`. The numbering vocabulary is the same for the
  rendered prefix and the key-to-row reverse lookup, so the two stay in
  sync by construction.
- **Question / choice visual separation**. Each question header (and its
  optional detail) is now followed by a muted `─` divider line that
  visually fences the option block from the header above and the next
  question below. Headers stay `selectable: false`; the divider is its
  own content line that participates in the scroll window. Option
  descriptions are rendered on a separate muted, indented line aligned to
  the label's first column — labels no longer hard-truncate against their
  description via concat-clip, and `foldText` folds any embedded `\n`
  into a single space before `clipToWidth`.

### Fixed

- **Unreachable options on short / wide overlays**: see Added — the scroll
  window eliminates the "cursor reaches a row that isn't visible" case.
  The footer `(n/m)` now reflects what the user actually sees (cursor row
  out of total selectable rows, headers excluded) — same metric the
  review page uses, so the two views agree.
- **Navigation off-by-one**: `moveCursor` used to pass `cursorIndex + direction`
  to `nextSelectableIndex`, but the latter already scans from
  `from + direction`, so each arrow press skipped two rows. The bug had
  been masked for years by the initial cursor landing on the unselectable
  header row (index 0), where the first `↓` happens to land on index 2.
  The reducer now passes the raw cursor index, and `initialState` snaps
  the cursor to the first selectable row so the `▸` marker and Enter /
  digit targets are real from the start.
- **Digit select into a windowed sentinel**: the in-progress edit row
  now participates in `clampScrollWindow` anchoring (`editingAnchor`,
  accent bold) instead of relying on the `selected` flag — so jumping to
  a sentinel that's just outside the window opens the editor with the
  row actually visible and the footer readout in sync.
- **Header render order**: the bolded header line previously wrapped
  `clipToWidth(BOLD + text + RESET)`, which violates the iron rule
  "clip plain text before applying ANSI". It now clips the plain text
  first and then wraps the surviving segment in `BOLD`/`RESET`. A
  repo-wide scan found no other offenders.

## [0.18.1] - 2026-08-24

### Fixed

- **Startup crash on real profiles**: the cordis plugin declared
  `inject = ['agents', 'commands']` while its effects also accessed
  `ctx.userQuestions` (ask-user provider registration) and `ctx.systemPrompt`
  (the ask-user guidance section). Cordis throws on property access for a
  service missing from `inject` — it does not yield `undefined` — so on any
  real profile the TUI died at startup. The inject array now declares all four
  services (`agents`, `commands`, `userQuestions`, `systemPrompt`).
- **Regression guard**: new `test/plugin-inject.test.mjs` statically asserts,
  against `src/index.ts`, that both regression services stay injected and that
  every direct `ctx.<member>` access in the plugin entry is either an injected
  service or a known non-service Context member — so a future service touch
  cannot land without updating `inject`. Suite total 654 across 40 files.

## [0.18.0] - 2026-08-23

### Added

- **Ask User Question** — the model can now pause mid-turn and ask the human
  structured questions through dsh's `ask_user_question` tool
  (`@deepseek-ai/dsh-tool-ask-user`, newly mounted by this profile's
  `cordis.patch.yml`). The TUI hosts the answering side via a new provider on
  the `ctx.userQuestions` capability seam (`src/ask-user.ts`): one framed
  overlay flattens every question into option rows plus a `Type something.`
  free-text sentinel row; single-select replaces, multi-select toggles.
  A single question submits immediately on Enter; two or more route through
  a review page (every answer listed and editable in place) before
  `Submit answers` commits. Two Esc presses within 200 ms decline — every
  question receives a declined envelope — and any external overlay close
  (theme swap, `/reload`, agent abort) settles as declined too, so the tool
  call can never hang. A system-prompt section (`order: 112`) nudges the
  model toward conservative use: only genuine decision points, 1–3 questions
  with 2–4 mutually exclusive options per call. Inspired by
  [juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-ask-user-question).
- The new pure logic is unit-tested without a terminal by
  `test/ask-user.test.mjs` — 31 new tests covering state reducers, answer /
  declined envelopes, the double-Esc state machine, flat-row layout math,
  cursor movement over unselectable header rows, and both render views —
  suite total 600 across 39 files.

### Fixed

- **Ask User review round**: the request's abort signal
  is now honored — an aborted tool call closes the overlay and settles
  declined instead of leaving a zombie overlay that swallowed every keypress.
  A lone question answered only by typed free text (no options) could never
  reach submission; committing the sentinel edit now submits, symmetric with
  the option fast path. A lone multiSelect question no longer auto-submits on
  the first toggle — it gets a Confirm row so several options can be picked,
  and Enter on an incomplete confirm/submit row flashes a hint; committing a
  free-text answer jumps the cursor to the next unanswered question. Holding
  Esc no longer fires the decline gesture: key auto-repeat below a 50 ms gap
  is ignored by the double-Esc state machine. Provider registration failures
  other than the upstream `DUPLICATE_PROVIDER` are rethrown loudly instead of
  being swallowed silently (a missing `ctx.userQuestions` service degrades
  with a warning), and `@deepseek-ai/dsh-user-questions` is declared in
  peer/dev dependencies; typechecking resolves them via the global dsh
  closure relink (CI installs global dsh and relinks before running the
  check — a bare fresh clone cannot resolve `@deepseek-ai/*` on its own).
  Theme hot-swaps now
  apply live to open overlays (theme passed as a getter through
  `wrapFramedOverlay`), upstream `detail` text renders muted under its
  question header, and three dead-code spots were removed. Regression
  coverage grew from 31 to 55 tests (`test/ask-user.test.mjs`, including a
  fake-TUI interaction layer for the overlay and provider wiring) — suite
  total 624 across 39 files.
## [0.17.0] - 2026-08-23

### Added

- **Steer a running subagent from its transcript viewer** (`Ctrl+G` → pick a
  child → `Enter`). The transcript footer gains `· Enter steer`; pressing it
  opens a multi-line steer input overlay built on the pi-tui `Editor` with
  `disableSubmit`, so the panel owns Enter: `Enter` sends, `Shift+Enter`
  inserts a newline, `Esc` cancels back to the transcript with nothing
  injected. Delivery is routed by the child's live `Agent.status`
  (the public `'idle' | 'running'` signal from `@deepseek-ai/dsh-agent`
  runtime-types): `running` → `agent.steer()` (consumed at the next step
  boundary), `idle` but unsettled → `agent.followup()` (its own ordinary
  turn). A missing registry handle or a settled child never opens the box —
  the viewer shows "This subagent has ended — steering unavailable" instead,
  and the same liveness re-check runs at flush time, so a child that settles
  while the message is being typed is refused too. Mirroring the maxRounds
  wrap-up fix, the injection runs in a `queueMicrotask` callback — never on
  the synchronous keypress stack — and only a successful send closes the box;
  a throwing primitive keeps it open with an inline ✘ error so the draft can
  be retried. Success returns to the transcript with a transient
  "Steer message sent" notice (retired by the next keypress; it steals a body
  row rather than growing the overlay). Injected messages carry
  `{ kind: 'plugin', plugin: 'dsh-tui-pi' }` source, same as the maxRounds
  wrap-up. Viewer-internal keys stay hardcoded (not remappable through
  keybindings.json), like every other in-panel hint. +20 tests
  (subagent-viewer 15 → 35): route decision matrix, ended-path
  no-injection with feedback, message content/source shape, and the input
  panel's deferred/retryable/cancelled submission plus notice rendering and
  the exact-overlay budget.

## [0.16.2] - 2026-08-23

### Fixed

- The `maxRounds` wrap-up injection no longer dies silently on the append
  publication window, and a failed attempt no longer abandons the cap for
  that child forever. `onRoundCount` runs inside a child `session/event`
  observer — while the store-mounted session is mid-append — so the old
  synchronous `agent.followup()` reentered that in-flight append through its
  inbox splice and threw ("session append cannot reenter while another
  append is being published"); the contained observer dispatch swallowed the
  error and the already-set `injected` flag made the loss permanent. The
  followup now runs in a `queueMicrotask` callback (steer/inject are not an
  alternative: they ride the same splice → append path). The callback
  re-checks liveness at flush time (`ctx.agents.get(childId) !== agent` or a
  settled child aborts), marks `injected` only after a successful followup,
  and leaves it unset on failure so the next counted round retries. A
  pending injection is also cancelled by `dispose`. All prior
  semantics hold: `maxRounds <= 0` never injects, counts below the cap never
  trigger, each child is injected at most once, settled children are never
  re-awakened.
- Regression coverage in `test/subagent-policy.test.mjs` (19 → 23 tests):
  one drives the real path end to end — a SessionStore-mounted session, a
  real Inbox splice over it, and the policy invoked synchronously from a
  `session/event` listener — asserting the `agent/inbox/spliced` event lands
  with a pending inbox message after the microtask flush; another proves a
  throwing followup keeps the cap unarmed until a retry succeeds.

## [0.16.1] - 2026-08-23

### Fixed

- The subagent compact row no longer shows `↻N≤M` after a successful retry.
  `dsh` emits no event when a retried request lands, so the bridge itself
  clears the `retries` / `maxRetries` counters at two points: an
  `assistant/message` proves the round-trip succeeded (it folds into the
  existing per-event `agentViews.set` so it cannot clobber the token /
  lastLine / rounds / contextTokens updates), and a `turn/start` on a
  continuable child resets the previous run's counters. The latter split is
  driven by `outcomeCleared = view.outcome !== undefined` plus
  `retryCleared = view.retries !== 0 || view.maxRetries !== undefined`, so
  retries are dropped unconditionally on every turn start (safe for fresh
  views where they are already 0) while outcome/endedAt stay gated by
  `view.outcome !== undefined`. The `AgentView.retries` /
  `AgentView.maxRetries` doc comments are updated to reflect the new
  semantics (0 = no active / pending retry in the current turn).

## [0.16.0] - 2026-08-23

### Added

- The `/model` picker gains three in-panel keys. `f` toggles the favorite
  flag on the cursor model — the list reorders live with favorites pinned
  on top behind a divider row. `h` toggles hidden — hidden models move to
  a dim Hidden section at the bottom of the list (with a count header), and
  the hide is guarded so the last still-visible row cannot be hidden away.
  `/` engages a session-local substring filter matched case-insensitively
  against name, id and provider.
- Favorite/hidden selections persist under the dsh-tui settings namespace
  as `favoriteModels` / `hiddenModels` string lists (`provider/id` keys).
  Each toggle flushes immediately, best-effort: a deployment without the
  settings service keeps the reordered/hidden state for the session only.
  The picker works on local copies of the lists, so cancelling the overlay
  never writes anything on its own.
- `TablePanel` grows selectable-row predicates so structural rows (the
  favorites divider and the Hidden header) render without being
  selectable, plus an optional footer hint row; the picker advertises
  `↑↓ navigate · Enter select · f favorite · h hide · / filter · Esc back`.

### Changed

- Row assembly, filter matching and the toggle/hide-guard helpers moved
  into the new pure module `src/model-list.ts` (data-in/data-out, no TUI
  imports), unit-tested by `test/model-list.test.mjs` — 21 new tests,
  suite total 569 across 38 files.

## [0.15.1] - 2026-08-22

### Fixed

- The `disableSubagent` guard now denies the native `subagent` tool only for
  sessions this TUI created or resumed, failing open for everything else.
  Previously the guard was process-global (plain-context dsh semantics), so
  installing this plugin into a web profile would also have disabled the
  built-in subagent inside Web UI sessions. The bridge now marks its agent
  scope with a surface key in both session setups (create and resume — dsh
  runs setup on the resume path too); the guard reads the calling agent's
  marker via `exec.agent` and passes unmarked callers through to the
  `maxAgents` cap check. Session meta was not usable as the carrier: dsh's
  session store folds only its known header fields into the durable
  `SessionHeader`, silently dropping custom fields at create time. The
  per-session spawn-tool hide (`tools.restrict`) is unchanged. Known semantic
  edge: children spawned by a TUI session through `use_agent` carry no
  marker, so their own plain `subagent` calls are no longer denied — the
  documented fail-open trade-off.
- The surface key is written with cordis `provide`, not `set`: on a real
  Context, `set` of a name that was not provided first throws ("cannot set
  property ... without provide"), and the marker is installed inside the
  session setups — a throw there would have rolled back every session
  create/resume. Regression-tested against a real `@deepseek-ai/cordis`
  Context (provide → get roundtrip + guard read-back).
- Boundary convergence: the `maxAgents` cap denial now carries the same
  surface-marker condition as the fence, so it too only fires for sessions
  this TUI created or resumed. The live-children count stays global; an
  unmarked agent sharing this process spawns freely even over the cap.

## [0.15.0] - 2026-08-22

### Changed

- The TUI now starts with the `standard` agent preset selected when the roster
  supplies one (`initialPresetIndex`), falling back to the first-scanned entry
  otherwise. This is a local selection only: before user interaction with
  `/preset` or `Tab`, no `meta.agentPreset` is sent at session create, so the
  server-side default (`agent-presets.default`) still governs.
- README documents `/preset`, the `Tab` preset-cycle shortcut and the startup
  default-selection behavior.

## [0.14.1] - 2026-08-22

### Fixed

- Preset roster now loads correctly: scan the filesystem directly (shipped
  root at `<dsh>/config/agent-presets/` and user root at `~/.dsh/.agent-presets/`)
  instead of relying on the `agentPresets` service which is inaccessible from
  the TUI plugin fiber.

## [0.14.0] - 2026-08-22

### Added

- Agent preset switch via **Tab** key: cycles through the deployment's agent
  presets; the footer brand segment shows the current selection as `dsh(<name>)`.
  The chosen preset is applied to the next blank session on first submit.
- `/preset` command: bare opens a picker overlay, `<name>` switches directly,
  `next` cycles forward (same as Tab).
- `presetCycle` keybinding in `/hotkeys` (default: Tab, remappable via
  `keybindings.json`).
- New `src/preset.ts` module: `fetchPresetRoster` (from `ctx.apiProxy`),
  `cyclePreset`, `currentPreset`, `findPresetByName`, `formatPresetLabel`.
- e2e scenario `60-preset`: graceful degradation when no presets are configured.

### Changed

- Footer hint bar now includes `Tab: preset` segment.
- `FooterDataSource` gains `getPreset(): string | undefined`.
- `DshSessionBridge` gains `setAgentPreset()` / `isSessionBlank()`; session
  creation passes `meta.agentPreset` to `ctx.agents.create()`.

## [0.13.0] - 2026-08-22

### Changed

- The `/session` info panel now renders in the same FW auto-table style as
  every other panel (`autoColumns` + booktabs rules from `src/panels.ts`):
  a fitted FIELD column, a flex VALUE column that clips instead of wrapping,
  and the shared theme fns. Same data rows — the session row now shows the
  full id (the flex column clips it rather than hiding it); the row data is
  locked by `sessionInfoRows` unit tests.

### Removed

- The empty-editor double-Esc binding that opened `/session`. An idle Esc is
  now always a no-op (pi's anti-misfire behavior); `/session` opens via the
  slash command only. The running-task double-Esc stop and the Ctrl+C /
  Ctrl+D / Ctrl+L / Ctrl+G chains are unchanged.

## [0.12.0] — 2026-08-21

### Added

- Usage-frequency sorting for slash completions (commands and skills share
  one list): most-used entries float to the top, and a keyword-filtered
  result keeps the frequency order of what remains. Ties break
  alphabetically; with an empty usage table the list degrades to the
  previous name-only order. Counts persist in
  `$DSH_HOME/tui-command-usage.json` (default `~/.dsh/`): atomic
  tmp+rename write on each use event, tolerant load (missing/corrupt file
  yields an empty table, never an error), and a 500-entry cap pruned by
  count. Concurrent dsh instances merge safely — each write re-reads the
  file and applies only its own baseline+delta, so one process no longer
  erases another's increments. Commands count on successful execution;
  skills count when a submitted `/name` gesture resolves against the live
  user-invocable registry (unknown names never count). New
  `src/usage.ts` + `test/usage.test.mjs` (26 cases); the suite stands at
  520 tests across 35 files.

## [0.11.0] — 2026-08-21

### Added

- `/model-sync`: imports discoverable models into a custom provider's
  stored model list. Discovery goes through `LlmRuntime.discoverModels`
  (the same seam as settings' "Fetch available models"); new ids are
  appended after the existing entries without reordering them, and a
  sync that finds nothing new skips the settings write entirely
  (no-op = zero mutations). Named catalog routes are not sync targets
  and are redirected to `/models-sync` with an accurate error message.
  The handler resolves the llm runtime via `ctx.get('llm')`, so it works
  on the live command fiber and degrades to an unavailable-runtime error
  when no LLM runtime is mounted. `test/model-sync.test.mjs` carries 18
  cases; the suite stands at 493 tests across 34 files.

### Changed

- `/skills-manager` is renamed to `/skills`: same standalone skill browser
  (`src/skills-manager.ts` keeps its filename), now registered under the
  shorter name in both channels and in `MODAL_COMMANDS`. The editor token
  charset drops `:`, mirroring dsh-commands' COMMAND_NAME exactly.

### Removed

- `/skill` (singular): the skill-invocation picker command is gone from both
  registration channels, `MODAL_COMMANDS`, and the `submit()` intercept;
  `pickSkill` and the `parseSkillCommand`/`skillGesture`/
  `skillCompletionQuery` helpers behind it are deleted. User-invocable
  skills remain reachable by typing their native `/name ` gesture directly
  (harness tool-skill injects the content) and still appear as `[s]` rows in
  the `/` autocomplete.

## [0.10.6] — 2026-08-21

### Changed

- `templates/APPEND_SYSTEM.md`: rule 3 (review gate) now carries a small-task
  exception — when facts are already confirmed and the remaining work is pure
  implementation, dispatch a sub-agent and skip the review pass (target
  ~6 min); review stays mandatory for design/code changes, risky operations,
  and unverified assumptions.

## [0.10.4] — 2026-08-21

### Changed

- `/logout` now unsubscribes the provider completely: it removes the stored
  API key **and** the `llm-pi-ai` provider profile from settings.yaml
  (`{op:'unset', providers.<id>}`). Until now only the key went and the
  profile stayed, so the provider's models kept listing in `/model` (the
  llm-pi-ai adapter registers a route per profile key; a picked model would
  have failed at request time with MISSING_CREDENTIAL). With the profile
  gone, the route deregisters and the models leave `/model` immediately; a
  re-`/login` re-subscribes and serves the installed pi-ai catalog's
  current model list.
- The logout candidate's key ref now comes from the profile's own
  `apiKeyEnv` when it names one (falling back to the derived ref) — a
  hand-edited profile pointing at a custom ref no longer unsets an
  unrelated key while leaving the real one stranded. Hand-declared routes
  (no installed catalog entry) keep their profile on logout
  (`removed-key-only`): `/login` cannot re-create their
  api/baseURL/models, and the result text points at `/settings` to drop
  the provider instead. Ordering contract (new `commitLogout`,
  unit-tested): a failed key removal never touches the profile, and a
  failed profile removal never undoes the key removal
  (`removed-incomplete` reports it and names the `/settings` recovery
  path). A revision-conflicted profile removal re-reads the section and
  reports success when the profile is already gone (concurrent removals
  converge). 486 tests (+11: the commitLogout ordering outcomes, the
  apiKeyEnv/declared candidate plumbing, and `handDeclaredLogouts`).

## [0.10.3] — 2026-08-20

### Changed

- Tables now use the auto layout everywhere: every column EXCEPT the last
  fits the widest of its uppercase title and its cells (capped); the last
  column runs to the right edge and clips (never wraps). The `/settings`
  SETTING column replaces the 0.10.1 50% split (a long label is capped so
  VALUE keeps a floor); `/model` flips to MODEL auto │ PROVIDER-to-edge;
  `/resume` is SESSION/WHEN auto │ DIR-to-edge; the login picker, the
  Ctrl+G sub-agent picker and the `/agents` table (name/model/deep now
  content-fitted instead of hand-tuned) follow the same policy. New
  `autoColumns` helper; 475 tests (auto layout + settings cap covered).

## [0.10.2] — 2026-08-20

### Changed

- Tables are now sealed with the booktabs trio: a TOP rule (`─┬─`) directly
  under the panel title (the gap row that showed only the frame's side
  borders is gone), the header, the MID rule (`─┼─`), the rows, and a
  BOTTOM rule (`─┴─`) closing the table — junctions on one vertical line
  with the `│` column separators. Applies to every panel (settings browser,
  Skills submenu, TablePanel pickers, FieldPanel windows); single-column
  lists keep the rules without junctions.

## [0.10.1] — 2026-08-20

### Changed

- `/settings` rows: the value column now starts at 50% of the panel width
  (a fixed half split — the flex label column pushed values to the far
  right edge). 473 tests (one new: the 50% separator-position contract).

## [0.10.0] — 2026-08-20

### Changed

- Every selection overlay now speaks one table language (the TodosPanel
  look, minus the index column): `●` title, UPPERCASE subtle header row, a
  `─┼─` rule under it with junctions exactly under the `│` column
  separators, width-exact padded cells, and the ▸ + accent BOLD selection.
  Migrated off pi-tui's SelectList: `/model` (both stages), the effort,
  `/theme`, `/permission` and skill pickers (selectors.ts), `/resume`
  (sessions.ts, now SESSION │ WHEN │ DIR columns), the `/login` logout
  picker, the agent model picker inside `/agents`, and the Ctrl+G sub-agent
  picker (now a live-refreshing SUB-AGENT │ STATS table).
- `/settings` browser rows render as SETTING │ VALUE with the header + rule
  (the old two-space gap read as floating text); lists whose values are all
  empty (menu-only levels) collapse to a single column. The Skills submenu
  drops its index and state-text columns for an ON (●/○) │ SKILL table.
- FieldPanel windows (`/hotkeys`, the `/agents` fields/limits windows)
  render as FIELD │ VALUE tables with the header + rule.
- `padCell` now ends clipped cells with `…` (the old hard clip hid that
  content was lost); clipped headers/rules/rows are width-clamped on narrow
  terminals (the flex column's floor could push them past the overlay).
- TablePanel gains an optional `title`, `maxVisible` and a `selectedRow()`
  getter, and reserves the marker slot in its width budget (rows no longer
  overflow the overlay by the marker's 2 columns).
- 472 tests (was 467): new coverage for `fitColumnWidth` /
  `tableHeaderLine` / `tableRuleLine`, the TablePanel/FieldPanel header +
  rule + separator contract, the SettingsListPanel single-column collapse,
  and the ellipsis clip.

## [0.9.4] — 2026-08-20

### Changed

- Dependency bump: `@aiwayds/dsh-dcp` 0.5.0 -> 0.5.1 (fixes `/compact` and
  `/dcp compact` crashing with `Cannot read private member #triggerLabels
  from an object whose class did not declare it` — cordis hands services to
  consumers through derived receivers, and dcp 0.4.0+ private state
  brand-checked against them; 0.5.1 switches to symbol keys).  No test
  changes; 467 tests unchanged.

## [0.9.3] — 2026-08-20

### Changed

- Dependency bump: `@aiwayds/dsh-dcp` 0.4.0 -> 0.5.0 (message-count
  semantics + per-session stats; verified under dsh 0.1.0-rc.8 via live
  `/dcp --help` smoke).  `@aiwayds/dsh-subagent-registry` 0.1.3 and
  `@earendil-works/pi-tui` 0.84.2 were already the latest published.
- README (en/zh) now states supported dsh versions explicitly: 0.1.0-rc.7
  and 0.1.0-rc.8.  rc.8 coverage: unit tests with both `execute()` mock
  signatures plus a tmux e2e smoke (startup, `/model`, `/settings`,
  `/dcp --help`); rc.7 coverage: the 0.9.0/0.9.1 development baseline —
  the arity shim keeps the rc.7 call path identical to 0.9.1's direct
  invocation.  No test changes; 467 tests unchanged.

## [0.9.2] — 2026-08-20

### Fixed

- **Slash commands crash with dsh 0.1.0-rc.8** (`Cannot read properties of
  undefined (reading 'aborted')`).  `@deepseek-ai/dsh-commands` rc.8 inserted
  an `images` parameter into `CommandRuntime.execute()` before `signal`
  (rc.7: `execute(agent, line, signal)`; rc.8: `execute(agent, line,
  images, signal)`).  The TUI's direct 3-arg call passed `signal` into the
  `images` slot, leaving the handler's `invocation.signal` undefined.  Added
  `executeCommand()` compat helper with runtime arity detection
  (`execute.length >= 4`) that inserts an empty images array when needed;
  the rc.7 path is byte-identical to the old direct 3-arg call.  Known
  limit of arity probing: a future `execute()` gaining a default parameter
  or another inserted parameter would misroute — re-check this signature
  first if slash commands break after a dsh upgrade.  458 -> 467 tests.

## [0.9.1] — 2026-08-20

### Fixed

- **`auto` icon-set false negative on terminals with built-in Nerd symbol
  fallback** (Ghostty, WezTerm — on every platform, not just macOS).  The
  font-directory / fc-list scans only see installed font files, so they
  correctly report "no Nerd Font" when none is installed system-wide — but
  these terminals ship a built-in Symbols Nerd Font fallback and render
  U+E0B0 without any system-installed Nerd Font.  The probe now
  short-circuits to `true` when `TERM_PROGRAM` matches the whitelist,
  before touching the filesystem; the directory scans remain the fallback
  path for all other terminals.  Residual gap, accepted: tmux 3.3+
  rewrites TERM_PROGRAM to `tmux` inside panes, so the whitelist does not
  apply there — the probe falls through to the conservative (tofu-free)
  scan; under tmux set `dsh-tui.iconSet` explicitly.  457 → 458 tests.

## [0.9.0] — 2026-08-20

### Added

- **Subagent discovery: budget-aware header gate + persisted-header safety**.
  In-process children (spawn and fork-driven alike) are created through
  dsh's `childSessionMeta`, which writes `origin: 'subagent'` AND a
  `delegationDepth` budget (>= 1) together, so the origin marker alone
  already identifies them; the gate additionally admits an origin-less
  header that carries a positive budget as a defensive fallback (label
  `fork <id8>` — current dsh does not produce this shape). Crucially, BOTH
  this gate and `/resume`'s `isResumableSessionHeader` judge the budget BY
  VALUE (`> 0` / `=== 0`), never by field presence: the jsonl persistence
  backend materialises `delegationDepth: 0` on every restored header (write
  `?? 0`, read back unconditionally), so a presence test would (a) pull
  user-facing `Session.fork` conversations and other restored non-children
  onto the live board / Ctrl+G, and (b) filter EVERY persisted session out
  of `/resume` (empty picker). `/resume` excludes exactly the delegated
  children (`origin: 'subagent'` or budget > 0) and keeps root sessions and
  user-facing forks resumable. Two regression tests pin the persisted
  shapes (jsonl round-trip materialises `delegationDepth: 0`; a restored
  depth-0 fork with a tracked parent must stay off the board). 455 → 457
  tests.
- **DCP compaction visibility inside subagents**: dsh-dcp appends one
  `user/message` `notice`-form row per committed compaction on the child's own
  log (`source: { kind: 'plugin', plugin: 'dsh-dcp', form: 'notice', summary }`).
  The Ctrl+G transcript now renders that row with a `🧹` marker — distinct
  from the generic `ⓘ` — and the picker rows carry the per-child compaction
  count (`🧹 N×` in the description). Every tracked child shows its
  compactions the same way.

### Changed

- **Icon-set self-adaptation (方案 C)**: the TUI's only Private-Use-Area
  glyph — the powerline separator U+E0B0 in the footer — renders as a tofu
  box on terminals without a Nerd Font. A new `dsh-tui.iconSet` setting
  (`auto` | `nerdfont` | `plain`, default `auto`) adapts the risky glyphs
  (U+E0B0 → ▸, ⏹ → ■, ⭘ → ●): `auto` probes for a Nerd/Powerline font once
  at startup (Linux `fc-list -q` per candidate, macOS font-directory scan,
  Windows/other → plain; zero dependencies, memoised, never throws —
  src/font-detect.ts) and renders the powerline glyphs when found, the safe
  Unicode stand-ins otherwise; `nerdfont`/`plain` pin the set. The footer
  separator, the ⏹ stop notices and the ⭘ subagent glyph route through
  accessors (src/icons.ts, `applyIconSet` called at startup and on every
  hot-applied `iconSet` change), so a `plain`/no-font resolution swaps them
  everywhere without flicker. A ~170KB font subset (ASCII + U+E0B0 + the
  whole project glyph set; OFL sources Hack Nerd Font + Noto Sans Symbols,
  `assets/fonts-gen.mjs` regeneration script) ships in `assets/fonts/` and
  is packed into the npm package; `node scripts/install-font.mjs` installs
  it and best-effort flips the terminal (macOS iTerm2 via PlistBuddy on the
  default bookmark, Linux GNOME Terminal via gsettings + kitty/alacritty/
  wezterm config files backed up first; Terminal.app/SSH/Windows skipped) —
  or set any Nerd Font by hand (README → Fonts). 419 → 439 tests.
- **Subagent "rounds" now count assistant messages, not completed turns**:
  a round is one `assistant/message` (one LLM round-trip) on the child's own
  session events, so a one-shot child — which lives its whole life inside a
  single turn and therefore never advances `turn/end` — shows live round
  progress instead of a frozen 0. The bridge's counter, the `maxRounds`
  wrap-up injection, the viewer/picker `rounds N/M` displays and the
  `reconcileChildRounds` session-log fallback all count `assistant/message`
  now; `turn/end` keeps only its settle/clear-when-done duty. The compact
  running-agent line gains a `round N/M` meta segment (the `/M` part only
  when `maxRounds > 0`, read live). `maxRounds` default raised 50 → 75
  (headroom for heavy delegated tasks under the new, always-advancing
  message count; the user picked 75 over the initial 100). The once-only
  wrap-up injection holds even when the wrap-up's own reply pushes the count
  past the cap. 398 → 401 tests.
- **Context usage now prices the current occupancy, not the cumulative
  spend**: the footer's Context segment and the subagent compact rows'
  `X/Y` numerator was the session-wide `inputTokens` total ÷ window — a
  value that only grows, so a long session could show 175% while the actual
  last request was 33%. The numerator is now the LATEST request's billed
  context (input + cache read + cache write + output, from the most recent
  `assistant/message` usage snapshot) plus a CJK-aware token estimate
  (`estimateTextTokens`, ported from `@aiwayds/dsh-dcp`'s `lib/summarizer.js`
  — CJK scripts at ~2 chars/token, ASCII at 4) of every message appended
  after it, since those enter the next request. The footer percent caps at
  100 (the window is a hard ceiling, like the web client's StatsLine); a
  compaction shows its effect on the next request, which the display then
  follows down. The cumulative four buckets stay the `/session` panel's and
  the viewer's number (unchanged semantics). Streamed `reasoning-delta`
  chunks are priced into the pending estimate alongside `text-delta` —
  `usage.outputTokens` includes reasoning tokens at snapshot time, so the
  live estimate stays consistent with that accounting — and a usage-less
  `assistant/message` (adapter reported no usage) no longer zeroes the
  display: the last billed baseline and the accumulated pending estimate
  are kept until the next billed message replaces them. 401 → 419 tests.
- **Slash-completion badges shortened to `[c]` / `[s]`**: the dropdown tags on
  every completion row (`/model`, `/agents`, …) and the `/settings` Skills
  rows now read `[c]` for registry commands and `[s]` for skill rows (was
  `[cmd]` / `[skill]`). The badge alignment contract is unchanged (both tags
  are 3 columns wide, so `BADGE_WIDTH` needs no padding).
- **Skill rows render entirely italic in the slash dropdown**: the
  editor-inline autocomplete styles each skill row as one `\x1b[3m…\x1b[23m`
  italic span covering the whole label (badge + `/name`) and the description
  (the same SGR pi-tui's `MarkdownTheme.italic` emits; off-coded so the
  selected row's backdrop survives); command `[c]` rows stay completely plain
  (zero ANSI). The escapes are width-zero to pi-tui's text utilities, so rows
  still align and truncate exactly like the plain ones — and a truncated
  italic label self-closes: pi-tui 0.84.2's `truncateToWidth` terminates any
  truncated result with a full `\x1b[0m` reset (finalizeTruncatedResult), so
  the dropped `\x1b[23m` never leaks past the row (regression-tested against
  the real SelectList). The `/settings` Skills panel keeps the plain `[s]` tag
  (its row-line is a fixed-column plain-text contract). 394 → 398 tests.

### Fixed

- **Subagent round count no longer inflates when a streamed event lands after
  the session-log reconcile**: the `reconcileChildRounds` fallback derives a
  child's count from its authoritative session log, and the event path counts
  streamed `assistant/message` events. When the log got a message first and
  that message's own streamed event then arrived late, the old event path did
  `current + 1` on the reconcile-derived value — and because the reconcile
  only ever moves the count up, the +1 was permanent (per-child "rounds" and
  the `maxRounds` wrap-up both drifted high). The event path now keeps its own
  absolute streamed ledger and the displayed count is `max(streamed,
  reconciled)`, aligned with the reconcile's only-upward semantics; reseed /
  torn-down handling is unchanged.
- **Redundant `assistant/chunk` guard removed**: the inner
  `if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')` in
  the child chunk fold was always true (the outer guard already narrowed it);
  the pending-estimate pricing now runs unconditionally inside that branch.
  439 → 455 tests.

## [0.8.3] — 2026-08-20

### Fixed

- **Dark canvas + light-themed host terminal rendered dark (unreadable)
  unstyled text**: editor input, unselected picker rows and autocomplete
  rows print with the TERMINAL default foreground (the 0.8.0 give-up),
  which is dark text when the host terminal is light-themed (e.g. Ghostty
  "TokyoNight Day") and invisible on the dark canvas. The canvas decorator
  now owns the default FOREGROUND too: the theme's `fgDefault` is
  re-injected after every color-clearing reset (full resets restore bg+fg,
  `\x1b[39m` fg only, `\x1b[49m` bg only), so unstyled content always
  matches the painted canvas no matter what the host terminal looks like.
  pi itself never paints a canvas, so its unstyled text always matched the
  visible background — painting one means owning both channels.
  `DSH_TUI_TRANSPARENT=1` keeps both channels off. 392 → 394 tests.

## [0.8.2] — 2026-08-20

### Fixed

- **Canvas holes after background-clearing resets**: 0.8.0/0.8.1 only
  painted the erase sequences (BCE), so any cell written after a full SGR
  reset (`\x1b[0m`, `\x1b[m`, combined `\x1b[0;…m`, `\x1b[49m`) inside a
  row fell back to the terminal default background — invisible with the
  dark theme on a dark terminal, glaring holes after switching to light
  (whale-banner gaps, styled-text tails). The decorator now re-injects the
  canvas after every background-clearing reset, mirroring the old patched
  `paintCanvasRow` semantics; color-sets whose params merely contain a 0
  channel (e.g. `\x1b[48;2;0;121;107m`) are not treated as resets
  (regression suite ported from the patched-build tests). 389 → 392 tests.

## [0.8.1] — 2026-08-20

### Fixed

- **Plugin boot crash on npm-installed dsh**: the npm-distributed dsh
  closure (0.1.0-rc.6 ~ rc.8) is missing `@deepseek-ai/dsh-client-schema-form`
  (its in-repo consumers declare it only as a workspace peer — see
  deepseek-harness discussion #3471), and our static import of it took the
  whole plugin down at boot on every fresh npm-dsh install (Homebrew dsh
  carries the package, which is why macOS kept working). The three helpers
  the settings browser uses (`rehydrateSchema` / `nodeAtPath` / `getPath`)
  are now vendored in `src/schema-model.ts` (MIT, attribution in the module
  header); their only runtime dependency, `@deepseek-ai/schemastery`, is
  present in every dsh closure. New schema-model test suite; 386 → 389
  tests.

## [0.8.0] — 2026-08-20

### Changed

- **Removed the pi-tui patch — repo and npm installs are now identical.**
  `patches/@earendil-works__pi-tui.patch` (applied via pnpm
  `patchedDependencies`, which never propagated to consumers) is gone; the
  package runs pristine `@earendil-works/pi-tui@0.84.2` from npm.
- **Canvas background rebuilt on BCE**: the full-screen theme background is
  now painted by `src/canvas-terminal.ts`, a write-stream decorator around
  the terminal handed to `TuiAltScreen`. It prefixes the canvas SGR before
  every erase-line (`\x1b[2K`) / erase-screen (`\x1b[2J`) sequence —
  terminals with back color erase fill the erased regions with that
  background, so the whole screen (including blank rows) carries the theme
  color and a `/theme` switch recolors it in one forced full redraw
  (`requestRender(true)`; a diff render would skip content-unchanged rows).
  The alt-screen exit dump passes through unpainted, so quitting leaks no
  background to the shell. `DSH_TUI_TRANSPARENT=1` still reverts to the
  see-through canvas.

### Removed (intentional cosmetic regressions vs the patched build)

- Editor `textColor` hook: typed input uses the terminal default foreground
  (matches pi itself, whose editor input is unstyled).
- SelectList `unselectedText` hook: unselected picker rows render plain;
  the selected row keeps its full-row `canvasSubtle` backdrop and bold text.
- Autocomplete list box frame (`┌─┐`): back to the upstream bare list.
- Reverse-off cursor close (`\x1b[27m`): moot without `textColor`.

### Tests

- theme-canvas suite rewritten for the decorator: CanvasTerminal unit tests
  (erase-boundary injection, transparent passthrough, exit shutoff),
  TuiAltScreen-driven integration tests, and a startTui/applyTheme e2e in a
  child-process fixture (hijacking `process.stdout.write` inside a
  `*.test.mjs` file corrupts node:test's own reporting stream under process
  isolation). editor-theme suite deleted with the `textColor` hook.
  392 → 386 tests / 28 → 27 files.

## [0.7.2] — 2026-08-19

### Fixed

- **Blank screen on any unpatched-pi-tui install** (fresh `DSH_HOME`s, npm
  consumers, containers): the repo patches pi-tui (`setCanvasBackground` +
  canvas row painting) via pnpm `patchedDependencies`, which **never
  propagates to consumers** — a pristine `@earendil-works/pi-tui` has no
  `setCanvasBackground`, so `startTui`'s unconditional call threw inside the
  render effect and the TUI died silently: no banner, no error, process
  alive, only the pty's own input echo on screen (the `dsh --profile tui
  --help` "hang" from the 0.7.1 container report was this, not a boot
  stall). The canvas call is now feature-detected: unpatched builds degrade
  to the transparent canvas (the pre-0.6.0 look) instead of crashing;
  repo/patched installs keep full canvas painting. Regression test added
  (`startTui survives a pi-tui build without setCanvasBackground`).
- Pinned the meta-package dependencies to exact versions
  (`@aiwayds/dsh-dcp` `latest` → `0.4.0`,
  `@aiwayds/dsh-subagent-registry` `latest` → `0.1.3`) so installs are
  reproducible and can't drift into an untested future release.

## [0.7.1] — 2026-08-19

### Fixed

- **Plugin install fails on pnpm 11** (`ERR_PNPM_IGNORED_BUILDS`): the
  published `postinstall` script was a no-op for consumers (the `src/` guard
  exits immediately), but pnpm 11's default `strictDepBuilds=true` treats any
  ignored build script as a hard error — exit code 1 prevented dsh from
  registering the plugin in `dsh.profile.bundles`, leaving the TUI running a
  headless `dsh-base`-only tree (blank screen, no banner). Removed the
  `postinstall` lifecycle hook from the published manifest; the closure linker
  now runs as `precheck` (repo dev flow only). Also dropped `pnpm-workspace.yaml`
  from the published files (consumers don't use it).

## [0.7.0] — 2026-08-19

### Added

- **`/login` and `/logout` slash commands** — the terminal counterparts of
  pi's credential management, built on the Models category's add-provider
  flow. `/login` opens the searchable provider directory
  (already-configured routes included, so a re-login can overwrite a key),
  collects the API key through the masked editor, and commits the provider
  profile + credential exactly like the web Models page. An optional
  argument names the provider: `/login openai` jumps straight to the key
  editor on a unique exact/prefix match and opens a picker filtered to the
  matches otherwise. `/logout` lists the providers with a stored credential
  and removes only the key on selection — the settings.yaml provider entry
  stays, matching pi's logout semantics (auth is dropped, the model
  configuration is kept; the provider reads as "API key missing" afterwards).

### Changed

- **`/settings` panels migrated to the project's select-panel FW**
  (`src/panels.ts` + `src/frame.ts`): every list level (categories,
  namespaces, schema fields, the Models category) renders through the new
  `SettingsListPanel` — accent BOLD title, whole-row selection, PgUp/PgDn
  paging, footer with scroll info — replacing the last pi-tui `SettingsList`
  usages and the hand-written `listTheme` backdrop. Submenus (`EditField`,
  reset confirmation, read-only viewers, the Skills panel, the add-provider
  flow) share the same title/footer/color conventions, so `/settings` now
  visually matches `/agents` and `/hotkeys`. Search (type-to-filter, Esc to
  clear) and every write path (revisioned `settings.mutate`, secret masking,
  reset-to-defaults, provider credential commits) are unchanged.

## [0.6.0] — 2026-08-19

### Changed

- **Brightened dark palette** with better contrast (todo header and theme
  popup border fixes included).
- Footer's last-request echo shows only the first line of the user input —
  multi-line content no longer wraps the footer area.
- Added `repository` and `keywords` package metadata for dsh-plugin hub
  discovery.

## [0.5.0] — 2026-08-18

### Added

- **Bundle of the full dsh plugin suite**: `@aiwayds/dsh-subagent-registry` is
  now a dependency, so installing `@aiwayds/dsh-tui-pi` pulls the whole set —
  TUI + subagent registry (`use_agent` tool) + DCP compaction. No
  `@deepseek-ai/*` package is declared (they resolve to the single dsh closure
  via the profile fallback), keeping the cordis module identity intact.
- README rewrite: screenshot as a terminal recording (gif), feature sections
  (footer / think & tool blocks / subagents / DCP), npm install flow and a
  troubleshooting table; Chinese mirror (`README.zh.md`).

## [0.4.3] — 2026-08-18

### Changed

- **dsh-dcp mounting moved out of this bundle** into the dsh-dcp package itself
  (its own `cordis.patch.yml`, shipped since `@aiwayds/dsh-dcp@0.2.0`). This TUI
  still depends on `@aiwayds/dsh-dcp` (latest); to activate it, add dsh-dcp to
  the profile bundles (`dsh plugin add @aiwayds/dsh-dcp`). Mounting it here as
  well would duplicate the entry id and crash the loader.

## [0.4.2] — 2026-08-18

### Added

- **Ship the deterministic compaction backend `@aiwayds/dsh-dcp`** (dependency,
  tracked as `latest`). The bundle patch now disables the default LLM
  summarizer (`compaction-basic`) and mounts dsh-dcp in its place, so every
  profile that bundles this TUI gets zero-LLM compaction out of the box —
  `/dcp`, automatic pressure compaction, and overflow recovery included. See
  [dsh-dcp](https://github.com/fan56/dsh-dcp) for the backend's knobs.

## [0.4.1] — 2026-08-17

### Changed

- **Think/tool activity moved out of the transcript into fixed panels above
  the chat input** (like the Todos panel): the transcript is now chat-clean
  (user bubbles, assistant text, notices, echoes only). One `ThinkPanel` and
  one `ToolPanel` exist for the whole run — every event refreshes the same
  panel in place, and a panel with no content renders zero rows (hidden). A
  reasoning delta feeds the think panel; a tool call refreshes the tool
  panel (pending); a matching result settles it (✔/✘, frozen time, result
  tail); results for other parallel callIds are ignored; a text delta, an
  assembled message, a user message or a turn end hides the finished phase.
  Panels are self-drawing components — terminal resizes and theme
  hot-switches re-lay them out without any rebuild.
- **`dsh-tui.panelHeight` gains `'1'` (the new default)**: the panel renders
  ONE borderless row — block identifier + elapsed time + the last content
  line (live-refreshed), right-truncated at the terminal width, never
  wrapped. `'5'/'7'/'10'` keep the boxed panel (header row now also carries
  the elapsed time); `'all'` keeps the full body with the 200-line streaming
  tail and the 2000-line tool-result cap.
- **The bottom running-agent line shows content, not tools**: the child's
  latest line is the live-refreshed last line of its streamed assistant
  text/reasoning (folded from a bounded per-child buffer, updated per
  chunk; the assembled message is authoritative) — tool invocations no
  longer overwrite it with `⚙ <name>`. The tail takes everything the row
  has left and is truncated at the right edge; the agent name caps at 40%
  of the space the meta leaves.
- **Delegation spawn tools no longer open a tool block**: `use_agent`
  (and the `subagent`/`subagent_fork`/`workflow`/`ralph` family) surface
  their children in the running-agent lines below the editor — showing the
  same work again as a tool panel above the input would duplicate it. A
  delegation call clears any stale settled tool panel, and its result never
  reopens one.
- Test suite: panels/box/height/cap/narrow/theme coverage moved to
  `live.test.mjs` (driven through `LiveWidgets.applyEvent`); the count
  stands at **317 tests** across **25 files**.

## [0.3.0] — 2026-08-17

### Added

- **Submitted-message history (`↑` / `↓`)** — the chat editor now browses
  back through the messages you've submitted, shell-style: `↑` recalls the
  most recent prompt and walks further back, `↓` moves forward again, and
  past the newest entry it restores your in-progress draft. The history holds
  up to **500 entries**, dropping the oldest ones beyond that. It survives a
  theme hot-swap (the editor is rebuilt on switch, and its history — including
  the mid-browse cursor and pre-browse draft — is reseeded into the
  replacement). The history is in-memory for the current TUI run: it does
  **not** survive `/reload` or a restart. Submitted slash commands (`/theme`,
  `/hotkeys`, …) are recorded too. The browse itself is the pi-tui `Editor`
  native up/down history path; this work populates it on submit and lifts the
  base's hard-coded 100-entry cap to 500.
- **Test suite** grew to **297 unit tests** across **24 files**, with
  `history.test.mjs` (13 tests: the 500-cap, duplicate dedup, arrow
  browse/walk, draft restore, copy-on-read `getHistory()`, single-entry and
  multi-line recall, and mid-browse rebuild draft survival, plus a `FOOTER_HINT`
  ≤ 103-width guard), `editor-theme.test.mjs` suites, and canvas regression
  tests.

### Fixed

- **`pnpm install` no longer breaks the build** — the three `@deepseek-ai/*`
  packages that were declared in `package.json` (`dsh-settings`,
  `dsh-client-schema-form`, `schemastery`) are no longer declared: they are
  host-provided by the dsh CLI (the public registry only has stale rc.1
  versions and pulls a private `dsh-type-meta` → 404), and resolving a second
  local copy split `@deepseek-ai/cordis` into two instances, breaking the
  `settings` type augmentation (`Property 'settings' does not exist on type
  'Context'`). A `postinstall` script (`scripts/link-dsh-closure.mjs`) now
  points every `node_modules/@deepseek-ai/*` at the global dsh closure after
  every install, so `pnpm check` stays green with no manual symlink repair.
- **Powerline footer CH segment invisible (white-on-white)** — the app-owned
  canvas's background re-injection (`paintCanvasRow`) misread the `0` channel
  of truecolor SGRs (`48;2;0;121;107` cache-teal) as the reset param and
  painted the canvas over the segment: white background + white text in light
  themes. The pi-tui patch's `sgrClearsBackground` now treats 3x/4x color-sets
  (ANSI, truecolor, 256-color) as never clearing the background.
- **Dark theme leaking light colors** — the chat editor's input rows were
  unstyled (terminal default foreground), so typed text was black-on-black on
  the dark canvas. The patched `EditorTheme` gains an optional `textColor`
  hook that paints input rows with the theme body color (light text on dark);
  the cursor closes with `ESC[27m` (reverse-off) so the themed foreground
  survives a mid-text cursor. Agent label dots also get bright dark-theme
  variants instead of the dim light-theme hexes.

## [0.2.0] — 2026-08-17

### Added

- **Subagent viewer (`Ctrl+G` / `/subagents`)** — an 80% two-level panel over
  the tracked children: a picker (running first, then the five most recently
  settled) whose rows show status glyph, label, delegation mode, rounds
  against the cap, token spend and elapsed time, then a live transcript panel
  for one child's buffered event log (300 ms tick, tail-follow scroll,
  double-`x` or `Esc` to close). The picker refreshes live on a 300 ms tick —
  rounds, tokens and elapsed no longer freeze at open time — and re-reads the
  round cap every tick, so a `maxRounds` change hot-applies while it is open.
- **Subagent fine-grained control** (via `/agents` → `l`, both settings live-
  read at every decision):
  - `maxAgents` (default 4, `0` = unlimited): a `tools.guard` denies the
    model-facing spawn tools once the cap is reached, listing the running
    labels in the deny reason; a workflow/ralph fan-out is pruned on
    `subagent/start`.
  - `maxRounds` (default 50, `0` = unlimited): when a child reaches the cap,
    the TUI queues one wrap-up request as its next turn — never interrupts
    work in flight, never repeats per child, never re-awakens a settled child.
    No force stop.
- **`/agents` manager** — a four-column table (name / model / deep /
  description) over the agent definition markdown files (`~/dsh/agents`,
  seeded from `~/.zcode/agents` on first run), with a fields window for
  editing model/thinking/deep, a 40-line prompt viewer, and the subagent
  limits panel. `deep` defaults to 1; `0` disables spawning children.
- **`/hotkeys`** — a select-panel browser of the effective app-key table:
  each key is a row (custom overrides starred), `Enter` prompts for a new pi
  key id (empty input resets to default), and a commit writes
  `keybindings.json` and applies live — no `/reload` needed.
- **App-owned canvas background** — every rendered row is painted with the
  palette's canvas color (via a pi-tui `TuiAltScreen` patch), so a theme
  switch recolors the whole screen including the background — the fix for the
  frozen-background look inside multiplexers like cmux/gostty where the pane
  background belongs to the terminal. `DSH_TUI_TRANSPARENT=1` reverts to the
  see-through canvas.
- **Terminal-following auto theme** — `auto` refines its startup guess by
  querying the terminal itself (CSI `?996n` color-scheme, then OSC 11
  background) and follows live light/dark switches via CSI 997 push
  notifications while `auto` stays selected; an explicit light/dark pin opts
  out.

### Changed

- **Keyboard handling aligned with pi**: `Esc` stops the running task only as
  a deliberate double-press (a popup open always closes itself first; a
  non-empty editor does nothing), `Ctrl+C` cancels on first press and quits on
  a second within 500 ms, `Ctrl+D` quits only on an empty editor, `Ctrl+L`
  opens the model picker, `Ctrl+G` opens the subagent viewer. Held-key
  auto-repeat never quits/stops — an 80 ms repeat floor plus a 200 ms confirm
  window guard both.
- **`/model` think stage defaults the picker to the model's current effort**.
- **Test suite** grew from 185 to **277 unit tests** across 21 files, with new
  suites for the subagent viewer, the subagent policy, the select-panel
  framework (`panels.ts`), keymap, hotkeys, and the canvas theme.
- `pnpm check` (tsc) stays at 0 errors.

### Fixed

- **Subagent picker rounds shown incorrectly**: the picker used to snapshot
  its rows once at open and never re-read turn counts, so a running child's
  `rounds N/M` froze while the transcript panel live-updated — the two levels
  were asymmetric. The picker now rebuilds its rows on the same 300 ms tick.
- **/reload input deadlock** (0.1.1-era regression, shipped in 0.2.0):
  awaiting the old fiber's teardown before re-applying the plugin so the new
  terminal never loses raw mode / stdin.
- A `pnpm install` now regenerates the three type-check symlinks
  (`dsh-settings`, `dsh-client-schema-form`, `schemastery`) into local `.pnpm`
  copies, splitting the cordis module identity and breaking `pnpm check` — the
  README documents the re-link command.

## [0.1.1] — 2026-08-16

### Added

- Popup frames (`FramedOverlay`) on every overlay: shared top/bottom border.
- Redesigned "paper feel" palettes (GitHub light/dark, WCAG AA) and live
  theme hot-switching (`applies: 'live'`, external-edit watch, `DSH_TUI_THEME`
  pinning).
- Live Todos widget + running-subagent activity blocks.
- Provider-first Models settings with the add-provider flow (mirrors the web
  Models page, live provider directory).
- `/model` think-stage defaulted to the model's current effort.

### Changed

- `/settings` categories aligned with the web settings page; UI text is
  English-only with CJK-safe width clipping.

## [0.1.0] — 2026-08-15

Initial release.

### Added

- pi-style terminal UI for DeepSeek Harness: alt-screen scrollable transcript,
  docked status/editor/footer, markdown messages, slash-command autocomplete.
- GitHub light/dark themes aligned with `cmux-theme.sh`.
- Powerline footer (provider / model+thinking / context / cache-hit / msgs /
  tools), cwd+git-branch editor top border, last-request widget.
- Commands: `/model /think /session /resume /new /settings /export /permission
  /theme /reload`.
- Boxed think/tool panels with height config (`dsh-tui.panelHeight`).
- `APPEND_SYSTEM.md` convention support (`~/.dsh/APPEND_SYSTEM.md`) with
  idempotent `dsh-tui-pi:todo-lifecycle` section maintenance.
- Event-driven incremental state with O(1) render — no render-time session-log
  re-scan.

[0.3.0]: https://github.com/fan56/dsh-tui-pi/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/fan56/dsh-tui-pi/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/fan56/dsh-tui-pi/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/fan56/dsh-tui-pi/releases/tag/v0.1.0
