#!/usr/bin/env bash
# Scenario — one-command onboarding: the `dsh-tui-pi`/`dst` launcher must
# bring a machine up by itself. Two passes:
#   A. the regular flow — dsh is present; `npm i -g` of the tarball registers
#      both bins, and the launcher's FIRST RUN (bin/boot.mjs) performs the
#      onboarding (progress lines, both bins registered, the tui profile
#      composed, a piped boot with no setup banner = fast path);
#   B. the fresh-machine flow — dsh hidden from PATH, a separate npm prefix
#      and an empty DSH_HOME: the launcher's first run installs the host
#      itself (always via npm) and still ends in a composable profile.
# Runs LAST in the suite on purpose: pass A re-installs the profile the
# earlier scenarios built, so nothing after it should depend on that state.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'one-command onboarding (npm i -g → first-run boot → dst)'

TARBALL="$(ls /dist/*.tgz 2>/dev/null | head -1)"
if [[ -n "${TARBALL:-}" && -f "$TARBALL" ]]; then
  ok "plugin tarball present: $(basename "$TARBALL")"
else
  bad 'no tarball found in /dist'
  summary
fi

# --- pass A: the regular machine (dsh on PATH) ----------------------------
INSTALL_LOG=/tmp/onboard-install.log
info "npm i -g $(basename "$TARBALL")"
if timeout 420 npm install -g --no-fund --no-audit "$TARBALL" >"$INSTALL_LOG" 2>&1; then
  ok 'npm i -g exited 0'
else
  bad "npm i -g failed (exit $?)"
  tail -20 "$INSTALL_LOG" | sed 's/^/    | /'
  summary
fi

# Since 2.38.1 there is no npm postinstall: onboarding moved from install
# time to the launcher's first run (bin/boot.mjs, the same runOnboard the
# deleted hook drove). The `npm i -g` above therefore only registers the
# bins; the first `dsh-tui-pi` invocation must do the rest. Force that first
# run deterministically: drop the tui profile the earlier scenarios built,
# so boot.mjs cannot fast-path past the onboarding.
GLOBAL_ROOT="$(npm prefix -g)"
LAUNCHER_PKG="$GLOBAL_ROOT/lib/node_modules/@aiwayds/dsh-tui-pi"
PROFILE_DIR="$HOME/.dsh/profiles/tui"
rm -rf "$PROFILE_DIR"
ONBOARD_LOG=/tmp/onboard-firstboot.log
info 'first dsh-tui-pi run must run the onboarding, then boot'
# errexit stays OFF around rc capture (see pass A below / pass B): a failing
# boot must reach summary(), not kill the scenario into a missing result file.
set +e
timeout 600 dsh-tui-pi </dev/null >"$ONBOARD_LOG" 2>&1
FIRST_RC=$?
# 0 = the TUI exited cleanly once the closed stdin hit EOF here; 124 = the
# timeout guard killed a healthy TUI that was still waiting on the (empty)
# stdin. Both prove the onboarding finished and the launcher reached the
# boot; anything else is a real failure. (Pass B drives the launcher through
# an isolated env without a closed stdin, so it does not share this rc
# reading.)
if [[ "$FIRST_RC" == "0" || "$FIRST_RC" == "124" ]]; then
  ok "first-run boot finished the onboarding and booted (rc=$FIRST_RC)"
else
  bad "first-run boot failed (rc=$FIRST_RC); log tail:"
  tail -20 "$ONBOARD_LOG" | sed 's/^/    | /'
fi
A_LOG="$(cat "$ONBOARD_LOG")"
assert_contains 'first run announced the onboarding' 'dsh-tui-pi setup (first run / upgrade only):' "$A_LOG"
assert_matches 'step 1/3 found the host' '\[1/3\] dsh host +found [0-9]' "$A_LOG"
assert_matches 'step 2/3 found pnpm' '\[2/3\] pnpm +found' "$A_LOG"
assert_matches 'step 3/3 created the profile' '\[3/3\] tui profile +(done|already set up)' "$A_LOG"

if command -v dsh-tui-pi >/dev/null 2>&1; then
  ok 'dsh-tui-pi bin registered'
else
  bad 'dsh-tui-pi bin missing'
fi
if command -v dst >/dev/null 2>&1; then
  ok 'dst bin registered'
else
  bad 'dst bin missing'
fi

if [[ -f "$PROFILE_DIR/node_modules/@aiwayds/dsh-tui-pi/package.json" ]]; then
  ok 'tui profile has the plugin mounted'
else
  bad 'tui profile missing the plugin'
