#!/usr/bin/env bash
#
# supervise.sh — the loop is never idle.
#
# Owner, 2026-08-13, looking at a deck reading "IDLE 1m14s · The build loop is not
# running on this host": *"it should never be in idle"*.
#
# He was right and the cause was my process, not a crash. I arm the STOP file to get
# a clean iteration boundary at which to swap a staged script in — bash parses a
# while loop before executing it, so editing the live file is unsafe — and every one
# of those swaps left the deck reading IDLE until I restarted by hand.
#
# So the safe boundary keeps its meaning and stops being a stoppage:
#
#   STOP  — finish this iteration, then the supervisor restarts. A swap point.
#   HALT  — actually stop. The only thing that ends the loop for good.
#
# The swap now happens HERE, at the boundary, automatically: if a staged
# nexeo-loop.next.sh exists and parses, it becomes nexeo-loop.sh before the restart.
# That removes the manual step where I have been forgetting to swap, and removes the
# temptation to edit the running file, which I did once today by mistake.
set -uo pipefail
ROOT="/var/www/tmcai"; cd "$ROOT"
ORCH="$ROOT/server/docs/orchestrator"; STATE="$ORCH/state"
LOOP="$ROOT/scripts/orchestrator/nexeo-loop.sh"
NEXT="$ROOT/scripts/orchestrator/nexeo-loop.next.sh"
HALT="$ORCH/HALT"
say() { printf '%s SUPERVISOR %s\n' "$(date -u '+%F %T UTC')" "$*"; }

mkdir -p "$STATE"
while true; do
  if [ -f "$HALT" ]; then
    say "HALT present — not starting. Remove $HALT to resume."
    exit 0
  fi

  # Swap a staged script in at the boundary, never while one is running.
  if [ -f "$NEXT" ]; then
    if bash -n "$NEXT" 2>/dev/null; then
      cp "$NEXT" "$LOOP" && rm -f "$NEXT"
      say "staged nexeo-loop.next.sh swapped in"
    else
      say "staged script FAILED syntax check — left in place, running the current one"
    fi
  fi

  say "starting the loop"
  NEXEO_DEPLOY="${NEXEO_DEPLOY:-1}" NEXEO_DEPLOY_ON="${NEXEO_DEPLOY_ON:-sound}" \
    bash "$LOOP"
  rc=$?
  say "loop exited rc=$rc"

  [ -f "$HALT" ] && { say "HALT present after exit — stopping"; exit 0; }

  # A crash loop must not spin. A clean iteration-boundary exit restarts promptly;
  # anything that dies inside 60s waits, so a broken script cannot burn the box or
  # the API budget in a tight loop.
  UP=$(( $(date +%s) - ${START:-0} ))
  sleep "$([ "$rc" -eq 0 ] && echo 10 || echo 60)"
done
