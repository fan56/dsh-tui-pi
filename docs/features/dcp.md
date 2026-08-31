# Dynamic context pruning (DCP)

Context stays within the model window automatically: [dsh-dcp](https://github.com/fan56/dsh-dcp) compacts the session **without calling an LLM to summarize**. Mount it once and it runs transparently — the footer's context segment follows the shrink, and inside a subagent each committed compaction shows as a `🧹` notice in the viewer.

```sh
dsh plugin --profile tui add @aiwayds/dsh-dcp
```

---

[← Back to README](../../README.md)
