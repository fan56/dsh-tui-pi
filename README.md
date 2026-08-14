# dsh-tui-pi

pi-style terminal UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

- **Look & feel**: pi coding agent interactive TUI, built on
  `@earendil-works/pi-tui` 0.84.2 (pinned) — alt-screen scrollable transcript,
  docked editor/status/footer, markdown messages, slash-command autocomplete.
- **Slash commands**: dsh's own, untouched. Autocomplete from
  `ctx.commands.list(agent)`, executed via `ctx.commands.execute(agent, line, signal)`.
  Verified: `/compact`, `/plan`, `/goal`, `/permission`, `/feedback`.
- **Themes**: GitHub light / GitHub dark (Primer palette). Switch via
  `DSH_TUI_THEME=light|dark`, else terminal-background detection (COLORFGBG).
- **Footer**: powerline segments ported from
  [pi-powerline-footer](https://github.com/fan56/pi-powerline-footer) —
  provider / model+thinking / context / cache-hit / msgs / tools with U+E0B0
  arrows, right-aligned live clock, cwd+git-branch editor top border, and the
  `↳ last-request` widget.

## Install (local)

```sh
# build once
cd dsh-tui-pi && pnpm install && pnpm build

# live development link (recommended; edits to src/ + pnpm build apply on next launch)
dsh plugin --profile tui add link:/path/to/dsh-tui-pi

# or an npm tarball
npm pack                                   # → dsh-tui-pi-0.1.0.tgz
dsh plugin --profile tui add /path/to/dsh-tui-pi-0.1.0.tgz
```

Both paths auto-add `dsh-tui-pi` to the profile's `dsh.profile.bundles`.

## Use

```sh
dsh --profile tui        # or: dsh-tui-pi (bin shim)
```

- Type a prompt → Enter. Streaming reply renders live; tool calls render as
  `⚙/✔/✘` cards.
- `/` opens slash-command autocomplete (Tab/arrows/Enter).
- Ctrl+C quits (disposes the agent and the dsh tree cleanly).

## Performance rules (from the pi-turbo findings)

pi's TUI lags in long sessions because its footer re-scans the whole session
log on every render (O(n)) and a 1s clock tick recomputes everything.
dsh-tui-pi avoids both by construction:

- **Event-driven incremental state**: `session/event` listeners maintain an
  append-only transcript model + running counters (tokens, messages, tools,
  cache-hit rate). Render never re-scans the dsh session log.
- **Footer reads O(1) maintained values** — never derived in `render()`.
- **Clock tick only re-renders the footer line**; transcript components cache.
- **Streaming strategy**: deltas accumulate in a plain Text; markdown renders
  once on the assembled `assistant/message` (no per-token markdown parsing).

## Dev

```sh
pnpm check    # tsc --noEmit
pnpm build    # emit lib/
pnpm test     # theme unit tests (node --test)
```

Local type-checking symlinks `node_modules/@deepseek-ai/*` to the installed
dsh closure (`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules`);
at runtime those imports resolve to the same module instances the running dsh
uses. Those symlinks stay out of any tarball (`files` ships lib/bin/patch only).

## Layout

```
bin/dsh-tui-pi      launcher shim (exec dsh --profile tui)
cordis.patch.yml    bundle patch: mounts the plugin as `tui-pi`
src/
  index.ts          cordis plugin entry + wiring (submit routing, footer, lifecycle)
  tui.ts            TUI bootstrap: alt-screen tree, dock, input, last-request
  session.ts        DshSessionBridge: lazy agent create, followup, events, O(1) stats
  commands.ts       CommandService: slash autocomplete + ctx.commands execution
  messages.ts       TranscriptRenderer: session events → pi-tui components
  footer.ts         PowerlineFooter (ported segment palette)
  editor.ts         CwdBorderEditor (top border: 📁 cwd │ ⎇ branch)
  git.ts            GitBranchWatcher (polled, cached)
  theme/
    palette.ts      GitHub light/dark Primer palettes + background detection
    index.ts        theme assembly: Editor/Markdown/SelectList themes, chat
                    roles, POWERLINE segment palette
test/theme.test.mjs unit tests for theme/palette functions
```

## Status (2026-08-14)

| Phase | Result |
|---|---|
| A cleanup | ✅ check/test clean, error boundary, LICENSE |
| B layout | ✅ alt-screen dock fixed, transcript scrolls independently |
| C session | ✅ prompt → streaming → markdown; tool cards; idle/working; clean Ctrl+C exit |
| D slash | ✅ autocomplete from registry; `/compact`, `/plan` executed; unknown `/x` falls through to model |
| E footer | ✅ all segments live; cwd border; last-request widget; O(1) stats |
| F packaging | ✅ `link:` install + tarball install verified on fresh profiles; tmux E2E |

Known limitations (future): model/permission/preset selector overlays,
session list/resume, theme switch UI, interrupt-without-exit (Ctrl+C once =
cancel turn, twice = exit).
