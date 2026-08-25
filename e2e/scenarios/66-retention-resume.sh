#!/usr/bin/env bash
# Scenario 66 — retention janitor + /resume display filter + startup config
# summary. Four phases, each a fresh TUI launch then quit_tui:
#
#   A. retention age rule (MAX_AGE_DAYS=2) + startup summary line
#      (mcp/skills/plugins + a profile-root `tui` line under the banner)
#      + the janitor's result surfacing as a transient footer notice.
#   B. disable hatch — MAX_COUNT=0 (the explicit "off" knob) leaves an
#      already-aged session alive (janitor is fully disabled, not just
#      a partial no-op).
#   C. /resume filter defaults — a small stub is hidden by the byte floor,
#      a large enough session surfaces with its preview text and the
#      `Updated` / `Dir` column headers.
#   D. /resume empty-filtered notice — when sessions exist but the window
#      hides them all, the picker reports the explicit "adjust
#      dsh-tui.resume.*" hint instead of the plain "no other sessions"
#      empty-store copy.
set -u
. "$(dirname "$0")/../lib/common.sh"
scenario 'retention janitor + /resume display filter + startup summary'

# --- container-only guard ----------------------------------------------------
# The prep phase below wipes $HOME/.dsh/sessions with `rm -rf`. Inside the
# podman e2e container that path is the disposable fixture store, but on the
# host it is the user's REAL session library — never run this scenario
# outside the container.
if [ ! -d /e2e/scenarios ]; then
  warn 'not running inside the podman e2e container — skipping (prep would wipe $HOME/.dsh/sessions)'
  summary
  exit 0
fi

