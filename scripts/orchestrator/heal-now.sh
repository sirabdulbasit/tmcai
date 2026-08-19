#!/usr/bin/env bash
#
# heal-now.sh — run a conversational healing pulse immediately, without waiting for the
# 10-minute tick.
#
# Owner, 2026-08-19: "how if i want to run conversational cron manually before 10m?"
#
# It calls the same watch-conversations.sh the cron calls — one implementation, so a manual
# run and a scheduled run cannot behave differently. What it changes is the guards that
# exist to stop the CRON spending money unattended, and which have no reason to apply when
# a human is deliberately asking:
#
#   NEXEO_WATCH_MIN_GAP_MIN=0   the 60-minute spacing between auto-builds is lifted
#   --force                     ignore the watermark and re-read the last 14 days even if
#                               no new message has arrived
#
# WHAT IT DELIBERATELY DOES NOT LIFT:
#   • the concurrency guard — one builder in one tree, ever. Two produce commits nobody can
#     attribute, which this project has already recorded.
#   • the daily auto-build cap — a manual run still counts against it, because the cap
#     exists to bound the day's spend and a human clicking faster is exactly the case it
#     is there for. Override with NEXEO_WATCH_MAX_BUILDS if you mean to.
#
# Usage:
#   ./heal-now.sh                          # act if there is new conversation
#   ./heal-now.sh --force                  # act regardless
#   ./heal-now.sh "Self-Healing"           # and aim this pulse at a named capability
#   ./heal-now.sh --force "Authorized Action"
set -uo pipefail

ROOT="/var/www/tmcai"
STATE="$ROOT/server/docs/orchestrator/state"

# ALWAYS RE-READ. Owner, 2026-08-20 01:17 PKT, having clicked Heal now: "it should start
# analyzing the chat but only see 'started' and nothing happening on screen."
#
# The button used to run without --force, so on a tick with no new message the watcher
# exited at the watermark check in about a second — correct for a 10-minute cron, wrong for
# a person who just asked. A deliberate click means "read it now", so the harvest and the
# analysis always run. It is the BUILD that stays conditional, and --build-anyway is what
# lifts that.
FORCE=1
BUILD_ANYWAY=0
CAP=""
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --no-force) FORCE=0 ;;
    --build-anyway) BUILD_ANYWAY=1 ;;
    *) CAP="$a" ;;
  esac
done

if [ "$FORCE" = "1" ]; then
  # Clearing the watermark makes every recent turn look new, so the harvest and the
  # analysis both run. The watermark is rewritten by the watcher on success, so this
  # costs one re-read and does not permanently reset anything.
  rm -f "$STATE/conversation-watermark"
  echo "heal-now: watermark cleared — the last 14 days will be re-read"
fi

if [ -n "$CAP" ]; then
  # Validated inside the loop against the nine capability names; a typo falls through to
  # the loop's own choice rather than aiming the run at nothing.
  export NEXEO_TARGET_CAPABILITY="$CAP"
  echo "heal-now: aiming this pulse at '$CAP'"
fi

# NEXEO_WATCH_MANUAL=1 is what tells the watcher a person is asking: it waives the daily
# auto-build cap and the hourly spacing, and spends against a separate manual budget
# (3/day by default). Without it a click on a day that had already used its four auto-builds
# ran the analysis and skipped the build — which is exactly what happened at 16:37 UTC on
# 2026-08-19, and which reads as "the cron did nothing".
#
# The concurrency guard is still NOT waived. One builder in one tree, ever.
if [ "$BUILD_ANYWAY" = "1" ]; then
  echo "heal-now: FORCE — will build even if the ranking is unchanged, and the manual cap is lifted"
  export NEXEO_WATCH_ALWAYS_BUILD=1 NEXEO_WATCH_MAX_MANUAL=99
fi

echo "heal-now: starting a conversational pulse (auto caps waived — manual budget applies)"
NEXEO_WATCH_MANUAL=1 NEXEO_WATCH_MIN_GAP_MIN=0 \
  exec bash "$ROOT/scripts/orchestrator/watch-conversations.sh"
