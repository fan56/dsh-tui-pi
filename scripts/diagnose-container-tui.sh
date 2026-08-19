#!/usr/bin/env bash
# diagnose-container-tui.sh — pipe this into a bare Ubuntu 22 container to
# diagnose why dsh-tui-pi shows a blank TUI after plugin install.
#
# Usage:
#   podman run --rm -i ubuntu:22.04 bash < scripts/diagnose-container-tui.sh
#
# Or with docker:
#   docker run --rm -i ubuntu:22.04 bash < scripts/diagnose-container-tui.sh
#
# The script is self-contained: it installs Node 22, pnpm, dsh 0.1.0-rc.7,
# and @aiwayds/dsh-tui-pi@0.7.1, then runs a battery of diagnostic checks.
# No code is modified — this is purely diagnostic.

set -uo pipefail

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
WARN=0
STEP=0

banner() {
  printf '\n%s\n' "================================================================"
  printf '  %s\n' "$1"
  printf '%s\n\n' "================================================================"
}
step() {
  STEP=$((STEP+1))
  printf '\n--- [%d] %s ---\n' "$STEP" "$1"
}
ok()     { printf '  [OK]   %s\n' "$1"; PASS=$((PASS+1)); }
fail()   { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL+1)); }
warn()   { printf '  [WARN] %s\n' "$1"; WARN=$((WARN+1)); }
info()   { printf '  [INFO] %s\n' "$1"; }

# ---------------------------------------------------------------------------
banner "dsh-tui-pi container TUI diagnostics"
info "Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
info "Host: $(uname -a)"
# ---------------------------------------------------------------------------

# ===== 0. Environment setup =====
step "Installing Node 22 (nodesource) + pnpm + utilities"

apt-get update -qq >/dev/null 2>&1
# script(1) is in bsdutils on Ubuntu; some images have it already
apt-get install -y -qq curl ca-certificates bsdutils >/dev/null 2>&1 || true

# nodesource Node 22
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null 2>&1
fi
info "node $(node --version), npm $(npm --version)"

if ! command -v pnpm &>/dev/null; then
  npm install -g pnpm >/dev/null 2>&1
fi
info "pnpm $(pnpm --version)"

# TERM for TUI rendering
export TERM=xterm-256color
info "TERM=$TERM"

# ===== 1. Install dsh =====
step "Installing @deepseek-ai/dsh@0.1.0-rc.7"

npm install -g @deepseek-ai/dsh@0.1.0-rc.7 2>&1 | tail -5
if command -v dsh &>/dev/null; then
  ok "dsh on PATH: $(which dsh)"
  info "dsh --version: $(dsh --version 2>&1 || echo '(flag not supported)')"
else
  fail "dsh not found on PATH after install"
  echo "ABORT: cannot continue without dsh"
  exit 1
fi

# ===== 2. Install dsh-tui-pi plugin =====
step "Installing @aiwayds/dsh-tui-pi@0.7.1 into profile 'tui'"

INSTALL_OUTPUT=$(dsh plugin --profile tui add @aiwayds/dsh-tui-pi@0.7.1 2>&1) || true
INSTALL_EXIT=$?
info "dsh plugin add exit code: $INSTALL_EXIT"
echo "$INSTALL_OUTPUT" | head -30 | sed 's/^/    /'
if [ "$INSTALL_EXIT" -eq 0 ]; then
  ok "Plugin install reported success (exit 0)"
else
  fail "Plugin install failed (exit $INSTALL_EXIT)"
fi

# ===== 3. Profile directory structure =====
step "Profile directory structure"

PROFILE_DIR="$HOME/.dsh/profiles/tui"
if [ -d "$PROFILE_DIR" ]; then
  ok "Profile dir exists: $PROFILE_DIR"
  info "Top-level contents:"
  ls -la "$PROFILE_DIR/" 2>&1 | sed 's/^/    /'
else
  fail "Profile dir does not exist: $PROFILE_DIR"
fi

# ===== 4. Check profile bundles =====
step "Profile bundles / cordis.patch.yml registration"

FOUND_BUNDLES=0
for f in "$PROFILE_DIR/dsh.profile" "$PROFILE_DIR/dsh.profile.yml" "$PROFILE_DIR/dsh.profile.yaml"; do
  if [ -f "$f" ]; then
    ok "Found profile config: $f"
    echo "    --- contents ---"
    cat "$f" 2>&1 | sed 's/^/    /'
    echo "    --- end ---"
    FOUND_BUNDLES=1
  fi
done

