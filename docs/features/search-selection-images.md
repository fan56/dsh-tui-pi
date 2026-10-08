# Search, selection and images

Two searches, two scopes:

- **Transcript search (this session)** — `Ctrl+Shift+F` opens pi-tui's built-in input overlay ("Find in transcript") over the primary transcript; `Enter`/`Ctrl+G` walk the matches forward, `Shift+Enter`/`Ctrl+Shift+G` backward, `Esc` closes. While it is open the search owns the keys, so your Esc/Ctrl+C gestures stay untouched. The plugin ships no code for this — it is the host TUI library's feature, and it also answers to the legacy `Ctrl+F` byte on terminals that collapse the chords.
- **Cross-session full-text search (every stored session)** — `/search` (or `Ctrl+Alt+F`) queries the host's FTS index (this bundle's patch points `session-query-sqlite` at a durable file under `<dsh-home>/storages/session-query/`, opened lazily on the first search — no boot cost). Results show one row per session — best-match snippet, when, working directory — titled through the session-title snapshots. `Enter` opens a hit: a regular session resumes through the exact `/resume` path (corrupt-log repair and write-lease fallback included); a `↳`-prefixed hit lives in a **subagent child** session and opens a read-only cold browse instead (resuming a child as the main conversation would misplace the recursion budget). `n` loads the next page, `q` starts a new query, `Esc` closes. The search covers user/assistant messages on the current surface — the same filters the web sidebar applies.

  **Key note:** the cross-session search deliberately binds `Ctrl+Alt+F`, NOT `Ctrl+Shift+F` — the transcript search above owns that chord, and an app-level binding here would consume it before pi-tui ever sees it. `Ctrl+Alt+F` arrives as the legacy `ESC+Ctrl+F` encoding on most terminals and collides with nothing in pi-tui's default table; `/search` works everywhere. Both keys are remappable through `~/.dsh/keybindings.json` and listed in `/hotkeys`.

- **Selection copy** — drag to select anywhere in the transcript; releasing copies through the OS clipboard (`pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip`, with OSC 52 riding along for terminals that honor it). `DSH_TUI_COPY_ON_SELECT=0` keeps selection visual-only. Mouse tracking is still tuned by `DSH_TUI_MOUSE` (default `buttons`: clicks, wheel, drag-selection and scrollbar dragging, no idle-motion noise).
- **Images from other surfaces** — messages sent with attachments from the web UI or Feishu render inline in the transcript: a real bitmap on Kitty / Ghostty / WezTerm (kitty graphics) and iTerm2, a clickable filename fallback elsewhere, and a muted "unavailable" note if the stored attachment fails verification. Session resume re-renders past images too.
- **LaTeX in replies** — `$e^{i\pi}+1=0$` and `$$\int_0^1 x\,dx$$` render as terminal-friendly Unicode math (`e^(iπ)+1 = 0`, `∫₀¹ x dx`). Quirk inherited from upstream: a literal `$$` pair in prose is treated as display math.

---

[← Back to README](../../README.md)
