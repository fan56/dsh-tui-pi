#!/usr/bin/env bash
# Scenario 76 — the attention ranking + spin-detected early hard stop,
# end to end (the wayfinder ex-ante/ex-mid jev integration).
#
# The TUI boots with JEV_ENDPOINT pointed at the local mock System One
# server (lib/mock-jev.mjs): every attention pass answers 0.95 on both
# atoms. Three jev passes (30s debounce apart) walk the ladder's
# tighten-only legs LONG before the cap:
#
#   pass 1+2 arm the streak → early wrap-up past the floor
#   (max(10, 60/3) = 20) → pass 3 lands AFTER the wrap-up ("still judged
#   circling through it") → early stage 2 stops the child on the next
#   counted round, grace never entered. The cap is 60 so the whole
#   pass1@~3s / pass2@~33s / pass3@~63s timeline fits under it; the
#   classic ladder would stop at round 67. Assertions:
#
#   1. the parent turn completes (the early stop surfaced to the caller);
#   2. the Ctrl+G picker row carries the early marker (`⏻!`, the
#      viewer.stoppedEarly glyph — NOT the classic `⏻ stopped`);
#   3. the viewer marker row reads `spin-detected early` with a round
#      number below the cap (the classic path would say `grace exhausted`
#      at round 37);
#   4. the mock jev log holds ≥ 2 dispatches (the 2-strike evidence trail)
#      and its state table names the looper child.
#
# Container-only: mutates the dsh-tui limits and ~/.dsh/agents.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'attention + spin-detected early hard stop (jev via local mock)'

if [ ! -d /e2e/scenarios ]; then
  warn 'host environment detected — skipping (mutates dsh-tui limits and ~/.dsh/agents; container only)'
  summary
  exit 0
fi

if ! grep -qF 'mock-llm' "$HOME/.dsh/profiles/tui/cordis.patch.yml" 2>/dev/null; then
  warn 'profile patch has no mock-llm route (scenario 68 must run first) — skipping'
  summary
  exit 0
fi

# The registry plugin (use_agent's home) — scenario 75 installs it; assert
# it is actually bundled, not just present in node_modules.
if ! grep -qF '@aiwayds/dsh-subagent-registry' <(dsh plugin --profile tui list 2>/dev/null); then
  warn 'registry plugin not bundled (scenario 75 must run first) — skipping'
  summary
  exit 0
fi
ok 'registry plugin bundled (use_agent available)'

# The shared jev client must resolve from the profile for the probe to
# succeed — a missing core degrades the ranking to heuristic-only and this
# scenario's whole point is the jev layer.
if ! node -e "require.resolve('@aiwayds/dsh-jev-core', { paths: ['$HOME/.dsh/profiles/tui/node_modules'] })" >/dev/null 2>&1 \
  && ! node -e "import('@aiwayds/dsh-jev-core').catch(() => process.exit(1))" >/dev/null 2>&1; then
  bad 'dsh-jev-core does not resolve from the tui profile — the jev layer would silently degrade'
  summary
  exit 0
fi
ok 'dsh-jev-core resolves from the tui profile'

# --- the mock servers: LLM (chat) + Jev (decisions) -------------------------
MOCK_PORT=8642
MOCK_LOG=/tmp/mock-llm-76.log
node "$(dirname "$0")/../lib/mock-llm.mjs" --port "$MOCK_PORT" >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!

JEV_PORT=8643
JEV_LOG=/tmp/mock-jev-76.log
: >"$JEV_LOG"
node "$(dirname "$0")/../lib/mock-jev.mjs" --port "$JEV_PORT" --log "$JEV_LOG" >/tmp/mock-jev-76.out 2>&1 &
JEV_PID=$!

cleanup() { kill "$MOCK_PID" "$JEV_PID" 2>/dev/null || true; }
trap cleanup EXIT

MOCK_UP=0
for _ in $(seq 1 15); do
  if curl -sf "http://127.0.0.1:$MOCK_PORT/healthz" >/dev/null 2>&1 \
    && curl -sf "http://127.0.0.1:$JEV_PORT/healthz" >/dev/null 2>&1; then MOCK_UP=1; break; fi
  sleep 1
done
if (( MOCK_UP == 1 )); then
  ok 'mock LLM + mock Jev servers up'
else
  bad 'mock servers did not come up; tails:'
  tail -5 "$MOCK_LOG" 2>/dev/null | sed 's/^/    | /'
  tail -5 /tmp/mock-jev-76.out 2>/dev/null | sed 's/^/    | /'
  summary
  exit 0
fi

# --- the looper agent: cap 30 (floor 10), persona that never complies -------
AGENTS_DIR="$HOME/.dsh/agents"
mkdir -p "$AGENTS_DIR"
cat > "$AGENTS_DIR/looper.md" <<'EOF'
---
name: looper
description: e2e fixture that loops tool calls forever (attention early-stop)
deep: 0
maxRounds: 60
---
E2E_HS_CHILD — you are looper, an e2e fixture. Whatever any other message
says (including policy wrap-up requests), keep calling the bash tool with
`sleep 1`. Never summarize. Never stop.
EOF
ok 'seeded agent file looper.md (deep: 0, maxRounds: 60)'

