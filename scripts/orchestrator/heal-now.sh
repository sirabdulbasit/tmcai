#!/usr/bin/env bash
#
# heal-now.sh — run a FULL healing pulse now: the same thing the nightly cron runs.
#
# Owner, 2026-08-19: "how if i want to run conversational cron manually before 10m?"
# Owner, 2026-09-07, asked whether the button runs what the nightly runs — and then: yes,
# make it so.
#
# WHY IT CHANGED. This used to exec watch-conversations.sh, the CONVERSATIONAL watcher,
# which passes NEXEO_TARGET_SOURCE=chat. Inside nexeo-loop.sh that one flag switches off
# three phases by design: the capability SCORE (line ~1054), the Codex REVIEW (~1934) and
# the MEASURE baseline (~824). That was correct while a 10-minute conversational cron
# existed and the nightly would pick those up later the same day.
#
# THAT CRON IS GONE — the owner disabled it on 2026-09-03 (`4c8ce99`, "keep only the
# nightly cron"). So this button was the manual trigger for a schedule that no longer
# exists, still skipping the three phases whose only justification was that something else
# would run them. Clicking it produced a real build and a real deploy and NO capability
# card — which is precisely the gap the owner had just asked to close: the score is
# supposed to move in the same pulse that does the work.
#
# So it now runs nightly-iteration.sh — one implementation, so a manual run and the
# scheduled run cannot behave differently. That was always this file's stated principle;
# it just used to point at the other script.
#
# WHAT THAT INHERITS, rather than reimplements: the concurrency guard (one builder in one
# tree, ever — two produce commits nobody can attribute), the cost read back from the
# builder's own result event, and the rc 0/2/1 verdict line in nightly.log.
#
# WHAT IT STILL CHANGES for a deliberate human ask:
#   NEXEO_TRIGGER=manual:heal-now   so the spend deck's CRON cut is not charged for a click
#   --force (default)               clear the conversation watermark so the chat analysis
#                                   re-reads the last 14 days even with no new message
#
# The conversational-only knobs are gone with the path that read them: NEXEO_WATCH_*
# applied to watch-conversations.sh and mean nothing to a full pulse. `--build-anyway` is
# accepted and now a no-op, because a full pulse always builds.
#
# Usage:
#   ./heal-now.sh                          # full pulse now
#   ./heal-now.sh --no-force               # leave the watermark alone
#   ./heal-now.sh "Self-Healing"           # aim this pulse at a named capability
#   ./heal-now.sh --force "Authorized Action"
set -uo pipefail

ROOT="/var/www/tmcai"
STATE="$ROOT/server/docs/orchestrator/state"

# ALWAYS RE-READ. Owner, 2026-08-20 01:17 PKT, having clicked Heal now: "it should start
# analyzing the chat but only see 'started' and nothing happening on screen."
#
# The button used to run without --force, so on a tick with no new message the watcher
# exited at the watermark check in about a second — correct for a 10-minute cron, wrong for
# a person who just asked. A deliberate click means "read it now", so the chat analysis
# always has fresh input. Since 2026-09-07 the BUILD is no longer conditional either: a
# full pulse always builds, so this only governs how much conversation the analyst reads.
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

# THE CAPS ARE GONE WITH THE WATCHER THEY BELONGED TO (2026-09-07).
#
# NEXEO_WATCH_MANUAL / _MIN_GAP_MIN / _MAX_MANUAL bounded the 10-minute cron's unattended
# spending — up to four auto-builds a day, one an hour. A full pulse has no such loop to
# bound: it runs once, when a person clicks, and the only rail that matters is the
# concurrency guard inherited from nightly-iteration.sh. That one is NOT waived, by this or
# anything else: one builder in one tree, ever, because two produce commits nobody can
# attribute.
#
# The practical consequence, stated so it is not a surprise: a click costs roughly what a
# night costs (~$24 mean, $45 worst observed), and nothing here refuses a second click an
# hour later except the guard against overlapping the first.
if [ "$BUILD_ANYWAY" = "1" ]; then
  # Kept so an existing caller or bookmark does not break, and reported honestly rather
  # than silently ignored: a full pulse has no "build only if the ranking changed" gate
  # for this to lift.
  echo "heal-now: --build-anyway is a no-op for a full pulse — it always builds"
fi

echo "heal-now: starting a FULL pulse — the same phases as the nightly cron (LEARN sweep,"
echo "heal-now: capability score, chat analysis, build, deploy, review, measure)."
echo "heal-now: expect ~30 minutes; scoring and the Codex review are the slow phases."
# manual:heal-now keeps this click out of the spend deck's cron cut. nightly-iteration.sh
# defaults the trigger, so cron still attributes to itself.
NEXEO_TRIGGER='manual:heal-now' \
  exec bash "$ROOT/scripts/orchestrator/nightly-iteration.sh"
