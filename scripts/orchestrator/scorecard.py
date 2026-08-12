#!/usr/bin/env python3
"""
scorecard.py — render (and update) the Nexeo capability scorecard.

Owner, 2026-08-12: *"after every codex review i want you to give me status like
following with Iteration#"*, in the exact shape AGENTS.md requires of every audit:
the nine BRAIN_VISION.md capabilities, Nexeo against a professional living
assistant, the gap, the movement since the last verified build, and paired
20-character bars.

WHY THIS IS A SCRIPT AND NOT PROSE. The scores are judgements — AGENTS.md is
explicit that they are capability judgements, not test-pass percentages, and that
green tests alone never raise one. What must NOT be re-judged each time is the
arithmetic, the bar widths, the capability ORDER, or the previous state: those are
where a hand-written report quietly drifts, and a scorecard that drifts is worse
than none because it manufactures the appearance of progress. So the judgement
stays human and the bookkeeping is mechanical.

The order is BRAIN_VISION.md's and is never sorted — AGENTS.md's required audit
sequence, step 1: *"preserve its exact capability order"*.

Usage:
  scorecard.py --render --iteration 2 --label "Post-Build"
  scorecard.py --set "Authorized Action=+3:DEF-132 writers fixed, live-verified" \\
               --set "Thinking=+1:reasoning path now shares finalisation" \\
               --iteration 2 --head abc1234 --verdict PROGRESSIVE --commit
"""
import argparse
import json
import os
import sys

STATE = os.environ.get(
    "NEXEO_SCORECARD",
    "/var/www/tmcai/server/docs/orchestrator/state/capability_scorecard.json",
)
WIDTH = 20  # bar cells; one cell = 5 points


def bar(score):
    filled = int(round(score / 100 * WIDTH))
    filled = max(0, min(WIDTH, filled))
    return "█" * filled + "░" * (WIDTH - filled)


def mean(vals):
    return round(sum(vals) / len(vals), 1) if vals else 0.0


def load():
    with open(STATE) as f:
        return json.load(f)


def save(d):
    with open(STATE, "w") as f:
        json.dump(d, f, indent=2)
        f.write("\n")


def render(d, iteration, label):
    caps = d["capabilities"]
    n_overall = mean([c["nexeo"] for c in caps])
    p_overall = mean([c["professional"] for c in caps])
    movement = round(sum(c.get("delta", 0) for c in caps) / len(caps), 1)

    name_w = max(len(c["name"]) for c in caps)
    out = []
    head = f"Brain Capability: {label}"
    if iteration is not None:
        head = f"Iteration {iteration} — {head}"
    out.append(head)
    out.append(
        f"{'Capability'.ljust(name_w)}   {'Nexeo Today'.ljust(WIDTH + 5)}"
        f"  {'Professional Assistant'.ljust(WIDTH + 5)}  Δ"
    )
    for c in caps:
        d_ = c.get("delta", 0)
        # A delta is always signed or an explicit 0 — never blank. A blank cell
        # reads as "not measured", which is a different claim from "did not move".
        dtxt = f"+{d_}" if d_ > 0 else (str(d_) if d_ < 0 else "0")
        out.append(
            f"{c['name'].ljust(name_w)}  {c['nexeo']:>3}  {bar(c['nexeo'])}"
            f"  {c['professional']:>3}  {bar(c['professional'])}  {dtxt:>4}"
        )
    verdict = ""
    if movement > 0:
        verdict = "PROGRESSIVE"
    elif movement < 0:
        verdict = "REGRESSION"
    else:
        verdict = "NEUTRAL"
    out.append(
        f"Overall: Nexeo {n_overall} vs professional assistant {p_overall}"
        f" · gap {round(p_overall - n_overall, 1)} · movement "
        f"{'+' if movement > 0 else ''}{movement} {verdict}"
    )
    return "\n".join(out)


def apply_sets(d, sets, iteration, head, verdict):
    caps = {c["name"].lower(): c for c in d["capabilities"]}
    # Deltas are RESET first: a delta means "moved this iteration". Carrying last
    # iteration's delta forward would report the same gain twice, which is how a
    # scorecard invents progress that never happened.
    for c in d["capabilities"]:
        c["delta"] = 0
    notes = []
    for s in sets or []:
        if "=" not in s:
            sys.exit(f"--set needs NAME=+N:evidence — got {s!r}")
        name, rest = s.split("=", 1)
        if ":" not in rest:
            sys.exit(f"--set {name!r} has no evidence after ':' — evidence is required")
        change, evidence = rest.split(":", 1)
        key = name.strip().lower()
        if key not in caps:
            sys.exit(f"unknown capability {name!r}; valid: "
                     f"{[c['name'] for c in d['capabilities']]}")
        delta = int(change)
        cap = caps[key]
        cap["nexeo"] = max(0, min(100, cap["nexeo"] + delta))
        cap["delta"] = delta
        notes.append(f"{cap['name']} {delta:+d}: {evidence.strip()}")

    d["as_of_iteration"] = iteration
    if head:
        d["as_of_head"] = head
    overall = mean([c["nexeo"] for c in d["capabilities"]])
    movement = round(sum(c["delta"] for c in d["capabilities"]) / len(d["capabilities"]), 1)
    d.setdefault("history", []).append({
        "iteration": iteration,
        "head": head or d.get("as_of_head"),
        "overall": overall,
        "movement": movement,
        "verdict": verdict or ("PROGRESSIVE" if movement > 0
                               else "REGRESSION" if movement < 0 else "NEUTRAL"),
        "evidence": notes or ["no capability moved this iteration"],
    })
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--render", action="store_true")
    ap.add_argument("--iteration", type=int)
    ap.add_argument("--label", default="Post-Build")
    ap.add_argument("--set", action="append", dest="sets",
                    help="NAME=+N:evidence (evidence is mandatory)")
    ap.add_argument("--head")
    ap.add_argument("--verdict")
    ap.add_argument("--commit", action="store_true",
                    help="persist the --set changes; without it nothing is written")
    a = ap.parse_args()

    d = load()
    if a.sets:
        d = apply_sets(d, a.sets, a.iteration or d.get("as_of_iteration"), a.head, a.verdict)
        if a.commit:
            save(d)
        else:
            sys.stderr.write("(dry run — pass --commit to persist)\n")
    print(render(d, a.iteration or d.get("as_of_iteration"), a.label))


if __name__ == "__main__":
    main()
