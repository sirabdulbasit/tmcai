#!/usr/bin/env bash
#
# run-score.sh — the SCORING seat (Grok), the loop's third agent.
#
# Owner, 2026-08-12: *"will orch window (terminal) will show progress of each
# agent?"* — it did not, for this seat. The Builder and Codex streamed to the loop
# window while grok's output went only to a log file, so the scoring window sat
# empty and the third agent looked dead. Phase 1 now streams `SCORE │` lines the
# same way the other two do; phase 2's raw JSON is captured but not echoed, since a
# wall of JSON would bury the readable narration.
#
# Owner, 2026-08-12: *"i want to add grok as a 3rd agent which has to build brain
# score after reading codebase"*.
#
# WHY A THIRD AGENT. Until now the orchestrator scored the nine capabilities while
# also choosing what got built and reporting the outcome — judge, contractor and
# press office in one. It cost real accuracy: six iterations of genuine work were
# suppressed behind a "live-verified" bar the orchestrator itself had made
# unpassable by forbidding deploys, and it took the owner challenging it to
# recalibrate. Scoring now sits with an agent that builds nothing and reviews
# nothing.
#
# `NotebookEdit` is deliberately absent from the deny list: grok rejects it as an
# "unsupported tool prefix" and refuses to start, which is how the first scoring
# pass failed. Verified individually — Write, Edit, MultiEdit are accepted.
#
# READ-ONLY, ENFORCED BY THE HARNESS. `--deny` removes every write tool rather
# than asking the scorer to behave. Three agents in one tree is one more than the
# two that already produced an attribution mess (my own tooling reviewed as the
# Builder's undisclosed scope, iteration 2). Its whole output is JSON on stdout.
#
# STRUCTURED OUTPUT, NOT PROSE. `--json-schema` constrains the model to
# score-schema.json, which REQUIRES per-capability evidence of at least 60
# characters and a `basis` naming how it was established. A scorer that can return
# a paragraph will eventually return a paragraph instead of a judgement, and a
# score with no citable basis is exactly what the card must never contain.
#
# Usage:
#   run-score.sh <iteration>            # score, print JSON path
#   run-score.sh <iteration> --dry-run  # render the prompt only, call nothing
#
# Exit: 0 scored · 3 grok missing/not authenticated · 4 invalid JSON · 5 no prompt
set -uo pipefail

ROOT="/var/www/tmcai"
ORCH="$ROOT/server/docs/orchestrator"
STATE="$ORCH/state"
LOGS="$ORCH/logs"
PROMPTS="$ROOT/scripts/orchestrator/prompts"
SCHEMA="$ROOT/scripts/orchestrator/score-schema.json"
GROK_BIN="${GROK_BIN:-/usr/local/bin/grok}"
CLAUDE_BIN="${CLAUDE_BIN:-/root/.local/bin/claude}"
# opus, not the builder's fable — see the conflict note above.
SCORE_MODEL="${NEXEO_SCORE_MODEL:-claude-opus-4-8}"
SESSION_FILE="$STATE/scorer-session-id"
SCORECARD="$STATE/capability_scorecard.json"

ITER="${1:?usage: run-score.sh <iteration> [--dry-run]}"
DRY=0; FRESH=0; POST=0
[ "${2:-}" = "--dry-run" ] && DRY=1
[ "${2:-}" = "--fresh" ] && FRESH=1
# --post: score the tree AFTER the build, into its own file. Owner, 2026-08-24, asking how to
# make the pulse actually improve Brain. The existing card is labelled Pre-Build and is taken
# BEFORE the builder starts — it is what the builder AIMS at. The loop was then reading that same
# pre-build card to decide `capability_moved`, which cannot work: a reading taken before the work
# cannot attest to the work. That is why `capability_moved=yes` has never once appeared in 11
# SHIP lines. A post-build card is the missing half of the comparison.
[ "${2:-}" = "--post" ] && POST=1

n="$(printf '%02d' "$ITER")"
OUT="$ORCH/scores/iter-$n-capability.json"
# A re-baseline gets its own file and is NEVER ingested into the series: it is
# evidence to read AGAINST the running numbers, not a replacement for them.
[ "$FRESH" -eq 1 ] && OUT="$ORCH/scores/iter-$n-capability-fresh.json"
[ "$POST" -eq 1 ] && OUT="$ORCH/scores/iter-$n-capability-post.json"
LOG="$LOGS/iter-$n-score.log"
mkdir -p "$ORCH/scores" "$LOGS" "$STATE"