# --- in-script helper: write a single seeded session directory -----------------
# Layout matches dsh's session-persistence backend:
#   $HOME/.dsh/sessions/<project>/<id>/session.jsonl.zstd
#
# `<project>` is the path-ENCODED cwd (per dsh-session-persistence-jsonl
# `projectKey`): every `/` (and `\`, `:`) becomes `-`, leading `-` runs are
# stripped, and the result is wrapped in `--...--`. Inside the container the
# tmux start dir (-c /app) makes cwd=/app, so the project dir MUST be
# `--app--`. A literal `e2e-proj` would never be discovered by the janitor
# or the /resume walk. `<id>` must be a strict lowercase hex UUID
# (`encodeSegment` passes UUID chars through verbatim, but any non-hex
# character gets `~XXXX`-escaped and the on-disk name would no longer match
# the live id).
#
# The artifact is a real zstd-frame container produced by the actual
# `@deepseek-ai/dsh-session-persistence-jsonl` backend's `encodeMaterialization`
# (two checksummed frames: the header record and the event batch). Calling
# the real encoder — not hand-writing JSONL — is what `persistence.list()`
# expects: a one-line `parseHeaderMeta` over the first zstd frame feeds the
# picker, and the janitor / size floor read the on-disk file size from the
# `meta` revision. We construct a stripped instance via
# `Object.create(JsonlSessionPersistence.prototype)` with `packChunks:true,
# compression:"zstd"` so the real `encodeMaterialization` (which uses
# `this.packChunks` and `this.compression`) runs without spinning up a
# full cordis service. Filler rows use **unique** per-event random bytes
# (NOT a repeating pattern) — zstd crushes repetition, so a uniform pad
# would never reach the size floor no matter how many events we add; random
# bytes keep the on-disk zstd size near the JSONL body size. The pad loop
# is **bounded by the on-disk file size**: each iteration ENCODES + WRITES +
# STATS, and stops as soon as `stat().size >= targetBytes` (sessions.ts
# reads that stat, never the decompressed body). The final on-disk size
# is logged to stdout for the record.
seed_session() {
  local project="$1" id="$2" preview="$3" size_bytes="${4:-}"
  local dir="$HOME/.dsh/sessions/$project/$id"
  local out="$dir/session.jsonl.zstd"
  mkdir -p "$dir"
  local now_ms
  now_ms="$(date +%s)000"
  local target_bytes="${size_bytes:-0}"
  local final_size
  final_size="$(node --input-type=module - "$out" "$id" "$preview" "$now_ms" "$target_bytes" <<'NODE'
import { writeFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import JsonlSessionPersistence from "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js";

const [outPath, id, preview, nowMs, targetBytesStr] = process.argv.slice(2);
const targetBytes = Number(targetBytesStr) || 0;

const instance = Object.create(JsonlSessionPersistence.prototype);
instance.packChunks = true;
instance.compression = "zstd";

const meta = {
  type: "session",
  version: 0,
  id,
  createdAt: Number(nowMs),
  cwd: "/app",
  delegationDepth: 0,
};

const events = [
  {
    type: "user/message",
    seq: 0,
    time: Number(nowMs),
    // Two seed-boundary requirements from @deepseek-ai/dsh-session that
    // `list()` never exercises (it reads only the header frame) but
    // `inspect()` enforces via Session.fromRestore replay:
    //   1. surfaceOp — a user/message is surface-eligible and MUST carry the
    //      marker ("session event \"user/message\" is surface-eligible and
    //      requires a surfaceOp marker"); plain "append" is the transcript
    //      origin.
    //   2. message id — the data of a user/message IS the identified message;
    //      assertMessageEventShape rejects it without a non-empty string id
    //      ("session event at seq 0 lacks an identified message").
    surfaceOp: "append",
    data: {
      id: `${id}-m0`,
      content: [{ type: "text", text: preview }],
      source: { kind: "user" },
      role: "user",
    },
  },
];

// Pad with filler rows drawn from the real session-event vocabulary (members
// of KNOWN_SESSION_EVENT_TYPES — confirmed at source level). Random hex `pad`
// keeps the on-disk zstd from crushing below the byte floor. The filler
// rotation spans 4 distinct real event types; each event gets a strictly
// increasing time (+1ms per event) and a strictly sequential seq (the seed
// user/message keeps seq 0). Loop bounds: BATCH=16 events per iteration,
// MAX_ITER=10 iterations — even with very small per-event contributions the
// bounded loop lands the floor before the compression work becomes a wall-
// clock problem. Each iteration ENCODES AND WRITES, then stats the on-disk
// file: that stat is what `sessions.ts` reads (it never decompresses, so the
// on-disk number IS the number the minBytes floor judges).
const BATCH = 16;
const MAX_ITER = 10;
const FILLER_TYPES = [
  { type: "permission/preset", makeData: () => ({ preset: "danger-full-access", pad: randomBytes(350).toString("hex") }) },
  { type: "sandbox/mode",      makeData: () => ({ mode: "danger-full-access",    pad: randomBytes(350).toString("hex") }) },
  { type: "approval/policy",   makeData: () => ({ policy: "never",               pad: randomBytes(350).toString("hex") }) },
  { type: "turn/start",        makeData: (turn) => ({ turn,                     pad: randomBytes(350).toString("hex") }) },
];
let onDisk = 0;
if (targetBytes > 0) {
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const content = await instance.encodeMaterialization(meta, events);
    await writeFile(outPath, content);
    const info = await stat(outPath);
    onDisk = info.size;
    if (onDisk >= targetBytes) break;
    const startSeq = events.length;
    for (let i = 0; i < BATCH; i++) {
      const filler = FILLER_TYPES[i % FILLER_TYPES.length];
      const extra = filler.type === "turn/start" ? filler.makeData(Math.floor((startSeq + i) / FILLER_TYPES.length)) : filler.makeData();
      events.push({
        type: filler.type,
        seq: startSeq + i,
        time: Number(nowMs) + startSeq + i,
        data: extra,
      });
    }
  }
} else {
  const content = await instance.encodeMaterialization(meta, events);
  await writeFile(outPath, content);
  const info = await stat(outPath);
  onDisk = info.size;
}

process.stdout.write(String(onDisk));
NODE
)"
  info "seeded $id: ${final_size} bytes on disk"
}

