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

# The guard's outputs, declared HERE rather than only inside measure_collect.
#
# Iteration 22 died three seconds into its build with "Provide a prompt to continue
# the conversation", because MEASURE was skipped that turn (no server/src change),
# so measure_collect never ran, so GUARD_TXT was unset — and under `set -u` the
# render call that referenced it aborted, leaving BUILD_PROMPT empty. The Builder
# was handed nothing at all.
#
# A variable that only exists on the happy path is a variable that will be unset on
# the day it matters, and the skip path is not rare: it fires on every iteration
# that follows a docs-only or orchestrator-only commit.
GUARD_STATUS="not-run"
GUARD_TXT="The regression guard has not run yet for this iteration (the benchmark was reused, so there is no new measurement to judge)."
MAX_ITER="${NEXEO_MAX_ITER:-40}"
STALL_LIMIT="${NEXEO_STALL_LIMIT:-3}"
DEPLOY="${NEXEO_DEPLOY:-0}"
SKIP_TESTS="${NEXEO_SKIP_TESTS:-0}"

CLAUDE_BIN="${CLAUDE_BIN:-/root/.local/bin/claude}"
CODEX_BIN="${CODEX_BIN:-/usr/local/bin/codex}"

BUILD_DOC="$ORCH/build_log.md"
REVIEW_DOC="$ORCH/review_log.md"
# The owner's / orchestrator's channel INTO the loop. Written outside the loop,
# read by every build turn. The orchestrator never writes to build_log.md or
# review_log.md — a bridge that speaks in either agent's name destroys the record
# of who actually claimed what.
DIRECTIVES_DOC="$ORCH/operator_directives.md"
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
#
# Owner, 2026-08-12: *"where every both agent (brain and codex) will [run]
# immediately after each other"*.
#
# Measured timings: Builder ~12 min, Codex ~86 s, measurement ~5 min. So the gap
# between the two seats WAS the measurement. It is now split in two — started
# after the build turn, COLLECTED after the review — so the reviewer begins the
# moment the builder stops and the score is computed alongside it instead of
# in front of it.
#
# What this costs, stated plainly: Codex no longer has THIS iteration's score
# while reviewing. Its strongest iteration-1 finding cited post-build case text
# (B07/B08/B10/B11 still opening with "Sir,") to prove a bypass, and it cannot do
# that against a score that does not exist yet. Running the two in parallel does
# not recover it either — Codex finishes in 86 s, the score takes 300 s, so it
# would never see it whatever the arrangement. The real fix is a FASTER
# measurement (parallelise the 12 cases → ~1 min), which lives in the benchmark
# and is therefore the Builder's, filed as a directive. Until then the reviewer
# gets the PREVIOUS score, told plainly that it is the previous one.
measure_start() {
  local iter="$1" label="$2"
  BENCH_JSON_PENDING="$SCORES/iter-$(printf '%02d' "$iter")-$label.json"
  BENCH_LOG_PENDING="$LOGS/iter-$(printf '%02d' "$iter")-bench-$label.log"
  say "MEASURE iter=$iter ($label) started in background → $(basename "$BENCH_JSON_PENDING")"
  ( cd "$SRV" && node -r dotenv/config dist/scripts/nexeoCapabilityBenchmark.js \
      --target "$TARGET" --out "$BENCH_JSON_PENDING" ) > "$BENCH_LOG_PENDING" 2>&1 &
  BENCH_PID=$!
}

measure_collect() {
  local iter="$1"
  [ -z "${BENCH_PID:-}" ] && { say "MEASURE iter=$iter nothing pending to collect"; return 1; }
  wait "$BENCH_PID"; local rc=$?
  BENCH_PID=""

  local line
  line="$(grep -m1 '^BENCH_RESULT' "$BENCH_LOG_PENDING" || true)"
  if [ -z "$line" ]; then
    # A missing score is never silently inherited from the previous iteration:
    # the loop would then steer on a stale number and call it current.
    say "MEASURE iter=$iter FAILED rc=$rc — no BENCH_RESULT line; see $(basename "$BENCH_LOG_PENDING")"
    BENCH_OVERALL="null"; BENCH_MIN="null"; BENCH_WEAKEST="null"; BENCH_GATE="error"
    BENCH_JSON=""
    return 1
  fi
  BENCH_OVERALL="$(sed -E 's/.*overall=([^ ]+).*/\1/'  <<<"$line")"
  BENCH_MIN="$(sed -E     's/.*min=([^ ]+).*/\1/'      <<<"$line")"
  BENCH_WEAKEST="$(sed -E 's/.*weakest=([^ ]+).*/\1/'  <<<"$line")"
  BENCH_GATE="$(sed -E    's/.*gate=([^ ]+).*/\1/'     <<<"$line")"
  BENCH_JSON="$BENCH_JSON_PENDING"
  say "MEASURE iter=$iter overall=$BENCH_OVERALL min=$BENCH_MIN weakest=$BENCH_WEAKEST gate=$BENCH_GATE"

  # THE GUARD, not the gate. Owner ruling 2026-08-13: capabilities drive, the
  # benchmark guards. min(C1..C8) >= 95 was unreachable — C4 awarded >=95 in 4% of
  # 228 scorings and nine of twelve cases never reached it once — so the benchmark
  # now answers the one question it can answer honestly: did a case get WORSE?
  GUARD_STATUS="not-run"; GUARD_TXT="The regression guard did not run this iteration."
  if [ -x "$ROOT/scripts/orchestrator/regression-guard.py" ] && [ -s "$BENCH_JSON" ]; then
    GUARD_OUT="$LOGS/iter-$iter-guard.json"
    if python3 "$ROOT/scripts/orchestrator/regression-guard.py" \
         "$ORCH/scores" "$BENCH_JSON" > "$GUARD_OUT" 2>&1; then
      GUARD_STATUS="clean"
      GUARD_TXT="Regression guard CLEAN — no case fell more than the calibrated band below its recent median."
    else
      GUARD_STATUS="regressed"
      GUARD_TXT="$(python3 - "$GUARD_OUT" <<'PYEOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("Regression guard reported a failure its output could not be parsed from."); raise SystemExit
lines = ["REGRESSION GUARD FIRED. Fix these before new work — a case that got worse is",
         "a regression whatever else the turn achieved.", ""]
for r in d.get("regressions", [])[:8]:
    lines.append(f"  {r['case']} {r['criterion']}: {r['baseline']} -> {r['now']} (down {r['drop']})")
    if r.get("reason"):
        lines.append(f"      judge: {r['reason'][:150]}")
for r in d.get("cases_down", [])[:6]:
    lines.append(f"  {r['case']} MEAN across criteria: {r['baseline']} -> {r['now']} (down {r['drop']})")
print("\n".join(lines))
PYEOF
)"
    fi
    say "GUARD  iter=$iter $GUARD_STATUS"
  fi
  grep -q 'mutated=true' <<<"$line" && say "WARNING iter=$iter benchmark MUTATED live data — see $(basename "$BENCH_JSON")"
  # Remember WHAT was measured, so a restart can tell whether re-measuring would
  # produce new information or just reprint the same number at cost.
  printf 'head=%s overall=%s min=%s weakest=%s gate=%s json=%s\n' \
    "$(git -C "$ROOT" rev-parse HEAD)" "$BENCH_OVERALL" "$BENCH_MIN" \
    "$BENCH_WEAKEST" "$BENCH_GATE" "$BENCH_JSON" > "$STATE/last-measure"
  return 0
}

