#!/usr/bin/env bash
#
# loop-watchdog.sh — keeps nexeo-loop.sh alive without a human watching.
#
# Owner, 2026-08-17, leaving the desk: "i want you to keep running loop, and you
# monitor it and don't let any iteration get into stuck or move in circle."
#
# WHY THIS EXISTS RATHER THAN ME WATCHING. The loop wrote "STOP file present — ending
# cleanly" at 15:47:31 and exited, and nothing noticed for an hour and a half. The
# owner asked twice why iteration 2 was still running while it had in fact been dead;
# both times the check happened because he prompted it. A monitor that depends on
# someone asking is not a monitor. This is the same failure SD-001 §7 names as the most
# consequential in this system's history — a build reported as running after the
# process had died.
#
# WHAT IT DOES, once a minute:
#   1. Is a real nexeo-loop.sh process alive? Matched on an argv ELEMENT, never a
#      substring of the whole command line — a grep for the script name matches the
#      grep itself, which has produced three false "it's running" readings today.
#   2. If not: clear a STOP file if present and start the loop again. STOP is for a
#      human stopping the loop, not for the loop to retire itself; the owner has ruled
#      that it must never be stopped.
#   3. Never start a second loop. Two builders in one tree is the attribution mess this
#      project has already recorded.
#
# WHAT IT DELIBERATELY DOES NOT DO. It does not judge whether the work is any good, and
# it does not touch the iteration counter or the hold. Circling is handled inside the
# loop — the target rotates down Codex's ranked list of the owner's own reported
# failures every three failed attempts — because that decision needs the chat analysis,
# which a watchdog has no business reading.
#
# Stop it with: touch /var/www/tmcai/server/docs/orchestrator/state/WATCHDOG_OFF
set -uo pipefail

ROOT="/var/www/tmcai"
ORCH="$ROOT/server/docs/orchestrator"
STATE="$ORCH/state"
LOG="$ORCH/watchdog.log"
OFF="$STATE/WATCHDOG_OFF"

say() { printf '%s  WATCHDOG %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$*" >> "$LOG"; }

loop_alive() {
  python3 - <<'PY'
import os, sys
for pid in os.listdir('/proc'):
    if not pid.isdigit():
        continue
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as fh:
            argv = [a.decode('utf-8', 'replace') for a in fh.read().split(b'\0') if a]
        ppid = [l.split()[1] for l in open(f'/proc/{pid}/status') if l.startswith('PPid')][0]
    except Exception:
        continue
    # An argv ELEMENT that IS the script — not a substring of some other command that
    # merely mentions it. Subshells inherit the parent's argv, so a child whose parent
    # is also a match is not a second loop.
    if any(a.endswith('nexeo-loop.sh') for a in argv):
        try:
            pargv = open(f'/proc/{ppid}/cmdline', 'rb').read().split(b'\0')
            if any(a.decode('utf-8', 'replace').endswith('nexeo-loop.sh') for a in pargv if a):
                continue
        except Exception:
            pass
        sys.exit(0)
sys.exit(1)
PY
}

say "watchdog started (pid $$)"
while true; do
  if [ -f "$OFF" ]; then
    say "WATCHDOG_OFF present — exiting; nothing will restart the loop from here"
    exit 0
  fi
  if loop_alive; then
    :
  else
    if [ -f "$ORCH/STOP" ]; then
      rm -f "$ORCH/STOP"
      say "STOP file cleared — the loop must not retire itself (owner ruling 2026-08-17)"
    fi
    ( setsid nohup env NEXEO_DEPLOY=1 bash "$ROOT/scripts/orchestrator/nexeo-loop.sh" \
        >> "$ORCH/loop.out" 2>&1 & )
    sleep 10
    if loop_alive; then
      say "loop was DOWN — restarted"
    else
      say "loop was DOWN — restart FAILED, will retry next tick"
    fi
  fi
  sleep 60
done
