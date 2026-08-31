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
# Owner ruling 2026-08-13: build on Fable 5. One place, so the flag and the log
# can never disagree, and a single turn falls back to opus on a 429 (run_claude).
BUILD_MODEL="${NEXEO_BUILD_MODEL:-fable}"
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
# STDOUT-SAFE say. `say` tees to STDOUT, so calling it inside a function whose
# stdout is the RETURN VALUE silently prepends the log line to that value. That
# is not hypothetical: on 2026-08-31 `builder_session_id` did exactly this, the
# captured id became "…  BUILD  no "Brain Builder" session found — creating
# <uuid>\n<uuid>", and every build turn died on `Error: Invalid session ID. Must
# be a valid UUID.` — so the Brain Builder seat never opened and never appeared
# in the session list, which is the owner's 2026-08-11 complaint recurring
# through a different mechanism. Use `saye` in any function that PRINTS a value.
# Both loop.out and the watchdog capture stderr (`>> loop.out 2>&1`), so nothing
# is lost by logging there.
saye() { say "$@" >&2; }
die() { say "FATAL: $*"; exit 1; }

[ -x "$CLAUDE_BIN" ] || die "claude CLI not executable at $CLAUDE_BIN"
# codex is no longer a REQUIREMENT: all three seats moved to Claude on 2026-08-18 when
# grok returned 402 and codex hit its usage limit. Kept as a warning rather than a fatal
# check so the loop still starts on a box without codex installed — and so that when
# credit returns, restoring the independent seats is a config change, not a rescue.
[ -x "$CODEX_BIN" ]  || say "note: codex CLI not present at $CODEX_BIN — no seat currently uses it"
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
    local cur; cur="$(cat "$BUILDER_SESSION_FILE")"
    # ROTATE ON SIZE. Every turn in a resumed session re-sends the whole transcript,
    # so a seat's lifetime cache-read cost grows with the SQUARE of its turn count.
    # Left alone this one grows without bound — the same shape that made the
    # interactive editor sessions expensive (measured 2026-08-28: eight of them held
    # 86% of 9.20B cache-read tokens, against 4% for this seat).
    #
    # Read ONCE, here, where a run picks up its id — never mid-run, so a live turn is
    # never pulled out from under itself. Retiring the id is the whole mechanism:
    # run_claude opens a fresh session whenever the transcript for an id is absent, so
    # the replacement takes the existing --session-id path with nothing else changed.
    local tx="/root/.claude/projects/-var-www-tmcai/$cur.jsonl"
    local cap="${NEXEO_BUILDER_MAX_MB:-8}"
    local mb=0
    [ -f "$tx" ] && mb="$(du -m "$tx" 2>/dev/null | cut -f1)"
    if [ "${mb:-0}" -ge "$cap" ] 2>/dev/null; then
      printf '%s %s %sMB\n' "$(date -u +%FT%TZ)" "$cur" "$mb" >> "$STATE/builder-session-retired"
      saye "BUILD  retiring \"$BUILDER_NAME\" $cur — transcript ${mb}MB >= ${cap}MB"
      : > "$BUILDER_SESSION_FILE"
    else
      printf '%s' "$cur"; return 0
    fi
  fi
  # 2. a live session already wears the name (e.g. the owner made it by hand)
  local found=""
  [ -x "$RESOLVER" ] && found="$("$RESOLVER" "$BUILDER_NAME" --cwd "$ROOT" 2>/dev/null || true)"
  if [ -n "$found" ]; then
    printf '%s' "$found" > "$BUILDER_SESSION_FILE"
    saye "BUILD  adopted existing \"$BUILDER_NAME\" session $found"
    printf '%s' "$found"; return 0
  fi
  # 3. none exists — create one and record it, so it is the same seat forever
  local sid; sid="$(cat /proc/sys/kernel/random/uuid)"
  printf '%s' "$sid" > "$BUILDER_SESSION_FILE"
  saye "BUILD  no \"$BUILDER_NAME\" session found — creating $sid"
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
  #
  # Written BEFORE the turn so a build that is killed mid-flight is still attributed to the
  # schedule that started it. `build` runs from the nightly cron AND from a hand-run loop
  # during a campaign, so the seat can never imply the schedule.
  printf '%s' "${NEXEO_TRIGGER:-manual}" > "$LOGS/iter-$n-build.trigger" 2>/dev/null || true
  printf '%s' "$prompt" | IS_SANDBOX=1 "$CLAUDE_BIN" -p \
    "${session_args[@]}" \
    --name "$BUILDER_NAME" \
    --model "$BUILD_MODEL" \
    --output-format stream-json --verbose \
    --dangerously-skip-permissions \
    --max-turns "${NEXEO_BUILD_MAX_TURNS:-40}" \
    --add-dir "$ROOT" 2>&1 \
    | tee "$raw" \
    | python3 "$FORMATTER" --prefix \
    | tee -a "$log" \
    | sed -u 's/^/BUILD  │ /'
  # claude's status, NOT tee's or python's — a formatter exiting 0 must never
  # launder a failed build turn into a success.
  local rc=${PIPESTATUS[1]}

  # ── RATE-LIMIT FALLBACK ─────────────────────────────────────────────────────
  # The seat's "api_error" was never a corrupt transcript. The raw event says it
  # plainly: api_error_status 429, type=seven_day_overage_included, "You've reached
  # your Fable 5 limit". That is what killed iterations 44-49 and 51 — 0 tokens,
  # $0.00, three seconds — and what the orchestrator twice misdiagnosed as a session
  # grown too large, rotating a 14.5 MB transcript that was never the problem.
  #
  # The owner chose Fable for building, so Fable stays primary. But an empty quota
  # must not cost a day of iterations: the turn is retried once on opus and the
  # substitution is logged, because a loop that stops building when one model is
  # full is not "never idle" — it is idle with an explanation.
  if grep -q '"api_error_status":429' "$raw" 2>/dev/null; then
    say "BUILD  iter=$iter RATE-LIMITED on model=$BUILD_MODEL — retrying this turn on opus"
    printf '%s' "$prompt" | IS_SANDBOX=1 "$CLAUDE_BIN" -p \
      "${session_args[@]}" \
      --name "$BUILDER_NAME" \
      --model opus \
      --output-format stream-json --verbose \
      --dangerously-skip-permissions \
      --add-dir "$ROOT" 2>&1 \
      | tee -a "$raw" \
      | python3 "$FORMATTER" --prefix \
      | tee -a "$log" \
      | sed -u 's/^/BUILD  │ /'
    rc=${PIPESTATUS[1]}
  fi

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