# Also check package.json for bundle references
if [ -f "$PROFILE_DIR/package.json" ]; then
  info "package.json dependencies:"
  node -e "
    const pkg = JSON.parse(require('fs').readFileSync('$PROFILE_DIR/package.json','utf8'));
    const deps = {...(pkg.dependencies||{}), ...(pkg.devDependencies||{})};
    for (const [k,v] of Object.entries(deps)) {
      console.log('    ' + k + ': ' + v);
    }
  " 2>&1 || true

  # Check if dsh-tui-pi is in dependencies
  if node -e "
    const pkg = JSON.parse(require('fs').readFileSync('$PROFILE_DIR/package.json','utf8'));
    const deps = {...(pkg.dependencies||{}), ...(pkg.devDependencies||{})};
    const has = deps['@aiwayds/dsh-tui-pi'] || deps['dsh-tui-pi'];
    process.exit(has ? 0 : 1);
  " 2>/dev/null; then
    ok "dsh-tui-pi is listed in profile package.json dependencies"
  else
    fail "dsh-tui-pi NOT found in profile package.json dependencies"
  fi
fi

if [ "$FOUND_BUNDLES" -eq 0 ]; then
  # Check if cordis.patch.yml was copied into the profile
  if find "$PROFILE_DIR" -name "cordis.patch.yml" 2>/dev/null | head -1 | grep -q .; then
    ok "cordis.patch.yml found in profile tree"
  else
    warn "No dsh.profile file and no cordis.patch.yml found in profile"
    info "dsh-tui-pi registers via cordis.patch.yml (insert id: tui-pi)"
    info "The plugin loader must discover this file in node_modules"
  fi
fi

# ===== 5. Check node_modules for plugin package =====
step "Plugin package in node_modules"

TUI_PKG_DIR=""
for candidate in \
  "$PROFILE_DIR/node_modules/@aiwayds/dsh-tui-pi" \
  "$PROFILE_DIR/node_modules/dsh-tui-pi"; do
  if [ -d "$candidate" ]; then
    ok "Plugin package found: $candidate"
    TUI_PKG_DIR="$candidate"
    info "Version: $(node -e "console.log(JSON.parse(require('fs').readFileSync('$candidate/package.json','utf8')).version)" 2>&1 || echo 'unreadable')"
    info "lib/ contents:"
    ls "$candidate/lib/" 2>&1 | head -15 | sed 's/^/    /'
    break
  fi
done
if [ -z "$TUI_PKG_DIR" ]; then
  fail "dsh-tui-pi package NOT found in node_modules"
fi

# ===== 6. cordis.patch.yml verification =====
step "cordis.patch.yml content (bundle registration id)"

if [ -n "$TUI_PKG_DIR" ] && [ -f "$TUI_PKG_DIR/cordis.patch.yml" ]; then
  ok "cordis.patch.yml found in plugin package"
  echo "    --- contents ---"
  cat "$TUI_PKG_DIR/cordis.patch.yml" | sed 's/^/    /'
  echo "    --- end ---"

  if grep -q "tui-pi" "$TUI_PKG_DIR/cordis.patch.yml"; then
    ok "Bundle id 'tui-pi' present in patch"
  else
    fail "Bundle id 'tui-pi' NOT found in cordis.patch.yml"
  fi
else
  fail "cordis.patch.yml NOT found in plugin package"
fi

# ===== 7. @deepseek-ai closure symlinks =====
step "@deepseek-ai closure (critical: single cordis instance contract)"

# The consumer runtime closure: ~/.dsh/profiles/node_modules/@deepseek-ai/
GLOBAL_CLOSURE="$HOME/.dsh/profiles/node_modules/@deepseek-ai"
if [ -d "$GLOBAL_CLOSURE" ]; then
  ok "Global closure exists: $GLOBAL_CLOSURE"
  info "Contents:"
  ls -la "$GLOBAL_CLOSURE/" 2>&1 | sed 's/^/    /'

  # Check if cordis is symlink or physical (AGENTS.md iron rule 8)
  CORDIS_PATH="$GLOBAL_CLOSURE/cordis"
  if [ -e "$CORDIS_PATH" ]; then
    if [ -L "$CORDIS_PATH" ]; then
      ok "cordis is a symlink (correct — single closure)"
      info "  -> $(readlink "$CORDIS_PATH")"
    else
      fail "cordis is a PHYSICAL directory (WRONG — causes dual cordis instances)"
      info "  This triggers 'Cannot read properties of undefined (reading prepare)' crash"
    fi
  else
    fail "cordis NOT found in global closure"
  fi
