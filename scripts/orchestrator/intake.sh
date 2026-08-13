#!/usr/bin/env bash
#
# intake.sh — header whatever the owner just pasted, so he never has to format.
#
# Owner, 2026-08-13: *"i am also updating owner_reports.md"* — and the detection rule I
# had written would have mishandled it. "Any unmarked text is a report" has two false
# positives in this very file: the format TEMPLATE (which contains the word UNPROCESSED)
# and R-2's pasted transcript, which continues for a hundred lines past its own header.
# A rule that matches non-reports forever is a rule that hides the real one.
#
# So detection is by CHANGE, not by shape: the byte length of the file at the moment it
# was last processed is recorded, and anything appended beyond that is new. The owner
# pastes; this adds `## R-<n> · <date> PKT · UNPROCESSED` above it; D-6 then puts it at
# the front of the queue. Nothing asks him to format anything.
set -uo pipefail
ROOT="/var/www/tmcai"; ORCH="$ROOT/server/docs/orchestrator"
F="$ORCH/owner_reports.md"; MARK="$ORCH/state/reports-bytes"
[ -f "$F" ] || exit 0
mkdir -p "$ORCH/state"

python3 - "$F" "$MARK" <<'PY'
import os, re, sys, datetime
f, mark = sys.argv[1], sys.argv[2]
body = open(f, errors="replace").read()
known = 0
if os.path.exists(mark):
    try:
        known = int(open(mark).read().strip() or 0)
    except ValueError:
        known = 0
if known and len(body) <= known:
    print("no new content"); raise SystemExit(0)
if not known:
    # First run: adopt the current file as the baseline rather than headering
    # everything already in it. R-1 and R-2 are processed and their transcripts are
    # not new reports.
    open(mark, "w").write(str(len(body)))
    print(f"baseline adopted at {len(body)} bytes")
    raise SystemExit(0)

new = body[known:].strip()
if len(new) < 40:
    open(mark, "w").write(str(len(body)))
    print("appended text too short to be a report — baseline advanced")
    raise SystemExit(0)
if re.match(r"^##\s+R-\d+", new):
    open(mark, "w").write(str(len(body)))
    print("already headered by the owner — left as is")
    raise SystemExit(0)

nums = [int(n) for n in re.findall(r"^##\s+R-(\d+)", body, re.M)]
nxt = (max(nums) + 1) if nums else 1
pkt = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=5)
hdr = (f"## R-{nxt} · {pkt:%Y-%m-%d %H:%M} PKT · UNPROCESSED\n"
       f"*(Header added by the orchestrator; the owner's report below is verbatim.)*\n\n")
open(f, "w").write(body[:known].rstrip("\n") + "\n\n" + hdr + new + "\n")
open(mark, "w").write(str(os.path.getsize(f)))
print(f"R-{nxt} headered — {len(new)} chars, now UNPROCESSED at the front of the queue")
PY
