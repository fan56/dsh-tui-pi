#!/usr/bin/env bash
# Scenario 74 — model profiles (v2.2.0): /profile-switch workspace binding and
# the /agents scope-aware edit path, entirely offline (no model traffic — the
# picked route comes from the mock provider 68 declared, and picking a model
# never calls it).
#
# Covers src/profile.ts + src/model-profiles.ts + the /agents glue:
#
#   1. a fresh store (no model-profiles.json) opens the switcher on the seeded
#      roster (work / personal / other) with '.dsh-profile here: none';
#   2. Enter on 'work' applies it: the summary echo reads 'Profile → work ·
#      model unchanged · agent values compose per-workspace at spawn · pinned
#      this tree (.dsh-profile)' and the pin file /app/.dsh-profile now names
#      the profile;
#   3. reopening the switcher marks the bound row '● work' and the title
#      carries '.dsh-profile here: work';
#   4. with the pin, /agents' fields window announces the scoped target
#      ('model/think edits apply to profile "work" …'), the model edit saves
#      with the '(profile "work")' scope note, the override lands in
#      $DSH_HOME/model-profiles.json, and the agent file's frontmatter stays
#      byte-untouched;
#   5. 'p' on the bound row unpins ('unpinned /app', pin file gone);
#   6. unpinned, the same edit announces the frontmatter target, saves with no
#      scope note, and the route lands in the agent file itself.
#
# The store's read path is self-healing: rm'ing the file before boot re-seeds
# the default roster, so the scenario starts deterministic. The picker's
# '/'-filter needs TWO Enters (apply the filter, then select the row) — the
# same discipline as 68-ask-user.sh.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'model profiles: /profile-switch binding + /agents scope-aware edits'

# Container-only: it writes $DSH_HOME/model-profiles.json, the agents dir and
# the cwd pin file — on the host those are live config.
if [ ! -d /e2e/scenarios ]; then
  warn 'host environment detected — skipping (writes model-profiles.json, agents dir, .dsh-profile; container only)'
  summary
  exit 0
fi

# Navigate the picker cursor onto the row whose label is `needle`: Down moves
# one row per press (clamped at the end), the ▸ marker names the selected
# row, so the loop stops the moment the cursor lands on it.
navigate_to_row() {
  local needle="$1" attempt
  for attempt in $(seq 1 30); do
    if capture | grep -qF "▸ ${needle}"; then
      ok "cursor navigated onto the ${needle} row (${attempt} Down presses)"
      return 0
    fi
    send Down
    sleep 0.5
  done
  return 1
}

# --- deterministic seed ---------------------------------------------------------
AGENTS_DIR="$HOME/.dsh/agents"
mkdir -p "$AGENTS_DIR"
cat > "$AGENTS_DIR/e2e-bot.md" <<'EOF'
---
name: e2e-bot
description: e2e fixture agent for profile scoping
deep: 1
---
You are e2e-bot, an e2e fixture agent.
EOF
ok 'seeded agent file e2e-bot.md (no model in frontmatter)'
rm -f "$HOME/.dsh/model-profiles.json"
rm -f /app/.dsh-profile

kill_tui
start_tui 'DSH_TUI_THEME=dark'
wait_tui_up 120 || { summary; exit 0; }
ensure_editor_ready 'editor clean before the profile flow' || true

# --- 1-2. switcher on the seeded store; Enter applies + binds -------------------
send '/profile-switch' Enter
wait_pane 'switcher opens on the seeded store, no binding' 20 \
  '● Model profiles · \.dsh-profile here: none'
PANE="$(capture)"
assert_contains 'seeded roster lists work' 'work' "$PANE"
assert_contains 'seeded roster lists personal' 'personal' "$PANE"
assert_contains 'seeded roster lists other' 'other' "$PANE"
assert_contains 'switcher footer advertises the binding keys' \
  'Enter switch (binds this dir) · p pin/unpin' "$PANE"

send Enter # cursor preselected onto row 0 = work
wait_pane 'apply summary names the switch' 20 'Profile → work'
wait_pane 'apply summary names the pin' 20 'pinned this tree \(\.dsh-profile\)'
if [ "$(cat /app/.dsh-profile 2>/dev/null)" = "work" ]; then
  ok 'pin file /app/.dsh-profile names work'
else
  bad 'pin file /app/.dsh-profile missing or wrong'
fi

# --- 3. the bound row is marked ---------------------------------------------------
ensure_editor_ready 'editor clean before the reopen' || true
send '/profile-switch' Enter
wait_pane 'switcher title shows the tree binding' 20 \
  '● Model profiles · \.dsh-profile here: work'
