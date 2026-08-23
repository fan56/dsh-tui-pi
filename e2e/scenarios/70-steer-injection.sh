#!/usr/bin/env bash
# Scenario 7 — subagent viewer Enter-steer injection (v0.17.0).
#
# This scenario is HOST-ONLY — it needs a real dsh installation with a
# working provider API key so the parent actually spawns a subagent and the
# child runs long enough to be steered. It is therefore SKIPPED inside the
# podman e2e container (which has no credentials) and runs on the host
# tmux against `~/.dsh/profiles/tui`.
#
# Per the repo AGENTS.md "Config safety" rule:
#   - snapshot ~/.dsh/settings.yaml + ~/.dsh/.credentials.yaml byte-for-byte
#     into a tempdir before the test;
#   - never read or output the file contents;
#   - restore byte-for-byte in a cleanup trap, verified with `cmp`.
#
# Flow (one tmux session, fresh `dsh --profile tui`):
#   1. parent prompt that explicitly routes work through the dsh subagent tool
#      so a long-running child is guaranteed to be live (multi-round task);
#   2. Ctrl+G opens the picker → Enter on the running child opens the viewer;
#   3. the viewer's footer must show "Enter steer" (VIEWER_FOOTER constant);
#   4. Enter inside the viewer opens the multi-line steer input, with the
#      "Enter send · Shift+Enter newline · Esc cancel" footer (STEER_FOOTER);
#   5. type a steer instruction + Enter → the viewer swaps back with the
#      `Steer message sent` notice (STEER_SENT_NOTICE) and the transcript
#      shows the injected message as an `ⓘ …` event;
#   6. open the viewer on the SETTLED child → Enter → the inline
#      `This subagent has ended — steering unavailable` notice
#      (STEER_ENDED_NOTICE) without opening the steer box (negative path);
#      the child is waited out (the steer tells it to stop early) so the
#      rejection runs against a genuinely settled entry;
#   7. BEFORE that, with the child still live: open the steer box again,
#      type something, press Esc → back to the viewer without any notice
#      (cancel path);
#   8. quit TUI; restore the snapshot; cmp verifies byte-equal.
#
# PATH hardening: host shell has ~/.local/bin/grep shadowing /usr/bin/grep
# with a wrapper that does not understand `-E` (passes it to rg as an
# encoding flag). common.sh's `wait_pane` / `esc_until_gone` rely on
# `grep -qE --` — put /usr/bin ahead of the wrapper before sourcing.
set -u
export PATH="/usr/bin:/bin:/opt/homebrew/bin:$PATH"
. "$(dirname "$0")/../lib/common.sh"
scenario 'subagent viewer Enter-steer injection (host tmux, v0.17.0)'

# --- skip guards -----------------------------------------------------------
# 1. Inside the podman container the suite has no credentials — a subagent
#    will not spawn, so this scenario must skip (warn, not fail).
if [ -d /e2e/scenarios ]; then
  warn 'container environment detected — skipping (host credentials required for real LLM)'
  summary
  exit 0
fi

# 2. On the host, the tui profile must be deployed with a v0.17.0 plugin so
#    the steer code path actually exists in the running lib.
PLUGIN_LIB="$HOME/.dsh/profiles/tui/node_modules/@aiwayds/dsh-tui-pi/lib/subagent-viewer.js"
if [ ! -f "$PLUGIN_LIB" ]; then
  warn "no deployed plugin at $PLUGIN_LIB — skipping (host tui profile not installed)"
  summary
  exit 0
fi
if ! grep -qF 'STEER_FOOTER' "$PLUGIN_LIB" 2>/dev/null \
   || ! grep -qF 'Steer message sent' "$PLUGIN_LIB" 2>/dev/null \
   || ! grep -qF 'SteerInputPanel' "$PLUGIN_LIB" 2>/dev/null; then
  warn 'deployed plugin predates v0.17.0 (no STEER_FOOTER / sent notice / SteerInputPanel) — skipping'
  summary
  exit 0
fi

