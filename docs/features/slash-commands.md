# Slash commands

| Command | What it does |
|---|---|
| `/model` | Two-stage provider/model picker + thinking level; `f` favorite, `h` hide, `/` filter (persisted). |
| `/think` | Reasoning-effort picker (`Off`/`High`/`Max`). |
| `/session` | Read-only info: id, cwd, model, token usage, event count. |
| `/resume` | Pick a persisted session (newest first), validate its log, restore it. |
| `/new` | Detach the current session; the next prompt opens a fresh one. |
| `/btw` | By-the-way side question while the main task runs — one tool-less model call over a recent-conversation snapshot, streamed into a temporary overlay. Never kept in the session; idle main line refuses it; `--model provider/model` overrides the route; bare `/btw` reopens the last answer (`DSH_TUI_BTW_CONTEXT_MESSAGES` sizes the snapshot). |
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

Model-list auto-sync for hand-declared (baseURL) providers is no longer a built-in command: the separate `@aiwayds/dsh-model-sync` plugin (a default dependency of this package) keeps those routes' model lists up to date on its own schedule.

Anything else falls through to the model as an ordinary prompt; dsh-native commands (`plan`, `compact`, `feedback`, `goal`, …) work unchanged.

*`/btw` in action — a side question answered in a temporary overlay while the main turn keeps running (the main line never sees it):*

https://github.com/user-attachments/assets/8f9b9754-b860-49be-b6e0-933585f6181d

---

[← Back to README](../../README.md)
