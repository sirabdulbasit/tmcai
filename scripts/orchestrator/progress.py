#!/usr/bin/env python3
"""
progress.py — is Brain actually getting better?

Owner, 2026-08-12: *"how can i keep watching improvment on brain as i am
expecting?"*

`watch.sh` answers a different question — what are the agents DOING right now.
This answers whether any of it is working, on one screen:

  · distance to the gate (the MINIMUM criterion, which is what gates — never the mean)
  · every criterion's trajectory across iterations, so a rise is visible as a trend
    rather than as one hopeful number
  · the capability scorecard (AGENTS.md's nine, Nexeo vs a professional assistant)
  · what the judge is still complaining about, in its own words
  · each iteration's Codex verdict, because a score that moved on a WEAK review is
    not progress that has been confirmed

Reads only files the loop already writes. Never runs the benchmark, so it is safe
to leave refreshing:

    watch -c -n 30 scripts/orchestrator/progress.py
"""
import glob
import json
import os
import re
import sys

ORCH = os.environ.get("NEXEO_ORCH", "/var/www/tmcai/server/docs/orchestrator")
SCORES = os.path.join(ORCH, "scores")
TARGET_DEFAULT = 95
CRIT_NAMES = {
    "C1": "Truthfulness", "C2": "Grounding", "C3": "Continuity",
    "C4": "Human voice", "C5": "Proportionate action", "C6": "Completeness",
    "C7": "Consequence honesty", "C8": "Identity/boundary",
}


def load_scores():
    """Every measurement, in the order it was taken. The filename carries the
    iteration and the label (baseline / post-build), and both matter: a baseline
    and a post-build at the same iteration are two different facts."""
    out = []
    for p in sorted(glob.glob(os.path.join(SCORES, "iter-*.json"))):
        m = re.search(r"iter-(\d+)-(.+)\.json$", os.path.basename(p))
        if not m:
            continue
        try:
            with open(p) as f:
                d = json.load(f)
        except Exception:
            continue
        out.append({
            "iter": int(m.group(1)), "label": m.group(2), "path": p,
            "overall": d.get("overall"), "crit": d.get("criteriaAvg", {}) or {},
            "weakest": d.get("weakestCriterion"),
            "weakest_score": d.get("weakestCriterionScore"),
            "gate": d.get("gatePassed"), "target": d.get("target", TARGET_DEFAULT),
            "mutated": d.get("mutated"), "fixq": d.get("fixQueue", []) or [],
            "scored": d.get("casesScored"), "failed": d.get("casesFailed"),
            "mtime": os.path.getmtime(p),
        })
    out.sort(key=lambda r: r["mtime"])
    return out


def verdicts():
    """Codex's verdict per iteration. A rising score with a WEAK review means the
    gain is unconfirmed, which is exactly the distinction this loop exists to keep."""
    p = os.path.join(ORCH, "review_log.md")
    if not os.path.exists(p):
        return {}
    txt = open(p, errors="replace").read()
    out = {}
    for m in re.finditer(r"^##\s+Iteration\s+(\d+)(.*?)(?=^##\s+Iteration|\Z)",
                         txt, re.S | re.M):
        body = m.group(2)
        v = re.search(r"\*\*(SOUND|WEAK|WRONG)\*\*", body) or \
            re.search(r"\b(SOUND|WEAK|WRONG)\b", body)
        out[int(m.group(1))] = v.group(1) if v else "?"
    return out


def spark(vals):
    """One cell per measurement. Trend beats a single number: three flat runs and
    one jump look identical if you only print the latest."""
    blocks = "▁▂▃▄▅▆▇█"
    real = [v for v in vals if v is not None]
    if not real:
        return ""
    lo, hi = min(real), max(real)
    span = (hi - lo) or 1
    return "".join(" " if v is None else blocks[min(7, int((v - lo) / span * 7))]
                   for v in vals)


