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
  └─ bridge      session.ts        lazy session, O(1) stats, cancel, resume,
                                   replay, persistDefaultModel, subagent tracker
                 dsh-events.ts     local types/guards for tool-workflow,
                                   subagent/descriptor, llm/retry events
                                   (declaring packages not installed) + AgentView
  └─ widgets     live-widgets.ts   fixed Todos/Agents widgets pinned above the
                                   chat window (renderTodos/renderAgents/
                                   tickLive/setTheme)
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
  (`setText`, never rebuild); `reasoning-delta` updates the thinking panel's
  body rows in place (in 'all' mode the live body is a bounded tail, see
  below).
- `assistant/message` — the streaming component is finalized (removed), the
  message renders as `Markdown` once (no per-token parsing); a `reasoning`
  block renders through the same height-configurable panel (full body).
- `tool/call` / `tool/result` — a height-configurable card (status-colored
  header `⚙/✔/✘ name`, body tail) keyed by `callId`; settled results keep at
  most the body budget — or 2000 lines in 'all' mode, with a `… (+N lines)`
  marker for the drop.
- `todo/write` — routed to the fixed live widget (see below), never rendered
  in the transcript.
- `turn/end` — error / `⏹ interrupted` / `⚠ output token limit reached` line.
- `command/run` / `command/done` — flow nodes, no render (the command echo
  path covers display).

Every applied operation is appended to a `ReplayOp` buffer (O(1) per event,
never scanned by the render path). `setTheme` — an explicit user action — is
the single reader: it clears the doc and replays the buffer against the new
theme, so streaming state, tool cards, echoes and notices rebuild
exactly as applied and an in-flight stream continues `setText` on its rebuilt
component. Panels are height-configurable through `dsh-tui.panelHeight`
(`'5'/'7'/'10'` total rows — top border + header row + body rows + bottom
border — or `'all'` for the full body) with a padded tail (`panelBodyText`,
pad rows carry the box characters `│ … │` so Text's empty-row fast path
doesn't drop them); rows are clipped to one physical line with
`clipPanelLine` (columns − 4, fallback 200) **before** styling. In 'all'
mode a streaming reasoning panel boxes only the last 200 lines while chunks
are in flight (per-chunk cost stays O(200) instead of O(accumulated)); the
assembled `assistant/message` block and the replay rebuilds render the full
body. The startup welcome banner (whale pixel art, plus the `DSH TUI`
wordmark in a pixel font: classic Adafruit GFX 5×7 bitmap font glyphs
(glcdfont.c, public domain) rendered at the whale's own 28 columns × 10
rows tall (4-column strokes, 2-row horizontal bars), spaced 2 columns
apart into an 88-column letter block, so the 118-column banner is whale
(28) + 2-column gap + D (28) + 2 + S (28) + 2 + H (28); below 120
terminal columns it
degrades to
the whale alone) in `welcome.ts` is the first replay op; its art is
reproducible from `assets/whale-source.png` via `node assets/whale-gen.mjs`
(test-enforced). The whale also prefixes the assistant's first text block
inline (`🐳: text`) instead of taking its own avatar line.

### Live widgets (live-widgets.ts)

`LiveWidgets` renders two **bordered panels** — the Todos tree and the Agents
board — into a fixed container **pinned above the chat input** (`ui.widgets`,
a `basis: auto / grow: 0` slot in the dock VStack directly above the editor,
tui.ts); they never scroll with the transcript. Each panel is a box (top
border + header row + body rows + bottom border, the same chrome as the
thinking/tool panels, `borderDefault`). Show-when-content, clear-when-done:

- `renderTodos(todos)` — `todo/write` events (routed from index.ts's
  `onEvent`, since the transcript no longer renders them): a boxed `● Todos
  (done/total)` header with `├─`/`└─` tree lines and `☐`/`◐`/`☑` status
  icons. An empty snapshot (or `/new`) hides the panel — and so does an
  **all-completed** list (the model writes the whole-list snapshot and rarely
  clears it; all-done is the end-of-work signal).
- `renderAgents(agents)` — the bridge's `onLive` fold: a boxed `● Agents`
  panel with one line per **running** child (spinner, provider + label,
  `↻retries≤max`, total tokens + context percent, elapsed, activity
  `⎿ running {tool}…`). A settled child drops off the board immediately; when
  none run the panel — and the whole slot when todos are gone too — collapses
  to zero rows.
- `tickLive()` — `AGENT_TICK_MS` (100 ms) timer in index.ts advances the
  spinner and re-reads the elapsed clock; no-op while nothing runs.
- `setTheme(bundle)` — recolors in place on a theme hot-switch (the widget is
  live state, not transcript history — no ReplayOp involvement).

Width discipline matches the panels: every line is clipped before styling to
the boxed row's inner budget (`panelBoxWidth(columns) − 4`); the todo content
gets the tree-chrome headroom, and the agent name (provider + label) is split
from a shared budget measured against the actual chrome width, so no row ever
wraps inside the box.

**Model-side guidance** (append-system.ts): the TUI supports pi's
`APPEND_SYSTEM.md` convention (dsh side: `~/.dsh/APPEND_SYSTEM.md`,
`$DSH_HOME` or `~/.dsh`) — a user-editable file appended to the system
prompt of every agent the TUI creates. The file is a **runtime user
artifact, never shipped with the source**: the repo contains no
`APPEND_SYSTEM.md`; the plugin only creates it on first run and maintains
its one marked section. A system-prompt section registered in the plugin's
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
  (`origin: 'subagent'` + `parentSession` matching a tracked session);
  delegation nests. Each child's own events fold into an O(1) `AgentView`:
  `subagent/descriptor` (provider + label), `assistant/message` usage
  (tokens), `llm/retry` (retries/max), `tool/call` (last activity),
  `request/context` (context window), and `turn/end` (best-effort settle —
  the board's clear-when-done; `turn/start` re-marks a resumed child running).
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
palette.ts        githubLight / githubDark Palette (19 roles each) + detectDarkPalette
theme/index.ts    buildTheme(palette) → TuiTheme { palette, editor, markdown,
                  selectList, chat } + POWERLINE (theme-agnostic) + resolveTheme
theme-settings.ts dsh-tui namespace { theme: 'auto'|'light'|'dark' } applies: 'live'
                  + watch sink + read/write preference
text.ts           clipToWidth / visibleWidth — every width decision
```

**Palette roles** (`Palette`): `canvas` (never painted — the terminal shows
through; the semantic base for dark blends), `canvasSubtle` (raised surface:
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

**Resolution order** (`resolveTheme`): `DSH_TUI_THEME=light|dark` **env
pins** the bundle → explicit preference (light/dark) → `detectDarkPalette`
(COLORFGBG bg ∈ {7,15} → light, else dark).

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
      → ui.setLastRequest(line)
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
  restart the previous code. Re-entrancy-guarded.

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
suffix; `opencode-go → OPENCODE_GO_API_KEY`). API-key resolution for the
status column is a three-way merge (`mergedEnv` in settings.ts):
`process.env`, refs stored this browser session (`justStoredRefs`), and
prefetched `ctx.credentials.describe(ref).configured` for the credentials
document (`.credentials.yaml`) — keys stored by web never live in
`process.env`. The key itself goes to `ctx.credentials.set`, never to
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
