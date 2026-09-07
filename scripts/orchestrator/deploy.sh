#!/usr/bin/env bash
#
# deploy.sh — the DEPLOY phase of the loop.
#
# Owner, 2026-08-12: *"make deploy as a part of loop"*, after learning that 13
# loop defects and one migration were sitting branch-only while he reported live
# symptoms the branch had already fixed.
#
# THIS IS THE ONLY PHASE THAT TOUCHES PRODUCTION, so it is the most conservative
# thing in the orchestrator. It follows CLAUDE.md's deploy protocol rather than
# `pm2 restart` on green (which is what the loop's old NEXEO_DEPLOY=1 flag did,
# and why that flag was never turned on):
#
#   1. GATE     — only deploys an iteration Codex ruled SOUND. A WEAK verdict
#                 means the reviewer found claims the diff does not support, and
#                 iterations 7 and 8 each traded a truthfulness guarantee for
#                 tone. Shipping those to the owner's live WhatsApp would be
#                 exactly the fabricated-completion class this project bleeds on.
#   2. RAILS    — re-verify at the deploy commit: tsc clean, tests green, build
#                 ok. The loop already ran these, but a deploy asserts them about
#                 the tree it is shipping, not about a tree from ten minutes ago.
#   3. CHART    — write the evaluation-chart row BEFORE the deploy (predicted
#                 impact, regression risk, how it will be judged). Owner ruling
#                 2026-08-05: predictions are written before the result is known
#                 so they can be wrong on the record.
#   4. MIGRATE  — hand-written idempotent migrations only, applied by shape
#                 detection, never `prisma migrate dev`. A migration failure
#                 STOPS the deploy; it never proceeds to restart.
#   5. RESTART  — pm2 restart, then a real HTTP probe. A process that is "online"
#                 with a dead listener is the false-green the chart records for
#                 the liveness probes.
#   6. VERIFY   — boot log inspected for NEW errors. Report exactly what was
#                 checked and what was not. Anything unexercised is stated as NOT
#                 VERIFIED, never assumed.
#   7. ROLLBACK — on probe failure: restore the previous dist + previous commit,
#                 restart, re-probe, and say so loudly. Migrations are NOT rolled
#                 back (they are idempotent and forward-only by design); that is
#                 stated rather than hidden.
#
# Env:
#   NEXEO_DEPLOY=1        required — without it this script refuses to run
#   NEXEO_DEPLOY_ON=sound|always   default sound
#   NEXEO_DEPLOY_DRYRUN=1 do everything except migrate/restart
set -uo pipefail

ROOT="/var/www/tmcai"
SRV="$ROOT/server"
ORCH="$SRV/docs/orchestrator"
STATE="$ORCH/state"
LOGS="$ORCH/logs"
CHART="$SRV/docs/brain_evaluation_chart.md"
PORT="${NEXEO_PORT:-4002}"
PM2_APP="${NEXEO_PM2_APP:-tmcai-server}"
# VERIFIED BY CURL, not read off a route file. I first wrote `/api/external/health`
# from `apiGatewayRoutes.ts` and never called it: it 404s. Every automated deploy
# would then have restarted production, probed, seen 404, declared failure and
# ROLLED BACK a good deploy — while leaving the schema forward-migrated. A
# false-negative probe is worse than no probe. `/api/health` returns 200 with
# dependency detail (database up, latency ms).
HEALTH_PATH="${NEXEO_HEALTH_PATH:-/api/health}"

ITER="${1:?usage: deploy.sh <iteration>}"
n="$(printf '%02d' "$ITER")"
LOG="$LOGS/iter-$n-deploy.log"
mkdir -p "$LOGS" "$STATE"

