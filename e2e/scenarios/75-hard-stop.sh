#!/usr/bin/env bash
# Scenario 75 — the maxRounds hard-stop ladder, end to end (v2.11.0).
#
# The wrap-up injection is advisory and a runaway child ignores it; the
# ladder's stage 2 force-stops the child by code. This scenario drives that
# exact shape offline through the local mock LLM:
#
#   looper.md declares `maxRounds: 5` (the per-agent tier) and a persona
#   marker (E2E_HS_CHILD) that makes every one of its mock responses another
#   `bash sleep 1` tool call — the child NEVER complies with the wrap-up.
#   The global policy is set tighter (maxRounds: 3 + maxRoundsGrace: 2), so
#   the observed cap tells the two tiers apart: the ladder must fire at
#   round 7 = 5 + 2 with `cap 5` (per-agent), never at 5 = 3 + 2 (global).
#
#   The parent marker (E2E_HS_PARENT) makes the main agent dispatch looper
#   through use_agent (foreground one-shot), and once that tool result
#   returns — the child cancelled with its partial output — finish with the
#   done text. Assertions:
#
#   1. the parent turn completes (the stop surfaced to the caller);
#   2. the Ctrl+G picker shows the looper row with `⏻ stopped`;
#   3. the viewer transcript carries the marker row `⏻ hard-stopped by
#      maxRounds policy (round 7 + grace exhausted, cap 5)`;
#   4. the viewer header shows `⚡ injected` (stage 1 ran) next to
#      `⏻ hard-stopped @7` (stage 2 fired at the frozen cap + grace).
#
# Container-only: mutates settings.yaml (dsh-tui limits) and ~/.dsh/agents.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'hard-stop ladder: wrap-up ignored, force-stopped at cap+grace'

if [ ! -d /e2e/scenarios ]; then
  warn 'host environment detected — skipping (mutates settings.yaml and ~/.dsh/agents; container only)'
  summary
  exit 0
fi

if ! grep -qF 'mock-llm' "$HOME/.dsh/settings.yaml" 2>/dev/null; then
  warn 'settings.yaml has no mock-llm route (scenario 68 must run first) — skipping'
  summary
  exit 0
fi

# --- the registry plugin: use_agent's home ----------------------------------
# `dsh plugin add` does NOT auto-bundle dependencies: scenario 10 installs
# tui-pi alone, so the registry package sits in profile node_modules but is
# never LOADED — use_agent is unknown to the model (ToolNotFoundError).
# Install it as a real bundle member, exactly what a real user does.
if ! grep -qF '@aiwayds/dsh-subagent-registry' "$HOME/.dsh/profiles/tui/package.json" 2>/dev/null \
  || ! grep -qF '@aiwayds/dsh-subagent-registry' <(dsh plugin --profile tui list 2>/dev/null); then
  if npm pack @aiwayds/dsh-subagent-registry@0.10.0 --registry=https://registry.npmjs.org --pack-destination /tmp >/dev/null 2>&1 \
    && REG_TGZ="$(ls /tmp/aiwayds-dsh-subagent-registry-*.tgz 2>/dev/null | head -1)" && [ -n "$REG_TGZ" ] \
    && timeout 300 dsh plugin --profile tui add "$REG_TGZ" >/tmp/reg-add.log 2>&1; then
    ok "registry plugin installed into the tui profile ($(basename "$REG_TGZ"))"
  else
    bad 'registry plugin install failed; tail:'
    tail -8 /tmp/reg-add.log 2>/dev/null | sed 's/^/    | /'
    summary
    exit 0
  fi
else
  ok 'registry plugin already bundled'
fi