# The capability scorecard is rendered by scorecard.py and NOT re-implemented
# here. It was, briefly — with 18-cell bars against scorecard.py's 20 — so the
# same capability drew differently depending on which view you happened to read.
# That is `protection-with-two-implementations`, the shape with seven recorded
# occurrences in this project's own chart, reproduced in the tooling built to
# measure it. One renderer, one owner.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from scorecard import render as render_scorecard, load as load_scorecard
except Exception:  # pragma: no cover - the view still works without it
    render_scorecard = load_scorecard = None


def main():
    runs = load_scores()
    if not runs:
        print(f"no measurements yet under {SCORES}")
        return 1
    vd = verdicts()
    latest = runs[-1]
    target = latest["target"] or TARGET_DEFAULT
    keys = sorted(set().union(*[set(r["crit"]) for r in runs]) or set())

    print("═" * 78)
    print(f"NEXEO PROGRESS · target {target} on EVERY criterion "
          f"· {len(runs)} measurement(s)")
    print("═" * 78)

    # ── the gate, stated as a distance, not a vibe ────────────────────────────
    w, ws = latest["weakest"], latest["weakest_score"]
    gap = None if ws is None else round(target - ws, 1)
    print(f"\nLatest: iteration {latest['iter']} ({latest['label']})  "
          f"overall {latest['overall']}  "
          f"gate {'PASSED' if latest['gate'] else 'not passed'}")
    if ws is not None:
        print(f"Gating criterion: {w} ({CRIT_NAMES.get(w, '?')}) at {ws} "
              f"— {gap} points from the gate")
    if latest["failed"]:
        # A suite where cases errored has not measured Brain, and must never be
        # read as a score.
        print(f"⚠ {latest['failed']} case(s) FAILED to score — this number is "
              f"incomplete, not low")
    if latest["mutated"]:
        print("⚠ this run WROTE to live data (see mutationEvidence in the report)")

    # ── trajectory ────────────────────────────────────────────────────────────
    print(f"\n{'':22}{'trend':<12} {'first':>6} {'latest':>7} {'Δ':>7}   vs target")
    for k in keys:
        series = [r["crit"].get(k) for r in runs]
        real = [v for v in series if v is not None]
        if not real:
            continue
        first, last = real[0], real[-1]
        d = round(last - first, 1)
        flag = "✓" if last >= target else f"{round(target - last, 1):>4} short"
        star = " ←gating" if k == w else ""
        print(f"{k} {CRIT_NAMES.get(k, ''):<19}{spark(series):<12} "
              f"{first:>6} {last:>7} {d:>+7}   {flag}{star}")

    overalls = [r["overall"] for r in runs]
    print(f"\n{'OVERALL':<22}{spark(overalls):<12} "
          f"{overalls[0]:>6} {overalls[-1]:>7} "
          f"{round((overalls[-1] or 0) - (overalls[0] or 0), 1):>+7}")

    # ── per-iteration, with the reviewer's verdict beside the number ──────────
    print("\nIteration history (verdict is Codex's, not the score's):")
    for r in runs:
        v = vd.get(r["iter"], "—")
        print(f"  iter {r['iter']:>2} {r['label']:<12} overall {str(r['overall']):>5} "
              f"· min {str(r['weakest_score']):>5} ({r['weakest']}) "
              f"· codex {v}")

    # ── what the judge still objects to, in its words ─────────────────────────
    print("\nStill failing — the judge's own sentences (worst first):")
    seen = set()
    for f in sorted(latest["fixq"], key=lambda x: x.get("score", 100))[:5]:
        key = (f.get("caseId"), f.get("criterion"))
        if key in seen:
            continue
        seen.add(key)
        print(f"  {f.get('criterion')} @ {f.get('score')}  {f.get('caseId')}")
        print(f"      {str(f.get('reason', ''))[:150]}")

    # ── capability scorecard, from its single renderer ─────────────────────────
    if render_scorecard and load_scorecard:
        try:
            d = load_scorecard()
            print()
            print(render_scorecard(d, d.get("as_of_iteration"), "Post-Build"))
            print("(capability scores are evidence judgements, not test results — "
                  "a green build alone never moves one)")
        except Exception as e:
            print(f"\n(scorecard unavailable: {e})")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