# --- snapshot ~/.dsh/{settings,.credentials}.yaml byte-for-byte -----------
# We never read these files — only cp them in and back out (cmp-verify).
SNAP_DIR="$(mktemp -d -t dsh-e2e-steer.XXXXXX)"
SNAP_SETTINGS="$SNAP_DIR/settings.yaml"
SNAP_CREDS="$SNAP_DIR/.credentials.yaml"
LIVE_SETTINGS="$HOME/.dsh/settings.yaml"
LIVE_CREDS="$HOME/.dsh/.credentials.yaml"

if [ -f "$LIVE_SETTINGS" ]; then cp -p "$LIVE_SETTINGS" "$SNAP_SETTINGS"; fi
if [ -f "$LIVE_CREDS" ]; then cp -p "$LIVE_CREDS" "$SNAP_CREDS"; fi

restore_snapshot() {
  kill_tui
  if [ -f "$SNAP_SETTINGS" ]; then
    if cmp -s "$SNAP_SETTINGS" "$LIVE_SETTINGS"; then
      ok 'settings.yaml byte-equal after test (no drift)'
    else
      bad 'settings.yaml drifted during test — restoring snapshot'
      cp -p "$SNAP_SETTINGS" "$LIVE_SETTINGS"
    fi
  fi
  if [ -f "$SNAP_CREDS" ]; then
    if cmp -s "$SNAP_CREDS" "$LIVE_CREDS"; then
      ok '.credentials.yaml byte-equal after test (no drift)'
    else
      bad '.credentials.yaml drifted during test — restoring snapshot'
      cp -p "$SNAP_CREDS" "$LIVE_CREDS"
    fi
  fi
  rm -rf "$SNAP_DIR"
}
trap restore_snapshot EXIT

# --- evidence trail ---------------------------------------------------------
# Every milestone dumps its full pane into EVID_DIR so a failed run leaves
# reviewable screenshots-by-text behind (kept under /tmp on purpose).
EVID_DIR="${EVID_DIR:-/tmp/dsh-e2e-steer-evidence}"
mkdir -p "$EVID_DIR"
evidence() { tmux capture-pane -t "$TS_HOST" -p >"$EVID_DIR/$1.txt" 2>/dev/null; }

# --- host session bootstrap ----------------------------------------------
# Common.sh pins TS=dsh-tui-e2e and cwd=/app (container assumptions). On the
# host we run a fresh session in /tmp so the editor cwd border doesn't leak
# a path the existing MARKER_CWD_BORDER check rejects.
TS_HOST=dsh-tui-steer-e2e
TS="$TS_HOST"
TUI_COLS=140
TUI_ROWS=36
# wait_pane polls with grep -qE, so any needle carrying ERE metacharacters
# ("Shift+Enter") silently never matches. This variant polls a FIXED string.
wait_pane_fixed() {
  local label="$1" timeout="$2" needle="$3" waited=0
  while (( waited < timeout )); do
    if capture | grep -qF -- "$needle"; then
      ok "$label"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  bad "$label (timed out after ${timeout}s)"
  return 1
}

pane_command() { tmux display-message -p -t "$TS_HOST" '#{pane_current_command}' 2>/dev/null; }
capture() { tmux capture-pane -t "$TS_HOST" -p 2>/dev/null; }
send() { tmux send-keys -t "$TS_HOST" "$@"; }

# Host-aware quit: same Ctrl+C x2 window contract, but the host shell
# prompt is `fliu56@…` not `root@…` (common.sh's quit_tui checks for the
# latter and would fail the quit wait on the host).
quit_host_tui() {
  local label="$1" waited=0
  send C-c
  sleep 0.3
  send C-c
  while (( waited < 8 )); do
    if [[ "$(pane_command)" == bash ]] || [[ "$(pane_command)" == zsh ]]; then
      ok "$label"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  info "Ctrl+C x2 did not quit — falling back to Ctrl+D (empty-editor quit)"
  send C-d
  waited=0
  while (( waited < 6 )); do
    if [[ "$(pane_command)" == bash ]] || [[ "$(pane_command)" == zsh ]]; then
      warn "$label (needed the Ctrl+D fallback)"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  bad "$label (TUI still running)"
  return 1
}

