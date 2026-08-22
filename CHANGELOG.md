# Changelog

All notable changes to dsh-tui-pi are documented here, grouped by release.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
