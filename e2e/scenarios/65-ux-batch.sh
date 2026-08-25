#!/usr/bin/env bash
# Scenario 65 — the 0.21 UX batch: /login's "Custom provider…" chained form
# (open → six fields → commit into the container's settings.yaml → close;
# Esc abandon path) and the registered-subagents rule in the seeded
# APPEND_SYSTEM.md. The ask-user dock panel and the maxRounds ⚡ markers
# need a live LLM turn and are covered elsewhere (unit suites + host smoke).
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'UX batch: /login custom provider form + APPEND_SYSTEM rule'

if ! tui_alive; then
  info 'TUI not running — starting fresh'
  start_tui 'DSH_TUI_THEME=dark'
  wait_tui_up 120 || summary
fi
ensure_editor_ready 'editor clean before the login flow' || true

# --- APPEND_SYSTEM.md ships the registered-subagents iron rule ---------------
if grep -qF 'registered subagents only' "$HOME/.dsh/APPEND_SYSTEM.md" 2>/dev/null; then
  ok 'seeded APPEND_SYSTEM.md carries the registered-subagents rule'
else
  bad 'APPEND_SYSTEM.md lacks the registered-subagents rule; file tail:'
  tail -6 "$HOME/.dsh/APPEND_SYSTEM.md" 2>/dev/null | sed 's/^/    | /' \
    || printf '    | (file missing)\n'
fi

# --- /login: the picker offers the Custom provider… entry ---------------------
MARKER_ADD_PROVIDER='Add provider'
MARKER_CUSTOM_ROW='Custom provider'
MARKER_FORM_STEP1='Custom provider 1/6'
MARKER_FORM_STEP4='Custom provider 4/6'

send '/login' Enter
wait_pane '/login opens the add-provider picker' 15 "$MARKER_ADD_PROVIDER" \
  && assert_contains 'picker lists the Custom provider entry' \
    "$MARKER_CUSTOM_ROW" "$(capture)"

# The custom entry is the first row (cursor starts there) — Enter opens the form.
send Enter
wait_pane 'Enter on Custom provider… opens the chained form at step 1' 15 "$MARKER_FORM_STEP1"

# Field 1 — route id (invalid value first: a colliding catalog id stays put).
send 'openai' Enter
sleep 2
PANE="$(capture)"
assert_contains 'a colliding id keeps the form on step 1 with the inline error' \
  'already exists' "$PANE"
# Clear the buffer and type a valid slug.
for _ in $(seq 1 6); do send BSpace; done
send 'acme-gateway' Enter
sleep 2

# Field 2 — display name (optional; skip with empty Enter).
send Enter
sleep 2

# Field 3 — protocol (empty Enter takes the openai-completions default).
send Enter
sleep 2

# Field 4 — base URL. (Step-4 title proves the chain advanced through three
# commits; an invalid URL keeps the step, then a valid one advances.)
wait_pane 'three committed fields advance the form to step 4' 15 "$MARKER_FORM_STEP4"
send 'not-a-url' Enter
sleep 2
PANE="$(capture)"
assert_contains 'an invalid base URL keeps step 4 with the inline error' \
  'http' "$PANE"
for _ in $(seq 1 9); do send BSpace; done
send 'https://gw.internal.example/v1' Enter
sleep 2

# Field 5 — models (comma list).
send 'acme-large,acme-think' Enter
sleep 2

# Field 6 — the masked API key; the final commit writes the profile.
send 'sk-e2e-test-key' Enter
# Commit outcome: with a credentials service the flow exits on its own; with
# none the editor stays open on the export-hint notice. Both count — the
# profile write itself is the assertion below.
sleep 4
send Escape # close the flow either way (no-op when it already exited)
sleep 2
esc_until_gone 'the login flow closes after the custom commit' "$MARKER_FORM_STEP1|$MARKER_ADD_PROVIDER"

if grep -qF 'acme-gateway' "$HOME/.dsh/settings.yaml" 2>/dev/null; then
  ok 'settings.yaml carries the hand-declared acme-gateway profile'
else
  bad 'settings.yaml lacks the acme-gateway profile; llm section tail:'
  grep -A6 'llm-pi-ai' "$HOME/.dsh/settings.yaml" 2>/dev/null | tail -8 | sed 's/^/    | /' \
    || printf '    | (no llm-pi-ai section)\n'
fi
if grep -qF 'ACME_GATEWAY_API_KEY' "$HOME/.dsh/settings.yaml" 2>/dev/null; then
  ok 'the profile derives the ACME_GATEWAY_API_KEY credential ref'
else
  bad 'the derived credential ref is missing from the profile'
fi
if grep -qF 'sk-e2e-test-key' "$HOME/.dsh/settings.yaml" 2>/dev/null; then
  bad 'the API key leaked into settings.yaml (must live in credentials only)'
else
  ok 'the API key never lands in settings.yaml'
fi

# --- Esc at step 1 abandons the whole flow -------------------------------------
ensure_editor_ready 'editor clean before the abandon pass' || true
send '/login' Enter
wait_pane '/login reopens the picker' 15 "$MARKER_ADD_PROVIDER"
send Enter # Custom provider… (first row)
wait_pane 'the form opens at step 1 again' 15 "$MARKER_FORM_STEP1"
send Escape
esc_until_gone 'Esc at step 1 abandons the whole flow (picker included)' \
  "$MARKER_FORM_STEP1|$MARKER_ADD_PROVIDER"

summary