# --- prep: clean any prior state on the test fixture paths ---------------------
rm -rf "$HOME/.dsh/sessions"
mkdir -p "$HOME/.dsh/sessions"

# =============================================================================
# Phase A — retention age rule + startup config summary
# =============================================================================
scenario 'Phase A: retention MAX_AGE_DAYS=2 + startup summary line'

# Seed 4 doomed-old session dirs (backdated mtime) and 1 fresh survivor.
# Distinct ids so the test is reproducible if the janitor reads them.
PROJ='--app--'
seed_session "$PROJ" a1e2f3a4-0001-4000-8000-00000000aa01 'old aaaa log' >/dev/null
seed_session "$PROJ" a1e2f3a4-0002-4000-8000-00000000aa02 'old bbbb log' >/dev/null
seed_session "$PROJ" a1e2f3a4-0003-4000-8000-00000000aa03 'old cccc log' >/dev/null
seed_session "$PROJ" a1e2f3a4-0004-4000-8000-00000000aa04 'old dddd log' >/dev/null
seed_session "$PROJ" a1e2f3a4-0005-4000-8000-00000000aa05 'fresh survivor' >/dev/null

# Backdate every artifact so the age rule's mtime test sees them as >2 days old.
BACKDATE_TS="$(date -d '-10 days' +%Y%m%d%H%M.%S)"
touch -t "$BACKDATE_TS" \
  "$HOME/.dsh/sessions/$PROJ/a1e2f3a4-0001-4000-8000-00000000aa01/session.jsonl.zstd" \
  "$HOME/.dsh/sessions/$PROJ/a1e2f3a4-0002-4000-8000-00000000aa02/session.jsonl.zstd" \
  "$HOME/.dsh/sessions/$PROJ/a1e2f3a4-0003-4000-8000-00000000aa03/session.jsonl.zstd" \
  "$HOME/.dsh/sessions/$PROJ/a1e2f3a4-0004-4000-8000-00000000aa04/session.jsonl.zstd"

# Edge fixtures: a flat file at the sessions root (must NOT be treated as a
# session) and an empty subdir inside the project bucket (must NOT be
# treated as a session).
touch "$HOME/.dsh/sessions/stray-flat.jsonl"
mkdir -p "$HOME/.dsh/sessions/$PROJ/empty-dir"

# Launch with the age rule active. MIN_IDLE_HOURS=0 disables the idle guard
# so a freshly-touched-but-backdated file is still age-eligible for removal.
start_tui 'DSH_TUI_RETENTION_MAX_AGE_DAYS=2 DSH_TUI_RETENTION_MIN_IDLE_HOURS=0'
wait_tui_up 120 || summary

# Retention is fire-and-forget at startup; give it a moment to settle before
# asserting on the filesystem. The janitor's pass is bounded by the file walk,
# which is fast in this fixture size.
sleep 3

if [[ -d "$HOME/.dsh/sessions/$PROJ/a1e2f3a4-0001-4000-8000-00000000aa01" ]]; then
  bad 'old-01 dir survived age rule (should be removed)'
else
  ok 'old-01 dir removed by age rule'
fi
if [[ -d "$HOME/.dsh/sessions/$PROJ/a1e2f3a4-0002-4000-8000-00000000aa02" ]]; then
  bad 'old-02 dir survived age rule (should be removed)'
else
  ok 'old-02 dir removed by age rule'
fi
if [[ -d "$HOME/.dsh/sessions/$PROJ/a1e2f3a4-0003-4000-8000-00000000aa03" ]]; then
  bad 'old-03 dir survived age rule (should be removed)'
else
  ok 'old-03 dir removed by age rule'
fi
if [[ -d "$HOME/.dsh/sessions/$PROJ/a1e2f3a4-0004-4000-8000-00000000aa04" ]]; then
  bad 'old-04 dir survived age rule (should be removed)'
