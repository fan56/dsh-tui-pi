#!/usr/bin/env bash
# Scenario 78 — /session panel decode speed + per-model usage rows (v2.29.0).
#
# The speed/models rows price REAL decode windows (first streamed token →
# settlement, tokens = the billed usage), and an instant mock reply would
# price its window at ~0ms — an empty or absurd rate. So this scenario drives
# the new `tps` phase in ../lib/mock-llm.mjs: a scripted ~1.5s tick stream
# whose 24 billed output tokens land at a sane, assertable rate.
#
# Route/model prerequisite: the mock-llm provider committed by 68-ask-user
# (mock-chat as the default model) — same reuse precedent as 69/71. The TUI
# restarts first so the fresh session's stats cover EXACTLY the scripted
# turn (the models row is then deterministic: one route, one request).
#
# Assertions (the /session panel's en locale labels):
#   1. the merged token rows exist (`tok in/out` / `cache r/w`);
#   2. the speed row renders a rounded tok/s (ERE, value is timing-dependent);
#   3. the models row lists the billed route: `mock-chat 1×24 <n>t/s` —
#      short route name, request count × output tokens, per-model rate;
#   4. Esc closes and the editor still works.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario '/session panel: decode speed + per-model usage rows'

# --- host guard -------------------------------------------------------------
# Like 68/69/71: this scenario starts a local mock server and drives the TUI
# against it — container's throwaway ~/.dsh only.
if [ ! -d /e2e/scenarios ]; then
  warn 'host environment detected — skipping (starts a mock LLM server; container only)'
  summary
  exit 0
fi

if ! grep -qF 'mock-llm' "$HOME/.dsh/profiles/tui/cordis.patch.yml" 2>/dev/null; then
  warn 'mock-llm route missing from the profile patch (run 68-ask-user first) — skipping'
  summary
  exit 0
fi

# --- fresh session: the models row must cover ONLY the scripted turn ---------
if tui_alive; then
  quit_tui 'clean exit of the previous scenario TUI'
fi
info 'restarting the TUI — a cold start lazily creates a fresh session (stats from zero)'
start_tui 'DSH_TUI_THEME=dark'
wait_tui_up 120 || { summary; exit 0; }
ensure_editor_ready 'editor clean before the stats turn' || true

# --- the mock LLM server (68/69/71 pattern) ----------------------------------
# Port 8642 is NOT arbitrary: the mock-llm ROUTE committed into the profile
# patch by 68 points at 127.0.0.1:8642 — a mock on any other port leaves the
# route dialing a dead endpoint (the turn never completes).
MOCK_PORT=8642
MOCK_LOG=/tmp/mock-llm-78.log
node "$(dirname "$0")/../lib/mock-llm.mjs" --port "$MOCK_PORT" >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
cleanup() { kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

MOCK_UP=0
for _ in $(seq 1 15); do
  if curl -sf "http://127.0.0.1:$MOCK_PORT/healthz" >/dev/null 2>&1; then
    MOCK_UP=1
    break
  fi
  sleep 1
done
if (( MOCK_UP == 1 )); then
  ok "mock LLM server up on 127.0.0.1:$MOCK_PORT"
else
  bad "mock LLM server did not come up; log tail:"
  tail -10 "$MOCK_LOG" 2>/dev/null | sed 's/^/    | /'
  summary
  exit 0
fi

# --- one timed billed turn ---------------------------------------------------
send 'Prove the decode-rate row now. E2E_TPS_TRIGGER'
sleep 1
send Enter
if ! wait_pane 'timed turn completes' 45 'E2E-TPS-TURN-DONE'; then
  info 'turn never finished — mock server log tail:'
  tail -10 "$MOCK_LOG" 2>/dev/null | sed 's/^/    | /'
  summary
  exit 0
fi
if grep -q 'phase=tps' "$MOCK_LOG" 2>/dev/null; then
  ok 'the mock served the scripted tps phase'
else
  bad 'the mock never saw the tps phase; log tail:'
  tail -8 "$MOCK_LOG" 2>/dev/null | sed 's/^/    | /'
fi

# --- /session panel: the three new/merged row groups -------------------------
send '/session'
sleep 0.5
send Enter
wait_pane 'session panel opens' 10 'Esc to close' || { summary; exit 0; }
PANE="$(capture)"
evidence_file="${EVID_DIR:-/tmp/e2e-results}/78-session-panel.txt"
mkdir -p "$(dirname "$evidence_file")"
printf '%s' "$PANE" >"$evidence_file"

assert_contains 'merged token row exists (tok in/out)' 'tok in/out' "$PANE"
assert_contains 'merged cache row exists (cache r/w)' 'cache r/w' "$PANE"
assert_matches 'speed row renders a rounded decode rate' 'speed[[:space:]│]*[0-9]+ tok/s' "$PANE"
assert_matches 'models row lists the billed route with count × tokens × rate' \
  'models[[:space:]│]*mock-chat 1×24 [0-9]+t/s' "$PANE"

# --- close, editor still usable ----------------------------------------------
send Escape
sleep 1
wait_gone 'panel closes on Esc' 10 'Esc to close'
ensure_editor_ready 'editor focused after the panel closed' || true

summary
