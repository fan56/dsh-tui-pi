#!/usr/bin/env bash
# Scenario 71 — footer CH (cache-hit) segment: lastMessage default + live
# session-mode switch (v2.8.0 cacheHitMode).
#
# The CH segment rates depend on REAL billed usage, and the container has no
# provider credentials — so this scenario reuses the local OpenAI-compatible
# mock server (../lib/mock-llm.mjs, the 68/69 pattern) and its new
# cache-bearing usage phases. Two scripted turns carry DIFFERENT cache ratios
# (OpenAI prompt_tokens_details.cached_tokens, mapped to cacheRead by pi-ai's
# adapter):
#
#   turn one: 1000 prompt tokens, 900 cached  -> that message's rate is 90%
#   turn two: 1000 prompt tokens, 200 cached  -> that message's rate is 20%
#   session cumulative over both: 1100 read / 2000 billed = 55%
#
# The three rates are mutually distinct, so the footer's displayed value
# identifies the active mode. The scenario runs against a FRESH session
# (clean TUI restart — a cold start lazily creates a new session, no auto-
# resume) so the cumulative denominator is exactly the two scripted turns:
#
#   1. no usage yet -> no CH segment at all;
#   2. after turn one the segment shows 90% (both modes agree on one sample);
#   3. after turn two the DEFAULT mode (lastMessage, the pi-tui semantics)
#      shows 20% — the stale 90% and the cumulative 55% must both be absent;
#   4. committing `cacheHitMode: session` into the container's settings.yaml
#      (an external edit, live-applied through the settings watch hook)
#      flips the same segment to 55% without a restart.
#
# Route/model prerequisite: the mock-llm provider committed by 68-ask-user
# (and mock-chat as the default model) — same reuse precedent as 69-btw.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'footer CH: lastMessage default (pi-tui semantics) + live session-mode switch'

# --- host guard -------------------------------------------------------------
# Like 68/69: this scenario permanently mutates dsh config (writes
# cacheHitMode into settings.yaml) — container's throwaway ~/.dsh only.
if [ ! -d /e2e/scenarios ]; then
  warn 'host environment detected — skipping (persists cacheHitMode into ~/.dsh; container only)'
  summary
  exit 0
fi

if ! grep -qF 'mock-llm' "$HOME/.dsh/settings.yaml" 2>/dev/null; then
  warn 'mock-llm route missing from settings.yaml (run 68-ask-user first) — skipping'
  summary
  exit 0
fi

# --- fresh session: the cumulative rate must cover ONLY the scripted turns ---
if tui_alive; then
  quit_tui 'clean exit of the previous scenario TUI'
fi
info 'restarting the TUI — a cold start lazily creates a fresh session (stats from zero)'
start_tui 'DSH_TUI_THEME=dark'
wait_tui_up 120 || { summary; exit 0; }
ensure_editor_ready 'editor clean before the CH turns' || true

# --- the mock LLM server (68/69 pattern) -------------------------------------
MOCK_PORT=8642
MOCK_LOG=/tmp/mock-llm-71.log
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

# --- 1. no usage yet -> no CH segment ----------------------------------------
PANE="$(capture)"
assert_not_contains 'no CH segment before any billed usage' '⚡ CH' "$PANE"

# --- 2. turn one (warm cache): CH 90% -----------------------------------------
send 'Prove the warm cache path now. E2E_CH_TRIGGER'
sleep 1
send Enter
if ! wait_pane 'turn one completes with the warm-cache reply' 45 'E2E-CH-TURN-ONE'; then
  info 'turn one never finished — mock server log tail:'
  tail -10 "$MOCK_LOG" 2>/dev/null | sed 's/^/    | /'
  summary
  exit 0
fi
# The footer updates on the finalized assistant/message (its usage snapshot),
# which trails the streamed text — poll for the segment rather than snapshot.
wait_pane 'turn one shows its 90% hit rate' 15 'CH90\.0%'

# --- 3. turn two (cold cache): the DEFAULT mode follows the latest message ----
send 'Prove the cold cache path now. E2E_CH_TRIGGER'
sleep 1
send Enter
if ! wait_pane 'turn two completes with the cold-cache reply' 45 'E2E-CH-TURN-TWO'; then
  info 'turn two never finished — mock server log tail:'
  tail -10 "$MOCK_LOG" 2>/dev/null | sed 's/^/    | /'
  summary
  exit 0
fi
wait_pane 'default lastMessage mode shows the latest message rate (20%)' 15 'CH20\.0%'
PANE="$(capture)"
assert_not_contains 'the previous message rate does not stick (sample follows the latest)' 'CH90\.0%' "$PANE"
assert_not_contains 'the session-cumulative rate does not leak into lastMessage mode' 'CH55\.0%' "$PANE"

# --- 4. external settings edit flips the mode live -----------------------------
# An external settings.yaml edit is a committed change (the namespace is
# applies:'live') — the footer re-reads the mode on every render, so the
# segment flips on the next repaint without a restart.
SETTINGS="$HOME/.dsh/settings.yaml"
if grep -qF 'cacheHitMode' "$SETTINGS"; then
  sed -i 's/^\(  *cacheHitMode: *\).*/\1session/' "$SETTINGS"
elif grep -q '^dsh-tui:' "$SETTINGS"; then
  awk '{print} /^dsh-tui:/ && !inserted {print "  cacheHitMode: session"; inserted=1}' "$SETTINGS" >"$SETTINGS.tmp" \
    && mv "$SETTINGS.tmp" "$SETTINGS"
else
  { printf 'dsh-tui:\n  cacheHitMode: session\n'; cat "$SETTINGS"; } >"$SETTINGS.tmp" \
    && mv "$SETTINGS.tmp" "$SETTINGS"
fi
if grep -q 'cacheHitMode: session' "$SETTINGS"; then
  ok 'settings.yaml now carries cacheHitMode: session'
else
  bad 'cacheHitMode: session did not land in settings.yaml'
fi

wait_pane 'session mode flips the footer to the cumulative rate (live apply)' 15 'CH55\.0%'
PANE="$(capture)"
assert_not_contains 'the per-message rate does not leak into session mode' 'CH20\.0%' "$PANE"

if grep -q 'phase=ch-warm' "$MOCK_LOG" 2>/dev/null \
  && grep -q 'phase=ch-cold' "$MOCK_LOG" 2>/dev/null; then
  ok 'the mock served both scripted cache phases'
else
  bad 'the mock never saw both CH phases; log tail:'
  tail -8 "$MOCK_LOG" 2>/dev/null | sed 's/^/    | /'
fi

summary