# Blocking form, for the startup baseline where there is nothing to overlap with.
measure() {
  measure_start "$1" "$2"
  measure_collect "$1"
}

# ── health rails ────────────────────────────────────────────────────────────
tsc_status() {
  ( cd "$SRV" && npx tsc --noEmit ) > "$LOGS/tsc.log" 2>&1 \
    && echo "clean" || echo "RED"
}

# G24 — the rail is non-deterministic. On ONE unchanged commit it read GREEN
# (2053 passed) while Codex and the orchestrator both read RED (8 failed), and the
# failing file passed 19/19 alone: cross-file pollution. So a single green sample
# proves nothing. Two samples are taken and BOTH must be green; a disagreement is
# reported as DISAGREE, never smoothed into green. This is not retry-until-green —
# that would convert a real red into a reported green, which is the failure this
# project has a whole chart section about.
test_status() {
  [ "$SKIP_TESTS" = "1" ] && { echo "skipped"; return; }
  ( cd "$SRV" && npx vitest run --reporter=dot ) > "$LOGS/vitest.log" 2>&1
  local rc=$?
  local rc2=0
  if [ $rc -eq 0 ]; then
    ( cd "$SRV" && npx vitest run --reporter=dot ) > "$LOGS/vitest-2.log" 2>&1
    rc2=$?
    if [ $rc2 -ne 0 ]; then
      local n2; n2="$(grep -Eo '[0-9]+ failed' "$LOGS/vitest-2.log" | head -1)"
      echo "DISAGREE (run1 green, run2 ${n2:-red}) — flaky suite, see D-8"
      return
    fi
  fi
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
    # A key with no placeholder in the template is DROPPED SILENTLY, which is how I
    # nearly shipped a re-scope instruction the Builder would never have seen. I had
    # already had the same class of failure this morning — the remediation rail
    # firing while I could not evidence that the prompt carried it — so this says so
    # rather than leaving it to be discovered by its absence.
    case "$out" in
      *"@@${k}@@"*) : ;;
      *) printf '%s WARN render: key %s has no @@%s@@ placeholder in %s — value DROPPED\n' \
           "$(date -u '+%F %T UTC')" "$k" "$k" "$(basename "$tmpl")" >&2 ;;
    esac
    out="${out//@@${k}@@/$v}"
  done
  printf '%s' "$out"
}

# ── the two agents ──────────────────────────────────────────────────────────
CODEX_SESSION_FILE="$STATE/codex-session-id"

# ── the Builder seat ────────────────────────────────────────────────────────
# Owner, 2026-08-11: *"u create new claude session name it 'Brain Builder'"* and
# *"always use that session"*, after *"i am unable to see it running in session"*.
#
# The loop used to mint a random uuid, so the build session appeared in the
# session list under an auto-derived name (`tmcai-dd`). The owner looked for a
# named session, found none, and reasonably concluded nothing was running — while
# a build turn was twelve minutes in. Two fixes, both here:
#
#   1. `--name "$BUILDER_NAME"` on every invocation, so the seat is findable by
#      the name a human chose rather than a hash.
#   2. The id is PERSISTED and resumed. A name is only visible while a session is
#      LIVE (`claude agents --json` lists running sessions only), so name lookup
#      alone would fail the moment the session idled — and the loop would quietly
#      open a fresh session each iteration, destroying the in-session property
#      that is the whole point. The name is the handle for humans; the persisted
#      id is the handle for the loop.
BUILDER_NAME="${NEXEO_BUILDER_NAME:-Brain Builder}"
BUILDER_SESSION_FILE="$STATE/builder-session-id"
RESOLVER="$ROOT/scripts/orchestrator/resolve-session.sh"
FORMATTER="$ROOT/scripts/orchestrator/format-stream.py"

builder_session_id() {
  # 1. already persisted — the normal path
  if [ -s "$BUILDER_SESSION_FILE" ]; then
    cat "$BUILDER_SESSION_FILE"; return 0
  fi
  # 2. a live session already wears the name (e.g. the owner made it by hand)
  local found=""
  [ -x "$RESOLVER" ] && found="$("$RESOLVER" "$BUILDER_NAME" --cwd "$ROOT" 2>/dev/null || true)"
  if [ -n "$found" ]; then
    printf '%s' "$found" > "$BUILDER_SESSION_FILE"
    say "BUILD  adopted existing \"$BUILDER_NAME\" session $found"
    printf '%s' "$found"; return 0
  fi
  # 3. none exists — create one and record it, so it is the same seat forever
  local sid; sid="$(cat /proc/sys/kernel/random/uuid)"
  printf '%s' "$sid" > "$BUILDER_SESSION_FILE"
  say "BUILD  no \"$BUILDER_NAME\" session found — creating $sid"
  printf '%s' "$sid"
}

