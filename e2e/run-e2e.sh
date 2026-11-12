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

# The fresh-machine onboarding scenario (80 pass B) installs the dsh host
# with npm inside this VM. The 0.2.2-rc.2 closure needs more install-time
# memory than a 2 GiB machine has: npm is SIGKILLed by the kernel OOM killer
# (exit 137) where the rc.1 closure installed fine. Read-only warning —
# raising the machine's memory is a host decision, not something the suite
# should do silently.
VM_MEM="$(podman machine inspect --format '{{.Resources.Memory}}' 2>/dev/null | head -1)"
if [ -n "$VM_MEM" ] && [ "$VM_MEM" -gt 0 ] 2>/dev/null && [ "$VM_MEM" -lt 4096 ]; then
  printf '==> warning: podman machine has %s MiB — 80-onboard pass B (npm install -g of the dsh host) OOMs below ~4 GiB on the 0.2.2-rc.2 closure; expect a SIGKILL/137 there unless the machine memory is raised\n' "$VM_MEM"
fi

# The mirror defaults (DaoCloud base image, npmmirror node dist) are baked
# into e2e/Containerfile on this repo, so the only build arg to forward is
# the resolved dsh version.
BUILD_ARGS=(--build-arg DSH_VERSION="$DSH_VERSION")

printf '==> building image %s (context: %s)\n' "$IMAGE" "$REPO_ROOT"
podman build -f "$REPO_ROOT/e2e/Containerfile" -t "$IMAGE" "${BUILD_ARGS[@]}" "$REPO_ROOT"

# Vendor the sibling dsh-subagent-registry build when one sits next to this
# checkout. The npm releases lag the host waves: 0.18.0 (rc.1 wave) died at
# load — it statically imports CodeRunFailedError from @deepseek-ai/dsh-tools,
# an export the 0.2.2-rc.1 host moved to @deepseek-ai/dsh-tool-executor-ptc —
# and 0.19.0/0.19.1 (tagged before the rc.2 adaptation commit) still read the
# PRE-rc.2 subagent seams, so on an 0.2.2-rc.2 host every scenario that
# dispatches through use_agent (75/76, plus 77's readiness probe) breaks
# SILENTLY: the child never surfaces on the live board, the Ctrl+G picker
# never opens, the mock jev records zero dispatches. The adapted source lives
# in the sibling repo; packing it here lets the scenarios run against the fix
# while npm still carries the stale builds. The tarball reaches the container
# through the /e2e bind mount; scenarios fall back to the npm pin when
# nothing is vendored (fresh clone, CI, or a stale sibling).
#
# The packed version is bumped one patch past the sibling's manifest before
# repacking: scenario 10's tui-pi install already pulls the published copy
# into the profile (tui-pi depends on ^0.18.0), and pnpm's hoisted install
# keeps the existing copy when a tarball declares the SAME name+version —
# the plugin-add'd file: dependency would be recorded in the profile
# package.json while node_modules keeps the broken npm content (observed in
# the container). A distinct version forces the hoisted root slot to
# materialize the vendored build.
VENDOR_DIR="$REPO_ROOT/e2e/vendor"
REGISTRY_SRC="${E2E_REGISTRY_SRC:-$REPO_ROOT/../dsh-subagent-registry}"
if [ -d "$REGISTRY_SRC/lib" ] && [ -f "$REGISTRY_SRC/package.json" ]; then
  mkdir -p "$VENDOR_DIR"
  rm -f "$VENDOR_DIR"/aiwayds-dsh-subagent-registry-*.tgz
  PACK_TMP="$(mktemp -d)"
  if (cd "$REGISTRY_SRC" && npm pack --pack-destination "$PACK_TMP" >/dev/null 2>&1) \
    && RAW_TGZ="$(ls "$PACK_TMP"/aiwayds-dsh-subagent-registry-*.tgz 2>/dev/null | head -1)" \
    && [ -n "$RAW_TGZ" ] \
    && tar xzf "$RAW_TGZ" -C "$PACK_TMP" \
    && BUMPED="$(node -e '
        const fs = require("fs")
        const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
        const m = manifest.version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/)
        if (!m) { console.error("unbumpable version: " + manifest.version); process.exit(1) }
        manifest.version = m[1] + "." + m[2] + "." + (Number(m[3]) + 1) + m[4]
        fs.writeFileSync(process.argv[1], JSON.stringify(manifest, null, 2) + "\n")
        console.log(manifest.version)
      ' "$PACK_TMP/package/package.json")" \
    && tar czf "$VENDOR_DIR/aiwayds-dsh-subagent-registry-$BUMPED.tgz" -C "$PACK_TMP" package; then
    REG_TGZ="$VENDOR_DIR/aiwayds-dsh-subagent-registry-$BUMPED.tgz"
    # Staleness probes — a stale vendored build would fail the scenarios
    # exactly like the npm copies, so refuse to vendor it:
    #   rc.1 wave: a build that still imports the moved symbol dies at load.
    #   rc.2 wave: a build without the waitForTreeWork runtime probe
    #     (lib/host-compat.js) reads the pre-rc.2 child seams and breaks the
    #     use_agent chain silently on an 0.2.2-rc.2 host.
    if tar xzOf "$REG_TGZ" package/lib/ptc/runner.js 2>/dev/null \
      | grep -q "import { CodeRunFailedError"; then
      rm -f "$REG_TGZ"
      printf '==> vendored registry build is stale (still imports the moved CodeRunFailedError) — scenarios fall back to the npm pin\n'
    elif ! tar xzOf "$REG_TGZ" package/lib/host-compat.js 2>/dev/null \
      | grep -q "waitForTreeWork"; then
      rm -f "$REG_TGZ"
      printf '==> vendored registry build is stale (predates the 0.2.2-rc.2 host wave: no waitForTreeWork probe) — scenarios fall back to the npm pin\n'
    else
      printf '==> vendored registry build: %s (sibling %s, version bumped past the stale npm copy)\n' "$(basename "$REG_TGZ")" "$REGISTRY_SRC"
    fi
  else
    printf '==> sibling registry pack failed — scenarios fall back to the npm pin\n'
  fi
  rm -rf "$PACK_TMP"
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
