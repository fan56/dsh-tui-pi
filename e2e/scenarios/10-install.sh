#!/usr/bin/env bash
# Scenario 1 — installation: global dsh CLI (baked into the image) sanity,
# then the real user flow under test: install the freshly built plugin
# tarball into a dsh profile and verify the profile-side contracts
# (bundle registration, cordis.patch.yml, single @deepseek-ai closure).
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'install (dsh CLI + plugin tarball into profile)'

PROFILE_DIR="$HOME/.dsh/profiles/tui"

# --- dsh CLI -------------------------------------------------------------
if command -v dsh >/dev/null 2>&1; then
  ok "dsh on PATH: $(command -v dsh)"
else
  bad 'dsh not on PATH'
fi
DSH_VERSION_OUT="$(dsh --version 2>&1 || true)"
info "dsh --version: $DSH_VERSION_OUT"
if printf '%s' "$DSH_VERSION_OUT" | grep -q '0\.1\.0-rc\.8'; then
  ok 'dsh version is 0.1.0-rc.8'
else
  warn "dsh version output did not contain 0.1.0-rc.8: $DSH_VERSION_OUT"
fi

# --- plugin tarball ------------------------------------------------------
TARBALL="$(ls /dist/*.tgz 2>/dev/null | head -1)"
if [[ -n "$TARBALL" && -f "$TARBALL" ]]; then
  ok "plugin tarball built and present: $(basename "$TARBALL")"
else
  bad 'no tarball found in /dist'
  summary
fi

# --- install into profile (the flow a real user runs) --------------------
info "installing: dsh plugin --profile tui add $TARBALL"
if timeout 420 dsh plugin --profile tui add "$TARBALL" >/tmp/plugin-add.log 2>&1; then
  ok 'dsh plugin add exited 0'
else
  bad "dsh plugin add failed (exit $?); tail of log:"
  tail -30 /tmp/plugin-add.log | sed 's/^/    | /'
  summary
fi

LIST_OUT="$(dsh plugin --profile tui list 2>&1 || true)"
info "dsh plugin list: $(printf '%s' "$LIST_OUT" | tr '\n' ' ' | head -c 300)"
if printf '%s' "$LIST_OUT" | grep -qi 'dsh-tui-pi'; then
  ok "plugin listed in profile 'tui'"
else
  bad "plugin not listed by 'dsh plugin --profile tui list'"
fi

# --- profile structure ---------------------------------------------------
if [[ -f "$PROFILE_DIR/package.json" ]]; then
  ok "profile dir created: $PROFILE_DIR"
else
  bad "profile dir missing: $PROFILE_DIR"
  summary
fi

PROFILE_JSON="$(cat "$PROFILE_DIR/package.json")"
assert_contains 'profile declares bundle key dsh-tui-pi' 'dsh-tui-pi' "$PROFILE_JSON"
assert_contains 'profile declares loader key @aiwayds/dsh-tui-pi' '@aiwayds/dsh-tui-pi' "$PROFILE_JSON"

TUI_PKG=""
for candidate in \
  "$PROFILE_DIR/node_modules/@aiwayds/dsh-tui-pi" \
  "$PROFILE_DIR/node_modules/dsh-tui-pi"; do
  if [[ -d "$candidate" ]]; then TUI_PKG="$candidate"; break; fi
done
if [[ -n "$TUI_PKG" ]]; then
  ok "plugin package installed at: $TUI_PKG"
else
  bad 'plugin package not found in profile node_modules'
  summary
fi

assert_contains 'plugin lib/ emitted (build product shipped)' 'lib' "$(ls "$TUI_PKG")"
if [[ -f "$TUI_PKG/cordis.patch.yml" ]] \
  && grep -q 'tui-pi' "$TUI_PKG/cordis.patch.yml"; then
  ok 'cordis.patch.yml shipped and registers the tui-pi bundle'
else
  bad 'cordis.patch.yml missing or has no tui-pi id'
fi

# --- single @deepseek-ai closure contract (top-level AGENTS.md rule 8) ----
# dsh's plugin loader injects @deepseek-ai/* from the global closure at load
# time — a profile-level closure dir is legitimate to be absent (plain node
# resolution from the plugin dir then yields MODULE_NOT_FOUND, which is
# expected, not a defect). The contract that matters: if anything
# @deepseek-ai landed in the profile's node_modules, it must be a symlink
# into the single closure — a physical copy means two cordis instances.
# The empirical proof of the whole chain is the TUI booting (scenario 20).
CLOSURE="$HOME/.dsh/profiles/node_modules/@deepseek-ai"
if [[ -L "$CLOSURE/cordis" ]]; then
  ok "closure cordis is a symlink -> $(readlink "$CLOSURE/cordis")"
elif [[ -d "$CLOSURE/cordis" ]]; then
  bad 'closure cordis is a PHYSICAL directory (dual-cordis hazard)'
elif [[ ! -e "$CLOSURE" ]]; then
  ok 'no @deepseek-ai copies in profile node_modules (dsh injects the closure)'
else
  warn 'closure cordis entry exists but is neither symlink nor directory'
fi

# Runtime dependency of the plugin itself must resolve from the profile.
RESOLVE_JS='
import { createRequire } from "node:module";
const req = createRequire(process.argv[1] + "/");
for (const name of ["@earendil-works/pi-tui", "@aiwayds/dsh-dcp", "@aiwayds/dsh-subagent-registry"]) {
  try { req.resolve(name); console.log(name + " RESOLVED"); }
  catch (e) { console.log(name + " FAILED " + e.code); }
}
'
RESOLVE_OUT="$(node --input-type=module -e "$RESOLVE_JS" "$TUI_PKG" 2>&1 || true)"
printf '%s\n' "$RESOLVE_OUT" | sed 's/^/  [info] /'
assert_contains '@earendil-works/pi-tui resolves from plugin dir' \
  '@earendil-works/pi-tui RESOLVED' "$RESOLVE_OUT"
assert_contains '@aiwayds/dsh-dcp resolves from plugin dir' \
  '@aiwayds/dsh-dcp RESOLVED' "$RESOLVE_OUT"
assert_contains '@aiwayds/dsh-subagent-registry resolves from plugin dir' \
  '@aiwayds/dsh-subagent-registry RESOLVED' "$RESOLVE_OUT"

summary