# Override common.sh's start_tui: cwd=/tmp here, no DSH_TUI_THEME so the
# displayed theme matches the host's saved preference (the test does not
# touch theme state).
start_host_tui() {
  tmux kill-session -t "$TS_HOST" 2>/dev/null || true
  sleep 0.3
  tmux new-session -d -s "$TS_HOST" -x "$TUI_COLS" -y "$TUI_ROWS" -c /tmp
  sleep 0.2
  tmux send-keys -t "$TS_HOST" 'dsh --profile tui' Enter
}

wait_host_tui_up() {
  local timeout="${1:-120}" waited=0 pane
  while (( waited < timeout )); do
    pane="$(capture)"
    if printf '%s' "$pane" | grep -qF -- "$WHALE_ROW" \
       && printf '%s' "$pane" | grep -qF -- "$MARKER_FOOTER_HINT"; then
      sleep 2
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  bad "TUI did not come up within ${timeout}s; last pane tail:"
  capture | tail -12 | sed 's/^/    | /'
  return 1
}

# A running-child indicator: a live-widget row that begins with a braille
# spinner glyph (the cycle runs through ⠋-⠏, e.g. ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏).
# Settled rows use ✓/✗/— instead, so the spinner class uniquely identifies
# a live child (the live widget renders one row per active child). The
# meta segment is `round N/M` (singular — see src/live-widgets.ts line 466).
LIVE_CHILD_ERE='[⠋-⠿] .*round [0-9]+/[0-9]+'

start_host_tui
wait_host_tui_up 120 || summary
evidence 01-tui-up

# Editor ready (probe + clear): piggybacks on common.sh's helper, but it
# needs the redirected `send` to land in our session.
ensure_editor_ready 'editor clean before steer task' || true

# --- 1. Spawn a long-running subagent -------------------------------------
# Explicit instruction to use the dsh subagent tool with a sleep-loop task:
# the parent almost always spawns one when told to, and twelve sequential
# `sleep 8` runs keep the child live for minutes regardless of how fast the
# model plans them — a comfortable window for the whole steering flow. The parent LLM occasionally answers the prompt directly
# (claiming "dispatched" without invoking the tool) — we retry with a
# harder push up to 3 times before giving up.
TASK_PRIMARY='Use the dsh subagent tool NOW to dispatch this task to the workhorse subagent — call the subagent tool, do not write the answer yourself. Task for the subagent: make TWELVE SEPARATE bash tool calls, each running exactly "sleep 8" and nothing else — NEVER combine them into one loop or one command. After all twelve finish, summarize.'
TASK_HARD_PUSH='You MUST call the subagent tool right now. Do not write anything yourself — your only job is to invoke the subagent tool with this task. Pass it to the workhorse subagent: make twelve separate bash tool calls, each running exactly "sleep 8" — one call per sleep, never a loop, never combined.'
SPAWNED=0
for ATTEMPT in 1 2 3; do
  if (( ATTEMPT == 1 )); then
    PROMPT="$TASK_PRIMARY"
  else
    PROMPT="$TASK_HARD_PUSH"
  fi
  info "spawn attempt $ATTEMPT: sending prompt"
  send "$PROMPT"
  sleep 1
  send Enter
  # Wait up to 70s for the parent to spawn the running child. The live
  # widget shows "⠋ <label>: rounds N/M" once a child is in flight.
  if wait_pane "parent spawns a running subagent (attempt $ATTEMPT)" 70 "$LIVE_CHILD_ERE"; then
    SPAWNED=1
    break
  fi
  info "no running subagent yet — sending harder push"
  # Cancel any leftover editor text and the partial response so the next
  # send starts clean (the parent may have begun typing a "plan" answer).
  for _ in $(seq 1 200); do send BSpace; done
  sleep 0.5
done

if (( SPAWNED == 0 )); then
  capture | tail -25 | sed 's/^/    | /'
  bad 'cannot proceed without a running child to steer (parent refused to spawn)'
  summary
  exit 0
fi

# --- 2. Ctrl+G → picker → Enter → viewer ---------------------------------
send C-g
# Picker marker: the SUB-AGENT / STATS header. The wrapper chrome makes
# this string uniquely present only inside the picker.
wait_pane 'Ctrl+G opens the subagent picker' 10 'SUB-AGENT.*STATS' || summary
evidence 02-picker
PANE="$(capture)"
assert_contains 'picker footer hint rendered' '↑↓ navigate · Enter open · Esc close' "$PANE"

