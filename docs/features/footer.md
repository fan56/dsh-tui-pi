# Footer — live session overview

Every number that matters for a session — provider/model route, thinking level, context use, message and tool counts, plus a live clock — sits in one powerline bar pinned to the bottom, with the editor's top border showing your cwd and git branch. You see cost pressure (context %, cache-hit %) and activity without ever leaving the terminal.

```
dsh ▸ volc-ark-plan ▸ deepseek-v4-flash ▸ high ▸ 48.7k/1.0M(4.6%) ▸ ⚡ CH85.4% ▸ 15 msgs ▸ 11 tools     00:02:13
```

**Cache-hit (`CHxx%`)** is the session's cache-hit rate — the share of the session's total billed input traffic that was served from the prompt cache. It is cumulative over the whole session (a provider/model switch does not reset it) and appears only once the session has actually billed any cached tokens. (Layout: [ARCHITECTURE.md](../../ARCHITECTURE.md).)

*The footer live — route, context pressure, cache-hit rate and counters update as the session runs:*

https://github.com/user-attachments/assets/b118510b-6a02-4fee-a36a-51d8796c6a2d

---

[← Back to README](../../README.md)
