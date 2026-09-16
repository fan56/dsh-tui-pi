# Ask User Question

While mid-turn, the model can pause and ask you structured questions via the `ask_user_question` tool; the answering side is a docked panel above the input — no window juggling. One question at a time with tabs for the rest, `Ctrl+T` folds the panel away, double-`Esc` declines. Free text, multi-select, a multi-question review page, bracketed-paste and right-click / `Ctrl+Shift+C` system-clipboard paste are all supported.

## Timeouts — the panel never waits forever

Every question carries two auto-answer budgets (default **5 min idle / 10 min absolute**). A panel left hanging — you walked away, or the question landed while you were heads-down — resolves itself instead of stalling the run:

- **Idle window (5 min)** — no keypress for this long auto-answers the focused question. Any key restarts it: as long as you are interacting, nothing is ever forced.
- **Absolute cap (10 min)** — fires even under continuous input, so a run can never be held hostage.

When a timer fires:

- Unanswered questions take the **recommended option** (the dsh tool contract marks it by putting it first — "(Recommended)").
- **Plans are never auto-approved**: a `plan-review` question picks a non-approve option (or answers with a decline note).
- A half-typed free-text buffer is committed as your answer (the same commit-on-exit semantics the ↑↓ path uses).
- Each automatic pick is **declared to the model in-band** — the answer's `custom` field carries a note (`Auto-answered after the no-input timeout: …`), so the model knows it was not a human choice and can re-ask later if it matters.
- Once nothing is left unanswered the panel settles immediately (the review page is a human double-check an absent human cannot do); a review-page timeout submits the answers already given. A transient footer notice reports what happened.
- The panel footer shows a live `· auto in m:ss` countdown while a timer is armed.

Configure through the `dsh-tui` settings namespace (precedence: settings.yaml > env > default; `<= 0` disables a rule; both rules off = wait forever):

```yaml
dsh-tui:
  askUser:
    idleMinutes: 5       # no-input window per question; <= 0 disables (env: DSH_TUI_ASK_USER_IDLE_MINUTES)
    absoluteMinutes: 10  # hard cap per question, even with input; <= 0 disables (env: DSH_TUI_ASK_USER_ABSOLUTE_MINUTES)
```

The ask-question flow in action:

https://github.com/user-attachments/assets/aa36be36-a508-4f53-ba85-efe0394dab11

---

[← Back to README](../../README.md)