[ -f "$PROMPTS/score.md" ] || { echo "run-score: missing $PROMPTS/score.md" >&2; exit 5; }
[ -f "$SCHEMA" ] || { echo "run-score: missing $SCHEMA" >&2; exit 5; }

# Carry the previous scoring in as text, so the scorer moves numbers rather than
# re-deriving nine from scratch every iteration — AGENTS.md requires comparison
# against the most recent verified scorecard, and rescoring from zero produces
# noise that reads as progress.
PREVIOUS="## Your previous scoring

None — this is your first scoring pass. Establish the baseline by reading, and be
explicit in \`evidence\` about what each number rests on."
if [ -s "$SCORECARD" ]; then
  PREV_TXT="$(python3 - "$SCORECARD" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
rows = [f"  {c['name']}: {c['nexeo']}" for c in d["capabilities"]]
hist = d.get("history", [])
last = hist[-1] if hist else {}
print("## Your previous scoring (iteration %s, HEAD %s)\n" % (
    d.get("as_of_iteration"), d.get("as_of_head")))
print("\n".join(rows))
print("\nOverall %s. Last recorded movement %s (%s)." % (
    round(sum(c["nexeo"] for c in d["capabilities"]) / len(d["capabilities"]), 1),
    last.get("movement"), last.get("verdict")))
ev = last.get("evidence")
if ev:
    print("\nWhat the previous entry credited:")
    for e in ([ev] if isinstance(ev, str) else ev):
        print("  - %s" % str(e)[:400])
print("\nNOTE: entries before this iteration were the ORCHESTRATOR's judgements, "
      "not yours. Treat them as a starting point to be corrected where the code "
      "disagrees, not as a floor you must respect.")
PY
)"
  [ -n "$PREV_TXT" ] && PREVIOUS="$PREV_TXT"
fi

# ── --fresh: DERIVE ALL NINE FROM SCRATCH ───────────────────────────────────
#
# Owner, 2026-08-13, on 22 iterations producing +0.7: "i have very serious concern
# with such progress in decimals". Checking the history to answer him found
# something worse than a slow rate: across eleven cards, EIGHT of the nine
# capabilities have never moved once, and the largest single-iteration change on any
# of them is +2.
#
# Two possible causes, and they must be separated. Either nothing was ever built
# (all 22 turns were repairs of one existing capability), or the flatness is an
# artefact of MY OWN prompt, which tells the scorer to carry its previous numbers
# forward, forbids moving one without citable evidence, and then states that nothing
# is deployed so live evidence is unavailable. A scorer given those three
# instructions will carry the numbers forward whatever the code does.
if [ "$FRESH" -eq 1 ]; then
  PREVIOUS="## FROM-SCRATCH RE-BASELINE — your previous card is deliberately withheld

Derive all nine capabilities from the codebase as it stands, as if scoring it for the
first time. Do not attempt to recall your earlier numbers and do not anchor to them.

**Why you are being asked.** Across eleven cards you have moved eight of the nine
capabilities exactly zero times, and the largest single change on any was +2. The
orchestrator cannot tell whether that is because nothing was built or because the
standing instruction to carry numbers forward has left the scorecard insensitive to
change. This run separates those explanations, so an honest answer is worth more than
a consistent one.

If a capability is genuinely where you had it, say so and the earlier reading is
confirmed. If a fresh read gives a different number — higher OR lower — report what
the evidence supports and say what you had missed. **You will not be corrected for
disagreeing with your own previous card.** This output is recorded alongside the
running series and never substituted for it."
fi

PROMPT="$(sed -e "s|@@ITER@@|$ITER|g" "$PROMPTS/score.md")"
# Runtime evidence. A failure here must NOT block scoring — the scorer simply loses
# live-evidence for this run and says so, which is honest. Silence would be worse:
# it would look like the capability does not fire.
EVIDENCE="_Runtime evidence unavailable for this run — score from the code and say so in \`unverifiable\`._"
if [ -x "$ROOT/scripts/orchestrator/evidence-pack.sh" ]; then
  EV_TXT="$("$ROOT/scripts/orchestrator/evidence-pack.sh" 2>/dev/null || true)"
  [ -n "$EV_TXT" ] && EVIDENCE="$EV_TXT"
fi
PROMPT="${PROMPT//@@EVIDENCE@@/$EVIDENCE}"
PROMPT="${PROMPT//@@PREVIOUS@@/$PREVIOUS}"

if [ "$DRY" -eq 1 ]; then
  printf '%s\n' "$PROMPT"
  exit 0
fi

[ -x "$CLAUDE_BIN" ] || { echo "run-score: claude not executable at $CLAUDE_BIN" >&2; exit 3; }

# Session continuity, same principle as the other two seats: the scorer should
# remember what it scored three iterations ago. `--session-id` opens a named
# session; `--resume` continues it. A lost session is reported, never silently
# replaced with a fresh one — that would quietly turn "moved +1" into a rescore
# from scratch.
declare -a session_args
if [ -s "$SESSION_FILE" ]; then
  session_args=(--resume "$(cat "$SESSION_FILE")")
else
  sid="$(cat /proc/sys/kernel/random/uuid)"
  printf '%s' "$sid" > "$SESSION_FILE"
  session_args=(--session-id "$sid")
fi

# --deny is the read-only enforcement. --permission-mode dontAsk keeps it headless
# without granting writes.
# TWO PHASES, AND THE REASON IS A HARD CLI CONSTRAINT.
#
# `--json-schema` constrains the model to emit JSON immediately, so it cannot use
# tools first. The first attempt proved it: grok returned in 13 seconds with
# `"evidence": "placeholder"` on all nine capabilities and `stopReason:
# "cancelled"`. It had read nothing, because with a schema attached there is no
# turn in which to read. Structured output and agentic reading cannot happen in
# one call.
#
# So: phase 1 READS, with tools, no schema, and produces prose. Phase 2 RESUMES
# that session and formats the analysis into the schema. The scorer's judgement is
# formed in phase 1; phase 2 is only transcription of its own findings.
run_grok_read() {
  # Phase 1 READS with tools and returns prose; phase 2 transcribes it into the schema.
  # Structured output and agentic reading cannot happen in one call — a model given a
  # schema emits JSON immediately and never opens a file.
  ( cd "$ROOT" && "$CLAUDE_BIN" -p "$1" \
    "${@:2}" \
    --model "$SCORE_MODEL" \
    --fallback-model claude-opus-4-8 \
    --output-format text \
    --permission-mode dontAsk \
    --disallowed-tools 'Write,Edit,NotebookEdit' \
    --max-turns 80 2>&1 ) \
    | tee "$READ_LOG" \
    | sed -u 's/^/SCORE  │ /'
  # codex's status, not tee's or sed's — a formatter exiting 0 must never launder a
  # failed scoring pass into a success.
  return "${PIPESTATUS[0]}"
}

