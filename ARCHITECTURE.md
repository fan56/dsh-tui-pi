# dsh-tui-pi — architecture

Design document for the dsh-tui-pi plugin. For working conventions see
[AGENTS.md](AGENTS.md); for usage see [README.md](README.md).

## 1. Process model

dsh-tui-pi is a **cordis plugin running in-process inside dsh**. It is mounted
as a profile bundle (`cordis.patch.yml` → `dsh.profile.bundles`), its `apply`
runs on a plugin fiber of the dsh runtime tree, and it renders with
`@earendil-works/pi-tui` 0.84.2 directly against the terminal
(`ProcessTerminal` + `TuiAltScreen`). There is no separate process and no RPC
between the TUI and dsh:

```
┌─ dsh process ─────────────────────────────────────────────┐
│  cordis root fiber                                         │
│    ├─ dsh-base … (agents, commands, settings, llm, …)      │
│    └─ tui-pi fiber (this plugin)                           │
│         ├─ index.ts apply() → runTui()                     │
│         │    ├─ pi-tui component tree (terminal)           │
│         │    └─ DshSessionBridge → ctx.agents / ctx.on(…)  │
│         └─ ctx.* service calls (direct, in-process)        │
└────────────────────────────────────────────────────────────┘
```

Contrast with the web client: web bundles (dsh-base + dsh-web-app) talk to
the same host services over **client-RPC** (`dsh-host-apiproxy`); the TUI
talks to them **directly through `ctx.get(...)` and `ctx.on(...)`**. Both
share the LLM layer — the same `llm-deepseek` and `llm-pi-ai` packages are
mounted in-process for TUI and web — so providers configured in the web
Models page are the same rows the TUI's Models category shows, and both write
the same `~/.dsh/settings.yaml`.

The plugin owns the terminal for its lifetime: teardown order is
`bridge.dispose() → ui.dispose() → ctx.root.fiber.dispose() → process.exit()`
(see §7), and on the fiber disposer the TUI is stopped *before* the agent
teardown so a hot reload can never start a fresh TUI while the old one still
holds the terminal.

## 2. Layers

```
entry / wiring   index.ts          command registration, footer/git/clock,
                                   applyThemeRef sink, submit routing, shutdown
  └─ UI shell    tui.ts            alt-screen tree, ScrollView, dock, focus,
                 editor.ts         editor rebuild on theme swap
                 footer.ts         powerline segments (O(segments) render)
  └─ renderer    messages.ts       session events → components, ReplayOp buffer
                                   (chat-clean: think/tool/todo render in the
                                   live widgets, never as transcript blocks)
  └─ widgets     activity.ts       ThinkPanel/ToolPanel — the fixed think/tool
                                   status panels above the chat input (one of
                                   each per run, refreshed in place, hidden
                                   while empty; '1'/'5'/'7'/'10'/'all' heights)
                 live-widgets.ts   the pinned live surfaces — Todos + think +
                                   tool panels above the chat window, the
                                   last-request line + running-agent lines
                                   below (applyEvent/renderTodos/renderAgents/
                                   tickLive/setTheme)
  └─ bridge      session.ts        lazy session, O(1) stats, cancel, resume,
                                   replay, persistDefaultModel, subagent tracker
                                   (child chunks fold a bounded content tail)
                 dsh-events.ts     local types/guards for tool-workflow,
                                   subagent/descriptor, llm/retry events
                                   (declaring packages not installed) + AgentView
  └─ commands    commands.ts       parse + dual-channel dispatch + autocomplete
  └─ overlays    selectors.ts      /model /think /theme pickers
                 sessions.ts       /session panel, /resume picker
                 settings.ts       settings browser + add-provider flow
                 frame.ts          FramedOverlay (popup borders)
  └─ theme       theme/palette.ts  GitHub light/dark palettes + detection
                 theme/index.ts    buildTheme roles, resolveTheme, POWERLINE
                 theme-settings.ts dsh-tui namespace (applies: 'live') + watch
                 text.ts           clipToWidth / visibleWidth
```

