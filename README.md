# dsh-tui-pi

pi-style terminal UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

- **Look & feel**: pi coding agent interactive TUI, built directly on the
  `@earendil-works/pi-tui` framework (pinned 0.83.0) — scrollable transcript,
  docked editor + status + footer, markdown messages, overlays.
- **Slash commands**: dsh's own, untouched. Autocomplete from
  `ctx.commands.list(agent)`, executed via `ctx.commands.execute(agent, line, signal)`.
- **Themes**: GitHub light / GitHub dark (Primer palette). Theme switch via
  `DSH_TUI_THEME=light|dark` or terminal-background detection.
- **Footer**: powerline segments ported from
  [pi-powerline-footer](https://github.com/fan56/pi-powerline-footer) —
  provider / model+thinking / context / cache / msgs / tools segments with
  `\uE0B0` separators, right-aligned clock.

## Performance rules (from the pi-turbo findings)

pi's TUI lags in long sessions because its footer re-scans the whole session
log on every render (O(n)) and a 1s clock tick re-renders the tree. dsh-tui-pi
avoids both by construction:

- **Event-driven incremental state**: session events (`session/event`,
  `agent/status`) maintain an append-only transcript model + running counters
  (input/output tokens, message count, tool count). Render never re-scans the
  dsh session log.
- **Footer reads O(1) maintained values**, never derived in `render()`.
- **Clock tick only re-renders the clock cells**, not the whole tree.
- **Transcript is bounded**: rendered message cap / lazy rendering for long
  sessions (pi-tui has no transcript virtualization yet).

## Install (dsh profile bundle)

```sh
dsh plugin --profile tui add /path/to/dsh-tui-pi   # or a git/registry source
dsh --profile tui
```

Runtime resolution follows the openma runner pattern: dsh host packages
(`@deepseek-ai/dsh-*`) are **not** npm dependencies — they resolve from the
profile's node_modules (healed by `dsh --profile`). Local dev symlinks
`node_modules/@deepseek-ai/*` into `~/deepseek-harness` for type-checking only.

## Status

- [x] Phase 0 — framework decision (A: pin `@earendil-works/pi-tui` 0.83.0),
      package scaffold, dsh host types via symlink, tmux smoke test
- [x] Phase 1 — plugin entry + TUI bootstrap (transcript / status / editor /
      footer dock, Ctrl+C exit). GitHub light/dark theme module.
- [ ] Phase 2 — session wiring: agents.create, followup, session/event stream,
      message rendering (streaming chunks → assembled message, tool cards)
- [ ] Phase 3 — editor slash commands: `ctx.commands.list` autocomplete,
      `parseCommand` + `ctx.commands.execute` on submit, command flow nodes
- [ ] Phase 4 — powerline footer + cwd/branch editor top border +
      last-request widget
- [ ] Phase 5 — selectors: model / permission preset / agent preset overlays
- [ ] Phase 6 — session list / resume
- [ ] Phase 7 — polish: theme switch UI, narrow-terminal fallback, tests, README shots

## Layout

```
src/
  index.ts          cordis plugin entry (name/inject/apply)
  tui.ts            TUI bootstrap: pi-tui tree, input, lifecycle
  theme/
    palette.ts      GitHub light/dark Primer palettes + detection
    index.ts        theme assembly: Editor/Markdown/SelectList themes,
                    chat roles, powerline palette
  session.ts        (phase 2) agent create + event stream → incremental model
  commands.ts       (phase 3) slash autocomplete + execution
  messages.ts       (phase 2) user/assistant/tool renderers
  footer.ts         (phase 4) powerline footer
  editor.ts         (phase 4) custom editor top border
  selectors.ts      (phase 5) model/permission/preset overlays
```

## Dev

```sh
pnpm install
pnpm check    # tsc --noEmit
pnpm build    # tsc emit to lib/
node --test test/          # tests (pending)
```

Smoke test the bare TUI in tmux:

```sh
tmux new-session -d -s tui -x 100 -y 30
tmux send-keys -t tui "cd /Users/fliu56/github/dsh-tui-pi && node --input-type=module -e \"import('./lib/tui.js').then(m => m.startTui())\"" Enter
tmux capture-pane -t tui -p
```