# Enter on the highlighted row (the new running one — top of list).
send Enter
# Viewer footer must contain the steer hint. The string is exact (hardcoded
# in src/subagent-viewer.ts VIEWER_FOOTER) so a fixed-string match is safe.
wait_pane 'viewer opens with Enter-steer footer' 10 'Enter steer' || summary
evidence 03-viewer-footer
PANE="$(capture)"
assert_contains 'viewer footer shows "Esc close"' 'Esc close' "$PANE"
assert_contains 'viewer header shows the running child label' 'running' "$PANE"

# --- 3. Enter → steer input box ------------------------------------------
send Enter
# Steer footer is its own constant — present only inside the input box.
# The viewer disposes, host.open(panel) mounts the SteerInputPanel, then the
# editor paints + the focus flag flip renders the cursor. On a busy parent
# turn (streaming chunks forcing re-renders) the chain measured >30s on the
# host, so poll for a full minute before declaring failure.
wait_pane_fixed 'Enter opens the steer input box' 30 'Enter send · Shift+Enter newline · Esc cancel' || summary
evidence 04-steer-box
PANE="$(capture)"
assert_contains 'steer box title shows the child label' 'Steer ' "$PANE"
assert_contains 'steer box shows the plugin-source caption' \
  'Delivered as a plugin-sourced user message.' "$PANE"

# --- 4. Type + Enter → success notice ------------------------------------
STEER_TEXT='Stop after the next sleep finishes and wrap up now.'
send "$STEER_TEXT"
sleep 0.8
# Guard against the editor not echoing what we typed.
evidence 05-typed
assert_contains 'steer editor echoed the typed text' "$STEER_TEXT" "$(capture)"
send Enter

# Wait for the success notice — STEER_SENT_NOTICE is exact ("Steer message
# sent") and is shown by the viewer on swap-back after a successful
# deliverSubagentSteer.
wait_pane 'success notice "Steer message sent" appears' 10 'Steer message sent' || summary
evidence 06-sent-notice

# --- 5. Transcript shows the injected message ----------------------------
# deliverSubagentSteer splices a plugin-sourced user message into the
# child's inbox. The agent processes it asynchronously (it goes through
# the agent's own inbox queue), then a `user/message` session event fires
# and the bridge's transcript fold picks it up — the viewer renders the
# injection as a non-user `ⓘ <text>` event line. Poll for the text instead
# of asserting immediately: the notice appears synchronously, but the
# transcript update lags until the child consumes the inbox entry at its
# next step boundary (each separate `sleep 8` call bounds that wait).
# The plugin message sits in the child's inbox until its NEXT step boundary
# (between tool calls), so the wait must cover several ~8s sleeps plus LLM
# latency — 150s is comfortably above that.
INJECT_WAITED=0
INJECT_FOUND=0
INJECT_TIMEOUT=150
while (( INJECT_WAITED < INJECT_TIMEOUT )); do
  if capture | grep -qF -- "$STEER_TEXT"; then
    INJECT_FOUND=1
    ok 'viewer transcript contains the injected steer message'
    evidence 07-injected-message
    break
  fi
  sleep 1
  INJECT_WAITED=$((INJECT_WAITED + 1))
done
if (( INJECT_FOUND == 0 )); then
  evidence 07-no-injection
  bad "viewer transcript never showed the injected steer message (${INJECT_TIMEOUT}s)"
  capture | tail -30 | sed 's/^/    | /'
fi

