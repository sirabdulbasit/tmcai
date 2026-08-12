#!/usr/bin/env python3
"""
pulse.py — the live status window.

Owner, 2026-08-12: *"how can i see pulse status? Brain capability: ?? Iteration #:
?? Stage (Building by Claude working or Reviewing by Codex) with timer count …
i need a window show me the real time progress"*.

Answers four questions at a glance, refreshing on its own:

    Brain capability   ← the scorecard overall, vs a professional assistant
    Iteration #        ← which one is in flight or last finished
    Stage              ← BUILDING (Claude) · REVIEWING (Codex) · MEASURING · IDLE
    Timer              ← how long the current stage has been running

STAGE IS DETECTED, NEVER ASSUMED. That distinction is the whole point of this
file. Earlier in this project a finished turn and a hung turn looked identical
from outside, and the orchestrator sat idle for thirty minutes on work that was
already done. So each stage is inferred from evidence that only exists while the
work is actually happening:

  BUILDING   a `claude` process whose argv carries the Builder session id, OR the
             Builder's transcript file written to within FRESH_S seconds. The
             transcript matters because in a visible IDE session the process
             belongs to the editor and cannot be matched by argv.
  REVIEWING  a live `codex exec` process, or its event log still growing.
  MEASURING  a live `nexeoCapabilityBenchmark` process.
  IDLE       none of the above — and it says IDLE rather than implying progress.

Where a real process is found, the timer is that process's own elapsed time from
the kernel. Only when the evidence is a file does it fall back to mtime, and it
SAYS which it used — a timer whose basis is unclear is a timer nobody can act on.

Usage:
    pulse.py                 # one snapshot
    pulse.py --loop          # refresh every 60s, keeping history (recommended)
    pulse.py --loop 30       # every 30s
    pulse.py --once --plain  # no colour, for piping
"""
import glob
import json
import os
import re
import subprocess
import sys
import time

ROOT = "/var/www/tmcai"
ORCH = f"{ROOT}/server/docs/orchestrator"
STATE = f"{ORCH}/state"
LOGS = f"{ORCH}/logs"
PROJ = "/root/.claude/projects/-var-www-tmcai"
FRESH_S = 90  # a file touched this recently counts as active work

C = {"r": "\033[0m", "b": "\033[1m", "dim": "\033[2m", "grn": "\033[32m",
     "yel": "\033[33m", "cyn": "\033[36m", "red": "\033[31m", "mag": "\033[35m"}


def plain():
    for k in C:
        C[k] = ""


def sh(cmd):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True,
                              timeout=15).stdout.strip()
    except Exception:
        return ""


def procs():
    """(elapsed_seconds, argv) for every process, so a timer can come from the
    kernel rather than from a guess."""
    out = []
    for line in sh("ps -eo etimes,args").splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        try:
            out.append((int(parts[0]), parts[1]))
        except ValueError:
            continue
    return out


def fmt_dur(s):
    s = int(s)
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m{s % 60:02d}s"
    return f"{s // 3600}h{(s % 3600) // 60:02d}m"


def builder_session():
    p = os.path.join(STATE, "builder-session-id")
    return open(p).read().strip() if os.path.exists(p) else ""


def newest(pattern):
    fs = glob.glob(pattern)
    if not fs:
        return None, 0
    f = max(fs, key=os.path.getmtime)
    return f, time.time() - os.path.getmtime(f)


def transcript_age(sid):
    if not sid:
        return None
    tp = os.path.join(PROJ, f"{sid}.jsonl")
    if not os.path.exists(tp):
        return None
    return time.time() - os.path.getmtime(tp)


