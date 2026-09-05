#!/usr/bin/env bash
# Scenario 6 — agent preset switch: `/preset` opens the picker overlay (when
# the deployment ships presets) or reports an error (when the roster is
# empty); `/preset next` switches — with a live session it goes through the
# confirmation dialog ("Switch preset to …?"), without one it applies
# directly. There is no Tab binding anymore (removed in 2.7.0).
#
# The container's dsh installation may or may not ship presets — both paths
# are tested. When absent: `/preset` errors and the footer shows plain "dsh".
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'agent preset switch (/preset + confirm dialog)'

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

# --- Tab must NOT cycle presets anymore (removed in 2.7.0) -------------------
if (( HAS_PRESETS )); then
  send Tab
  sleep 1.5
  PANE="$(capture)"
  AFTER_TAB="$(printf '%s' "$PANE" | grep -oE 'dsh\([^)]+\)' | head -1)"
  if [[ "$AFTER_TAB" == "$INITIAL_PRESET" ]]; then
    ok "Tab is unbound: footer unchanged ($INITIAL_PRESET)"
  else
    bad "Tab still cycles presets ($INITIAL_PRESET → $AFTER_TAB) — binding should be gone"
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

  # /preset next — with a live session this opens the confirmation dialog;
  # without one it applies directly. Handle both shapes.
  ensure_editor_ready 'editor focused before /preset next' || true
  BEFORE="$(capture | grep -oE 'dsh\([^)]+\)' | head -1)"
  send '/preset next' Enter
  sleep 2
  PANE="$(capture)"
  if printf '%s' "$PANE" | grep -q 'Switch preset to'; then
    ok '/preset next opens the confirmation dialog (live session)'
    # Cancel keeps everything as it was.
    send Esc
    sleep 1.5
    AFTER_CANCEL="$(capture | grep -oE 'dsh\([^)]+\)' | head -1)"
    if [[ "$AFTER_CANCEL" == "$BEFORE" ]]; then
      ok "dialog Cancel keeps the preset ($BEFORE)"
    else
      bad "dialog Cancel changed the preset ($BEFORE → $AFTER_CANCEL)"
    fi
    # Re-run and confirm the switch this time.
    ensure_editor_ready 'editor focused before confirmed switch' || true
    send '/preset next' Enter
    sleep 2
    send Enter
    sleep 2.5
    AFTER="$(capture | grep -oE 'dsh\([^)]+\)' | head -1)"
    if [[ "$AFTER" != "$BEFORE" ]]; then
      ok "confirmed switch applies: $BEFORE → $AFTER"
    else
      warn "confirmed switch did not change the footer label (single preset?)"
    fi
  else
    AFTER="$(printf '%s' "$PANE" | grep -oE 'dsh\([^)]+\)' | head -1)"
    if [[ "$AFTER" != "$BEFORE" ]]; then
      ok "/preset next applies directly (no live session): $BEFORE → $AFTER"
    else
      warn "/preset next did not change preset (single preset or no-op)"
    fi
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
