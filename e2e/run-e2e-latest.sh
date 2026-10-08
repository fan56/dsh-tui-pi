#!/usr/bin/env bash
# Host-side driver for the LATEST-WAVE e2e: the published @aiwayds plugins
# at their npm-latest versions (no source tree, no /dist tarball) — the
# "what did users just install" counterpart of run-e2e.sh's source-tree run.
#
# Usage:  ./e2e/run-e2e-latest.sh
#
# Generates e2e/latest-profile/package.json from live npm view answers
# (official registry), builds e2e/Containerfile.latest, and runs the full
# scenario suite minus 10-install inside one container.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-localhost/dsh-tui-pi-e2e-latest:latest}"
REG="--registry=https://registry.npmjs.org"

# Same resolution rule as run-e2e.sh: newest of latest/next.
NPM_VIEW_REG=""
if ! npm view @deepseek-ai/dsh@latest version >/dev/null 2>&1; then
  NPM_VIEW_REG="$REG"
fi
# shellcheck disable=SC2086
STABLE="$(npm view @deepseek-ai/dsh@latest version $NPM_VIEW_REG)"
# shellcheck disable=SC2086
RC="$(npm view @deepseek-ai/dsh@next version $NPM_VIEW_REG 2>/dev/null || true)"
DSH_VERSION="$STABLE"
if [ -n "$RC" ] && [ "$(printf '%s\n' "$STABLE" "$RC" | sort -V | tail -1)" = "$RC" ]; then
  DSH_VERSION="$RC"
fi
printf '==> dsh closure: %s\n' "$DSH_VERSION"

# The full sibling wave (everything the user's real tui profile carries).
PLUGINS=(
  dsh-agent-dispatch
  dsh-approval-policy
  dsh-ask-router
  dsh-cron
  dsh-dcp
  dsh-feishu
  dsh-jev-core
  dsh-llm-net-retry
  dsh-llm-proxy
  dsh-llm-stats
  dsh-mcp-adapter
  dsh-model-sync
  dsh-profile-switch
  dsh-subagent-registry
  dsh-topics-memory
  dsh-tui-pi
  dsh-vault
  dsh-web-search-anysearch
  dsh-web-search-tavily
)

printf '==> resolving npm-latest versions (official registry)\n'
DEPS_JSON='{'
FIRST=1
for pkg in "${PLUGINS[@]}"; do
  # shellcheck disable=SC2086
  version="$(npm view "@aiwayds/$pkg" version $REG)"
  if [ -z "$version" ]; then
    echo "could not resolve @aiwayds/$pkg" >&2
    exit 1
  fi
  printf '    @aiwayds/%s %s\n' "$pkg" "$version"
  [ $FIRST -eq 1 ] || DEPS_JSON+=','
  FIRST=0
  DEPS_JSON+="\"@aiwayds/$pkg\":\"$version\""
done
# The profile's own host-runner pin: the @deepseek-ai closure member the
# real profile carries. Its `latest` dist-tag is stale (0.0.1-rc.3), so
# resolve newest-of-latest/next — the same rule as the dsh CLI itself.
# shellcheck disable=SC2086
RUNNER_STABLE="$(npm view @deepseek-ai/dsh-cordis-host-runner@latest version $REG)"
# shellcheck disable=SC2086
RUNNER_NEXT="$(npm view @deepseek-ai/dsh-cordis-host-runner@next version $REG 2>/dev/null || true)"
RUNNER="$RUNNER_STABLE"
if [ -n "$RUNNER_NEXT" ] && [ "$(printf '%s\n' "$RUNNER_STABLE" "$RUNNER_NEXT" | sort -V | tail -1)" = "$RUNNER_NEXT" ]; then
  RUNNER="$RUNNER_NEXT"
fi
[ -z "$RUNNER" ] && { echo "could not resolve @deepseek-ai/dsh-cordis-host-runner" >&2; exit 1; }
printf '    @deepseek-ai/dsh-cordis-host-runner %s\n' "$RUNNER"
DEPS_JSON+=",\"@deepseek-ai/dsh-cordis-host-runner\":\"$RUNNER\"}"

mkdir -p "$REPO_ROOT/e2e/latest-profile"
node -e '
const fs = require("fs")
const deps = JSON.parse(process.argv[2])
const manifest = {
  name: "dsh-profile-tui",
  private: true,
  dependencies: deps,
  dsh: { profile: { bundles: [
    "@deepseek-ai/dsh-base",
    ...Object.keys(deps).filter(name => name.startsWith("@aiwayds/")),
  ] } },
  // The pnpm 10 default script block is CORRECT for published plugins: their
  // postinstalls are dev-tree closure linkers that the npm tarball does not
  // ship (running them fails with MODULE_NOT_FOUND — dsh-vault 0.7.0). Only
  // the genuinely native deps need the build approval; everything else
  // stays blocked, exactly like a `dsh plugin add` install leaves them.
  pnpm: { onlyBuiltDependencies: ["koffi", "node-pty"] },
}
fs.writeFileSync(process.argv[1], JSON.stringify(manifest, null, 2) + "\n")
console.log("==> wrote e2e/latest-profile/package.json")
' "$REPO_ROOT/e2e/latest-profile/package.json" "$DEPS_JSON"

printf '==> building image %s\n' "$IMAGE"
podman build -f "$REPO_ROOT/e2e/Containerfile.latest" -t "$IMAGE" \
  --build-arg DSH_VERSION="$DSH_VERSION" "$REPO_ROOT/e2e"

printf '==> running scenario suite (latest wave)\n'
podman run --rm --name dsh-tui-e2e-latest \
  -v "$REPO_ROOT/e2e:/e2e:ro" \
  "$IMAGE"

printf '==> latest-wave e2e finished OK\n'
