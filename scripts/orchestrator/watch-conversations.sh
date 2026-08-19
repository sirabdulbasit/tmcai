#!/usr/bin/env bash
#
# watch-conversations.sh — every 10 minutes: has the owner said anything new to Brain,
# and if so, is it worth spending a build on?
#
# Owner, 2026-08-18: "would it be possible if you set cron of 10mins and everytime it
# will see if new conversation to brain has made then evaluate it and fix it?"
#
# THE SHAPE, and why it is not simply "run an iteration when a message arrives".
# Detection is free — one indexed query. Analysis is one Codex call. A BUILD is $7 to
# $21. At ~30 turns a day, triggering a build per conversation would spend more in a
# week than the whole continuous loop did ($1,144 across 162 builds), most of it on
# turns where Brain behaved correctly and there was nothing to fix.
#
# So the three stages are separated by cost:
#   1. WATERMARK   (free)   new turns since we last looked? if not, exit in milliseconds
#   2. HARVEST + ANALYSE (~1 Codex call) refresh the transcript, re-rank the root causes
#   3. BUILD       ($7-21)  only when the analysis found something NEW, and only inside
#                           a daily budget and a minimum interval
#
# Stage 3's guards are the whole point. Without them this is a machine that turns the
# owner's typing into money.
set -uo pipefail

ROOT="/var/www/tmcai"
ORCH="$ROOT/server/docs/orchestrator"
STATE="$ORCH/state"
LOG="$ORCH/watch.log"

WATERMARK="$STATE/conversation-watermark"
ROOTS_HASH="$STATE/chat-roots-hash"
BUILD_STAMP="$STATE/last-auto-build"
BUILD_COUNT="$STATE/auto-builds-today"
MANUAL_COUNT="$STATE/manual-builds-today"   # a click's budget, kept apart from the cron's

# Guards, all overridable but all present by default.
MIN_GAP_MIN="${NEXEO_WATCH_MIN_GAP_MIN:-60}"      # never two auto-builds inside an hour
MAX_BUILDS_DAY="${NEXEO_WATCH_MAX_BUILDS:-4}"     # ~$30-80/day worst case, not unbounded

say() { printf '%s  WATCH %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$*" >> "$LOG"; }

# THE PHASE EVENTS THE DECK READS — owner, 2026-08-20: he clicked Heal now, the header went
# green and the phase list beneath it still showed "done 2m19s" from a pulse five hours old,
# labelled idle.
#
# The reason was structural, not cosmetic: a conversational pulse launched here wrote only to
# watch.log, while `pulse.py` builds its phase rows from the `STAGE iter=N` lines in loop.log
# that nexeo-loop.sh emits. So a pulse this script ran had no phases at all, and the panel
# displayed the last ones it could find. Two paths, one concept, and only one of them told
# the deck anything — which is `protection-with-two-implementations` wearing a different hat.
#
# It writes the same lines to the same file, so the deck needs no second parser.
ORCH_LOG="$ORCH/loop.log"

# A NEW PULSE IS A NEW PULSE, and needs its own number and its own banner.
#
# The first version of this reused the number in state/iteration, so a second pulse wrote its
# "started" event into a row whose `end` was already recorded from the first — and the panel
# went on showing "done 2m19s" while the analyst was live. `pulse.py` banks and resets the
# open spans on the `─── iteration N ───` banner, which only nexeo-loop.sh was writing. The
# conversational path emitted phase events into a completed row.
#
# So the counter advances here too, and the banner is written before the first phase event.
# That is also what the owner asked the number to mean: "Healing Pulse #4" should become #5
# when a fifth pulse starts, not stay at #4 forever because the full loop happens to own the
# counter.
# LAZY, because most ticks are no-ops. This script runs 144 times a day and exits at the
# watermark check whenever nothing has been said to Brain — numbering those would produce 144
# "pulses" a day and make the counter meaningless, which is the complaint that got the old
# iteration numbering reset in the first place. The number is claimed by the first pulse that
# has actual work to do.
PULSE_ITER=""
begin_pulse() {
  [ -n "$PULSE_ITER" ] && return 0
  PULSE_ITER=$(( $(cat "$STATE/iteration" 2>/dev/null || echo 0) + 1 ))
  printf '%s' "$PULSE_ITER" > "$STATE/iteration"
  printf '%s  ─── iteration %s ───\n' \
    "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$PULSE_ITER" >> "$ORCH_LOG"
}
phase() {
  begin_pulse
  printf '%s  %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" \
    "$1 iter=$PULSE_ITER $2" >> "$ORCH_LOG"
}

# ── 1. WATERMARK. Free, and exits immediately on the common case of nothing new. ─────
NEWEST="$(cd "$ROOT/server" && timeout 60 node -r dotenv/config -e '
const {PrismaClient}=require("/var/www/tmcai/server/node_modules/@prisma/client");
const p=new PrismaClient();
(async()=>{const m=await p.message.findFirst({orderBy:{createdAt:"desc"},select:{createdAt:true}});
process.stdout.write(m?String(m.createdAt.getTime()):"0");await p.$disconnect();})()
  .catch(()=>{process.stdout.write("ERR")});' 2>/dev/null)"

case "$NEWEST" in
  ''|ERR) say "could not read the newest message — leaving the watermark untouched and retrying next tick"; exit 0 ;;