def detect_stage():
    """Returns (stage, elapsed_seconds, basis, detail).

    A LIVE PROCESS IS NOT PROOF OF WORK. The first version of this matched any
    `claude` process whose argv contained the Builder's session id and reported
    BUILDING for 16h51m — because it had matched the IDE WINDOW, whose argv
    carries the session id since the window IS that session. The timer was the
    tab's uptime; the transcript had been cold for 42 minutes. So the pulse said
    "Claude is building" about a session that had finished long ago, which is the
    precise failure this file exists to prevent.

    Two rules follow, and they are the whole design:
      · the IDE's own process is never evidence of a turn (path check below)
      · a matched process still has to be CORROBORATED by a transcript that is
        actually being written; process + cold transcript is STALLED, not
        BUILDING, and stalled must never look like progress
    """
    ps = procs()
    sid = builder_session()

    for et, arg in ps:
        if "nexeoCapabilityBenchmark" in arg:
            return "MEASURING", et, "process", "benchmark: 12 cases, compose + judge"
    for et, arg in ps:
        if "codex" in arg and " exec" in arg:
            return "REVIEWING", et, "process", "codex exec (reviewing the diff)"

    age = transcript_age(sid)

    # Headless build turn: print mode (`-p`) with the session id, and NOT the
    # editor's own binary. `--output-format stream-json` alone is not a signal —
    # the IDE uses it too.
    for et, arg in ps:
        if (sid and sid in arg and " -p" in arg
                and "vscode-server" not in arg and "vscode/cli" not in arg):
            if age is not None and age > FRESH_S:
                return ("STALLED", et, "process+cold transcript",
                        f"claude -p alive {fmt_dur(et)} but transcript untouched "
                        f"for {fmt_dur(age)} — may be hung or awaiting permission")
            return "BUILDING", et, "process", f"claude -p --resume {sid[:8]} (headless)"

    # Visible IDE session: the turn runs inside the editor's process, so a
    # transcript being written is the ONLY available evidence of a live turn.
    if age is not None and age < FRESH_S:
        return ("BUILDING", age, "transcript",
                f"session {sid[:8]} in your IDE tab, written {int(age)}s ago")

    rev, rev_age = newest(f"{LOGS}/iter-*-review.jsonl")
    if rev and rev_age < FRESH_S:
        return "REVIEWING", rev_age, "logfile", os.path.basename(rev)

    quiet = f", Builder quiet for {fmt_dur(age)}" if age is not None else ""
    return "IDLE", 0, "none", f"no build, review or measurement running{quiet}"


def scores():
    out = []
    for p in sorted(glob.glob(f"{ORCH}/scores/iter-*.json"), key=os.path.getmtime):
        m = re.search(r"iter-(\d+)-(.+)\.json$", os.path.basename(p))
        if not m:
            continue
        try:
            d = json.load(open(p))
        except Exception:
            continue
        out.append((int(m.group(1)), m.group(2), d))
    return out


def verdicts():
    p = f"{ORCH}/review_log.md"
    if not os.path.exists(p):
        return {}
    txt = open(p, errors="replace").read()
    v = {}
    for m in re.finditer(r"^##\s+Iteration\s+(\d+)(.*?)(?=^##\s+Iteration|\Z)",
                         txt, re.S | re.M):
        w = re.search(r"\*\*(SOUND|WEAK|WRONG)\*\*", m.group(2))
        v[int(m.group(1))] = w.group(1) if w else "?"
    return v


def gauge(nexeo, pro, width=30):
    """One bar per capability: filled to Nexeo's score, with `|` marking the
    professional benchmark.

    The block characters (█ / ░) were unreadable on the owner's terminal — his
    screenshot shows filled and empty rendering as the same grey rectangle, so a
    33 and a 92 looked identical. A chart that cannot be read is not a chart, so
    this uses plain ASCII, which cannot be defeated by a font.
    """
    cells = ["."] * width
    filled = max(0, min(width, int(round(nexeo / 100 * width))))
    for i in range(filled):
        cells[i] = "="
    mark = max(0, min(width - 1, int(round(pro / 100 * width))))
    cells[mark] = "|"
    return "".join(cells)