run_grok_format() {
  # Phase 2: resume the thread that did the reading and transcribe ITS OWN findings
  # into the schema. --output-schema takes a FILE, where grok took the schema inline.
  ( cd "$ROOT" && "$CLAUDE_BIN" -p "$FORMAT_PROMPT" \
    --resume "$1" \
    --model "$SCORE_MODEL" \
    --fallback-model claude-opus-4-8 \
    --json-schema "$(cat "$SCHEMA")" \
    --output-format json \
    --permission-mode dontAsk \
    --disallowed-tools 'Write,Edit,NotebookEdit' \
    --max-turns 4 2>&1 ) \
    | tee "$LOG" \
    | sed -u 's/^/SCORE  │ [json] /' >/dev/null
  # Phase 2 is one JSON blob: tee'd for the parser, and NOT echoed to the window,
  # where a wall of raw JSON would bury the readable phase-1 narration.
  return "${PIPESTATUS[0]}"
}

READ_LOG="$LOGS/iter-$n-score-read.log"
READ_PROMPT="$PROMPT

## THIS TURN IS FOR READING ONLY

Do NOT output JSON yet. Read the files named above, follow the code for each
capability, and end your turn with your findings in prose: for every one of the
nine capabilities, the score you will give it and the file:line, commit or DEF id
that justifies it. You will be asked for the JSON next, from this same session, so
what you establish now is what you will report."

FORMAT_PROMPT="Now output ONLY the JSON for the scorecard, matching the schema
exactly, using the nine scores and the evidence you just established.