run_claude() {
  local iter="$1" prompt="$2"
  local n; n="$(printf '%02d' "$iter")"
  local log="$LOGS/iter-$n-build.log"       # readable, live
  local raw="$LOGS/iter-$n-build.jsonl"     # raw events, the evidence
  local sid; sid="$(builder_session_id)"
  local -a session_args

  # `--resume` on a session with no transcript yet fails, so the FIRST turn
  # opens it with --session-id and every later turn resumes it.
  if [ -f "/root/.claude/projects/-var-www-tmcai/$sid.jsonl" ]; then
    session_args=(--resume "$sid")
    say "BUILD  iter=$iter resuming \"$BUILDER_NAME\" ($sid)"
  else
    session_args=(--session-id "$sid")
    say "BUILD  iter=$iter opening \"$BUILDER_NAME\" ($sid)"
  fi

  # `--output-format stream-json --verbose` is what makes the turn WATCHABLE.
  # Without it `claude -p` buffers the whole turn and flushes at the end: the log
  # sat at 0 bytes for twelve minutes, so a working loop was indistinguishable
  # from a hung one. Raw events are tee'd for evidence; the formatter renders a
  # live line per event. `tail -f` either file to watch the Builder work.
  #
  # IS_SANDBOX=1 is required: this box runs as root, and Claude Code refuses
  # --dangerously-skip-permissions under root without it. Verified 2026-08-11.
  # Without it a headless turn cannot answer a permission prompt, so every tool
  # call would be denied and the build turn would silently do nothing.
  # Owner ruling, 2026-08-13: *"use model fable5 while building"*. The seat had no
  # --model flag at all, so it inherited the CLI default and every build turn ran on
  # claude-opus-5[1m] — visible in the stream header, never chosen. Validated before
  # staging rather than after, because a model string the CLI cannot resolve would
  # kill every build turn silently:
  #
  #   claude -p --model fable --output-format json "Reply with exactly: OK"
  #   → modelUsage keys: ['claude-haiku-4-5-20251001', 'claude-fable-5']
  #
  # The alias resolves to claude-fable-5 (haiku is the CLI's own auxiliary model).
  # REVIEWER and SCORER seats are unchanged — the ruling is about building.
  printf '%s' "$prompt" | IS_SANDBOX=1 "$CLAUDE_BIN" -p \
    "${session_args[@]}" \
    --name "$BUILDER_NAME" \
    --model fable \
    --output-format stream-json --verbose \
    --dangerously-skip-permissions \
    --add-dir "$ROOT" 2>&1 \
    | tee "$raw" \
    | python3 "$FORMATTER" --prefix \
    | tee -a "$log" \
    | sed -u 's/^/BUILD  │ /'
  # claude's status, NOT tee's or python's — a formatter exiting 0 must never
  # launder a failed build turn into a success.
  local rc=${PIPESTATUS[1]}

  say "BUILD  iter=$iter claude exit=$rc ($(wc -l < "$log" 2>/dev/null || echo 0) lines → $(basename "$log"))"
  # A dead session must not silently start a fresh one every iteration; that
  # would quietly destroy the "in-session" property the owner asked for.
  if [ "$rc" -ne 0 ] && grep -qiE 'no conversation found|session .* not found' "$raw" 2>/dev/null; then
    say "BUILD  iter=$iter session $sid is GONE — clearing so a new seat is opened next iteration"
    rm -f "$BUILDER_SESSION_FILE"
  fi
  return "$rc"
}

