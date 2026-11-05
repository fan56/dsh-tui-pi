#!/usr/bin/env bash
# Host-side driver: build the Ubuntu 24.04 e2e image from this source tree
# and run the whole scenario suite inside one container (the container's
# isolated ~/.dsh keeps the host config untouched).
#
# Usage:  ./e2e/run-e2e.sh          (from anywhere; resolves the repo root)
#
# Requirements: podman with a running machine (`podman machine start`).
# The base image pulls through docker.m.daocloud.io because docker.io is
# not reachable from this network; see e2e/Containerfile.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-localhost/dsh-tui-pi-e2e:latest}"

# Same resolution rule as ci.yml / release.yml: newest of the `latest`
# (stable) and `next` (rc) dist-tags, never hand-pinned and never the
# retired `alpha` tag.
# bash 3.2 (macOS) aborts on `"${arr[@]}"` for an empty array under `set -u`
# (and `arr=()` leaves the variable unset), so carry the flag as a plain
# string — value never contains spaces.
NPM_VIEW_REG=""
if ! npm view @deepseek-ai/dsh@latest version >/dev/null 2>&1; then
  NPM_VIEW_REG="--registry=https://registry.npmjs.org"
fi
# shellcheck disable=SC2086
STABLE="$(npm view @deepseek-ai/dsh@latest version $NPM_VIEW_REG)"
# shellcheck disable=SC2086
RC="$(npm view @deepseek-ai/dsh@next version $NPM_VIEW_REG 2>/dev/null || true)"
DSH_VERSION="$STABLE"
# Prerelease-aware newest-of(latest,next) — NOT sort -V (trap on record:
# sort -V ranks 0.2.1-rc.2 above 0.2.1 once a stable lands on latest).
DSH_VERSION="$STABLE"
if [ -n "$RC" ] && node -e '
  const parse = (v) => { const [core, pre] = v.split("-"); return { c: core.split(".").map(Number), pre } }
  const A = parse(process.argv[1]), B = parse(process.argv[2])
  for (let i = 0; i < 3; i++) {
    if (A.c[i] !== B.c[i]) process.exit(A.c[i] > B.c[i] ? 0 : 1)
  }
  if ((A.pre === undefined) !== (B.pre === undefined)) process.exit(A.pre === undefined ? 0 : 1)
  process.exit(String(A.pre ?? "") >= String(B.pre ?? "") ? 0 : 1)
' "$RC" "$STABLE"; then
  DSH_VERSION="$RC"
fi
printf '==> dsh closure: %s\n' "$DSH_VERSION"

# The mirror defaults (DaoCloud base image, npmmirror node dist) are baked
# into e2e/Containerfile on this repo, so the only build arg to forward is
# the resolved dsh version.
BUILD_ARGS=(--build-arg DSH_VERSION="$DSH_VERSION")

printf '==> building image %s (context: %s)\n' "$IMAGE" "$REPO_ROOT"
podman build -f "$REPO_ROOT/e2e/Containerfile" -t "$IMAGE" "${BUILD_ARGS[@]}" "$REPO_ROOT"

# Vendor the sibling dsh-subagent-registry build when one sits next to this
# checkout. npm's dsh-subagent-registry@0.18.0 (latest) statically imports
# CodeRunFailedError from @deepseek-ai/dsh-tools — an export the 0.2.2-rc.1
# host moved to the new @deepseek-ai/dsh-tool-executor-ptc package — so the
# published build dies at plugin load with an ESM SyntaxError and every
# scenario that dispatches through use_agent (75/76, plus 77's readiness
# probe) goes red on that host. The fixed source lives in the sibling repo;
# packing it here lets the scenarios run against the fix while npm still
# carries the stale build. The tarball reaches the container through the
# /e2e bind mount; scenarios fall back to the npm pin when nothing is
# vendored (fresh clone, CI, or a stale sibling).
VENDOR_DIR="$REPO_ROOT/e2e/vendor"
REGISTRY_SRC="${E2E_REGISTRY_SRC:-$REPO_ROOT/../dsh-subagent-registry}"
if [ -d "$REGISTRY_SRC/lib" ] && [ -f "$REGISTRY_SRC/package.json" ]; then
  mkdir -p "$VENDOR_DIR"
  rm -f "$VENDOR_DIR"/aiwayds-dsh-subagent-registry-*.tgz
  if (cd "$REGISTRY_SRC" && npm pack --pack-destination "$VENDOR_DIR" >/dev/null 2>&1); then
    REG_TGZ="$(ls "$VENDOR_DIR"/aiwayds-dsh-subagent-registry-*.tgz 2>/dev/null | head -1)"
    # Staleness probe: a build that still imports the moved symbol would die
    # at load exactly like the npm build — refuse to vendor it.
    if [ -n "$REG_TGZ" ] && tar xzOf "$REG_TGZ" package/lib/ptc/runner.js 2>/dev/null \
      | grep -q "import { CodeRunFailedError"; then
      rm -f "$REG_TGZ"
      printf '==> vendored registry build is stale (still imports the moved CodeRunFailedError) — scenarios fall back to the npm pin\n'
    else
      printf '==> vendored registry build: %s (sibling %s)\n' "$(basename "$REG_TGZ")" "$REGISTRY_SRC"
    fi
  else
    printf '==> sibling registry pack failed — scenarios fall back to the npm pin\n'
  fi
fi

printf '==> running scenario suite (all state stays inside the container)\n'
RUN_ARGS=(--rm --name dsh-tui-e2e -v "$REPO_ROOT/e2e:/e2e:ro")
# Subset override consumed by run-all.sh; forwarded so callers can scope a
# run without hand-rolling podman incantations.
if [ -n "${E2E_SCENARIOS:-}" ]; then
  RUN_ARGS+=(-e "E2E_SCENARIOS=$E2E_SCENARIOS")
fi
podman run "${RUN_ARGS[@]}" \
  "$IMAGE" \
  bash /e2e/scenarios/run-all.sh

printf '==> e2e finished OK\n'
