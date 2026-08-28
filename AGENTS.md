# AGENTS.md — working conventions for dsh-tui-pi

For agents doing work in this repository. End-user docs live in
[README.md](README.md); the full design in [ARCHITECTURE.md](ARCHITECTURE.md);
session history and current state in [HANDOFF.md](HANDOFF.md).

## Architecture at a glance

```
index.ts          cordis plugin entry (apply + effect) — all wiring: commands,
                  footer, git, clock, bridge, theme hot-swap sink, shutdown
tui.ts            UI shell: alt-screen, transcript ScrollView, dock, editor
                  rebuild on theme swap (themeRef mutable binding) +
                  transient footer notice slot (showNotice: stacked muted
                  lines above the footer, each auto-dismisses after 8s,
                  capped at 8; fed by the shared notice bridge)
messages.ts       TranscriptRenderer: session events → components; ReplayOp
                  buffer + setTheme rebuild; chat-clean transcript (think/
                  tool/todo render in the live widgets, never here)
activity.ts       ThinkPanel/ToolPanel: the fixed think/tool status panels
                  pinned above the chat input (one of each per run, refreshed
                  in place, hidden while empty; '1' = one row with identifier
                  + elapsed + last line, '5'/'7'/'10'/'all' = boxed heights;
                  self-drawing, resize/theme-safe) + the panel helpers
                  (panelBodyText/clipRow/toolSubject/…)
session.ts        DshSessionBridge: lazy create, followup, resume/replay,
                  cancel, O(1) stats, persistDefaultModel, subagent tracker
                  (tool-workflow + child events → AgentView rows → onLive;
                  child chunks fold a bounded live content tail)
dsh-events.ts     local types/guards for tool-workflow/subagent/llm-retry
                  events (declaring packages not installed) + AgentView
live-widgets.ts   LiveWidgets: the pinned surfaces around the chat input —
                  Todos panel + ThinkPanel + ToolPanel above (applyEvent
                  phase machine), ` ● ` last-request line + compact
                  running-agent lines below (content-line tail, right-
                  truncated; renderTodos/renderAgents/tickLive/setTheme;
                  show-when-content, clear-when-done)
append-system.ts  APPEND_SYSTEM.md support (pi convention, dsh side
                  ~/.dsh/APPEND_SYSTEM.md — a RUNTIME user file): install
                  seeds a fresh file from templates/APPEND_SYSTEM.md (the
                  English orchestrator template; content in the file, not
                  code); the dsh-tui-pi:todo-lifecycle section is ensured
                  there (idempotent marker, atomic) and migrated out of the
                  legacy ~/.dsh/AGENTS.md
commands.ts       CommandService: parse + dual-channel dispatch + autocomplete
notice-bridge.ts  shared notice bridge — the ONLY channel for operator
                  traces (invalid dsh-tui.retention/resume settings values,
                  the settings-namespace registration failure, a missing
                  userQuestions service, the retention result): emitNotice
                  delivers straight to the TUI's sink once registered, else
                  queues bounded pending (FIFO, cap 16) drained in order on
                  registration; never registered (headless) → silently
                  dropped — deliberately no flush timer / stderr fallback
                  (a timer firing into a slow-starting TUI would write raw
                  bytes over the alt-screen). /reload-safe by module-cache
                  eviction + per-producer one-shot guards; a failed reload
                  rolls back with module state intact → still-pending is
                  consumed once by the restarted TUI (≤ 1 batch)
frame.ts          FramedOverlay: shared top/bottom ─ border for every popup
ask-user.ts       Ask User Question: pure state reducers (answer/declined
                  envelopes, double-Esc machine, flat-row layout) + the
                  DOCKED questions panel (Todos-panel box in the askUser dock
                  slot above the editor — takes focus while open, the app
                  keymap yields via dockedModalActive, no floating overlay)
                  + ctx.userQuestions provider registration
custom-provider.ts /login "Custom provider…" entry: pure field parsers +
                  the chained EditField form composing a hand-declared
                  llm-pi-ai route (id/name/protocol/baseURL/models/key)
selectors.ts      /model (2-stage, embeddable via PanelHost), /think, /theme
                  pickers
startup-info.ts   startup config readout under the welcome banner (mcp
                  count, skills installed/total, collapsed plugin tree) +
                  the exit-hint pure helpers (--profile/--resume parsing,
                  resume-command formatting); collectStartupSummary is a
                  best-effort loader+filesystem snapshot
model-list.ts     /model pure logic: row assembly (favorites pinned top, dim
                  Hidden section), filter matcher, toggle/hide-guard helpers —
                  data-in/data-out, unit-tested without a terminal
model-profiles.ts /profile-switch + /profile-cfg pure storage: $DSH_HOME/
                  model-profiles.json (atomic, self-healing reads, seeded
                  work/personal/other), name ops (create/rename/delete),
                  captureAgentsSnapshot (save-current) + planAgentApply
                  (snapshot semantics: listed agents get exactly the recorded
                  overrides, absent keys clear, unlisted agents untouched);
                  directory pins — `.dsh-profile` dot file discovered walking
                  up from cwd (nearest wins), write/remove with a hand-edit
                  refusal guard
profile.ts        /profile-switch switcher + /profile-cfg manager
                  (agents.ts overlay pattern): switcher applies a profile
                  through the /model chain (bridge selection +
                  persistDefaultModel) plus agent frontmatter writes,
                  `p` pins/unpins the cwd (.dsh-profile — new sessions in
                  this tree auto-load the pinned profile);
                  manager = roster table (n new, d double-press delete) →
                  FieldPanel (m model via the SAME favorites/hidden pickModel
                  table, t think, a agents sub-table, s save current, r
                  rename, v review)
settings.ts       /settings browser: categories, schema walk, write chain,
                  add-provider flow (uses provider-catalog.ts)
sessions.ts       /session panel + /resume picker (ordered by last update:
                  jsonl log mtimes via loadSessionLastUpdates — newest
                  mtime/size across BOTH log suffixes, retention's
                  vocabulary, best-effort fallback to createdAt; display
                  filter: active within maxAgeDays and log size >=
                  minBytes — knobs dual-layer configurable, same chain as
                  retention: settings.yaml `dsh-tui.resume.*` explicit
                  (USER layer via readSessionManagementExplicit) >
                  DSH_TUI_RESUME_MAX_AGE_DAYS/_MIN_BYTES env > defaults
                  7d/20KB, resolved per picker open by resolveResumeConfig)
skills-manager.ts /skills panel (standalone skill browser): ~/.agents/skills
                  → ~/.dsh/skills symlinks via an idempotent install chain
                  (skillSymlinkPaths + installSkillSymlink: same-source
                  no-op incl. relative-target equivalence, different-source
                  / physical-dest refusal, dangling repair gated to
                  ENOENT/ELOOP) + per-item applyOneSkillChange (uninstall
                  is symmetric: only symlinks are removed, physical
                  file/dir refused) with an end-of-batch skillApplySummary
                  (short reasons, 3-item cap + "+N more"); a failing item
                  never aborts the remaining pending changes, the panel
                  rescans either way with the summary riding above the
                  rows, and an applying gate blocks Space/Enter mid-batch
retention.ts      startup session-log janitor: pure selector (keep 100 /
                  7 days, 24h idle guard on the count rule, protected set
                  = current session ∪ in-flight /resume target, both exempt
                  and slot-free) + store walk (skips symlinks, lstat
                  semantics) + one-by-one fs.rm runner (rm failure → failed
                  count, never aborts the pass); thresholds dual-layer
                  configurable (settings.yaml `dsh-tui.retention.*`
                  explicit, read from the descriptor USER layer via
                  readSessionManagementExplicit — theme-settings.ts —
                  > DSH_TUI_RETENTION_MAX_COUNT/_MAX_AGE_DAYS/
                  _MIN_IDLE_HOURS env > defaults; precedence
                  settings > env > default, invalid settings emit one
                  notice each via the shared bridge and fall to the next
                  level, invalid env falls back silently; MAX_COUNT<=0 at
                  the winning layer disables — the escape hatch for
                  long-lived read-attach processes); result surfaces once
                  as a transient notice above the footer via the shared
                  notice bridge (emitNotice — src/notice-bridge.ts);
                  fire-and-forget in apply() behind a globalThis one-shot
                  (per process, /reload-safe); root resolved by the CORE
                  convention ($DSH_HOME/sessions); exports
                  SESSION_LOG_FILE_NAMES shared with the /resume walk
reload.ts         /reload hot-reload (cordis-plugin-hmr style)
hotkeys.ts        /hotkeys — keybindings.json contract + validation + the
                  select-panel manager (FieldPanel + EditField, /agents style)
theme-settings.ts dsh-tui settings namespace (applies: 'live') + watch sink
theme/            palette.ts (GitHub light/dark) + index.ts (buildTheme,
                  resolveTheme: env > preference > terminal detection —
                  COLORFGBG sync guess, then CSI 996n / OSC 11 query + live
                  CSI 997 follow for 'auto')
text.ts           clipToWidth / visibleWidth — the only width vocabulary
```