# `codex exec` accepts -C/--cd; `codex exec resume` does NOT (verified against
# codex-cli 0.147.0 — it errors "unexpected argument '-C' found"). So the resume
# path takes its working directory from the shell, and every invocation is
# wrapped in a subshell that cd's to $ROOT rather than relying on the caller.
run_codex() {
  local iter="$1" prompt="$2"
  local n; n="$(printf '%02d' "$iter")"
  local log="$LOGS/iter-$n-review.log"       # readable, live
  local raw="$LOGS/iter-$n-review.jsonl"     # raw events, the evidence
  local last="$LOGS/iter-$n-review-last.txt"
  local stored="" rc=0
  local -a cmd

  [ -s "$CODEX_SESSION_FILE" ] && stored="$(cat "$CODEX_SESSION_FILE")"

  # Built once, run once. The three branches used to duplicate the invocation,
  # which is how a flag gets fixed on two paths and forgotten on the third.
  if [ -z "$stored" ]; then
    say "REVIEW iter=$iter codex opening a new thread"
    cmd=("$CODEX_BIN" exec --json --dangerously-bypass-approvals-and-sandbox
         --skip-git-repo-check -C "$ROOT" -o "$last" "$prompt")
  elif [ "$stored" = "--last" ]; then
    say "REVIEW iter=$iter codex resuming --last (thread id was never captured)"
    cmd=("$CODEX_BIN" exec resume --last --json
         --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check
         -o "$last" "$prompt")
  else
    say "REVIEW iter=$iter codex resuming thread $stored"
    cmd=("$CODEX_BIN" exec resume "$stored" --json
         --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check
         -o "$last" "$prompt")
  fi

  # Owner, 2026-08-11: *"i want to see both's activities in-session"*. The
  # reviewer streams exactly like the builder — raw events tee'd as evidence, one
  # readable line per event rendered live. The formatter speaks both dialects, so
  # watching Codex reads the same as watching the Builder.
  ( cd "$ROOT" && "${cmd[@]}" 2>&1 ) \
    | tee "$raw" \
    | python3 "$FORMATTER" --prefix \
    | tee -a "$log" \
    | sed -u 's/^/REVIEW │ /'
  # codex's status, NOT tee's or the formatter's.
  rc=${PIPESTATUS[0]}

  # Capture the thread id from the first run so later iterations resume THIS
  # thread, not whatever else ran last in this directory. codex-cli 0.147.0
  # emits it as "thread_id"; the other two spellings are accepted in case a
  # future version renames it.
  if [ -z "$stored" ]; then
    local sid
    # Read the RAW event stream, not the formatted log. Once the output started
    # going through the formatter, `"thread_id":"…"` no longer appears in $log —
    # the id would never be captured, the loop would fall back to `resume --last`,
    # and the in-session property would decay silently with a WARNING nobody
    # reads. The formatted line is accepted as a second source.
    sid="$(grep -oE '"(session_id|thread_id|conversation_id)":"[0-9a-f-]{36}"' "$raw" 2>/dev/null \
           | head -1 | grep -oE '[0-9a-f-]{36}' || true)"
    [ -z "$sid" ] && sid="$(grep -oE 'codex thread [0-9a-f-]{36}' "$log" 2>/dev/null \
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

# Owner, 2026-08-12, on the 6-minute startup wait: *"why not immediately?"*
#
# Because the measurement is 12 real conversations — each a live compose plus a
# live judge call — not a cached number. But re-measuring is only INFORMATIVE when
# Brain could actually behave differently. The benchmark exercises `answerAsBrain`
# and the judge; nothing under scripts/ or docs/ can change what it reads. So if
# no file that Brain's behaviour depends on has changed since the last successful
# measurement, the previous score is reused and the ledger SAYS it was reused
# rather than measured. A ledger row that cannot be told apart from a fresh
# measurement is worse than a slow loop.
#
# Deliberately conservative: any change under server/src or server/prisma counts,
# even one that plainly cannot matter. Guessing which source changes are
# behaviour-neutral is how a real regression gets skipped.
REUSED_SCORE=0
if [ -s "$STATE/last-measure" ]; then
  # shellcheck disable=SC2046
  LAST_HEAD="$(sed -E 's/.*head=([0-9a-f]+).*/\1/' "$STATE/last-measure")"
  if [ -n "$LAST_HEAD" ] && git -C "$ROOT" cat-file -e "$LAST_HEAD^{commit}" 2>/dev/null; then
    if [ -z "$(git -C "$ROOT" diff --name-only "$LAST_HEAD" HEAD -- server/src server/prisma)" ]; then
      BENCH_OVERALL="$(sed -E 's/.*overall=([^ ]+).*/\1/' "$STATE/last-measure")"
      BENCH_MIN="$(sed -E     's/.*min=([^ ]+).*/\1/'     "$STATE/last-measure")"
      BENCH_WEAKEST="$(sed -E 's/.*weakest=([^ ]+).*/\1/' "$STATE/last-measure")"
      BENCH_GATE="$(sed -E    's/.*gate=([^ ]+).*/\1/'    "$STATE/last-measure")"
      BENCH_JSON="$(sed -E    's/.*json=([^ ]+).*/\1/'    "$STATE/last-measure")"
      REUSED_SCORE=1
      say "MEASURE skipped — no server/src or server/prisma change since $(git -C "$ROOT" rev-parse --short "$LAST_HEAD"); REUSING overall=$BENCH_OVERALL min=$BENCH_MIN weakest=$BENCH_WEAKEST"
    fi
  fi
fi

if [ "$REUSED_SCORE" -eq 0 ]; then
  if ! measure "$ITER" "baseline"; then
    die "baseline measurement failed — the loop has no metric; see logs/"
  fi
fi
BASELINE_OVERALL="$BENCH_OVERALL"
# The note must say WHICH baseline this is. On a restart the counter is already
# past 0, and a row reading "baseline before any loop iteration" next to
# iteration 3 is simply false — the kind of small untrue record that makes a
# whole ledger untrustworthy. It also states the HEAD it measured, because after
# a restart the tree has usually moved since the last row.
if [ "$ITER" -eq 0 ]; then
  BASELINE_NOTE="baseline before any loop iteration"
elif [ "$REUSED_SCORE" -eq 1 ]; then
  BASELINE_NOTE="RESTART at HEAD $(git rev-parse --short HEAD) — score REUSED, not measured (no server/src or server/prisma change since it was taken); iterations 1..$ITER done, next build turn is $((ITER + 1))"
else
  BASELINE_NOTE="RESTART baseline re-measured at HEAD $(git rev-parse --short HEAD) — iterations 1..$ITER already done; next build turn is $((ITER + 1))"
fi
append_ledger "$ITER" "$(git rev-parse --short HEAD)" "$BENCH_OVERALL" "$BENCH_MIN" \
  "$BENCH_WEAKEST" "$BENCH_GATE" "$(tsc_status)" "skipped" "baseline" "$BASELINE_NOTE"

# G5 — the circling detector's memory must survive a restart. It reached 3/3 at
# iteration 9's close and a restart silently reset it to 0, defeating the one rail
# that forces structural change. Persisted now, and the restore is announced.
BEST_MIN="${BENCH_MIN%%.*}"; [ -n "$BEST_MIN" ] || BEST_MIN=0
STALL=0
[ -s "$STATE/stall" ] && STALL="$(cat "$STATE/stall")"
[ -s "$STATE/best-min" ] && BEST_MIN="$(cat "$STATE/best-min")"
say "STALL restored: $STALL/$STALL_LIMIT (best min criterion $BEST_MIN)"

while :; do
  if [ -f "$STOP_FILE" ]; then
    say "STOP file present — ending cleanly at iteration $ITER"
    rm -f "$STOP_FILE"
    break
  fi
  # The benchmark no longer ends the loop. It was never able to: the owner's
  # objective is nine capabilities at 95% of a professional, and this benchmark
  # cannot see seven of them. A pass is worth saying out loud and nothing more.
  if [ "$BENCH_GATE" = "pass" ]; then
    say "benchmark gate would have passed (overall=$BENCH_OVERALL, min >= $TARGET) — noted, NOT an exit"
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

  # ── REMEDIATION TURNS ─────────────────────────────────────────────────────
  # Owner approved 2026-08-13. An iteration does not end until its own change earns
  # SOUND from the reviewer.
  #
  # The evidence for this: 16 iterations, 2 SOUND verdicts, the last at #4, and
  # NOTHING shipped for a day. Each ~$20 turn built something, was told what was
  # wrong with it, and then started something else — so four consecutive iterations
  # (13,14,15,16) went on repairing the previous one's damage while the reviewer's
  # actual findings stayed open. A review whose findings are never closed is a
  # critic, not a gate.
  #
  # So a WEAK or WRONG verdict makes the NEXT turn a remediation turn on the SAME
  # change. The campaign's deliverables do not advance, and new work is forbidden
  # until the finding is closed or the Builder shows on the record that it is wrong.
  #
  # CAPPED at REMEDIATION_LIMIT attempts. Without a cap this becomes an infinite
  # loop on one stubborn finding, burning $20 a turn — the failure mode of every
  # retry-until-green mechanism this project has recorded.
  # D-14 re-scope. Two consecutive iterations that reached nobody means the KIND of
  # work changes; a third attempt at the same class is what produced twenty
  # iterations and one deploy.
  RESCOPE_NOTE="Not applicable."
  RESCOPE_STREAK=0
  [ -s "$STATE/fail-streak" ] && RESCOPE_STREAK="$(cat "$STATE/fail-streak")"
  if [ "$RESCOPE_STREAK" -ge 2 ]; then
    say "RESCOPE iter=$ITER — $RESCOPE_STREAK consecutive iterations reached the owner with nothing"
    RESCOPE_NOTE="**RE-SCOPE THIS TURN — $RESCOPE_STREAK consecutive iterations deployed nothing and moved no capability.**

Do NOT continue the previous approach. Per D-14, pick work that can pass review and
SHIP in this turn: one owner-visible behaviour made correct, with a test and a live
check. A smaller change that arrives beats a better change that does not. Say in
your build entry what you dropped and why, and predict explicitly whether this can
be deployed at the end of this turn."
  fi

  REMEDIATION_LIMIT="${NEXEO_REMEDIATION_LIMIT:-3}"
  REMEDIATION_NOTE="Not applicable — the previous iteration was not left with an open review finding."
  # The last REVIEWED iteration, not blindly ITER-1.
  #
  # Iteration 19 was aborted mid-build (I killed the loop to install the G26 fix),
  # so it never got a review section. With `ITER-1` the rail then looked up
  # iteration 19, found nothing, read NONE, and iteration 18's two HIGH findings
  # would have gone unremediated for the second time — reproducing the exact
  # failure the G26 fix was meant to end, by a different route. Any abort, crash
  # or manual restart creates this hole, so the lookback asks the review log which
  # iteration it last ruled on.
  PREV_ITER="$(python3 - "$REVIEW_DOC" "$ITER" <<'PYEOF'
import re, sys
try:
    txt = open(sys.argv[1], errors="replace").read()
except Exception:
    print(int(sys.argv[2]) - 1); raise SystemExit
nums = [int(n) for n in re.findall(r"^##\s+Iteration\s+(\d+)", txt, re.M)
        if int(n) < int(sys.argv[2])]
print(max(nums) if nums else int(sys.argv[2]) - 1)
PYEOF
)"
  [ -n "$PREV_ITER" ] || PREV_ITER=$((ITER - 1))
  PREV_VERDICT="$(python3 - "$REVIEW_DOC" "$PREV_ITER" <<'PYEOF'