else
  ok 'old-04 dir removed by age rule'
fi
if [[ -d "$HOME/.dsh/sessions/$PROJ/a1e2f3a4-0005-4000-8000-00000000aa05" ]]; then
  ok 'fresh-05 dir survives age rule (not backdated)'
else
  bad 'fresh-05 dir was wrongly removed'
fi
if [[ -f "$HOME/.dsh/sessions/stray-flat.jsonl" ]]; then
  ok 'flat file at sessions root survives (not a session dir)'
else
  bad 'flat file at sessions root was wrongly removed'
fi
if [[ -d "$HOME/.dsh/sessions/$PROJ/empty-dir" ]]; then
  ok 'empty subdir survives (no session.jsonl inside)'
else
  bad 'empty subdir was wrongly removed'
fi

# --- retention result notice: transient line above the footer -----------------
# The janitor no longer writes raw stderr; its result surfaces once as a
# muted notice above the footer that auto-dismisses after 8s
# (NOTICE_AUTO_DISMISS_MS in src/tui.ts). The pass settled during the sleep
# above, so capture NOW — inside the 8s window — before asserting.
PANE="$(capture)"
assert_contains 'retention result surfaces as a footer notice' \
  'Session retention: removed' "$PANE"
assert_not_contains 'old raw-stderr retention prefix never reaches the pane' \
  'dsh-tui-pi] session retention' "$PANE"

# --- startup summary line: mcp N · skills X/Y · plugins N, plus a `tui` row --
PANE="$(capture)"
assert_matches 'startup summary line shows mcp/skills/plugins counts' \
  'mcp [0-9]+ · skills [0-9]+/[0-9]+ · plugins [0-9]+' "$PANE"
# The profile name itself is a single line ("tui") directly under the banner.
# The banner Text adds paddingX=1, so the captured line carries a leading
# space — anchor on a leading-whitespace + exact "tui" word so a longer
# label like "tui-foo" does not spuriously match.
if printf '%s\n' "$PANE" | grep -qE '^[[:space:]]+tui([[:space:]]|$)'; then
  ok 'startup summary line shows the profile name (tui)'
else
  bad 'profile-name line "tui" missing from startup summary; pane tail:'
  printf '%s\n' "$PANE" | tail -10 | sed 's/^/    | /'
fi

quit_tui 'Phase A quit' || summary

# =============================================================================
# Phase B — disable hatch (MAX_COUNT=0 turns the janitor off)
# =============================================================================
scenario 'Phase B: retention MAX_COUNT=0 disables the janitor'

# Seed another doomed-old dir. With MAX_COUNT=0 the janitor is fully disabled
# so this dir must survive (it would be removed by the age rule from Phase A).
seed_session "$PROJ" a1e2f3a4-0006-4000-8000-00000000aa06 'doomed old log' >/dev/null
touch -t "$BACKDATE_TS" \
  "$HOME/.dsh/sessions/$PROJ/a1e2f3a4-0006-4000-8000-00000000aa06/session.jsonl.zstd"

# The test wants MAX_COUNT=0 to be the explicit "off" hatch. Set MIN_IDLE_HOURS
# to 0 too so the (theoretical) age-rule's idle guard does not gate us; the
# whole point of MAX_COUNT=0 is that none of the rules fire at all.
start_tui 'DSH_TUI_RETENTION_MAX_COUNT=0 DSH_TUI_RETENTION_MIN_IDLE_HOURS=0 DSH_TUI_RETENTION_MAX_AGE_DAYS=2'
wait_tui_up 120 || summary

# Give the (disabled) fire-and-forget pass the same time window it would have
# used if it had been enabled. A passing test means the file is still there.
sleep 3

if [[ -d "$HOME/.dsh/sessions/$PROJ/a1e2f3a4-0006-4000-8000-00000000aa06" ]]; then
  ok 'doomed-06 dir survives when MAX_COUNT=0 (janitor disabled)'