else
  warn "Global closure dir not found: $GLOBAL_CLOSURE"
  info "Checking plugin-local @deepseek-ai..."
  PLUGIN_CLOSURE="${TUI_PKG_DIR:+$TUI_PKG_DIR/node_modules/@deepseek-ai}"
  if [ -n "$PLUGIN_CLOSURE" ] && [ -d "$PLUGIN_CLOSURE" ]; then
    info "Plugin-local @deepseek-ai found: $PLUGIN_CLOSURE"
    ls -la "$PLUGIN_CLOSURE/" 2>&1 | sed 's/^/    /'
  else
    fail "No @deepseek-ai found anywhere — plugin cannot resolve cordis types"
  fi
fi

# dsh global install's own closure
DSH_BIN=$(which dsh 2>/dev/null || echo "")
if [ -n "$DSH_BIN" ]; then
  DSH_REAL=$(realpath "$DSH_BIN" 2>/dev/null || echo "$DSH_BIN")
  DSH_GLOBAL_CLOSURE="$(dirname "$(dirname "$DSH_REAL")")/node_modules/@deepseek-ai"
  if [ -d "$DSH_GLOBAL_CLOSURE" ]; then
    ok "dsh global closure: $DSH_GLOBAL_CLOSURE"
    info "Contents:"
    ls "$DSH_GLOBAL_CLOSURE/" 2>&1 | sed 's/^/    /'
  else
    warn "dsh global closure not at expected path: $DSH_GLOBAL_CLOSURE"
  fi
fi

# ===== 8. Node module resolution test =====
step "Module resolution: can the plugin resolve @deepseek-ai/cordis?"

