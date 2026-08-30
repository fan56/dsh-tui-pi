#!/usr/bin/env bash
# Fullscreen transcript search (pi-tui built-in, Ctrl+Shift+F) over a real
# PTY. The plugin ships no search code of its own: the tui.altScreen.search
# binding opens pi-tui's input overlay anchored top-right ("Find
# transcript"), the query counts matches over the primary ScrollView (the
# transcript), escape closes, and reopening starts a fresh query. Also pins
# the footer hint segment for discoverability ('Ctrl+Shift+F: search',
# default on).
#
# Match targets: the startup banner's "mcp N · skills X/Y · plugins N"
# counts line (deterministic) for the positive path; an absurd query for
# the "No matches" path.
source "$(dirname "$0")/../lib/common.sh"

scenario 'fullscreen transcript search (Ctrl+Shift+F)'

start_tui
wait_tui_up 120

# --- discoverability: the footer hint carries the search segment ----------
PANE="$(capture)"
assert_contains 'footer hint shows the search segment' 'Ctrl+Shift+F: search' "$PANE"

# --- open the search overlay ----------------------------------------------
send C-S-f
wait_pane 'search overlay opens on ctrl+shift+f' 15 'Find transcript'

# --- negative path: an absurd query counts zero matches --------------------
send 'zzqqxx'
wait_pane 'absurd query reports no matches' 15 'No matches'

# --- positive path: the banner counts line matches -------------------------
for _ in 1 2 3 4 5 6; do send BSpace; done
sleep 1
send 'plugins'
wait_pane 'banner counts line matches the query' 15 '[0-9]+/[0-9]+'

# --- close: escape returns to the plain transcript --------------------------
esc_until_gone 'escape closes the search' 'Find transcript'

# --- reopen: a fresh, empty query (no stale counter) ------------------------
send C-S-f
wait_pane 'search reopens' 15 'Find transcript'
sleep 1
PANE="$(capture)"
assert_not_contains 'reopened search starts with an empty query' 'No matches' "$PANE"

# --- leave a clean editor for the next scenario ------------------------------
send Escape
sleep 1
send Escape
sleep 0.6

summary