Theme hot-switch chain (read this before touching anything theme-related):
`settings mutate → scope.watch → applyThemeRef (index.ts) → renderer.setTheme
(ReplayOp replay) + tui.applyTheme (canvas background + themeRef swap +
editor rebuild) → one throttled render frame`. `auto` also follows the
terminal: a CSI 996n/OSC 11 query refines the startup guess, and CSI 997
pushes repaint while the preference stays `auto` (see `stopTerminalFollow`).

## Iron rules

1. **Render never re-scans.** Footer/stats read O(1) maintained counters only.
   Never call `getBranch()/getEntries()` or walk the session log inside
   `render()`. Every event does O(event) work.
2. **Streaming is `setText` on the existing component** — never
   removeChild+addChild per delta. Markdown parses once on the assembled
   `assistant/message`, never per token.
3. **All truncation goes through `clipToWidth`** (src/text.ts). Bare
   `String.length` clipping is banned: CJK full-width = 2 columns, graphemes
   never split. **Clip plain text BEFORE applying ANSI** — `clipToWidth`
   counts SGR fragments as visible columns (verified on pi-tui 0.84.2);
   `clipRow`/`clipPanelLine` (activity.ts) encodes that order.
4. **UI text is English-only** (user requirement). Chinese/emoji *content*
   must render correctly — that means width-safe clipping everywhere.
