# dsh-tui-pi

pi-style terminal UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

## Preview (ASCII mock-up)

```
┌──────────────────────────────────────────────────────────────┐
│  🐳: 两个 subagent 已在后台并行启动 (A: 5b19b15c, B: d2072ffd) │  ← transcript (scrolls)
│  ┌─ 💭 thinking ──────────────────────────────────────────┐  │
│  │ Actually, I can check list_agents or wait…             │  │
│  └────────────────────────────────────────────────────────┘  │
│  ⚙ bash  python scripts/demo.py  …  ✔ bash                │  │
└──────────────────────────────────────────────────────────────┘
┌─ ● Todos (1/2) ────────────────────────────────────────────┐
│ ├─ ☑ Todo 1: 启动 subagent A 执行 10s 任务并收集结果        │  ← fixed widgets
│ └─ ◐ Todo 2: 启动 subagent B 执行 10s 任务并收集结果        │    above the input
└─────────────────────────────────────────────────────────────┘
∴ working…                                                    ← status
📁 ~/github (Full access) │ ⎇ main                            ← editor border
[ 请输入指令…                                                ] ← input
 ↳ 创建 2 个 todo, 每个 todo 起一个 10s 的 subagent            ← last request
  ↳ ⠼ Subagent A 10s 任务 · 1.2k token · 19.0s                 ← running agents
  ↳ ⠼ Subagent B 10s 任务 · 562 token · 6.0s                   ← (compact lines)
dsh ▸ ☁ opencode-go ▸ 🤖 deepseek-v4-flash ▸ ● high ▸ 🧠 11.6k/1.0M (1.2%) ▸ ⚡ CH98.9% ▸ 💬 8 ▸ 🔧 4       00:00:14   ← footer
⌨ Enter: send · Ctrl+C: cancel / double: quit                 ← hints
```

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
  env var wins over every preference. The app paints its own canvas, so a
  switch recolors the whole screen (background included) even inside
  multiplexers; without a preference, `auto` detects the terminal background
  (COLORFGBG + a live OSC 11 / CSI 996n query) and follows the terminal's
  light/dark switches in real time.