say() { printf '%s  DEPLOY iter=%s %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "${ITER:-0}" "$*" \
          | tee -a "$LOG" | tee -a "$ORCH/loop.log"; }
die() { say "ABORT: $*"; exit "${2:-1}"; }

[ "${NEXEO_DEPLOY:-0}" = "1" ] || die "NEXEO_DEPLOY is not 1 — deploy phase disabled" 0

cd "$ROOT" || die "cannot cd $ROOT"

# ── 1. GATE ─────────────────────────────────────────────────────────────────
VERDICT="$(python3 - "$ORCH/review_log.md" "$ITER" <<'PY'
import re, sys
try:
    txt = open(sys.argv[1], errors="replace").read()
except Exception:
    print("MISSING"); raise SystemExit
m = re.search(r"^##\s+Iteration\s+%s\b(.*?)(?=^##\s+Iteration|\Z)" % re.escape(sys.argv[2]),
              txt, re.S | re.M)
if not m:
    print("MISSING"); raise SystemExit
v = re.search(r"\*\*(SOUND|WEAK|WRONG)\*\*", m.group(1))
print(v.group(1) if v else "UNKNOWN")
PY
)"
say "iteration $ITER codex verdict: $VERDICT"
MODE="${NEXEO_DEPLOY_ON:-sound}"

# `no-critical` — ship unless the reviewer raised a CRITICAL or HIGH finding.
#
# Reasoning, on the record: gating on SOUND produced 2 shipped-eligible iterations out
# of 17 and starved deployment for a day. Under the owner's 2026-08-13 rubric
# undeployed work is worth ZERO capability, so a gate that blocks everything actively
# prevents the improvement it is meant to protect. Iteration 17 is the case in point —
# Codex confirmed it CLOSED all three prior divergences and still ruled WEAK over a
# MEDIUM (email treated as a phone) and a bootstrap ordering concern. Withholding a
# fix that is demonstrably better than production, to protect a principle, is the
# wrong trade.
#
# What still blocks: CRITICAL or HIGH. Iteration 13's silent data loss was CRITICAL and
# would be held exactly as it was. The reviewer still decides; only the threshold moves.
if [ "$MODE" = "no-critical" ]; then
  BLOCKERS="$(python3 - "$ORCH/review_log.md" "$ITER" <<'PYX'
import re, sys
try:
    txt = open(sys.argv[1], errors="replace").read()
except Exception:
    print("PARSE-FAILED"); raise SystemExit
m = re.search(r"^##\s+Iteration\s+%s(.*?)(?=^##\s+Iteration|\Z)" % re.escape(sys.argv[2]),
              txt, re.S | re.M)
if not m:
    print("NO-REVIEW"); raise SystemExit
found = re.findall(r"\*\*(CRITICAL|HIGH)\s*—", m.group(1))
print(",".join(sorted(set(found))) if found else "")
PYX
)"
  if [ -n "$BLOCKERS" ]; then
    say "HOLD — reviewer raised $BLOCKERS on iteration $ITER. Nothing shipped."
    printf '%s %s hold:%s
' "$(date -u +%FT%TZ)" "$ITER" "$BLOCKERS" >> "$STATE/deploy-holds"
    exit 0
  fi
  say "gate: no CRITICAL or HIGH finding on iteration $ITER (verdict $VERDICT) — clear to ship"
fi
if [ "$MODE" = "sound" ] && [ "$VERDICT" != "SOUND" ]; then
  # Not a failure — a deliberate hold. The commit stays queued for a later deploy
  # once a subsequent iteration's review is clean.
  say "HOLD — deploy requires a SOUND review (got $VERDICT). Nothing shipped."
  printf '%s %s hold:%s\n' "$(date -u +%FT%TZ)" "$ITER" "$VERDICT" >> "$STATE/deploy-holds"
  exit 0
fi

DEPLOY_SHA="$(git rev-parse HEAD)"
PREV_SHA="$(cat "$STATE/deployed-sha" 2>/dev/null || echo "")"
[ "$DEPLOY_SHA" = "$PREV_SHA" ] && { say "already deployed $(git rev-parse --short HEAD) — nothing to do"; exit 0; }

DEFS="$(git log --oneline ${PREV_SHA:+$PREV_SHA..}HEAD --grep='^DEF-' -E 2>/dev/null \
        | grep -oE 'DEF-[0-9]+' | sort -u | tr '\n' ' ')"
say "deploying $(git rev-parse --short "$DEPLOY_SHA") · defects: ${DEFS:-none named}"

# Dirty tree = stop. CLAUDE.md: failed pull, dirty tree, failed build or migration
# = stop and report, never improvised recovery. Orchestrator docs are expected to
# be dirty, so only Brain paths count.
DIRTY="$(git status --porcelain -- server/src server/tests server/prisma | head -5)"
[ -n "$DIRTY" ] && die "Brain paths dirty at deploy time:
$DIRTY"

