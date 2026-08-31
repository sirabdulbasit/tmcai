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
# A MONEY BOUND, not a count bound. The caps above limit how MANY builds run and say
# nothing about what they cost, and the spread is wide: measured 2026-08-28 across 90
# runs, a single build ranges from a few dollars to $45.28 (iteration 47). Summed from
# each run's own `total_cost_usd` result event — the CLI's accounting, not an estimate.
#
# SIZED AGAINST THE MEASURED DISTRIBUTION, not picked. Orchestrator spend per day over
# the 10 days to 2026-08-28: median $63.08, mean $56.48, highest ORDINARY day $81.04
# (4 runs, 08-24), and one runaway at $151.22 (12 runs, 08-18).
#
# 100 therefore sits above every ordinary day observed and below the runaway, and it
# still permits two worst-case builds. A first draft of this used 50, which would have
# tripped below the MEDIAN day — a cap that fires on normal operation is not a guard,
# it is an outage with a budget attached.
MAX_USD_DAY="${NEXEO_WATCH_MAX_USD_DAY:-100}"

# Dollars to integer cents, in pure shell. `10#` forces base 10 so a cap written as
# "08.50" is not read as octal.
usd_to_cents() {
  local v="${1:-0}" whole frac
  whole="${v%%.*}"
  case "$v" in *.*) frac="${v#*.}" ;; *) frac="00" ;; esac
  frac="${frac}00"; frac="${frac:0:2}"
  # BOTH halves need `10#`, not just the fraction. A cap of "08.50" has a leading zero
  # in the WHOLE part too, and bash reads a bare 08 as octal and aborts the script under
  # `set -u`-adjacent arithmetic. Caught by testing the exact value this comment claims
  # to support.
  printf '%s' "$(( 10#${whole:-0} * 100 + 10#${frac} ))"
}

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
# NOTHING CAN TRAP SIGKILL — not this script, not any script. So a pulse that is hard-killed
# leaves its ledger entry open forever, and "no verdict" would be indistinguishable from "still
# running". The next pulse closes it: if the previous iteration has a start line and no verdict,
# and no iteration is actually running, it is recorded as `vanished`. That word is deliberate —
# it says the pulse stopped without saying why, which is the truth, rather than guessing.
close_abandoned_pulse() {
  local prev="$1"
  [ -z "$prev" ] || [ "$prev" -lt 1 ] 2>/dev/null && return 0
  [ -f "$STATE/pulse-ledger.jsonl" ] || return 0
  grep -q "\"iteration\":$prev,\"kind\":\"conversational\",\"kind_n\"" "$STATE/pulse-ledger.jsonl" || return 0
  grep -q "\"iteration\":$prev,.*\"verdict\"" "$STATE/pulse-ledger.jsonl" && return 0
  printf '{"iteration":%s,"kind":"conversational","verdict":"vanished","at":"%s"}\n' \
    "$prev" "$(date -u +%FT%TZ)" >> "$STATE/pulse-ledger.jsonl"
  printf '%s  PULSE  iter=%s verdict=vanished (no exit recorded — closed by the next pulse)\n' \
    "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$prev" >> "$ORCH_LOG"
}

