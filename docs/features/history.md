# History browser

`/history` is a read-only look-back over a session's past turns (ADR 0003): the
left pane lists the browsed session's **completed turns** — turn number plus a
user-message preview, in seq order (a list, not a tree: the session log has no
message-level branching) — and the right pane shows the selected turn: the user
prompts in the main transcript's bubble style, the turn's LLM replies as
Markdown, and a per-tool call-count summary (`⚙ 3 tool calls: read×2, edit×1`).

*Two panes at ≥100 columns; below that the panes stack (list above, detail
below):*

```
● History · aaaaaaaa (live)              │ Turn 1 · live snapshot
  TURN │ PROMPT                          │
  ─────┼─────────────────                │ ▎ now refactor the kerberos layer
▸    0 │ explain the websocket…          │
     1 │ now refactor the kerberos…      │ Refactored.
                                        │
                                        │ ⚙ 3 tool calls: read×2, edit×1
```

## What it does

- **`/history`** browses the current live session (a snapshot at open — turns
  finished while the viewer stays open do not appear; reopening refreshes).
  With no live session it answers with a hint instead of inventing one.
- **`/history <sessionId>`** cold-reads any stored session through the host
  persistence API (`sessionPersistence.inspect`) — no writer lock, no resume,
  no agent activation (CONTEXT.md "Cold read"). A corrupt log answers with the
  ⚠ line and points at `/resume`, which owns the repair flow.
- **Navigation** stays with the left list: ↑↓/PgUp/PgDn move, `/` filters rows
  live (substring over the preview and the turn number), Esc clears an applied
  filter before closing. **Enter or `c` copies** the selected turn's user
  prompt back into the editor — a plain `setText`, never submitted; the copy
  **replaces the editor's current content, including any unsubmitted draft,
  without a confirmation prompt** (deliberate: the browser is read-only, the
  editor is where you edit). A turn with no user prompt (injected context
  only) declines to copy with a status line. **`s`** opens a session picker
  (the `/resume` vocabulary: resumable headers only, newest update first,
  first-message previews, ⚠ corrupt markers, the browsed session marked `●`;
  `/` filters it by title, directory or session id). **`[` / `]`** page the
  detail pane; a selection change resets it to the top.
- **Focus model**: the keyboard starts on the list; **`→`** hands it to the
  detail pane (**↑**/**↓** line-scroll, **PgUp/PgDn** or **`[`/`]`** page,
  **`←`** or **Esc** steps back; every other key is inert while the detail is
  keyed). Esc grades detail → list → applied-filter-clear → close — it never
  skips a level. Focus is visible: the list's ▸ cursor demotes to `›` while
  the detail is keyed, the detail title turns accent bold and its footer
  shows `← list · ↑↓ scroll`.
- **Fixed window**: the browser opens at 90% × 85% of the terminal and its
  geometry never changes with the content — short turns pad blank rows, long
  ones scroll. Only a terminal resize re-derives the window.
- **Read-only by construction**: nothing here writes a session log, takes the
  writer lock, resends, branches, or jumps the main transcript.

## Snapshot semantics

The event list is read once per open / session switch — live session →
`session.snapshotEvents()`, stored session → `sessionPersistence.inspect()` —
and folded into completed turns by the pure `SessionEvent[] → HistoryTurn[]`
module (`src/history-turns.ts`): `turn/start … turn/end` brackets only, the
still-streaming turn of a live session excluded, `assistant/chunk` never
consumed (the assembled `assistant/message` carries the full text).

## See also

- [Sessions and resume](sessions-resume.md) — `/resume`, `/new`, `/export`
- ADR 0003 — why `/history` is a linear list, not a tree
- CONTEXT.md — "History browser" / "Cold read" terminology

---

[← Back to README](../../README.md)
