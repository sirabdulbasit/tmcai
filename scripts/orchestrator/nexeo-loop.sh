#!/usr/bin/env bash
#
# nexeo-loop.sh — the Claude ↔ Codex build/review orchestrator.
#
# Owner, 2026-08-11: *"build an orchestrator where both claude and codex will
# communicate with each other (in-session) and this iteration will keep going
# until Nexeo capability get 85+"*, then *"we need to achieve 95% of
# professional assistant in every aspect"*, and *"the entire loop will continue
# with[out] any intervention"*.
#
# ── THE CYCLE ───────────────────────────────────────────────────────────────
#
#   MEASURE ─┬─> gate passed?  ── yes ──> stop, report, notify
#            └─ no
#              BUILD   (claude, in-session)  reads review_log.md + fix queue,
#                                            changes code, updates build_log.md
#              MEASURE (benchmark)           the score the reviewer will see
#              REVIEW  (codex,  in-session)  reads build_log.md + the real diff
#                                            + the score, writes review_log.md
#              LEDGER  (this script)         appends the iteration, one row
#            └─> loop
#
# The two agents never talk directly. They talk THROUGH THE DOCS, and the
# orchestrator is the only thing that decides who runs next. That is deliberate:
# a doc-mediated handoff leaves a durable, auditable record of what each side
# claimed, which is exactly the property the three governing docs exist to
# provide (AGENTS.md, CLAUDE.md "Working protocol for Brain changes"). A direct
# pipe between two models would leave nothing behind.
#
# "In-session" is real, not simulated: Claude keeps ONE session across every
# iteration (--session-id then --resume), and Codex keeps ONE thread
# (codex exec then codex exec resume <id>). Each side therefore remembers what
# it tried three iterations ago and what the other side said about it.
#
# ── AUTONOMY, AND THE RAILS THAT MAKE IT SURVIVABLE ─────────────────────────
#
# The owner asked for no intervention, so nothing here blocks on a human. The
# rails are what stand in for one:
#
#   • tsc gate      — a build turn that leaves `tsc --noEmit` red is reported to
#                     the next build turn as its first job. The loop never
#                     stacks changes on a tree that does not compile.
#   • test gate     — vitest must stay green; a red suite is fed forward the
#                     same way.
#   • forbidden     — .env, tokens, whatsapp-sessions/, the owner-owned docs
#     paths           (AGENTS.md). Checked after EVERY build turn, because
#                     BLD-001 was exactly this and it reached production.
#   • stall         — no improvement in the MINIMUM criterion for
#                     $STALL_LIMIT iterations flips the next build prompt to
#                     "structural change required, patches are forbidden" —
#                     CLAUDE.md rule 5's circling verdict, automated.
#   • STOP file     — `touch server/docs/orchestrator/STOP` ends the loop
#                     cleanly after the current turn. No kill needed.
#   • no deploy     — by default this loop does NOT restart production. See
#                     NEXEO_DEPLOY below; the default is off on purpose.
#
# ── USAGE ───────────────────────────────────────────────────────────────────
#
#   # foreground, watch it work
#   scripts/orchestrator/nexeo-loop.sh
#
#   # unattended, survives logout
#   nohup scripts/orchestrator/nexeo-loop.sh > /tmp/nexeo-loop.out 2>&1 &
#
#   # stop it cleanly
#   touch server/docs/orchestrator/STOP
#
# Env:
#   NEXEO_TARGET=95        per-criterion floor AND overall floor
#   NEXEO_MAX_ITER=40      hard iteration cap (a runaway backstop, not a goal)
#   NEXEO_STALL_LIMIT=3    iterations without minimum improving → structural mode
#   NEXEO_DEPLOY=0         1 = build+restart pm2 after a PROGRESS iteration
#   NEXEO_SKIP_TESTS=0     1 = skip vitest between turns (faster, weaker rails)
#
set -uo pipefail

ROOT="/var/www/tmcai"
SRV="$ROOT/server"
ORCH="$SRV/docs/orchestrator"
STATE="$ORCH/state"
LOGS="$ORCH/logs"
SCORES="$ORCH/scores"
PROMPTS="$ROOT/scripts/orchestrator/prompts"

