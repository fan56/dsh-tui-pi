#!/usr/bin/env bash
# Scenario 77 — /plugins manager smoke + cross-session full-text search.
#
# The plugin panel is driven read-only: open, assert the bundle table
# lists this very package as a row, Esc back. No toggles/uninstalls — a
# mid-suite mutation of the running profile's bundles would sink every
# later assertion (and 77 is the last scenario for exactly this reason).
#
# The search overlay is exercised against REAL stored content: scenario
# 76's parent prompt (E2E_HS_PARENT) lives in the persisted store, so the
# query needs no live model. The first search also bootstraps the FTS
# index (this bundle's patch override points session-query-sqlite at a
# durable file with openAt first-search), which is part of what this
# scenario proves: boot is unaffected, the index builds on demand, hits
# surface with snippets, Enter-resume is left to the /resume suites.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'plugins manager smoke + cross-session full-text search'

if [ ! -d /e2e/scenarios ]; then
  warn 'host environment detected — skipping (drives the container TUI only)'
  summary
  exit 0
fi

kill_tui
start_tui 'DSH_TUI_THEME=dark'
wait_tui_up 120 || { summary; exit 0; }
ensure_editor_ready 'editor clean before the plugin smoke' || true

# --- /plugins: table lists this package's own bundle --------------------------
send '/plugins' Enter
wait_pane 'plugins manager opens with the bundle table' 20 '🔌 Plugins'
PANE="$(capture)"
if printf '%s' "$PANE" | grep -qF 'dsh-tui-pi@'; then
  ok 'bundle table lists the dsh-tui-pi row with its version'
else
  bad 'dsh-tui-pi row not visible in the bundle table; pane tail:'
  printf '%s\n' "$PANE" | tail -12 | sed 's/^/    | /'
fi
if printf '%s' "$PANE" | grep -qE 'on|off'; then
  ok 'state column carries on/off labels'
else
  bad 'state column shows no on/off labels'
fi
send Escape
sleep 1
PANE="$(capture)"
if printf '%s' "$PANE" | grep -qF '🔌 Plugins'; then
  bad 'plugins manager still open after Esc'
else
  ok 'Esc closes the plugins manager'
fi

# --- /search: full-text over the stored corpus --------------------------------
ensure_editor_ready 'editor clean before the search' || true
send '/search' Enter
wait_pane 'search overlay opens the query editor' 20 'Search sessions'
# Scenario 76's parent prompt is a persisted user message — the FTS corpus.
send 'E2E_HS_PARENT'
sleep 1
send Enter
# First search builds the durable index (openAt first-search): budget
# generously — the store holds every session the suite wrote so far.
wait_pane 'results table shows the scenario-76 hit' 90 'E2E_HS_PARENT'
PANE="$(capture)"
if printf '%s' "$PANE" | grep -qF '🔍'; then
  ok 'results view rendered with the search title'
else
  bad 'results view title not visible; pane tail:'
  printf '%s\n' "$PANE" | tail -12 | sed 's/^/    | /'
fi
send Escape
sleep 1
PANE="$(capture)"
if printf '%s' "$PANE" | grep -qF 'Search sessions'; then
  bad 'search overlay still open after Esc'
else
  ok 'Esc closes the search overlay'
fi

# The durable index file exists under the dsh home (the patch override's
# path contract) — proof the engine opened the on-disk database, not an
# in-memory throwaway.
if find "$HOME/.dsh/storages/session-query" -name 'index.sqlite' 2>/dev/null | grep -q .; then
  ok 'durable FTS index file created under storages/session-query'
else
  bad 'no durable index file under storages/session-query'
fi

kill_tui
summary