# --- 6. Cancel path: Esc on the steer box --------------------------------
# Still-running child: open picker → viewer → steer box → type → Esc →
# back to the viewer with NO notice (cancel is silent) and nothing delivered.
# The viewer overlay is still up from the injection step — close it first,
# otherwise the Ctrl+G is swallowed by the overlay and the picker never
# opens (which used to skip this whole section silently).
send Escape
sleep 0.5
send C-g
sleep 1
PANE="$(capture)"
if printf '%s' "$PANE" | grep -qF 'SUB-AGENT'; then
  send Enter # open viewer of top row (running)
  sleep 1
  PANE="$(capture)"
  if printf '%s' "$PANE" | grep -qF 'running'; then
    send Enter # open steer box
    sleep 1
    PANE="$(capture)"
    if printf '%s' "$PANE" | grep -qF 'Enter send · Shift+Enter newline · Esc cancel'; then
      CANCEL_TEXT='this should not be delivered'
      send "$CANCEL_TEXT"
      sleep 0.5
      assert_contains 'cancel-path: steer editor echoed the typed text' "$CANCEL_TEXT" "$(capture)"
      send Escape
      sleep 1
      PANE="$(capture)"
      assert_contains 'cancel returns to the viewer' '↑↓ scroll · Esc close' "$PANE"
      if printf '%s' "$PANE" | grep -qF "$CANCEL_TEXT"; then
        bad 'cancel-path: cancelled text leaked into the viewer transcript'
      else
        ok 'cancel-path: cancelled text was NOT delivered'
      fi
      if printf '%s' "$PANE" | grep -qF 'Steer message sent'; then
        bad 'cancel-path: success notice shown despite Esc cancel'
      else
        ok 'cancel-path: no success notice shown after Esc'
        evidence 08-cancel-path
      fi
    else
      warn 'steer box did not open for cancel-path assertion'
    fi
  else
    warn 'no running viewer for cancel-path assertion'
  fi
  send Escape
else
  warn 'picker did not reopen for cancel-path assertion'
fi

# --- 7. Negative path: settled child is rejected -------------------------
# The steer ("stop after the next sleep") makes the child wrap up early.
# Poll the picker until its row turns ✓ (settled) — up to 150s — so the
# rejection is proven against a REAL settled entry, then: Enter opens the
# viewer, Enter again must show the inline ended notice INSTEAD of the
# steer box (steerAvailable() is false for a settled child).
# Up to ~120s of LIVE picker polling: open the picker ONCE and watch the
# settled (✓) row appear without touching the keyboard — stray Escs leak to
# the editor underneath and arm the parent's Esc×2 stop gesture.
send Escape
sleep 0.5
SETTLED=0
send C-g
sleep 1
if printf '%s' "$(capture)" | grep -qF 'SUB-AGENT'; then
  for _ in $(seq 1 30); do
    if printf '%s' "$(capture)" | grep -qE '✓ [^│]*one-shot'; then
      SETTLED=1
      evidence 09-picker-settled
      break
    fi
    sleep 3
  done
else
  warn 'picker did not open for settled-rejection assertion'
fi
if (( SETTLED == 1 )); then
  ok 'picker shows the settled (✓) child after the steer landed'
  # Walk the highlight (▸) onto a settled row: a fast parent may have
  # spawned follow-up children after the early-steer stop, so the ✓ entry
  # is not necessarily the top row.
  NAV=0
  while (( NAV < 6 )); do
    HL="$(capture | grep '▸')"
    case "$HL" in
      *✓*) break ;;
      *) send Down; sleep 0.5; NAV=$((NAV + 1)) ;;
    esac
  done
  if printf '%s' "$(capture | grep '▸')" | grep -q '✓'; then
    send Enter # open the viewer on the settled child
    wait_pane 'viewer opens on the settled child' 10 'completed' || summary
    evidence 10-viewer-settled
    send Enter
    # STEER_ENDED_NOTICE renders as an inline notice INSTEAD of the input
    # box (steerAvailable() is false for a settled child); asserting the
    # absence of the input-box footer proves the rejection contract.
    if wait_pane 'settled child shows the "ended" notice' 10 \
         'This subagent has ended — steering unavailable'; then
      PANE="$(capture)"
      if printf '%s' "$PANE" | grep -qF 'Enter send · Shift+Enter newline · Esc cancel'; then
        bad 'settled child opened the steer input box (should show ended notice instead)'
      else
        ok 'no steer input box opened for settled child'
        evidence 11-settled-notice
      fi
    fi
    send Escape
  else
    warn 'could not move the picker highlight onto the settled row'
    send Escape
  fi
else
  warn 'child never settled within ~120s — settled-rejection path skipped'
  send Escape
fi

# --- 8. Quit TUI ---------------------------------------------------------
# The cleanup trap restores the snapshot; here we just exit the TUI cleanly
# so the snapshot/restore check actually compares on-disk state.
ensure_editor_ready 'editor clean before quit' || true
quit_host_tui 'TUI quits cleanly via Ctrl+C x2' || true
summary