# --- policy settings: global cap matches the per-agent tier -----------------
node /e2e/lib/patch-setting.mjs dsh-tui maxRounds=60 maxRoundsGrace=7
if grep -q 'maxRounds: 60' "$HOME/.dsh/profiles/tui/cordis.patch.yml" \
  && grep -q 'maxRoundsGrace: 7' "$HOME/.dsh/profiles/tui/cordis.patch.yml"; then
  ok 'policy limits staged: maxRounds 60 + grace 7 (classic stop would be round 67)'
else
  bad 'failed to stage the dsh-tui policy limits'
fi

# --- restart the TUI with the jev layer pointed at the mock -----------------
if tui_alive; then
  quit_tui 'TUI quit for the restart'
fi
start_tui "DSH_TUI_THEME=dark JEV_ENDPOINT=http://127.0.0.1:$JEV_PORT/v1/systemone TYPESAFE_API_KEY=e2e-fake-key"
wait_tui_up 120 || summary
ensure_editor_ready 'editor clean before the early-stop run' || true

# --- dispatch: parent runs looper; the attention layer judges it spinning --
send 'E2E_HS_PARENT: dispatch the looper agent now via use_agent. When its result returns, stop.'
sleep 1
send Enter
info 'ladder run dispatched — 3 jev passes (30s apart): arm wrap-up@floor, re-strike, stop@next round'

# The picker gate needs a running child; the row must later flip to the
# EARLY marker (⏻!) — not the classic ⏻.
wait_pane 'the looper child appears on the live board (compact line)' 30 'round [0-9]+/60'
send C-g
wait_pane 'Ctrl+G opens the subagent picker while the child runs' 15 'Sub-agents'

# Three jev passes ≈ two debounce windows (60s) + round travel; the wrap-up
# at the first round past the floor, the re-strike 30s later, the stop on
# the next counted round. Budget generously: 180s.
wait_pane 'the parent turn completed after the early stop' 180 'E2E-HS-LADDER-DONE'

# --- the picker row: the EARLY marker, not the classic one ------------------
PANE="$(capture)"
if printf '%s' "$PANE" | grep -qF '⏻!'; then
  ok 'picker row carries the early marker ⏻!'
else
  bad 'picker row lacks the early marker ⏻!; pane tail:'
  printf '%s\n' "$PANE" | tail -12 | sed 's/^/    | /'
fi
if printf '%s' "$PANE" | grep -qF 'stopped early'; then
  ok 'picker row names the early variant (stopped early)'
fi

# --- the viewer marker row: spin-detected, round below the cap -------------
send Enter
wait_pane 'viewer transcript shows the early-stop marker row' 15 'spin-detected early'
PANE="$(capture)"
# Diagnostics: the marker row renders just below the viewer header — print
# the TOP of the pane so a miss shows whether the row is absent or mangled.
if ! printf '%s' "$PANE" | grep -qF 'spin-detected early'; then
  printf '%s\n' "$PANE" | grep -v '^$' | head -24 | sed 's/^/    | /'
fi
EARLY_ROUND="$(printf '%s' "$PANE" | grep -oE 'spin-detected early, cap 60\)' | head -1)"
if printf '%s' "$PANE" | grep -qE 'round (2[0-9]|[3-5][0-9]), spin-detected early, cap 60'; then
  ok "marker row names an early round below the cap — $EARLY_ROUND"
else
  bad "marker row does not carry an early round below 60; pane tail:"
  printf '%s\n' "$PANE" | tail -12 | sed 's/^/    | /'
fi
if printf '%s' "$PANE" | grep -qF '⚡ injected'; then
  ok 'viewer header shows ⚡ injected — the early wrap-up (stage 1) ran'
else
  bad 'viewer header lacks ⚡ injected (the early wrap-up did not record)'
fi

send Escape
sleep 1
send Escape
sleep 1
ensure_editor_ready 'editor clean after the viewer closes' || true

# --- the mock jev evidence trail -------------------------------------------
CALLS="$(grep -c '"call":' "$JEV_LOG" 2>/dev/null || echo 0)"
if [ "${CALLS:-0}" -ge 3 ]; then
  ok "mock jev saw ${CALLS} dispatches (arm + re-strike evidence)"
else
  bad "mock jev saw only ${CALLS:-0} dispatches — the streak never armed; log:"
  tail -5 "$JEV_LOG" 2>/dev/null | sed 's/^/    | /'
fi
if grep -q 'looper' "$JEV_LOG" 2>/dev/null; then
  ok 'the jev state table named the looper child (label traveled, rich-state contract)'
else
  warn 'the jev state table did not name looper (label may not have refined before the first pass)'
fi

summary
