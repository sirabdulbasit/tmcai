#!/usr/bin/env bash
#
# run-score.sh — the SCORING seat (Grok), the loop's third agent.
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
SESSION_FILE="$STATE/grok-session-id"
SCORECARD="$STATE/capability_scorecard.json"

ITER="${1:?usage: run-score.sh <iteration> [--dry-run]}"
DRY=0
[ "${2:-}" = "--dry-run" ] && DRY=1

n="$(printf '%02d' "$ITER")"
OUT="$ORCH/scores/iter-$n-capability.json"
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

PROMPT="$(sed -e "s|@@ITER@@|$ITER|g" "$PROMPTS/score.md")"
PROMPT="${PROMPT//@@PREVIOUS@@/$PREVIOUS}"

if [ "$DRY" -eq 1 ]; then
  printf '%s\n' "$PROMPT"
  exit 0
fi

[ -x "$GROK_BIN" ] || { echo "run-score: grok not executable at $GROK_BIN" >&2; exit 3; }

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
( cd "$ROOT" && "$GROK_BIN" -p "$PROMPT" \
    "${session_args[@]}" \
    --cwd "$ROOT" \
    --json-schema "$(cat "$SCHEMA")" \
    --output-format json \
    --permission-mode dontAsk \
    --deny 'Write' --deny 'Edit' --deny 'MultiEdit' --deny 'NotebookEdit' \
    --disallowed-tools 'Write,Edit,MultiEdit,NotebookEdit' \
    --max-turns 60 ) > "$LOG" 2>&1
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