else
  bad 'doomed-06 dir was removed even with MAX_COUNT=0 (hatch failed)'
fi

quit_tui 'Phase B quit' || summary

# =============================================================================
# Phase C — /resume display filter defaults
# =============================================================================
scenario 'Phase C: /resume surfaces the large session and hides the stub'

# Reset the store so Phase C's filter test is independent of the previous
# janitor state. Seed two sessions under the path-encoded project dir:
#   - alpha  : preview "resume-row-alpha hello world", padded to ≥25KB
#   - stub   : preview "stub tiny log", ~200B (well below the default 20KB floor)
rm -rf "$HOME/.dsh/sessions"
mkdir -p "$HOME/.dsh/sessions"
PROJ='--app--'
seed_session "$PROJ" \
  a1e2f3a4-0007-4000-8000-00000000aa07 \
  'resume-row-alpha hello world' 25000
seed_session "$PROJ" \
  a1e2f3a4-0008-4000-8000-00000000aa08 \
  'stub tiny log'

# Belt-and-braces evidence for the seeded byte sizes: the floor hides alpha
# if the on-disk zstd is below 20480B (sessions.ts reads stat().size, never
# the decompressed body). ls -la into stdout so any future debug session
# has the ground truth without re-running the seeder.
ls -la \
  "$HOME/.dsh/sessions/$PROJ/a1e2f3a4-0007-4000-8000-00000000aa07/session.jsonl.zstd" \
  "$HOME/.dsh/sessions/$PROJ/a1e2f3a4-0008-4000-8000-00000000aa08/session.jsonl.zstd"

# Plain launch — no retention/resume env. The picker's defaults (7d / 20KB)
# must drop stub (size) and keep alpha.
start_tui ''
wait_tui_up 120 || summary

ensure_editor_ready 'editor focused before /resume' || true
send '/resume' Enter
wait_pane '/resume picker opens' 15 '● Resume session'
PANE="$(capture)"
assert_contains 'picker shows the large session (alpha) row' \
  'resume-row-alpha' "$PANE"
assert_not_contains 'picker hides the stub (size filter)' \
  'stub tiny log' "$PANE"
assert_contains 'picker renders the Updated column header' 'UPDATED' "$PANE"
assert_contains 'picker renders the Dir column header' 'DIR' "$PANE"

esc_until_gone '/resume picker closes on Esc' 'Resume session'
quit_tui 'Phase C quit' || summary

# =============================================================================
# Phase D — empty-filtered notice (sessions exist, window hides them all)
# =============================================================================
scenario 'Phase D: empty-filtered notice vs. plain empty-store copy'

# Same store from Phase C — alpha is large, stub is tiny. With minBytes set
# astronomically high, BOTH get filtered out, so the picker resolves the
# `empty-filtered` branch (not the plain `empty` branch).
start_tui 'DSH_TUI_RESUME_MIN_BYTES=999999999'
wait_tui_up 120 || summary

ensure_editor_ready 'editor focused before /resume (minBytes floor)' || true
send '/resume' Enter
# The empty-filtered notice is a short error text — it may render in the
# picker's empty-state slot OR in the command's error toast, depending on
# the flow. Either way the substring must reach the pane.
wait_pane 'empty-filtered notice appears' 15 'No sessions within the resume window'

PANE="$(capture)"
assert_contains 'empty-filtered notice names the resume window' \
  'No sessions within the resume window' "$PANE"
assert_contains 'empty-filtered notice points at the dsh-tui.resume.* knobs' \
  'adjust dsh-tui.resume.*' "$PANE"
assert_not_contains 'alpha row must not appear under the high minBytes floor' \
  'resume-row-alpha' "$PANE"
assert_not_contains 'must NOT report the plain empty-store copy' \
  'No other persisted sessions to resume.' "$PANE"

esc_until_gone '/resume picker closes on Esc' 'Resume session'
quit_tui 'Phase D quit' || summary

summary
exit 0
