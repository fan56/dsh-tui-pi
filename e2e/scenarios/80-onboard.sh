#!/usr/bin/env bash
# Scenario — one-command onboarding: the `dsh-tui-pi`/`dst` launcher must
# bring a machine up by itself. Two passes:
#   A. the regular flow — dsh is present; `npm i -g` of the tarball runs the
#      postinstall onboarding (progress lines, both bins registered, the tui
#      profile composed, a piped boot with no setup banner = fast path);
#   B. the fresh-machine flow — dsh hidden from PATH, a separate npm prefix
#      and an empty DSH_HOME: the launcher's first run installs the host
#      itself (always via npm) and still ends in a composable profile.
# Runs LAST in the suite on purpose: pass A re-installs the profile the
# earlier scenarios built, so nothing after it should depend on that state.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'one-command onboarding (npm i -g → postinstall → dst)'

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

# Lifecycle-script policy differs across npm lines (npm >=11 gates them),
# so drive the postinstall explicitly: the assertion targets the script's
# behavior, not the installer's mood. This mirrors what an npm that does
# run it would produce.
GLOBAL_ROOT="$(npm prefix -g)"
LAUNCHER_PKG="$GLOBAL_ROOT/lib/node_modules/@aiwayds/dsh-tui-pi"
POSTINSTALL_LOG=/tmp/onboard-postinstall.log
if timeout 420 env npm_config_global=true node "$LAUNCHER_PKG/scripts/postinstall.mjs" >"$POSTINSTALL_LOG" 2>&1; then
  ok 'postinstall exited 0'
else
  bad "postinstall failed (exit $?)"
  tail -20 "$POSTINSTALL_LOG" | sed 's/^/    | /'
  summary
fi
A_LOG="$(cat "$POSTINSTALL_LOG")"
assert_contains 'postinstall announced the onboarding' 'preparing the dsh host' "$A_LOG"
assert_matches 'step 1/3 found the host' '\[1/3\] dsh host +found [0-9]' "$A_LOG"
assert_matches 'step 2/3 found pnpm' '\[2/3\] pnpm +found' "$A_LOG"
assert_matches 'step 3/3 created the profile' '\[3/3\] tui profile +(done|already set up)' "$A_LOG"
assert_contains 'postinstall reported ready' 'ready — launch' "$A_LOG"

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

PROFILE_DIR="$HOME/.dsh/profiles/tui"
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
timeout 25 sh -c 'sleep 40 | dsh --profile tui' >"$BOOT_LOG" 2>&1
BOOT_RC=$?
set -e
if [[ "$BOOT_RC" == "124" ]]; then
  ok 'boot survived until the timeout kill (healthy, piped)'
else
  bad "boot exited early (rc=$BOOT_RC); log tail:"
  tail -10 "$BOOT_LOG" | sed 's/^/    | /'
fi
assert_not_contains 'fast path printed no setup banner' 'setup (first run' "$(cat "$BOOT_LOG")"

# --- pass B: the fresh machine (dsh hidden, separate prefix + home) -------
info 'pass B: hide dsh, separate npm prefix, empty DSH_HOME'
NODSH=/tmp/onboard-nodsh-bin
B_PREFIX=/tmp/onboard-prefix
B_HOME="$HOME/.dsh-onboard-b"
rm -rf "$NODSH" "$B_PREFIX" "$B_HOME"
mkdir -p "$NODSH" "$B_PREFIX/bin" "$B_HOME"
ln -s "$(command -v node)" "$NODSH/node"
ln -s "$(command -v npm)" "$NODSH/npm"

B_LOG=/tmp/onboard-fresh.log
set +e
env -i HOME="$HOME" TERM="${TERM:-xterm-256color}" \
  PATH="$NODSH:$B_PREFIX/bin:/usr/bin:/bin" \
  NPM_CONFIG_PREFIX="$B_PREFIX" \
  DSH_HOME="$B_HOME" \
  timeout 600 node "$LAUNCHER_PKG/bin/boot.mjs" >"$B_LOG" 2>&1
B_RC=$?
set -e
B_OUT="$(cat "$B_LOG")"
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