TARGET="${NEXEO_TARGET:-95}"
MAX_ITER="${NEXEO_MAX_ITER:-40}"
STALL_LIMIT="${NEXEO_STALL_LIMIT:-3}"
DEPLOY="${NEXEO_DEPLOY:-0}"
SKIP_TESTS="${NEXEO_SKIP_TESTS:-0}"

CLAUDE_BIN="${CLAUDE_BIN:-/root/.local/bin/claude}"
CODEX_BIN="${CODEX_BIN:-/usr/local/bin/codex}"

BUILD_DOC="$ORCH/build_log.md"
REVIEW_DOC="$ORCH/review_log.md"
LEDGER_MD="$ORCH/orchestrator_ledger.md"
LEDGER_JSONL="$ORCH/ledger.jsonl"
STOP_FILE="$ORCH/STOP"

mkdir -p "$STATE" "$LOGS" "$SCORES"

# ── logging ─────────────────────────────────────────────────────────────────
ts()  { date '+%Y-%m-%d %H:%M:%S %Z'; }
say() { printf '%s  %s\n' "$(ts)" "$*" | tee -a "$ORCH/loop.log"; }
die() { say "FATAL: $*"; exit 1; }

[ -x "$CLAUDE_BIN" ] || die "claude CLI not executable at $CLAUDE_BIN"
[ -x "$CODEX_BIN" ]  || die "codex CLI not executable at $CODEX_BIN"
[ -d "$PROMPTS" ]    || die "prompt directory missing: $PROMPTS"

# ── forbidden paths (AGENTS.md / CLAUDE.md "Never touch/commit") ────────────
# Matched against `git status --porcelain` and against each iteration's commits.
# BLD-001 (an owner-owned doc committed by a directory add, 2026-08-05) is why
# this is enforced by the harness and not left to the agent's care.
FORBIDDEN_RE='(^|/)\.env|whatsapp-sessions/|nexeo_self_learning&development\.md|tenant-scope-audit-2026-05-22\.md|tmcai-key\.json'

check_forbidden() {
  local iter="$1" base="$2" bad=""
  # working tree
  bad="$(cd "$ROOT" && git status --porcelain | awk '{print $2}' | grep -Ei "$FORBIDDEN_RE" || true)"
  # anything committed during this iteration
  local committed
  committed="$(cd "$ROOT" && git diff --name-only "$base" HEAD 2>/dev/null | grep -Ei "$FORBIDDEN_RE" || true)"
  if [ -n "$bad" ] || [ -n "$committed" ]; then
    say "CRITICAL iter=$iter forbidden path touched — tree:[${bad//$'\n'/ }] committed:[${committed//$'\n'/ }]"
    printf '%s\n' "FORBIDDEN PATH TOUCHED at iteration $iter — tree:[${bad//$'\n'/ }] committed:[${committed//$'\n'/ }]. Revert this before anything else." \
      > "$STATE/forbidden-alert"
    return 1
  fi
  rm -f "$STATE/forbidden-alert"
  return 0
}

# ── the score ───────────────────────────────────────────────────────────────
# Returns via globals: BENCH_OVERALL BENCH_MIN BENCH_WEAKEST BENCH_GATE
# BENCH_JSON. Exit-code contract of the harness: 0 pass, 2 below bar, 1 broken.
measure() {
  local iter="$1" label="$2"
  local json="$SCORES/iter-$(printf '%02d' "$iter")-$label.json"
  local log="$LOGS/iter-$(printf '%02d' "$iter")-bench-$label.log"

  say "MEASURE iter=$iter ($label) → $(basename "$json")"
  ( cd "$SRV" && node -r dotenv/config dist/scripts/nexeoCapabilityBenchmark.js \
      --target "$TARGET" --out "$json" ) > "$log" 2>&1
  local rc=$?

  local line
  line="$(grep -m1 '^BENCH_RESULT' "$log" || true)"
  if [ -z "$line" ]; then
    say "MEASURE iter=$iter FAILED rc=$rc — no BENCH_RESULT line; see $(basename "$log")"
    BENCH_OVERALL="null"; BENCH_MIN="null"; BENCH_WEAKEST="null"; BENCH_GATE="error"
    BENCH_JSON=""
    return 1
  fi
  BENCH_OVERALL="$(sed -E 's/.*overall=([^ ]+).*/\1/'  <<<"$line")"
  BENCH_MIN="$(sed -E     's/.*min=([^ ]+).*/\1/'      <<<"$line")"
  BENCH_WEAKEST="$(sed -E 's/.*weakest=([^ ]+).*/\1/'  <<<"$line")"
  BENCH_GATE="$(sed -E    's/.*gate=([^ ]+).*/\1/'     <<<"$line")"
  BENCH_JSON="$json"
  say "MEASURE iter=$iter overall=$BENCH_OVERALL min=$BENCH_MIN weakest=$BENCH_WEAKEST gate=$BENCH_GATE"
  grep -q 'mutated=true' <<<"$line" && say "WARNING iter=$iter benchmark MUTATED live data — see $(basename "$json")"
  return 0
}

