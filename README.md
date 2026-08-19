# dsh-tui-pi

pi-style terminal UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a plugin suite that turns dsh into a pi-like coding agent experience.

> 中文说明: [README.zh.md](README.zh.md)

## Screenshot

![dsh-tui-pi demo](./dsh-tui-pi-demo.gif)

A live terminal recording of a session — todos, running subagents, think/tool
panels and the powerline footer in action. ([Interactive playback on
asciinema](https://asciinema.org/a/BE212ZO8x1zEZyZn))

### Layout overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Transcript (scrollable)                                            │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  💭 thinking — reasoning in progress                        │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ⚙ bash  python scripts/demo.py  …  ✔ bash                        │
│  ↳ 生成 2 个 todo, 每个 todo 起一个 10s 的 subagent                 │
│  ↳ ⠼ Workhorse 10s 任务 · 1.2k token · 19.0s                       │
└─────────────────────────────────────────────────────────────────────┘
┌─ ● Todos (0/8) ────────────────────────────────────────────────────┐
│ ├─ ☑ 调研 dsh-tui-pi 斜杠命令/补全机制                                │
│ ├─ ◐ 调研 harness ctx.skills API                                   │
│ └─ ☐ 实现 /skill:<name> 补全并触发 skill                             │
└─────────────────────────────────────────────────────────────────────┘
∴ working…                                                            │
~/github (Full access) │ ⎇ main                                       │
[ 请输入指令…                                                       ] │
 ↳ 第一 打slash 命令的时候 显示 /skill:<skill name> 选择后使用          │
  ↳ ⠼ 牛马狗  · 1.5m/1m · 635.7s                                      │
dsh ▸ volc-ark-plan ▸ deepseek-v4-flash ▸ high ▸ 48.7k/1.0M(4.6%)   │
     ▸ ⚡ CH85.4% ▸ 15 msgs ▸ 11 tools                  00:02:13     │
 Esc ×2: stop · Ctrl+C ×2: quit · Ctrl+G: subagents · ↑↓: history   │
└─────────────────────────────────────────────────────────────────────┘
         │                       │                │
         │                       │                └─ Footer (powerline)
         │                       └─ Running subagents (last-request area)
         └─ Todos panel (bordered, above editor)
```

---

## Features

### Footer

A powerline-style status bar pinned at the bottom of the screen, showing live session state at a glance:

```
dsh ▸ volc-ark-plan ▸ deepseek-v4-flash ▸ high ▸ 48.7k/1.0M(4.6%) ▸ ⚡ CH85.4% ▸ 15 msgs ▸ 11 tools     00:02:13
```

Seven segments read O(1) maintained counters (never re-scan the session log):

| Segment | Content |
|---|---|
| **Provider** | current `provider/model` route |
| **Model** | model short-name |
| **Thinking** | reasoning effort level (`off` / `high` / `max`) |
| **Context** | `used / max (percent%)` |
| **Cache-hit** | `CHxx%` — prompt-cache hit rate |
| **Messages** | total user + assistant messages |
| **Tools** | total tool invocations |
| **Clock** | live right-aligned HH:MM:SS (tick every second) |

Segments are rendered with [U+E0B0](https://www.nerdfonts.com/cheat-sheet) powerline arrows; the palette is hot-swappable with the current theme.

The editor's top border shows the working directory and git branch:

```
~/github (Full access) │ ⎇ main
```

---

### Think & Tool Blocks

In-flight thinking and tool calls render as fixed **panels pinned above the chat input** (they never appear in the scrollable transcript):

```
┌─ 💭 thinking ──────────────────────────────────────────────┐
│ Actually, I can check list_agents or wait…                 │
└────────────────────────────────────────────────────────────┘
⚙ bash  python scripts/demo.py  …  ✔ bash
```

Key behavior:

- **One panel per type** — a single `ThinkPanel` and a single `ToolPanel` exist for the whole run; each event refreshes the panel in place, so there's no transcript churn.
- **Empty = hidden** — when nothing is active, the panel renders zero rows and disappears.
- **`dsh-tui.panelHeight`** (default `1`): one borderless row (block id + elapsed + last content line, right-truncated); `5`/`7`/`10` renders a boxed panel; `all` prints the full body.
- **Delegation tools** (`use_agent`, `subagent`, `workflow`, `ralph`) never open a tool block — their children appear as running-agent lines (see Subagents).

---

### Subagents

Running subagent activity is shown in the **last-request area below the editor** as compact, one-line-per-child status rows:

```
↳ 创建 2 个 todo, 每个 todo 起一个 10s 的 subagent
  ↳ ⠼ Subagent A 10s 任务 · 1.2k token · 19.0s
  ↳ ⠼ Subagent B 10s 任务 · 562 token · 6.0s
```

Each line shows: spinner + agent **name**, retries (`↻N≤M`), token count (+ context %), elapsed. No provider shown, no box, no header — just one line per running child.

#### Todos

The `● Todos (done/total)` tree is a bordered panel pinned **above the chat input** (never scrolls with the transcript):

```
┌─ ● Todos (0/8) ──────────────────────────────────────────┐
│ ├─ ☑ Todo 1: research subagent spawn API                 │
│ ├─ ◐ Todo 2: implement /skill:<name> autocomplete        │
│ └─ ☐ Todo 3: add settings panel skills branch            │
└───────────────────────────────────────────────────────────┘
```

Icons: `☑` completed, `◐` in-progress, `☐` pending. A settled child drops off; when empty, both the todo panel and agent lines collapse to zero rows.

#### Viewer & limits

`Ctrl+G` (or `/subagents`) opens an 80% picker over tracked children — running ones first, then the five most recently settled. Enter opens a live transcript viewer (refreshes ~3×/s with tail-follow).

Two caps (`/agents` → `l` to configure):

- **`maxAgents`** (default 4, `0` = unlimited) — spawns are denied when the cap is hit.
- **`maxRounds`** (default 50, `0` = unlimited) — after a child's completed turns reach the cap, the TUI queues one wrap-up request and never force-stops.

---

### DCP (Dynamic Context Pruning)

[DCP](https://github.com/fan56/dsh-dcp) is a standalone zero-LLM compaction plugin for dsh — it automatically trims context to stay within limits without calling an LLM to summarize.

`dsh-tui-pi` lists `@aiwayds/dsh-dcp` as a dependency, but **does not mount it** — dsh-dcp ships its own `cordis.patch.yml` (since `@aiwayds/dsh-dcp@0.2.0`). To activate:

```sh
dsh plugin --profile tui add @aiwayds/dsh-dcp
```

Once mounted, DCP runs transparently in the background. The footer's **context** and **cache-hit** segments reflect the pruning effect in real time.

---

## Slash commands

| Command | What it does |
|---|---|
| `/model` | Two-stage provider/model picker (then thinking level). Live switch, persisted. |
| `/think` | Reasoning-effort picker for the current model (`Off`/`High`/`Max`). |
| `/session` | Read-only info panel: id, cwd, model, token usage, event count. |
| `/resume` | Pick a persisted session, validate its log, then restore it. |
| `/new` | Detach the current session; the next prompt opens a fresh one. |
| `/settings` | Text-based settings browser (namespaces, schema walk, inline editors, secrets masked). |
| `/export` | Write the current session log as JSONL (`~/Downloads/dsh-session-<id>.jsonl`). |
| `/permission` | Permission-preset picker (read-only / workspace-write / danger-full-access). |
| `/theme` | Color-scheme picker (`auto` / `light` / `dark`). Applies immediately. |
| `/agents` | Manage agent markdown files + subagent limits (`maxAgents`, `maxRounds`). |
| `/subagents` | Pick a running/recent subagent and watch its live transcript. |
| `/reload` | Hot-reload the plugin from source (after `pnpm build`) without restarting dsh. |
| `/hotkeys` | Keybinding browser and live editor. |

Anything that is not a resolvable command falls through to the model as an ordinary prompt.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Enter` | Send the prompt |
| `Esc` | **Double-press to stop** — single press arms (500ms window); popup open → closes popup instead; empty editor → second press opens `/session` |
| `Ctrl+C` | Mid-turn: first press cancels turn, second quits. Idle: clears editor / quits. **Held-key auto-repeat never quits.** |
| `Ctrl+D` | Quit (only when editor is empty) |
| `Ctrl+L` | Open model/think picker |
| `Ctrl+G` | Open subagent picker (while children are running) |
| `Tab` | Autocomplete |
| `↑` / `↓` | Browse submitted-message history (shell-style, 500 entries) |

### Custom keybindings

Remap any app key through `~/.dsh/keybindings.json` — a partial JSON map of app keys to key ids (`ctrl+letter`, `alt+letter`, named keys). Edit by hand or use `/hotkeys` to change interactively (live-applied, no restart).

---

## Themes

GitHub light / GitHub dark palettes, hot-switchable at runtime:

- `/theme` — live picker; the whole screen repaints including background.
- `DSH_TUI_THEME=light|dark` — env pin that wins over preference.
- `DSH_TUI_TRANSPARENT=1` — see-through canvas (terminal background shows through).
- `auto` mode detects the terminal and follows live light/dark switches.

The full-screen canvas background ships inside the package — a write-stream
decorator (`src/canvas-terminal.ts`) paints every erase sequence with the
theme color via BCE, no patched dependencies.

---

## Install (local)

```sh
# build + pack + install into the profile in one step
node scripts/dev-install.mjs        # pnpm build → pnpm pack → refresh profile copies

# or manually:
pnpm pack                            # → aiwayds-dsh-tui-pi-<version>.tgz
dsh plugin --profile tui add /path/to/aiwayds-dsh-tui-pi-<version>.tgz
```

The profile's `package.json` carries two keys pointing at the tarball:
`dsh-tui-pi` (dsh resolves the bundle by this name) and
`@aiwayds/dsh-tui-pi` (the loader entry in `cordis.patch.yml`).

## Install (npm)

Install the full dsh plugin suite into a fresh profile:

```sh
dsh plugin --profile tui add @aiwayds/dsh-tui-pi
dsh plugin --profile tui add @aiwayds/dsh-subagent-registry
dsh plugin --profile tui add @aiwayds/dsh-dcp
```

Then launch:

```sh
dsh --profile tui
```

**What happens automatically:**

- dsh registers all three plugins in `dsh.profile.bundles` (via `reconcilePlugins`).
- dsh sets `autoInstallPeers: false` in the profile's `pnpm-workspace.yaml`.
- On first boot, dsh calls `healProfilesModuleFallback` to create symlinks
  under `~/.dsh/profiles/node_modules/@deepseek-ai/*` → the global dsh
  closure (`$(which dsh)/../../node_modules/@deepseek-ai`). This gives all
  plugins a single `@deepseek-ai/cordis` instance — no manual closure setup
  is needed.
- `compaction-basic` is disabled by `@aiwayds/dsh-dcp`'s patch; dsh-dcp
  takes over as the compaction backend.

**What does NOT happen automatically:**

- Nothing patch-related anymore: since 0.8.0 the repo and the npm package
  run the same pristine `@earendil-works/pi-tui` — the canvas background is
  painted by our own write-stream decorator (BCE), which ships in the
  package and needs no `pnpm-workspace.yaml` entries in consumer profiles.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find package '<name>' imported from ~/.dsh/profiles/...` | A bundle's `cordis.patch.yml` `name` field doesn't match the scoped package name. | Update the plugin; all `@aiwayds/*` plugins now use `name: '@aiwayds/<pkg>'` in their patch. |
| `Cannot read properties of undefined (reading 'prepare')` | Duplicate `@deepseek-ai/cordis` module instances (two physical copies in the profile tree). | See iron rule 8 in AGENTS.md. Delete physical `~/.dsh/profiles/tui/node_modules/@deepseek-ai` copies and let dsh heal the fallback: `rm -rf ~/.dsh/profiles/tui/node_modules/@deepseek-ai && dsh --profile tui` (the heal recreates them as symlinks). |
| pnpm `Peer dependencies that should be installed: @deepseek-ai/...` warning | A plugin declares `@deepseek-ai/*` as regular `dependencies` instead of `peerDependencies`. | Update the plugin (all `@aiwayds/*` dsh plugins use optional peerDeps). The warning is harmless — pnpm doesn't auto-install optional peers. |
| pnpm `Ignored build scripts: @aiwayds/dsh-tui-pi@...` warning | pnpm 10 blocks build scripts by default; the tui-pi postinstall (`link-dsh-closure.mjs`) was skipped. | This is expected and **harmless** — the postinstall only matters for the repo dev flow, not npm consumers. dsh handles closure linking via `healProfilesModuleFallback`. |

---

## Use

```sh
dsh --profile tui        # or: dsh-tui-pi (bin shim)
```

---

## Dev

```sh
pnpm check    # tsc --noEmit
pnpm build    # emit lib/
pnpm test     # unit tests, node --test against lib/ (386 tests, pretest builds)
```

Local type-checking symlinks `node_modules/@deepseek-ai/*` to the installed
dsh closure (`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules`);
those symlinks stay out of any tarball. `scripts/link-dsh-closure.mjs` (the
package's `postinstall`) re-creates every link after each `pnpm install`.

**pi-tui**: pristine `@earendil-works/pi-tui` 0.84.2 from npm — no patches,
no fork. The full-screen canvas background is our own write-stream decorator
(`src/canvas-terminal.ts`, BCE).

---

## Layout

```
bin/dsh-tui-pi        launcher shim (exec dsh --profile tui)
cordis.patch.yml      bundle patch: mounts the plugin as `tui-pi`
src/
  index.ts            cordis plugin entry: command registration, footer,
                      git watcher, clock, bridge, theme hot-swap, shutdown
  tui.ts              alt-screen tree, transcript ScrollView, dock, canvas bg
  session.ts          DshSessionBridge: agent create, followup, resume,
                      O(1) incremental stats, subagent tracker
  live-widgets.ts     Todos panel + running-agent activity lines
  messages.ts         TranscriptRenderer: session events → pi-tui components,
                      streaming setText, height-configurable panels
  footer.ts           PowerlineFooter (7 segments + clock)
  editor.ts           CwdBorderEditor (top border: cwd + git branch)
  subagent-policy.ts  maxAgents guard + maxRounds wrap-up injection
  subagent-viewer.ts  Ctrl+G picker + live transcript panel
  theme/              GitHub light/dark palettes + terminal detection
test/*.test.mjs       unit tests (296 across 24 files)
```

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the release history.