if [ -n "$TUI_PKG_DIR" ]; then
  RESOLVE_TEST=$(node -e "
    try {
      const path = require.resolve('@deepseek-ai/cordis', { paths: ['$TUI_PKG_DIR'] });
      console.log('RESOLVED: ' + path);
    } catch (e) {
      console.log('FAILED: ' + e.message);
    }
  " 2>&1)
  info "@deepseek-ai/cordis from plugin dir:"
  echo "    $RESOLVE_TEST"

  if echo "$RESOLVE_TEST" | grep -q "RESOLVED"; then
    ok "@deepseek-ai/cordis resolves from plugin directory"
  else
    fail "@deepseek-ai/cordis does NOT resolve from plugin directory"
    info "This is the most common root cause of blank TUI"
  fi

  # Also check pi-tui
  PIUI_TEST=$(node -e "
    try {
      const path = require.resolve('@earendil-works/pi-tui', { paths: ['$TUI_PKG_DIR'] });
      console.log('RESOLVED: ' + path);
    } catch (e) {
      console.log('FAILED: ' + e.message);
    }
  " 2>&1)
  info "@earendil-works/pi-tui from plugin dir:"
  echo "    $PIUI_TEST"

  if echo "$PIUI_TEST" | grep -q "RESOLVED"; then
    ok "@earendil-works/pi-tui resolves"
  else
    fail "@earendil-works/pi-tui does NOT resolve"
  fi
fi

# ===== 9. pi-tui native bindings (informational — Linux degrades gracefully) =====
step "pi-tui native bindings (informational — Linux has no native helpers)"

if [ -n "$TUI_PKG_DIR" ]; then
  PIUI_PKG=$(node -e "
    try { console.log(require.resolve('@earendil-works/pi-tui/package.json', { paths: ['$TUI_PKG_DIR'] }).replace('/package.json','')); }
    catch { console.log(''); }
  " 2>/dev/null || echo "")

  if [ -n "$PIUI_PKG" ] && [ -d "$PIUI_PKG" ]; then
    info "pi-tui package: $PIUI_PKG"
    if [ -d "$PIUI_PKG/native" ]; then
      info "Native platforms shipped:"
      ls "$PIUI_PKG/native/" 2>&1 | sed 's/^/    /'

      # Check linux availability
      if [ -d "$PIUI_PKG/native/linux" ]; then
        ok "Linux native bindings exist"
      else
        info "No linux native bindings — but this is EXPECTED and harmless"
        info "pi-tui native-modifiers.js returns undefined on process.platform !== 'darwin'/'win32'"
        info "The native helpers are only for darwin modifier keys and win32 console mode"
        info "Linux terminal input works without native bindings (process.stdin raw mode)"
      fi
    fi
  fi
fi

# ===== 10. dsh --help — command registration check =====
step "dsh --profile tui --help (are TUI commands visible?)"

HELP_OUTPUT=$(dsh --profile tui --help 2>&1) || true
echo "$HELP_OUTPUT" | head -30 | sed 's/^/    /'

TUI_CMDS=0
for cmd in "/login" "/logout" "/settings" "/model" "/theme" "/session" "/resume" "/hotkeys" "/reload"; do
  if echo "$HELP_OUTPUT" | grep -qi "$cmd"; then
    ok "Command in help: $cmd"
    TUI_CMDS=$((TUI_CMDS+1))
  fi
done
if [ "$TUI_CMDS" -eq 0 ]; then
  fail "No dsh-tui-pi commands found in --help output"
  info "This suggests the plugin is NOT being loaded by dsh"
else
  ok "$TUI_CMDS dsh-tui-pi commands found in --help"
fi

# ===== 11. dsh --profile tui --version =====
step "dsh --profile tui --version (non-interactive sanity check)"

VERSION_OUTPUT=$(dsh --profile tui --version 2>&1) || true
info "Output:"
echo "$VERSION_OUTPUT" | sed 's/^/    /'
if echo "$VERSION_OUTPUT" | grep -qi "dsh-tui-pi\|0\.7\.1\|tui-pi"; then
  ok "Version output mentions dsh-tui-pi or version"
else
  warn "Version output does not mention dsh-tui-pi"
fi

# ===== 12. Check if dsh exits cleanly without TTY =====
step "dsh --profile tui exit behavior (no TTY, 5s timeout)"

EXIT_LOG="/tmp/dsh-exit-test.log"
START_TS=$(date +%s)
timeout 5 dsh --profile tui </dev/null >"$EXIT_LOG" 2>&1 || true
EXIT_CODE=$?
END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))

info "Exit code: $EXIT_CODE (after ${DURATION}s)"
info "Output bytes: $(wc -c < "$EXIT_LOG")"

if [ "$EXIT_CODE" -eq 124 ]; then
  info "Exit 124 = timeout (TUI started but did not exit on its own)"
  info "This is expected: TUI waits for user input"
  ok "TUI process is alive (timeout = it ran for 5 seconds)"
elif [ "$EXIT_CODE" -eq 0 ]; then
  warn "Exit 0 = TUI exited immediately without error"
  info "Possible cause: TUI detects no TTY and exits gracefully"
else
  warn "Exit $EXIT_CODE = TUI exited with error"
fi

if [ -s "$EXIT_LOG" ]; then
  info "Exit test output:"
  cat "$EXIT_LOG" | head -30 | cat -v | sed 's/^/    /'
else
  info "(no output captured)"
fi

# ===== 13. script command capture =====
step "Terminal capture with 'script -q' (PTY emulation)"

SCRIPT_LOG="/tmp/dsh-tui-script.log"
# script provides a pseudo-TTY, which may let the TUI render
timeout 5 script -q "$SCRIPT_LOG" -c "dsh --profile tui" </dev/null 2>&1 || true

SCRIPT_SIZE=$(wc -c < "$SCRIPT_LOG" 2>/dev/null || echo 0)
info "script log size: $SCRIPT_SIZE bytes"

if [ "$SCRIPT_SIZE" -gt 0 ]; then
  ok "script captured output ($SCRIPT_SIZE bytes)"
  info "First 50 lines (cat -v shows escape sequences):"
  head -50 "$SCRIPT_LOG" | cat -v | sed 's/^/    /'

  # Check for alt-screen activation: ESC[?1049h
  if cat -v "$SCRIPT_LOG" | grep -q '\[?1049h\|\[2J\|\[H'; then
    ok "Alt-screen / cursor-home escape sequences detected"
  else
    info "No alt-screen escapes (TUI may not have entered alt-screen mode)"
  fi

  # Strip escape sequences and check for visible text
  VISIBLE=$(sed 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\][^\x07]*\x07//g; s/\x1b[()][AB012]//g' "$SCRIPT_LOG" | tr -d '[:cntrl:]' | tr -s ' ')
  if [ -n "$VISIBLE" ] && [ ${#VISIBLE} -gt 10 ]; then
    ok "Visible text content found after stripping escapes"
    info "Cleaned text (first 300 chars):"
    echo "$VISIBLE" | head -c 300 | sed 's/^/    /'
  else
    fail "No visible text content — TUI output is blank or all-escape"
    info "This confirms the blank TUI symptom"
  fi
else
  fail "script captured zero bytes — TUI produced no output at all"
fi

# ===== 14. Direct pipe capture =====
step "Direct pipe capture: dsh --profile tui 2>&1 (no PTY)"

PIPE_LOG="/tmp/dsh-tui-pipe.log"
timeout 5 dsh --profile tui </dev/null >"$PIPE_LOG" 2>&1 || true

PIPE_SIZE=$(wc -c < "$PIPE_LOG" 2>/dev/null || echo 0)
info "Pipe log size: $PIPE_SIZE bytes"

if [ "$PIPE_SIZE" -gt 0 ]; then
  ok "Pipe captured output ($PIPE_SIZE bytes)"
  info "Raw output (cat -v):"
  cat -v "$PIPE_LOG" | head -50 | sed 's/^/    /'

  # Check for TUI content markers
  if cat "$PIPE_LOG" | grep -qi "dsh-tui-pi\|pi-tui\|whale\|DSH TUI\|welcome"; then
    ok "TUI content markers found in pipe output"
  else
    info "No TUI content markers in pipe output"
  fi
else
  fail "Pipe captured zero bytes — TUI is silent without a PTY"
fi

# ===== 15. stderr-only capture =====
step "Stderr capture (error diagnostics)"

STDERR_LOG="/tmp/dsh-stderr.log"
timeout 5 dsh --profile tui </dev/null 2>"$STDERR_LOG" || true

STDERR_SIZE=$(wc -c < "$STDERR_LOG" 2>/dev/null || echo 0)
info "Stderr size: $STDERR_SIZE bytes"

if [ "$STDERR_SIZE" -gt 0 ]; then
  warn "Stderr has output (may contain errors):"
  cat "$STDERR_LOG" | head -40 | sed 's/^/    /'
else
  info "Stderr is empty (no error output)"
fi

# ===== 16. DSH home directory inspection =====
step "DSH home directory (~/.dsh/)"

if [ -d "$HOME/.dsh" ]; then
  ok "$HOME/.dsh exists"
  info "Top-level:"
  ls -la "$HOME/.dsh/" 2>&1 | sed 's/^/    /'

  # Log files
  info "Looking for log files..."
  LOGS=$(find "$HOME/.dsh" -maxdepth 3 \( -name "*.log" -o -name "debug*" -o -name "error*" -o -name "crash*" \) 2>/dev/null)
  if [ -n "$LOGS" ]; then
    ok "Log files found:"
    echo "$LOGS" | sed 's/^/    /'
    # Show last few lines of each log
    for lf in $LOGS; do
      info "--- $lf (last 10 lines) ---"
      tail -10 "$lf" 2>&1 | sed 's/^/    /'
    done
  else
    info "No log files found in ~/.dsh/"
  fi

  # settings.yaml
  if [ -f "$HOME/.dsh/settings.yaml" ]; then
    ok "settings.yaml exists"
    info "Contents:"
    cat "$HOME/.dsh/settings.yaml" | sed 's/^/    /'
  else
    warn "No settings.yaml (fresh install, no config yet)"
  fi

  # .credentials.yaml
  if [ -f "$HOME/.dsh/.credentials.yaml" ]; then
    ok ".credentials.yaml exists"
  else
    warn "No .credentials.yaml — /login may be required"
    info "TUI might show blank if it blocks on authentication"
  fi
else
  fail "$HOME/.dsh does not exist"
fi

# ===== 17. NODE_DEBUG=module trace =====
step "Module loading trace (NODE_DEBUG=module)"

MODULE_LOG="/tmp/dsh-module-debug.log"
timeout 5 NODE_DEBUG=module dsh --profile tui </dev/null 2>"$MODULE_LOG" || true

MODULE_SIZE=$(wc -c < "$MODULE_LOG" 2>/dev/null || echo 0)
info "Module debug log: $MODULE_SIZE bytes"

if [ "$MODULE_SIZE" -gt 0 ]; then
  # Check for plugin loading
  if grep -i "dsh-tui-pi\|tui-pi\|@aiwayds" "$MODULE_LOG" >/dev/null 2>&1; then
    ok "Module trace mentions dsh-tui-pi"
    grep -i "dsh-tui-pi\|tui-pi\|@aiwayds" "$MODULE_LOG" | head -5 | sed 's/^/    /'
  else
    fail "Module trace does NOT mention dsh-tui-pi — plugin never loaded"
  fi

  # Check for errors
  ERRORS=$(grep -i "error\|ERR_\|MODULE_NOT_FOUND\|cannot find\|not found" "$MODULE_LOG" 2>/dev/null | head -10)
  if [ -n "$ERRORS" ]; then
    warn "Errors in module debug:"
    echo "$ERRORS" | sed 's/^/    /'
  fi
else
  warn "Module debug log empty"
fi

# ===== 18. dsh profile list =====
step "dsh profile list"

PROFILE_LIST=$(dsh profile list 2>&1) || true
echo "$PROFILE_LIST" | sed 's/^/    /'
if echo "$PROFILE_LIST" | grep -qi "tui"; then
  ok "Profile 'tui' in profile list"
else
  warn "Profile 'tui' not in profile list"
fi

# ===== 19. dsh plugin list =====
step "dsh plugin --profile tui list"

PLUGIN_LIST=$(dsh plugin --profile tui list 2>&1) || true
echo "$PLUGIN_LIST" | sed 's/^/    /'
if echo "$PLUGIN_LIST" | grep -qi "dsh-tui-pi\|tui-pi\|@aiwayds"; then
  ok "dsh-tui-pi in plugin list"
else
  fail "dsh-tui-pi NOT in plugin list"
fi

# ===== 20. Full plugin node_modules listing =====
step "Full node_modules listing for @deepseek-ai and @earendil-works"

if [ -n "$TUI_PKG_DIR" ]; then
  info "@deepseek-ai in plugin node_modules:"
  ls -la "$TUI_PKG_DIR/node_modules/@deepseek-ai/" 2>&1 | sed 's/^/    /' || info "  (not found)"

  info "@earendil-works in plugin node_modules:"
  ls -la "$TUI_PKG_DIR/node_modules/@earendil-works/" 2>&1 | sed 's/^/    /' || info "  (not found)"
fi

# Also check the profile-level node_modules
info "@deepseek-ai in profile node_modules:"
ls -la "$PROFILE_DIR/node_modules/@deepseek-ai/" 2>&1 | sed 's/^/    /' || info "  (not found)"

# ===== 21. strace-lite: check if process opens any files =====
step "Process activity trace (strace-lite via /proc)"

# On Ubuntu, we can check /proc for the dsh process
timeout 3 bash -c '
  dsh --profile tui </dev/null &
  PID=$!
  sleep 1
  if [ -d "/proc/$PID" ]; then
    echo "  [INFO] dsh process alive as PID $PID"
    echo "  [INFO] Open file descriptors:"
    ls -la /proc/$PID/fd 2>/dev/null | tail -20 | sed "s/^/    /"
    echo "  [INFO] Memory maps (node modules loaded):"
    grep "node_modules\|pi-tui\|dsh-tui" /proc/$PID/maps 2>/dev/null | head -10 | sed "s/^/    /"
  else
    echo "  [INFO] dsh process already exited"
  fi
  wait $PID 2>/dev/null || true
' 2>&1 || true

# ===== Summary =====
banner "DIAGNOSTIC SUMMARY"
echo ""
printf "  PASS: %d\n" "$PASS"
printf "  FAIL: %d\n" "$FAIL"
printf "  WARN: %d\n" "$WARN"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "  ISSUES DETECTED — review [FAIL] items above."
  echo ""
  echo "  Common root causes for blank TUI in containers:"
  echo "  1. @deepseek-ai/cordis not resolvable from plugin (closure broken)"
  echo "  2. Plugin not registered in profile bundles (cordis.patch.yml missing)"
  echo "  3. No TTY — pi-tui TuiAltScreen requires a real terminal"
  echo "     (podman run -i without -t gives stdin but no PTY)"
  echo "  4. Missing .credentials.yaml — TUI may block waiting for /login"
  echo "  5. pi-tui process.platform check fails silently on unexpected env"
  echo ""
  echo "  NOTE: pi-tui native bindings (darwin-modifiers, win32-console-mode)"
  echo "  are NOT needed on Linux — native-modifiers.js returns undefined"
  echo "  gracefully for platform !== 'darwin'/'win32'. This is NOT the cause."
else
  echo "  All checks passed."
  echo "  Blank TUI is likely a rendering issue (no PTY or terminal detection)."
fi

echo ""
echo "  Diagnostic logs:"
echo "    /tmp/dsh-tui-script.log   (script PTY capture)"
echo "    /tmp/dsh-tui-pipe.log     (direct pipe capture)"
echo "    /tmp/dsh-stderr.log       (stderr)"
echo "    /tmp/dsh-module-debug.log (NODE_DEBUG=module)"
echo "    /tmp/dsh-exit-test.log    (exit behavior)"
echo ""
