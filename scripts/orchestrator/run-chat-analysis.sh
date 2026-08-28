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
  if [ "$(wc -c < "$LOG")" -gt 400 ]; then
    cp "$LOG" "$OUT"
    echo "run-chat-analysis: ranking updated ($(wc -l < "$OUT") lines)"
  else
    echo "run-chat-analysis: reply too short to be a ranking — previous one kept" >&2
    exit 1
  fi
else
  echo "run-chat-analysis: claude exited non-zero — previous ranking kept (see $LOG)" >&2
  exit 1
fi
