#!/usr/bin/env bash
# Scenario 4 — theme switch review: the /theme picker overlay, the canvas
# repaint to the opposite palette (verified through capture -e SGR runs),
# the persisted preference in ~/.dsh/settings.yaml, and persistence across
# a full TUI restart.
#
# Navigation model (src/selectors.ts): rows are [auto, light, dark]; the
# preselected row is the persisted preference (fresh profile = 'auto',
# row 0), so one Down lands on light; with light persisted, one Down lands
# on dark.
#
# IMPORTANT: no DSH_TUI_THEME here — the env override pins the display and
# a preference change then only saves ("display is pinned by
# DSH_TUI_THEME=dark") without repainting, which is correct app behavior
# but not what this scenario reviews.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'theme switch (picker / canvas repaint / persistence)'

SETTINGS_YAML="$HOME/.dsh/settings.yaml"

# Always restart env-free so the preference — not an env pin — owns the
# display for the whole scenario.
kill_tui
start_tui
wait_tui_up 120 || summary
ensure_editor_ready 'editor clean before theme traffic' || true

# --- open the picker --------------------------------------------------------
send '/theme' Enter
wait_pane '/theme opens the theme picker' 15 "$MARKER_THEME_ROWS" || summary
PANE="$(capture)"
assert_contains 'picker row: auto' 'auto' "$PANE"
assert_contains 'picker row: light description' 'GitHub light palette' "$PANE"
assert_contains 'picker row: dark description' 'GitHub dark palette' "$PANE"

# --- switch to light ---------------------------------------------------------
# Fresh profile: preference 'auto' preselected (row 0) -> Down -> light.
send Down
send Enter
sleep 3
SGR="$(capture_sgr)"
if printf '%s' "$SGR" | grep -qF -- "$SGR_CANVAS_LIGHT"; then
  ok 'canvas repainted to light (SGR 48;2;252;253;252)'
else
  bad 'light canvas SGR not found after switching to light'
fi
if printf '%s' "$SGR" | grep -qF -- "$SGR_CANVAS_DARK"; then
  bad 'dark canvas SGR still present after switching to light'
else
  ok 'dark canvas SGR gone after switching to light'
fi
wait_pane 'selection notice rendered (Theme: light)' 10 'Theme: light'
wait_gone 'theme picker closed after selection' 10 "$MARKER_THEME_ROWS"
if [[ -f "$SETTINGS_YAML" ]] && grep -q 'light' "$SETTINGS_YAML"; then
  ok 'preference persisted to settings.yaml (light)'
else
  bad 'settings.yaml missing or has no light preference'
fi

# --- switch back to dark ------------------------------------------------------
# Preference is now light (row 1) -> Down -> dark.
ensure_editor_ready 'editor focused for the dark switch' || true
send '/theme' Enter
wait_pane '/theme reopens the theme picker' 15 "$MARKER_THEME_ROWS" || summary
send Down
send Enter
sleep 3
SGR="$(capture_sgr)"
if printf '%s' "$SGR" | grep -qF -- "$SGR_CANVAS_DARK"; then
  ok 'canvas repainted to dark (SGR 48;2;13;17;23)'
else
  bad 'dark canvas SGR not found after switching to dark'
fi
wait_pane 'selection notice rendered (Theme: dark — applied)' 10 'Theme: dark'
if [[ -f "$SETTINGS_YAML" ]] && grep -q 'dark' "$SETTINGS_YAML" \
  && ! grep -q 'light' "$SETTINGS_YAML"; then
  ok 'preference persisted to settings.yaml (dark, light gone)'
else
  bad 'settings.yaml does not reflect the dark preference'
fi

# --- persistence across a restart ---------------------------------------------
# Quit, relaunch (still env-free): the persisted preference must win.
quit_tui 'quit TUI for restart-persistence check' || summary
start_tui
wait_tui_up 120 || summary
sleep 3
SGR="$(capture_sgr)"
if printf '%s' "$SGR" | grep -qF -- "$SGR_CANVAS_DARK"; then
  ok 'restarted TUI comes up on the persisted dark canvas'
else
  bad 'restarted TUI did not restore the persisted dark canvas'
fi

summary
