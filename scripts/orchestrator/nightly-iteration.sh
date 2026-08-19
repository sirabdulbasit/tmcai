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
# WORST-CASE COST is one iteration: ~$7 at the mean, ~$21 at the worst build observed.
# With the builder now capped at 40 turns the tail is shorter than that observed max.
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
  say "an iteration is already running — skipping tonight's run rather than starting a second builder"
  exit 0
fi

PRIORITY="$(cat "$ORCH/state/capability-priority" 2>/dev/null || true)"
RUN_STARTED="$(date -u +%s)"
say "starting ONE iteration · deploy=1 · priority='${NEXEO_TARGET_CAPABILITY:-${PRIORITY:-by headroom}}'"

cd "$ROOT" || exit 1
NEXEO_MAX_ITER=1 NEXEO_DEPLOY=1 \
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
say "finished rc=$rc · build cost \$$COST"
exit "$rc"
