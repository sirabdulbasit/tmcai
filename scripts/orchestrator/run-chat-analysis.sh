#!/usr/bin/env bash
#
# run-chat-analysis.sh — the Chat Analysis stage, standalone.
#
# It existed only inside nexeo-loop.sh, which meant the only way to re-read the owner's
# conversations was to run a whole $7-21 iteration. watch-conversations.sh needs to
# analyse on every new conversation and build only sometimes, so the cheap half had to
# come out of the expensive one.
#
# READ ONLY, and one call. No session resume: this is a fresh judgement each time,
# because the previous ranking is passed IN as text (below) rather than carried in a
# conversation the analyst might defend rather than revise.
set -uo pipefail

ROOT="/var/www/tmcai"
ORCH="$ROOT/server/docs/orchestrator"
STATE="$ORCH/state"
PROMPTS="$ROOT/scripts/orchestrator/prompts"
OUT="$STATE/chat-root-causes.md"
STAMP="$(date -u +%Y%m%dT%H%M%S)"
# THREE FILES, THREE JOBS — this seat used to write one and it cost us the ability to bill it.
#   .jsonl  the raw event stream: the ONLY place usage and cost exist, read by
#           orchestratorSpendService. Under --output-format text there was no such record, so
#           the every-ten-minutes cron was structurally unbillable and the heal seat has sat at
#           "never measured" since the deck was built.
#   .log    the analyst's ANSWER, extracted from the stream. This is what the SIGNATURES gate
#           reads and what becomes the ranking, so it must stay plain text — writing the JSON
#           envelope here would put a wall of events into chat-root-causes.md.
#   .err    stderr, kept OUT of the event stream. Merging it in (the old `2>&1`) would put
#           non-JSON lines in the middle of the evidence file.
LOG="$ORCH/logs/chat-analysis-$STAMP.log"
RAW="$ORCH/logs/chat-analysis-$STAMP.jsonl"
ERR="$ORCH/logs/chat-analysis-$STAMP.err"
CLAUDE_BIN="${CLAUDE_BIN:-/root/.local/bin/claude}"
MODEL="${NEXEO_CHAT_MODEL:-claude-opus-4-8}"

# WHO LAUNCHED THIS RUN, recorded before it starts so a crashed or timed-out run is still
# attributed. A seat is not a schedule: this same script is the ten-minute cron's analyst AND
# what someone runs by hand to re-read the conversations, and the spend deck has to tell those
# apart. watch-conversations.sh exports NEXEO_TRIGGER; a bare terminal run leaves it unset and
# is honestly recorded as `manual`.
printf '%s' "${NEXEO_TRIGGER:-manual}" > "$ORCH/logs/chat-analysis-$STAMP.trigger" 2>/dev/null || true

[ -x "$CLAUDE_BIN" ] || { echo "run-chat-analysis: claude not executable" >&2; exit 3; }
[ -f "$PROMPTS/chat-analysis.md" ] || { echo "run-chat-analysis: prompt missing" >&2; exit 3; }

# Incremental by construction: the previous ranking goes in, so a new conversation is
# read against what is already known. A tag's weight comes from being the sixth
# occurrence, and that is invisible if you only see the newest exchange.
PREV="$(cat "$OUT" 2>/dev/null || echo '(none — this is the first analysis)')"
PROMPT="$(cat "$PROMPTS/chat-analysis.md")

## Your previous ranking — carry it forward, do not re-derive it
$PREV

## What to do now
The transcript in \`server/docs/orchestrator/state/recent-chats.md\` has been refreshed
from production since that ranking was written. Read it, then UPDATE the ranking:
promote an item when a new exchange is another occurrence of it, add what is genuinely
new, and drop nothing silently. If nothing in the new conversation changes the picture,
say exactly that and return the ranking unchanged — an unchanged ranking is a real
answer and it is what tells the loop not to spend a build."

# --add-dir is required: the transcript and the change log live outside any single
# directory claude would default to.
#
# `--output-format stream-json --verbose` rather than `text`: the SAME format the build seat
# has used for 34 recorded runs, chosen deliberately over `json` so no new parser shape enters
# the system — orchestratorSpendService already reads this exact stream, and its `result` event
# is where both the cost and the answer live.
#
# `--no-session-persistence` matches the ruling in ccb4808. That commit fixed nexeo-loop.sh's
# run_chat_analyst, but the ten-minute cron does not call that function — it calls THIS script,
# which was left persisting a transcript for a seat that never resumes.
if ( cd "$ROOT" && "$CLAUDE_BIN" -p "$PROMPT" \
      --no-session-persistence \
      --model "$MODEL" --fallback-model claude-opus-4-8 \
      --output-format stream-json --verbose \
      --permission-mode dontAsk \
      --disallowed-tools 'Write,Edit,NotebookEdit' \
      --add-dir "$ROOT" \
      --max-turns "${NEXEO_ANALYSIS_MAX_TURNS:-12}" ) > "$RAW" 2>"$ERR"; then
  # Pull the analyst's answer out of the stream. The LAST `result` event wins, matching how the
  # spend parser picks the run's own summary on a retry. Extraction failing is treated exactly
  # like a truncated reply below — it fails CLOSED and the previous ranking stands, because an
  # empty $LOG cannot pass the SIGNATURES gate.
  python3 "$ROOT/scripts/orchestrator/extract-result.py" "$RAW" > "$LOG" 2>>"$ERR" || true
  # Only overwrite the ranking on a non-trivial answer. A truncated or empty reply that
  # replaced a good ranking would quietly erase the loop's only account of what is
  # wrong — and it would look like "the analysis ran".
  # A SIZE BAR IS NOT A COMPLETENESS BAR.
  #
  # 400 bytes only catches an empty or stub reply. A reply that is LARGE but truncated
  # sails through it and overwrites a good ranking — and the damage does not stop there.
  # The fingerprint in watch-conversations.sh reads the SIGNATURES table; with no table
  # it falls back to hashing the prose, which is regenerated text that differs on every
  # run. That is the failure already recorded in this system: "root causes CHANGED" fired
  # 18 times out of 18, and the loop rebuilt the same ground while reporting it warranted.
  #
  # So a truncated analysis costs twice — healing loses its ranking, and the build loop
  # churns. The SIGNATURES table is the machine-readable contract the loop depends on
  # (see prompts/chat-analysis.md), so require it rather than a byte count.
  #
  # This is correct independently of any turn ceiling: the weak bar was always the defect.
  # It also makes NEXEO_ANALYSIS_MAX_TURNS safe to lower, because the worst a too-tight
  # ceiling can now do is fail loudly and leave the previous ranking standing.
  if [ "$(wc -c < "$LOG")" -gt 400 ] && grep -q '^## SIGNATURES' "$LOG"; then
    cp "$LOG" "$OUT"
    echo "run-chat-analysis: ranking updated ($(wc -l < "$OUT") lines)"
  else
    echo "run-chat-analysis: reply incomplete (too short, no SIGNATURES table, or the result event could not be extracted) — previous ranking kept (see $RAW, $ERR)" >&2
    exit 1
  fi
else
  echo "run-chat-analysis: claude exited non-zero — previous ranking kept (see $RAW, $ERR)" >&2
  exit 1
fi
