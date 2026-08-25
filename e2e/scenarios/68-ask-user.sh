#!/usr/bin/env bash
# Scenario 68 — ask-user one question at a time with tab strip + Ctrl+T fold
# (v0.23.0, commit 40a03df).
#
# The ask_user_question panel needs a live agent turn, and the container has
# no provider credentials — so this scenario runs a LOCAL OpenAI-compatible
# mock server (../lib/mock-llm.mjs, plain node stdlib) and drives the real
# chain offline:
#
#   /login "Custom provider…" form (scenario 65's pattern) declares a
#   hand-declared route mock-llm -> http://127.0.0.1:8642/v1 with model
#   mock-chat; /model's '/'-filter selects it; a trigger prompt makes the
#   agent loop call the mock, whose FIRST scripted response is an
#   ask_user_question tool call with three questions (two single-select +
#   one multiSelect). The panel opens and the scenario asserts:
#
#   1. one-question rendering: only the focused question's header/options
#      render, the title carries (1/3), and the tab strip [1] · 2 · 3 shows;
#   2. answering a single-select tab auto-advances: title (2/3), answered
#      tab marked 1✓, the previous question no longer active;
#   3. ←/→ hop between tabs (revisit shows the earlier question again);
#   4. Ctrl+T folds the panel to the 3-line strip ((2/3 · 1 answered) +
#      "Ctrl+T expand"), hiding the question rows AND the table chrome;
#      while folded, navigation/answer keys are inert; Ctrl+T unfolds;
#   5. the multiSelect tab never auto-advances (both options toggleable,
#      ● selection marks visible);
#   6. the Confirm row hops to the review page (all answers listed, submit
#      row ✓ ready), submission closes the panel, the tool result flows
#      back, and the mock's second scripted response renders the final
#      assistant text E2E-ASK-FLOW-COMPLETE.
#
# The mock's behavior is keyed on the request body (trigger marker + a tool
# message), never on arrival order, so stray turns cannot desync the script.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'ask-user: one question at a time + tab strip + Ctrl+T fold'

# --- host guard -------------------------------------------------------------
# This scenario permanently mutates dsh config: /model persists mock-chat as
# the DEFAULT model (persistDefaultModel) and /login commits the mock-llm
# route (http://127.0.0.1:8642) into settings.yaml. Run on the host that
# would poison the live ~/.dsh with a dead route — so it must only run
# inside the e2e container, whose ~/.dsh is throwaway. Same detection as
# 70-steer-injection.sh, inverted: skip (warn, not fail) when NOT in it.
if [ ! -d /e2e/scenarios ]; then
  warn 'host environment detected — skipping (persists mock model/route into ~/.dsh; container only)'
  summary
  exit 0
fi

if ! tui_alive; then
  info 'TUI not running — starting fresh'
  start_tui 'DSH_TUI_THEME=dark'
  wait_tui_up 120 || summary
fi
ensure_editor_ready 'editor clean before the ask-user flow' || true

# --- the mock LLM server ----------------------------------------------------
MOCK_PORT=8642
MOCK_LOG=/tmp/mock-llm.log
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

# --- /login: declare the mock-llm route (65-ux-batch form pattern) ----------
MARKER_ADD_PROVIDER='Add provider'
MARKER_FORM_STEP1='Custom provider 1/6'

send '/login' Enter
wait_pane '/login opens the add-provider picker' 15 "$MARKER_ADD_PROVIDER"
send Enter # Custom provider… is the first row
wait_pane 'Enter on Custom provider… opens the chained form' 15 "$MARKER_FORM_STEP1"

send 'mock-llm' Enter        # 1/6 route id
sleep 2
send Enter                   # 2/6 display name (optional)
sleep 2
send Enter                   # 3/6 protocol — empty takes openai-completions
sleep 2
send "http://127.0.0.1:$MOCK_PORT/v1" Enter # 4/6 base URL
sleep 2
send 'mock-chat' Enter       # 5/6 models
sleep 2
send 'sk-mock-e2e-key' Enter # 6/6 API key — commits the route
sleep 4
send Escape                  # close the flow (no-op when it already exited)
sleep 2
esc_until_gone 'login flow closes after the mock provider commit' \
  "$MARKER_FORM_STEP1|$MARKER_ADD_PROVIDER"

