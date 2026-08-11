#!/usr/bin/env bash
#
# resolve-session.sh — find a Claude Code session id BY DISPLAY NAME.
#
# Owner, 2026-08-11: *"read id of Claude Session title 'Builder' and always use
# that session"* — after *"i am unable to see it running in session"*.
#
# WHAT WENT WRONG WITHOUT THIS. The loop generated a random uuid for its build
# session, so the session showed up in the session list under an auto-derived
# name (`tmcai-dd`). The owner looked for "Builder", found nothing, and concluded
# the loop was not running — while it was mid-build-turn. The session was visible
# the whole time; it just had no name a human had chosen.
#
# WHY BY NAME AND NOT A PASTED UUID. A session id changes whenever the session is
# recreated. A uuid baked into the loop would silently point at a dead transcript,
# the loop would open a FRESH session every iteration, and the "in-session"
# property the owner asked for would be gone with no error anywhere. The name is
# the stable handle; the id is looked up each time.
#
# INTERFACE. `claude agents --json` is the supported, documented way to enumerate
# sessions for scripting ("does not require a TTY"). It returns
#   [{"pid":…, "cwd":…, "kind":"interactive", "sessionId":"…", "name":"tmcai-92"}]
# The internal registry (/root/.claude/sessions/<pid>.json) is used only as a
# fallback, because it carries `nameSource` — which tells us whether a name was
# CHOSEN ("user", e.g. via `claude --name Builder`) or auto-derived.
#
# Usage:
#   resolve-session.sh Builder                 # print the session id, or exit 3
#   resolve-session.sh Builder --cwd /var/www/tmcai
#   resolve-session.sh --list
#
# Exit: 0 found (id on stdout) · 3 no such session · 4 ambiguous (>1 match)
set -uo pipefail

CLAUDE_BIN="${CLAUDE_BIN:-/root/.local/bin/claude}"
REG="${CLAUDE_SESSION_REGISTRY:-/root/.claude/sessions}"

# `claude agents --json` is authoritative; the registry adds nameSource. Merged
# on sessionId so a name is never reported without knowing where it came from.
sessions_json() {
  local cwd_filter="${1:-}"
  local args=(agents --json)
  [ -n "$cwd_filter" ] && args+=(--cwd "$cwd_filter")
  timeout 60 "$CLAUDE_BIN" "${args[@]}" 2>/dev/null
}

registry_json() {
  python3 - "$REG" <<'PY'
import glob, json, os, sys
out = {}
for f in glob.glob(os.path.join(sys.argv[1], "*.json")):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    sid = d.get("sessionId")
    if sid:
        out[sid] = d.get("nameSource", "?")
print(json.dumps(out))
PY
}

merged() {
  local cwd_filter="${1:-}"
  SESSIONS="$(sessions_json "$cwd_filter")" REGISTRY="$(registry_json)" python3 <<'PY'
import json, os, sys
try:
    sessions = json.loads(os.environ.get("SESSIONS") or "[]")
except Exception:
    sessions = []
try:
    reg = json.loads(os.environ.get("REGISTRY") or "{}")
except Exception:
    reg = {}
if not isinstance(sessions, list):
    sessions = []
for s in sessions:
    sid = s.get("sessionId", "?")
    print("\t".join([
        str(s.get("name", "?")), sid, str(s.get("cwd", "?")),
        str(s.get("kind", "?")), str(reg.get(sid, "?")),
    ]))
PY
}

if [ "${1:-}" = "--list" ]; then
  printf '%-16s %-38s %-20s %-12s %s\n' NAME SESSION_ID CWD KIND NAME_SOURCE
  merged "${2:-}" | while IFS=$'\t' read -r n s c k ns; do
    printf '%-16s %-38s %-20s %-12s %s\n' "$n" "$s" "$c" "$k" "$ns"
  done
  exit 0
fi

WANT="${1:?usage: resolve-session.sh <session-name> [--cwd <path>]}"
CWD_FILTER=""
[ "${2:-}" = "--cwd" ] && CWD_FILTER="${3:-}"

# Exact, case-insensitive. Substring matching is deliberately NOT used: "Builder"
# must never resolve to "Builder-old" or "rebuilder".
matches="$(merged "$CWD_FILTER" | WANT="$WANT" python3 -c '
import os, sys
want = os.environ["WANT"].strip().lower()
for line in sys.stdin:
    parts = line.rstrip("\n").split("\t")
    if len(parts) >= 2 and parts[0].strip().lower() == want:
        print(parts[1])
' | sort -u)"

count="$(printf '%s' "$matches" | grep -c . || true)"
if [ "$count" -eq 0 ]; then
  printf 'resolve-session: no live session named "%s"\n' "$WANT" >&2
  printf 'To create one:  claude --name %s   (then it is findable across restarts)\n' "$WANT" >&2
  printf 'Live sessions:\n' >&2
  "$0" --list >&2
  exit 3
fi
if [ "$count" -gt 1 ]; then
  # Never guess between two sessions wearing one name — the loop would write its
  # build turns into whichever happened to sort first.
  printf 'resolve-session: %s live sessions named "%s" — refusing to guess:\n%s\n' \
    "$count" "$WANT" "$matches" >&2
  exit 4
fi
printf '%s' "$matches"