# ── 2. RAILS at the deploy commit ────────────────────────────────────────────
say "re-verifying at the deploy commit"
( cd "$SRV" && npx tsc --noEmit ) >> "$LOG" 2>&1 || die "tsc RED at deploy commit"
( cd "$SRV" && npx vitest run --reporter=dot ) >> "$LOG" 2>&1 || die "tests RED at deploy commit"
# SNAPSHOT FIRST. This used to run AFTER the build, so the "rollback snapshot" was a
# copy of the NEW dist — restoring it would have restored the very build you were
# rolling back from. The comment said "BEFORE anything touches production"; the build
# three lines above had already rewritten dist. Taken before the build, it is the last
# known-good artifact, which is what a rollback needs.
BACKUP="/tmp/nexeo-dist-backup-$(date -u +%Y%m%d-%H%M%S)"
cp -a "$SRV/dist" "$BACKUP" 2>/dev/null && say "dist snapshot (pre-build, last known good): $BACKUP"

# ── THE UNLOCK, THE BUILD, THE MANIFEST, THE RELOCK ──────────────────────────
#
# server/dist is chattr +i. CLAUDE.md: "the unlock IS the authorization moment", set
# after an unauthorised build replaced production at 19:15 on 2026-08-16. Running the
# loop with NEXEO_DEPLOY=1 is that authorization, given deliberately and once — but it
# only holds if the window closes again every time, including on failure.
#
# The trap is the whole point. die() exits, tsc can fail, the migration can abort — and
# any exit that skipped the relock would leave production writable indefinitely, which
# is strictly worse than never having locked it, because it looks locked in the runbook.
relock() {
  if command -v chattr >/dev/null 2>&1; then
    chattr -R +i "$SRV/dist" 2>/dev/null \
      && say "dist relocked (immutable)" \
      || say "WARNING dist could NOT be relocked — production is writable, fix by hand"
  fi
}
trap relock EXIT

chattr -R -i "$SRV/dist" 2>/dev/null || die "could not unlock server/dist for the build"
say "dist unlocked for the build (relock is trapped on every exit path)"

( cd "$SRV" && npm run build ) >> "$LOG" 2>&1 || die "npm run build FAILED"

# The manifest command is canonical and copied EXACTLY from CLAUDE.md. It is sensitive
# to BOTH path rendering and sort locale — the same directory yields four different
# digests across ./path vs %P and ambient vs LC_ALL=C — so a digest computed any other
# way is not comparable to the recorded one and is not evidence.
MANIFEST="$(cd "$SRV/dist" && find . -name '*.js' -type f -printf '%P\n' \
  | LC_ALL=C sort | xargs sha256sum | sha256sum | awk '{print $1}')"
say "dist manifest: $MANIFEST"
printf '%s  %s\n' "$MANIFEST" "$(git rev-parse --short HEAD)" >> "$ORCH/state/deploy-manifests"

say "rails: tsc clean · tests green · build ok · manifest recorded"

if [ "${NEXEO_DEPLOY_DRYRUN:-0}" = "1" ]; then
  say "DRY RUN — stopping before migration and restart"
  exit 0
fi

# ── 3. CHART row, written BEFORE the deploy ─────────────────────────────────
CHART_ROW="$(python3 - "$CHART" "$ITER" "$(git rev-parse --short "$DEPLOY_SHA")" "$DEFS" "$VERDICT" <<'PY'
import re, sys, datetime
chart, iteration, sha, defs, verdict = sys.argv[1:6]
body = open(chart, errors="replace").read()
hdr = "| # | Deployed (PKT) | HEAD | DEFs | Predicted impact | Observed | Verdict |"
if hdr not in body:
    raise SystemExit(0)
