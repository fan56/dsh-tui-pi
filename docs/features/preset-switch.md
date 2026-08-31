# Preset switching

`Tab` cycles agent presets, `/preset` opens a picker, `/preset <name>` jumps straight to one (`/preset next` cycles forward). The footer brand segment always shows the current selection as `dsh(<name>)`. A preset is a dsh deployment concept: each one composes a session's agent from a different set of prompt sections and model-facing tools. The shipped roster is `standard` (the full coding agent), `minimal` (fixed one-line persona + persistent shell + editor — no delegation, skills, plan mode, compaction or web), `cordis` and `ptc` (PTC; `code` on older hosts). Drop your own under `~/.dsh/.agent-presets/<id>/agent.cordis.yml` and it appears in the roster at the next launch.

## When a switch takes effect

The selection is **local to the TUI** and is read exactly once — at the moment a session is **created**:

- A session with any content keeps its preset forever. Press `/new` first; the next submit creates the session on the new preset.
- A fresh TUI that has not sent anything yet needs no `/new` — the first submit already picks the selection up.
- `/resume` ignores the selection entirely: a resumed session rejoins the preset recorded in its session header at creation time.

The footer label reflects the selection, not the live session — until the next session is created the two can legitimately disagree. (And until you touch `Tab` or `/preset`, no preset is sent at session create at all: the server-side `agent-presets.default` setting governs, the label is just a preview.)

## What a preset gates — and what it doesn't

A preset controls the **agent-plane composition**: the persona/prompt sections and the tool rows mounted for that agent. It does **not** filter **profile plugins** — those register into host-level registries once at process start, before any session exists, so their tools are visible to sessions on *every* preset.

The practical consequence: on `minimal` the native `subagent`/`workflow` tools are gone, but if the optional [@aiwayds/dsh-subagent-registry](https://github.com/fan56/dsh-subagent-registry) plugin is installed, its `use_agent` tool still works — and since this TUI fences the native `subagent` tool by default (`disableSubagent`), `use_agent` is the one delegation path left standing. **Seeing subagent calls on `minimal` is expected behavior, not a leak.** The same layering explains skills: the skill *registry* is host-level, the skill *tools* are preset-level, so `minimal` sessions see no skill catalog even though the host still loads one.

---

[← Back to README](../../README.md)
