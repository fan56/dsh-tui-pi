# Preset switching

`/preset` opens a picker, `/preset <name>` jumps straight to one (`/preset next` cycles forward). The footer brand segment shows the selection as `dsh(<name>)`. A preset is a dsh deployment concept: each one composes a session's agent from a different set of prompt sections and model-facing tools. The shipped roster is `standard` (the full coding agent), `minimal` (fixed one-line persona + persistent shell + editor — no delegation, skills, plan mode, compaction or web), `cordis` and `ptc` (PTC; `code` on older hosts). Drop your own under `~/.dsh/.agent-presets/<id>/agent.cordis.yml` and it appears in the roster at the next launch. There is no `Tab` binding — switching lives entirely in `/preset`.

## When a switch takes effect

A switch is an **explicit action that takes effect immediately**: it starts a **NEW session** on the chosen preset. With a live session, every switch path (picker `Enter`, `/preset <name>`, `/preset next`) first opens a confirmation dialog — *Switch preset to \<name\>?* (or *Restart session on \<name\>?* when the target is the current preset) — offering exactly three ways out:

- **Fork & switch** — starts the new session on the preset **seeded with this conversation**: the full log up to the last completed turn is carried over (compaction included — the new session opens on the same compacted context), and the transcript replays it. The running turn is not carried (it belongs to the old session), and the old session stays resumable via `/resume`.
- **Fresh start** — starts a new **empty** session on the preset (the same detach path as `/new`); the old session stays resumable.
- **Cancel** (or Esc) — changes nothing: neither the selection nor the current session.

Without a live session (a fresh TUI that has not sent anything yet) there is nothing to leave behind: the selection applies directly, no dialog — the first submit already creates the session on it. `/resume` ignores the selection entirely: a resumed session rejoins the preset recorded in its session header at creation time.

Because a switch either starts the new session immediately (or, on a sessionless TUI, applies to the session that is about to be created), the footer label no longer drifts from the live session — there is no "selection ≠ live preset" window to fall into. (And until you touch `/preset` at all, no preset is sent at session create: the server-side `agent-presets.default` setting governs, the label is just a preview.)

## What a preset gates — and what it doesn't

A preset controls the **agent-plane composition**: the persona/prompt sections and the tool rows mounted for that agent. It does **not** filter **profile plugins** — those register into host-level registries once at process start, before any session exists, so their tools are visible to sessions on *every* preset.

The practical consequence: on `minimal` the native `subagent`/`workflow` tools are gone, but if the optional [@aiwayds/dsh-subagent-registry](https://github.com/fan56/dsh-subagent-registry) plugin is installed, its `use_agent` tool still works — and since this TUI fences the native `subagent` tool by default (`disableSubagent`), `use_agent` is the one delegation path left standing. **Seeing subagent calls on `minimal` is expected behavior, not a leak.** The same layering explains skills: the skill *registry* is host-level, the skill *tools* are preset-level, so `minimal` sessions see no skill catalog even though the host still loads one.

---

[← Back to README](../../README.md)