begin_pulse() {
  [ -n "$PULSE_ITER" ] && return 0
  close_abandoned_pulse "$(cat "$STATE/iteration" 2>/dev/null || echo 0)"
  PULSE_ITER=$(( $(cat "$STATE/iteration" 2>/dev/null || echo 0) + 1 ))
  printf '%s' "$PULSE_ITER" > "$STATE/iteration"
  printf '%s  ─── iteration %s ───\n' \
    "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$PULSE_ITER" >> "$ORCH_LOG"
  # THE LEDGER TOO, not just the log. Owner, 2026-08-20, on a token table showing C1/C2/C3
  # beside a timing table showing #1 to #9: four of the nine pulses had no ledger line, so the
  # deck could not label them and dropped them. Only nexeo-loop.sh wrote this file, so a pulse
  # that skipped its build — most conversational pulses — was never recorded as having existed.
  #
  # THE COUNT IS COMPUTED FIRST, ON ITS OWN LINE, and this is not stylistic. A comment placed
  # between two continued lines of a `printf` is NOT a comment — the backslash joins it, and its
  # words become ARGUMENTS. I did exactly that in fd24ada while fixing the `grep -c || echo 0`
  # bug, and it emitted `{"kind_n":,"at":""}` and then tried to execute `1` as a command. Every
  # conversational pulse would have written a malformed ledger line. `bash -n` passes it, because
  # it is valid syntax that means something else.
  #
  # `grep -c` prints 0 AND exits 1 when nothing matches, so `|| echo 0` appended a SECOND zero
  # and the arithmetic became $(( 0\n0 + 1 )) — the syntax error that killed four nightlies.
  # `|| true` keeps the pipeline honest without adding output.
  # COUNT PULSES, NOT ROWS. Each pulse now writes TWO lines — a start and a verdict — and both
  # carry "kind":"conversational", so counting that alone double-counts every pulse and the
  # number drifts. `kind_n` appears on the start line only, which is exactly one per pulse.
  CONV_N="$(( $(grep -c '"kind":"conversational","kind_n"' "$STATE/pulse-ledger.jsonl" 2>/dev/null || true) + 1 ))"
  printf '{"iteration":%s,"kind":"conversational","kind_n":%s,"at":"%s"}\n' \
    "$PULSE_ITER" "$CONV_N" "$(date -u +%FT%TZ)" >> "$STATE/pulse-ledger.jsonl"
  printf '%s  PULSE  iter=%s conversational (started by %s)\n' \
    "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$PULSE_ITER" \
    "$([ "${NEXEO_WATCH_MANUAL:-0}" = "1" ] && echo 'a person' || echo 'cron')" >> "$ORCH_LOG"
}
# WHAT THIS PULSE ACTUALLY DID, recorded per pulse — owner, 2026-08-24, asking whether every
# pulse improves Brain. It was unanswerable: the ledger said a pulse HAPPENED and nothing said
# what it achieved. A verdict line per pulse makes the trend answer the question directly
# instead of by inference from a weekly score.
#
# Called on every exit path, and from a trap, so an abort records "died" rather than nothing —
# four nightlies died in silence this week and the deck showed a healthy system.
PULSE_VERDICT="died"
PULSE_CLOSED=0
finish_pulse() {
  [ -n "${1:-}" ] && PULSE_VERDICT="$1"
  [ -z "$PULSE_ITER" ] && return 0     # never claimed a number, so nothing to close
  # CLOSE ONCE. Every explicit call is followed by `exit`, which fires the EXIT trap, which calls
  # this again — so each pulse wrote its verdict TWICE. Visible in the ledger as duplicate rows
  # for iterations 36 and 37 within the same second. Harmless to the verdict itself, but it
  # doubles any count taken from these rows, which is exactly the drift the `kind_n` fix removed
  # from the other direction this morning.
  [ "$PULSE_CLOSED" = "1" ] && return 0
  PULSE_CLOSED=1
  printf '{"iteration":%s,"kind":"conversational","verdict":"%s","at":"%s"}\n' \
    "$PULSE_ITER" "$PULSE_VERDICT" "$(date -u +%FT%TZ)" >> "$STATE/pulse-ledger.jsonl"
  printf '%s  PULSE  iter=%s verdict=%s\n' \
    "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$PULSE_ITER" "$PULSE_VERDICT" >> "$ORCH_LOG"
}
trap 'finish_pulse' EXIT
# A SIGNALLED DEATH IS STILL A DEATH. The EXIT trap covers a normal exit; it does NOT cover a
# process that is signalled away. Iteration 29 proved this: it logged its start line, ran its
# build, logged `iteration finished rc=2` — and then recorded NO verdict, because the watcher
# was killed rather than allowed to exit. Verified by running this exact file in a sandbox,
# where the trap fires correctly.
trap 'finish_pulse died-signal; exit 143' TERM INT HUP

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
# NEXEO_TRIGGER names the SCHEDULE for the spend deck's cron cut — this is the ten-minute
# conversational cron, the highest-frequency spender on the box and the one that was entirely
# unmeasured until the analyst moved to stream-json. Unset would mean `manual`, so the
# attribution can only come from here.
if ! NEXEO_TRIGGER='cron:watch-conversations' \
     timeout 900 bash "$ROOT/scripts/orchestrator/run-chat-analysis.sh" >> "$LOG" 2>&1; then
  say "analysis failed — the previous ranking stands"
  finish_pulse "analysis-failed"
  phase "CHAT" "exit=1 (analysis failed — the previous ranking stands)"
  exit 0
fi
phase "CHAT" "exit=0 (ranking written)"
# THE FINDINGS, NOT THE PROSE — owner, 2026-08-24: "can we improve brain's capabilities with
# every pulse healing?"
#
# This hashed the analyst's whole output, which is REGENERATED TEXT: 52 lines one run, 95 the
# next, 57 the next. So the hash differed every time and "root causes CHANGED" fired 18 times
# out of 18 — the loop could not tell a new defect from the same defect described differently,
# and rebuilt the same ground while reporting it as warranted. "Nothing new" was not a state the
# system could reach.
#
# The fingerprint is now the SET of declared signature tags, sorted and deduplicated. Reword the
# analysis and it is unchanged; find a genuinely new defect and it moves.
NEW_HASH="$(python3 - "$STATE/chat-root-causes.md" <<'PYFP'
import hashlib, re, sys
try:
    txt = open(sys.argv[1], errors="replace").read()
