# Dynamic context pruning (DCP)

Context stays within the model window automatically: [dsh-dcp](https://github.com/fan56/dsh-dcp) compacts the session **without calling an LLM to summarize**. Mount it once and it runs transparently — the footer's context segment follows the shrink, and inside a subagent each committed compaction shows as a `🧹` notice in the viewer.

```sh
dsh plugin --profile tui add @aiwayds/dsh-dcp
```

*DCP in action — a ~50k-token multi-turn history compacted with `/dcp compact` (zero LLM calls); the footer's context count drops on the next message:*

https://github.com/user-attachments/assets/c4df056a-d715-4196-a58e-a0165e0d3b42

---

[← Back to README](../../README.md)