### UI shell (tui.ts / editor.ts / footer.ts)

Fixed alt-screen layout: a `ScrollView` over the transcript container
(`basis 0 / grow 1`), below it a `VStack` dock (`basis auto / grow 0`) with
status container, `CwdBorderEditor`, last-request widget and footer container.
The editor's top border row is rewritten in `render()` to show
`📁 cwd │ ⎇ branch` in the muted info color (border color is near-invisible on
light themes). `GitBranchWatcher` polls `git rev-parse` every 5 s off the
render path (unref'd timer); the footer and editor only read its cached value.

The dock is rebuilt in place on a theme swap: the editor is recreated with the
new bundle's baked colors, preserving the input buffer, submit handler,
autocomplete provider and branch provider. Focus moves to the replacement only
if the editor held focus — an open overlay keeps focus and its own close path
re-focuses the new editor.

### Renderer (messages.ts)

`TranscriptRenderer` turns `session/event` deliveries into components. Every
event does O(event) work:

- `user/message` — bubble (`▎ ` prefix, `canvasSubtle` bg); the local prompt
  echo rendered on submit is deduped via `lastEcho` (trimmed text match).
- `assistant/chunk` — `text-delta` appends to one streaming `Text`
  (`setText`, never rebuild); `reasoning-delta` renders nothing here — the
  fixed ThinkPanel consumes it (see below).
- `assistant/message` — the streaming component is finalized (removed), the
  message renders as `Markdown` once (no per-token parsing); `reasoning`
  blocks render nothing here (the ThinkPanel already showed the burst live).
- `tool/call` / `tool/result` — render nothing here: the fixed ToolPanel
  above the chat input tracks the current tool (see below).
- `todo/write` — routed to the fixed live widget (see below), never rendered
  in the transcript.
- `turn/end` — error / `⏹ interrupted` / `⚠ output token limit reached` line.
- `command/run` / `command/done` — flow nodes, no render (the command echo
  path covers display).

The transcript is chat-clean by design: user bubbles, assistant text,
notices and echoes only. Think/tool/todo activity lives in the fixed live
widgets above the chat input — one panel of each kind for the whole run,
refreshed in place, never transcript blocks.

Every applied operation is appended to a `ReplayOp` buffer (O(1) per event,
never scanned by the render path). `setTheme` — an explicit user action — is
the single reader: it clears the doc and replays the buffer against the new
theme, so streaming state, echoes and notices rebuild exactly as applied and
an in-flight stream continues `setText` on its rebuilt component. The
startup welcome banner (whale pixel art, plus the `DSH TUI` wordmark in a
pixel font: classic Adafruit GFX 5×7 bitmap font glyphs
(glcdfont.c, public domain) rendered at the whale's own 28 columns × 10
rows tall (4-column strokes, 2-row horizontal bars), spaced 2 columns
apart into an 88-column letter block, so the 118-column banner is whale
(28) + 2-column gap + D (28) + 2 + S (28) + 2 + H (28); below 120 terminal
columns it degrades to the whale alone) in `welcome.ts` is the first replay
op; its art is reproducible from `assets/whale-source.png` via
`node assets/whale-gen.mjs` (test-enforced). The whale also prefixes the
assistant's first text block inline (`🐳: text`) instead of taking its own
avatar line, and the daily quote caption is whale-prefixed too (`🐳 「…」`).

### Fixed activity panels (activity.ts)

`ThinkPanel` and `ToolPanel` are the single fixed status surfaces for
think/tool activity, mounted once in the widgets dock (above the chat input,
like the Todos panel). One instance of each exists for the whole run:
`LiveWidgets.applyEvent` (index.ts routes every parent-session event, replay
included) drives the phase machine —

- a `reasoning-delta` opens/feeds the ThinkPanel (elapsed from the burst's
  first delta); the newest non-blank line is the live content;
- a `tool/call` refreshes the ToolPanel pending (icon + name + subject +
  args tail); a matching `tool/result` settles it (✔/✘, frozen time, result
  tail); results for other callIds (parallel calls) are ignored. Delegation
  spawn tools (`use_agent`/`subagent`/`workflow`/`ralph` — the `SPAWN_TOOLS`
  family) never open a tool block: their children render in the running-agent
  lines below the editor, and a delegation call clears any stale settled tool
  panel;
- a text delta, an assembled `assistant/message`, a user message or a
  `turn/end` hides the finished phases — no content, zero rows.

Panels are self-drawing Components (`render(width)` per frame, no cached
rows — the TodosPanel pattern): a terminal resize re-lays the box out
automatically and a theme hot-switch is just a repaint. Heights come from
`dsh-tui.panelHeight` (`'1'` default: ONE borderless row — block identifier
+ elapsed + last content line, right-truncated at the terminal width, never
wrapped; `'5'/'7'/'10'`: boxed header + content rows, borders add two more;
`'all'`: full body with caps — a streaming reasoning panel boxes only a
200-line live tail while chunks are in flight, a settled tool result keeps
at most 2000 lines with a `… (+N lines)` marker). Every body row is clipped
to one physical line (`clipRow` — plain text before ANSI) at the CURRENT
render width, so no row ever wraps.

### Live widgets (live-widgets.ts)

`LiveWidgets` owns the pinned live surfaces across three fixed containers
(the widgets dock above the input plus the lastRequest area below it; both
`basis: auto / grow: 0` slots that never scroll with the transcript):

- **Todos** — a single **bordered panel** (top border + header row + body rows +
  bottom border, `borderDefault`) in the widgets dock, directly above the
  think/tool status panels. Show-when-content, clear-when-done.
- **Think/Tool activity** — the fixed `ThinkPanel`/`ToolPanel` (activity.ts,
  see above), mounted once in the same dock; `applyEvent` drives their phase
  machine, `setPanelHeight` re-budgets them live.
- **Running-agent activity** — merged into the **last-request area below the
  editor** (`ui.lastRequest`, tui.ts): the ` ● <last request>` line followed
  by one **compact line per running agent** — `├─ `/`└─ `-prefixed (tree
  connectors aligned with the todo rows), spinner + agent NAME, `↻retries≤max`,
  compact `X/Y` (the CURRENT context-occupancy estimate — the child's latest
  request's billed input+output plus a CJK estimate of messages after it, over
  its context window; NOT the cumulative `tokens` spend, which only grows and
  stays the viewer's/session-panel's number), `round N/M`, elapsed, and the
  child's latest **content**
  line (` · <tail>`): the live-refreshed last line of its streamed assistant
  text/reasoning — never a tool name. The tail takes everything the row has
  left and is truncated at the right edge; each line is clipped (prefix
  included) to the terminal width BEFORE any ANSI. The ↳ line persists while
  agents come and go; a settled child drops off immediately.

- `renderTodos(todos)` — `todo/write` events (routed from index.ts's
  `onEvent`, since the transcript no longer renders them): a boxed `● Todos
  (done/total)` header with `├─`/`└─` tree lines and `☐`/`◐`/`☑` status
  icons. An empty snapshot (or `/new`) hides the panel — and so does an
  **all-completed** list (the model writes the whole-list snapshot and rarely
  clears it; all-done is the end-of-work signal).
- `renderAgents(agents)` — the bridge's `onLive` fold: one compact line per
  **running** child (see above). When none run the agent lines vanish and the
  slot collapses to just the ● line (or zero rows when that too is cleared).
- `setLastRequest(text)` — renders the ` ● ` line (`fgMuted`) in the activity
  area, clipped to the terminal width (`columns - 5`, fallback 195 outside a
  TTY) so it always renders on one row and never wraps; `undefined` removes
  it.
- `tickLive()` — `AGENT_TICK_MS` (100 ms) timer in index.ts advances the
  spinner and re-reads the elapsed clocks; no-op while nothing runs and no
  panel is visible.
- `setTheme(bundle)` — recolors the Todos panel, the think/tool panels, the
  ● line and the agent lines in place on a theme hot-switch (the widgets are
  live state, not transcript history — no ReplayOp involvement).
- `clear()` (`/new`) — drops the Todos panel, hides the think/tool panels
  and the agent lines but **keeps** the ● last-request line.

Width discipline matches the panels: box lines are clipped before styling to
the boxed row's inner budget (`panelBoxWidth(columns) − 4`); each compact agent
line is clipped (`  ↳ ` prefix included) to the terminal width before any ANSI,
with the agent NAMES split from a shared budget measured against that width,
so no line ever wraps.

**Model-side guidance** (append-system.ts): the TUI supports pi's
`APPEND_SYSTEM.md` convention (dsh side: `~/.dsh/APPEND_SYSTEM.md`,
`$DSH_HOME` or `~/.dsh`) — a user-editable file appended to the system
prompt of every agent the TUI creates. The file is a **runtime user
artifact**: at install time the TUI seeds a fresh file from the shipped
English template `templates/APPEND_SYSTEM.md` (the pi orchestrator-identity
definition, translated — content lives in the FILE, not in code) plus the
TUI's marked todo-lifecycle section; an existing file is user-owned and
never overwritten. A system-prompt section registered in the plugin's
scope (`dsh-tui-pi:append-system`, order 200) uses a text **provider** that
reads the file at each assembly (`readAppendSystem`), so edits apply to the
next request with no restart and no watcher; an empty file contributes
nothing (empty sections are dropped by the renderer).
Because `todo/write` is a whole-list snapshot and models rarely clear it,
the TUI's own `dsh-tui-pi:todo-lifecycle` guidance lives in the same file:
`ensureTodoLifecycleInstructions` is idempotent (marker
`<!-- dsh-tui-pi:todo-lifecycle -->`), atomic (tmp + rename) and
best-effort; `migrateAgentsMdTodoSection` removes the section's earlier
incarnation from `~/.dsh/AGENTS.md` so the guidance is not delivered twice.
The panel-side all-completed hide remains the fallback when the model
ignores the convention.

### Bridge (session.ts)

`DshSessionBridge` is the only session-facing component:

- **Lazy creation**: `ensureSession()` creates the agent on first use
  (`agents.create({ sessionId, meta: { cwd }, agentOptions, setup })`), with
  an in-flight guard and a resume-aware wait (a prompt mid-resume awaits the
  resume instead of racing a second creation).
- **Selection**: a mutable `ModelSelectionRef` is installed into the agent
  (`installModelSelection`), so `/model` / `/think` switch the route live.
  `seedSelectionFromDefault()` reads `agentDefaultModel.currentSelection()`
  without clobbering a live pre-prompt choice.
- **Stats**: `session/event` and `agent/status` subscriptions (filtered to
  the bridge's session id) maintain running counters; the footer reads
  `getStats()` O(1).
- **Subagents**: the same `session/event` firehose is not scope-filtered
  (dsh-scope's `session/event` resolver is null), so child sessions arrive
  too. Children are keyed by session id and discovered two ways:
  `tool-workflow/agent-start` on a tracked session's log (registers the child
  with its workflow label) or — the primary path, since some deployments
  never emit workflow events — the child session's **header**
  (`parentSession` matching a tracked session + the durable `delegationDepth`
  budget; `origin: 'subagent'` is NOT required — fork-driven children carry
  the budget without the origin, while user-facing `Session.fork`
  conversations never set it and stay off the board);
  delegation nests. Each child's own events fold into an O(1) `AgentView`:
  `subagent/descriptor` (provider + label), `assistant/message` usage — the
  cumulative `tokens` spend AND the `contextTokens` current-occupancy estimate
  (the latest request's billed input + output + a CJK estimate of messages
  after it, priced by the ported `src/tokens.ts`) — and round counting (the
  "rounds" = one per `assistant/message`,
  i.e. per LLM round-trip — the unit the `maxRounds` policy caps and the
  compact line shows), `llm/retry` (retries/max), `tool/call` (last
  activity), `request/context` (context window), and `turn/end` (best-effort
  settle — the board's clear-when-done; `turn/start` re-marks a resumed
  child running). `turn/end` is NOT the round unit: a one-shot child never
  leaves its single turn, so turns would never progress while it works.
  `tool-workflow/agent-end` pairs through `runId:seq` for the real outcome.
  `onLive` pushes the sorted snapshot (by `startedAt`) to the widget.
  `replay()` folds the same parent-log workflow events so a resumed session
  rebuilds the board. The tracker clears on dispose/detach/resume — each
  firing `onLive([])` — so the widget drops stale rows before the next
  session's events rebuild it.
- **Cancel**: `cancelActiveTurn()` → `agent.cancel({ kind: 'user' },
  { keepInbox: true })` — the web stop-button equivalent; `isRunning()` is a
  mirror of the status subscription.
- **Detach** (`/new`): disposes the agent handle and zeroes stats but keeps
  the event subscriptions, so the next prompt renders into a fresh session.
- **Resume** (`/resume`): `agents.resume({ resumeSessionId, agentOptions,
  setup })`, serialized in-flight; the caller replays `events.filter(e =>
  e.seq < firstLiveSeq)` — live events arrive again through the subscription,
  replay would double-count; `assistant/chunk` is skipped in replay.
- **Persist**: `persistDefaultModel()` prefers
  `agentDefaultModel.saveSelection` (a `settings.replace`, last-write-wins);
  falls back to `settings.mutate` with one `SettingsConflictError` retry.

## 3. Command dual channel

dsh's command registry stays the single source of truth: autocomplete lists
`ctx.commands.list(agent)`, submission routes through
`ctx.commands.execute(agent, line, signal)`, and unknown commands fall through
to the model as ordinary prompts. TUI-owned commands (the 9 surface commands)
register **both** channels:

```
registerLocal(name, handler)  → CommandService.local map
                                dispatch when bridge.getAgent() === undefined
                                (no throwaway session for agentless commands)
ctx.effect(register(...))     → host registry: discovery, and the
                                lifecycle path once an agent exists
```

`tryExecute(line, signal)` parses, prefers the local handler when agentless,
otherwise warms the session and asks the host. `/export` is the inverted
case: its local registration only exists to *refuse* politely when no agent
exists (the host command would mint a session just to report nothing to
export). Modal commands (`settings model think session resume theme`) run
with a never-aborting signal — a 30 s timeout would fire mid-browse; the
rest use `AbortSignal.timeout(30_000)`.

## 4. Overlay system

Every popup goes through `tui.showOverlay(component, { width, maxHeight })`,
wrapped by `FramedOverlay` (src/frame.ts): one full-width `─` line above and
below the content (each with a blank spacer row), colored
`palette.borderDefault` — 4 extra rows total. The frame wraps the overlay
root, so a SettingsList **submenu inherits the border automatically**: the
submenu swaps the list's own render while the frame keeps both border rows in
place. All 6 `showOverlay` call sites are wrapped:

| Site | Component | width / maxHeight |
|---|---|---|
| selectors.ts `openEffortPicker` | SelectList (effort) | 80% / 75% |
| selectors.ts `pickTheme` | SelectList (theme) | 80% / 75% |
| selectors.ts `pickModel` (stage 1) | SelectList (models) | 80% / 75% |
| sessions.ts `showSessionInfo` | SessionInfoPanel | 70% / 100% |
| sessions.ts `pickPersistedSession` | SelectList (sessions) | 80% / 75% |
| settings.ts `SettingsBrowser.open` | SettingsList (categories) | 80% / 80% |

maxHeights are tuned so the bottom border survives on a 24-row terminal
(13 list rows + 4 frame rows ≤ 18 at 75%; ~15 + 4 ≤ 19 at 80%; 19 + 4 at 100%).

**Focus contract**: every overlay resolves through `restoreFocus`, which
re-focuses the *current* editor instance — critical because the editor is
rebuilt under a theme hot-swap, and pi-tui's overlay hide would restore focus
to the stale pre-overlay editor and swallow input. The two-stage model picker
shows stage 2 *before* hiding stage 1 (the new overlay owns focus first — no
focus flash); Esc on stage 2 abandons the whole pick; the stage-1 input
handlers are detached on first settle to prevent ghost settles.

The settings browser is the deepest overlay: category level (static
`CATEGORY_MAP` mirroring the web client's settings sections, English labels
doubling as search keywords), namespace level, then a schema walk dispatched
on node type (cycle rows, inline Input editors — secrets masked by
`EditField.maskLine`, dict add-key, reset-with-confirmation, read-only JSON
viewer). Writes serialize on a promise chain and go through
`settings.mutate(ns, pathOps, revision)`; every committed write re-reads the
descriptor (the service's resolved value is the single source of truth) and
failed writes revert the on-screen row. The Models category swaps in a
freshly built list on structural change (a new provider row cannot be
expressed with `updateValue`).

## 5. Theme system

```
palette.ts        githubLight / githubDark Palette (19 roles each) + detectDarkPalette + rgbIsLight
theme/index.ts    buildTheme(palette) → TuiTheme { palette, editor, markdown,
                  selectList, chat } + POWERLINE (theme-agnostic) + resolveTheme
theme-settings.ts dsh-tui namespace { theme: 'auto'|'light'|'dark' } applies: 'live'
                  + watch sink + read/write preference
text.ts           clipToWidth / visibleWidth — every width decision
```

**Palette roles** (`Palette`): `canvas` (the app-owned background, painted on
every rendered row — patched pi-tui `setCanvasBackground`; see below),
`canvasSubtle` (raised surface:
bubbles, panels, overlays, code), `canvasInset` (editor border row, footer),
`fgDefault/Muted/Subtle`, `borderDefault/Muted`, `accent` +
`accentMuted`, `success/+Muted`, `danger/+Muted`, `attention/+Muted`,
`thinking`. The 2026-08 redesign ("paper feel"): light = near-white canvas
`#fcfdfc` with a faint cool-green cast, gray-green surfaces `#eef3ee` /
`#e5ebe5`, graphite-green body text, steel-blue accent `#0a60b5`, and
low-saturation families (green success `#1e843b`, violet thinking `#7b4fae`,
soft amber attention `#9a6700`, rose danger `#b64550`); dark keeps the
`#0d1117` family with muted fills as solid 25%-tint blends over canvas
(`blend()`, the terminal can't carry alpha). All role contrasts meet WCAG AA
on their surface (28/28 checks in the review).

**Assembly**: `buildTheme` maps the palette onto pi-tui's `EditorTheme` /
`MarkdownTheme` / `SelectListTheme` plus our own `ChatTheme` roles
(user bubble, tool-card backgrounds, thinking panel, todos). `SelectListTheme`
paints the `canvasSubtle` backdrop on selected rows / descriptions / scroll
info / no-match — unselected values stay raw (pi-tui 0.84.2, accepted).
`POWERLINE` segment colors are theme-agnostic (vivid backgrounds with white
bold text on both themes).

**Canvas background** (`patches/@earendil-works__pi-tui.patch`): pi-tui rows
are written with erase-line + content, so the terminal's default background
shows through every unpainted row — a theme switch used to leave the dominant
background frozen (most visible inside multiplexers like cmux/gostty, where
the pane background belongs to the terminal). `TuiAltScreen` gained
`setCanvasBackground(sgr)`: `doRender` runs every non-image row through
`paintCanvasRow` — prefix the canvas SGR, re-inject it after every
background-clearing SGR (reset / 49), pad to the full width so the
erase-line remainder carries the color, trailing reset. `startTui` sets the
canvas at startup and under `applyTheme`; `DSH_TUI_TRANSPARENT=1` keeps the
old see-through behavior.

**Resolution order** (`resolveTheme`): `DSH_TUI_THEME=light|dark` **env
pins** the bundle → explicit preference (light/dark) → `detectDarkPalette`
(COLORFGBG bg ∈ {7,15} → light, else dark). With `auto`, the TUI then asks
the terminal itself (index.ts): `queryTerminalColorScheme` (CSI `?996n`),
falling back to `queryTerminalBackgroundColor` (OSC 11 → `rgbIsLight`
luminance), and hot-applies the answer if it differs from the startup guess.
While the preference stays `auto`, `setTerminalColorSchemeNotifications`
enables CSI 997 pushes and `onTerminalColorSchemeChange` repaints on live
terminal light/dark switches; an explicit pin disables the subscription.

**Hot-switch**: the bundle is held in `themeRef` (tui.ts) — a mutable binding
every read goes through. Commits flow:

```
/theme picker or /settings edit or external settings.yaml edit
  → settings.mutate (dsh-tui ns, applies: 'live')
  → scope.watch → applyThemeRef (index.ts)
  → applyTheme(bundle):
      renderer.setTheme(bundle)   ReplayOp buffer replay (transcript rebuild)
      ui.applyTheme(bundle)       themeRef swap + editor rebuild (focus-safe)
      paintFooterHint()           re-colored hint line
      loader rebuild              spinner with the new accent
  → one nextTick-throttled render frame (per-piece requestRenders coalesce)
```

Theme modules are singletons, so a self-echoed write (the watch delivers the
TUI's own `/theme` commit too) is a no-op by bundle identity. Startup reads
await the settings namespace registration (bounded, 2 s cap; settings-less
deployments degrade to `auto`). `DSH_TUI_THEME` keeps winning after a pick:
`/theme` persists the preference but reports the display is pinned. An
overlay open at switch time keeps the bundle it was built with until closed
(known limitation).

## 6. Data flow: submit → screen

```
editor Enter
  → index.ts submit(text)
      → liveWidgets.setLastRequest(line)
      → CommandService.tryExecute(line, signal)
          ├─ parseCommand fails → { handled: false }
          ├─ agentless + local handler → local dispatch → renderCommandEcho
          ├─ host path → bridge.ensureAgent() → commands.execute(agent, line)
          │     └─ unknown command name → { handled: false } (falls through)
          └─ { handled: false } → renderer.renderPromptEcho(line) (lastEcho set)
              → bridge.prompt(text)
                  → ensureSession() (lazy agents.create / await in-flight resume)
                  → agent.followup(createUserMessage({...}))
                      → dsh agent loop (provider/model from the live selection)
                          → session/event published in-process
                              → bridge.onEvent (stats, filtered by session id)
                              → renderer.applyEvent → components
                                  → tui.requestRender() (throttled frame)
```

Echo dedupe: the local prompt echo renders immediately; the session's
`user/message` echo is suppressed while `lastEcho` matches. Errors anywhere
in the submit path surface as buffered notices (replay ops), so a theme
switch never erases the only record of a failure.

## 7. Lifecycle & shutdown

- Graded Ctrl+C: mid-turn first press cancels the turn
  (`⏹ canceling current turn…` notice + `bridge.cancelActiveTurn()`);
  anything further — or any press while idle — quits. A cancel race to idle
  quits too.
- `disposeAndExit` runs once (`exitTask`): stop the clock, dispose git
  watcher, `bridge.dispose()`, `ui.dispose()`, `ctx.root.fiber.dispose()`,
  `process.exit(code)`.
- Fiber disposer (reload/HMR path): `handle.dispose()` (tui.stop) runs
  **before** `await bridge.dispose()` — a fire-and-forget swap must never
  leave the old TUI holding the terminal after the new one starts (input
  deadlock, see HANDOFF row L+).
- `/reload` (reload.ts): evicts the entry + user-code dependency closure from
  ESM loadCache and CJS require.cache (Map.prototype methods bypass Node 24+'s
  typed LoadCache), re-imports the entry, swaps the runtime
  (`registry.delete` then `setImmediate` + `fiber.await()` for the real
  teardown), re-registers the fresh plugin; failures roll back caches and
  restart the previous code. Re-entrancy-guarded. After a reload the TUI
  auto-resumes the previously current session: the old fiber stashes its
  session id on `globalThis` (process-global, so it survives the module-cache
  eviction) before teardown, and the fresh fiber consumes it best-effort; a
  fresh dsh process start resets the stash, so it still creates a new session.

## 8. LLM layer

Two mounted llm packages (shared with the web client, id spaces disjoint):

- **llm-deepseek** — official direct connection: single provider
  `deepseek-official` (api.deepseek.com), static 2 models, `thinking:
  disabled` (exposes only `Off` efforts).
- **llm-pi-ai** — the pi-ai adapter (`@earendil-works/pi-ai`): built-in
  catalog of ~37 providers (opencode, minimax, anthropic, openai, …), plus the
  `llm-pi-ai.providers` dict for custom routes (provider/model override
  mappings). Zero routes = dormant package. A hand-written provider with an
  id that collides with the built-in catalog fails with DUPLICATE_ADAPTER.

The TUI consumes the union through the `llm` service:
`listProviders()` / `listModels(id)` (the `/model` picker),
`resolveModelInfo(p, m)` (efforts for `/think`, context window for the
footer), `resolveCallConfig()` (live-switch validation).

**providers dict** (`llm-pi-ai.providers.<id>`) is the routing surface the
web Models page and the TUI's add-provider flow both write. Each entry
carries `apiKeyEnv` — the credential reference, derived by **convention**
(`deriveKeyRef`: route key uppercased, non-alphanumeric runs → `_`, `_API_KEY`
suffix; `opencode-go → OPENCODE_GO_API_KEY`). The add-provider picker
(`src/provider-catalog.ts`) mirrors the web Models directory: the static
`PROVIDER_CATALOG` lists all 36 llm-pi-ai catalog routes that take an API key
(pi-ai 0.82.1) as the fallback, but at runtime `addProviderEntries`
(settings.ts) prefers the live `llm.listConfigurableProviders()` directory
(→ `directoryProviderEntries`) so the TUI stays in lockstep with pi-ai; the
static mirror supplies friendly names/hints and degrades gracefully when the
service is missing. API-key resolution for the status column is a three-way
merge (`mergedEnv` in settings.ts): `process.env`, refs stored this browser
session (`justStoredRefs`), and prefetched `ctx.credentials.describe(ref).configured`
for the credentials document (`.credentials.yaml`) — keys stored by web never
live in `process.env`. The key itself goes to `ctx.credentials.set`, never to
settings.yaml.

**Default model composition**: `agent-default-model` holds
`provider / model / reasoningEffort`. The bridge seeds the live selection
from `agentDefaultModel.currentSelection()` (eagerly at construction so the
footer shows a route from the first frame); `/model` and `/think` update the
mutable ref live and persist through `persistDefaultModel`. The TUI is the
only writer of `agent-default-model` (settings.replace, last-write-wins).

## 9. Iron rules (checklist)

1. Render never re-scans — O(1) maintained values only.
2. Streaming = `setText` on the existing component; markdown once per message.
3. `clipToWidth` everywhere; clip before styling; no bare `String.length`.
4. UI text English-only; CJK/emoji content width-safe.
5. NodeNext + verbatimModuleSyntax + erasableSyntaxOnly: `.ts` import
   extensions, `import type`, no parameter properties, no enums/namespaces.
6. Comments in English.
7. dsh commands are never re-implemented; TUI commands use both channels.
8. Overlay close always returns focus to the current editor; two-stage
   pickers show-then-hide; stage-2 Esc cancels all.
9. Resume replays only `seq < firstLiveSeq`, skipping `assistant/chunk`.
10. `descriptor.value` is the resolved object, not a yaml fragment.
11. The settings service mounts asynchronously — wait bounded, degrade.
12. `~/.dsh/settings.yaml` / `.credentials.yaml` are live config: mutate with
    revision, last-write-wins, backup/restore in tests and e2e.