except Exception:
    print("unreadable"); raise SystemExit
# The analyst's machine-readable table is the contract (see prompts/chat-analysis.md). Its LAST
# occurrence wins: the file is appended to across runs.
parts = re.split(r"^##\s+SIGNATURES\s*$", txt, flags=re.M)
tags = set()
if len(parts) > 1:
    for line in parts[-1].splitlines():
        if not line.strip().startswith("|"):
            if tags:
                break
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        last = cells[-1] if len(cells) >= 3 else ""
        # Skip the header row and the markdown rule. "tag" is the header's own label, and it
        # was being counted as a tag — harmless to the hash's stability but wrong, and a
        # fingerprint with junk in it is one nobody trusts enough to act on.
        if last and last.lower() != "tag" and not set(last) <= set("-: "):
            tags.add(last)
if not tags:
    # No declared table — fall back to the full text, which is the old behaviour. Stated rather
    # than silent: a fingerprint that quietly degrades to "always different" is the bug above.
    print("prose:" + hashlib.sha256(txt.encode()).hexdigest())
else:
    print("tags:" + hashlib.sha256("\n".join(sorted(tags)).encode()).hexdigest())
PYFP
)"
printf '%s' "$NEW_HASH" > "$ROOTS_HASH"

# TWO REASONS THIS GATE MAY NOT FIRE — owner, 2026-08-24: "i found above observed gaps and then
# i clicked on Heal Now but it didnt build it why?"
#
# 1. A PERSON ASKED. NEXEO_WATCH_MANUAL was read at line ~278, thirty lines AFTER this gate had
#    already exited, so "Heal now" was refused by the same rule as an unattended cron tick. A
#    human pressing a button is a stronger signal than a hash; it is not a duplicate of anything.
#
# 2. THE FINGERPRINT DEADLOCK, which is the real defect and is mine from this morning. The hash
#    tracks WHICH FINDINGS EXIST, so it is stable exactly while findings stay open — and a stable
#    hash forbids the build that would close them. Three findings sat open for hours
#    (2,608 emails never triaged, dead connectors, the screenshot) and every pulse dutifully
#    reported "root causes did not change" as a reason NOT to act on them. The prose-hash gate it
#    replaced built the same ground 18 times out of 18; this one built it zero times. Both
#    failures come from asking "is this different?" when the question is "has this been worked?".
#
#    So the skip now needs BOTH: the findings are unchanged AND a build has already been
#    attempted against this exact finding-set. One attempt per distinct set — no re-grinding, no
#    deadlock.
BUILT_HASH_FILE="$STATE/chat-roots-hash-built"
LAST_BUILT_HASH="$(cat "$BUILT_HASH_FILE" 2>/dev/null || true)"
if [ "$NEW_HASH" = "$PREV_HASH" ]    && [ "$NEW_HASH" = "$LAST_BUILT_HASH" ]    && [ "${NEXEO_WATCH_MANUAL:-0}" != "1" ]    && [ "${NEXEO_WATCH_ALWAYS_BUILD:-0}" != "1" ]; then
  say "conversation was new but the root causes did not change, and this finding-set has already been built — analysed, no build"
  finish_pulse "nothing-new"
  phase "BUILD" "exit=skip (nothing new in the ranking to build)"
  exit 0
fi
[ "${NEXEO_WATCH_ALWAYS_BUILD:-0}" = "1" ] && [ "$NEW_HASH" = "$PREV_HASH" ] && \
  say "root causes unchanged, but ALWAYS_BUILD is set — a person asked for a build anyway"
say "root causes CHANGED — a build may be warranted"

# ── 3. BUILD. Guarded, because this is the expensive stage. ──────────────────────────
TODAY="$(date -u +%F)"

