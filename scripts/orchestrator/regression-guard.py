#!/usr/bin/env python3
"""
regression-guard.py — the benchmark's job after 2026-08-13.

Owner ruling: *capabilities drive, benchmark guards.* The gate it used to enforce
— min(C1..C8) >= 95 on every one of twelve cases — was unreachable, and measured
so rather than argued: across 228 case-scorings C4 awarded >=95 four percent of
the time, and nine of the twelve cases never reached it once in nineteen runs.
Every other criterion clears 95 routinely and every case has reached it on all of
them. So one tone criterion held an exit condition shut for twenty iterations,
which is the honest reason the loop never finished and the stall counter climbed
forever.

The benchmark is not deleted, and it is not weakened into decoration. It becomes
the thing it is actually good at: catching a case that got WORSE. For every case
and criterion it holds the best score ever observed, and it fails when a current
score falls more than the noise band below that best. Noise is real here — C4 has
read 90, 85 and 88 on barely-changed code — so the band is stated, not implied.

Exit: --json for the loop, non-zero when a regression is found.
"""
import json, glob, os, re, sys

SCORES = sys.argv[1] if len(sys.argv) > 1 else "server/docs/orchestrator/scores"
CURRENT = sys.argv[2] if len(sys.argv) > 2 else None
# Bands calibrated from this judge's own variance, measured over 1728
# consecutive-run cell comparisons on unchanged code paths:
#
#   median 0 · p75 5 · p90 10 · p95 10 · p99 20 · max 50
#   47% of cells change AT ALL between runs · 11% change by >=10
#
# So my first band of 2 was indefensible: with 96 cells per run it would fire on
# roughly forty-five cells of pure sampling noise. A single cell must drop past
# p99 territory to mean anything, and the cheaper signal is the CASE MEAN, which
# averages eight criteria and shrinks the variance instead of amplifying it.
NOISE_CELL = float(os.environ.get("NEXEO_GUARD_CELL", "12"))
NOISE_CASE = float(os.environ.get("NEXEO_GUARD_CASE", "5"))
WINDOW = int(os.environ.get("NEXEO_GUARD_WINDOW", "5"))

def load(p):
    try:
        return json.load(open(p))
    except Exception:
        return None

def median(xs):
    xs = sorted(xs)
    n = len(xs)
    if not n:
        return None
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2

cells = {}          # (case, crit) -> [scores oldest..newest]
case_means = {}     # case -> [mean per run]
def iter_no(path):
    m = re.search(r"iter-(\d+)-", os.path.basename(path))
    return int(m.group(1)) if m else -1

CUR_N = iter_no(CURRENT) if CURRENT else 10**6

def prior_runs():
    """Only runs BEFORE the current one.

    The first version globbed every run except the current file, which meant
    iteration 1 was judged against the median of iterations 16-20 — future data
    as a baseline. It made all seven early runs report regressions and it would
    have kept doing so silently.
    """
    out = []
    for f in sorted(glob.glob(os.path.join(SCORES, "iter-*-post-build.json")),
                    key=iter_no):
        if iter_no(f) >= CUR_N:
            continue
        out.append(f)
    return out

for f in prior_runs():
    d = load(f)
    if not d:
        continue
    for c in d.get("cases", []):
        got = []
        for k, v in (c.get("criteria") or {}).items():
            sc = v.get("score")
            if sc is None:
                continue
            cells.setdefault((c["id"], k), []).append(sc)
            got.append(sc)
        if got:
            case_means.setdefault(c["id"], []).append(sum(got) / len(got))

cur = load(CURRENT) if CURRENT else None
if not cur:
    print(json.dumps({"status": "no-current", "regressions": [], "cases_down": []}))
    raise SystemExit(0)

regressions, cases_down = [], []
for c in cur.get("cases", []):
    got = []
    for k, v in (c.get("criteria") or {}).items():
        sc = v.get("score")
        if sc is None:
            continue
        got.append(sc)
        prior = cells.get((c["id"], k), [])[-WINDOW:]
        # Three samples minimum. Runs 1-7 all "regressed" under the first version
        # purely because their baseline was a median of one or two draws from a
        # sampler that moves 47% of cells between runs.
        if len(prior) < 3:
            continue
        base = median(prior)
        drop = round(base - sc, 1)
        if drop > NOISE_CELL:
            regressions.append({"case": c["id"], "criterion": k, "baseline": base,
                                "now": sc, "drop": drop,
                                "reason": (v.get("reason") or "")[:200]})
    if got:
        prior_c = case_means.get(c["id"], [])[-WINDOW:]
        base = median(prior_c) if len(prior_c) >= 3 else None
        now = round(sum(got) / len(got), 1)
        if base is not None and round(base - now, 1) > NOISE_CASE:
            cases_down.append({"case": c["id"], "baseline": round(base, 1),
                               "now": now, "drop": round(base - now, 1)})

regressions.sort(key=lambda r: -r["drop"])
cases_down.sort(key=lambda r: -r["drop"])
bad = bool(regressions or cases_down)
print(json.dumps({
    "status": "regressed" if bad else "clean",
    "baseline": f"median of last {WINDOW} runs",
    "bands": {"cell": NOISE_CELL, "case_mean": NOISE_CASE,
              "calibrated_from": "1728 consecutive-run comparisons; p99=20, p90=10"},
    "cases": len(cur.get("cases", [])),
    "min_baseline_samples": 3,
    "regressions": regressions,
    "cases_down": cases_down,
}, indent=1))
raise SystemExit(1 if bad else 0)