esac
SEEN="$(cat "$WATERMARK" 2>/dev/null || echo 0)"
if [ "$NEWEST" = "$SEEN" ]; then
  exit 0                      # nothing new; silent, because this is the 10-minute norm
fi
say "new conversation activity (newest $NEWEST, last seen $SEEN)"

# ── 2. HARVEST + ANALYSE. Cheap, and it is what the owner actually asked to happen ──
#     on every new conversation: read it and work out what it says.
if ! ( cd "$ROOT/server" && timeout 300 node -r dotenv/config \
        "$ROOT/scripts/orchestrator/harvest-chats.js" --since "$SEEN" ) >> "$ORCH/harvest.log" 2>&1; then
  say "harvest failed — see harvest.log; watermark NOT advanced so the next tick retries"
  exit 0
fi
# The watermark advances only after a SUCCESSFUL harvest. Advancing it earlier would
# silently skip the conversation that failed to harvest.
printf '%s' "$NEWEST" > "$WATERMARK"

PREV_HASH="$(cat "$ROOTS_HASH" 2>/dev/null || echo none)"
phase "CHAT" "started reading the live conversations (all tenants, last 14 days)"
if ! timeout 900 bash "$ROOT/scripts/orchestrator/run-chat-analysis.sh" >> "$LOG" 2>&1; then
  say "analysis failed — the previous ranking stands"
  phase "CHAT" "exit=1 (analysis failed — the previous ranking stands)"
  exit 0
fi
phase "CHAT" "exit=0 (ranking written)"
NEW_HASH="$(sha256sum "$STATE/chat-root-causes.md" 2>/dev/null | awk '{print $1}')"
printf '%s' "$NEW_HASH" > "$ROOTS_HASH"

if [ "$NEW_HASH" = "$PREV_HASH" ] && [ "${NEXEO_WATCH_ALWAYS_BUILD:-0}" != "1" ]; then
  say "conversation was new but the root causes did not change — analysed, no build"
  phase "BUILD" "exit=skip (nothing new in the ranking to build)"
  exit 0
fi
[ "${NEXEO_WATCH_ALWAYS_BUILD:-0}" = "1" ] && [ "$NEW_HASH" = "$PREV_HASH" ] && \
  say "root causes unchanged, but ALWAYS_BUILD is set — a person asked for a build anyway"
say "root causes CHANGED — a build may be warranted"

# ── 3. BUILD. Guarded, because this is the expensive stage. ──────────────────────────
TODAY="$(date -u +%F)"
STAMP_DAY="$(cut -d' ' -f1 "$BUILD_COUNT" 2>/dev/null || echo '')"
COUNT="$(cut -d' ' -f2 "$BUILD_COUNT" 2>/dev/null || echo 0)"
[ "$STAMP_DAY" = "$TODAY" ] || COUNT=0

# A HUMAN CLICKING "Heal now" IS NOT THE CASE THESE CAPS PROTECT AGAINST.
#
# Owner, 2026-08-19, after clicking it: "where i am expecting to start it immediately."
# The pulse DID start immediately — but today's auto-build cap was already 4/4, so it would
# have run the analysis and silently skipped the build. He asked for a fix and would have
# received a document. The caps exist to stop a CRON spending money unattended every ten
# minutes; neither reason survives a deliberate click.
#
# So a manual run skips the daily cap and the hourly spacing — and gets its OWN cap, because
# "unattended" is not the only way to spend $60 by accident. A stuck finger is the other.
# HOISTED ABOVE THE BRANCH, because the build stamp below is written on BOTH paths.
#
# These lived inside the auto-only `else`, and this script runs under `set -u`. So on a MANUAL
# run — every "Heal now" — `$NOW` was unbound at `printf '%s' "$NOW" > "$BUILD_STAMP"` and bash
# killed the script dead, right after logging "MANUAL run (1/6 today) … a person asked". The
# owner saw a pulse approve its own build and then simply stop: Chat Analysis done, Build &
# Deploy "—", stage WAITING. Mine, introduced an hour earlier when I wrapped the guards in the
# if/else that waives them for a person.
LAST="$(cat "$BUILD_STAMP" 2>/dev/null || echo 0)"
NOW="$(date -u +%s)"