PANE="$(capture)"
assert_matches 'bound profile row carries the current marker' '● work' "$PANE"
esc_until_gone 'Esc closes the switcher' '● Model profiles'

# --- 4. pinned /agents edit lands in the profile store ---------------------------
ensure_editor_ready 'editor clean before the agents flow' || true
send '/agents' Enter
wait_pane 'agents table opens' 20 '● Agents'
PANE="$(capture)"
assert_contains 'agent row lists e2e-bot' 'e2e-bot' "$PANE"
assert_contains 'unconfigured model cell shows inherit' '(inherit)' "$PANE"

# The agents model picker has NO '/'-filter (unlike /model's) — reach the
# mock-chat row with Down navigation and verify the ▸ marker per press. The
# mock model declares no reasoning efforts, so no stage-2 effort picker
# follows the selection.

ensure_editor_ready 'editor clean before the agents flow' || true
send '/agents' Enter
wait_pane 'agents table opens' 20 '● Agents'
PANE="$(capture)"
assert_contains 'agent row lists e2e-bot' 'e2e-bot' "$PANE"
assert_contains 'unconfigured model cell shows inherit' '(inherit)' "$PANE"

send Enter # open the single agent's fields window
wait_pane 'fields window announces the pinned scope' 20 \
  'model/think edits apply to profile "work"'
send m
wait_pane 'model picker opens for the agent' 20 '● Model'
PANE="$(capture)"
assert_contains 'picker lists the mock route row' 'mock-chat' "$PANE"
navigate_to_row 'mock-chat' || { bad 'never highlighted the mock-chat row'; summary; exit 0; }
send Enter
wait_pane 'pinned save carries the profile scope note' 20 \
  'saved e2e-bot → mock-llm/mock-chat \(profile "work"\)'

sleep 1
if grep -qF '"model":"mock-llm/mock-chat"' "$HOME/.dsh/model-profiles.json" 2>/dev/null; then
  ok 'profile store records the e2e-bot override'
else
  bad 'profile store lacks the e2e-bot override'
fi
if grep -qF 'mock-llm/mock-chat' "$AGENTS_DIR/e2e-bot.md"; then
  bad 'frontmatter was rewritten despite the pin'
else
  ok 'frontmatter baseline untouched by the pinned edit'
fi

send Escape # fields -> table
sleep 1
send Escape # table -> close
wait_pane 'closing the manager echoes the change set' 15 'Agents updated: e2e-bot'

# --- 5. unpin via the p toggle ---------------------------------------------------
ensure_editor_ready 'editor clean before the unpin' || true
send '/profile-switch' Enter
wait_pane 'switcher still shows the binding' 20 \
  '● Model profiles · \.dsh-profile here: work'
send p
wait_pane 'p toggle unpins the tree' 15 'unpinned /app'
if [ ! -f /app/.dsh-profile ]; then
  ok 'pin file removed by the unpin'
else
  bad 'pin file survived the unpin'
fi
esc_until_gone 'Esc closes the switcher after the unpin' '● Model profiles'

# --- 6. unpinned edit writes the frontmatter baseline ----------------------------
ensure_editor_ready 'editor clean before the unpinned edit' || true
send '/agents' Enter
wait_pane 'agents table opens again' 20 '● Agents'
send Enter
wait_pane 'fields window announces the frontmatter scope' 20 \
  'no workspace profile pin — edits write the frontmatter baseline'
send m
wait_pane 'model picker opens for the unpinned edit' 20 '● Model'
navigate_to_row 'mock-chat' || { bad 'never highlighted the mock-chat row (unpinned)'; summary; exit 0; }
send Enter
wait_pane 'unpinned save echoes the plain route' 20 \
  'saved e2e-bot → mock-llm/mock-chat'
PANE="$(capture)"
assert_not_contains 'no profile scope note on the unpinned save' '(profile "work")' "$PANE"

sleep 1
if grep -qF 'mock-llm/mock-chat' "$AGENTS_DIR/e2e-bot.md"; then
  ok 'frontmatter baseline now carries the model route'
else
  bad 'frontmatter never received the model route'
fi
if grep -qF 'description: e2e fixture agent for profile scoping' "$AGENTS_DIR/e2e-bot.md"; then
  ok 'the frontmatter rewrite kept the untouched keys'
else
  bad 'the frontmatter rewrite dropped unrelated keys'
fi

send Escape
sleep 1
send Escape
wait_pane 'second close echoes the change set' 15 'Agents updated: e2e-bot'

summary
