#!/usr/bin/env bash
#
# score-daemon.sh — the SCORING seat, running unattended.
#
# Owner, 2026-08-12: *"everything should be run without any intervention and keep
# updating progress on window"*, having just added Grok as the third agent.
#
# WHY A SEPARATE PROCESS RATHER THAN A PHASE IN THE LOOP. The scoring phase belongs
# in `nexeo-loop.sh`, and that is where it will end up. But bash reads a running
# script incrementally from disk, so editing the loop while it is executing can
# corrupt the run — and the loop is running now, on the owner's standing
# instruction that it must not stop. A daemon gets scoring working today without
# touching a live script, which is the safe order of operations.
#
# It watches for iterations that are COMPLETE and UNSCORED, which means all three
# of these:
#   1. `scores/iter-NN-post-build.json` exists   (the benchmark measured it)
#   2. `review_log.md` has `## Iteration NN`      (Codex reviewed it)
#   3. `scores/iter-NN-capability.json` is absent (Grok has not scored it)
#
# All three matter. Scoring before Codex has ruled means the scorer judges work a
# reviewer may be about to refute; scoring twice would append two history rows for
# one iteration and double-count the movement.
#
# It runs ONE iteration per pass and sleeps, deliberately: a burst of scoring
# passes over several unscored iterations would each carry the previous card
# forward, and the ordering would decide the numbers.
#
# Usage:
#   score-daemon.sh                 # forever, 60s poll
#   score-daemon.sh --once          # score at most one iteration, then exit
#   score-daemon.sh --interval 30
#
# Stop it: touch server/docs/orchestrator/STOP-SCORING
set -uo pipefail

ROOT="/var/www/tmcai"
ORCH="$ROOT/server/docs/orchestrator"
SCORES="$ORCH/scores"
STOP="$ORCH/STOP-SCORING"
INTERVAL=60
ONCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --once) ONCE=1; shift;;
    --interval) INTERVAL="${2:-60}"; shift 2;;
    *) echo "score-daemon: unknown arg $1" >&2; exit 4;;
  esac
done