import re, sys
try:
    txt = open(sys.argv[1], errors="replace").read()
except Exception:
    print("NONE"); raise SystemExit
m = re.search(r"^##\s+Iteration\s+%s\b(.*?)(?=^##\s+Iteration|\Z)" % re.escape(sys.argv[2]),
              txt, re.S | re.M)
if not m:
    print("NONE"); raise SystemExit
v = re.search(r"\*\*(SOUND|WEAK|WRONG)\*\*", m.group(1))
print(v.group(1) if v else "NONE")
PYEOF
)"
  REM_COUNT=0
  [ -s "$STATE/remediation-count" ] && REM_COUNT="$(cat "$STATE/remediation-count")"
  # G26 — LOG THE DECISION WHETHER OR NOT IT FIRES. The first version only spoke when
  # it triggered, so two consecutive WEAK verdicts produced silence and I could not
  # tell a broken rail from a rail that correctly declined. Every part of the check
  # reproduced correctly standalone; only the running loop disagreed, which is exactly
  # the state an unconditional log would have diagnosed in one line. Same lesson as
  # the pulse's stage detector and the completion watcher: a rail that cannot be
  # watched deciding cannot be trusted.
  say "REMEDIATION check: prev=$PREV_ITER verdict=${PREV_VERDICT:-<empty>} count=$REM_COUNT/$REMEDIATION_LIMIT"
  if [ "$PREV_VERDICT" = "WEAK" ] || [ "$PREV_VERDICT" = "WRONG" ]; then
    if [ "$REM_COUNT" -ge "$REMEDIATION_LIMIT" ]; then
      # Three attempts and the reviewer is still not satisfied. Escalate rather than
      # keep paying: either the finding is wrong or the change should be reverted,
      # and both are judgements for a human.
      say "REMEDIATION cap reached ($REM_COUNT/$REMEDIATION_LIMIT) on iteration $PREV_ITER's change — releasing to new work and flagging for the owner"
      REMEDIATION_NOTE="ESCALATED. Iteration $PREV_ITER's change was remediated $REM_COUNT times and the reviewer is still not satisfied. You are released to new work, but say plainly in your build entry whether the remaining finding should be (a) accepted as a known limitation with a DEF row, or (b) grounds for reverting the change. The orchestrator is reporting this to the owner."
      printf '0' > "$STATE/remediation-count"
    else
      REM_COUNT=$((REM_COUNT + 1))
      printf '%s' "$REM_COUNT" > "$STATE/remediation-count"
      MODE="remediation"
      say "REMEDIATION iter=$ITER — iteration $PREV_ITER closed $PREV_VERDICT; this turn finishes that change (attempt $REM_COUNT/$REMEDIATION_LIMIT)"
      REMEDIATION_NOTE="**THIS IS A REMEDIATION TURN — attempt $REM_COUNT of $REMEDIATION_LIMIT.**

Iteration $PREV_ITER's review closed **$PREV_VERDICT**. Your job this turn is to CLOSE
THAT FINDING on the same change. Not a new defect, not the next fixQueue entry, not the
campaign's next deliverable — those all wait.