run_chat_analyst() {
  local iter="$1" prompt="$2"
  local n; n="$(printf '%02d' "$iter")"
  local last="$LOGS/iter-$n-chat-last.txt"
  local raw="$LOGS/iter-$n-chat.jsonl"
  # CLAUDE, not codex. Scoring and Review moved to Claude on 2026-08-18 when both other
  # vendors ran dry, and this seat was left pointed at codex — so every Chat Analysis
  # since has exited 1 ("You've hit your usage limit"), the builder silently fell back to
  # the previous ranking, and the stage the owner cares most about has been dead while
  # reporting itself as a completed phase.
  #
  # NO resume, deliberately: this is a different question from the diff review, and
  # sharing a thread is how the reviewer's context leaked into it once already.
  # Write tools denied — the analyst establishes what is wrong, it does not edit.
  #
  # AND NO TRANSCRIPT ON DISK. No-resume was intentional; the litter it produced was
  # not. Every -p run mints a fresh session id and still persists a transcript, so the
  # conversational cron wrote one session file every ten minutes — 76 of them by
  # 2026-08-31, against 31 real human conversations in the same directory. The owner
  # went looking for a session and could not find one in the flood (the same complaint
  # as 2026-08-11, arriving this time by volume rather than by name).
  #
  # Nothing is lost: this seat's output is ALREADY captured independently, to
  # iter-NN-chat-last.txt — which is what the builder and the evidence packages actually
  # read. The copy under ~/.claude/projects was pure duplication, and it is the one nobody
  # can resume anyway — this seat never resumes by design.
  #
  # AND IT IS NOW BILLABLE. Under `--output-format text` this seat emitted no usage at all, so
  # `iter-NN-chat.jsonl` was a copy of the prose rather than an event stream and the `heal` seat
  # has read "never measured" on the spend deck since the deck was built. stream-json is the
  # format the build seat already records 34 runs in, so the same parser reads it unchanged.
  # The prose the builder and the evidence packages consume is extracted back out below, so
  # iter-NN-chat-last.txt keeps exactly the contents it always had.
  printf '%s' "${NEXEO_TRIGGER:-manual}" > "$LOGS/iter-$n-chat.trigger" 2>/dev/null || true
  "$CLAUDE_BIN" -p "$prompt" \
    --no-session-persistence \
    --model "${NEXEO_CHAT_MODEL:-claude-opus-4-8}" \
    --fallback-model claude-opus-4-8 \
    --output-format stream-json --verbose \
    --permission-mode dontAsk \
    --disallowed-tools 'Write,Edit,NotebookEdit' \
    --add-dir "$ROOT" \
    --max-turns 40 > "$raw" 2>"$LOGS/iter-$n-chat.err"
  local rc=$?
  python3 "$ROOT/scripts/orchestrator/extract-result.py" "$raw" > "$last" 2>/dev/null || true
  # A claude turn that exited 0 but yielded no extractable answer must NOT be reported as a
  # successful analysis. Before stream-json the prose WAS the file and an exit-0 run always
  # left one; now the answer is a field, and a stream that ends without a result event would
  # otherwise hand the loop an empty ranking while claiming the stage completed.
  if [ "$rc" -eq 0 ] && [ ! -s "$last" ]; then
    rc=1
    say "CHAT   iter=$iter claude exit=0 but no result event — treating as failure ($(basename "$raw"))"
  fi
  say "CHAT   iter=$iter claude exit=$rc ($(basename "$last"))"
  return $rc
}