5. **TypeScript constraints** (tsconfig): `NodeNext` +
   `verbatimModuleSyntax` + `erasableSyntaxOnly` →
   - relative imports carry the `.ts` extension (`./foo.ts`);
   - `import type` for type-only imports; no enums/namespaces/parameter
     properties (`constructor(private x)` is a compile error);
   - `rewriteRelativeImportExtensions` handles the emit.
6. **Comments in English.** Commit messages in English, imperative mood.
7. **Never re-implement a dsh command.** Autocomplete comes from
   `ctx.commands.list(agent)`, execution from `ctx.commands.execute`.
   TUI-owned commands register both channels: `registerLocal` (direct dispatch
   when no live agent — never mint a throwaway session) + `ctx.commands.register`.
8. **Overlay focus contract**: every overlay resolves back through
   `restoreFocus` — callers must re-focus the *current* editor instance (it is
   rebuilt on theme swap). Two-stage pickers show the new overlay before
   hiding the old one (no focus flash). Stage-2 Esc abandons the whole pick.
9. **Resume replay split**: replay only `seq < firstLiveSeq` events —
   live events arrive again through the `session/event` subscription and would
   double-count. `assistant/chunk` is skipped in replay (the finalized message
   carries the full text).

## Quality gates

- `pnpm check` (tsc --noEmit) must stay 0 errors.
- `pnpm test` must stay green: **991 tests** across 55 files (verified by
  `node --test test/*.mjs`; the v0.26.0 baseline was 918, model-profiles
  added 25, the directory pin added 5, the single-writer guard added 9,
  repair-session-log fixtures added 6, the read-only remote view added 7, the
  corrupt-log repair flow added 21). Per-file totals
  below; verify after any new logic is added and update if numbers
  move. New pure logic → new test file under `test/` against built
  `lib/` (`node --test`, pretest builds). Update the totals in
  HANDOFF.md.
  - ask-user 102 + notice-bridge 8 + skills 36 + skills-manager 24 + startup-info 19 +
  - live 35 + keymap 31 + login 25 + panels 24 + session-reconcile 30 +
  - retention 39 + pending-echo 26 + steer-flow 22 + session-header-reset 9 +
    writer-lock 9 + repair-session-log 6 + remote-tail 7 + log-repair 21 +
  theme 21 + settings 19 + welcome 18 + model-sync 18 + provider-catalog 17 +
  custom-provider 12 +
  messages 16 + hotkeys 16 + theme-canvas 16 + subagent-policy 26 +
  subagent-viewer 37 + history 13 + agent-manager 13 +
  sessions 35 + theme-switch 11 + frame 11 + footer-hints 10 + permission 9 +
  theme-settings 15 + commands 9 + text 15 + font-detect 8 + quotes 7 +
  icons 7 + reload 6 + append-system 9 + install-font 6 + tokens 6 +
  queue-panel 6 + schema-model 3 + usage 26 + preset 12 + dev-upgrade 8 +
  model-list 21 + notice-bridge 8 + plugin-inject 2 + model-profiles 30 +
  mouse-mode 5 + session-ch-cache 8.
