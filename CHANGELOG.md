# Changelog

All notable changes to dsh-tui-pi are documented here, grouped by release.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
