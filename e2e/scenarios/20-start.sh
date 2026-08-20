#!/usr/bin/env bash
# Scenario 2 — TUI startup: launch `dsh --profile tui` inside tmux (a real
# PTY), then review the first painted screen: welcome banner (pixel whale +
# DSH wordmark), random quote line, editor cwd border, powerline footer
# with provider/model segments, keybinding hint and clock, dark canvas via
# DSH_TUI_THEME, and a live editor.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'TUI startup (banner / footer / editor in tmux)'

start_tui 'DSH_TUI_THEME=dark'
wait_tui_up 120 || summary

# --- welcome banner ------------------------------------------------------
PANE="$(capture)"
assert_contains 'pixel whale banner rendered' "$WHALE_ROW" "$PANE"
if has_wordmark "$PANE"; then
  ok 'DSH wordmark rendered at 140 cols'
else
  bad 'DSH wordmark not detected at 140 cols (expected >= 15-block run)'
fi
assert_matches 'random welcome quote rendered' '🐳 「.+」' "$PANE"

# --- footer --------------------------------------------------------------
assert_contains 'footer keybinding hint visible' "$MARKER_FOOTER_HINT" "$PANE"
assert_matches 'footer clock visible (HH:MM)' '[0-9]{2}:[0-9]{2}' "$PANE"
assert_contains 'footer shows the default provider segment' 'deepseek-official' "$PANE"
assert_contains 'footer shows the default model segment' 'deepseek-v4-flash' "$PANE"

# --- canvas color (SGR via capture -e) ------------------------------------
SGR="$(capture_sgr)"
if printf '%s' "$SGR" | grep -qF -- "$SGR_CANVAS_DARK"; then
  ok 'dark canvas background painted (SGR 48;2;13;17;23)'
else
  warn 'dark canvas SGR not found in capture -e (tmux may re-encode colors)'
fi

# --- editor accepts input -------------------------------------------------
send 'e2e-typing-marker'
sleep 2
assert_contains 'editor echoes typed text' 'e2e-typing-marker' "$(capture)"
for _ in $(seq 1 25); do send BSpace; done
sleep 1
assert_not_contains 'editor cleared after backspaces' 'e2e-typing-marker' "$(capture)"

summary