if grep -qF 'mock-llm' "$HOME/.dsh/settings.yaml" 2>/dev/null; then
  ok 'settings.yaml carries the hand-declared mock-llm route'
else
  bad 'settings.yaml lacks the mock-llm route'
fi

# --- /model: select mock-chat via the picker's '/' filter --------------------
ensure_editor_ready 'editor clean before /model' || true
send '/model' Enter
wait_pane '/model opens the model picker' 15 '● Model'
send '/mock' # '/' engages the filter, 'mock' narrows to the mock route's rows
sleep 2
PANE="$(capture)"
if printf '%s' "$PANE" | grep -qF 'mock-chat'; then
  ok 'filter narrows the model list to mock-chat'
else
  bad 'mock-chat not visible after the /mock filter; pane tail:'
  printf '%s\n' "$PANE" | tail -12 | sed 's/^/    | /'
fi
# Enter #1 APPLIES the filter (the footer reads "Enter apply" while the
# filter input owns the keys); Enter #2 then selects the highlighted row.
# The mock model declares no reasoning efforts, so no stage-2 picker follows.
send Enter
sleep 1.5
send Enter
sleep 3
PANE="$(capture)"
assert_contains 'footer reflects the mock model selection' 'mock-chat' "$PANE"
if printf '%s' "$PANE" | grep -qF '● Model'; then
  bad 'model picker still open after selection'
else
  ok 'model picker closed after selection'
fi

# --- trigger: prompt the agent -> mock returns the ask_user_question call ---
ensure_editor_ready 'editor clean before the trigger prompt' || true
send 'Ask me the deployment questions now. E2E_ASK_TRIGGER'
sleep 1
send Enter
# Full chain: session create + LLM request + tool dispatch + panel mount.
if ! wait_pane 'the ask tool opens the docked panel on tab 1' 45 '● Questions \(1/3\)'; then
  info 'panel never opened — mock server log tail:'
  tail -10 "$MOCK_LOG" 2>/dev/null | sed 's/^/    | /'
  summary
  exit 0
fi
PANE="$(capture)"

# --- 1. one question at a time + the tab strip -------------------------------
assert_contains 'title shows the (1/3) tab position' '● Questions (1/3)' "$PANE"
assert_contains 'tab strip renders bracketed focus + plain tabs' '[1] · 2 · 3' "$PANE"
assert_contains 'only the focused question header renders' 'Deploy target' "$PANE"
assert_not_contains 'later question header stays folded away' 'Verbosity' "$PANE"
assert_not_contains 'later multi-select header stays folded away' 'Extras' "$PANE"
assert_contains 'options render with the free-text sentinel' 'Type something.' "$PANE"
assert_contains 'multi-tab footer advertises the tab keys' '←→ tabs' "$PANE"

# --- 2. answering a single-select tab auto-advances --------------------------
# The cursor starts on the first selectable row (option 'staging'); Enter
# selects it and the focus hops to the next unanswered tab.
send Enter
sleep 1.5
PANE="$(capture)"
assert_contains 'auto-advance moves the title to (2/3)' '● Questions (2/3)' "$PANE"
assert_contains 'tab strip marks question 1 answered' '1✓ · [2]' "$PANE"
assert_contains 'question 2 header becomes the active one' 'Verbosity' "$PANE"
assert_not_contains 'question 1 header is no longer active' 'Deploy target' "$PANE"
assert_not_contains 'question 1 options are no longer rendered' 'staging' "$PANE"

# --- 3. ←/→ hop between tabs ---------------------------------------------------
send Left
sleep 1
PANE="$(capture)"
assert_contains 'Left returns to tab 1' '● Questions (1/3)' "$PANE"
assert_contains 'the revisited question header renders again' 'Deploy target' "$PANE"
send Right
sleep 1
PANE="$(capture)"
assert_contains 'Right moves back to tab 2' '● Questions (2/3)' "$PANE"
assert_contains 'tab 2 question renders again' 'Verbosity' "$PANE"