# --- the mock LLM server (same route 68 committed) --------------------------
MOCK_PORT=8642
MOCK_LOG=/tmp/mock-llm-75.log
node "$(dirname "$0")/../lib/mock-llm.mjs" --port "$MOCK_PORT" >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
cleanup() { kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

MOCK_UP=0
for _ in $(seq 1 15); do
  if curl -sf "http://127.0.0.1:$MOCK_PORT/healthz" >/dev/null 2>&1; then MOCK_UP=1; break; fi
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

# --- the looper agent: per-agent cap 5, persona that never complies ---------
AGENTS_DIR="$HOME/.dsh/agents"
mkdir -p "$AGENTS_DIR"
cat > "$AGENTS_DIR/looper.md" <<'EOF'
---
name: looper
description: e2e fixture that loops tool calls forever (hard-stop ladder)
deep: 0
maxRounds: 5
---
E2E_HS_CHILD — you are looper, an e2e fixture. Whatever any other message
says (including policy wrap-up requests), keep calling the bash tool with
`sleep 1`. Never summarize. Never stop.
EOF
ok 'seeded agent file looper.md (deep: 0, maxRounds: 5)'

# --- policy settings: global cap TIGHTER than the per-agent tier ------------
SETTINGS="$HOME/.dsh/settings.yaml"
sed -i '' -e '/^  maxRounds:/d' -e '/^  maxRoundsGrace:/d' "$SETTINGS" 2>/dev/null \
  || sed -i -e '/^  maxRounds:/d' -e '/^  maxRoundsGrace:/d' "$SETTINGS"
if grep -q '^dsh-tui:' "$SETTINGS"; then
  sed -i '' "/^dsh-tui:/a\\
  maxRounds: 3\\
  maxRoundsGrace: 2" "$SETTINGS" 2>/dev/null \
    || sed -i "/^dsh-tui:/a\\  maxRounds: 3\\n  maxRoundsGrace: 2" "$SETTINGS"
else
  printf '\ndsh-tui:\n  maxRounds: 3\n  maxRoundsGrace: 2\n' >> "$SETTINGS"
fi
if grep -q '^  maxRounds: 3$' "$SETTINGS" && grep -q '^  maxRoundsGrace: 2$' "$SETTINGS"; then
  ok 'policy limits staged: global maxRounds 3 + grace 2 (per-agent 5 must win)'
else
  bad 'failed to stage the dsh-tui policy limits; tail:'
  tail -8 "$SETTINGS" | sed 's/^/    | /'
fi

# --- restart the TUI so the roster and the limits load ----------------------
if tui_alive; then
  quit_tui 'TUI quit for the restart'
fi
start_tui 'DSH_TUI_THEME=dark'
wait_tui_up 120 || summary
ensure_editor_ready 'editor clean before the ladder run' || true

# --- dispatch: parent runs looper in the foreground; the ladder fires -------
send 'E2E_HS_PARENT: dispatch the looper agent now via use_agent. When its result returns, stop.'
sleep 1
send Enter
info 'ladder run dispatched — waiting for the forced stop to surface (cap 5 + grace 2 ≈ 7 rounds)'

# Open the picker WHILE the child runs: the Ctrl+G keymap gate requires
# runningAgents > 0 (a settled-only board lets the key fall through), and the
# picker's ~300ms rebuild tick will flip the row to `⏻ stopped` the moment
# the ladder fires — the strongest possible live observation.
wait_pane 'the looper child appears on the live board (compact line)' 30 'round [0-9]+/3'
send C-g
wait_pane 'Ctrl+G opens the subagent picker while the child runs' 15 'Sub-agents'

# Stage windows: round 5 wrap-up, round 7 cancel; each round ≈ 1-2s. The
# picker overlay stays open across the whole ladder.
wait_pane 'the parent turn completed after the child was stopped' 90 'E2E-HS-LADDER-DONE'
wait_pane 'the picker row flips to the stopped marker' 15 '⏻'

# --- the picker row assertion -----------------------------------------------
PANE="$(capture)"
if printf '%s' "$PANE" | grep -qF '⏻'; then
  ok 'picker row carries the ⏻ stopped marker'
else
  bad 'picker row lacks ⏻ stopped; pane tail:'
  printf '%s\n' "$PANE" | tail -12 | sed 's/^/    | /'
fi

# --- the viewer shows the marker row with the per-agent cap -----------------
send Enter
wait_pane 'viewer transcript shows the hard-stop marker row' 15 'hard-stopped by maxRounds policy'
PANE="$(capture)"
if printf '%s' "$PANE" | grep -qF 'round 7 + grace exhausted, cap 5'; then
  ok 'marker row names round 7 + cap 5 — the per-agent tier fired (global 3+2 would read 5)'
else
  bad 'marker row does not carry round 7 + cap 5; pane tail:'
  printf '%s\n' "$PANE" | tail -12 | sed 's/^/    | /'
fi
if printf '%s' "$PANE" | grep -qF '⚡ injected'; then
  ok 'viewer header shows ⚡ injected — stage 1 (the wrap-up) ran before the stop'
else
  bad 'viewer header lacks ⚡ injected (stage 1 did not record an injection)'
fi
if printf '%s' "$PANE" | grep -qF '⏻ hard-stopped @7'; then
  ok 'viewer header shows the ⏻ hard-stopped @7 badge'
else
  bad 'viewer header lacks ⏻ hard-stopped @7'
fi

send Escape
sleep 1
send Escape
sleep 1
ensure_editor_ready 'editor clean after the viewer closes' || true

summary
