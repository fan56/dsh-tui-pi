#!/usr/bin/env bash
# Shared helpers for the e2e scenarios: assertion primitives with per-scenario
# counters, tmux driving (a real PTY) around `dsh --profile tui`, and the UI
# marker strings asserted across the suite. Sourced by each scenario script;
# $0 is still the scenario, so the result file derives from its basename.
#
# All state lives inside the container (~/.dsh of the image user) — nothing
# here touches host configuration.

# --- identity / counters ----------------------------------------------------
SCENARIO="$(basename "$0" .sh)"
RESULTS_DIR="${RESULTS_DIR:-/tmp/e2e-results}"
mkdir -p "$RESULTS_DIR"
PASS=0 FAIL=0 WARN=0

scenario() { printf '\n=== [%s] %s ===\n' "$SCENARIO" "$*"; }
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$*"; }
warn() { WARN=$((WARN + 1)); printf '  warn %s\n' "$*"; }
info() { printf '  [info] %s\n' "$*"; }

summary() {
  printf '%d %d %d\n' "$PASS" "$FAIL" "$WARN" >"$RESULTS_DIR/$SCENARIO.result"
  printf '  -- %s: %d pass, %d fail, %d warn\n' "$SCENARIO" "$PASS" "$FAIL" "$WARN"
}

# --- assertions -------------------------------------------------------------
assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    ok "$label"
    return 0
  fi
  bad "$label (substring not found: $needle); haystack tail:"
  printf '%s\n' "$haystack" | tail -6 | sed 's/^/    | /'
  return 1
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    bad "$label (substring still present: $needle); haystack tail:"
    printf '%s\n' "$haystack" | tail -6 | sed 's/^/    | /'
    return 1
  fi
  ok "$label"
  return 0
}

assert_matches() {
  local label="$1" ere="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qE -- "$ere"; then
    ok "$label"
    return 0
  fi
  bad "$label (ERE not matched: $ere); haystack tail:"
  printf '%s\n' "$haystack" | tail -6 | sed 's/^/    | /'
  return 1
}

# --- UI markers (kept in sync with src/) --------------------------------------
# Whale art row (src/welcome.ts WHALE_ART) — mid-line substring so trailing-
# space trimming by capture-pane cannot break the match.
WHALE_ROW='▄██████████████▄  ████████'
# Lower whale rows for narrow viewports where the top rows scroll out.
WHALE_ANY_ERE='(▀██        ▀████▄ ████▀|▀██▄   █▄▄  ▀█████▀|▀▀███▄▄███▄▄▄█████▄|▀▀▀████▀▀▀)'
# The DSH wordmark's H crossbar folds to a 16-block full-block run; whale art
# tops out at 14 — a fixed 15-block string separates the two. A fixed string,
# because grep interval quantifiers do not work on multibyte glyphs.
WORDBLOCK_15="$(printf '█%.0s' $(seq 1 15))"

MARKER_FOOTER_HINT='Ctrl+C ×2: quit'      # src/footer.ts FOOTER_HINT
MARKER_CWD_BORDER='📁 /app'                # editor border info (container cwd)
SGR_CANVAS_DARK='48;2;13;17;23'            # theme/palette.ts canvas #0d1117
SGR_CANVAS_LIGHT='48;2;252;253;252'        # canvas #fcfdfc

MARKER_EFFORT_PICKER='● Reasoning effort'          # selectors.ts openEffortPicker
MARKER_SETTINGS_BROWSER='⚙ settings'               # settings.ts browser title
MARKER_RESUME_NO_SESSIONS='No other persisted sessions to resume.'
MARKER_HOTKEYS_PANEL='⚙ hotkeys'                   # hotkeys.ts FieldPanel title
MARKER_PERMISSION='● Permission preset'            # selectors.ts pickPermission
MARKER_MODEL_PICKER='● Model'                      # selectors.ts pickModel
MARKER_MODEL_ROW='deepseek-v4-flash'               # built-in default model row
MARKER_THEME_ROWS='● Theme'                        # selectors.ts pickTheme

has_wordmark() {
  printf '%s' "$1" | grep -qF -- "$WORDBLOCK_15"
}

# --- tmux session -------------------------------------------------------------
TS=dsh-tui-e2e
TUI_COLS=140
TUI_ROWS=36

