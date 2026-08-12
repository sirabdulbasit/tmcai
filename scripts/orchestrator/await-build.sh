#!/usr/bin/env bash
#
# await-build.sh — wait for the Builder's turn to actually finish.
#
# Owner, 2026-08-12: *"i am unable to see it running in claude in session"* — said
# THIRTY MINUTES AFTER iteration 3 had completed.
#
# WHAT WENT WRONG. When the Builder ran headless, the process exiting WAS the
# completion signal. Once it moved into a visible IDE session there was no signal
# at all: it finished, wrote its report into its own window, and went quiet. I was
# waiting to be told; it had no reason to tell me. So the orchestrator sat idle
# while the work was done, and from outside a finished turn and a dead turn look
# exactly the same.
#
# The fix is to OBSERVE completion instead of being notified of it. Two facts the
# Builder cannot finish without producing, both on disk:
#
#   1. `## Iteration N` appended to build_log.md   (its required report)
#   2. a new commit on HEAD                        (its required commit)
#
# Both are required, deliberately. The build log alone can be written before the
# commit; a commit alone can be someone else's. Requiring the pair means a turn is
# only "done" when it has done the two things that make it reviewable.
#
# ANCHORING MATTERS. "A new commit" is relative to something, and by default that
# is HEAD when this script starts — which is correct only if it is launched BEFORE
# the turn is handed over. Started afterwards, the commit it is waiting for has
# already happened and it would wait forever: a watcher that hangs on completed
# work is worse than no watcher. `--since <head>` states the anchor explicitly for
# exactly that case (and makes the self-test possible).
#
# Usage:
#   await-build.sh 3                       # anchor at current HEAD, then wait
#   await-build.sh 3 --since 545a69a        # anchor at a known pre-turn commit
#   await-build.sh 3 --timeout 2400         # give up after 40 min (exit 3)
#
# Exit: 0 done · 3 timed out · 4 bad arguments
set -uo pipefail

ORCH="/var/www/tmcai/server/docs/orchestrator"
BUILD_DOC="$ORCH/build_log.md"
ITER="${1:?usage: await-build.sh <iteration> [--since <head>] [--timeout <seconds>]}"
shift
TIMEOUT=3600
SINCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) TIMEOUT="${2:-3600}"; shift 2;;
    --since)   SINCE="${2:-}"; shift 2;;
    *) echo "await-build: unknown argument $1" >&2; exit 4;;
  esac
done

case "$ITER" in ''|*[!0-9]*) echo "await-build: iteration must be a number" >&2; exit 4;; esac

if [ -n "$SINCE" ]; then
  START_HEAD="$(git -C /var/www/tmcai rev-parse "$SINCE" 2>/dev/null)" \
    || { echo "await-build: cannot resolve --since $SINCE" >&2; exit 4; }
else
  START_HEAD="$(git -C /var/www/tmcai rev-parse HEAD)"
fi
t0="$(date +%s)"
printf 'awaiting iteration %s — build_log section AND a new commit (from %s)\n' \
  "$ITER" "$(git -C /var/www/tmcai rev-parse --short "$START_HEAD")"

while :; do
  have_section=0
  [ -f "$BUILD_DOC" ] && grep -qE "^## Iteration ${ITER}\b" "$BUILD_DOC" && have_section=1
  now_head="$(git -C /var/www/tmcai rev-parse HEAD)"
  have_commit=0
  # The commit must touch BRAIN paths. "HEAD moved" is not enough: the
  # orchestrator commits to this same repo, and on its first real use this
  # watcher fired on one of MY commits (the pulse fix) while the Builder was
  # still working — the exact "a commit alone could be someone else's" case the
  # docstring warned about and the code did not guard. Reaching the right
  # conclusion by luck is not a working detector.
  if [ "$now_head" != "$START_HEAD" ]; then
    if [ -n "$(git -C /var/www/tmcai diff --name-only "$START_HEAD" "$now_head" \
                 -- server/src server/tests server/prisma server/docs/brain_change_log.md)" ]; then
      have_commit=1
    fi
  fi

  # And the turn must have gone QUIET. The Builder commits its code and then keeps
  # working — updating the governing docs, re-running verification. Measuring while
  # it is mid-edit would score a tree it has not finished, and attribute the result
  # to a change that is still moving.
  quiet=1
  sid_file="$ORCH/state/builder-session-id"
  if [ -s "$sid_file" ]; then
    tp="/root/.claude/projects/-var-www-tmcai/$(cat "$sid_file").jsonl"
    if [ -f "$tp" ]; then
      age=$(( $(date +%s) - $(stat -c %Y "$tp") ))
      [ "$age" -lt 90 ] && quiet=0
    fi
  fi
  [ "$quiet" -eq 0 ] && have_commit=0

  if [ "$have_section" -eq 1 ] && [ "$have_commit" -eq 1 ]; then
    printf 'iteration %s DONE — %s → %s\n' "$ITER" \
      "$(git -C /var/www/tmcai rev-parse --short "$START_HEAD")" \
      "$(git -C /var/www/tmcai rev-parse --short "$now_head")"
    git -C /var/www/tmcai log --oneline "$START_HEAD..$now_head"
    exit 0
  fi

  elapsed=$(( $(date +%s) - t0 ))
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    # Reported as a timeout, never as completion. A turn that stalled and a turn
    # that finished must not produce the same outcome — that conflation is what
    # cost the thirty minutes this script exists to prevent.
    printf 'TIMEOUT after %ss — section=%s commit=%s. The turn may be stalled, or waiting on a permission prompt in its window.\n' \
      "$elapsed" "$have_section" "$have_commit" >&2
    exit 3
  fi
  sleep 15
done
