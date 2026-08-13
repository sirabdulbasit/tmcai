#!/usr/bin/env bash
#
# campaign-advance.sh — enforce the campaign lifecycle.
#
# The campaign file has said since it was written that "a campaign ends when its
# exit condition is met or its budget is spent — whichever first — and the
# orchestrator records which. Never silently extended." I wrote that rule and did
# not implement it, so at iteration 15 C-1 was running as "budgeted iteration 4 of
# 3" with C-2 due to start and nothing to start it. A rule with no enforcement is a
# comment.
#
# This runs at the END of an iteration and does exactly one thing: decide whether
# the active campaign continues, and if not, roll the next one in and write the
# outcome to `history`. It NEVER extends a budget on its own — an extension is a
# judgement with a reason, and it belongs to a human or to the orchestrator acting
# explicitly, recorded in `extended[]`.
#
# Usage: campaign-advance.sh <iteration-just-finished>
# Exit:  0 continues · 10 rolled over · 11 budget spent, needs a decision
set -uo pipefail
ROOT="/var/www/tmcai"; ORCH="$ROOT/server/docs/orchestrator"
F="$ORCH/state/campaign.json"; ITER="${1:?usage: campaign-advance.sh <iteration>}"
[ -f "$F" ] || { echo "no campaign file"; exit 0; }

python3 - "$F" "$ITER" "$ORCH" <<'PY'
import json, sys, datetime
f, it, orch = sys.argv[1], int(sys.argv[2]), sys.argv[3]
d = json.load(open(f)); a = d.get("active") or {}
if not a:
    print("no active campaign"); raise SystemExit(0)
start  = a.get("from_iteration", it)
budget = a.get("budget_iterations", 1)
spent  = it - start + 1
left   = budget - spent

def close(outcome, detail):
    a["closed"] = {"at": datetime.datetime.utcnow().isoformat() + "Z",
                   "last_iteration": it, "iterations_spent": spent,
                   "outcome": outcome, "detail": detail}
    d.setdefault("history", []).append(a)
    q = d.get("queued") or []
    if q:
        nxt = q.pop(0)
        nxt["from_iteration"] = it + 1
        d["active"] = nxt
        d["queued"] = q
        print(f"ROLLED OVER → {nxt['id']} {nxt['name']} from iteration {it+1} "
              f"({outcome})")
        rc = 10
    else:
        d["active"] = {}
        print(f"campaign {a.get('id')} closed ({outcome}); NO queued campaign — "
              f"the loop will run unaimed until one is defined")
        rc = 10
    json.dump(d, open(f, "w"), indent=2); open(f, "a").write("\n")
    raise SystemExit(rc)

# Exit condition is a JUDGEMENT, not a regex: it is recorded by whoever assessed it
# in `exit_condition_status`. If every half says MET, the campaign is done early —
# which is the good outcome and must not require the budget to run out.
st = a.get("exit_condition_status") or {}
if st and all(str(v).upper().startswith("MET") for v in st.values()):
    close("exit condition met", st)

if left > 0:
    print(f"{a.get('id')} continues — iteration {spent} of {budget}, {left} left")
    raise SystemExit(0)

# Budget spent, exit condition not met. This script does NOT extend: it reports and
# leaves the decision visible, because an extension without a reason is the drift
# this file exists to stop.
print(f"BUDGET SPENT — {a.get('id')} used {spent} of {budget} iterations and its "
      f"exit condition is not met: {st or 'unassessed'}. Extend it deliberately "
      f"(record why in extended[]) or close it and roll to the next.")
raise SystemExit(11)
PY
