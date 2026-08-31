# Persistent context

`$DSH_HOME/APPEND_SYSTEM.md` (default `~/.dsh/APPEND_SYSTEM.md`, pi convention) is appended to the **main agent's** system prompt and hot-applied — edit the file and the next request sees it, no restart. The TUI seeds it from a template on first run, keeps its marked todo-lifecycle section idempotent, and never overwrites your content. Subagents are deliberately left untouched.

---

[← Back to README](../../README.md)
