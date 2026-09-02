#!/usr/bin/env bash
# Scenario 69 — /btw side questions (v1.1.0), driven fully offline through
# the local mock LLM that 68-ask-user.sh committed into settings.yaml (route
# mock-llm -> http://127.0.0.1:8642/v1, default model mock-chat).
#
# Covers the /btw decision layer (src/btw.ts) + overlay (src/btw-overlay.ts):
#
#   idle paths (fresh TUI, no turn running):
#     1. bare /btw with an empty Last-btw slot -> the usage text;
#     2. /btw <question> while idle -> BTW_IDLE_NOTICE (a normal prompt is
#        strictly better when nothing runs);
#     3. /btw --model without a question -> the inline argument error;
#
#   busy paths (a slow main turn from the mock's E2E_BTW_MAIN phase keeps the
#   line running for ~42s while two side calls fire into the window; the
#   overlay captures the keyboard while open, so the queue leg closes it
#   first — Esc never stops the run):
#     4. started echo 'btw — answering alongside the main task.' + the framed
#        overlay with the model label '⌘ btw — mock-llm/mock-chat' and
#        'Thinking…' while the mock holds;
#     5. Esc closes the overlay without stopping the run;
#     6. a second /btw queues behind the still-running first: echo 'btw
#        queued (position 1).';
#     7. bare /btw reopens the live run ('btw — the running answer is back
#        on screen.'), the first answer streams in, and the settled overlay
#        shows 'Not kept in the session · /btw reopens this answer';
#     8. the drained job promotes UNDER the still-open overlay ->
#        hasCapturingSurface skips the popup and a footer notice says
#        'btw running in the background — /btw to view the answer.';
#     9. Esc again, then bare /btw reopens the drained run and its answer
#        surfaces in the overlay;
#    10. Esc closes the overlay and NEITHER answer marker appears anywhere in
#        the transcript — the screen-level proof that a side call never
#        enters the session (the mock session store is zstd-framed, so a
#        file-level grep cannot see the bytes);
#    11. the main line is untouched: its own tick stream finishes with
#        E2E-BTW-MAIN-DONE and the transcript stays clean;
#    12. the Last-btw review: bare /btw after close shows the last exchange
#        ('Last btw exchange shown.' + answer + the not-kept badge).
#
# The mock keys phases on the request body (E2E_BTW_Q / E2E_BTW_MAIN), never
# on arrival order; the Q key is checked first because the side call's
# snapshot embeds the main prompt.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'btw: side questions over the mock LLM (idle, queue, overlay, not-persisted)'

# --- guards -------------------------------------------------------------------
# Container-only: needs the mock route 68 committed into settings.yaml plus a
# throwaway ~/.dsh — on the host it would depend on (or poison) live config.
if [ ! -d /e2e/scenarios ]; then
  warn 'host environment detected — skipping (needs the container mock route + throwaway ~/.dsh)'
  summary
  exit 0
fi
if ! grep -qF 'mock-llm' "$HOME/.dsh/settings.yaml" 2>/dev/null; then
  warn 'mock-llm route not configured (68-ask-user must run first) — skipping'
  summary
  exit 0
fi

# --- the mock LLM server (same port as the committed route) -------------------
MOCK_PORT=8642
MOCK_LOG=/tmp/mock-llm-69.log
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
  bad 'mock LLM server did not come up; log tail:'
  tail -10 "$MOCK_LOG" 2>/dev/null | sed 's/^/    | /'
  summary
  exit 0
fi

# --- fresh TUI on the mock default model ---------------------------------------
kill_tui
start_tui 'DSH_TUI_THEME=dark'
wait_tui_up 120 || { summary; exit 0; }
PANE="$(capture)"
assert_contains 'footer carries the mock default model' 'mock-chat' "$PANE"
ensure_editor_ready 'editor clean before the idle probes' || true

# --- idle paths ----------------------------------------------------------------
# One atomic send per command line: Enter lands before the autocomplete popup
# can own the keys (the house pattern of 30/60/65).
send '/btw' Enter
wait_pane 'bare /btw with an empty slot shows the usage text' 20 'Usage: /btw <question>'
ensure_editor_ready 'editor clean after the usage probe' || true

