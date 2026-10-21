# Subagents

Running subagents show as compact one-line status rows below the editor — name, context use, rounds, elapsed — so delegation is visible without opening anything. `Ctrl+G` (or `/subagents`) opens a live transcript viewer; press `Enter` inside it to steer a child with a message. The `● Todos` panel keeps your task tree pinned above the input. Caps (`maxAgents`, `maxRounds`, configured via `/agents` → `l`) keep runaway delegation in check.

## Decode speed (tok/s)

The viewer header carries the child's model speed next to the token spend:

- **while a message streams** — the live in-flight rate, tilde-marked (`~87 tok/s`). It estimates from the deltas received so far and self-corrects the moment the message settles;
- **otherwise** — the cumulative decode average over the child's settled messages (`25 tok/s`).

The rate is a true decode speed: the window per message is first token → settlement, so time-to-first-token and tool time stay out of it. It never renders as a fake `0 tok/s` — with no timed traffic yet, the slot is simply absent.

*Subagents at work — one status line per child, and the `Ctrl+G` viewer streaming a child's transcript live:*

https://github.com/user-attachments/assets/0e3b64a8-a1f1-4c0a-9e60-153b31ec24b7

---

[← Back to README](../../README.md)
