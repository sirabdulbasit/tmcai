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
LOG="$ORCH/logs/chat-analysis-$(date -u +%Y%m%dT%H%M%S).log"
CLAUDE_BIN="${CLAUDE_BIN:-/root/.local/bin/claude}"
MODEL="${NEXEO_CHAT_MODEL:-claude-opus-4-8}"

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
if ( cd "$ROOT" && "$CLAUDE_BIN" -p "$PROMPT" \
      --model "$MODEL" --fallback-model claude-opus-4-8 \
      --output-format text \
      --permission-mode dontAsk \
      --disallowed-tools 'Write,Edit,NotebookEdit' \
      --add-dir "$ROOT" \
      --max-turns "${NEXEO_ANALYSIS_MAX_TURNS:-12}" ) > "$LOG" 2>&1; then
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
    echo "run-chat-analysis: reply incomplete (too short, or no SIGNATURES table) — previous ranking kept" >&2
    exit 1
  fi
else
  echo "run-chat-analysis: claude exited non-zero — previous ranking kept (see $LOG)" >&2
  exit 1
fi