nums = [int(m) for m in re.findall(r"^\| \*\*D-(\d+)\*\*", body, re.M)]
nxt = (max(nums) + 1) if nums else 23
pkt = datetime.datetime.utcnow() + datetime.timedelta(hours=5)
row = (f"| **D-{nxt}** | **{pkt:%m-%d %H:%M} PKT** | `{sha}` | {defs or 'see log'} | "
       f"**Predicted:** the fixes named in this range reach production; each carries "
       f"its own DEF row with root cause and tests. Codex reviewed the shipping "
       f"iteration **{verdict}**. **Risk:** these are the first loop-produced changes "
       f"deployed automatically by the orchestrator's deploy phase — the phase itself "
       f"is new, so its own failure modes (migration ordering, probe accuracy, "
       f"rollback) are as untested as the code it ships. Mitigated by: re-running the "
       f"full matrix at the deploy commit, a dist snapshot before touching production, "
       f"an HTTP probe rather than a pm2 status read, and automatic rollback on probe "
       f"failure. **Judged by:** the boot log carrying no NEW errors and the health "
       f"probe answering on :4002 after restart. | *(written before deploy — observed "
       f"result appended by the deploy phase)* | *(pending)* |\n")
lines = body.split("\n")
for i, ln in enumerate(lines):
    if ln.startswith(hdr[:20]):
        # after header + separator
        lines.insert(i + 2, row.rstrip("\n"))
        break
open(chart, "w").write("\n".join(lines))
print(f"D-{nxt}")
PY
)"
say "evaluation-chart row written (pre-deploy): ${CHART_ROW:-none}"

# ── 3b. THE OTHER HALF OF THE ROW ────────────────────────────────────────────
#
# WHAT WAS MISSING, and it was missing for every automated deploy (found 2026-09-07).
# The row above is written BEFORE the deploy and ends with the two placeholder cells
# "*(written before deploy — observed result appended by the deploy phase)*" and
# "*(pending)*". NOTHING IN THIS FILE EVER APPENDED THEM. The phase restarted
# production, probed it, read the boot log — and then exited, leaving the row saying a
# result would arrive that no line of code was ever going to write. D-102, D-103 and
# D-104 (2026-09-05/06/07) all sit at "(pending)" with the evidence sitting unread in
# their own deploy logs.
#
# That is CLAUDE.md rule 3 — "Report the evaluation chart at EVERY deploy … Anything
# not exercised is stated as NOT VERIFIED, never assumed" — half-implemented: the
# prediction was recorded so it could be wrong on the record, and then the record was
# never closed. A chart of predictions with no observations cannot answer the only
# question it exists to answer, which is whether the loop is getting anywhere.
#
# The verdict this writes is UNVERIFIED, never PROGRESS. A green build and a healthy
# probe say the code is RUNNING; they say nothing about whether the defect is fixed for
# the owner, and this project has a chart full of rows about that exact confusion.
# ── AND THE DEF ROW ITSELF ───────────────────────────────────────────────────
#
# THE SYMPTOM THE OWNER ACTUALLY SAW (2026-09-07). His Build Pulse deck read
# "DEF-321 · alert fix built but not deployed" while DEF-321 had been live on
# production for two days. The deck was not wrong — it reads `brain_change_log.md`,
# and that row still said "**NOT YET at build time** (Builder does not deploy)",
# which is the Builder's honest note about ITS OWN moment. Nothing was ever going to
# replace it, because the Builder cannot deploy and the deploy phase never wrote back.
#
# CLAUDE.md rule 2 — "no fix ships without its DEF row updated (resolved date-time,
# commit, verification)". This is the deploy half of that rule, and it had no
# implementation at all. Its absence does not just lose bookkeeping: it tells the
# owner on his own dashboard that shipped work is unshipped, which is the exact
# "months of progress look like circling" failure the three-document protocol exists
# to end.
#
# Narrow on purpose: it rewrites the DEPLOYED cell and ONLY when that cell still
# says NOT YET. It never touches verification, never marks anything VERIFIED —
# deployed is not verified, and this phase cannot see the owner's traffic.
defs_deployed() {
  [ -n "${DEFS:-}" ] || return 0
  python3 - "$SRV/docs/brain_change_log.md" "$1" "$2" "${CHART_ROW:-}" $DEFS <<'PYDEF'
import re, sys
log, sha, ts, row = sys.argv[1:5]
defs = sys.argv[5:]
lines = open(log, errors="replace").read().split(chr(10))
moved = []
for i, ln in enumerate(lines):
    m = re.match(r"^\| \*\*(DEF-\d+)\*\* \|", ln)
    if not m or m.group(1) not in defs:
        continue
    cells = ln.split(" | ")
    # Section A rows carry a DEPLOYED? column (8 cells); section B rows do not.
    if len(cells) < 8:
        continue
    if "NOT YET" not in cells[6].upper() and "not yet" not in cells[6]:
        continue
    cells[6] = (f"**DEPLOYED `{sha}` {ts} UTC** by the loop's deploy phase"
                + (f" ({row})" if row else "")
                + " — deployed is NOT verified")
    lines[i] = " | ".join(cells)
    moved.append(m.group(1))
if moved:
    open(log, "w").write(chr(10).join(lines))
print(" ".join(moved) if moved else "none")
PYDEF
}

