[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-tui-pi

pi-style terminal UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a plugin suite that turns dsh into a pi-like coding-agent experience: pi-tui look & feel, dsh slash commands, GitHub light/dark themes and a powerline footer.

**Compatibility:** tested against dsh `0.1.1-rc.2`; slash commands keep working across dsh-commands' `execute()` signature change (pre-rc.8 3-arg → current 4-arg).

https://github.com/user-attachments/assets/6a7e00bb-1fd0-4bc5-9070-457f1e9fa54d

*A live recording of a session (MP4, 1.5× speed) — todos, running subagents, think/tool panels and the powerline footer in action.*

## ✨ Features

> Each item links to its section below — one line for what it gives you.

- [**Footer — live session overview**](#footer) — provider/model, context pressure and the session cache-hit rate at a glance, always in view.
- [**Think & tool panels**](#think-and-tool-panels) — reasoning and tool activity stay out of the transcript, so the conversation reads clean.
- [**Subagents**](#subagents) — every running subagent gets a status line; watch and steer it live.
- [**Ask User Question**](#ask-user-question) — the model can pause and ask you structured questions, answered without leaving the TUI.
- [**Feishu integration demo**](#feishu-integration-demo) — dsh-tui-pi on the desktop and Feishu/Lark on the phone driving (and answering for) the same dsh session.
- [**Dynamic context pruning (DCP)**](#dynamic-context-pruning-dcp) — context stays within limits automatically, with zero LLM calls.
- [**Persistent context**](#persistent-context) — your ground rules ride along on every request, hot-applied with no restart.
- [**Model profiles & favorites**](#model-profiles-and-favorites) — switch a whole model setup per project and keep the picker small.
- [**Sessions & resume**](#sessions-and-resume) — sessions stay tidy automatically and resume in a few keystrokes.
- [**Themes**](#themes) — GitHub light/dark palettes, hot-switchable; `auto` follows your terminal.

---

## Footer

Every number that matters for a session — provider/model route, thinking level, context use, message and tool counts, plus a live clock — sits in one powerline bar pinned at the bottom, with the editor's top border showing your cwd and git branch. You see cost pressure (context %, cache-hit %) and activity without ever leaving the terminal.

```
dsh ▸ volc-ark-plan ▸ deepseek-v4-flash ▸ high ▸ 48.7k/1.0M(4.6%) ▸ ⚡ CH85.4% ▸ 15 msgs ▸ 11 tools     00:02:13
```

**Cache-hit (`CHxx%`)** is the session's cache-hit rate — the share of the session's total billed input traffic that was served from the prompt cache. It is cumulative over the whole session (a provider/model switch does not reset it) and appears only once the session has actually billed any cached tokens. (Layout: [ARCHITECTURE.md](ARCHITECTURE.md).)

---

## Think and tool panels

Live reasoning and tool calls render as fixed panels pinned **above the chat input** instead of scrolling into the transcript, so the conversation thread stays readable. Panels appear only while something is active, and their height is configurable (`dsh-tui.panelHeight`: `1` line, `5`/`7`/`10` boxed rows, or `all`).

---

## Subagents

Running subagents show as compact one-line status rows below the editor — name, context use, rounds, elapsed — so delegation is visible without opening anything. `Ctrl+G` (or `/subagents`) opens a live transcript viewer; press `Enter` inside it to steer a child with a message. The `● Todos` panel keeps your task tree pinned above the input. Caps (`maxAgents`, `maxRounds`, configured via `/agents` → `l`) keep runaway delegation in check.

---

## Ask User Question

While mid-turn, the model can pause and ask you structured questions via the `ask_user_question` tool; the answering side is a docked panel above the input — no window juggling. One question at a time with tabs for the rest, `Ctrl+T` folds the panel away, double-`Esc` declines. Free text, multi-select, a multi-question review page, bracketed-paste and right-click / `Ctrl+Shift+C` system-clipboard paste are all supported.

See the ask-question flow in action:

https://github.com/user-attachments/assets/aa36be36-a508-4f53-ba85-efe0394dab11

---

## Feishu integration demo

dsh-tui-pi on the desktop and Feishu/Lark on the phone driving (and answering for) the same dsh session:

https://github.com/user-attachments/assets/177e8839-523b-487e-b3d1-6d725cd8aba5

https://github.com/user-attachments/assets/c0d7092f-deda-4443-b75a-2bc93bd30d86

Demos courtesy of the [dsh-feishu Demos issue](https://github.com/fan56/dsh-feishu/issues/1).

---

## Dynamic context pruning (DCP)

Context stays within the model window automatically: [dsh-dcp](https://github.com/fan56/dsh-dcp) compacts the session **without calling an LLM to summarize**. Mount it once and it runs transparently — the footer's context segment follows the shrink, and inside a subagent each committed compaction shows as a `🧹` notice in the viewer.

```sh
dsh plugin --profile tui add @aiwayds/dsh-dcp
```

---

## Persistent context

`$DSH_HOME/APPEND_SYSTEM.md` (default `~/.dsh/APPEND_SYSTEM.md`, pi convention) is appended to the **main agent's** system prompt and hot-applied — edit the file and the next request sees it, no restart. The TUI seeds it from a template on first run, keeps its marked todo-lifecycle section idempotent, and never overwrites your content. Subagents are deliberately left untouched.

---

## Model profiles and favorites

`/profile-switch` swaps a whole setup — default model, thinking level and every subagent's model — in one pick; `p` pins a profile to the current directory so every new session in that tree loads it. `/model` favorites and hidden lists keep the picker small. Manage profiles with `/profile-cfg` (roster, edit, save-current, rename, delete).

---

## Sessions and resume

`/resume` restores any recent session in a few keystrokes (ordered by last update), `/new` starts fresh, `/export` writes the session log as JSONL (`~/Downloads/dsh-session-<id>.jsonl`). A startup janitor (`dsh-tui.retention.*`) prunes old session logs so the store never grows without bound; the resume picker shows only the working set (`dsh-tui.resume.*`). Both are configurable in `~/.dsh/settings.yaml` with env overrides.

---

## Themes

GitHub light/dark palettes, hot-switched with `/theme`; `auto` detects your terminal and follows live light/dark switches. `DSH_TUI_THEME=light|dark` pins a scheme, `DSH_TUI_TRANSPARENT=1` makes the canvas see-through, `DSH_TUI_MOUSE=buttons|all|off` tunes mouse tracking.

---

## Slash commands

| Command | What it does |
|---|---|
| `/model` | Two-stage provider/model picker + thinking level; `f` favorite, `h` hide, `/` filter (persisted). |
| `/think` | Reasoning-effort picker (`Off`/`High`/`Max`). |
| `/session` | Read-only info: id, cwd, model, token usage, event count. |
| `/resume` | Pick a persisted session (newest first), validate its log, restore it. |
| `/new` | Detach the current session; the next prompt opens a fresh one. |
| `/settings` | Text-based settings browser (namespaces, schema walk, secrets masked). |
| `/export` | Write the current session log as JSONL. |
| `/permission` | Permission-preset picker (read-only / workspace-write / danger-full-access). |
| `/theme` | Color-scheme picker (`auto`/`light`/`dark`), applies immediately. |
| `/preset` | Agent-preset picker; `<name>` switches directly, `next` cycles (same as `Tab`). |
| `/profile-switch` | Apply a model profile to the live selection, the persisted default and the agent files; `p` pins the cwd. |
| `/profile-cfg` | Manage profiles: edit default model / think / per-agent models, `s` save current, `n` new, `r` rename, `d` delete. |
| `/agents` | Manage agent markdown files + subagent limits (`maxAgents`, `maxRounds`). |
| `/subagents` | Pick a running/recent subagent and watch its live transcript; `Enter` steers it. |
| `/skills` | Manage user skills (installed and available). |
| `/reload` | Hot-reload the plugin from source after `pnpm build`. |
| `/login` | Log in to a provider (or `/login openai`); **Custom provider…** adds any OpenAI/Anthropic-compatible gateway. |
| `/logout` | Remove a provider's stored key and profile. |
| `/hotkeys` | Keybinding browser and live editor. |

Model-list auto-sync for hand-declared (baseURL) providers is no longer a
built-in command: the separate `@aiwayds/dsh-model-sync` plugin (a default
dependency of this package) keeps those routes' model lists up to date on its
own schedule.

Anything else falls through to the model as an ordinary prompt; dsh-native commands (`plan`, `compact`, `feedback`, `goal`, …) work unchanged.

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

Other knobs: `dsh-tui.panelHeight` (think/tool panel height), `dsh-tui.iconSet` (`auto`/`nerdfont`/`plain` — powerline glyphs adapt to your font; install a Nerd Font with `node scripts/install-font.mjs`), `~/.dsh/keybindings.json` (key remaps).

---

## Install and launch

```sh
dsh plugin --profile tui add @aiwayds/dsh-tui-pi
dsh plugin --profile tui add @aiwayds/dsh-subagent-registry   # optional
dsh plugin --profile tui add @aiwayds/dsh-dcp                 # optional
dsh --profile tui          # launch (or: dsh-tui-pi)
```

Everything that used to need manual patching — the canvas background, the `@deepseek-ai` module closure, the compaction backend — now happens automatically. Upgrade an existing profile after a release:

```sh
node scripts/dev-upgrade.mjs                  # latest
node scripts/dev-upgrade.mjs 1.0.5 --dry-run  # preview the plan first
```

---

## Companion plugins

- [@aiwayds/dsh-ask-router](https://www.npmjs.com/package/@aiwayds/dsh-ask-router) — ships as a default dependency; fans every `ask_user_question` out to all answering surfaces (TUI panel, Feishu card) and the first answer wins. List it in the profile's `bundles` before the UI bundles to activate.
- [@aiwayds/dsh-feishu](https://github.com/fan56/dsh-feishu) — optional; drives the same dsh session from Feishu/Lark on your phone, including an ask-user card surface. Install into the same profile for phone-side participation.

---

## Development

```sh
pnpm check    # tsc --noEmit
pnpm build    # emit lib/
pnpm test     # unit tests, node --test against lib/ (pretest builds; 1020 tests across 55 files)
```

`pi-tui` runs pristine from npm — no patches, no fork. See [AGENTS.md](AGENTS.md) for the iron rules and quality gates.

---

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — full design: process model, layers, data flow.
- [HANDOFF.md](HANDOFF.md) — session history and current state (Chinese).
- [CHANGELOG.md](CHANGELOG.md) — release history.
- [AGENTS.md](AGENTS.md) — working conventions and quality gates for contributors.
- [docs/](docs/) — design notes (steer/follow-up flow, showcase drafts, …).

---

## Credits

The [Ask User Question](#ask-user-question) interaction is inspired by [juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-ask-user-question) (adapted to this TUI's docked-panel and dsh `userQuestions` provider architecture; all code here is original).
