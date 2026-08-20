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

printf '==> building image %s (context: %s)\n' "$IMAGE" "$REPO_ROOT"
podman build -f "$REPO_ROOT/e2e/Containerfile" -t "$IMAGE" "$REPO_ROOT"

printf '==> running scenario suite (all state stays inside the container)\n'
podman run --rm --name dsh-tui-e2e \
  -v "$REPO_ROOT/e2e:/e2e:ro" \
  "$IMAGE" \
  bash /e2e/scenarios/run-all.sh

printf '==> e2e finished OK\n'