# ── health rails ────────────────────────────────────────────────────────────
tsc_status() {
  ( cd "$SRV" && npx tsc --noEmit ) > "$LOGS/tsc.log" 2>&1 \
    && echo "clean" || echo "RED"
}

test_status() {
  [ "$SKIP_TESTS" = "1" ] && { echo "skipped"; return; }
  ( cd "$SRV" && npx vitest run --reporter=dot ) > "$LOGS/vitest.log" 2>&1
  local rc=$?
  local nums
  nums="$(grep -Eo '[0-9]+ (passed|failed)' "$LOGS/vitest.log" | tr '\n' ' ' | sed 's/ $//')"
  if [ $rc -eq 0 ]; then echo "green (${nums:-unknown})"; else echo "RED (${nums:-see vitest.log})"; fi
}

# ── prompt rendering ────────────────────────────────────────────────────────
# Placeholders are @@NAME@@ so nothing in the prose can be mistaken for one.
render() {
  local tmpl="$1"; shift
  local out; out="$(cat "$tmpl")"
  while [ $# -gt 1 ]; do
    local k="$1" v="$2"; shift 2
    out="${out//@@${k}@@/$v}"
  done
  printf '%s' "$out"
}

# ── the two agents ──────────────────────────────────────────────────────────
CLAUDE_SESSION_FILE="$STATE/claude-session-id"
CODEX_SESSION_FILE="$STATE/codex-session-id"

run_claude() {
  local iter="$1" prompt="$2"
  local log="$LOGS/iter-$(printf '%02d' "$iter")-build.log"
  local -a session_args

  if [ -s "$CLAUDE_SESSION_FILE" ]; then
    session_args=(--resume "$(cat "$CLAUDE_SESSION_FILE")")
    say "BUILD  iter=$iter claude resuming session $(cat "$CLAUDE_SESSION_FILE")"
  else
    local sid; sid="$(cat /proc/sys/kernel/random/uuid)"
    printf '%s' "$sid" > "$CLAUDE_SESSION_FILE"
    session_args=(--session-id "$sid")
    say "BUILD  iter=$iter claude opening session $sid"
  fi

  # IS_SANDBOX=1 is required: this box runs as root, and Claude Code refuses
  # --dangerously-skip-permissions under root without it. Verified 2026-08-11.
  # Without the flag a headless turn cannot answer a permission prompt, so every
  # tool call would be denied and the build turn would silently do nothing.
  printf '%s' "$prompt" | IS_SANDBOX=1 "$CLAUDE_BIN" -p \
    "${session_args[@]}" \
    --dangerously-skip-permissions \
    --add-dir "$ROOT" \
    > "$log" 2>&1
  local rc=$?
  say "BUILD  iter=$iter claude exit=$rc ($(wc -l < "$log") lines → $(basename "$log"))"
  # A dead session must not silently start a fresh one every iteration; that
  # would quietly destroy the "in-session" property the owner asked for.
  if [ $rc -ne 0 ] && grep -qiE 'no conversation found|session .* not found' "$log"; then
    say "BUILD  iter=$iter claude session lost — opening a NEW session next iteration"
    rm -f "$CLAUDE_SESSION_FILE"
  fi
  return $rc
}

# `codex exec` accepts -C/--cd; `codex exec resume` does NOT (verified against
# codex-cli 0.147.0 — it errors "unexpected argument '-C' found"). So the resume
# path takes its working directory from the shell, and every invocation is
# wrapped in a subshell that cd's to $ROOT rather than relying on the caller.
run_codex() {
  local iter="$1" prompt="$2"
  local log="$LOGS/iter-$(printf '%02d' "$iter")-review.log"
  local last="$LOGS/iter-$(printf '%02d' "$iter")-review-last.txt"
  local stored="" rc=0

  [ -s "$CODEX_SESSION_FILE" ] && stored="$(cat "$CODEX_SESSION_FILE")"

  if [ -z "$stored" ]; then
    say "REVIEW iter=$iter codex opening a new thread"
    ( cd "$ROOT" && "$CODEX_BIN" exec --json \
        --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
        -C "$ROOT" -o "$last" "$prompt" ) > "$log" 2>&1
    rc=$?
  elif [ "$stored" = "--last" ]; then
    say "REVIEW iter=$iter codex resuming --last (thread id was never captured)"
    ( cd "$ROOT" && "$CODEX_BIN" exec resume --last --json \
        --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
        -o "$last" "$prompt" ) > "$log" 2>&1
    rc=$?
  else
    say "REVIEW iter=$iter codex resuming thread $stored"
    ( cd "$ROOT" && "$CODEX_BIN" exec resume "$stored" --json \
        --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
        -o "$last" "$prompt" ) > "$log" 2>&1
    rc=$?
  fi

  # Capture the thread id from the first run so later iterations resume THIS
  # thread, not whatever else ran last in this directory. codex-cli 0.147.0
  # emits it as "thread_id"; the other two spellings are accepted in case a
  # future version renames it.
  if [ -z "$stored" ]; then
    local sid
    sid="$(grep -oE '"(session_id|thread_id|conversation_id)":"[0-9a-f-]{36}"' "$log" \
           | head -1 | grep -oE '[0-9a-f-]{36}' || true)"
    if [ -n "$sid" ]; then
      printf '%s' "$sid" > "$CODEX_SESSION_FILE"
      say "REVIEW iter=$iter codex thread id captured: $sid"
    else
      say "REVIEW iter=$iter WARNING thread id not captured — falling back to resume --last"
      printf '%s' "--last" > "$CODEX_SESSION_FILE"
    fi
  fi

  say "REVIEW iter=$iter codex exit=$rc ($(basename "$last"))"
  return $rc
}

# ── ledger ──────────────────────────────────────────────────────────────────
append_ledger() {
  local iter="$1" head="$2" overall="$3" min="$4" weakest="$5" gate="$6"
  local tsc="$7" tests="$8" mode="$9" note="${10}"

  printf '{"iteration":%d,"at":"%s","head":"%s","overall":%s,"min_criterion":%s,"weakest":"%s","gate":"%s","tsc":"%s","tests":"%s","mode":"%s","target":%s,"note":"%s"}\n' \
    "$iter" "$(date -Iseconds)" "$head" "$overall" "$min" "$weakest" "$gate" \
    "$tsc" "$tests" "$mode" "$TARGET" "$note" >> "$LEDGER_JSONL"

  printf '| %s | %s | `%s` | %s | %s (%s) | %s | %s | %s | %s |\n' \
    "$iter" "$(ts)" "$head" "$overall" "$min" "$weakest" "$gate" "$tsc" "$tests" "$note" \
    >> "$LEDGER_MD"
}

# ── seed the docs on first run ──────────────────────────────────────────────
[ -f "$LEDGER_MD" ] || cat > "$LEDGER_MD" <<EOF
# Orchestrator ledger — Claude ↔ Codex capability loop

Written by \`scripts/orchestrator/nexeo-loop.sh\`. One row per iteration. The
score is produced by \`dist/scripts/nexeoCapabilityBenchmark.js\`: **gate = every
criterion C1–C8 at or above the target, not the average.**

Target: **$TARGET** on every criterion. Baseline on 2026-08-11 before the loop
existed: live \`brain_response_evaluations\` averaged **80.1** over 76 turns.

| Iter | Finished (PKT) | HEAD | Overall | Min (criterion) | Gate | tsc | tests | Note |
|---|---|---|---|---|---|---|---|---|
EOF

[ -f "$BUILD_DOC" ] || cat > "$BUILD_DOC" <<'EOF'
# Build log — written by Claude, read by Codex

One `## Iteration N` section per build turn, appended, newest at the bottom.
Codex reviews these entries against the real diff, so a claim here that the diff
does not support is the single most useful thing for the reviewer to catch.

Required per iteration: what the fix queue said, what was changed and why, the
verification numbers (tsc / vitest, exact figures), what was NOT done, and the
honest expectation of which criterion should move.
EOF

[ -f "$REVIEW_DOC" ] || cat > "$REVIEW_DOC" <<'EOF'
# Review log — written by Codex, read by Claude

One `## Iteration N` section per review turn, appended, newest at the bottom.
The reviewer's job is not approval: it is to find the gap between what the build
log claims and what the diff does, and to name the next highest-value change.

Required per iteration: verdict (SOUND / WEAK / WRONG), each unsupported claim,
correctness and regression risks with file:line, and a ranked directive for the
next build turn.
EOF

# ── main ────────────────────────────────────────────────────────────────────
cd "$ROOT" || die "cannot cd $ROOT"

say "════════ orchestrator start · target $TARGET on every criterion · max $MAX_ITER iterations ════════"
say "deploy=$DEPLOY skip_tests=$SKIP_TESTS stall_limit=$STALL_LIMIT"

# Iteration counter survives a kill, so a restarted loop continues numbering.
ITER=0
[ -s "$STATE/iteration" ] && ITER="$(cat "$STATE/iteration")"

# Build once so the benchmark runs the CURRENT source, not a stale dist.
say "PREP   building dist so the benchmark measures current source"
( cd "$SRV" && npm run build ) > "$LOGS/prep-build.log" 2>&1 \
  || die "initial npm run build failed — see logs/prep-build.log"

if ! measure "$ITER" "baseline"; then
  die "baseline measurement failed — the loop has no metric; see logs/"
fi
BASELINE_OVERALL="$BENCH_OVERALL"
append_ledger "$ITER" "$(git rev-parse --short HEAD)" "$BENCH_OVERALL" "$BENCH_MIN" \
  "$BENCH_WEAKEST" "$BENCH_GATE" "$(tsc_status)" "skipped" "baseline" "baseline before any loop iteration"

BEST_MIN="${BENCH_MIN%%.*}"; [ -n "$BEST_MIN" ] || BEST_MIN=0
STALL=0

while :; do
  if [ -f "$STOP_FILE" ]; then
    say "STOP file present — ending cleanly at iteration $ITER"
    rm -f "$STOP_FILE"
    break
  fi
  if [ "$BENCH_GATE" = "pass" ]; then
    say "🎯 GATE PASSED — overall=$BENCH_OVERALL, every criterion >= $TARGET. Loop complete."
    break
  fi
  if [ "$ITER" -ge "$MAX_ITER" ]; then
    say "iteration cap $MAX_ITER reached without passing the gate — stopping (rail, not success)"
    break
  fi

  ITER=$((ITER + 1))
  printf '%s' "$ITER" > "$STATE/iteration"
  BASE_HEAD="$(git rev-parse HEAD)"
  say "──────── iteration $ITER ────────"

  TSC_BEFORE="$(tsc_status)"
  MODE="incremental"
  STRUCTURAL_NOTE="Not applicable — normal incremental improvement is fine this iteration."
  if [ "$STALL" -ge "$STALL_LIMIT" ]; then
    MODE="structural"
    STRUCTURAL_NOTE="STRUCTURAL MODE. The minimum criterion has not improved for $STALL iterations. Per CLAUDE.md rule 5 this is *circling*, and another patch on the reported instance is FORBIDDEN. Change the mechanism that keeps producing this class — decompose the path, unify the duplicated implementation, or move the decision to where the information actually is."
    say "STALL  $STALL iterations without improvement → structural mode"
  fi

  FORBIDDEN_ALERT="none"
  [ -s "$STATE/forbidden-alert" ] && FORBIDDEN_ALERT="$(cat "$STATE/forbidden-alert")"

  # ── BUILD ────────────────────────────────────────────────────────────────
  BUILD_PROMPT="$(render "$PROMPTS/build.md" \
    ITER "$ITER" TARGET "$TARGET" \
    OVERALL "$BENCH_OVERALL" MINSCORE "$BENCH_MIN" WEAKEST "$BENCH_WEAKEST" \
    SCOREJSON "${BENCH_JSON:-none}" \
    TSC "$TSC_BEFORE" TESTS "${TESTS_AFTER:-not yet run this session}" \
    MODE "$MODE" STRUCTURAL "$STRUCTURAL_NOTE" \
    FORBIDDEN "$FORBIDDEN_ALERT" \
    BUILDDOC "$BUILD_DOC" REVIEWDOC "$REVIEW_DOC" \
    BASELINE "$BASELINE_OVERALL")"
  run_claude "$ITER" "$BUILD_PROMPT" || say "BUILD  iter=$ITER claude returned non-zero — continuing, the rails below will judge the tree"

  check_forbidden "$ITER" "$BASE_HEAD" || true

  # ── rails, then re-measure ───────────────────────────────────────────────
  TSC_AFTER="$(tsc_status)"
  say "RAILS  iter=$ITER tsc=$TSC_AFTER"
  if [ "$TSC_AFTER" = "clean" ]; then
    ( cd "$SRV" && npm run build ) > "$LOGS/iter-$(printf '%02d' "$ITER")-npmbuild.log" 2>&1 \
      && say "RAILS  iter=$ITER npm run build ok" \
      || say "RAILS  iter=$ITER npm run build FAILED"
    TESTS_AFTER="$(test_status)"
    say "RAILS  iter=$ITER tests=$TESTS_AFTER"
    measure "$ITER" "post-build" || say "MEASURE iter=$ITER failed — reviewer will be told the score is missing"
  else
    TESTS_AFTER="not run (tsc red)"
    say "RAILS  iter=$ITER tsc RED — skipping build/tests/measure; the score stands from before"
  fi

  # ── REVIEW ───────────────────────────────────────────────────────────────
  DIFF_STAT="$(git diff --stat "$BASE_HEAD" HEAD 2>/dev/null | tail -25)"
  [ -z "$DIFF_STAT" ] && DIFF_STAT="$(git status --porcelain | head -25)"
  [ -z "$DIFF_STAT" ] && DIFF_STAT="(no changes detected this iteration — say so plainly in the review)"

  REVIEW_PROMPT="$(render "$PROMPTS/review.md" \
    ITER "$ITER" TARGET "$TARGET" \
    OVERALL "$BENCH_OVERALL" MINSCORE "$BENCH_MIN" WEAKEST "$BENCH_WEAKEST" \
    SCOREJSON "${BENCH_JSON:-none}" \
    TSC "$TSC_AFTER" TESTS "$TESTS_AFTER" \
    BASEHEAD "$(git rev-parse --short "$BASE_HEAD")" HEAD "$(git rev-parse --short HEAD)" \
    DIFFSTAT "$DIFF_STAT" \
    BUILDDOC "$BUILD_DOC" REVIEWDOC "$REVIEW_DOC")"
  run_codex "$ITER" "$REVIEW_PROMPT" || say "REVIEW iter=$ITER codex returned non-zero — continuing"

  check_forbidden "$ITER" "$BASE_HEAD" || true

  # ── stall accounting on the MINIMUM, which is what the gate reads ─────────
  CUR_MIN="${BENCH_MIN%%.*}"; [ -n "$CUR_MIN" ] || CUR_MIN=0
  if [ "$CUR_MIN" -gt "$BEST_MIN" ] 2>/dev/null; then
    say "PROGRESS min criterion $BEST_MIN → $CUR_MIN"
    BEST_MIN="$CUR_MIN"; STALL=0
    if [ "$DEPLOY" = "1" ] && [ "$TSC_AFTER" = "clean" ]; then
      say "DEPLOY iter=$ITER restarting tmcai-server (NEXEO_DEPLOY=1)"
      pm2 restart tmcai-server >> "$ORCH/loop.log" 2>&1 \
        && say "DEPLOY iter=$ITER pm2 restart ok" || say "DEPLOY iter=$ITER pm2 restart FAILED"
    fi
  else
    STALL=$((STALL + 1))
    say "NO IMPROVEMENT in the minimum criterion (still $BEST_MIN) — stall=$STALL/$STALL_LIMIT"
  fi

  append_ledger "$ITER" "$(git rev-parse --short HEAD)" "$BENCH_OVERALL" "$BENCH_MIN" \
    "$BENCH_WEAKEST" "$BENCH_GATE" "$TSC_AFTER" "$TESTS_AFTER" "$MODE" \
    "stall=$STALL$([ "$FORBIDDEN_ALERT" = "none" ] || echo ' FORBIDDEN-PATH-ALERT')"
done

say "════════ orchestrator finished · iterations=$ITER · overall=$BENCH_OVERALL min=$BENCH_MIN gate=$BENCH_GATE ════════"
say "ledger: $LEDGER_MD"
[ "$BENCH_GATE" = "pass" ] && exit 0 || exit 2
