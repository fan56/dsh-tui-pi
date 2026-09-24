# Preset switching

`/preset` opens a picker, `/preset <name>` jumps straight to one (`/preset next` cycles forward). The footer brand segment shows the selection as `dsh(<name>)`. A preset is a dsh deployment concept: each one composes a session's agent from a different set of prompt sections and model-facing tools. The roster is read from the host's **agent-preset registry** (dsh 0.1.7's declarative presets): the shipped roster is `standard` (the full coding agent), `ptc` (PTC — batches of tool calls processed by the PTC runtime), `minimal` (fixed one-line persona + persistent shell + editor — no delegation, skills, plan mode, compaction or web) and `cordis` (now the **creator slot** — plugin/preset authoring; its old dynamic define/run tools were removed upstream). A preset whose declaration fails to activate stays on the roster with a ⚠ badge and the reason. There is no `Tab` binding — switching lives entirely in `/preset`.

**Migrating a 0.1.5 directory preset:** dsh 0.1.7 removed directory discovery entirely — `~/.dsh/.agent-presets/<id>/` (`agent.cordis.yml` + `preset.yml`) is no longer read by anything, and the TUI no longer lists those directories (they survive only as a roster fallback for pre-0.1.7 hosts). Re-declare the preset as a bundle-patch row instead: insert one `@deepseek-ai/dsh-agent-preset` entry into your profile's patch with the **same id** (the old directory name — sessions recorded under that id must keep resolving, or their resume fails), the `preset.yml` name/description as `name`/`description`, and the `agent.cordis.yml` plugin rows as `plugins`. Creator mode can generate this for you, or install a hand-written patch via the Plugin Manager.

## When a switch takes effect

A switch is an **explicit action that takes effect immediately**: it starts a **NEW session** on the chosen preset. With a live session, every switch path (picker `Enter`, `/preset <name>`, `/preset next`) first opens a confirmation dialog — *Switch preset to \<name\>?* (or *Restart session on \<name\>?* when the target is the current preset) — offering exactly three ways out:

- **Fork & switch** — starts the new session on the preset **seeded with this conversation**: the full log up to the last completed turn is carried over (compaction included — the new session opens on the same compacted context), and the transcript replays it. The running turn is not carried (it belongs to the old session), and the old session stays resumable via `/resume`.
- **Fresh start** — starts a new **empty** session on the preset (the same detach path as `/new`); the old session stays resumable.
- **Cancel** (or Esc) — changes nothing: neither the selection nor the current session.

Without a live session (a fresh TUI that has not sent anything yet) there is nothing to leave behind: the selection applies directly, no dialog — the first submit already creates the session on it. `/resume` ignores the selection entirely: a resumed session rejoins the preset recorded in its session header at creation time.

Because a switch either starts the new session immediately (or, on a sessionless TUI, applies to the session that is about to be created), the footer label no longer drifts from the live session — there is no "selection ≠ live preset" window to fall into. (And until you touch `/preset` at all, no preset is sent at session create: the registry's deployment default governs — the `default` / `selectedDefault` config of the `agent-preset-registry` entry (editable under `/settings → Agent Presets` where volatile) — the label is just a preview.)

## What a preset gates — and what it doesn't

A preset controls the **agent-plane composition**: the persona/prompt sections and the tool rows mounted for that agent. It does **not** filter **profile plugins** — those register into host-level registries once at process start, before any session exists, so their tools are visible to sessions on *every* preset.

A note on this TUI specifically: the TUI profile mounts its tools globally (as it did before 0.1.7), so a `/preset` selection here records the session's preset identity (`meta.agentPreset`) and lets `/preset`/fork/remember flows work, but it does not itself re-compose the running agent's tool set — switching presets changes what a NEW session composes, exactly as the confirmation dialog says.

The practical consequence: on `minimal` the native `subagent`/`workflow` tools are gone, but if the optional [@aiwayds/dsh-subagent-registry](https://github.com/fan56/dsh-subagent-registry) plugin is installed, its `use_agent` tool still works — and since this TUI fences the native `subagent` tool by default (`disableSubagent`), `use_agent` is the one delegation path left standing. **Seeing subagent calls on `minimal` is expected behavior, not a leak.** The same layering explains skills: the skill *registry* is host-level, the skill *tools* are preset-level, so `minimal` sessions see no skill catalog even though the host still loads one.

---

[← Back to README](../../README.md)
