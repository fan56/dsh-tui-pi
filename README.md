[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-tui-pi

pi-style terminal UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a plugin suite that turns dsh into a pi-like coding-agent experience: pi-tui look & feel, dsh slash commands, GitHub light/dark themes and a powerline footer.

**Requires dsh >= 0.1.2-rc.1** — this plugin targets the dsh RC/stable line only (CI and releases resolve the newest of the `latest`/`next` dist-tags at runtime). **The alpha line is no longer supported.** A startup guard logs a one-line warning and exits cleanly when the host is older than the floor (opt out with `DSH_TUI_SKIP_HOST_CHECK=1`). See [ADR 0002](docs/adr/0002-target-dsh-0.1.2-alpha.3-single-target.md) for the now-superseded alpha single-target decision.

https://github.com/user-attachments/assets/6a7e00bb-1fd0-4bc5-9070-457f1e9fa54d

*A live recording of a session (MP4, 1.5× speed) — todos, running subagents, think/tool panels and the powerline footer in action.*

## ✨ Features

> Each item links to its own doc under [`docs/features/`](docs/features/) — one line here, the details (and demo videos) there.

- [**Footer — live session overview**](docs/features/footer.md) — provider/model, context pressure and the session cache-hit rate at a glance, always in view.
- [**Think & tool panels**](docs/features/think-tool-panels.md) — reasoning and tool activity stay out of the transcript, so the conversation reads clean.
- [**Subagents**](docs/features/subagents.md) — every running subagent gets a status line; watch and steer it live.
- [**Ask User Question**](docs/features/ask-user-question.md) — the model can pause and ask you structured questions, answered without leaving the TUI.
- [**Feishu integration**](docs/features/feishu-demo.md) — dsh-tui-pi on the desktop and Feishu/Lark on the phone driving (and answering for) the same dsh session.
- [**Dynamic context pruning (DCP)**](docs/features/dcp.md) — context stays within limits automatically, with zero LLM calls.
- [**Persistent context**](docs/features/persistent-context.md) — your ground rules ride along on every request, hot-applied with no restart.
- [**Model profiles & favorites**](docs/features/model-profiles.md) — switch a whole model setup per project and keep the picker small.
- [**Agent preset switching**](docs/features/preset-switch.md) — `Tab` / `/preset` between the shipped agent compositions (`standard`, `minimal`, …); what a preset really gates, and exactly when a switch takes effect.
- [**Sessions & resume**](docs/features/sessions-resume.md) — sessions stay tidy automatically and resume in a few keystrokes; a cross-process writer guard keeps the log single-writer.
- [**Themes**](docs/features/themes.md) — GitHub light/dark palettes, hot-switchable; `auto` follows your terminal.
- [**Search, selection & images**](docs/features/search-selection-images.md) — `Ctrl+Shift+F` over the whole transcript, drag-select copies to the OS clipboard, attachments from web/Feishu render inline, LaTeX replies draw as Unicode math.
- [**Slash commands**](docs/features/slash-commands.md) — `/model`, `/resume`, `/btw`, `/profile-switch`, … plus everything dsh-native.
- [**Startup plugin tree**](docs/features/startup-tree.md) — every profile plugin with its installed npm version, printed at launch.

---

## Install and launch

```sh
dsh plugin --profile tui add @aiwayds/dsh-tui-pi
dsh --profile tui          # launch (or: dsh-tui-pi)
```

Legacy `session_projcache` records (missing `identity.isSeeded`/`identity.inheritedEventCount`, written before dsh 0.1.2-alpha.4 — predating the rc/stable floor of 0.1.2-rc.1 this plugin now targets) are migrated at the profile layer: the bundle patch replaces the stock `session-projection-cache` row with a wrapper (`@aiwayds/dsh-tui-pi/projcache`) that backfills the records while its module loads — strictly before the stock plugin could open the domain and crash the boot — so every `dsh --profile tui` start is covered, launcher or not. Migration is idempotent, backs up every rewritten file next to the original, and never blocks startup. The `dsh-tui-pi` launcher additionally runs the same migration as a CLI preflight before `exec dsh`.

Everything that used to need manual patching — the canvas background, the `@deepseek-ai` module closure, the compaction backend — now happens automatically. Upgrade an existing profile after a release:

```sh
node scripts/dev-upgrade.mjs                  # latest
node scripts/dev-upgrade.mjs 1.0.5 --dry-run  # preview the plan first
```

---

## Companion plugins

**Default dependencies** — the eight plugins below ship with this package (installed into the profile's `node_modules`); activation still follows the profile's `bundles` list — list each one there to activate it.

- [@aiwayds/dsh-ask-router](https://www.npmjs.com/package/@aiwayds/dsh-ask-router) — fans every `ask_user_question` out to all answering surfaces (TUI panel, Feishu card); the first answer wins — list it in `bundles` before the UI bundles to activate.
- [@aiwayds/dsh-dcp](https://github.com/fan56/dsh-dcp) — the deterministic zero-LLM compaction backend.
- [@aiwayds/dsh-llm-proxy](https://github.com/fan56/dsh-llm-proxy) — SYSTEM proxy + per-host LLM outbound routing.
- [@aiwayds/dsh-llm-stats](https://github.com/fan56/dsh-llm-stats) — the `/llm-stats` usage ledger.
- [@aiwayds/dsh-mcp-adapter](https://github.com/fan56/dsh-mcp-adapter) — folds MCP tool schemas out of every prompt and adds the `/mcp` command ([demo](docs/features/mcp-adapter.md)).
- [@aiwayds/dsh-model-sync](https://github.com/fan56/dsh-model-sync) — syncs provider routes with the pi.dev model catalog.
- [@aiwayds/dsh-subagent-registry](https://github.com/fan56/dsh-subagent-registry) — registers `~/.dsh/agents/*.md` as `use_agent` subagents.
- [@aiwayds/dsh-web-search-anysearch](https://github.com/fan56/dsh-web-search-anysearch) — the AnySearch web search provider.

**Recommended install** — [@aiwayds/dsh-topics-memory](https://github.com/fan56/dsh-topics-memory), OKF topic memory for dsh (zero-LLM hot-path injection + a local git-tracked bundle; formerly dsh-llmwiki-memory):

```sh
dsh plugin --profile tui add @aiwayds/dsh-topics-memory
```

**Optional** — [@aiwayds/dsh-feishu](https://github.com/fan56/dsh-feishu) — drives the same dsh session from Feishu/Lark on your phone ([demo](docs/features/feishu-demo.md)).

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Enter` | Send the prompt |
| `Esc` | **Double-press to stop** (single press arms; a popup open closes it instead) |
| `Ctrl+C` | Mid-turn: first press cancels, second quits; idle: clears editor / quits. Held-key auto-repeat never quits. |
| `Ctrl+D` | Quit (only when the editor is empty) |
| `Ctrl+L` | Open the model/think picker |
| `Ctrl+G` | Open the subagent picker (viewer `Enter` opens steer) |
| `Ctrl+O` | Pending-message queue (s steer now · d remove) |
| `Ctrl+Shift+F` | Transcript search (`Enter`/`Ctrl+G` next · `Shift+Enter`/`Ctrl+Shift+G` previous · `Esc` close) |
| `Tab` | Cycle agent presets |
| `↑` / `↓` | Browse submitted-message history |

Remap any app key through `~/.dsh/keybindings.json` (a partial JSON map, live-applied) or interactively with `/hotkeys`.

---

## Configuration

Session-store knobs under the `dsh-tui` settings namespace in `~/.dsh/settings.yaml` (each also has an env override, `DSH_TUI_RETENTION_*` / `DSH_TUI_RESUME_*`; precedence: settings.yaml > env > default):

```yaml
dsh-tui:
  retention:        # startup janitor for ~/.dsh/sessions — DELETES old logs. Once per startup.
    maxCount: 100   # <= 0 disables the janitor
    maxAgeDays: 7
    minIdleHours: 24
  resume:           # /resume display filter — only HIDES picker rows, never deletes.
    maxAgeDays: 7
    minBytes: 20480
```

Other knobs: `dsh-tui.panelHeight` (think/tool panel height), `dsh-tui.iconSet` (`auto`/`nerdfont`/`plain` — powerline glyphs adapt to your font; install a Nerd Font with `node scripts/install-font.mjs`), `dsh-tui.footerHints` (toggle each footer hint segment, incl. `search`), `DSH_TUI_COPY_ON_SELECT=0` (keep drag-selection visual-only), `~/.dsh/keybindings.json` (key remaps).

---

## Development

```sh
pnpm check    # tsc --noEmit
pnpm build    # emit lib/
pnpm test     # unit tests, node --test against lib/ (pretest builds; 1,100+ tests across 60+ files — see HANDOFF.md for the current baseline)
```

`pi-tui` runs pristine from npm — no patches, no fork. See [AGENTS.md](AGENTS.md) for the iron rules and quality gates.

---

## Documentation

- [docs/features/](docs/features/) — one doc per feature, with demo videos.
- [ARCHITECTURE.md](ARCHITECTURE.md) — full design: process model, layers, data flow.
- [HANDOFF.md](HANDOFF.md) — session history and current state (Chinese).
- [CHANGELOG.md](CHANGELOG.md) — release history.
- [AGENTS.md](AGENTS.md) — working conventions and quality gates for contributors.
- [docs/](docs/) — design notes (steer/follow-up flow, showcase drafts, …).

---

## Credits

The [Ask User Question](docs/features/ask-user-question.md) interaction is inspired by [juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-ask-user-question) (adapted to this TUI's docked-panel and dsh `userQuestions` provider architecture; all code here is original).
