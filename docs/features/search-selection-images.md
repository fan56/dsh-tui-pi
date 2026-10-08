# Search, selection and images

- **Cross-session full-text search** — `/search` (or `Ctrl+Shift+F`) queries every stored session through the host's FTS index (this bundle's patch points `session-query-sqlite` at a durable file under `<dsh-home>/storages/session-query/`, opened lazily on the first search — no boot cost). Results show one row per session — best-match snippet, when, working directory — titled through the session-title snapshots. `Enter` opens a hit: a regular session resumes through the exact `/resume` path (corrupt-log repair and write-lease fallback included); a `↳`-prefixed hit lives in a **subagent child** session and opens a read-only cold browse instead (resuming a child as the main conversation would misplace the recursion budget). `n` loads the next page, `q` starts a new query, `Esc` closes. The search covers user/assistant messages on the current surface — the same filters the web sidebar applies.

  **Terminal note:** the `Ctrl+Shift+F` chord only arrives on terminals that speak the kitty keyboard protocol (kitty / Ghostty / WezTerm / iTerm2) — the sequence is `CSI 70;6u`. tmux without `extended-keys` and other legacy terminals deliver a bare capital `F` for that chord, so `/search` is the entry point there. The key is remappable through `~/.dsh/keybindings.json` and listed in `/hotkeys`.
- **Selection copy** — drag to select anywhere in the transcript; releasing copies through the OS clipboard (`pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip`, with OSC 52 riding along for terminals that honor it). `DSH_TUI_COPY_ON_SELECT=0` keeps selection visual-only. Mouse tracking is still tuned by `DSH_TUI_MOUSE` (default `buttons`: clicks, wheel, drag-selection and scrollbar dragging, no idle-motion noise).
- **Images from other surfaces** — messages sent with attachments from the web UI or Feishu render inline in the transcript: a real bitmap on Kitty / Ghostty / WezTerm (kitty graphics) and iTerm2, a clickable filename fallback elsewhere, and a muted "unavailable" note if the stored attachment fails verification. Session resume re-renders past images too.
- **LaTeX in replies** — `$e^{i\pi}+1=0$` and `$$\int_0^1 x\,dx$$` render as terminal-friendly Unicode math (`e^(iπ)+1 = 0`, `∫₀¹ x dx`). Quirk inherited from upstream: a literal `$$` pair in prose is treated as display math.

---

[← Back to README](../../README.md)