run_codex() {
  local iter="$1" prompt="$2"
  local n; n="$(printf '%02d' "$iter")"
  local log="$LOGS/iter-$n-review.log"       # readable, live
  local raw="$LOGS/iter-$n-review.jsonl"     # raw events, the evidence
  local last="$LOGS/iter-$n-review-last.txt"
  local stored="" rc=0
  local -a cmd

  printf '%s' "${NEXEO_TRIGGER:-manual}" > "$LOGS/iter-$n-review.trigger" 2>/dev/null || true

  [ -s "$CODEX_SESSION_FILE" ] && stored="$(cat "$CODEX_SESSION_FILE")"

  # Built once, run once. The three branches used to duplicate the invocation,
  # which is how a flag gets fixed on two paths and forgotten on the third.
  local REVIEW_MODEL="${NEXEO_REVIEW_MODEL:-claude-opus-4-8}"
  local -a common=(--model "$REVIEW_MODEL" --fallback-model claude-opus-4-8
                   --output-format stream-json --verbose
                   --permission-mode dontAsk
                   --disallowed-tools 'Write,Edit,NotebookEdit'
                   --max-turns 60)
  if [ -z "$stored" ]; then
    stored="$(cat /proc/sys/kernel/random/uuid)"
    printf '%s' "$stored" > "$CODEX_SESSION_FILE"
    say "REVIEW iter=$iter claude opening a new session $stored on $REVIEW_MODEL"
    cmd=("$CLAUDE_BIN" -p "$prompt" --session-id "$stored" "${common[@]}")
  else
    say "REVIEW iter=$iter claude resuming session $stored on $REVIEW_MODEL"
    cmd=("$CLAUDE_BIN" -p "$prompt" --resume "$stored" "${common[@]}")
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
  # the reviewer's status, NOT tee's or the formatter's.
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

# THE EXIT CODE MUST SAY WHICH KIND OF ENDING THIS WAS. Owner, 2026-08-24, after I misread five
# nights of `rc=2` as crashes and told him the nightly was dead.
#
# The last line of this script used to compute the exit code from ONE thing — whether the bench
# gate passed. So a run that fell over halfway exited 2, and a healthy run whose C4 sat at 87.9
# exited 2, and NOTHING could tell them apart. That is not a reporting nicety: for five nights a
# fatal shell error fired inside this file and the exit code calmly reported "gate did not pass".
# I then read the log and concluded the opposite of the truth, twice, in both directions.
#
#   0  the run finished AND the gate passed
#   2  the run finished, the gate did not pass          ← normal, expected, not a failure
#   1  the run did NOT reach its finish line            ← a real failure, always worth waking for
#
# 1 is the one that could not previously be expressed. The trap is what makes it honest: any
# ending that has not passed the finish line — `set -u`, a signal, an unexpected `exit` — lands
# here with FINISHED_CLEANLY still 0 and is reported as the failure it is.
FINISHED_CLEANLY=0
ORCH_RC=1
finish_orch() {
  local shell_rc=$?
  if [ "$FINISHED_CLEANLY" = "1" ]; then
    exit "$ORCH_RC"
  fi
  say "ABORTED — the run ended before its finish line (shell rc=$shell_rc). This is a FAILURE, not a gate result."
  exit 1
}
trap finish_orch EXIT
say "deploy=$DEPLOY skip_tests=$SKIP_TESTS stall_limit=$STALL_LIMIT"

# Iteration counter survives a kill, so a restarted loop continues numbering.
ITER=0
[ -s "$STATE/iteration" ] && ITER="$(cat "$STATE/iteration")"

# NO PREP BUILD. Removed 2026-08-17.
#
# This ran `npm run build` into server/dist before iteration 1 — and `server/dist` is
# the DEPLOYED ARTIFACT, chattr +i since 2026-08-16 precisely because a build in this
# tree silently replaces what production is executing and any later restart activates
# code nobody authorised. That happened once already, at 19:15 on 2026-08-16.
#
# It existed only so the benchmark measured current source rather than a stale dist.
# The benchmark was removed from the pipeline on 2026-08-17 (owner: "ok remove
# measure"), so this step now serves nothing while doing the one thing the repo
# forbids. `npx tsc --noEmit` — already run by tsc_status — IS the build check.
#
# To build without deploying: clone (git clone --no-local) and build the clone.

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
    # A KNOWN HOLE, written down because it is dormant rather than fixed (2026-08-24). This asks
    # git whether Brain's CODE changed. Brain's PROMPTS are not only code: `prompt_blocks` is a
    # database table, written at runtime through promptBlockService, and an edit there changes
    # how Brain behaves while leaving this diff empty — so the score would silently go on
    # replaying. Not fixed today because it has never fired: all 8 rows are `source: seeded` and
    # the newest `updated_at` is 2026-05-23, three months before this line was written. If that
    # table ever starts changing, this criterion has to include it or the scorer goes blind.
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

# A CONVERSATIONAL PULSE HAS TWO STAGES, AND MEASURING IS NOT ONE OF THEM.
#
# Owner, 2026-08-20, looking at a conversational pulse whose header read MEASURING: "what is
# 'Measuring'?? it is not part of Healing Pulse - Phase." He is right, and by his own
# definition: a conversational pulse is Chat Analysis + Build & Deploy, nothing else.
#
# The post-build MEASURE stage and the Capability Evaluation stage were both already guarded
# for this. THIS one — the startup baseline — was not, so a pulse launched from a click ran a
# 12-case compose-and-judge benchmark before it built anything, took several minutes over it,
# and displayed a stage that does not exist in that pulse's own phase list. Three guards for
# one condition, and the third was missing, which is `protection-with-two-implementations`
# counted a third time.
#
# What replaces it on this path is not nothing: deploy.sh runs tsc and vitest at the deploy
# commit, so the build is still verified — it just is not scored against the benchmark, which
# a conversational pulse never reports anyway.
if [ "${NEXEO_TARGET_SOURCE:-}" = "chat" ]; then
  say "MEASURE iter=$ITER baseline skipped — conversational pulse (Chat Analysis + Build & Deploy only)"
  # A SKIPPED STAGE MUST STILL DEFINE WHAT IT WOULD HAVE SET.
  #
  # The guard above, added an hour earlier, killed pulse #10 outright: `set -u` and
  # `BASELINE_OVERALL="$BENCH_OVERALL"` four lines down — "line 687: BENCH_OVERALL: unbound
  # variable", the loop dead in the same second it started, the deck showing Build & Deploy
  # as "—" with no event at all.
  #
  # THE SECOND TIME TONIGHT I made this exact mistake: guard a stage, forget that the code
  # after it reads what that stage set. The first was `$NOW` in watch-conversations.sh. Under
  # `set -u` the failure is silent death rather than an empty string, which is the right trade
  # and also why it surfaces only as absence.
  #
  # "null" and "error" are this file's own convention for a measurement that did not happen —
  # measure() already uses exactly these on its failure path (line 204), so downstream readers,
  # the ledger and the review prompt all handle them. Not "0", which would read as a score.
  BENCH_OVERALL="null"; BENCH_MIN="null"; BENCH_WEAKEST="null"
  BENCH_GATE="skipped"; BENCH_JSON=""
elif [ "$REUSED_SCORE" -eq 0 ]; then
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
  # THE CAP COUNTS THIS RUN'S PULSES, NOT THE ABSOLUTE COUNTER.
  #
  # It compared $ITER — which persists across runs — against MAX_ITER. Under cron with
  # NEXEO_MAX_ITER=1 the counter was already 1 from the first pulse, so EVERY run since
  # exited in ~57 seconds saying "cap reached" without doing any work: the 02:30 nightly,
  # the 08:42 run, all of them. The owner asked why only one pulse had run since
  # yesterday, and this was the whole answer — the crons fired faithfully into a
  # condition that was true before they started.
  #
  # PULSES_THIS_RUN starts at 0 in every process, so "1" means "one pulse from here".
  PULSES_THIS_RUN=$((${PULSES_THIS_RUN:-0} + 1))
  if [ "$PULSES_THIS_RUN" -gt "$MAX_ITER" ]; then
    say "pulse cap $MAX_ITER reached for this run — stopping (rail, not success)"
    break
  fi

  # THE COUNTER ADVANCES ONLY ON IMPROVEMENT.
  #
  # Owner, 2026-08-17, said this several times and I implemented it too weakly twice:
  # "if iteration couldn't get improvement in brain capability then don't move to next
  # iteration, first make it improved." My earlier version advanced the number and held
  # only the WORK, so the deck read "iteration 2" after a turn that moved nothing —
  # which is exactly the thing he has been objecting to since the 58-iteration run.
  #
  # So the number now MEANS an improvement, not an attempt. It advances when BRAIN
  # overall rose since the last completed turn; otherwise the same iteration is
  # attempted again and its logs append to that iteration's record. A counter that
  # counts attempts is what let 58 iterations look like progress while two of nine
  # capabilities ever moved.
  # Read the last two cards directly rather than through a state file. The first
  # version compared $STATE/overall-last against a file nothing ever wrote, so ADVANCE
  # was always 1 and the counter would have kept climbing exactly as before — the
  # rule would have existed in the script and not in the behaviour.
  ADVANCE="$(python3 - "$STATE/capability_scorecard.json" <<'PYADV'
import json, sys
try:
    h = [r for r in json.load(open(sys.argv[1])).get("history", []) if r.get("overall") is not None]
except Exception:
    print(1); raise SystemExit
# Fewer than two cards: nothing to compare, so let the loop move.
if len(h) < 2:
    print(1)
else:
    print(1 if h[-1]["overall"] > h[-2]["overall"] else 0)
PYADV
)"
  if [ "$ADVANCE" = "1" ]; then
    ITER=$((ITER + 1))
  else
    say "ITERATION $ITER REPEATS — BRAIN overall did not rise; the number advances on improvement, not on attempts"
  fi
  printf '%s' "$ITER" > "$STATE/iteration"
  BASE_HEAD="$(git rev-parse HEAD)"
  say "──────── iteration $ITER ────────"
  # THE PULSE LEDGER — owner, 2026-08-18: "we will have trend conversational healing 1,
  # 2, 3 and night build heal 1, 2, 3."
  #
  # One line per pulse, with its kind and its ordinal WITHIN that kind, so the deck can
  # label columns C1/C2/N1 instead of a bare iteration number that no longer means
  # anything. The ordinal is computed by counting previous lines of the same kind rather
  # than kept in a counter file — a counter drifts the moment a pulse dies mid-run, and
  # the ledger is the record either way.
  if [ "${NEXEO_TARGET_SOURCE:-}" = "chat" ]; then
    PULSE_KIND=conversational
  else
    PULSE_KIND=evaluation
  fi
  printf '%s' "$PULSE_KIND" > "$STATE/pulse-mode"
  # `grep -c` PRINTS 0 AND EXITS 1 when nothing matches, so `|| echo 0` appended a SECOND zero
  # and the arithmetic became $(( 0\n0 + 1 )). Reproduced in isolation on this box: the
  # assignment FAILS and leaves PULSE_N UNSET, and the printf below then dies on `set -u` with
  # "PULSE_N: unbound variable".
  #
  # It only ever bit the NIGHTLY. The ledger has conversational entries, so for
  # PULSE_KIND=conversational the grep exits 0 and prints one number; "evaluation" had none, so
  # only that branch tripped. `|| true` keeps the pipeline honest without adding output.
  #
  # WHAT IT COST, stated narrowly because I first got this wrong and said so to the owner:
  # the EVALUATION LEDGER ROW, and nothing else that is proven. `pulse-ledger.jsonl` runs
  # unbroken from 2026-08-18 (iteration 1) to 29 with ZERO "evaluation" rows and zero malformed
  # lines, which is why the deck's nightly track reads "0 pulses" against six completed runs.
  # It did NOT stop the nightly from scoring: 08-20 measured overall=94.2 and 08-21 measured
  # 95.3, both written to scores/iter-NN-baseline.json. The later nights show
  # "MEASURE skipped — no server/src or server/prisma change", which is the intended
  # cost guard, not this bug.
  #
  # ONE THING REMAINS UNEXPLAINED, and it is left here honestly rather than resolved by
  # guessing: the record says the run both DIED here (no ledger row was ever written, and
  # `set -u` is never relaxed in this file) and REACHED ITS FINISH LINE (loop.out shows
  # "orchestrator finished" after the error, and nightly.log records rc=2, which only line
  # ~1793 can produce — a `set -u` death would give rc=1). Those cannot both be true, so one
  # of them is being misread. The exit-code separation added below is what makes the next
  # occurrence answer this by itself instead of by log archaeology.
  PULSE_N="$(( $(grep -c "\"kind\":\"$PULSE_KIND\"" "$STATE/pulse-ledger.jsonl" 2>/dev/null || true) + 1 ))"
  printf '{"iteration":%s,"kind":"%s","kind_n":%s,"at":"%s"}\n' \
    "$ITER" "$PULSE_KIND" "$PULSE_N" "$(date -u +%FT%TZ)" >> "$STATE/pulse-ledger.jsonl"
  say "PULSE  iter=$ITER $PULSE_KIND #$PULSE_N"

  # ── CAPABILITY EVALUATION (Grok) — FIRST, before anything is built ────────
  #
  # Owner, 2026-08-17: "it will first score the brain using grok and then start
  # iterations … build will read capability evaluation and see where the gap is."
  #
  # WHY IT MOVED. This ran LAST, after Review, as "Post-Build". So every iteration
  # chose what to build BEFORE the only numbers that say which capability is weakest
  # existed for that turn — the build read the previous turn's card at best, and on a
  # fresh start read nothing. 58 iterations moved 2 of 9 capabilities; work aimed
  # without the scores is the most plausible reason, and this is the change that
  # tests it.
  #
  # Two consequences of running first, both deliberate:
  #   • label is Pre-Build, not Post-Build — it scores the tree the build is ABOUT
  #     to start from, which is what the builder needs to aim.
  #   • head is BASE_HEAD, the commit actually scored. Using HEAD would attribute
  #     the reading to a commit that did not exist when Grok read the code.
  if [ "${NEXEO_TARGET_SOURCE:-}" = "chat" ]; then
    say "SCORE  iter=$ITER skipped — conversational pulse (Chat Analysis + Build & Deploy only)"
  elif [ -x "$ROOT/scripts/orchestrator/run-score.sh" ]; then
    say "SCORE  iter=$ITER asking the scorer (reads the codebase; nobody edits its numbers)"
    if "$ROOT/scripts/orchestrator/run-score.sh" "$ITER" >/dev/null 2>&1; then
      CAPJSON="$SCORES/iter-$(printf '%02d' "$ITER")-capability.json"
      if python3 "$ROOT/scripts/orchestrator/scorecard.py" --ingest "$CAPJSON" \
           --iteration "$ITER" --head "$(git rev-parse --short "$BASE_HEAD")" \
           --commit --append --label "Pre-Build" >> "$ORCH/score.log" 2>&1; then
        say "SCORE  iter=$ITER card appended — the build aims at these numbers"
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

  # ── DEPLOY DEBT — no new work while the last one has not reached him ────────
  # Owner, 2026-08-14: *"also deploy the iteration before start next"*. He is right,
  # and it is the rule this loop most needed: three undeployed Brain commits sat on
  # the branch through nineteen further iterations, so every one of those turns was
  # worth zero before it began (D-14 — undeployed work changes nothing for him).
  #
  # While Brain-path commits stand between the deployed SHA and HEAD, the campaign
  # and all new work are SUSPENDED. The only job is to make HEAD deployable: close
  # the reviewer's blocking findings so the deploy phase can ship it. This is not a
  # remediation attempt-counter that expires — the debt is measured from the tree
  # every iteration and clears only when a deploy actually happens.
  DEPLOY_DEBT=""
  if [ -s "$STATE/deployed-sha" ]; then
    DEPLOY_DEBT="$(git -C "$ROOT" log --oneline "$(cat "$STATE/deployed-sha")"..HEAD -- server/src server/prisma 2>/dev/null | head -20)"
  fi
  if [ -n "$DEPLOY_DEBT" ]; then
    DEBT_N="$(printf '%s\n' "$DEPLOY_DEBT" | grep -c .)"
    say "DEBT   iter=$ITER — $DEBT_N undeployed Brain commit(s) on the branch; campaign suspended until HEAD ships"
    CAMPAIGN_TXT="**CAMPAIGN SUSPENDED — THERE IS UNDEPLOYED WORK ON THIS BRANCH.**

