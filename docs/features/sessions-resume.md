# Sessions and resume

`/resume` restores any recent session in a few keystrokes (ordered by last update), `/new` starts fresh, `/export` writes the session log as JSONL (`~/Downloads/dsh-session-<id>.jsonl`). A startup janitor (`dsh-tui.retention.*`) prunes old session logs so the store never grows without bound; the resume picker shows only the working set (`dsh-tui.resume.*`). Both are configurable in `~/.dsh/settings.yaml` with env overrides.

*Cross-process safety — a second process is refused while the session is live, and falls back to a read-only watch that mirrors the owner's turn in real time:*

https://github.com/user-attachments/assets/c73b5c44-831c-40d1-ac74-99ceee05c98c

---

[← Back to README](../../README.md)
