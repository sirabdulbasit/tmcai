#!/usr/bin/env bash
#
# watch.sh — one live view of BOTH seats.
#
# Owner, 2026-08-11: *"i want to see both's activities in-session"*, after
# *"i am unable to see it running in session"*.
#
# Tails three streams into one, tagged, as they happen:
#
#   ORCH    the orchestrator's own narration (phases, rails, scores, stalls)
#   BUILD   the Brain Builder's turn — thinking, tool calls, edits
#   REVIEW  Codex's turn — reasoning, commands, its verdict
#
# New per-iteration files appear as the loop advances, so this follows the
# DIRECTORY rather than a fixed filename: `tail -F` on a named file would sit
# silently on iteration 2's log forever while iteration 3 wrote elsewhere. That
# silence is the exact failure this script exists to end.
#
# Usage:
#   scripts/orchestrator/watch.sh            # follow live
#   scripts/orchestrator/watch.sh --replay    # print what already happened, then follow
set -uo pipefail

ORCH="/var/www/tmcai/server/docs/orchestrator"
LOGS="$ORCH/logs"
REPLAY=0
[ "${1:-}" = "--replay" ] && REPLAY=1

command -v inotifywait >/dev/null 2>&1 || {
  printf 'watch.sh: inotifywait not found (apt-get install inotify-tools).\n' >&2
  printf 'Falling back to a 2s poll.\n\n' >&2
}

tag() {  # tag <LABEL> — prefix every line, flushing per line
  local label="$1"
  while IFS= read -r line; do
    printf '%-6s │ %s\n' "$label" "$line"
  done
}

# Track how much of each file has been shown, so a poll never reprints a line.
declare -A SEEN

emit_new() {
  local f="$1" label="$2"
  local total; total="$(wc -l < "$f" 2>/dev/null || echo 0)"
  local seen="${SEEN[$f]:-0}"
  if [ "$total" -gt "$seen" ]; then
    tail -n +"$((seen + 1))" "$f" 2>/dev/null | head -n "$((total - seen))" | tag "$label"
    SEEN[$f]="$total"
  fi
}

# On a cold start, skip what is already there unless --replay: the point is to
# watch what happens NEXT.
if [ "$REPLAY" -eq 0 ]; then
  for f in "$ORCH/loop.log" "$LOGS"/iter-*-build.log "$LOGS"/iter-*-review.log; do
    [ -f "$f" ] && SEEN[$f]="$(wc -l < "$f" 2>/dev/null || echo 0)"
  done
  printf '── watching %s · showing new activity only (--replay for history)\n\n' "$ORCH"
else
  printf '── replaying then watching %s\n\n' "$ORCH"
fi

trap 'printf "\n── watch stopped (the loop itself is unaffected)\n"; exit 0' INT TERM

while :; do
  [ -f "$ORCH/loop.log" ] && emit_new "$ORCH/loop.log" "ORCH"
  # Newest iteration first is wrong here — chronological order is what makes the
  # two seats' turns readable as a conversation.
  for f in $(ls -1 "$LOGS"/iter-*-build.log 2>/dev/null | sort); do
    emit_new "$f" "BUILD"
  done
  for f in $(ls -1 "$LOGS"/iter-*-review.log 2>/dev/null | sort); do
    emit_new "$f" "REVIEW"
  done
  sleep 2
done