# SPEND GATE, ahead of the count gates because money is the bound that actually matters.
#
# IT BOUNDS THE CRON, NEVER A PERSON. Owner ruling 2026-08-28: "my healing should not be
# compromised, but token consumption should be smart and optimized." The waste this gate
# exists to stop is unattended: a loop spending money every ten minutes with nobody
# watching. A human clicking "Heal now" is the opposite situation — they are standing
# there, they have decided, and they will see the result.
#
# The first version of this gate applied to manual runs too, and that was wrong twice
# over. It would have re-created the defect this file already records — 2026-08-19,
# "where i am expecting to start it immediately", and 2026-08-24, "i clicked on Heal Now
# but it didnt build it why?" — and `heal-now.sh` had no way to override it, so even
# `--force` would have been refused. Manual runs already carry their own bound
# (MAX_MANUAL_DAY).
#
# A WAIVER IS ALWAYS LOGGED. No silent pass and no silent skip: whichever way this gate
# resolves over the cap, `say` records it. A guard that waives quietly is indistinguishable
# from a guard that is broken.
#
# READ NEXEO_WATCH_MANUAL DIRECTLY, not $MANUAL — that variable is not assigned until ~30
# lines below this gate, and under `set -u` referencing it here would kill the script
# outright. That is exactly how a manual run died once before, on an unbound $NOW.
#
# FAILS OPEN. If the accounting cannot be read, the build proceeds and the log says so.
# A broken accountant must not become an outage.
SPENT_CENTS="$(python3 - "$ORCH/logs" "$TODAY" <<'PY' 2>/dev/null || true
import glob, json, os, sys, datetime
day, total = sys.argv[2], 0.0
for f in glob.glob(os.path.join(sys.argv[1], "iter-*-build.jsonl")):
    try:
        if datetime.datetime.utcfromtimestamp(os.path.getmtime(f)).strftime("%Y-%m-%d") != day:
            continue
        for line in open(f, errors="replace"):
            if '"total_cost_usd"' in line:
                v = json.loads(line).get("total_cost_usd")
                if isinstance(v, (int, float)):
                    total += v
    except Exception:
        continue
print(int(round(total * 100)))
PY
)"
CAP_CENTS="$(usd_to_cents "$MAX_USD_DAY")"
case "$SPENT_CENTS" in
  ''|*[!0-9]*)
    say "spend accounting unreadable — spend gate SKIPPED (failing open), count caps still apply"
    ;;
  *)
    if [ "$SPENT_CENTS" -ge "$CAP_CENTS" ]; then
      SPENT_FMT="$((SPENT_CENTS/100)).$(printf '%02d' $((SPENT_CENTS%100)))"
      if [ "${NEXEO_WATCH_MANUAL:-0}" = "1" ]; then
        say "daily SPEND cap reached (\$$SPENT_FMT / \$$MAX_USD_DAY today) — WAIVED, a person asked: healing is never refused for cost. Manual budget still applies"
      elif [ "${NEXEO_WATCH_FORCE:-0}" = "1" ]; then
        say "daily SPEND cap reached (\$$SPENT_FMT / \$$MAX_USD_DAY today) — OVERRIDDEN by NEXEO_WATCH_FORCE=1"
      else
        say "daily SPEND cap reached (\$$SPENT_FMT / \$$MAX_USD_DAY today) — unattended run, analysis recorded, build deferred"
        finish_pulse "deferred-spend-cap"
        phase "BUILD" "exit=skip (deferred: spent \$$SPENT_FMT of \$$MAX_USD_DAY today)"
        exit 0
      fi
    fi
    ;;
esac

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
    finish_pulse "deferred-manual-cap"
    phase "BUILD" "exit=skip (deferred: manual cap $MCOUNT/$MAX_MANUAL_DAY today)"
    exit 0
  fi
  say "MANUAL run ($((MCOUNT + 1))/$MAX_MANUAL_DAY today) — daily auto-cap ($COUNT/$MAX_BUILDS_DAY) and ${MIN_GAP_MIN}m spacing both waived: a person asked"
else
  if [ "$COUNT" -ge "$MAX_BUILDS_DAY" ]; then
    say "daily auto-build cap reached ($COUNT/$MAX_BUILDS_DAY) — analysis recorded, build deferred to the nightly run"
    finish_pulse "deferred-daily-cap"
    phase "BUILD" "exit=skip (deferred: daily cap $COUNT/$MAX_BUILDS_DAY, waiting for the nightly run)"
    exit 0
  fi

  if [ $(( (NOW - LAST) / 60 )) -lt "$MIN_GAP_MIN" ]; then
    say "last auto-build was $(( (NOW - LAST) / 60 ))m ago (< ${MIN_GAP_MIN}m) — analysis recorded, build deferred"
    finish_pulse "deferred-spacing"
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
  finish_pulse "skipped-concurrent"
  exit 0
fi

# Stamp the finding-set this build is for, so the gate above can tell "already worked" from
# "merely unchanged". Written when the build STARTS, not when it succeeds: a build that dies
# still counts as attempted, or a repeatedly-failing one would re-trigger every ten minutes.
printf '%s' "$NEW_HASH" > "$BUILT_HASH_FILE"
printf '%s' "$NOW" > "$BUILD_STAMP"
printf '%s %s' "$TODAY" "$((COUNT + 1))" > "$BUILD_COUNT"
say "starting ONE bounded iteration (auto-build $((COUNT + 1))/$MAX_BUILDS_DAY today)"
cd "$ROOT" || exit 1
NEXEO_MAX_ITER=1 NEXEO_DEPLOY=1 NEXEO_TARGET_SOURCE=chat \
  bash "$ROOT/scripts/orchestrator/nexeo-loop.sh" >> "$ORCH/loop.out" 2>&1
say "iteration finished rc=$?"
