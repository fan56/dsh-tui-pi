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
if [ -n "$RC" ] && [ "$(printf '%s\n' "$STABLE" "$RC" | sort -V | tail -1)" = "$RC" ]; then
  DSH_VERSION="$RC"
fi
printf '==> dsh closure: %s\n' "$DSH_VERSION"

# The mirror defaults (DaoCloud base image, npmmirror node dist) are baked
# into e2e/Containerfile on this repo, so the only build arg to forward is
# the resolved dsh version.
BUILD_ARGS=(--build-arg DSH_VERSION="$DSH_VERSION")

printf '==> building image %s (context: %s)\n' "$IMAGE" "$REPO_ROOT"
podman build -f "$REPO_ROOT/e2e/Containerfile" -t "$IMAGE" "${BUILD_ARGS[@]}" "$REPO_ROOT"

printf '==> running scenario suite (all state stays inside the container)\n'
podman run --rm --name dsh-tui-e2e \
  -v "$REPO_ROOT/e2e:/e2e:ro" \
  "$IMAGE" \
  bash /e2e/scenarios/run-all.sh

printf '==> e2e finished OK\n'