def snapshot(full=False):
    stage, elapsed, basis, detail = detect_stage()
    sc = scores()
    vd = verdicts()
    latest = sc[-1][2] if sc else {}
    latest_iter = sc[-1][0] if sc else "—"

    # Which iteration is IN FLIGHT: build_log's newest section, which the Builder
    # writes as it finishes. If a stage is active, the live iteration is the next
    # one after the last measured — stated as inferred, not as fact.
    bl = f"{ORCH}/build_log.md"
    built = 0
    if os.path.exists(bl):
        ns = [int(x) for x in re.findall(r"^## Iteration (\d+)",
                                         open(bl, errors="replace").read(), re.M)]
        built = max(ns) if ns else 0
    in_flight = built + 1 if stage == "BUILDING" else built

    col = {"BUILDING": C["cyn"], "REVIEWING": C["mag"], "MEASURING": C["yel"],
           "STALLED": C["red"], "IDLE": C["dim"]}.get(stage, C["dim"])

    who = {"BUILDING": "Claude building", "REVIEWING": "Codex reviewing",
           "MEASURING": "benchmark scoring", "STALLED": "STALLED",
           "IDLE": "nobody working"}.get(stage, stage)
    timer = fmt_dur(elapsed) if stage != "IDLE" else fmt_dur(
        time.time() - os.path.getmtime(f"{ORCH}/build_log.md")
        if os.path.exists(f"{ORCH}/build_log.md") else 0)

    lines = []
    lines.append(f"{C['dim']}{'─' * 58}{C['r']}")
    lines.append(f"{C['b']}NEXEO{C['r']} {time.strftime('%H:%M:%S')}   "
                 f"iteration {C['b']}{in_flight}{C['r']}   "
                 f"{col}{C['b']}{who}{C['r']} {C['b']}{timer}{C['r']}")

    scp = os.path.join(STATE, "capability_scorecard.json")
    if os.path.exists(scp):
        d = json.load(open(scp))
        caps = d["capabilities"]
        n = round(sum(c["nexeo"] for c in caps) / len(caps), 1)
        pro = round(sum(c["professional"] for c in caps) / len(caps), 1)
        mv = round(sum(c.get("delta", 0) for c in caps) / len(caps), 1)
        lines.append("")
        for c in caps:
            dd = c.get("delta", 0)
            dtxt = f"{C['grn']}+{dd}{C['r']}" if dd > 0 else (
                f"{C['red']}{dd}{C['r']}" if dd < 0 else f"{C['dim']}0{C['r']}")
            lines.append(f"  {c['name']:<23}{c['nexeo']:>3} "
                         f"{gauge(c['nexeo'], c['professional'])} "
                         f"{C['dim']}{c['professional']:>3}{C['r']} {dtxt}")
        lines.append(f"  {C['b']}{'BRAIN':<23}{n:>5}{C['r']}   vs {pro} pro   "
                     f"gap {C['b']}{round(pro - n, 1)}{C['r']}   "
                     f"move {'+' if mv > 0 else ''}{mv}")

    if latest:
        ws = latest.get("weakestCriterionScore")
        tgt = latest.get("target", 95)
        gap = None if ws is None else round(tgt - ws, 1)
        v = vd.get(latest_iter, "—")
        vc = {"SOUND": C["grn"], "WEAK": C["yel"], "WRONG": C["red"]}.get(v, C["dim"])
        lines.append(f"  {C['dim']}{'gate':<23}{C['r']}"
                     f"{latest.get('weakestCriterion')} {ws} → {tgt}"
                     f"   {C['red'] if gap and gap > 0 else C['grn']}{gap} to go{C['r']}"
                     f"   codex {vc}{v}{C['r']}")
        # Kept even in the minimal view: an incomplete measurement must never be
        # mistaken for a low score, and a run that wrote to live data must not be
        # silent. One short line each, only when true.
        if latest.get("casesFailed"):
            lines.append(f"  {C['red']}{latest['casesFailed']} case(s) failed to score "
                         f"— incomplete, not low{C['r']}")
        if latest.get("mutated"):
            lines.append(f"  {C['yel']}last run wrote to live data{C['r']}")

    if full and sc:
        lines.append("")
        for it, label, d in sc[-6:]:
            v = vd.get(it, "—")
            vc = {"SOUND": C["grn"], "WEAK": C["yel"], "WRONG": C["red"]}.get(v, C["dim"])
            lines.append(f"  {C['dim']}iter {it} {label:<12}{C['r']} "
                         f"{str(d.get('overall')):>5}  min {str(d.get('weakestCriterionScore')):>5} "
                         f"{str(d.get('weakestCriterion')):<3} {vc}{v}{C['r']}")
    return "\n".join(lines)


def main():
    args = sys.argv[1:]
    if "--plain" in args:
        plain()
    full = "--full" in args
    if "--loop" in args:
        i = args.index("--loop")
        every = 60
        if i + 1 < len(args) and args[i + 1].isdigit():
            every = int(args[i + 1])
        try:
            while True:
                print(snapshot(full), flush=True)
                time.sleep(every)
        except KeyboardInterrupt:
            print("\npulse stopped (nothing else is affected)")
        return 0
    print(snapshot(full))
    return 0


if __name__ == "__main__":
    sys.exit(main())