- **Footer**: powerline segments ported from
  [pi-powerline-footer](https://github.com/fan56/pi-powerline-footer) —
  provider / model+thinking / context / cache-hit / msgs / tools with U+E0B0
  arrows, right-aligned live clock, cwd+git-branch editor top border, and the
  `↳ last-request` widget.
- **Live todos & subagents**: the `● Todos (done/total)` tree (`☐`/`◐`/`☑`
  status icons) is a bordered panel pinned **above the chat input**; the
  running subagent activity merges into the **last-request area below the
  editor** as compact lines (`  ↳ ` prefix, spinner + agent **name** first,
  retries, token count + context percent, elapsed — no provider) — no box, no
  header, just one line per running
  child. Both refresh ~10×/s. Show while there is content, clear when done —
  a settled child drops off and an empty panel/area collapses to zero rows.
  Subagents are tracked from the child sessions themselves (header `origin:
  subagent` + `parentSession`), so any spawn mechanism works. The TUI also
  supports pi's `APPEND_SYSTEM.md` convention
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
| `/agents` | manage agent definition markdown files (name/model/thinking/deep per agent) **and the subagent limits** — `l` from the table opens the limits panel: `maxAgents` (concurrent live children, default 4) and `maxRounds` (completed turns before the TUI queues a wrap-up request, default 50; both `0 = unlimited`). Limits are read live at every spawn/turn decision; writes go to the `dsh-tui` settings namespace and hot-apply. Also the initial view when no agent files exist yet. |
| `/subagents` | the command twin of `Ctrl+G`: pick a running (or recently settled) subagent and watch its live transcript in the 80% viewer — status, rounds against the cap, tokens, tool calls. |
| `/reload` | hot-reload the plugin from the current source (after `pnpm build`) without restarting dsh — the TUI and the live agent are torn down; the session log persists and can be rejoined with `/resume`. |
| `/hotkeys` | keybinding browser: the effective app-key table (custom overrides starred) plus the keybindings file path — see [Custom keybindings](#custom-keybindings). |

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

1. pick from the directory — every llm-pi-ai catalog route that takes an API
   key (36 in the installed pi-ai 0.82.1), read live from the llm service with
   a static fallback, the same directory as the web Models page;
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
- **The whole screen changes, background included.** The TUI paints its own
  canvas (a patched pi-tui paints every rendered row with the palette's
  canvas color), so a light→dark switch recolors the entire surface — the
  terminal's own background never shows through, which is what makes the
  switch look broken inside multiplexers like cmux/gostty where the pane
  background belongs to the terminal, not the app. Set
  `DSH_TUI_TRANSPARENT=1` to go back to the see-through canvas and keep your
  terminal theme visible.
- An **external edit** of `~/.dsh/settings.yaml` (`dsh-tui.theme: dark`)
  hot-applies through the same watch path.
- `DSH_TUI_THEME=light|dark` **pins** the display regardless of preference —
  it wins at startup and keeps winning; `/theme` still persists the
  preference and honestly reports `Theme preference saved — display is pinned
  by DSH_TUI_THEME=…` instead of claiming it applied.
- The choice survives restarts. `auto` detects the terminal: the synchronous
  startup guess reads `COLORFGBG`; a background refinement then asks the
  terminal itself (CSI `?996n` color-scheme query, falling back to an OSC 11
  background-color query — both answered by Ghostty/cmux, kitty and iTerm),
  and while `auto` stays selected the TUI follows live light/dark switches of
  the terminal (CSI 997 push notifications) and repaints on the next frame.

## APPEND_SYSTEM.md

dsh-tui-pi supports pi's `APPEND_SYSTEM.md` convention on the dsh side:
**`~/.dsh/APPEND_SYSTEM.md`** (`$DSH_HOME` or `~/.dsh`) is appended to the
system prompt of every agent this TUI creates. The file is read at each
prompt assembly, so **edits apply to the very next request** — no restart,
no reload, no watcher.

- **The file is not shipped with the source**: the repo contains no
  `APPEND_SYSTEM.md` at its root — it lives in your `~/.dsh` and is yours to
  edit freely (identity, persona rules, UI conventions — anything you want
  the model to know). The English **template** the installer seeds from is
  `templates/APPEND_SYSTEM.md` (the pi orchestrator-identity definition,
  translated — content lives in that file, not in code).
- On first run the TUI **creates** the file from the template if missing and
  **maintains one marked section** in it (`<!-- dsh-tui-pi:todo-lifecycle
  -->`, telling the model to clear the todo list once everything is
  completed). Your own content is never touched; the maintenance is
  idempotent, atomic (tmp + rename) and best-effort.
- An empty or missing file contributes nothing to the prompt (the section is
  dropped by the prompt renderer).

## Install (local)

```sh
# build once
cd dsh-tui-pi && pnpm install && pnpm build

# live development link (recommended; edits to src/ + pnpm build apply on next launch)
dsh plugin --profile tui add link:/path/to/dsh-tui-pi

# or an npm tarball
npm pack                                   # → aiwayds-dsh-tui-pi-0.2.0.tgz
dsh plugin --profile tui add /path/to/aiwayds-dsh-tui-pi-0.2.0.tgz
```

Both paths auto-add `dsh-tui-pi` to the profile's `dsh.profile.bundles`.

## Use

```sh
dsh --profile tui        # or: dsh-tui-pi (bin shim)
```

- Type a prompt → Enter. Streaming reply renders live; tool calls render as
  `⚙/✔/✘` cards.
- Todos the model spawns show in a bordered panel pinned **above the chat
  input** (never scrolls with the transcript): a `● Todos (done/total)` tree.
  Subagent children render as **compact lines in the last-request area below
  the editor** (` ↳ <last request>` then one line per running child) — `  ↳ `
  prefix, spinner + agent **name** first, retries (`↻N≤M`), tokens
  (+ context percent), elapsed (no box, no `● Agents` header, no provider). A
  finished child drops off; when nothing is left the panel and the activity
  lines collapse away.
- `/` opens slash-command autocomplete (Tab/arrows/Enter).

## Keyboard shortcuts

App-level keys (key mappings mirror [pi](https://github.com/badlogic/pi-mono)):

| Key | Action |
| --- | --- |
| `Enter` | send the prompt |
| `Esc` | **stop the current task — as a deliberate double-press** — priority chain: a popup that is open closes itself first (Esc inside a popup *never* stops the running task); the editor's autocomplete closes; a mid-turn agent waits for a second `Esc` within 500ms to cancel the whole task (parent + subagents, `⏹ canceling current turn…`; the first press only arms the window and shows a hint); a non-empty editor does **nothing** (anti-misfire); on an **empty** editor a second `Esc` within 500ms opens `/session` |
| `Ctrl+C` | mid-turn: first press cancels the running turn, second press (within 500ms) quits; idle: first press clears the editor, second press quits. With a popup open it cancels the popup instead. **Held-key auto-repeat never quits** — repeats under 80ms apart are swallowed, and the double-press quit is confirmed for 200ms (a follow-up repeat aborts it, a human-speed re-press fires it immediately) |
| `Ctrl+D` | quit — only when the editor is **empty**, like pi's `app.exit`; with text it is the regular delete-character-forward |
| `Ctrl+L` | open the model/think picker (pi's `app.model.select`) |
| `Ctrl+G` | open the subagent picker while subagents run (see `/subagents`); idle the key falls through untouched. dsh's own mapping — pi spends this key on an external editor we don't have, remap in `keybindings.json` if you miss it |
| `Tab` | autocomplete |

Editor keys (movement/deletion/undo) come from the pi-tui `Editor` default
bindings — no dsh code involved: `←→` / `Ctrl+B`/`Ctrl+F` move, `Alt+←→` /
`Ctrl+←→` / `Alt+B`/`Alt+F` word-move, `Home`/`End` / `Ctrl+A`/`Ctrl+E` line
edges, `PageUp`/`PageDown` scroll, `Backspace` / `Delete`/`Ctrl+D` delete,
`Ctrl+W`/`Alt+Backspace` delete word back, `Alt+D` delete word forward,
`Ctrl+U`/`Ctrl+K` delete to line start/end, `Ctrl+-` undo, `Ctrl+Y`/`Alt+Y`
yank, `Shift+Enter`/`Ctrl+J` newline. `↑` / `↓` follow this interplay: on the
first line `↑` moves the cursor to the line start, whereas on an **empty**
editor (or with the cursor at the line start) it browses history instead (next
paragraph).

`↑` / `↓` browse the submitted-message history shell-style. `↑` recalls the
most recent prompt and walks further back; `↓` moves forward again, and past
the newest entry it restores your in-progress draft. Browsing starts when the
cursor is at the start of the first line — including on an empty editor — and
the text you were leaving is preserved as the draft, so `↓` all the way back
hands you the draft again. The history holds up to **500 entries**, dropping
the oldest ones beyond that; it survives a theme hot-swap (the editor is
rebuilt on switch). The history is in-memory for the current TUI run — it does
**not** survive `/reload` or a restart. Submitted slash commands (`/theme`,
`/hotkeys`, …) are recorded too. Recalling a multi-line entry places the
cursor at its start; `↓` then walks the entry's lines before advancing the
history — but a single-line entry round-trips identically (do not fight the
pi-tui behavior).

Not supported yet (documented status): `Ctrl+O` collapse tool output, `Ctrl+X`
copy the last assistant message, `Alt+Enter` follow-up queue, `Ctrl+V` paste
image, `Ctrl+Z` suspend, `Ctrl+P`/`Ctrl+Shift+P` model cycle, `Shift+Tab` think
cycle, `Ctrl+T` collapse thinking.

### Subagent viewer & fine-grained control

`Ctrl+G` (or `/subagents`) opens an 80% picker over the tracked children —
running ones first (spinner, mode, rounds against `maxRounds`, tokens,
elapsed), then the five most recently settled. Enter opens the transcript
viewer: one readable line per buffered child event (user/assistant messages,
tool calls paired with truncated results, turns, todos), refreshing ~3x/s
with tail-follow (scroll up to detach, reach the bottom to re-attach), and a
truncation note when the per-child 2000-event ring buffer dropped its head.
`Esc` closes; a deliberate double-`x` within 500ms closes too.

Two caps steer delegation (configure in `/agents` → `l`, both live-read at
every decision):

- **`maxAgents`** (default 4, `0` = unlimited) — a `tools.guard` denies
  model-facing spawn tools (`subagent`, `subagent_fork`, `workflow`, `ralph`,
  `use_agent`) once that many children run, with the running labels in the
  deny reason so the model can wait or `list_agents`. The cap is approximate
  under a burst of parallel spawns; workflow fan-out (which bypasses the tool
  pipeline) is pruned after the fact on `subagent/start`.
- **`maxRounds`** (default 50, `0` = unlimited) — when a child's completed
  turns reach the cap, the TUI queues one wrap-up request
  ("总结和结束这个任务，汇报情况。") as its next turn — it never interrupts
  work underway, never repeats per child, and never re-awakens a child that
  already settled. There is deliberately **no force stop**.

### Custom keybindings

The five app-level keys are remappable through `$DSH_HOME/keybindings.json`
(`~/.dsh/keybindings.json` by default) — pi's
`~/.pi/agent/keybindings.json` convention. The file is a **partial** map of
the app keys to pi-tui key ids; anything missing keeps its default. Key id
format: `modifier+key`, modifiers `ctrl`/`shift`/`alt`/`super` (combined with
`+`), key a letter/digit/symbol or a named key (`escape`, `enter`, `tab`,
`space`, `backspace`, `delete`, `home`, `end`, `pageUp`, `pageDown`, arrows,
`f1`–`f24` …).

```json
{
  "escape": "ctrl+x",
  "ctrlC": "alt+c",
  "ctrlD": "ctrl+w",
  "modelPicker": "ctrl+m"
}
```

The file is read when the TUI starts. You can edit it by hand (then
`/reload`) — or use `/hotkeys`, which shows the effective table in the same
select-panel style as `/agents`: each app key is a row (custom overrides
starred), `Enter` prompts for a new key id (empty input resets the key to its
default), and a commit **writes the file and applies the change live** — no
`/reload` needed. Invalid entries never block: they warn and keep the default.

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
pnpm test     # unit tests, node --test against lib/ (277 tests, pretest builds)
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
                    dock (status/editor/last-request/footer), editor rebuild,
                    app-owned canvas background (patched pi-tui)
  session.ts        DshSessionBridge: lazy agent create, followup, resume,
                    replay, cancel, O(1) incremental stats, persistDefaultModel,
                    subagent tracker (tool-workflow + child events → live rows)
  dsh-events.ts     local types + guards for tool-workflow/subagent/llm-retry
                    events (declaring packages not installed) + AgentView
  live-widgets.ts   LiveWidgets: Todos boxed above the input + running-agent
                    activity merged under the last-request line
                    (renderTodos/renderAgents/setLastRequest/tickLive/setTheme)
  commands.ts       CommandService: slash autocomplete + dual-channel dispatch
                    (registerLocal agentless direct / ctx.commands host path)
  messages.ts       TranscriptRenderer: session events → pi-tui components;
                    streaming setText, height-configurable panels, ReplayOp
                    buffer for theme-switch rebuilds
  footer.ts         PowerlineFooter (ported segment palette, 7 segments + clock)
  editor.ts         CwdBorderEditor (top border: 📁 cwd │ ⎇ branch)
  git.ts            GitBranchWatcher (polled, cached)
  frame.ts          FramedOverlay: shared top/bottom ─ border for every popup
  panels.ts         select-panel framework: TablePanel/FieldPanel/ViewerPanel/
                    PanelHost + padCell/columnWidths/ListController
  keymap.ts         pure key-action decision (resolveKeyAction) — Esc/Ctrl+C/
                    Ctrl+D/Ctrl+L/Ctrl+G chains with double-press guards
  hotkeys.ts        keybindings.json contract + validation + /hotkeys manager
  agent-manager.ts  agent markdown files: parse/validate/write-back engine +
                    ~/.zcode/agents seeding, `deep` policy
  agents.ts         /agents table + fields window + subagent limits panel
  subagent-policy.ts  maxAgents guard + maxRounds wrap-up injection (read live)
  subagent-viewer.ts  Ctrl+G picker + live transcript panel (300 ms tick)
  provider-catalog.ts  built-in provider directory (36 llm-pi-ai catalog
                    routes, mirrors the web Models page) + deriveKeyRef + row
                    views (pure data/functions for the Models add-provider flow)
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
  welcome.ts        startup whale banner (WHALE_ART + PIXEL_FONT glyphs)
  quotes.ts         startup quote pool
  append-system.ts  APPEND_SYSTEM.md support + todo-lifecycle section
                    maintenance (idempotent, atomic)
  theme/
    palette.ts      GitHub light/dark palettes + terminal-background detection
                    (rgbIsLight luminance)
    index.ts        buildTheme: Editor/Markdown/SelectList/chat roles, POWERLINE
                    segment palette, resolveTheme (env > preference > detect)
test/*.test.mjs     unit tests, node --test against lib/ (277 across 21 files)
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the release history.

## Status (0.2.0)

All surface commands shipped and tmux-e2e verified: `/model /think /session
/resume /new /settings /export /theme /reload /agents /subagents /hotkeys`;
provider-first Models with the add-provider flow; overlay chrome
(backgrounds + borders); theme hot-switch (immediate apply, external-change
watch, env pinning) with an app-owned canvas background that recolors the
whole screen; terminal-following `auto` theme; subagent viewer with live
rounds/tokens/elapsed; subagent `maxAgents`/`maxRounds` limits; pi-aligned
keybindings with double-press guards; live todos + subagent progress blocks;
clean Ctrl+C exit. `pnpm check` clean, 277 unit tests green, e2e run
confirmed the settings/credentials files are restored byte-for-byte.

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
