#!/usr/bin/env bash
# Scenario 3 — slash commands review: the editor autocomplete popup (open,
# filter, close), each modal command's overlay (open, overlay-only content,
# Esc back to a focused editor), the /model picker against the built-in
# default provider, and the /resume no-sessions error path.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'slash commands (autocomplete + picker overlays)'

if ! tui_alive; then
  info 'TUI not running — starting fresh'
  start_tui 'DSH_TUI_THEME=dark'
  wait_tui_up 120 || summary
fi
ensure_editor_ready 'editor clean before command traffic' || true

# --- autocomplete popup: open, filter, close ------------------------------
# Keep the leading '/' on the line while swapping the filter text — the
# popup only triggers on a '/' prefix.
send '/'
# The popup window shows only the first rows of the command list — assert
# on names proven to sit inside that window (not e.g. models-sync).
wait_pane 'autocomplete popup opens on /' 10 'think|skill|logout'
esc_until_gone 'autocomplete popup closes on Esc' 'think|skill|logout'
send 'set'
sleep 2
assert_contains 'autocomplete filter "set" shows /settings' 'settings' "$(capture)"
for _ in $(seq 1 3); do send BSpace; done
send 'th'
sleep 2
PANE="$(capture)"
assert_contains 'autocomplete filter "th" shows /theme' 'theme' "$PANE"
assert_contains 'autocomplete filter "th" shows /think' 'think' "$PANE"
for _ in $(seq 1 2); do send BSpace; done
send 'hot'
sleep 2
assert_contains 'autocomplete filter "hot" shows /hotkeys' 'hotkeys' "$(capture)"
for _ in $(seq 1 4); do send BSpace; done

# --- /think: reasoning effort picker --------------------------------------
ensure_editor_ready 'editor focused before /think' || true
send '/think' Enter
wait_pane '/think opens the effort picker' 15 "$MARKER_EFFORT_PICKER" \
  && assert_contains 'effort picker shows the provider-default row' \
    '(provider default)' "$(capture)"
esc_until_gone 'effort picker closes on Esc' "$MARKER_EFFORT_PICKER"

# --- /settings: settings browser ------------------------------------------
ensure_editor_ready 'editor focused before /settings' || true
send '/settings' Enter
wait_pane '/settings opens the settings browser' 15 "$MARKER_SETTINGS_BROWSER"
esc_until_gone 'settings browser closes on Esc' "$MARKER_SETTINGS_BROWSER"

# --- /resume with no persisted sessions: the error path --------------------
ensure_editor_ready 'editor focused before /resume' || true
send '/resume' Enter
wait_pane '/resume without sessions reports the no-sessions error' 15 \
  "$MARKER_RESUME_NO_SESSIONS"

# --- /hotkeys: keybinding panel --------------------------------------------
ensure_editor_ready 'editor focused before /hotkeys' || true
send '/hotkeys' Enter
wait_pane '/hotkeys opens the keybinding panel' 15 "$MARKER_HOTKEYS_PANEL"
esc_until_gone 'keybinding panel closes on Esc' '⚙'

# --- /permission: preset picker ---------------------------------------------
ensure_editor_ready 'editor focused before /permission' || true
send '/permission' Enter
wait_pane '/permission opens the preset picker' 15 "$MARKER_PERMISSION"
esc_until_gone 'preset picker closes on Esc' "$MARKER_PERMISSION"

# --- /model: picker against the built-in default provider -------------------
# Open, verify rows, then CANCEL with Esc — selecting a model would advance
# to the stage-2 effort picker and change footer state.
ensure_editor_ready 'editor focused before /model' || true
send '/model' Enter
wait_pane '/model opens the model picker' 15 "$MARKER_MODEL_PICKER" \
  && assert_contains 'model picker lists the default model' \
    "$MARKER_MODEL_ROW" "$(capture)"
esc_until_gone 'model picker cancels on Esc' "$MARKER_MODEL_PICKER"

# --- editor still usable after all overlay traffic --------------------------
ensure_editor_ready 'editor usable after overlay open/close cycles'

summary