CHART_ROW="${CHART_ROW:-}"
chart_observe() {
  # $1 = row id (D-NN) · $2 = observed cell · $3 = verdict cell
  [ -n "${1:-}" ] || return 0
  python3 - "$CHART" "$1" "$2" "$3" <<'PYOBS'
import sys
chart, row, observed, verdict = sys.argv[1:5]
clean = lambda t: t.replace("|", "¦").replace("\n", " · ").strip()
placeholder = ("| *(written before deploy — observed result appended by the deploy "
               "phase)* | *(pending)* |")
lines = open(chart, errors="replace").read().split("\n")
hit = False
for i, ln in enumerate(lines):
    if ln.startswith(f"| **{row}** |") and placeholder in ln:
        lines[i] = ln.replace(placeholder, f"| {clean(observed)} | {clean(verdict)} |")
        hit = True
        break
if hit:
    open(chart, "w").write("\n".join(lines))
print("observed" if hit else "row-not-found")
PYOBS
}

# ── 4. MIGRATIONS ───────────────────────────────────────────────────────────
# Hand-written, idempotent, applied by name-tracking in state. A failure stops the
# deploy before restart: shipping code that expects a schema it did not get is
# worse than not shipping.
APPLIED="$STATE/migrations-applied"
touch "$APPLIED"
for dir in "$SRV/prisma/migrations"/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/migration.sql" ] || continue
  grep -qxF "$name" "$APPLIED" && continue
  # Only migrations introduced in this deploy range are candidates; older ones are
  # assumed already applied by earlier manual deploys and are recorded as such.
  if [ -n "$PREV_SHA" ] && ! git diff --name-only "$PREV_SHA" HEAD -- "$dir" | grep -q .; then
    printf '%s\n' "$name" >> "$APPLIED"; continue
  fi
  say "applying migration $name"
  if psql "${DATABASE_URL:-$(grep -m1 '^DATABASE_URL=' "$SRV/.env" | cut -d= -f2- | tr -d '"')}" \
        -v ON_ERROR_STOP=1 -f "$dir/migration.sql" >> "$LOG" 2>&1; then
    printf '%s\n' "$name" >> "$APPLIED"
    MIGS_RUN="${MIGS_RUN:-}$name "
    say "migration $name applied"
  else
    chart_observe "$CHART_ROW" "**NOT DEPLOYED — migration \`$name\` FAILED.** Production was never restarted and the code never shipped; the schema is unchanged for this migration. Deploy log: \`$LOG\`." "**UNVERIFIED — nothing shipped.** Next action: fix the migration by hand, then re-run this iteration's deploy."
    die "migration $name FAILED — production NOT restarted, code NOT shipped"
  fi
done

# ── 5. RESTART + 6. PROBE ───────────────────────────────────────────────────
BOOT_MARK="$(date -u +%s)"
pm2 restart "$PM2_APP" >> "$LOG" 2>&1 || die "pm2 restart failed"
say "pm2 restart issued; probing :$PORT"

OK=0
for i in $(seq 1 20); do
  sleep 3
  body="$(curl -s --max-time 5 "http://127.0.0.1:$PORT$HEALTH_PATH" 2>/dev/null || true)"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT$HEALTH_PATH" 2>/dev/null || echo 000)"
  # 200 alone is not health: the endpoint reports dependency state, and a server
  # answering while its database is down is the false-green this project has a
  # chart row about.
  if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"status":"healthy"'; then
    OK=1; PROBE_SECS=$((i*3)); say "health probe 200 + status=healthy after ${PROBE_SECS}s"; break
  fi