send '/btw what gives' Enter
wait_pane 'idle rejection: /btw refuses while the main line is idle' 20 \
  'the main line is idle, so just ask directly'
ensure_editor_ready 'editor clean after the idle rejection' || true

send '/btw --model mock-llm/mock-chat' Enter
wait_pane 'missing question after --model errors inline' 20 'No question after /btw --model.'
ensure_editor_ready 'editor clean before the busy flow' || true

# --- busy flow: slow main turn + two side calls ---------------------------------
# Keyboard ownership shapes the flow: while the overlay is open it captures
# the keys, so the queue test closes the overlay first (Esc NEVER stops the
# run — the call keeps streaming into the Last-btw slot) and reopens it via
# bare /btw afterwards.
send 'Walk the migration plan step by step. E2E_BTW_MAIN' Enter
if ! wait_pane 'main turn starts streaming its ticks' 45 'main-line progress tick'; then
  info 'main turn never started — mock server log tail:'
  tail -10 "$MOCK_LOG" 2>/dev/null | sed 's/^/    | /'
  summary
  exit 0
fi

send '/btw E2E_BTW_Q1 what is the deploy status' Enter
wait_pane 'side call starts: command echo' 15 'btw — answering alongside the main task.'
wait_pane 'overlay opens with the side model label' 15 '⌘ btw — mock-llm/mock-chat'
wait_pane 'overlay shows Thinking… while the mock holds' 8 'Thinking…'

send Escape # overlay closes; the side call keeps streaming
wait_gone 'Esc closes the overlay without stopping the run' 10 '⌘ btw —'

send '/btw E2E_BTW_Q2 and the rollback plan' Enter
wait_pane 'second /btw queues behind the still-running first' 15 'btw queued \(position 1\)'

send '/btw' Enter
wait_pane 'bare /btw reopens the live run' 15 'the running answer is back on screen'
wait_pane 'first answer streams into the reopened overlay' 20 'E2E-BTW-ANSWER-ONE'
wait_pane 'settled badge: not kept in the session' 15 \
  'Not kept in the session · /btw reopens this answer'
wait_pane 'drained job promotes under the open overlay as a notice' 15 \
  'btw running in the background'

send Escape # release the keyboard again — the drained run keeps streaming into the slot
wait_gone 'Esc releases the keyboard after the promote notice' 10 '⌘ btw —'

send '/btw' Enter
wait_pane 'bare /btw reopens the drained run' 15 'the running answer is back on screen'
wait_pane 'second answer surfaces in the reopened overlay' 25 'E2E-BTW-ANSWER-TWO'

send Escape
wait_gone 'Esc closes the overlay' 15 '⌘ btw —'
PANE="$(capture)"
assert_not_contains 'answer one never lands in the transcript' 'E2E-BTW-ANSWER-ONE' "$PANE"
assert_not_contains 'answer two never lands in the transcript' 'E2E-BTW-ANSWER-TWO' "$PANE"
assert_contains 'main line was never disrupted by the side calls' 'main-line progress tick' "$PANE"

wait_pane 'main turn finishes normally after the slow stream' 90 'E2E-BTW-MAIN-DONE'
PANE="$(capture)"
assert_not_contains 'transcript stays clean after the main turn' 'E2E-BTW-ANSWER-ONE' "$PANE"
assert_not_contains 'the side model label is gone with the overlay' '⌘ btw —' "$PANE"

# --- Last-btw review -------------------------------------------------------------
send '/btw' Enter
wait_pane 'bare /btw after close shows the Last-btw slot' 15 'Last btw exchange shown'
wait_pane 'review carries the last answer' 10 'E2E-BTW-ANSWER-TWO'
wait_pane 'review keeps the not-kept badge' 10 'Not kept in the session'
send Escape
wait_gone 'Esc closes the review overlay' 10 '⌘ btw —'

summary
