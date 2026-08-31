# Search, selection and images

- **Transcript search** — `Ctrl+Shift+F` opens an input overlay over the transcript; `Enter`/`Ctrl+G` and `Shift+Enter`/`Ctrl+Shift+G` walk the matches, `Esc` closes. While it is open the search owns the keys, so your Esc/Ctrl+C gestures stay untouched.
- **Selection copy** — drag to select anywhere in the transcript; releasing copies through the OS clipboard (`pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip`, with OSC 52 riding along for terminals that honor it). `DSH_TUI_COPY_ON_SELECT=0` keeps selection visual-only. Mouse tracking is still tuned by `DSH_TUI_MOUSE` (default `buttons`: clicks, wheel, drag-selection and scrollbar dragging, no idle-motion noise).
- **Images from other surfaces** — messages sent with attachments from the web UI or Feishu render inline in the transcript: a real bitmap on Kitty / Ghostty / WezTerm (kitty graphics) and iTerm2, a clickable filename fallback elsewhere, and a muted "unavailable" note if the stored attachment fails verification. Session resume re-renders past images too.
- **LaTeX in replies** — `$e^{i\pi}+1=0$` and `$$\int_0^1 x\,dx$$` render as terminal-friendly Unicode math (`e^(iπ)+1 = 0`, `∫₀¹ x dx`). Quirk inherited from upstream: a literal `$$` pair in prose is treated as display math.

*`Ctrl+Shift+F` in action — type to filter, `Enter` walks the matches, `Esc` closes:*

https://github.com/user-attachments/assets/4da83731-a3d3-4d3d-95d4-8370f073f24d

---

[← Back to README](../../README.md)
