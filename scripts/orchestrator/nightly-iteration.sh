#!/usr/bin/env bash
#
# nightly-iteration.sh — ONE bounded iteration, once a night.
#
# Owner, 2026-08-18: "since it is consuming so many tokens we need to set once iteration
# over the night auto and manual call through UI."
#
# WHY BOUNDED RATHER THAN SUPERVISED. The continuous loop spent $1,144.32 across 162
# builds, and 37 of those iterations produced nothing — roughly $260 on turns with no
# work product. It also could not stay alive: everything started from a shell session
# was reaped with it, three times in two days. A single cron-launched iteration fixes
# both at once. It cannot run away (NEXEO_MAX_ITER=1), and cron is not reaped by
# anything, so it needs no watchdog.
#
# WORST-CASE COST is one iteration. Measured 2026-08-28 from the builders' own
# `total_cost_usd` result events across 90 runs ($564.85 in total): the worst observed
# build is $45.28 (iteration 47), then $36.37 and $29.58. The figures that stood here
# before — "~$7 at the mean, ~$21 at the worst" — were stale, and they are the numbers
# the build caps were sized against.
#
# The 40-turn cap did NOT shorten the tail, as this comment used to claim: iteration 47
# logged 58 turns against `--max-turns 40`, because sub-agent turns appear in the stream
# without counting toward the cap. Treat 40 as a bound on the main loop only.
#
# WHICH CAPABILITY IT WORKS. In priority order:
#   1. NEXEO_TARGET_CAPABILITY in the environment (a manual run overrides everything)
#   2. state/capability-priority — the owner's standing choice, and the file a UI
#      button will write, so the button needs no change to this script
#   3. otherwise the loop rotates by headroom, skipping anything within 8 points of its
#      benchmark, so it lifts the weakest rather than polishing the strongest
set -uo pipefail

ROOT="/var/www/tmcai"
ORCH="$ROOT/server/docs/orchestrator"
LOG="$ORCH/nightly.log"

say() { printf '%s  NIGHTLY %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$*" >> "$LOG"; }

# Never run two at once. A cron entry that overlaps a still-running iteration would put
# two builders in one tree, which this project has already recorded as an attribution
# mess nobody could untangle.
if python3 - <<'PY'
import os, sys
for pid in os.listdir('/proc'):
    if not pid.isdigit():
        continue
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as fh:
            argv = [a.decode('utf-8', 'replace') for a in fh.read().split(b'\0') if a]
    except Exception:
        continue
    if any(a.endswith('nexeo-loop.sh') for a in argv):
        sys.exit(0)
sys.exit(1)
PY
then
  say "an iteration is already running — skipping this run rather than starting a second builder (one builder in one tree, ever)"
  exit 0
fi

PRIORITY="$(cat "$ORCH/state/capability-priority" 2>/dev/null || true)"
RUN_STARTED="$(date -u +%s)"
say "starting ONE iteration · deploy=1 · priority='${NEXEO_TARGET_CAPABILITY:-${PRIORITY:-by headroom}}'"

cd "$ROOT" || exit 1
# NEXEO_TRIGGER names the SCHEDULE for the spend deck's cron cut. Every seat this iteration
# opens — build, chat, review — writes it beside its run log, so the deck can answer "what did
# the nightly cron cost" separately from a loop someone ran by hand. Unset means manual, so
# this is the only place the nightly attribution can come from.
# THE TRIGGER IS OVERRIDABLE, AND THAT IS THE WHOLE POINT OF THE DEFAULT (2026-09-07).
#
# Since heal-now.sh now runs a FULL pulse through this same script, a manual click would
# otherwise be stamped `cron:nightly-iteration` and land in the spend deck's CRON cut —
# corrupting the one number the comment above exists to protect. heal-now.sh exports
# `manual:heal-now`; cron sets nothing and gets the default.
# THE TURN CAP HAD TO MOVE WITH THE SCOPE (2026-09-07).
#
# build.md rule 4 now asks for every open gap in the target capability rather than one
# change, and 40 turns does not fit five fixes — the brief would have been widened into a
# cap that truncates it, which is a no-op dressed as a decision.
#
# 60, not unbounded, and the number comes from this project's own measurement rather than
# comfort: the worst build ever observed ran 58 turns and cost $45.28 (iteration 47, from
# the builders' own total_cost_usd events across 90 runs). So 60 is bounded by a cost
# already survived once, and the mean run has never been near it. Raise or lower with
# NEXEO_BUILD_MAX_TURNS if the trade changes.
#
# Note the cap bounds the MAIN LOOP only: sub-agent turns appear in the stream without
# counting toward it, which is how iteration 47 logged 58 against a limit of 40.
NEXEO_MAX_ITER=1 NEXEO_DEPLOY=1 \
NEXEO_BUILD_MAX_TURNS="${NEXEO_BUILD_MAX_TURNS:-60}" \
NEXEO_TRIGGER="${NEXEO_TRIGGER:-cron:nightly-iteration}" \
  bash "$ROOT/scripts/orchestrator/nexeo-loop.sh" >> "$ORCH/loop.out" 2>&1
rc=$?

# The cost of the run, read back from the builder's own result event rather than
# estimated — the loop records total_cost_usd per turn and that is the only figure that
# is not a guess.
COST="$(python3 - "$ORCH/logs" "$RUN_STARTED" <<'PY'
import glob, json, os, sys
best = None
# Only count a build log written DURING this run. The newest file otherwise belongs to
# whatever ran last — which is how a 57-second no-op reported $9.85 of someone else's
# spend and looked like it had done a full build.
started = float(sys.argv[2]) if len(sys.argv) > 2 else 0
for f in sorted(glob.glob(os.path.join(sys.argv[1], "iter-*-build.jsonl")),
                key=os.path.getmtime)[-1:]:
    if started and os.path.getmtime(f) < started:
        break
    for line in reversed(open(f, errors="replace").read().splitlines()):
        if '"type":"result"' in line:
            try:
                best = json.loads(line).get("total_cost_usd")
            except Exception:
                pass
            break
print(f"{best:.2f}" if isinstance(best, (int, float)) else "unknown")
PY
)"
# SAY WHICH KIND OF ENDING, not just the number. `nightly.log` recorded `rc=2` six nights
# running and nothing could read it: 2 is the code for "finished, gate did not pass", which is
# a HEALTHY run whose C4 sits below target — but it looks identical to a failure to anyone
# scanning the log, and on 2026-08-24 it fooled me into reporting the nightly as dead. The loop
# now distinguishes 0/2/1 (see nexeo-loop.sh's exit contract); this writes the meaning down so
# the next reader does not have to know that.
case "$rc" in
  0) VERDICT="gate PASSED" ;;
  2) VERDICT="finished, gate did not pass — NOT a failure" ;;
  *) VERDICT="FAILED — the run did not reach its finish line" ;;
esac
say "finished rc=$rc ($VERDICT) · build cost \$$COST"
exit "$rc"