Requirements the schema enforces and I will re-check on ingest:
- all nine capabilities, in BRAIN_VISION.md order
- \`evidence\` at least 60 characters, citing what you actually read (file:line,
  commit, DEF id, or doc row) — NOT the word placeholder, and not a restatement
  of the capability name
- \`basis\` one of code-read / test-read / doc-read / live-evidence / absent
- \`what_moved\` and \`what_did_not\` at least 30 characters each

An unevidenced entry is rejected and the whole scoring pass is retried, so write
the real citation."

# Phase 1 — read.
run_grok_read "$READ_PROMPT" "${session_args[@]}"
rc=$?

# A recorded session id that was never actually created makes every resume fail.
# That is different from a session that existed and was lost: here a fresh start
# is the correct repair, not a silent downgrade. Retried once, loudly.
#
# THE PATTERN WAS WRONG AND IT COST SEVEN DAYS OF MEASUREMENT (found 2026-09-07).
# This list was written from the shapes an HTTP resume failure takes. The CLI does
# not emit any of them: a dead session prints
#
#   No conversation found with session ID: <uuid>
#
# and exits 1. Reproduced on this box against a fabricated uuid. So `rc` was
# non-zero, the recovery branch did not match, run-score exited non-zero, and the
# loop logged "grok FAILED" and carried on — every run from iteration 56
# (2026-08-31 13:00) to iteration 73 (2026-09-07 02:58), TWELVE consecutive runs.
# No iter-NN-capability.json was produced, so no card was ingested, so
# `capability_scorecard.json` froze at iteration 54 / d144edf, so the ADVANCE test
# in nexeo-loop.sh (compare the last two cards) could never see a rise and the
# iteration counter froze at 73 — while each night still built, reviewed and
# DEPLOYED a real fix. The loop was working and its instrument was dead.
#
# The lesson this file should carry: match on what the tool ACTUALLY printed, and
# never let a diagnostic path be the one thing nothing exercises.
if [ "$rc" -ne 0 ] && grep -qiE "not found locally|404 Not Found|Failed to restore session|No conversation found" "$READ_LOG"; then
  echo "run-score: recorded session does not exist — opening a NEW one and retrying once" >&2
  sid="$(cat /proc/sys/kernel/random/uuid)"
  printf '%s' "$sid" > "$SESSION_FILE"
  # `--session-id` was passed twice here. The CLI tolerates it (verified, rc=0), so it
  # cost nothing, but a duplicated flag reads as a typo in a recovery path nobody had
  # ever seen run — and this one had never run.
  run_grok_read "$READ_PROMPT" --session-id "$sid"
  rc=$?
fi

# The session id grok actually used, read back from its own output rather than
# assumed — if it forked or renamed, resuming the wrong id would format a session
# that never did the reading.
ACTUAL_SID="$(grep -oE '"session_?[Ii]d":"[0-9a-f-]{36}"' "$READ_LOG" | head -1 | grep -oE '[0-9a-f-]{36}' || true)"
[ -z "$ACTUAL_SID" ] && ACTUAL_SID="$(cat "$SESSION_FILE")"
printf '%s' "$ACTUAL_SID" > "$SESSION_FILE"

# Phase 2 — format what it just found.
run_grok_format "$ACTUAL_SID"
rc=$?

# The JSON may be wrapped by the CLI's own envelope; take the first object that
# parses AND carries `capabilities`, so a wrapper cannot be mistaken for a score.
python3 - "$LOG" "$OUT" <<'PY'
import json, re, sys
raw = open(sys.argv[1], errors="replace").read()
cands = []
for m in re.finditer(r"\{", raw):
    dec = json.JSONDecoder()
    try:
        obj, _ = dec.raw_decode(raw[m.start():])
    except Exception:
        continue
    if isinstance(obj, dict):
        if "capabilities" in obj:
            cands.append(obj)
        # CLI envelopes commonly nest the payload under result/content/text.
        for k in ("result", "output", "content", "text", "response"):
            v = obj.get(k)
            if isinstance(v, str) and "capabilities" in v:
                try:
                    inner = json.loads(v)
                    if isinstance(inner, dict) and "capabilities" in inner:
                        cands.append(inner)
                except Exception:
                    pass
            elif isinstance(v, dict) and "capabilities" in v:
                cands.append(v)
if not cands:
    sys.stderr.write("run-score: no scorecard JSON found in grok output\n")
    sys.exit(4)
json.dump(cands[0], open(sys.argv[2], "w"), indent=2)
print(sys.argv[2])
PY
prc=$?
if [ "$prc" -ne 0 ]; then
  echo "run-score: grok exit=$rc but no valid scorecard — see $(basename "$LOG")" >&2
  exit 4
fi
exit 0
