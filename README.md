[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-tui-pi

A fully-featured pi-style terminal UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a plugin suite that turns dsh into a pi-like coding-agent experience: /history look-back & fork-at-turn, guided preset switching, live subagent steering, model profiles, 20+ built-in themes (10 light + 10 dark) with user theme directory discovery, and a powerline footer.

**Requires dsh >= 0.1.5-rc.2** — this plugin targets the dsh RC/stable line only (CI and releases resolve the newest of the `latest`/`next` dist-tags at runtime). **The alpha line is no longer supported.** A startup guard logs a one-line warning and exits cleanly when the host is older than the floor (opt out with `DSH_TUI_SKIP_HOST_CHECK=1`). See [ADR 0002](docs/adr/0002-target-dsh-0.1.2-alpha.3-single-target.md) for the now-superseded alpha single-target decision.

https://github.com/user-attachments/assets/67a7c6ca-ff42-4005-b543-437ba61771bb

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
- [**Model profiles & favorites**](docs/features/model-profiles.md) — profile switching lives in [dsh-profile-switch](https://github.com/fan56/dsh-profile-switch) now; this suite keeps the TUI read side (session seeding from the pin, live-selection bridge, scope-aware `/agents` edits) and the `/model` favorites that keep the picker small.
- [**Agent preset switching**](docs/features/preset-switch.md) — `/preset` between the shipped agent compositions (`standard`, `minimal`, …); a switch is confirmed and starts a NEW session on the preset (the current one stays resumable); what a preset really gates.
- [**Sessions & resume**](docs/features/sessions-resume.md) — sessions stay tidy automatically and resume in a few keystrokes; the host's kernel write lease keeps the log single-writer across processes.
- [**History browser**](docs/features/history.md) — `/history` opens a fixed two-pane look-back over the session: completed turns on the left, the selected turn's replies on the right; copy a prompt back to the editor, or cold-read any stored session without resuming it (read-only).
- [**Themes**](docs/features/themes.md) — 20 built-in palettes (10 light + 10 dark) plus user theme discovery (`~/.dsh/themes/`); hot-switchable, `auto` follows your terminal.
- [**Search, selection & images**](docs/features/search-selection-images.md) — `Ctrl+Shift+F` over the whole transcript, drag-select copies to the OS clipboard, attachments from web/Feishu render inline, LaTeX replies draw as Unicode math.
- [**Slash commands**](docs/features/slash-commands.md) — `/model`, `/resume`, `/btw`, … plus everything dsh-native.
- [**Settings browser & UI languages**](docs/features/settings-i18n.md) — `/settings` edits everything in place (alphabetical categories, per-provider model lists, a Subagent group); `/language` switches the UI language from any surface.
- [**Startup plugin tree**](docs/features/startup-tree.md) — every profile plugin with its installed npm version, printed at launch.

---

## Install and launch

```sh
dsh plugin --profile tui add @aiwayds/dsh-tui-pi
dsh --profile tui          # launch (or: dsh-tui-pi)
```

Legacy `session_projcache` records (written before dsh 0.1.2-alpha.4) are migrated automatically at profile load — idempotent, with per-file backups, never blocking startup; the `dsh-tui-pi` launcher runs the same preflight.

Everything that used to need manual patching — the canvas background, the `@deepseek-ai` module closure, the compaction backend — now happens automatically. Upgrade an existing profile after a release:

```sh
node scripts/dev-upgrade.mjs                  # latest
node scripts/dev-upgrade.mjs 1.0.5 --dry-run  # preview the plan first
```

---

## Uninstall

```sh
dsh plugin --profile <name> remove @aiwayds/dsh-tui-pi
```

The `dsh-tui-pi` bin shim is global and can stay; if you installed the package globally and want it gone too: `npm -g rm @aiwayds/dsh-tui-pi`.

The host cleans up the profile automatically: the `dsh.profile.bundles` entry is spliced and the whole patch layer goes away with the package — the stock `session-projection-cache` row re-enables, and the projcache wrapper, the `tool-ask-user` insert and its disable row all vanish.

User data stays on disk on purpose (deleting it is destructive; a reinstall reuses all of it): `~/.dsh/APPEND_SYSTEM.md`, `tui-command-usage.json`, `model-profiles.json`, `keybindings.json`, `~/.dsh/agents/` + `~/.dsh/skills/`, workspace `.dsh-profile` pins, the `dsh-tui:` settings section, and the session projection cache (incl. `.bak-preflight-*` migration backups). While the plugin runs, the retention janitor (default `maxCount: 100` / `maxAgeDays: 30`) deletes old session logs — uninstalling stops that, but already-deleted logs are gone. `scripts/install-font.mjs` mutates OS font/terminal state and has a documented backup; uninstall doesn't touch it.

---

## Companion plugins

**Default dependencies** — the nine plugins below ship with this package (installed into the profile's `node_modules`); activation still follows the profile's `bundles` list — list each one there to activate it.

- [@aiwayds/dsh-ask-router](https://www.npmjs.com/package/@aiwayds/dsh-ask-router) — fans every `ask_user_question` out to all answering surfaces (TUI panel, Feishu card); the first answer wins — list it in `bundles` before the UI bundles to activate.
- [@aiwayds/dsh-dcp](https://github.com/fan56/dsh-dcp) — the deterministic zero-LLM compaction backend.
- [@aiwayds/dsh-llm-proxy](https://github.com/fan56/dsh-llm-proxy) — SYSTEM proxy + per-host LLM outbound routing.
- [@aiwayds/dsh-llm-stats](https://github.com/fan56/dsh-llm-stats) — the `/llm-stats` usage ledger.
- [@aiwayds/dsh-mcp-adapter](https://github.com/fan56/dsh-mcp-adapter) — folds MCP tool schemas out of every prompt and adds the `/mcp` command ([demo](docs/features/mcp-adapter.md)).
- [@aiwayds/dsh-model-sync](https://github.com/fan56/dsh-model-sync) — syncs provider routes with the pi.dev model catalog.
- [@aiwayds/dsh-profile-switch](https://github.com/fan56/dsh-profile-switch) — `/profile-switch` + `/profile-cfg`: named model profiles switched and configured through the host's ask-user flow, on the TUI and the web (the panels this suite used to carry). Add it to your profile's `bundles` to activate.
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
| `Esc` | **Double-press to stop everything** — the first press arms, the second opens a confirmation dialog naming what is running (main turn + subagent count); `Enter` there stops the main turn AND every running subagent, `Esc` keeps everything running. A popup open closes it instead. Works while only background subagents run. |
| `Ctrl+C` | Mid-task: first press stops (same everything-stop, no dialog), second quits; idle: clears editor / quits. Held-key auto-repeat never quits. |
| `Ctrl+D` | Quit (only when the editor is empty) |
| `Ctrl+L` | Open the model/think picker |
| `Ctrl+G` | Open the subagent picker (viewer `Enter` opens steer, `x ×2` stops that subagent while it runs / closes when settled) |
| `Ctrl+O` | Pending-message queue (s steer now · d remove) |
| `Ctrl+Shift+F` | Transcript search (`Enter`/`Ctrl+G` next · `Shift+Enter`/`Ctrl+Shift+G` previous · `Esc` close) |
| `↑` / `↓` | Browse submitted-message history |

Remap any app key through `~/.dsh/keybindings.json` (a partial JSON map, live-applied) or interactively with `/hotkeys`.

---

## Configuration

Everything lives under the `dsh-tui` namespace of `~/.dsh/settings.yaml` — but you rarely touch the file: **`/settings` browses and edits it in place** (searchable categories — Agent Presets / General / Models / Plugins / TUI — with live values, per-field descriptions, and an add-provider flow under Models). Language, theme, panel height, footer hints and icon set hot-apply on change; the rest reads at the next launch.

Most knobs have sensible defaults and need no configuration. The few you might actually set:

```yaml
dsh-tui:
  language: zh-CN   # UI language — or just /language (asks on any surface; bundled: en, zh-CN, ja, ko)
  theme: auto       # auto / light / dark / any registered theme name — or /theme
  maxAgents: 4      # subagent concurrency, 0 = unlimited (also tunable in /agents → l)
```

Adding a UI language is one JSON file in `~/.dsh/locales/` — a same-id file merges per key over the bundled one, a new id registers (details: [Settings browser & UI languages](docs/features/settings-i18n.md)). The session-store janitors (`retention` / `resume`) and ask-user timeouts (`askUser`) live in the same namespace with documented defaults.

The plugin ships a bundled skill (`dsh-tui-pi-config`): ask the agent to "configure the TUI" and it collects your choices interactively and writes the section for you. **The full key table and the `DSH_TUI_*` env var list live in [skills/dsh-tui-pi-config/SKILL.md](skills/dsh-tui-pi-config/SKILL.md).**

---

## Development

```sh
pnpm check    # tsc --noEmit
pnpm build    # emit lib/
pnpm test     # unit tests, node --test against lib/ (pretest builds — the current baseline lives in AGENTS.md)
```

`pi-tui` runs pristine from npm — no patches, no fork. See [AGENTS.md](AGENTS.md) for the iron rules and quality gates.

---

## Documentation

- [docs/features/](docs/features/) — one doc per feature, with demo videos.
- [ARCHITECTURE.md](ARCHITECTURE.md) — full design: process model, layers, data flow.
- [CHANGELOG.md](CHANGELOG.md) — release history.
- [AGENTS.md](AGENTS.md) — working conventions and quality gates for contributors.
- [docs/](docs/) — design notes (steer/follow-up flow, showcase drafts, …).

---

## Compatibility note

Resuming, under a dsh 0.1.6 host, a session saved under dsh 0.1.5-rc.2 whose subagent completion notices carried reasoning content fails to serialize the first model request (upstream B-21 — host-side data issue, not a plugin defect). If `/resume` fails this way, start a new session instead.

---

## Credits

The [Ask User Question](docs/features/ask-user-question.md) interaction is inspired by [juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-ask-user-question) (adapted to this TUI's docked-panel and dsh `userQuestions` provider architecture; all code here is original).
