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

    # The owner supplied this layout twice, verbatim. It is reproduced to the
    # column — including the exact `Overall:` sentence — because a report he has
    # to re-read differently each time is a report he stops reading. The gap and
    # the verdict AGENTS.md requires go on their own line BELOW his line, rather
    # than being wedged into it.
    out = []
    head = f"Brain Capability: {label}"
    if iteration is not None:
        head = f"Iteration {iteration} — {head}"
    out.append(head)
    out.append(
        "Capability               Nexeo Today                    "
        "Professional Assistant       Δ"
    )
    for c in caps:
        d_ = c.get("delta", 0)
        # A delta is always signed or an explicit 0 — never blank. A blank cell
        # reads as "not measured", which is a different claim from "did not move".
        dtxt = f"+{d_}" if d_ > 0 else (str(d_) if d_ < 0 else "0")
        out.append(
            f"{c['name']:<26}{c['nexeo']:>2}  {bar(c['nexeo'])}"
            f"      {c['professional']:>2}  {bar(c['professional'])}{dtxt:>6}"
        )
    verdict = ("PROGRESSIVE" if movement > 0
               else "REGRESSION" if movement < 0 else "NEUTRAL")
    out.append(
        f"Overall: Nexeo {n_overall} vs professional assistant {p_overall}"
        f" · movement {'+' if movement > 0 else ''}{movement}"
    )
    out.append(f"Gap to professional: {round(p_overall - n_overall, 1)} · {verdict}")

    # RELIABILITY, reported alongside capability because they are different things
    # and the card could only ever see one of them.
    #
    # Owner, 2026-08-12: "bug fixing is also a progress and definitely cause the
    # improvement in brain", then "so its mean brain scoring is not catering it".
    # Both correct. The nine capabilities measure BREADTH against a professional
    # assistant; what this loop actually produces is a fabrication removed, a guard
    # that stops destroying answers, two competing resolvers collapsed into one.
    # That is reliability of an existing capability, and on a 94-point breadth scale
    # it can only ever show up as +1s — so the work looked like nothing.
    #
    # It is deliberately NOT folded into the nine scores. The capability order and
    # meaning are the owner's (BRAIN_VISION.md / AGENTS.md); inventing a tenth
    # capability or inflating the others to reflect defect work would make the
    # comparison with a professional assistant meaningless. Two axes, both honest.
    try:
        import subprocess
        g = subprocess.run(
            ["git", "-C", "/var/www/tmcai", "log", "--oneline", "--grep=^DEF-1[3-9]",
             "-E", "8806ce1..HEAD"],
            capture_output=True, text=True, timeout=20).stdout
        defs = sorted({ln.split(":")[0].split()[1] for ln in g.splitlines()
                       if len(ln.split()) > 1 and ln.split()[1].startswith("DEF-")})
        if defs:
            out.append("")
            out.append(f"Reliability (this loop): {len(defs)} defects shipped — "
                       + ", ".join(defs))
            out.append("  NOT DEPLOYED — every fix above is in the branch only, so "
                       "live behaviour is unchanged")
    except Exception:
        pass
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
        # A FULL SNAPSHOT, not just the movement. Without it an earlier
        # iteration's card can only be reconstructed by replaying deltas
        # backwards from the current state — and a card rebuilt by arithmetic is
        # not a record of what was reported at the time, it is a guess that will
        # quietly disagree with what the owner was shown.
        "snapshot": [{"name": c["name"], "nexeo": c["nexeo"],
                      "professional": c["professional"], "delta": c.get("delta", 0)}
                     for c in d["capabilities"]],
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
    ap.add_argument("--append", action="store_true",
                    help="also append the rendered card to capability_history.md")
    ap.add_argument("--history", action="store_true",
                    help="render EVERY iteration's card, oldest first, from its snapshot")
    a = ap.parse_args()

    d = load()

    if a.history:
        # Rendered from each iteration's stored snapshot, never by replaying
        # deltas backwards from today — a card rebuilt by arithmetic is a guess,
        # and it would quietly disagree with what was reported at the time.
        for h in d.get("history", []):
            snap = h.get("snapshot")
            if not snap:
                print(f"Iteration {h['iteration']}: no snapshot stored "
                      f"(recorded before snapshots existed)\n")
                continue
            print(render({"capabilities": snap}, h["iteration"], "Post-Build"))
            v = h.get("verdict")
            if v:
                print(f"Verdict: {v}")
            # Evidence is a list now, but the first entry was written as a bare
            # string — iterating that yields one character per line.
            ev = h.get("evidence") or []
            for e in ([ev] if isinstance(ev, str) else ev):
                print(f"  · {e}")
            print()
        return
    if a.sets:
        d = apply_sets(d, a.sets, a.iteration or d.get("as_of_iteration"), a.head, a.verdict)
        if a.commit:
            save(d)
        else:
            sys.stderr.write("(dry run — pass --commit to persist)\n")
    card = render(d, a.iteration or d.get("as_of_iteration"), a.label)
    print(card)

    if a.append:
        # One card per iteration, kept in order. The owner asked to WATCH progress
        # across iterations, and a single overwritten "current" card cannot show a
        # trend — it can only ever agree with itself.
        hist = os.path.join(os.path.dirname(STATE), "..", "capability_history.md")
        hist = os.path.normpath(hist)
        new = not os.path.exists(hist)
        with open(hist, "a") as f:
            if new:
                f.write(
                    "# Capability history — one scorecard per iteration\n\n"
                    "Appended by `scripts/orchestrator/scorecard.py --append` at the end of\n"
                    "each iteration, after Codex's review. Never rewritten: an earlier card\n"
                    "that turned out to be optimistic is evidence, not an error to tidy away.\n"
                )
            evidence = (d.get("history") or [{}])[-1].get("evidence")
            f.write(f"\n## Iteration {a.iteration or d.get('as_of_iteration')}\n\n")
            f.write("```\n" + card + "\n```\n")
            if evidence:
                f.write("\n**What moved, and on what evidence:**\n\n")
                for e in (evidence if isinstance(evidence, list) else [evidence]):
                    f.write(f"- {e}\n")
        sys.stderr.write(f"(appended to {hist})\n")


if __name__ == "__main__":
    main()
