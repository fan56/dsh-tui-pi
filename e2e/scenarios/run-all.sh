#!/usr/bin/env bash
# Master in-container runner: executes the scenarios in order (each one
# always finishes; failures are recorded, not fatal) and aggregates the
# per-scenario counters into a final verdict + exit code.
set -u
export TERM="${TERM:-xterm-256color}"
cd "$(dirname "$0")"

RESULTS_DIR="${RESULTS_DIR:-/tmp/e2e-results}"
rm -rf "$RESULTS_DIR"
mkdir -p "$RESULTS_DIR"

printf 'e2e runner: image toolchain — %s | node %s | tmux %s\n' \
  "$(uname -m)" "$(node --version)" "$(tmux -V)"

for s in 10-install 20-start 30-commands 40-theme 50-resize-exit; do
  bash "./$s.sh"
done

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_WARN=0
printf '\n==================================================\n'
printf '  final results\n'
printf '==================================================\n'
for f in "$RESULTS_DIR"/*.result; do
  read -r p fl w < "$f"
  name="$(basename "${f%.result}")"
  printf '  %-14s %3d pass  %3d fail  %3d warn\n' "$name" "$p" "$fl" "$w"
  TOTAL_PASS=$((TOTAL_PASS + p))
  TOTAL_FAIL=$((TOTAL_FAIL + fl))
  TOTAL_WARN=$((TOTAL_WARN + w))
done
printf '  %-14s %3d pass  %3d fail  %3d warn\n' 'TOTAL' \
  "$TOTAL_PASS" "$TOTAL_FAIL" "$TOTAL_WARN"

if (( TOTAL_FAIL > 0 )); then
  printf '\n  E2E RESULT: FAIL (%d failing assertions)\n' "$TOTAL_FAIL"
  exit 1
fi
printf '\n  E2E RESULT: PASS\n'
exit 0