capture() { tmux capture-pane -t "$TS" -p 2>/dev/null; }
capture_sgr() { tmux capture-pane -t "$TS" -p -e 2>/dev/null; }
send() { tmux send-keys -t "$TS" "$@"; }
pane_command() { tmux display-message -p -t "$TS" '#{pane_current_command}' 2>/dev/null; }

tui_alive() {
  tmux has-session -t "$TS" 2>/dev/null \
    && [[ "$(pane_command)" != bash ]]
}

start_tui() {
  local env_prefix="${1:-}"
  tmux kill-session -t "$TS" 2>/dev/null || true
  sleep 0.3
  # -c pins the pane shell (and thus the TUI session cwd) to the image
  # WORKDIR — the runner's cd into e2e/scenarios must not leak into the
  # editor border (MARKER_CWD_BORDER asserts the /app path).
  tmux new-session -d -s "$TS" -x "$TUI_COLS" -y "$TUI_ROWS" -c /app
  tmux send-keys -t "$TS" "${env_prefix:+$env_prefix }dsh --profile tui" Enter
}

wait_tui_up() {
  local timeout="${1:-120}" waited=0 pane
  while (( waited < timeout )); do
    pane="$(capture)"
    if printf '%s' "$pane" | grep -qF -- "$WHALE_ROW" \
      && printf '%s' "$pane" | grep -qF -- "$MARKER_FOOTER_HINT"; then
      sleep 2 # let the editor chrome finish its first full paint
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  bad "TUI did not come up within ${timeout}s; last pane tail:"
  capture | tail -12 | sed 's/^/    | /'
  return 1
}

# Poll until an ERE appears in the pane (records the verdict itself).
wait_pane() {
  local label="$1" timeout="$2" ere="$3" waited=0
  while (( waited < timeout )); do
    if capture | grep -qE -- "$ere"; then
      ok "$label"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  bad "$label (timed out after ${timeout}s)"
  return 1
}

# Poll until an ERE disappears (no keypresses sent).
wait_gone() {
  local label="$1" timeout="$2" ere="$3" waited=0
  while (( waited < timeout )); do
    if ! capture | grep -qE -- "$ere"; then
      ok "$label"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  bad "$label (still present after ${timeout}s)"
  return 1
}

esc_until_gone() {
  local label="$1" ere="$2" attempt
  for attempt in 1 2 3 4 5; do
    send Escape
    sleep 1
    if ! capture | grep -qE -- "$ere"; then
      ok "$label"
      return 0
    fi
  done
  bad "$label (still up after 5 Esc presses)"
  return 1
}

# Make sure the slash-command editor is focused and empty: close any overlay,
# blind-clear leftovers (no-op on an empty line), then prove focus with a
# probe string and remove it again.
ensure_editor_ready() {
  local label="$1" probe='rdy-probe' attempt i
  for attempt in 1 2; do
    send Escape
    sleep 0.6
    for i in $(seq 1 40); do send BSpace; done
    sleep 0.4
    send "$probe"
    sleep 1.2
    if capture | grep -qF -- "$probe"; then
      for i in $(seq 1 ${#probe}); do send BSpace; done
      sleep 0.6
      if ! capture | grep -qF -- "$probe"; then
        ok "$label"
        return 0
      fi
      bad "$label (backspace did not clear the probe)"
      return 1
    fi
  done
  bad "$label (editor did not echo the probe)"
  return 1
}

# Quit via Ctrl+C x2 — the second press must land 150–500ms after the first
# (src/keymap.ts): closer reads as key-repeat, farther misses the window.
quit_tui() {
  local label="$1" waited=0
  send C-c
  sleep 0.3
  send C-c
  while (( waited < 8 )); do
    if [[ "$(pane_command)" == bash ]] && capture | grep -q 'root@'; then
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
    if [[ "$(pane_command)" == bash ]]; then
      warn "$label (needed the Ctrl+D fallback)"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  bad "$label (TUI still running)"
  return 1
}

kill_tui() {
  if tmux has-session -t "$TS" 2>/dev/null; then
    send C-c
    sleep 0.4
    send C-d
    sleep 0.8
    tmux kill-session -t "$TS" 2>/dev/null || true
  fi
}