$DEBT_N commit(s) touching Brain code stand between the deployed SHA
($(cut -c1-9 < "$STATE/deployed-sha")) and HEAD, and the owner ruled on 2026-08-14 that an
iteration is deployed before the next one starts. Undeployed work is worth zero to him
whatever it scores, so starting something new on top of it only makes the debt larger.

\`\`\`
$DEPLOY_DEBT
\`\`\`

**YOUR ONLY JOB THIS TURN IS TO MAKE HEAD DEPLOYABLE.** Read the newest \`## Iteration\`
section of \`$REVIEW_DOC\` and close every finding the reviewer says blocks release —
CRITICAL findings and product-invariant violations first. No campaign increment, no new
defect, no refactor, no opportunistic fix: each of those adds surface for the reviewer to
block on, and three consecutive turns have already died that way.

If you believe a blocking finding is already closed, name the commit and the file:line
that closes it and let the reviewer judge that claim. If you believe it is wrong, say so
with evidence — 'I disagree' does not clear a release blocker."
  fi

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

  # THE TARGET COMES FROM THE OWNER'S CHATS FIRST, THE CODE-READ GAP SECOND.
  #
  # Owner, 2026-08-17: "analyzing chat log is very essential because i am communicating
  # to brain and found serious issues with it that should be analyzed by loop and fixed
  # by building capabilities."
  #
  # The widest arithmetic gap is a reading of the CODE. The analyst's top item is a
  # reading of what actually happened to him — ranked by recurrence x reached-the-owner
  # x still-open. When they disagree the chats win, because a defect he has hit four
  # times is a fact and a code-read gap is an inference. On the first analysis they DID
  # disagree: the gap said Simple & Smart, the chats said the @lid identity class, and
  # the loop spent the iteration on Simple & Smart.
  #
  # It is still derived, not chosen by a model mid-turn: the analyst writes a ranked
  # file, and this reads the top entry. Falls back to the widest gap when there is no
  # analysis, so the loop can never be left with no aim.
  ATTEMPTS="$(grep -c "──────── iteration $ITER ────────" "$ORCH/loop.log" 2>/dev/null || echo 1)"
  TARGET_CAP="$(python3 - "$STATE/capability_scorecard.json" "$STATE/chat-root-causes.md" "$ATTEMPTS" "${NEXEO_TARGET_CAPABILITY:-}" "$STATE/capability-priority" <<'PYTGT'
import json, os, re, sys
p = sys.argv[1]

# OWNER PRIORITY WINS — owner, 2026-08-18: "there should be option where i can select
# priority of capability that has to be improved through manual call or overnight run."
#
# Two ways in, checked before anything the loop would choose for itself:
#   NEXEO_TARGET_CAPABILITY="Simple & Smart"   — one manual run
#   state/capability-priority                  — persists across runs, and is the file a
#                                                UI button would write, so the button can
#                                                be added later without touching the loop
#
# VALIDATED against the nine, never trusted as typed. An unrecognised name FALLS THROUGH
# to the loop's own choice and says so on stderr — silently accepting "Self Healing" for
# "Self-Healing" would aim a whole overnight run at nothing while the deck showed a
# target the scorer has never heard of.
def _valid_names():
    try:
        return [c["name"] for c in json.load(open(p))["capabilities"]]
    except Exception:
        return []

_names = _valid_names()
for _src, _want in (("NEXEO_TARGET_CAPABILITY", sys.argv[4] if len(sys.argv) > 4 else ""),
                    ("capability-priority file",
                     (open(sys.argv[5]).read().strip()
                      if len(sys.argv) > 5 and os.path.exists(sys.argv[5]) else ""))):
    if not _want:
        continue
    _hit = next((n for n in _names if n.lower() == _want.strip().lower()), None)
    if _hit:
        print(_hit)
        raise SystemExit
    print(f"run-loop: {_src} names '{_want}', which is not one of "
          f"{_names!r} — ignoring it and choosing by headroom", file=sys.stderr)
try:
    roots = open(sys.argv[2], encoding="utf-8", errors="replace").read()
    caps = re.findall(r"\*\*Capability:\*\*\s*\d+\.\s*([A-Za-z &-]+)", roots)
    # TWO MODES — owner, 2026-08-18.
    #
    #   CONVERSATIONAL (NEXEO_TARGET_SOURCE=chat, the 10-minute watcher): "fix only those
    #   capabilities which observed through conversation." The target is whatever the
    #   analysis of the NEW turns put first. Headroom is irrelevant here: if he just hit
    #   a fabrication, the fix is fabrication, not whichever capability happens to be
    #   furthest from its benchmark.
    #
    #   EVALUATION (default, the nightly run): "run entire brain evaluation and analyze
    #   the gaps and fix it." Rotates by headroom so all nine get worked over time
    #   instead of ten iterations landing on Accurate Communication.
    if os.environ.get("NEXEO_TARGET_SOURCE") == "chat" and caps:
        print(caps[0].strip())
        raise SystemExit

    # ROTATE BY HEADROOM, DO NOT REPEAT THE WINNER.
    #
    # Owner, 2026-08-18: "iterations are only focusing on accurate communications
    # where each iteration should see improvement in each capability."
    #
    # Measured cause: three of nine chat root causes map to Accurate Communication and
    # NONE map to Simple & Smart, so taking the analysis's top item every turn spent ten
    # iterations lifting 79->89 on a capability with 5 points of headroom while Simple &
    # Smart sat at 33 with 59.
    #
    # So the capability is chosen by HEADROOM, cycling one place per iteration, and any
    # capability within 8 points of its professional benchmark is skipped — polishing a
    # nearly-finished capability is the trap that produced this. The chat log still
    # decides WHAT to fix inside that capability; it no longer decides WHICH capability,
    # because it cannot: it has no evidence at all for three of the nine.
    try:
        caps_card = json.load(open(p))["capabilities"]
        ranked = [c["name"] for c in sorted(
            caps_card, key=lambda c: (c.get("professional") or 0) - (c.get("nexeo") or 0),
            reverse=True)
            if (c.get("professional") or 0) - (c.get("nexeo") or 0) > 8]
        if ranked:
            try:
                attempts = int(sys.argv[3])
            except Exception:
                attempts = 1
            print(ranked[(max(attempts, 1) - 1) % len(ranked)])
            raise SystemExit
    except SystemExit:
        raise
    except Exception:
        pass
    if caps:
        # Rotate one place down the ranked list per 3 failed attempts. The list is
        # Codex's ranking of the owner's own reported failures, so every entry is
        # real work — rotating changes the attack, not the goal.
        try:
            attempts = int(sys.argv[3])
        except Exception:
            attempts = 1
        print(caps[min((max(attempts, 1) - 1) // 3, len(caps) - 1)].strip())
        raise SystemExit
except SystemExit:
    raise
except Exception:
    pass
try:
    caps = json.load(open(p))["capabilities"]
    w = max(caps, key=lambda c: (c.get("professional") or 0) - (c.get("nexeo") or 0))
    print(w["name"])
except Exception:
    print("UNKNOWN")
PYTGT
)"
  say "TARGET iter=$ITER widest capability gap: $TARGET_CAP"

  # ── HOLD UNTIL THE NUMBER MOVES ───────────────────────────────────────────
  #
  # Owner, 2026-08-17: "we should not move to next iteration until we get some
  # improvement in brain overall."
  #
  # Implemented as a HOLD ON THE WORK, not on the counter: the iteration number still
  # advances so every turn keeps its own log, card and review, but the turn is told it
  # is a continuation — same capability, no new scope — until BRAIN overall rises.
  #
  # CAPPED, and the cap is not negotiable. This file already records the failure mode:
  # "Without a cap this becomes an infinite loop on one stubborn finding, burning $20 a
  # turn — the failure mode of every retry-until-green mechanism this project has
  # recorded." A capability can also be genuinely immovable this month; holding forever
  # would spend the budget proving that. At the cap the loop moves to the next-widest
  # gap and SAYS SO, rather than quietly giving up or quietly continuing.
  HOLD_LIMIT="${NEXEO_HOLD_LIMIT:-3}"
  HOLD_NOTE="Not applicable — this is not a continuation turn."
  HOLD_COUNT=0
  [ -s "$STATE/hold-count" ] && HOLD_COUNT="$(cat "$STATE/hold-count")"
  OVERALL_NOW="$(python3 - "$STATE/capability_scorecard.json" <<'PYOV'
import json, sys
try:
    h = json.load(open(sys.argv[1]))["history"]
    print(h[-1].get("overall", ""))
except Exception:
    print("")
PYOV
)"
  OVERALL_PREV="$(cat "$STATE/overall-last" 2>/dev/null || echo "")"
  if [ -n "$OVERALL_NOW" ] && [ -n "$OVERALL_PREV" ]; then
    if awk "BEGIN{exit !($OVERALL_NOW > $OVERALL_PREV)}"; then
      say "HOLD   iter=$ITER BRAIN overall $OVERALL_PREV -> $OVERALL_NOW — it MOVED; new work is allowed"
      HOLD_COUNT=0
    else
      HOLD_COUNT=$((HOLD_COUNT + 1))
      if [ "$HOLD_COUNT" -ge "$HOLD_LIMIT" ]; then
        # NO ESCAPE HATCH. Owner, 2026-08-17, after seven iterations with no movement:
        # "you will only move to next iteration once we have improved it."
        #
        # The earlier version moved to the next-widest gap at the cap. That is what
        # produced 58 iterations across nine capabilities with two of them ever moving:
        # each capability got a few attempts, none got finished, and the counter went up
        # regardless. The hold now persists and the instruction ESCALATES instead.
        #
        # The money bound is no longer this cap; it is MAX_ITER (40) and the owner
        # watching. That is a deliberate trade he made explicitly, twice.
        say "HOLD   iter=$ITER no movement after $HOLD_COUNT turns on $TARGET_CAP — HOLDING, not moving on"
        HOLD_NOTE="ATTEMPT $HOLD_COUNT ON $TARGET_CAP, AND IT HAS NOT MOVED. BRAIN overall is still $OVERALL_NOW. You do NOT change capability and you do NOT start new work — the owner has ruled that the loop does not advance until this number rises. Everything you have tried on $TARGET_CAP so far has failed to reach him, so do not repeat that approach: state in your build entry what you now believe the REAL obstacle is, and attack that instead. If you believe the obstacle is that the work is not reaching production, say so plainly — that is a finding, not a failure."
      else
        say "HOLD   iter=$ITER BRAIN overall flat at $OVERALL_NOW — continuation turn $HOLD_COUNT/$HOLD_LIMIT on $TARGET_CAP"
        HOLD_NOTE="CONTINUATION TURN $HOLD_COUNT of $HOLD_LIMIT. BRAIN overall did NOT move last turn (still $OVERALL_NOW). Do NOT start new work and do NOT change capability. Go deeper on $TARGET_CAP: the previous turn's change was insufficient or did not reach a live surface. Say in your build entry what you now believe was wrong about the last attempt."
      fi
    fi
  fi
  printf '%s' "$HOLD_COUNT" > "$STATE/hold-count"
  [ -n "$OVERALL_NOW" ] && printf '%s' "$OVERALL_NOW" > "$STATE/overall-last"

  # ── CHAT ANALYSIS (Codex) — the owner's experience, before anything is built ─
  #
  # Owner, 2026-08-17: "someone should review chat log … at which stage? before
  # building so builder can incorporate it."
  #
  # CACHED ON THE ARCHIVE'S CONTENT. The 18 chats change only when the owner reports a
  # new one, so re-analysing them every ~30 minutes would spend ~$20 a turn re-reading
  # static text — while the same owner asked for SHORTER iterations. The hash makes
  # this a real stage that costs nothing on the iterations where nothing changed.
  # HARVEST THE OWNER'S LIVE CONVERSATIONS FIRST.
  #
  # Owner, 2026-08-18: "i don't want to paste the conversation, i want you to read it by
  # yourself and analyze it and fix it — this is the capability of Self Healing."
  #
  # brain_chat_archive.md is hand-written and stopped at Chat 17 on 2026-08-04. The
  # database held 424 turns the loop had never read, the newest 13 minutes old, including
  # "Delete all actionable items" -> "no dispatcher for this action in a confirmed plan".
  # Every target the loop chose for two weeks was computed from stale evidence.
  #
  # Every tenant and every user, deliberately unfiltered — see harvest-chats.js.
  if [ -f "$ROOT/scripts/orchestrator/harvest-chats.js" ]; then
    if ( cd "$ROOT/server" && node -r dotenv/config \
           "$ROOT/scripts/orchestrator/harvest-chats.js" --days 14 ) >> "$ORCH/harvest.log" 2>&1; then
      say "CHAT   iter=$ITER harvested the live conversations from the database"
    else
      # Never fatal. A failed harvest means the analyst reads the hand-written archive,
      # which is worse but not nothing — and stopping the iteration over it would trade
      # a stale input for no iteration at all.
      say "CHAT   iter=$ITER harvest FAILED (see harvest.log) — falling back to the written archive"
    fi
  fi

  CHATROOTS_FILE="$STATE/chat-root-causes.md"
  # The harvested transcript is the primary evidence; the curated archive is the fallback
  # and still carries the symptom-tag vocabulary the deck matches against.
  CHAT_SRC="$STATE/recent-chats.md"
  [ -s "$CHAT_SRC" ] || CHAT_SRC="$ROOT/server/docs/brain_chat_archive.md"
  CHAT_HASH_FILE="$STATE/chat-archive-hash"
  if [ -f "$CHAT_SRC" ]; then
    CHAT_HASH_NOW="$(sha256sum "$CHAT_SRC" "$ROOT/server/docs/brain_evaluation_chart.md" 2>/dev/null | sha256sum | awk '{print $1}')"
    CHAT_HASH_WAS="$(cat "$CHAT_HASH_FILE" 2>/dev/null || echo "")"
    if [ "$CHAT_HASH_NOW" != "$CHAT_HASH_WAS" ] || [ ! -s "$CHATROOTS_FILE" ]; then
      CHAT_SEEN="$(cat "$STATE/chat-chats-analysed" 2>/dev/null || echo 0)"
      # Count the heading the ACTIVE source actually uses. The harvested transcript is
      # split into "## Session" blocks and the curated archive into "## Chat" ones, so a
      # single hard-coded pattern read 0 against the harvest and the analyst was handed
      # "18 of 0 chats already analysed" — a sentence with no meaning, in the one place
      # that tells it what is new.
      CHAT_TOTAL="$(grep -cE '^## (Chat|Session) ' "$CHAT_SRC" 2>/dev/null || echo 0)"
      # And "seen" cannot exceed what exists: a stale count from the previous source
      # would tell it everything had been read when nothing had.
      [ "$CHAT_SEEN" -le "$CHAT_TOTAL" ] 2>/dev/null || CHAT_SEEN=0
      say "CHAT   iter=$ITER archive changed — $CHAT_SEEN of $CHAT_TOTAL chats already analysed; sending the new ones"
      CHAT_PROMPT="$(cat "$PROMPTS/chat-analysis.md")
## Your previous ranking — carry it forward
$(cat "$CHATROOTS_FILE" 2>/dev/null || echo '(none — this is the first analysis, read the whole archive)')

## What is new since that ranking
$CHAT_SEEN of $CHAT_TOTAL chats in brain_chat_archive.md were covered by the ranking
above. Read only the chats AFTER that point, plus the recurrence table, and UPDATE the
ranking: move an item up when a new chat is another occurrence of it, add what is
genuinely new, and drop nothing silently — if you remove an item, say why.
Do NOT re-derive the whole archive from scratch. Rescoring history each time produces
noise that looks like new findings, which is the same failure the scoring seat was
told to avoid."
      if run_chat_analyst "$ITER" "$CHAT_PROMPT"; then
        cp "$LOGS/iter-$(printf '%02d' "$ITER")-chat-last.txt" "$CHATROOTS_FILE" 2>/dev/null \
          && printf '%s' "$CHAT_HASH_NOW" > "$CHAT_HASH_FILE" \
          && printf '%s' "$CHAT_TOTAL" > "$STATE/chat-chats-analysed" \
          && say "CHAT   iter=$ITER root causes written to chat-root-causes.md" \
          || say "CHAT   iter=$ITER analysis produced no output — the builder gets the previous list"
      else
        say "CHAT   iter=$ITER codex returned non-zero — the builder gets the previous list"
      fi
    else
      say "CHAT   iter=$ITER archive unchanged — reusing the cached root causes (no paid call)"
    fi
  fi
  CHATROOTS="$(cat "$CHATROOTS_FILE" 2>/dev/null || echo "Not yet analysed — no chat root causes available this iteration.")"

  # THE OWNER'S OPEN SYMPTOM LIST, and on a conversational run it IS the objective.
  #
  # Owner, 2026-08-18: "Conversational Cron (10m) should clear Chat Log gaps like
  # whatsapp-lid-activity-rejected x4, capability-fabrication x3 ..."
  #
  # These are the symptoms he reported that no SHIPPED fix has yet named. Two of the six
  # are already struck (capability-fabrication via `fabricated-status`, stale-contact-data
  # via `protection-with-two-implementations`), which is what makes the rest a finite
  # worklist rather than a mood. Read from pulse.py --open-symptoms so the builder is
  # aimed at exactly the list the owner is looking at — one implementation, two readers.
  OPEN_SYMPTOMS="$(timeout 90 python3 "$ROOT/scripts/orchestrator/pulse.py" --open-symptoms 2>/dev/null \
    | awk -F'\t' '{printf "  - `%s` — reported in %s of his conversations, still not shipped\n", $1, $2}')"
  [ -n "$OPEN_SYMPTOMS" ] || OPEN_SYMPTOMS="  (none open — every reported symptom has a shipped fix naming it)"
  if [ "${NEXEO_TARGET_SOURCE:-}" = "chat" ]; then
    say "CHAT   iter=$ITER conversational run — clearing the owner's open symptom list"
    OPEN_SYMPTOMS="THIS RUN'S OBJECTIVE IS TO CLEAR ONE OF THESE. Pick the top one you can
actually close, fix it at the root, and NAME ITS TAG VERBATIM in your commit — the tag is
what strikes it off his deck. Do not work anything else this run.

$OPEN_SYMPTOMS"
  fi

  # ── THE CAPABILITY GAPS, for the builder to aim at ────────────────────────
  # Owner, 2026-08-17: "build will read capability evaluation and see how we can
  # improve further, where is the gap." Rendered from the card the evaluation stage
  # wrote MINUTES ago, sorted widest gap first. Without this the builder had the cap
  # rule (@@CAP@@) but never the scores themselves — it was told not to repeat a
  # capability claim, and never told which capability was weakest.
  # Path passed as argv, NOT through the environment. $STATE is a shell variable the
  # loop never exports, so os.environ.get("STATE") was "" and this printed UNKNOWN on
  # every iteration — the builder was handed "TARGET THIS ITERATION: UNKNOWN" four
  # times running and aimed blind. Every other heredoc here passes paths as argv.

  # ── HANDSHAKE: did the LAST iteration's target actually move? ─────────────
  if [ -s "$STATE/target-capability" ]; then
    PREV_TARGET="$(cat "$STATE/target-capability")"
    python3 - "$STATE/capability_scorecard.json" "$PREV_TARGET" "$STATE/aim-history" <<'PYAIM' \
      | while read -r line; do say "$line"; done
import json, sys
card_p, target, hist_p = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    card = json.load(open(card_p))
    hist = card.get("history") or []
    if len(hist) < 2:
        print(f"AIM    baseline only — no prior card to compare {target} against")
        raise SystemExit
    def snap(h):
        return {c["name"]: c["nexeo"] for c in (h.get("snapshot") or [])}
    before, after = snap(hist[-2]), snap(hist[-1])
    b, a = before.get(target), after.get(target)
    if b is None or a is None:
        print(f"AIM    {target} not present in both cards — cannot compare")
        raise SystemExit
    delta = a - b
    hit = "HIT" if delta > 0 else "MISS"
    with open(hist_p, "a") as fh:
        fh.write(f"{target}\t{b}\t{a}\t{delta}\t{hit}\n")
    rows = [l.split("\t") for l in open(hist_p).read().splitlines() if l.strip()]
    hits = sum(1 for r in rows if r[-1] == "HIT")
    print(f"AIM    {hit}: {target} {b} -> {a} ({delta:+d}) · hit rate {hits}/{len(rows)}")
except Exception as e:
    print(f"AIM    could not evaluate the handshake: {e}")
PYAIM
  fi
  printf '%s' "$TARGET_CAP" > "$STATE/target-capability"


  CAPGAPS="$(python3 - "$STATE/capability_scorecard.json" <<'PYGAP'
import json, sys
p = sys.argv[1]
try:
    caps = json.load(open(p))["capabilities"]
except Exception as e:
    print(f"(no capability card readable: {e})")
else:
    rows = sorted(caps, key=lambda c: (c.get("professional") or 0) - (c.get("nexeo") or 0),
                  reverse=True)
    print("| capability | nexeo | professional | gap |")
    print("|---|---|---|---|")
    for c in rows:
        gap = (c.get("professional") or 0) - (c.get("nexeo") or 0)
        print(f"| {c['name']} | {c.get('nexeo')} | {c.get('professional')} | {gap} |")
    w = rows[0]
    print()
    print(f"WIDEST GAP: **{w['name']}** at {w.get('nexeo')} against "
          f"{w.get('professional')} — {(w.get('professional') or 0) - (w.get('nexeo') or 0)} points.")
PYGAP
)"

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
    BASELINE "$BASELINE_OVERALL" CAPGAPS "$CAPGAPS" TARGETCAP "$TARGET_CAP" \
    HOLD "$HOLD_NOTE" CHATROOTS "$CHATROOTS" OPENSYMPTOMS "$OPEN_SYMPTOMS")"
  # Save what the Builder was actually told. I could not verify that iteration 20's
  # remediation note reached the prompt, because the rendered text only ever lived
  # in this variable — so "the rail fired" and "the Builder was instructed" were
  # two different claims and I could only evidence the first. A loop that mediates
  # between agents through documents has to keep the document it sent.
  printf '%s' "$BUILD_PROMPT" > "$LOGS/iter-$ITER-build-prompt.md"
  run_claude "$ITER" "$BUILD_PROMPT" || say "BUILD  iter=$ITER claude returned non-zero — continuing, the rails below will judge the tree"

  # ── DEAD-BUILD RAIL ────────────────────────────────────────────────────────
  # An iteration whose Builder produced NOTHING must not be reviewed, scored or
  # counted. Twice now the seat has died on resume with terminal_reason=api_error
  # — 0 tokens, $0.00, one turn, three seconds — and the loop carried on regardless:
  # iterations 31-40 and again 44-49. Sixteen iterations were announced, reviewed by
  # Codex and scored by Grok over a tree that had not changed, while build_log.md
  # sat at Iteration 30 and then at 43. Codex was reduced to writing "there is no
  # Iteration N section" nine times running, and every one of those verdicts cost
  # real money and told the owner an iteration had happened.
  #
  # The test is the TREE, not the exit code: `claude -p` exits 0 on an api_error and
  # the formatter prints "result success" beside error=True, so neither is a signal.
  # No new commit and a clean worktree means no work, whatever anything claims.
  # Scoped to BRAIN paths on purpose. HEAD alone is the wrong test: the
  # orchestrator commits to this branch too (the Deck, this script, the loop's own
  # records), so a busy orchestrator would mask a dead Builder and the rail would
  # never fire on the very day it is needed. Codex found the same confusion from
  # the other side at iteration 41 — "six non-DEF commits mixed into the range".
  BUILD_TOUCHED="$(git -C "$ROOT" diff --name-only "$BASE_HEAD" HEAD -- server/src server/tests server/prisma 2>/dev/null | head -1)"
  BUILD_DIRTY="$(git -C "$ROOT" status --porcelain -- server/src server/tests server/prisma 2>/dev/null | head -1)"
  if [ -z "$BUILD_TOUCHED" ] && [ -z "$BUILD_DIRTY" ]; then
    DEAD_BUILDS=0
    [ -s "$STATE/dead-builds" ] && DEAD_BUILDS="$(cat "$STATE/dead-builds")"
    DEAD_BUILDS=$((DEAD_BUILDS + 1))
    printf '%s' "$DEAD_BUILDS" > "$STATE/dead-builds"
    say "DEAD   iter=$ITER — the Builder produced NO commit and left a clean tree. Not reviewing, not scoring, not counting it (consecutive: $DEAD_BUILDS)"

    # The known cause is a resumed transcript that has grown until it fails on
    # every resume. Rotating the seat is cheap and reversible; leaving a dead seat
    # in place costs a full iteration each time. Two strikes, because a single
    # api_error is often transient and the session's context is worth keeping.
    if [ "$DEAD_BUILDS" -ge 2 ]; then
      OLD_SID="$(cat "$STATE/builder-session-id" 2>/dev/null)"
      # A PINNED session is the owner's, not the loop's, and is never rotated away.
      # Owner, 2026-08-17, created a session for build and deploy and pointed the
      # builder at it; two dead builds would otherwise have replaced it with a random
      # uuid and said so only in a log line he was not reading. Rotating a seat the
      # loop opened is cheap; discarding one he opened is not the loop's call.
      if [ -f "$STATE/builder-session-pinned" ]; then
        printf '0' > "$STATE/dead-builds"
        say "DEAD   builder seat $OLD_SID is PINNED by the owner — not rotating; the dead-build count is cleared and the same seat is retried"
      else
        NEW_SID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
        printf '%s' "$NEW_SID" > "$STATE/builder-session-id"
        printf '0' > "$STATE/dead-builds"
        say "DEAD   rotating the Builder seat $OLD_SID -> $NEW_SID (a fresh seat opens next iteration)"
      fi
    fi

    say "SHIP   iter=$ITER deployed=no capability_moved=no (dead build — no work product)"
    # Do not spin. A dead build closes in seconds, so without this the loop burns
    # its whole iteration budget in minutes and the deck fills with failed turns
    # that never reached an API. Iteration 51 to 52 took 63 seconds.
    sleep 60
    continue
  fi
  printf '0' > "$STATE/dead-builds"

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
    # NO BUILD HERE EITHER. This emitted into the deployed server/dist once per
    # iteration — the same forbidden write as the old PREP step, forty times over,
    # and it only logged FAILED so it would have gone on doing it silently.
    # tsc_status above already ran `npx tsc --noEmit`, which AGENTS.md §5 names as
    # the check; an emitting build adds no verification, only risk.
    say "RAILS  iter=$ITER build check = tsc --noEmit (no emit into the deployed dist)"
    TESTS_AFTER="$(test_status)"
    say "RAILS  iter=$ITER tests=$TESTS_AFTER"
    # G4 — MEASURE is blocking again, and runs BEFORE the review. The owner ruled
    # the phases are a sequence; the overlap also cost Codex this iteration's score,
    # which is what produced its strongest early finding.
    if [ "${NEXEO_TARGET_SOURCE:-}" = "chat" ]; then
      say "MEASURE iter=$ITER skipped — conversational pulse; deploy.sh still runs tsc and vitest at the deploy commit"
      # NOT started, so nothing is collected later. It was set to 1 unconditionally, which
      # sent the collector after a benchmark that was never launched — it returns 1 and logs
      # "nothing pending to collect", making a correctly-skipped stage look like a failed one.
      MEASURE_STARTED=0
    else
      measure "$ITER" "post-build" || say "MEASURE iter=$ITER failed — the reviewer is told the score is missing"
      MEASURE_STARTED=1
    fi
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
  # ── DEPLOY — BEFORE the review. Owner's ruling, 2026-08-17 ────────────────
  #
  # "since we are on live server … considering self healing (where no testing is
  # involved by any human) so it should be deployed what is built, and codex will
  # review what is built or deployed and grok will analyse what is built or deployed."
  #
  # WHAT THIS BUYS: Codex and Grok both then judge the RUNNING system rather than a
  # branch nobody is executing. That was the whole reason the capability score sat at
  # 47.7 for a day — the scorer credits only what reaches the owner, and nothing did.
  #
  # WHAT IT COSTS, stated plainly because nothing else in this file will say it: with
  # the review moved after the ship, NO MODEL LOOKS AT THE DIFF BEFORE IT REACHES
  # PRODUCTION. The gate is now `tsc --noEmit` + `vitest` above, and after the ship the
  # HTTP probe with rollback inside deploy.sh. Codex becomes a detector, not a gate —
  # a CRITICAL finding is now something the owner learns about from a deployed system.
  # NEXEO_DEPLOY_ON=always because there is no review verdict yet to read.
  if [ "$DEPLOY" = "1" ]; then
    NEXEO_DEPLOY_ON=always "$ROOT/scripts/orchestrator/deploy.sh" "$ITER" \
      || say "DEPLOY iter=$ITER did not ship (see the deploy log)"
  fi

  REVIEW_PROMPT="$(render "$PROMPTS/review.md" \
    ITER "$ITER" TARGET "$TARGET" \
    OVERALL "$BENCH_OVERALL" MINSCORE "$BENCH_MIN" WEAKEST "$BENCH_WEAKEST" \
    SCOREJSON "${BENCH_JSON:-none}" SCORESTATE "$SCORE_STATE" \
    TSC "$TSC_AFTER" TESTS "$TESTS_AFTER" \
    BASEHEAD "$(git rev-parse --short "$BASE_HEAD")" HEAD "$(git rev-parse --short HEAD)" \
    DIFFSTAT "$DIFF_STAT" \
    BUILDDOC "$BUILD_DOC" REVIEWDOC "$REVIEW_DOC" \
    TARGETCAP "$TARGET_CAP" CAPGAPS "$CAPGAPS")"
  if [ "${NEXEO_TARGET_SOURCE:-}" = "chat" ]; then
    say "REVIEW iter=$ITER skipped — conversational pulse; the nightly run reviews what accumulated"
  else
    run_codex "$ITER" "$REVIEW_PROMPT" || say "REVIEW iter=$ITER reviewer returned non-zero — continuing"
  fi

  check_forbidden "$ITER" "$BASE_HEAD" || true

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
  # SCORE THE TREE THE BUILD PRODUCED — owner, 2026-08-24: "how can we make pulse healing so
  # that can start improving brain's capabilities".
  #
  # Only reached on a LIVE build: a dead one `continue`s far above, so the scorer is never spent
  # on a turn that changed no code. That matters — 17 of the last 29 builds produced nothing, and
  # scoring those would have been pure cost.
  #
  # Why this exists at all: the card the loop was reading below is the PRE-BUILD one, taken
  # before the builder starts, because that is what the builder aims at. Reading it afterwards to
  # ask "did this iteration move capability" is asking a photograph taken at the start of the
  # race who won. In 11 SHIP lines the answer was `no` 6 times and `unknown` 5 times and `yes`
  # never — not because nothing moved, but because nothing could ever have been detected.
  CAP_POST="$SCORES/iter-$(printf '%02d' "$ITER")-capability-post.json"
  if [ -x "$ROOT/scripts/orchestrator/run-score.sh" ]; then
    say "SCORE  iter=$ITER post-build scoring (the build changed code — this is the half that can say it moved)"
    if "$ROOT/scripts/orchestrator/run-score.sh" "$ITER" --post >/dev/null 2>&1; then
      if python3 "$ROOT/scripts/orchestrator/scorecard.py" --ingest "$CAP_POST" \
           --iteration "$ITER" --head "$(git -C "$ROOT" rev-parse --short HEAD)" \
           --commit --append --label "Post-Build" >> "$ORCH/score.log" 2>&1; then
        say "SCORE  iter=$ITER post-build card appended"
      else
        say "SCORE  iter=$ITER post-build INGEST REJECTED (see score.log) — removed, capability stays UNKNOWN"
        rm -f "$CAP_POST"
      fi
    else
      say "SCORE  iter=$ITER post-build scorer FAILED — capability stays UNKNOWN for this iteration"
    fi
  fi

  # Read the POST-build card, and zero-pad the iteration. Both were bugs: this line read the
  # pre-build card, and it built the name unpadded (`iter-9-`) while run-score.sh writes padded
  # (`iter-09-`), so for every single-digit iteration the file it looked for could not exist.
  CAP_MOVED="$(python3 - "$CAP_POST" <<'PYEOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("unknown"); raise SystemExit
v = (d.get("overall_verdict") or "").upper()
if v != "PROGRESSIVE":
    print("no"); raise SystemExit
# PROGRESSIVE alone is not this turn's doing. At iteration 23 the card was
# PROGRESSIVE while `what_moved` said, in the scorer's own words, "scorer
# correction, not DEF-169" — so the loop logged "ITERATION 23 reached the owner"
# on a turn that deployed nothing. The scorer was honest; this read was not.
# A card with no attribution field scores "unknown", never "yes": a missing
# answer must not default to progress.
a = (d.get("movement_attribution") or "").upper()
if not a:
    print("unknown")
else:
    print("yes" if a == "ITERATION_WORK" else "no")
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
# Reaching this point is what "finished" MEANS — set the flag before choosing the code, so the
# trap above stops treating this as an abort. 0 = gate passed, 2 = finished but gate did not.
FINISHED_CLEANLY=1
if [ "$BENCH_GATE" = "pass" ]; then ORCH_RC=0; else ORCH_RC=2; fi
say "exit rc=$ORCH_RC ($([ "$ORCH_RC" = "0" ] && echo 'gate passed' || echo 'finished, gate did not pass — NOT a failure'))"
exit "$ORCH_RC"