- e2e is tmux-driven: `tmux new-session -d -s dsh-tui -x 140 -y 36`, launch
  `dsh --profile tui`, drive keys, `capture-pane` for assertions (see HANDOFF
  "验证命令速查"). Keep the 24-row terminal case in the matrix — overlay
  maxHeights are tuned for it.
- Review cycle ("老法师"): findings are labeled by class — A (architecture /
  UX / focus), B (behavioral bugs), C (cosmetic). Fixes land with regression
  tests where the finding is testable (see the O/P/Q/R rounds in HANDOFF).
  Do not start a new feature before the review round on the current one is
  closed.

## Config safety — read before any test or e2e

- `~/.dsh/settings.yaml` and `~/.dsh/.credentials.yaml` are **LIVE
  configuration** of the user's dsh. Tests and e2e runs that touch them MUST
  snapshot both files first and restore them byte-for-byte afterwards (verify
  with a diff; the e2e gate requires an empty diff).
- The user may be running their own dsh instances concurrently. The settings
  file is **last-write-wins**: never assume you own it, never rewrite whole
  sections from a stale snapshot. All writes go through
  `settings.mutate(ns, pathOps, revision)` (optimistic concurrency, one retry
  on `SettingsConflictError`) or service APIs that do their own
  `settings.replace` (e.g. `agentDefaultModel.saveSelection`).
- The settings service mounts asynchronously in the injection fiber
  (~144ms transient `undefined`): wait bounded (the theme-settings
  registration promise pattern) and degrade, never hang startup.

## Known pi-tui 0.84.2 limitations (do not fight them)

- **Layout does not descend into a plain Container**: a Container without a
  layout node renders by concatenation, so a nested ScrollView inside the
  transcript can never obtain a viewport. The fixed think/tool panels with a
  tail body (`dsh-tui.panelHeight`: '1' one row, '5'/'7'/'10' boxed rows, or
  'all' with a bounded streaming tail and a 2000-line tool-result cap) are
  the accepted design — no inner scrolling.
- **The canvas background is painted by our write-stream decorator, not by
  components**: rows are written with erase-line (`\x1b[2K`) + content, so
  unpainted rows would show the terminal's default background and a theme
  switch would leave it frozen (most visible inside cmux/gostty).
  `src/canvas-terminal.ts` wraps the `ProcessTerminal` handed to
  `TuiAltScreen` and injects the canvas SGR at two points: before every
  `\x1b[2K`/`\x1b[2J` (BCE — terminals fill erased regions with the current
  SGR background, covering row tails) and after every background-clearing
  SGR reset (`\x1b[0m`, `\x1b[m`, `\x1b[0;…m`, `\x1b[49m` — content after a
  reset would otherwise print cells with the terminal default background,
  punching holes into the canvas; color-sets whose params merely contain a
  0 channel are NOT resets). Zero pi-tui patches. Diff-rendered rows the
  renderer skips keep their last paint, which is why `applyTheme` must
  force a full redraw via `requestRender(true)`. `DSH_TUI_TRANSPARENT=1`
  (checked in `src/tui.ts`) opts back into the see-through canvas. The
  alt-screen exit dump passes through unpainted (decorator shutoff on
  `EXIT_ALT_SCREEN`).
- **SelectListTheme has no background hook for unselected rows**: the value
  part of unselected rows renders raw (`renderItem` → `prefix + truncatedValue`),
  so it cannot get the `canvasSubtle` backdrop. Only the selected row,
  descriptions, scroll info and no-match line are themed.
- **A truncated label drops the selected-row backdrop after the cut**:
  pi-tui 0.84.2's `truncateToWidth` terminates any truncated result with a
  full `\x1b[0m` reset (`finalizeTruncatedResult`), so when a SELECTED skill
  row's label is cut, everything after the cut — the spacing and the
  description — loses the selected background/bold (the `\x1b[0m` ends
  `selectedText`'s span early). Pre-existing upstream behaviour, unrelated
  to the whole-line italic tweak (the italic off-code is `\x1b[23m`; the
  non-truncated backdrop path is regression-tested in test/skills.test.mjs).
- **Input has no masking**: secret fields are rendered by our own
  `EditField` dot-row renderer (maskLine) over a real Input; the value never
  reaches the render output.
- **SettingsList's search input row is pushed raw** (settings-list.js, first
  line with `enableSearch`), no theme injection. Also: its search matches
  `label` only (fuzzyFilter) — English labels carry the searchable keywords;
  `done(undefined)` closes a submenu without changing anything.