# --- 4. Ctrl+T folds the panel to the 3-line strip -----------------------------
send C-t
sleep 1
PANE="$(capture)"
assert_contains 'folded strip carries position + answered count' \
  '● Questions (2/3 · 1 answered)' "$PANE"
assert_contains 'folded strip advertises Ctrl+T expand' 'Ctrl+T expand' "$PANE"
assert_not_contains 'question rows are hidden while folded' 'Verbosity' "$PANE"
assert_not_contains 'table chrome is hidden while folded' 'Selection' "$PANE"

# --- (folded) answering keys are inert ------------------------------------------
# While folded only the toggle and the Esc chain act: arrows, digits and
# Enter must not switch tabs, answer, or submit anything.
send Down
send Right
send '2'
send Enter
sleep 1
PANE="$(capture)"
assert_contains 'panel stays folded after inert keys' 'Ctrl+T expand' "$PANE"
assert_not_contains 'inert keys did not switch to tab 3' '● Questions (3/3)' "$PANE"
assert_not_contains 'inert keys did not reveal question 3' 'Extras' "$PANE"

# --- Ctrl+T unfolds --------------------------------------------------------------
send C-t
sleep 1
PANE="$(capture)"
assert_contains 'unfold restores the (2/3) title' '● Questions (2/3)' "$PANE"
assert_contains 'unfold restores the question rows' 'Verbosity' "$PANE"
assert_not_contains 'the unfolded panel is not the strip anymore' 'Ctrl+T expand' "$PANE"

# --- 5. answer question 2, then the multi-select tab never auto-advances -------
send Enter # 'quiet' — cursor landed on tab 2's first selectable row
sleep 1.5
PANE="$(capture)"
assert_contains 'answering tab 2 advances to (3/3)' '● Questions (3/3)' "$PANE"
assert_contains 'tabs 1 and 2 both marked answered' '1✓ · 2✓ · [3]' "$PANE"
assert_contains 'question 3 header becomes active' 'Extras' "$PANE"
assert_not_contains 'question 2 header no longer active' 'Verbosity' "$PANE"

send Enter # toggle 'lint' on the multi-select tab
sleep 1
PANE="$(capture)"
assert_contains 'multi-select toggle keeps the panel on (3/3)' '● Questions (3/3)' "$PANE"
assert_contains 'the toggled option shows its ● selection mark' '● 1. lint' "$PANE"
send Down
sleep 0.5
send Enter # toggle 'smoke'
sleep 1
PANE="$(capture)"
assert_contains 'the second option shows its ● selection mark' '● 2. smoke' "$PANE"
assert_contains 'multi-select never auto-advances past (3/3)' '● Questions (3/3)' "$PANE"

# --- 6. Confirm row -> review page -> submit -> final answer ---------------------
send Down # sentinel row
sleep 0.5
send Down # Confirm row
sleep 1
PANE="$(capture)"
assert_contains 'cursor lands on the ready Confirm row' '▸ ✓ ⏎ Confirm answers' "$PANE"
send Enter
wait_pane 'Confirm hops to the review page' 10 '● Review answers'
PANE="$(capture)"
assert_contains 'review lists question 1 answer' 'staging' "$PANE"
assert_contains 'review lists question 2 answer' 'quiet' "$PANE"
assert_contains 'review lists question 3 answers' 'lint, smoke' "$PANE"
assert_contains 'submit row reports ✓ ready' '✓ ready' "$PANE"

send Down # q2 row
sleep 0.5
send Down # q3 row
sleep 0.5
send Down # submit row
sleep 1
PANE="$(capture)"
assert_contains 'cursor lands on the submit row' '▸ Submit answers' "$PANE"
send Enter
wait_gone 'the panel closes after submission' 15 '● Review answers'
wait_pane 'the mock final answer renders in the transcript' 45 'E2E-ASK-FLOW-COMPLETE'
PANE="$(capture)"
assert_not_contains 'no questions panel remains' '● Questions' "$PANE"

if grep -q 'phase=final' "$MOCK_LOG" 2>/dev/null; then
  ok 'the mock served the scripted final phase (tool result flowed back)'
else
  bad 'the mock never saw the tool-result turn; log tail:'
  tail -8 "$MOCK_LOG" 2>/dev/null | sed 's/^/    | /'
fi

summary
