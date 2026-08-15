# dsh-tui-pi

pi-style terminal UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

- **Look & feel**: pi coding agent interactive TUI, built on
  `@earendil-works/pi-tui` 0.84.2 (pinned) — alt-screen scrollable transcript,
  docked editor/status/footer, markdown messages, slash-command autocomplete.
- **Slash commands**: dsh's own, untouched. Autocomplete from
  `ctx.commands.list(agent)`, executed via `ctx.commands.execute(agent, line, signal)`.
  Verified: `/compact`, `/plan`, `/goal`, `/permission`, `/feedback`. The TUI
  adds its own surface commands — `/model /think /session /resume /new
  /settings /export /theme /reload` (see below).
- **Themes**: GitHub light / GitHub dark palettes (aligned with the
  `cmux-theme.sh` GitHub terminal themes). Hot-switchable at runtime: pick one
  with `/theme` (applies immediately), edit the `dsh-tui.theme` setting
  (external edits hot-apply too), or pin with `DSH_TUI_THEME=light|dark` — the
  env var wins over every preference. Without a preference, terminal-background
  detection (COLORFGBG).
- **Footer**: powerline segments ported from
  [pi-powerline-footer](https://github.com/fan56/pi-powerline-footer) —
  provider / model+thinking / context / cache-hit / msgs / tools with U+E0B0
  arrows, right-aligned live clock, cwd+git-branch editor top border, and the
  `↳ last-request` widget.
- **Live todos & subagents**: bordered panels pinned **above the chat input** —
  a `● Todos (done/total)` tree (`☐`/`◐`/`☑` status icons) and a live
  `● Agents` board (spinner, provider + label, retries, token count + context
  percent, elapsed and the current tool) refreshed ~10×/s. Show while there is
  content, clear when done — a settled child drops off the board and an empty
  panel collapses to zero rows. Subagents are tracked from the child sessions
  themselves (header `origin: subagent` + `parentSession`), so any spawn
  mechanism works. The TUI also supports pi's `APPEND_SYSTEM.md` convention
  (dsh side: `~/.dsh/APPEND_SYSTEM.md`): a user-editable file whose content is
  appended to the system prompt of every agent the TUI creates — read at each
  assembly, so edits apply to the next request without a restart. The TUI's
  own `dsh-tui-pi:todo-lifecycle` guidance (marker
  `<!-- dsh-tui-pi:todo-lifecycle -->`) lives in that file, telling the model
  to write an empty todo list once everything is completed (idempotent,
  atomic, best-effort; the panel-side all-completed hide remains as fallback).

## Commands

| Command | What it does |
|---|---|
| `/model` | pick provider/model — every route the mounted llm services list (pi-ai's built-in catalog + llm-deepseek's static pair). Two-stage picker: choose the model, then a think level when the route exposes one (Esc on stage 2 abandons the whole pick). Live switch with footer sync, persisted as the default. |
| `/think` | reasoning-effort picker for the current model — `(provider default)` clears the override, then the route's efforts (Off / High / Max …). Live + persisted. |
| `/session` | read-only info panel: id, cwd, created, model, think level, status, message/tool counts, token usage, event count, parent session. |
| `/resume` | pick a persisted session (subagent children and the current session are filtered out), validate its log *before* touching the live agent, then restore it — transcript and footer stats rebuild from the stored events. |
| `/new` | detach the current session and clear the transcript; the next prompt opens a fresh one (the escape hatch when the current history must not follow, e.g. images in it). |
| `/settings` | text-based settings browser: namespaces grouped into categories (General / Models / Plugins / Agent Presets / Other), schema walk with drill-ins, cycle rows, inline editors (secrets masked), dict add-key, reset-to-defaults. Writes go through the settings mutate chain. |
| `/export` | write the current session log as JSONL — default `~/Downloads/dsh-session-<id>.jsonl`, or a path argument. |
| `/permission` | permission-preset picker (whatever the deployment table advertises — read-only / workspace-write / danger-full-access). Select a preset to apply it through dsh's canonical `/permission <name>` command, or Esc to keep the current one. The editor's top border shows the live preset badge (danger-full-access → "Full access"). |
| `/theme` | color-scheme picker (auto / light / dark). The choice applies immediately and is persisted to `dsh-tui.theme`. |
| `/reload` | hot-reload the plugin from the current source (after `pnpm build`) without restarting dsh — the TUI and the live agent are torn down; the session log persists and can be rejoined with `/resume`. |

Anything that is not a resolvable command falls through to the model as an
ordinary prompt, so dsh packages' commands (and future registrations) appear
automatically.

### Models: provider-first

`/settings → Models` does not expose the raw `llm-pi-ai` namespace. It lists
one row per configured provider — label (`displayName` ?? catalog name ??
route key), value column (first model / `N models` / `catalog` when pi-ai
serves the route), and one-line API-key state (`API key set` / `missing` /
`not configured`) probed from the process environment plus the credentials
document — with dedicated `DeepSeek (official)` and `Default model` rows and a
`+ Add provider…` action. The add flow mirrors pi's `/login`:

1. pick from the built-in directory (10 searchable catalog routes — Anthropic,
   DeepSeek, Google Gemini, Groq, Mistral, OpenAI, OpenCode Go, OpenRouter,
   Together AI, xAI);
2. enter exactly one API key — masked dot-row editor, the value never echoes
   and never reaches the rendered output;
3. the commit double-writes like the web Models page: `llm-pi-ai.providers.<id>`
   gets `{ apiKeyEnv: <ref> }` through the settings mutate chain (ref derived
   by convention: route key uppercased, non-alphanumerics → `_`, `_API_KEY`
   suffix, e.g. `opencode-go → OPENCODE_GO_API_KEY`) and the key is stored via
   `ctx.credentials.set` — never in `settings.yaml`. Without a credentials
   service the profile still commits and the UI says
   `export <REF>=<key> to use it` instead.

### Theme hot-switch

Themes change live, no restart:

- `/theme` (or an edit through `/settings → General → dsh-tui`) commits the
  preference to the `dsh-tui` settings namespace, which is registered
  `applies: 'live'`. The namespace's watch hook pushes the commit to the
  running TUI, which repaints everything on the next frame: transcript
  (replayed from its operation buffer), editor border, footer hint, spinner.
- An **external edit** of `~/.dsh/settings.yaml` (`dsh-tui.theme: dark`)
  hot-applies through the same watch path.
- `DSH_TUI_THEME=light|dark` **pins** the display regardless of preference —
  it wins at startup and keeps winning; `/theme` still persists the
  preference and honestly reports `Theme preference saved — display is pinned
  by DSH_TUI_THEME=…` instead of claiming it applied.
- The choice survives restarts (`auto` falls back to terminal detection).

## APPEND_SYSTEM.md

dsh-tui-pi supports pi's `APPEND_SYSTEM.md` convention on the dsh side:
**`~/.dsh/APPEND_SYSTEM.md`** (`$DSH_HOME` or `~/.dsh`) is appended to the
system prompt of every agent this TUI creates. The file is read at each
prompt assembly, so **edits apply to the very next request** — no restart,
no reload, no watcher.

- **The file is not shipped with the source**: the repo contains no
  `APPEND_SYSTEM.md` — it lives in your `~/.dsh` and is yours to edit freely
  (identity, persona rules, UI conventions — anything you want the model to
  know, e.g. pi-style `.pi/agent/APPEND_SYSTEM.md` content copied over).
- On first run the TUI **creates** the file if missing and **maintains one
  marked section** in it (`<!-- dsh-tui-pi:todo-lifecycle -->`, telling the
  model to clear the todo list once everything is completed). Your own
  content is never touched; the maintenance is idempotent, atomic
  (tmp + rename) and best-effort.
- An empty or missing file contributes nothing to the prompt (the section is
  dropped by the prompt renderer).

## Install (local)

```sh
# build once
cd dsh-tui-pi && pnpm install && pnpm build

# live development link (recommended; edits to src/ + pnpm build apply on next launch)
dsh plugin --profile tui add link:/path/to/dsh-tui-pi

# or an npm tarball
npm pack                                   # → dsh-tui-pi-0.1.0.tgz
dsh plugin --profile tui add /path/to/dsh-tui-pi-0.1.0.tgz
```

Both paths auto-add `dsh-tui-pi` to the profile's `dsh.profile.bundles`.

## Use

```sh
dsh --profile tui        # or: dsh-tui-pi (bin shim)
```

- Type a prompt → Enter. Streaming reply renders live; tool calls render as
  `⚙/✔/✘` cards.
- Todos and subagent children the model spawns show in bordered panels pinned
  **above the chat input** (they never scroll with the transcript): a
  `● Todos (done/total)` tree and a live `● Agents` board — spinner, provider
  + label, retries (`↻N≤M`), tokens (+ context percent), elapsed, and the
  current tool (`⎿ running …`). A finished child drops off the board; when
  nothing is left the panels collapse away.
- `/` opens slash-command autocomplete (Tab/arrows/Enter).
- Ctrl+C quits — while the agent is mid-turn the first press cancels the turn
  (`⏹ canceling current turn…`), any further press quits.

## Performance rules (from the pi-turbo findings)

pi's TUI lags in long sessions because its footer re-scans the whole session
log on every render (O(n)) and a 1s clock tick recomputes everything.
dsh-tui-pi avoids both by construction:

- **Event-driven incremental state**: `session/event` listeners maintain an
  append-only transcript model + running counters (tokens, messages, tools,
  cache-hit rate). Render never re-scans the dsh session log.
- **Footer reads O(1) maintained values** — never derived in `render()`.
- **Clock tick only re-renders the footer line**; transcript components cache.
- **Live widgets tick at 100 ms** (`AGENT_TICK_MS`, unref'd timer): a tick
  only re-setTexts the widget's single Text (O(agents)) and is a no-op while
  no child runs — never a transcript re-scan.
- **Streaming strategy**: deltas accumulate in a plain Text via `setText` on
  the same component (never remove+re-add per token); markdown renders once on
  the assembled `assistant/message` (no per-token markdown parsing).
- **Configurable think/tool panels** (`dsh-tui.panelHeight`, default `'5'`):
  `'5'/'7'/'10'` set the total panel rows (top border + header row + body rows
  + bottom border); `'all'` prints the full body, with bounded on-screen
  content — a streaming reasoning panel boxes a 200-line live tail while
  chunks are in flight (the assembled message renders everything) and a
  settled tool result keeps at most 2000 lines (a `… (+N lines)` marker
  reports the drop). No inner scroll — pi-tui 0.84.2 never lays out nested
  components, so a nested ScrollView cannot obtain a viewport. Body lines are
  clipped to one physical row *before* styling, so long output can never wrap
  the panel past its configured rows.
- **Width safety**: every truncation goes through `clipToWidth` (src/text.ts)
  — CJK full-width characters count 2 columns and graphemes are never split.
  Bare `String.length` clipping is banned.

## Dev

```sh
pnpm check    # tsc --noEmit
pnpm build    # emit lib/
pnpm test     # unit tests, node --test against lib/ (171 tests, pretest builds)
```

Local type-checking symlinks `node_modules/@deepseek-ai/*` to the installed
dsh closure (`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules`);
at runtime those imports resolve to the same module instances the running dsh
uses. Those symlinks stay out of any tarball (`files` ships lib/bin/patch only).

⚠️ `pnpm install` regenerates the three type-check symlinks declared in
`package.json` (`dsh-settings`, `dsh-client-schema-form`, `schemastery`)
into local `.pnpm` copies, splitting the cordis module identity and breaking
`pnpm check` — after any install, re-link them:

```sh
ln -sfn /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/{dsh-settings,dsh-client-schema-form,schemastery} node_modules/@deepseek-ai/
```

`dsh-permission-presets` is a fourth, undeclared type-check link — the same
extraneous-closure pattern as `cordis`/`dsh-agent` above: `pnpm install`
never regenerates it (it is not in the dependency tree), but a wiped
`node_modules` needs it re-created by hand:

```sh
ln -sfn /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-permission-presets node_modules/@deepseek-ai/
```

**pi-tui patch**: this plugin applies a small patch to the pinned
`@earendil-works/pi-tui` 0.84.2 (`pnpm.patchedDependencies` in
`pnpm-workspace.yaml`, patch in `patches/`): it adds an `unselectedText`
SelectListTheme hook (full-row background on unselected rows), wires the
previously dead `selectedPrefix` hook (accent arrow on the selected row), and
frames the editor's slash-autocomplete list in a `│` box. The patch travels in
the tarball (`files` includes `patches` + `pnpm-workspace.yaml`); the
link:-mounted dev workflow uses the already-patched copy in this repo's
`node_modules`.

## Layout

```
bin/dsh-tui-pi      launcher shim (exec dsh --profile tui)
cordis.patch.yml    bundle patch: mounts the plugin as `tui-pi`
src/
  index.ts          cordis plugin entry + wiring: command registration, footer,
                    git watcher, clock, bridge, theme hot-swap sink, shutdown
  tui.ts            TUI bootstrap: alt-screen tree, transcript ScrollView,
                    dock (status/editor/last-request/footer), editor rebuild
  session.ts        DshSessionBridge: lazy agent create, followup, resume,
                    replay, cancel, O(1) incremental stats, persistDefaultModel,
                    subagent tracker (tool-workflow + child events → live rows)
  dsh-events.ts     local types + guards for tool-workflow/subagent/llm-retry
                    events (declaring packages not installed) + AgentView
  live-widgets.ts   LiveWidgets: fixed Todos/Agents widgets pinned above the
                    chat window (renderTodos/renderAgents/tickLive/setTheme)
  commands.ts       CommandService: slash autocomplete + dual-channel dispatch
                    (registerLocal agentless direct / ctx.commands host path)
  messages.ts       TranscriptRenderer: session events → pi-tui components;
                    streaming setText, height-configurable panels, ReplayOp
                    buffer for theme-switch rebuilds
  footer.ts         PowerlineFooter (ported segment palette, 7 segments + clock)
  editor.ts         CwdBorderEditor (top border: 📁 cwd │ ⎇ branch)
  git.ts            GitBranchWatcher (polled, cached)
  frame.ts          FramedOverlay: shared top/bottom ─ border for every popup
  provider-catalog.ts  built-in provider directory + deriveKeyRef + row views
                    (pure data/functions for the Models add-provider flow)
  reload.ts         /reload hot-reload (cordis-plugin-hmr style partial reload)
  text.ts           clipToWidth / visibleWidth (grapheme-safe column clipping)
  theme-settings.ts dsh-tui settings namespace (applies: 'live') + watch sink
                    + preference read/write with conflict retry
  selectors.ts      /model (two-stage), /think, /theme and /permission picker
                    overlays
  permission.ts     permission display names (web-client conventions) + picker
                    option assembly (pure, unit-tested)
  sessions.ts       /session info panel + /resume persisted-session picker
  settings.ts       /settings browser: categories, schema walk, inline editors,
                    serialized mutate write chain, add-provider flow
  theme/
    palette.ts      GitHub light/dark palettes + terminal-background detection
    index.ts        buildTheme: Editor/Markdown/SelectList/chat roles, POWERLINE
                    segment palette, resolveTheme (env > preference > detect)
test/*.test.mjs     unit tests, node --test against lib/ (171 across 14 files)
```

## Status (2026-08-15)

All surface commands shipped and tmux-e2e verified: `/model /think /session
/resume /new /settings /export /theme /reload`; provider-first Models with the
add-provider flow; overlay chrome (backgrounds + borders); theme hot-switch
(immediate apply, external-change watch, env pinning); graded Ctrl+C; live
todos + subagent progress blocks; clean Ctrl+C exit. `pnpm check` clean,
171 unit tests green, e2e run confirmed the settings/credentials files are
restored byte-for-byte.

Known limitations (accepted, pi-tui 0.84.2 constraints):

- **SelectList unselected rows and the SettingsList search row have no
  background**: unselected rows render as raw `prefix + value` and the search
  input row is pushed without a theme hook — the popup backdrop is striped
  rather than one solid surface.
- **On a 24-row terminal a popup can reach the dock rows**: overlays float
  over the status/editor area (the frame adds 4 rows on top of the list cap),
  so the popup bottom border and the status line share screen rows while a
  popup is open. Cosmetic — popups are modal.
- **An overlay open at switch time does not follow a theme hot-switch**: the
  transcript, dock and editor repaint immediately, but an open popup keeps the
  palette it was built with until it closes (its submenus inherit the same
  stale bundle).