log() { printf '%s  SCORE  %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" \
          | tee -a "$ORCH/score.log"; }

# The NEWEST complete unscored iteration, never the oldest.
#
# The first run of this daemon went for iteration 1, which is wrong in a way worth
# recording: Grok scores by reading the CURRENT codebase, so scoring "iteration 1"
# while HEAD sits at iteration 8 would attribute today's code to a week-old turn
# and then compute movement from it. Retroactive capability scoring is not possible
# with a code-reading scorer; only the present state can be judged.
#
# Older unscored iterations are marked skipped, with the reason, so they are not
# revisited and so the gap is visible rather than silent.
next_unscored() {
  local n it best=""
  for f in "$SCORES"/iter-*-post-build.json; do
    [ -f "$f" ] || continue
    n="$(basename "$f")"; n="${n#iter-}"; n="${n%%-*}"
    it=$((10#$n))
    [ -f "$SCORES/iter-$n-capability.json" ] && continue
    grep -qE "^## Iteration ${it}\b" "$ORCH/review_log.md" 2>/dev/null || continue
    [ -z "$best" ] && best="$it"
    [ "$it" -gt "$best" ] && best="$it"
  done
  [ -z "$best" ] && return 1
  # Mark everything older as skipped-by-design.
  for f in "$SCORES"/iter-*-post-build.json; do
    [ -f "$f" ] || continue
    n="$(basename "$f")"; n="${n#iter-}"; n="${n%%-*}"
    it=$((10#$n))
    [ "$it" -ge "$best" ] && continue
    [ -f "$SCORES/iter-$n-capability.json" ] && continue
    printf '{"skipped":true,"reason":"not scored by Grok — a code-reading scorer can only judge the CURRENT tree, and HEAD had already moved past this iteration when scoring began"}\n' \
      > "$SCORES/iter-$n-capability.json"
  done
  printf '%s' "$best"
  return 0
}

log "daemon start (poll ${INTERVAL}s) — watching for complete, unscored iterations"

while :; do
  if [ -f "$STOP" ]; then
    log "STOP-SCORING present — exiting cleanly"; rm -f "$STOP"; break
  fi

  if iter="$(next_unscored)"; then
    log "iteration $iter is complete and unscored — asking Grok"
    # Output is NOT swallowed: the owner asked whether the orchestrator window shows
    # each agent's progress, and for this seat it did not — the daemon discarded
    # exactly the lines that would have shown grok working.
    if "$ROOT/scripts/orchestrator/run-score.sh" "$iter"; then
      json="$SCORES/iter-$(printf '%02d' "$iter")-capability.json"
      head="$(git -C "$ROOT" rev-parse --short HEAD)"
      # --commit persists; --append writes the card into capability_history.md.
      # Failure here must be LOUD and must not consume the iteration: if ingest
      # rejects the JSON (unevidenced score, wrong shape), the capability file is
      # removed so the next pass retries rather than silently skipping an
      # iteration that never got scored.
      if python3 "$ROOT/scripts/orchestrator/scorecard.py" --ingest "$json" \
           --iteration "$iter" --head "$head" --commit --append \
           --label "Post-Build" >> "$ORCH/score.log" 2>&1; then
        log "iteration $iter scored and card appended"
        # CLOSE THE MISSING EDGE. Grok's schema carries `notes_for_builder` — the
        # capability gap it would close next — and until now that insight
        # dead-ended in a JSON file. The scorer can see that Self-Pruning is
        # absent while the Builder polishes honorifics; that is precisely the
        # information the Builder needs and could not get.
        #
        # It is routed through operator_directives.md, the one channel the build
        # prompt already reads, and quoted VERBATIM under the scorer's name. The
        # orchestrator does not paraphrase it: a bridge that speaks in an agent's
        # voice destroys the record of who actually claimed what, which is the
        # reason this loop is document-mediated at all.
        python3 - "$json" "$iter" "$ORCH/operator_directives.md" <<'PYEOF'
import json, sys, datetime
src, iteration, doc = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    g = json.load(open(src))
except Exception:
    sys.exit(0)
note = (g.get("notes_for_builder") or "").strip()
absent = [c["name"] for c in g.get("capabilities", [])
          if c.get("basis") == "absent"]
if not note and not absent:
    sys.exit(0)
body = open(doc).read()
marker = "## S-1 · FROM THE SCORER (Grok), verbatim"
block = [marker, "",
         f"Written after iteration {iteration}. Quoted as given — the orchestrator "
         f"does not paraphrase the scorer.", ""]
if note:
    block += ["**The capability gap it would close next:**", "",
              f"> {note}", ""]
if absent:
    block += ["**Capabilities it found ABSENT in the code** (not merely weak — "
              "nothing implements them):", ""]
    block += [f"- {a}" for a in absent]
    block += ["", "A capability scored `absent` cannot be improved by fixing a "
              "defect on another surface. If one of these is the largest gap to "
              "the owner's objective, building it is worth more than another "
              "point of C4.", ""]
block.append("---")
new_block = "\n".join(block) + "\n\n"
if marker in body:
    head, _, tail = body.partition(marker)
    _, _, rest = tail.partition("---")
    body = head + new_block.rstrip("\n") + "\n" + rest
else:
    # Inserted at the TOP of the directive list so the Builder reads it before the
    # older items, but below the file's own header.
    lines = body.split("\n")
    for i, ln in enumerate(lines):
        if ln.startswith("## "):
            body = "\n".join(lines[:i]) + "\n" + new_block + "\n".join(lines[i:])
            break
    else:
        body = body + "\n" + new_block
open(doc, "w").write(body)
print("routed scorer notes into operator_directives.md")
PYEOF
      else
        log "INGEST REJECTED iteration $iter — see score.log; removing $(basename "$json") so it is retried"
        rm -f "$json"
      fi
    else
      log "grok scoring FAILED for iteration $iter — see logs/iter-$(printf '%02d' "$iter")-score.log"
      # Not retried in a tight loop: a failing scorer would burn tokens every
      # poll. The next pass tries again after the interval.
    fi
  fi

  [ "$ONCE" -eq 1 ] && { log "--once: done"; break; }
  sleep "$INTERVAL"
done
