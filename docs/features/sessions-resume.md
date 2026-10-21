# Sessions and resume

`/resume` restores any recent session in a few keystrokes (ordered by last update), `/new` starts fresh, `/export` writes the session log as JSONL (`~/Downloads/dsh-session-<id>.jsonl`). A startup janitor (`dsh-tui.retention.*`) prunes old session logs so the store never grows without bound; the resume picker shows only the working set (`dsh-tui.resume.*`). Both are configurable in the plugin's entry config (the `dsh-tui` entry of your profile patch) with env overrides.

## Session stats: speed and models used

`/session` carries a decode-speed row and a per-model breakdown alongside the token totals:

- **speed** — the session-wide decode rate in `tok/s`: summed output tokens over summed first-token → settlement wall time (time-to-first-token and tool time stay out), so it reads as the model's actual generation speed;
- **models** — every route the session actually billed, with request count, output tokens and per-model rate (`deepseek-v4-flash 2×12.3k 86t/s · hy3 1×500`). This is the real traffic from the log's route snapshots, which can differ from the current selection the `model` row shows after a mid-session `/model` switch — and it rebuilds from replayed events, so it survives resume.

The two token-count pairs share rows (`tok in/out`, `cache r/w`) to keep the panel within its small-terminal budget.

*Cross-process safety — a second process is refused while the session is live, and falls back to a read-only watch that mirrors the owner's turn in real time:*

https://github.com/user-attachments/assets/c73b5c44-831c-40d1-ac74-99ceee05c98c

---

[← Back to README](../../README.md)