Read \`$REVIEW_DOC\` \`## Iteration $PREV_ITER\` and take its numbered risks in order of
severity. For each one, either fix it or show on the record why the reviewer is wrong —
'I disagree' without evidence is not closing it, and neither is a build entry that
lists the finding and moves on.

Why this rule exists, so you can judge it rather than just obey it: over sixteen
iterations the loop earned two SOUND verdicts and shipped nothing for a day, because
every turn started something new while the previous turn's findings stayed open. Four
consecutive iterations went on repairing the damage of the one before. Finishing is now
the job.

If you believe the finding is already closed by work in a later commit, say which
commit and which line, and the reviewer will judge that claim."
    fi
  elif [ "$PREV_VERDICT" = "SOUND" ] && [ "$REM_COUNT" -gt 0 ]; then
    say "REMEDIATION cleared — iteration $PREV_ITER earned SOUND after $REM_COUNT attempt(s)"
    printf '0' > "$STATE/remediation-count"
  fi
  if [ "$STALL" -ge "$STALL_LIMIT" ]; then
    MODE="structural"
    STRUCTURAL_NOTE="STRUCTURAL MODE. The minimum criterion has not improved for $STALL iterations. Per CLAUDE.md rule 5 this is *circling*, and another patch on the reported instance is FORBIDDEN. Change the mechanism that keeps producing this class — decompose the path, unify the duplicated implementation, or move the decision to where the information actually is."
    say "STALL  $STALL iterations without improvement → structural mode"
  fi

  # The active campaign, rendered into the build prompt. Campaigns set WHAT the
  # loop is aiming at across several iterations; Codex's directive still governs
  # HOW. Without this the loop re-aims at whatever gates the benchmark every turn,
  # which is how eight iterations all landed on the smallest remaining gap.
  # ── THE CAPABILITY CAP ─────────────────────────────────────────────────────
  #
  # Owner, 2026-08-13: *"are we in right direction of improvements?"* — and the
  # arithmetic said no. Accurate Communication is 15 of the 359 remaining capability
  # points, 4.2% of the journey, and it had received 22 of 22 iterations. The other
  # eight capabilities, 95.8% of the distance, had received none.
  #
  # Not bad luck — both rails pointed the same way. The benchmark's fixQueue always
  # names a conversational case and every conversational case is capability 4, while
  # the remediation rail chains each turn to whatever the reviewer last objected to,
  # which is that same case. I built that rail this morning and gave it no exit, so
  # it made the loop finish its work properly AND bound it tighter to the smallest
  # gap.
  #
  # So: after this many consecutive turns on one capability, the next turn must move
  # to the campaign's capability whatever the fixQueue says. Remediation still gets
  # its attempts — the cap is on staying, not on finishing.
  CAP_LIMIT="${NEXEO_CAPABILITY_CAP:-3}"
  CAP_NOTE="Not applicable."
  # Keyed on CAMPAIGN STARVATION, not on the declared capability line.
  #
  # My first version compared the last three `CAPABILITY:` declarations and fired
  # only if they matched. It would not have fired once: the Builder declares
  # `RELIABILITY-ONLY` for most turns, which is correct under the owner's ruling and
  # says nothing about which capability the work touched. A cap that cannot detect
  # the thing it exists to stop is decoration.
  #
  # So the signal is the campaign itself: it has been open N iterations and its
  # capability has not moved. That is the owner's question — *"are we in right
  # direction of improvements?"* — asked of the data instead of the prose.
  CAP_STARVED="$(python3 - "$STATE/campaign.json" "$ORCH/scores" "$ITER" "$CAP_LIMIT" <<'PYEOF'
import glob, json, os, re, sys
try:
    camp = json.load(open(sys.argv[1]))["active"]
except Exception:
    print(""); raise SystemExit
scores_dir, iter_no, limit = sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
name = camp.get("capability")
start = int(camp.get("from_iteration") or 0)
open_for = iter_no - start
if not name or open_for < limit:
    print(""); raise SystemExit

def score_at(n):
    try:
        d = json.load(open(os.path.join(scores_dir, f"iter-{n}-capability.json")))
    except Exception:
        return None
    for c in d.get("capabilities", []):
        if c.get("name") == name:
            return c.get("score")
    return None

# The newest card, and the newest card at or before the campaign opened.
newest = None
for f in sorted(glob.glob(os.path.join(scores_dir, "iter-*-capability.json")),
                key=lambda p: int(re.search(r"iter-(\d+)-", p).group(1))):
    n = int(re.search(r"iter-(\d+)-", f).group(1))
    if n <= iter_no:
        newest = n
at_start = next((score_at(n) for n in range(start, 0, -1) if score_at(n) is not None), None)
now = score_at(newest) if newest else None
if at_start is None or now is None:
    print(""); raise SystemExit
if now > at_start:
    print("")  # it is moving; leave the loop alone
else:
    print(f"{name}|{open_for}|{at_start}|{now}")
PYEOF
)"
  if [ -n "$CAP_STARVED" ]; then
    IFS='|' read -r CS_NAME CS_FOR CS_FROM CS_NOW <<<"$CAP_STARVED"
    say "CAP    iter=$ITER — campaign capability '$CS_NAME' open $CS_FOR iterations, still $CS_NOW (was $CS_FROM)"
    CAP_NOTE="**CAMPAIGN STARVATION — \`$CS_NAME\` has been the active campaign for $CS_FOR iterations and has not moved ($CS_FROM to $CS_NOW).**

This turn works \`$CS_NAME\`. Whatever the fixQueue says, do not add another change
aimed at the benchmark's conversational cases: Accurate Communication is 15 of the
359 remaining capability points — 4.2% of the journey — and has had every iteration
so far, while the other eight capabilities are 95.8% and have had none.

Start with the campaign's LOWEST-numbered undelivered increment. If you believe an
exception is genuinely required — a live regression that would reach the owner, for
example — say so explicitly in your build entry with the reason, so the orchestrator
reports it as an override rather than it passing unnoticed."
  fi

  CAMPAIGN_TXT="$(python3 - "$STATE/campaign.json" "$ITER" <<'PYEOF'
import json, sys
try:
    d = json.load(open(sys.argv[1])); it = int(sys.argv[2])
except Exception:
    print("No campaign file — treat this as a normal incremental iteration."); raise SystemExit
a = d.get("active") or {}
if not a:
    print("No active campaign."); raise SystemExit
start, budget = a.get("from_iteration", it), a.get("budget_iterations", 1)
spent = max(0, it - start) + 1
incs = a.get("increments") or []
inc_txt = ""
if incs:
    inc_txt = "\n**The increments, in order — take the first that is not done:**\n\n" + "\n".join(
        f"{i['n']}. {i['what']}\n   *Done when:* {i.get('done_when','')}" for i in incs) + "\n"
extra = ""
for k, label in (("baseline", "Baseline"), ("target_score", "Target"),
                 ("scope_rule", "SCOPE"), ("deploy_rule", "DEPLOY"),
                 ("abort_condition", "ABORT CONDITION"),
                 ("the_capability_in_the_owner's_words", "In the owner's words")):
    if a.get(k):
        extra += f"\n**{label}:** {a[k]}\n"
print(f"""### ACTIVE CAMPAIGN {a['id']} — {a['name']}  (iteration {spent} of {budget})

**Capability:** {a.get('capability')}  ·  **{a.get('baseline','?')} → {a.get('target_score','?')}**
**Goal:** {a.get('goal')}
**Exit condition:** {a.get('exit_condition')}
**Why this one:** {a.get('why_this_one', a.get('why_first', 'see the campaign file'))}
{inc_txt}{extra}
This is WHAT you are aiming at for this campaign. Codex's ranked directive governs
HOW — follow it where it serves the campaign, and say so in your build entry if it
pulls you off the campaign, rather than silently switching targets. A campaign turn
that produces nothing toward the goal must say that plainly; a turn that quietly
retargets the benchmark's gating criterion is the drift this structure exists to
stop. Budget is {budget} iterations; if you need more, argue for it in the build
entry and the orchestrator will extend it on the record rather than by default.""")
PYEOF
)"

  # Header anything the owner pasted since the last turn, so D-6 sees it as a report
  # without him having to format it. Runs BEFORE the build prompt is rendered, which is
  # the only point at which a new report can still reach this iteration.
  if [ -x "$ROOT/scripts/orchestrator/intake.sh" ]; then
    INTAKE_OUT="$("$ROOT/scripts/orchestrator/intake.sh" 2>&1 | tail -1)"
    case "$INTAKE_OUT" in
      *headered*) say "INTAKE $INTAKE_OUT" ;;
    esac
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
    FORBIDDEN "$FORBIDDEN_ALERT" CAMPAIGN "$CAMPAIGN_TXT" REMEDIATION "$REMEDIATION_NOTE" \
    RESCOPE "$RESCOPE_NOTE" GUARD "$GUARD_TXT" CAP "$CAP_NOTE" \
    BUILDDOC "$BUILD_DOC" REVIEWDOC "$REVIEW_DOC" DIRECTIVES "$DIRECTIVES_DOC" \
    BASELINE "$BASELINE_OVERALL")"
  # Save what the Builder was actually told. I could not verify that iteration 20's
  # remediation note reached the prompt, because the rendered text only ever lived
  # in this variable — so "the rail fired" and "the Builder was instructed" were
  # two different claims and I could only evidence the first. A loop that mediates
  # between agents through documents has to keep the document it sent.
  printf '%s' "$BUILD_PROMPT" > "$LOGS/iter-$ITER-build-prompt.md"
  run_claude "$ITER" "$BUILD_PROMPT" || say "BUILD  iter=$ITER claude returned non-zero — continuing, the rails below will judge the tree"

  check_forbidden "$ITER" "$BASE_HEAD" || true

  # ── rails, then START the measurement (it runs DURING the review) ────────
  # Owner, 2026-08-12: both seats must run immediately after each other. The
  # 5-minute measurement used to sit between them; it now overlaps the review.
  # The rails stay in front, ~90s of tsc + build + tests, because they are the
  # safety gates: a review of a tree that does not compile, and a measurement of
  # a stale dist, are both worthless.
  PREV_OVERALL="$BENCH_OVERALL"; PREV_MIN="$BENCH_MIN"; PREV_WEAKEST="$BENCH_WEAKEST"
  TSC_AFTER="$(tsc_status)"
  say "RAILS  iter=$ITER tsc=$TSC_AFTER"
  MEASURE_STARTED=0
  if [ "$TSC_AFTER" = "clean" ]; then
    ( cd "$SRV" && npm run build ) > "$LOGS/iter-$(printf '%02d' "$ITER")-npmbuild.log" 2>&1 \
      && say "RAILS  iter=$ITER npm run build ok" \
      || say "RAILS  iter=$ITER npm run build FAILED"
    TESTS_AFTER="$(test_status)"
    say "RAILS  iter=$ITER tests=$TESTS_AFTER"
    # G4 — MEASURE is blocking again, and runs BEFORE the review. The owner ruled
    # the phases are a sequence; the overlap also cost Codex this iteration's score,
    # which is what produced its strongest early finding.
    measure "$ITER" "post-build" || say "MEASURE iter=$ITER failed — the reviewer is told the score is missing"
    MEASURE_STARTED=1
  else
    TESTS_AFTER="not run (tsc red)"
    say "RAILS  iter=$ITER tsc RED — skipping build/tests/measure; the score stands from before"
  fi

  # ── REVIEW — starts NOW, while the score is still being computed ──────────
  # G1 — scoped to BRAIN paths. Unscoped, the orchestrator's own commits landed in
  # the Builder's review range and Codex reviewed my tooling as its undisclosed
  # scope (its iteration-2 WEAK verdict said so). Fixed in the manual prompts at
  # iteration 3 and never in the loop; iterations 6-11 all had polluted ranges.
  DIFF_STAT="$(git diff --stat "$BASE_HEAD" HEAD -- server/src server/tests server/prisma server/docs 2>/dev/null | tail -25)"
  [ -z "$DIFF_STAT" ] && DIFF_STAT="$(git status --porcelain | head -25)"
  [ -z "$DIFF_STAT" ] && DIFF_STAT="(no changes detected this iteration — say so plainly in the review)"

  # The score handed to the reviewer is the PREVIOUS one, and it is labelled as
  # such. Passing a pending measurement's stale numbers as if they were this
  # iteration's would be the `fabricated-status` shape aimed at the reviewer —
  # the one participant whose whole job is catching claims that outrun evidence.
  if [ "$MEASURE_STARTED" = "1" ]; then
    SCORE_STATE="**This iteration's score is MEASURED and current** — the benchmark ran after the build turn and before this review, so \`@@SCOREJSON@@\` is this iteration's own post-build report. Use its \`fixQueue\` and case text as evidence; that is how you proved the DEF-134 bypass in iteration 1.  OLD NOTE, no longer applicable: — it is computed concurrently with your review so that you start the moment the Builder stops. The numbers below are the PREVIOUS iteration's. Judge the diff against the build log's claims, which is your job and needs no score; where a claim can only be settled by the new measurement, say so explicitly and it will be in front of you next iteration."
  else
    SCORE_STATE="No measurement ran this iteration (tsc was RED, so build/tests/measure were skipped). The numbers below are the last successful measurement's."
  fi
  REVIEW_PROMPT="$(render "$PROMPTS/review.md" \
    ITER "$ITER" TARGET "$TARGET" \
    OVERALL "$BENCH_OVERALL" MINSCORE "$BENCH_MIN" WEAKEST "$BENCH_WEAKEST" \
    SCOREJSON "${BENCH_JSON:-none}" SCORESTATE "$SCORE_STATE" \
    TSC "$TSC_AFTER" TESTS "$TESTS_AFTER" \
    BASEHEAD "$(git rev-parse --short "$BASE_HEAD")" HEAD "$(git rev-parse --short HEAD)" \
    DIFFSTAT "$DIFF_STAT" \
    BUILDDOC "$BUILD_DOC" REVIEWDOC "$REVIEW_DOC")"
  run_codex "$ITER" "$REVIEW_PROMPT" || say "REVIEW iter=$ITER codex returned non-zero — continuing"

  check_forbidden "$ITER" "$BASE_HEAD" || true

  # ── SCORE (Grok) — G3: in the sequence, not a parallel daemon ─────────────
  if [ -x "$ROOT/scripts/orchestrator/run-score.sh" ]; then
    say "SCORE  iter=$ITER asking Grok (reads the codebase; nobody edits its numbers)"
    if "$ROOT/scripts/orchestrator/run-score.sh" "$ITER" >/dev/null 2>&1; then
      CAPJSON="$SCORES/iter-$(printf '%02d' "$ITER")-capability.json"
      if python3 "$ROOT/scripts/orchestrator/scorecard.py" --ingest "$CAPJSON" \
           --iteration "$ITER" --head "$(git rev-parse --short HEAD)" \
           --commit --append --label "Post-Build" >> "$ORCH/score.log" 2>&1; then
        say "SCORE  iter=$ITER card appended"
      else
        # Rejected means unevidenced or malformed — the file is removed so the
        # iteration is retried rather than silently skipped.
        say "SCORE  iter=$ITER INGEST REJECTED (see score.log) — capability file removed for retry"
        rm -f "$CAPJSON"
      fi
    else
      say "SCORE  iter=$ITER grok FAILED — see logs/iter-$(printf '%02d' "$ITER")-score.log"
    fi
  fi

  # ── DEPLOY — last phase, gated on a SOUND review ──────────────────────────
  if [ "$DEPLOY" = "1" ]; then
    "$ROOT/scripts/orchestrator/deploy.sh" "$ITER" || say "DEPLOY iter=$ITER did not ship (see the deploy log)"
  fi

  # ── stall accounting on the MINIMUM, which is what the gate reads ─────────
  CUR_MIN="${BENCH_MIN%%.*}"; [ -n "$CUR_MIN" ] || CUR_MIN=0
  if [ "$CUR_MIN" -gt "$BEST_MIN" ] 2>/dev/null; then
    say "PROGRESS min criterion $BEST_MIN → $CUR_MIN"
    BEST_MIN="$CUR_MIN"; STALL=0
    printf '%s' "$STALL" > "$STATE/stall"; printf '%s' "$BEST_MIN" > "$STATE/best-min"
    # NO DEPLOY HERE. This block used to `pm2 restart` on any PROGRESS with a clean
    # tsc — the crude flag that predated deploy.sh. I added the gated deploy phase
    # and LEFT THIS IN PLACE, so at iteration 13 the loop logged
    # "codex verdict: WRONG · hold" from the real gate and then restarted
    # production anyway from here, shipping a CRITICAL data-loss regression.
    # Two implementations of deploy, the weaker one live: the exact shape this
    # project has recorded eight times. Deploy happens in ONE place, deploy.sh,
    # after the review, gated on the verdict.
  else
    STALL=$((STALL + 1))
    printf '%s' "$STALL" > "$STATE/stall"
    say "NO IMPROVEMENT in the minimum criterion (still $BEST_MIN) — stall=$STALL/$STALL_LIMIT"
  fi

  append_ledger "$ITER" "$(git rev-parse --short HEAD)" "$BENCH_OVERALL" "$BENCH_MIN" \
    "$BENCH_WEAKEST" "$BENCH_GATE" "$TSC_AFTER" "$TESTS_AFTER" "$MODE" \
    "stall=$STALL$([ "$FORBIDDEN_ALERT" = "none" ] || echo ' FORBIDDEN-PATH-ALERT')"

  # ── D-14 · DID THIS ITERATION REACH THE OWNER? ─────────────────────────────
  #
  # Owner, 2026-08-13: *"we are not here to increase just numbers of iteration we
  # need significant improvements against each iteration"*.
  #
  # One iteration in ten shipped, and Grok's card said why in its own words:
  # "branch-only, NOT YET deployed; overall remains 47.4". Under the capability
  # contract undeployed work has changed nothing for him, so the number was frozen
  # by construction. The loop tracked the benchmark, the test count and the stall
  # counter — and never tracked the only column he was asking about.
  #
  # So: an iteration that deploys nothing AND moves no capability is FAILED, not
  # neutral. Two in a row and the next turn is re-scoped to something small enough
  # to pass review and ship, rather than a third attempt at the same class.
  SHIPPED_THIS_ITER="no"
  grep -q "\"iteration\": *$ITER\b" "$STATE/deploy-history" 2>/dev/null && SHIPPED_THIS_ITER="yes"
  CAP_MOVED="$(python3 - "$ORCH/scores/iter-$ITER-capability.json" <<'PYEOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("unknown"); raise SystemExit
v = (d.get("overall_verdict") or "").upper()
print("yes" if v == "PROGRESSIVE" else "no")
PYEOF
)"
  FAIL_STREAK=0
  [ -s "$STATE/fail-streak" ] && FAIL_STREAK="$(cat "$STATE/fail-streak")"
  # D-19, 2026-08-13 — THE STREAK RESETS ON DELIVERY, NOT ON A SCORER'S OPINION.
  # This block used to reset the moment EITHER a deploy happened OR Grok's card said
  # PROGRESSIVE. So at iteration 23 the loop logged "ITERATION 23 reached the owner —
  # fail streak reset from 3" on an iteration that deployed NOTHING: the owner received
  # nothing and the failure rail was disarmed by a third-party model's adjective. That
  # is how fourteen iterations produced one deploy without the rail ever tripping, and
  # it inverts the owner's standing ruling that improvement must be REAL, not numeric
  # (D-10), and that undeployed work is worth zero (D-14).
  #
  # Capability movement without a deploy is still worth SAYING — it is the difference
  # between a wasted turn and a turn whose value is stuck behind the gate — but it no
  # longer counts as reaching him.
  if [ "$SHIPPED_THIS_ITER" = "yes" ]; then
    [ "$FAIL_STREAK" -gt 0 ] && say "ITERATION $ITER reached the owner — fail streak reset from $FAIL_STREAK"
    FAIL_STREAK=0
  else
    FAIL_STREAK=$((FAIL_STREAK + 1))
    if [ "$CAP_MOVED" = "yes" ]; then
      say "ITERATION $ITER FAILED — capability moved but NOTHING DEPLOYED, so the owner received nothing (streak $FAIL_STREAK)"
    else
      say "ITERATION $ITER FAILED — nothing deployed, no capability movement (streak $FAIL_STREAK)"
    fi
  fi
  printf '%s' "$FAIL_STREAK" > "$STATE/fail-streak"
  say "SHIP   iter=$ITER deployed=$SHIPPED_THIS_ITER capability_moved=$CAP_MOVED"
done

say "════════ orchestrator finished · iterations=$ITER · overall=$BENCH_OVERALL min=$BENCH_MIN gate=$BENCH_GATE ════════"
say "ledger: $LEDGER_MD"
[ "$BENCH_GATE" = "pass" ] && exit 0 || exit 2