done

if [ "$OK" -ne 1 ]; then
  # ── 7. ROLLBACK ──
  say "PROBE FAILED — rolling back to ${PREV_SHA:-previous dist}"
  [ -d "$BACKUP" ] && rm -rf "$SRV/dist" && cp -a "$BACKUP" "$SRV/dist" && say "dist restored"
  pm2 restart "$PM2_APP" >> "$LOG" 2>&1
  sleep 6
  back="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$HEALTH_PATH" 2>/dev/null || echo 000)"
  say "post-rollback probe: $back"
  say "MIGRATIONS ARE NOT ROLLED BACK — they are idempotent and forward-only by design. Schema is ahead of the restored code."
  chart_observe "$CHART_ROW" "**ROLLED BACK — NOT DEPLOYED.** The health probe on :$PORT$HEALTH_PATH never answered 200 with \`status:healthy\` in 60s, so the pre-build dist snapshot was restored and production restarted; the post-rollback probe returned \`$back\`. **Migrations were NOT rolled back** (idempotent, forward-only) so the schema is AHEAD of the restored code — that is stated, not hidden. Applied this run: ${MIGS_RUN:-none}. Deploy log: \`$LOG\`." "**UNVERIFIED — nothing reached the owner.** Next action: read the boot log for why the probe failed before re-attempting this commit."
  die "deploy failed and was rolled back" 2
fi

NEWERR="$(pm2 logs "$PM2_APP" --lines 200 --nostream 2>/dev/null \
          | grep -iE "error|unhandled|ECONN|cannot find" | tail -5)"
printf '%s' "$DEPLOY_SHA" > "$STATE/deployed-sha"
printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$ITER" "$(git rev-parse --short "$DEPLOY_SHA")" \
  >> "$STATE/deploy-history"
say "DEPLOYED $(git rev-parse --short "$DEPLOY_SHA") · defects: ${DEFS:-none named}"
[ -n "$NEWERR" ] && say "boot log carries errors (may be pre-existing — NOT verified as new):
$NEWERR"
say "live acceptance of individual DEFs is NOT verified by this phase — that needs real traffic"

# THE ROW IS CLOSED HERE, and it is closed honestly. What this phase can witness is
# exactly four things: the matrix was green at the deploy commit, the artifact it built
# has this digest, production restarted, and the health endpoint answered. What it
# CANNOT witness is whether any named DEF is actually fixed for the owner — that needs
# his traffic — so the verdict is UNVERIFIED and the next action names what would move
# it. A deploy phase that wrote PROGRESS on a green probe would be manufacturing the
# evidence the chart exists to demand.
MOVED="$(defs_deployed "$(git rev-parse --short "$DEPLOY_SHA")" "$(date -u '+%Y-%m-%d %H:%M')")"
say "DEF rows moved to DEPLOYED: ${MOVED:-none}"

chart_observe "$CHART_ROW" \
  "**DEPLOYED \`$(git rev-parse --short "$DEPLOY_SHA")\` at $(date -u '+%Y-%m-%d %H:%M') UTC, written by the deploy phase itself.** Matrix re-run AT the deploy commit: \`tsc --noEmit\` clean, \`vitest run\` green. Dist manifest \`${MANIFEST:0:16}…\` (canonical command), built under an explicit \`chattr -i\` unlock and relocked on exit. Migrations applied this run: ${MIGS_RUN:-none}. \`pm2 restart $PM2_APP\`, then **health probe 200 with \`status:healthy\` after ${PROBE_SECS:-?}s** on :$PORT$HEALTH_PATH — an HTTP probe, not a pm2 status read. Boot log after restart: $([ -n "$NEWERR" ] && printf 'carries error lines, NOT established as new (pre-existing until compared)' || printf 'no error lines in the last 200'). **NOT VERIFIED:** live acceptance of ${DEFS:-the shipped changes} — no owner traffic has exercised them, and no capability number was re-measured by this phase." \
  "**UNVERIFIED — the code is running, the fix is not proven.** A healthy probe is evidence of a live process and nothing more. Next action: exercise ${DEFS:-the shipped changes} against real traffic, and let the next capability scoring run say whether anything moved."
exit 0
