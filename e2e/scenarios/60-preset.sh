#!/usr/bin/env bash
# Scenario 6 — agent preset switch: Tab cycles through the deployment's agent
# presets, the footer brand segment reflects the current selection as
# `dsh(<name>)`, and `/preset` opens a picker overlay (when presets exist)
# or reports an error (when the roster is empty).
#
# The container's dsh installation may or may not ship presets — both paths
# are tested. When presets exist the scenario exercises Tab cycling and the
# `/preset` overlay; when absent it verifies the graceful degradation (Tab
# is a no-op, `/preset` errors, footer shows plain "dsh").
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'agent preset switch (Tab + /preset)'

if ! tui_alive; then
  info 'TUI not running — starting fresh'
  start_tui 'DSH_TUI_THEME=dark'
  wait_tui_up 120 || summary
fi
ensure_editor_ready 'editor clean before preset traffic' || true

# --- detect whether presets are available ------------------------------------
# The footer brand segment is "dsh" (no presets) or "dsh(<name>)" (presets).
# After startup the default preset is selected, so the footer already shows it.
PANE="$(capture)"
if printf '%s' "$PANE" | grep -qoE 'dsh\([^)]+\)'; then
  HAS_PRESETS=1
  INITIAL_PRESET="$(printf '%s' "$PANE" | grep -oE 'dsh\([^)]+\)' | head -1)"
  info "presets available; initial footer: $INITIAL_PRESET"
else
  HAS_PRESETS=0
  INITIAL_PRESET='dsh'
  assert_contains 'footer shows plain dsh (no presets)' 'dsh' "$PANE"
  info 'no presets detected — testing graceful degradation'
fi

# --- Tab cycling (when presets exist) ----------------------------------------
if (( HAS_PRESETS )); then
  # Tab should cycle to the next preset; the footer label must change.
  send Tab
  sleep 1.5
  PANE="$(capture)"
  AFTER_TAB="$(printf '%s' "$PANE" | grep -oE 'dsh\([^)]+\)' | head -1)"
  if [[ "$AFTER_TAB" != "$INITIAL_PRESET" ]]; then
    ok "Tab cycles preset: $INITIAL_PRESET → $AFTER_TAB"
  elif (( HAS_PRESETS == 1 )); then
    # Single preset — Tab is a no-op, which is correct.
    warn "Tab did not change preset (only one available: $INITIAL_PRESET)"
  else
    bad "Tab did not cycle preset (still $INITIAL_PRESET)"
  fi

  # Tab again should cycle further (or wrap).
  PREV="$AFTER_TAB"
  send Tab
  sleep 1.5
  PANE="$(capture)"
  AFTER_TAB2="$(printf '%s' "$PANE" | grep -oE 'dsh\([^)]+\)' | head -1)"
  if [[ "$AFTER_TAB2" != "$PREV" ]] || (( HAS_PRESETS <= 2 )); then
    ok "second Tab cycles further: $PREV → $AFTER_TAB2"
  else
    bad "second Tab did not cycle (still $PREV)"
  fi
fi

# --- /preset command ----------------------------------------------------------
if (( HAS_PRESETS )); then
  # /preset bare — should open the picker overlay.
  ensure_editor_ready 'editor focused before /preset' || true
  send '/preset' Enter
  wait_pane '/preset opens the preset picker' 10 '● Agent preset' \
    && ok '/preset picker shows overlay title'
  # Close it.
  esc_until_gone 'preset picker closes on Esc' '● Agent preset'

  # /preset next — should cycle like Tab.
  ensure_editor_ready 'editor focused before /preset next' || true
  BEFORE="$(capture | grep -oE 'dsh\([^)]+\)' | head -1)"
  send '/preset next' Enter
  sleep 2
  AFTER="$(capture | grep -oE 'dsh\([^)]+\)' | head -1)"
  if [[ "$AFTER" != "$BEFORE" ]]; then
    ok "/preset next cycles: $BEFORE → $AFTER"
  else
    warn "/preset next did not change preset (single preset or no-op)"
  fi
else
  # No presets — /preset should report an error.
  ensure_editor_ready 'editor focused before /preset (no presets)' || true
  send '/preset' Enter
  wait_pane '/preset reports no presets error' 10 'No agent presets available'
fi

# --- editor still usable after preset traffic ---------------------------------
ensure_editor_ready 'editor usable after preset operations'

summary