MANUAL="${NEXEO_WATCH_MANUAL:-0}"
# 6, not 3. Three was my guess an hour after building the button, sized against a cron's risk
# profile rather than a person's use of it — and it ran out the same evening, so his click
# analysed and silently declined to build. A manual build is a deliberate act that he watches
# the result of; the runaway it guards against is a stuck finger, and six still bounds that.
MAX_MANUAL_DAY="${NEXEO_WATCH_MAX_MANUAL:-6}"
MCOUNT=0
if [ "$MANUAL" = "1" ]; then
  MSTAMP_DAY="$(cut -d' ' -f1 "$MANUAL_COUNT" 2>/dev/null || echo '')"
  MCOUNT="$(cut -d' ' -f2 "$MANUAL_COUNT" 2>/dev/null || echo 0)"
  [ "$MSTAMP_DAY" = "$TODAY" ] || MCOUNT=0
  if [ "$MCOUNT" -ge "$MAX_MANUAL_DAY" ]; then
    say "MANUAL cap reached ($MCOUNT/$MAX_MANUAL_DAY today) — build deferred. Raise NEXEO_WATCH_MAX_MANUAL to override"
    phase "BUILD" "exit=skip (deferred: manual cap $MCOUNT/$MAX_MANUAL_DAY today)"
    exit 0
  fi
  say "MANUAL run ($((MCOUNT + 1))/$MAX_MANUAL_DAY today) — daily auto-cap ($COUNT/$MAX_BUILDS_DAY) and ${MIN_GAP_MIN}m spacing both waived: a person asked"
else
  if [ "$COUNT" -ge "$MAX_BUILDS_DAY" ]; then
    say "daily auto-build cap reached ($COUNT/$MAX_BUILDS_DAY) — analysis recorded, build deferred to the nightly run"
    phase "BUILD" "exit=skip (deferred: daily cap $COUNT/$MAX_BUILDS_DAY, waiting for the nightly run)"
    exit 0
  fi

  if [ $(( (NOW - LAST) / 60 )) -lt "$MIN_GAP_MIN" ]; then
    say "last auto-build was $(( (NOW - LAST) / 60 ))m ago (< ${MIN_GAP_MIN}m) — analysis recorded, build deferred"
    phase "BUILD" "exit=skip (deferred: last build $(( (NOW - LAST) / 60 ))m ago, min gap ${MIN_GAP_MIN}m)"
    exit 0
  fi
fi
[ "$MANUAL" = "1" ] && printf '%s %s\n' "$TODAY" "$((MCOUNT + 1))" > "$MANUAL_COUNT"

# One builder in one tree, ever. Two would produce commits nobody can attribute.
#
# Matched on an argv ELEMENT via /proc, not with pgrep. `pgrep -af nexeo-loop.sh` matches
# its own pattern and any shell that merely mentions the script, and the `grep -v grep`
# dance around it is exactly the check that gave three false "it is running" readings in
# one afternoon. A subshell whose parent is also a match is not a second builder.
if python3 - <<'PYRUN'
import os, sys
hits = []
for pid in os.listdir('/proc'):
    if not pid.isdigit():
        continue
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as fh:
            argv = [a.decode('utf-8', 'replace') for a in fh.read().split(b'\0') if a]
        ppid = [l.split()[1] for l in open(f'/proc/{pid}/status') if l.startswith('PPid')][0]
    except Exception:
        continue
    if any(a.endswith('nexeo-loop.sh') for a in argv):
        hits.append((pid, ppid))
tops = [p for p, q in hits if q not in [x for x, _ in hits]]
sys.exit(0 if tops else 1)
PYRUN
then
  say "an iteration is already running — not starting a second"
  exit 0
fi

printf '%s' "$NOW" > "$BUILD_STAMP"
printf '%s %s' "$TODAY" "$((COUNT + 1))" > "$BUILD_COUNT"
say "starting ONE bounded iteration (auto-build $((COUNT + 1))/$MAX_BUILDS_DAY today)"
cd "$ROOT" || exit 1
NEXEO_MAX_ITER=1 NEXEO_DEPLOY=1 NEXEO_TARGET_SOURCE=chat \
  bash "$ROOT/scripts/orchestrator/nexeo-loop.sh" >> "$ORCH/loop.out" 2>&1
say "iteration finished rc=$?"