fi
WORKSPACE="$PROFILE_DIR/pnpm-workspace.yaml"
if [[ -f "$WORKSPACE" ]]; then
  if grep -q 'set this to true or false' "$WORKSPACE"; then
    bad 'pnpm allowBuilds skeleton left undecided'
  else
    ok 'pnpm-workspace.yaml has no undecided allowBuilds placeholders'
  fi
else
  warn 'profile has no pnpm-workspace.yaml (pre-skeleton pnpm?)'
fi

DUMP="$(dsh --profile tui --dump-config 2>&1 || true)"
assert_contains 'dump-config composes the plugin' 'tui-pi' "$DUMP"

BOOT_LOG=/tmp/onboard-boot.log
info 'piped boot via dsh-tui-pi (fast path must be silent, boot must survive)'
set +e
timeout 25 sh -c 'sleep 40 | dsh-tui-pi' >"$BOOT_LOG" 2>&1
BOOT_RC=$?
# Keep -e OFF past this point: the assert_* helpers return 1 on failure, and
# with errexit armed a failing assert kills the script before summary() — the
# scenario then writes no result file and its counter silently vanishes from
# run-all.sh's total table (observed when pass B died on the host install).
set +e
if [[ "$BOOT_RC" == "124" ]]; then
  ok 'boot survived until the timeout kill (healthy, piped)'
else
  bad "boot exited early (rc=$BOOT_RC); log tail:"
  tail -10 "$BOOT_LOG" | sed 's/^/    | /'
fi
assert_not_contains 'fast path printed no setup banner' 'setup (first run' "$(cat "$BOOT_LOG")"

# --- pass B: the fresh machine (dsh hidden, separate prefix + home) -------
# Known environment ceiling (HOST-SIDE, not launcher-fixable): on a 2 GiB
# podman VM the fresh-machine host install `npm install -g
# @deepseek-ai/dsh@0.2.2-rc.2` can be SIGKILLed by the kernel OOM killer
# (exit 137) where 0.2.2-rc.1 installed fine — the rc.2 closure needs more
# install-time memory than the VM has. The launcher surfaces that death now
# (signal + step in the failure lines, see bin/onboard-core.mjs) instead of
# a bare "setup stopped"; this scenario only asserts the launcher's
# reporting contract, the OOM itself belongs to the environment.
info 'pass B: hide dsh, separate npm prefix, empty DSH_HOME'
NODSH=/tmp/onboard-nodsh-bin
B_PREFIX=/tmp/onboard-prefix
B_HOME="$HOME/.dsh-onboard-b"
rm -rf "$NODSH" "$B_PREFIX" "$B_HOME"
mkdir -p "$NODSH" "$B_PREFIX/bin" "$B_HOME"
ln -s "$(command -v node)" "$NODSH/node"
ln -s "$(command -v npm)" "$NODSH/npm"

B_LOG=/tmp/onboard-fresh.log
# errexit stays OFF (see pass A): a failed install or a failing assert below
# must reach summary(), not kill the scenario into a missing result file.
set +e
env -i HOME="$HOME" TERM="${TERM:-xterm-256color}" \
  PATH="$NODSH:$B_PREFIX/bin:/usr/bin:/bin" \
  NPM_CONFIG_PREFIX="$B_PREFIX" \
  DSH_HOME="$B_HOME" \
  timeout 600 node "$LAUNCHER_PKG/bin/boot.mjs" >"$B_LOG" 2>&1
B_RC=$?
B_OUT="$(cat "$B_LOG")"
# The launcher exit itself is a finding: since the failure detail (exit code
# / signal) is now printed by boot.mjs, surface the tail verbatim when the
# fresh-machine run died before finishing the three steps.
if (( B_RC != 0 )); then
  bad "fresh-machine launcher exited $B_RC (0 expected); log tail:"
  tail -12 "$B_LOG" | sed 's/^/    | /'
fi
assert_matches 'step 1/3 noticed the missing host' '\[1/3\] dsh host +not found' "$B_OUT"
assert_matches 'step 1/3 installed the host' '\[1/3\] dsh host +installed [0-9]' "$B_OUT"
assert_matches 'step 2/3 handled pnpm' '\[2/3\] pnpm +(found|installed)' "$B_OUT"
assert_matches 'step 3/3 created the profile' '\[3/3\] tui profile +done' "$B_OUT"
if [[ -x "$B_PREFIX/bin/dsh" ]]; then
  ok 'host landed in the npm prefix fallback location'
else
  bad "host not found at $B_PREFIX/bin/dsh (rc=$B_RC)"
fi
B_DUMP="$("$B_PREFIX/bin/dsh" --profile tui --dump-config 2>&1 || true)"
assert_contains 'fresh-machine profile composes the plugin' 'tui-pi' "$B_DUMP"

summary
