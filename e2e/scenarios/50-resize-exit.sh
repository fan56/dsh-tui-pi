#!/usr/bin/env bash
# Scenario 5 — resize and clean exit: the 80x24 tuned case (the wordmark
# degrades away below 96 columns, the whale stays, the TUI survives), an
# overlay at 24 rows, restore to 140x36, the documented Ctrl+C x2 quit
# back to the shell, and a final restart to prove the profile still boots
# after a quit.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'resize (80x24) + clean exit + restart'

if ! tui_alive; then
  info 'TUI not running — starting fresh'
  start_tui 'DSH_TUI_THEME=dark'
  wait_tui_up 120 || summary
fi
ensure_editor_ready 'editor clean before resize traffic' || true

# Whale rows from the middle/lower art (top rows can scroll out of the
# transcript viewport at 24 rows — the ScrollView keeps its bottom anchor).
# --- shrink to 80x24 ---------------------------------------------------------
tmux resize-window -t "$TS" -x 80 -y 24
sleep 3
PANE="$(capture)"
assert_contains 'TUI alive after resize to 80x24 (cwd border)' \
  "$MARKER_CWD_BORDER" "$PANE"
assert_contains 'footer hint still rendered at 80x24' \
  "$MARKER_FOOTER_HINT" "$PANE"
if printf '%s' "$PANE" | grep -qE -- "$WHALE_ANY_ERE"; then
  ok 'whale banner still rendered at 80x24'
else
  bad 'whale banner not visible at 80x24 (expected at least a lower row)'
fi
if has_wordmark "$PANE"; then
  bad 'wordmark should degrade away below 96 columns'
else
  ok 'wordmark degraded away at 80 columns (whale-only banner)'
fi

# --- overlay inside the 24-row tuned case -------------------------------------
send '/theme' Enter
wait_pane '/theme picker opens at 24 rows' 15 "$MARKER_THEME_ROWS" \
  && assert_contains 'picker rows visible at 24 rows' 'GitHub' "$(capture)"
esc_until_gone 'picker closes at 24 rows' "$MARKER_THEME_ROWS"

# --- back to wide ---------------------------------------------------------------
tmux resize-window -t "$TS" -x "$TUI_COLS" -y "$TUI_ROWS"
WORDMARK_RESTORED=0
for _ in $(seq 1 15); do
  if has_wordmark "$(capture)"; then WORDMARK_RESTORED=1; break; fi
  sleep 1
done
if (( WORDMARK_RESTORED )); then
  ok "wordmark restored after resize back to ${TUI_COLS} cols"
else
  # Repaint may be waiting for the next input tick — nudge and re-check.
  info 'wordmark absent 15s after resize — nudging with an input tick'
  send Space
  sleep 0.3
  send BSpace
  sleep 1
  if has_wordmark "$(capture)"; then
    warn 'resize-back wordmark repaint only happened after an input tick'
  else
    bad "wordmark did not come back after resizing to ${TUI_COLS} columns"
  fi
fi
assert_contains 'footer hint still rendered after restore' \
  "$MARKER_FOOTER_HINT" "$(capture)"

# --- clean exit ------------------------------------------------------------------
# dsh-tui exits the alt-screen and prints an exit dump (transcript tail +
# footer rows) onto the shell screen — so footer text REMAINING on the pane
# is correct; the authoritative exit signals are the shell prompt and the
# pane's foreground process switching back to the shell.
ensure_editor_ready 'editor clean before quit' || true
quit_tui 'quit via Ctrl+C x2'
PANE="$(capture)"
assert_contains 'shell prompt back after quit' 'root@' "$PANE"
CMD="$(pane_command)"
if [[ "$CMD" == bash ]]; then
  ok "pane foreground is the shell again (${CMD})"
else
  bad "pane foreground after quit is '${CMD}' (expected bash)"
fi
assert_contains 'exit dump rendered on the shell screen' \
  "$MARKER_CWD_BORDER" "$PANE"

# --- one more full boot after a quit -----------------------------------------------
start_tui 'DSH_TUI_THEME=dark'
wait_tui_up 120 || summary
ok 'TUI boots again after a clean quit'
quit_tui 'second quit via Ctrl+C x2'
kill_tui

summary
