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
    pulse.py --loop          # refresh IN PLACE every 60s (recommended)
    pulse.py --loop 15       # every 15s
    pulse.py --loop --scroll # append a block each tick instead of redrawing
    pulse.py --full          # also show the measurement history
    pulse.py --plain         # no colour, for piping
"""
import calendar
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


# ── owner-clock rendering (G23, fixed at the owner's second report) ─────────
# All wall-clock strings render in the OWNER'S zone, labeled. The box runs UTC;
# the owner is Asia/Karachi (UTC+5, no DST — a fixed offset is exact, and every
# governing doc already stamps its rows in PKT). Durations are epoch-based and
# were never wrong. An unlabeled clock in the wrong zone reads as a lie; a
# labeled one is merely a choice.
PKT_OFFSET = 5 * 3600


def pkt(epoch, fmt="%H:%M:%S"):
    return time.strftime(fmt, time.gmtime(epoch + PKT_OFFSET)) + " PKT"


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


STAGE_FILE = os.path.join(STATE, "pulse-stage")


def stage_elapsed(stage, fallback):
    """How long the CURRENT stage has been running.

    The first version printed the transcript's age for a visible IDE turn, which
    is a different quantity entirely: it showed 5s, then 8s, then 57s during one
    continuous build turn, because it was measuring how STALE the file was, not
    how long the work had been going. The owner's question was "since how long" —
    staleness cannot answer it.

    So the moment a stage changes, the time is recorded and the timer counts from
    there. Falls back to the caller's figure only when there is no recorded start
    (first run, or the state file was cleared).
    """
    now = time.time()
    prev_stage, prev_since = "", 0.0
    try:
        raw = open(STAGE_FILE).read().split()
        prev_stage, prev_since = raw[0], float(raw[1])
    except Exception:
        pass
    if stage != prev_stage:
        try:
            os.makedirs(STATE, exist_ok=True)
            with open(STAGE_FILE, "w") as f:
                f.write(f"{stage} {now}")
        except Exception:
            pass
        return fallback
    return now - prev_since if prev_since else fallback


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

    # The third seat. Same editor-process guard as the other two matchers — grok
    # also has a TUI that could be sitting open.
    for et, arg in ps:
        if ("grok" in arg and " -p" in arg
                and "vscode-server" not in arg and "vscode/cli" not in arg):
            return "SCORING", et, "process", "grok reading the codebase (capability score)"
    for et, arg in ps:
        if "nexeoCapabilityBenchmark" in arg:
            return "MEASURING", et, "process", "benchmark: 12 cases, compose + judge"
    # The SAME editor-process trap as the claude matcher below. The owner's Codex
    # VSCode extension runs `.../openai.chatgpt-*/bin/linux-x86_64/codex … app-server`
    # permanently, and matching it reported "Codex reviewing" while the loop was
    # actually running tsc. I guarded the claude matcher against this and left its
    # twin unguarded — protection-with-two-implementations, in the tool built to
    # watch for it. `exec` must be the SUBCOMMAND, and the editor's own binary is
    # never a review turn.
    for et, arg in ps:
        if ("codex" in arg and re.search(r"codex(\.\w+)?\s+exec\b", arg)
                and "vscode-server" not in arg and "vscode/cli" not in arg):
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

    # The loop's own verification between the two agents: ~90s of tsc, build and
    # vitest. It had no stage, so every iteration showed "nobody working" for a
    # minute and a half of genuine work — which the owner twice read as stuck. Work
    # with no agent attached is still work and must be visible as such.
    for et, arg in ps:
        if ("/var/www/tmcai" in arg or "tmcai/server" in arg) and (
                "tsc" in arg or "vitest" in arg):
            what = "tsc --noEmit" if "tsc" in arg else "vitest run"
            return "CHECKS", et, "process", f"orchestrator rails: {what}"

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
        # Grok's capability files live in the same directory and carry no
        # criteriaAvg. Including them made the benchmark line render "None None →
        # 95": a status window showing None where a score belongs is worse than
        # showing nothing, because it looks like a measurement that came back empty.
        if m.group(2) == "capability":
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



# ── the iteration's phase timeline, parsed from the loop's own log ───────────
#
# Owner, 2026-08-12: *"i need one consolidate window which will show me like:
# Iteration #? Iteration Started: date/time / Build: Building 10m3s - Current /
# Review: / Progress Building: and Progress Bars"*.
#
# Phase timings come from `loop.log`, which the loop timestamps as it goes:
#
#   11:25:18  ──────── iteration 8 ────────
#   11:26:15  BUILD  iter=8 resuming "Brain Builder" (...)
#   11:44:40  BUILD  iter=8 claude exit=0 (116 lines → iter-08-build.log)
#   11:45:37  RAILS  iter=8 tsc=clean
#
# That is a RECORD of what happened, not an inference from what is running now. A
# phase with a start and no end is running; with both, its duration is exact. The
# earlier version of this file guessed the current phase from process lists and got
# it wrong twice — once calling the IDE window a build turn for 16h51m, once calling
# the Codex extension a review. Reading the log removes the guess.
PHASE_ORDER = ["Build", "Checks", "Measure", "Review", "Score"]


def phase_timeline():
    """{iteration: {phase: {"start": ts, "end": ts}}}, plus the newest iteration."""
    lg = f"{ORCH}/loop.log"
    if not os.path.exists(lg):
        return {}, None
    it_re = re.compile(r"^(\S+ \S+ \S+)\s+─+ iteration (\d+) ─+")
    ev_re = re.compile(r"^(\S+ \S+ \S+)\s+(BUILD|RAILS|MEASURE|REVIEW)\s+iter=(\d+)\s+(.*)$")
    out, newest = {}, None

    def ts(s):
        # loop.log stamps are written with %Z and this box writes UTC. timegm
        # pins the parse to UTC regardless of the server's TZ — mktime read them
        # as server-local, which was only accidentally correct (G23).
        try:
            return calendar.timegm(time.strptime(s.rsplit(" ", 1)[0], "%Y-%m-%d %H:%M:%S"))
        except Exception:
            return None

    for line in open(lg, errors="replace"):
        m = it_re.match(line)
        if m:
            it = int(m.group(2))
            newest = it if newest is None or it > newest else newest
            out.setdefault(it, {})["_started"] = ts(m.group(1))
            continue
        m = ev_re.match(line)
        if not m:
            continue
        t, kind, it, rest = ts(m.group(1)), m.group(2), int(m.group(3)), m.group(4)
        newest = it if newest is None or it > newest else newest
        d = out.setdefault(it, {})
        if kind == "BUILD":
            ph = d.setdefault("Build", {})
            if "exit=" in rest:
                ph["end"] = t
                ph["detail"] = rest.split("(")[0].strip()
            else:
                ph.setdefault("start", t)
        elif kind == "RAILS":
            ph = d.setdefault("Checks", {})
            ph.setdefault("start", t)
            ph["detail"] = rest
            # tests= is the last rail; measure starting is what actually ends it.
            if "tests=" in rest:
                ph["end"] = t
        elif kind == "MEASURE":
            ph = d.setdefault("Measure", {})
            if "started" in rest:
                ph.setdefault("start", t)
                d.setdefault("Checks", {})["end"] = t
            elif "overall=" in rest:
                ph["end"] = t
                ph["detail"] = rest
        elif kind == "REVIEW":
            ph = d.setdefault("Review", {})
            if "exit=" in rest:
                ph["end"] = t
                ph["detail"] = rest.split("(")[0].strip()
            else:
                ph.setdefault("start", t)
    # The scoring seat writes its own log, so its phase is read from there.
    sl = f"{ORCH}/score.log"
    if os.path.exists(sl):
        for line in open(sl, errors="replace"):
            m = re.match(r"^(\S+ \S+ \S+)\s+SCORE\s+iteration (\d+) (.*)$", line)
            if not m:
                continue
            t, it, rest = ts(m.group(1)), int(m.group(2)), m.group(3)
            ph = out.setdefault(it, {}).setdefault("Score", {})
            if "scored and card appended" in rest:
                ph["end"] = t
            elif "unscored" in rest:
                ph.setdefault("start", t)
    return out, newest


def last_stream_line(iteration, phase):
    """The newest readable line from whichever seat is working — the 'Progress'
    line. Read from the formatted stream logs the agents write as they go."""
    n = f"{iteration:02d}"
    src = {"Build": f"{LOGS}/iter-{n}-build.log",
           "Review": f"{LOGS}/iter-{n}-review.log",
           "Score": f"{LOGS}/iter-{n}-score-read.log"}.get(phase)
    if not src or not os.path.exists(src):
        return ""
    try:
        lines = [l.rstrip("\n") for l in open(src, errors="replace") if l.strip()]
    except Exception:
        return ""
    for ln in reversed(lines[-40:]):
        t = re.sub(r"^\[\s*\d+s\]\s*", "", ln).strip()
        t = re.sub(r"^(BUILD|REVIEW|SCORE)\s*│\s*", "", t).strip()
        if len(t) > 12 and not t.startswith("──"):
            return t[:96]
    return ""



# ── seat models, read from each seat's own output ────────────────────────────
# Owner, 2026-08-12: *"in orch window also show model of agent"*. Read from the
# logs the seats actually produced, never hardcoded — the whole point is to know
# which model did the work, and a hardcoded label would keep saying the old one
# after a switch. Codex emits no model field in its event stream, so it is shown
# as "default" rather than guessed at.
def seat_models():
    out = {"Build": "?", "Review": "default", "Score": "?"}
    for f in sorted(glob.glob(f"{LOGS}/iter-*-build.jsonl"), key=os.path.getmtime)[-1:]:
        m = re.search(r'"model":"([a-z0-9.\-]+)"', open(f, errors="replace").read(4_000_000))
        if m:
            out["Build"] = m.group(1)
    for f in sorted(glob.glob(f"{LOGS}/iter-*-score.log"), key=os.path.getmtime)[-1:]:
        m = re.search(r'"modelUsage":\s*\{\s*"([^"]+)"', open(f, errors="replace").read(4_000_000))
        if m:
            out["Score"] = m.group(1)
    return out


# ── capability trend, iteration-wise ────────────────────────────────────────
# Owner, 2026-08-12: *"can i also see i kind of trend of brain capability in orch
# window iteration wise / can you build trend chart?"*
#
# ASCII ramp, not block characters. His terminal renders █ and ░ as the same grey
# rectangle (that is why the capability bars were rewritten in ASCII), so a
# sparkline built from blocks would be unreadable in exactly the same way.
#
# Scaled per row between that row's own min and max, which is the only way a
# +0.6 total movement over ten iterations is visible at all — and the absolute
# numbers are printed beside it so the scaling cannot exaggerate. A flat row
# renders flat.
RAMP = ".-=+*#"


def spark_ascii(vals, width=None):
    real = [v for v in vals if v is not None]
    if len(real) < 2:
        return "".join("." for _ in vals)
    lo, hi = min(real), max(real)
    span = (hi - lo) or 1
    return "".join("." if v is None else
                   RAMP[min(len(RAMP) - 1, int((v - lo) / span * (len(RAMP) - 1)))]
                   for v in vals)


def capability_trend():
    """[(label, series, first, last)] — one row per capability that has moved,
    plus BRAIN overall. Capabilities that never moved are summarised in one line
    rather than printing nine flat rows: a trend chart of nine unchanged numbers
    is noise that hides the two that changed."""
    scp = os.path.join(STATE, "capability_scorecard.json")
    if not os.path.exists(scp):
        return [], [], 0
    try:
        d = json.load(open(scp))
    except Exception:
        return [], [], 0
    hist = d.get("history", [])
    # One point per iteration — the last entry for that iteration wins, because a
    # recalibration appends a second row for an iteration already recorded.
    per_iter = {}
    for h in hist:
        snap = h.get("snapshot")
        if snap:
            per_iter[h["iteration"]] = snap
    iters = sorted(per_iter)
    if len(iters) < 2:
        return [], [], 0
    names = [c["name"] for c in d["capabilities"]]
    moved, flat = [], []
    for nm in names:
        series = [next((c["nexeo"] for c in per_iter[i] if c["name"] == nm), None)
                  for i in iters]
        real = [v for v in series if v is not None]
        if not real:
            continue
        if real[0] == real[-1] and len(set(real)) == 1:
            flat.append(nm)
        else:
            moved.append((nm, series, real[0], real[-1]))
    overall = [round(sum(c["nexeo"] for c in per_iter[i]) / len(per_iter[i]), 1)
               for i in iters]
    moved.append(("BRAIN overall", overall, overall[0], overall[-1]))
    return moved, flat, iters


# ── collect, then render ─────────────────────────────────────────────────────
#
# Owner, 2026-08-12: *"what if we build live dashboard in ?tab=health which shows
# me exact picture (same like orch pulse window) with good graphics?"*
#
# The window and the web dashboard MUST read the same numbers, so everything the
# display needs is gathered here once, as plain data, and both surfaces render
# from it. The alternative — a second stage detector written in TypeScript — is
# the exact failure this file has already been burned by twice: the codex matcher
# was left unguarded against the editor process because its twin, the claude
# matcher, was guarded in a separate copy of the same rule. One detector, two
# renderers. Anything the browser shows that the terminal does not is a bug in
# the renderer, never a difference of opinion about what is running.
#
# Epochs are emitted raw (`now`, phase `start`/`end`) so the browser can count
# its own timers up between polls instead of freezing between refreshes, and so
# clocks can be rendered in the owner's zone there exactly as `pkt()` does here.


def capability_series():
    """Brain capability, iteration by iteration, as NUMERIC SERIES ready to chart.

    Owner, 2026-08-13: *"i want to see brain improvement iteration wise"*.

    The data existed — inside each iteration's record and inside the scorecard's
    history — but only as ASCII sparklines for the terminal and as one number per
    row. A chart needs series: nine capability lines plus the overall, indexed by
    iteration, with the movement and WHO scored it.

    Two things are carried alongside each point on purpose:
      · `scored_by` — iterations 1-6 were the orchestrator's own judgements and 7+
        are Grok's. A chart that hides the change of scorer would show a
        methodology shift as if it were progress.
      · `disputed` — the scorer raised a capability in an iteration the reviewer
        ruled WEAK or WRONG. The Deck should be able to mark that point rather
        than draw it as settled.
    """
    scp = os.path.join(STATE, "capability_scorecard.json")
    if not os.path.exists(scp):
        return None
    try:
        d = json.load(open(scp))
    except Exception:
        return None
    names = [c["name"] for c in d.get("capabilities", [])]
    pro = {c["name"]: c["professional"] for c in d.get("capabilities", [])}

    # Reviewer verdicts, so a disputed point can be flagged.
    verdicts = {}
    rl = f"{ORCH}/review_log.md"
    if os.path.exists(rl):
        txt = open(rl, errors="replace").read()
        for m in re.finditer(r"^##\s+Iteration\s+(\d+)(.*?)(?=^##\s+Iteration|\Z)",
                             txt, re.S | re.M):
            v = re.search(r"\*\*(SOUND|WEAK|WRONG)\*\*", m.group(2))
            if v:
                verdicts[int(m.group(1))] = v.group(1)

    points, per_iter = [], {}
    for h in d.get("history", []):
        snap = h.get("snapshot")
        if not snap:
            continue
        per_iter[h["iteration"]] = (h, snap)  # a later entry for the same iteration wins
    for it in sorted(per_iter):
        h, snap = per_iter[it]
        by = {c["name"]: c["nexeo"] for c in snap}
        overall = round(sum(by.values()) / len(by), 1) if by else None
        rv = verdicts.get(it)
        points.append({
            "iteration": it,
            "head": h.get("head"),
            "overall": overall,
            "movement": h.get("movement"),
            "verdict": h.get("verdict"),
            "scored_by": h.get("scored_by", "orchestrator"),
            "reviewer_verdict": rv,
            "disputed": bool(rv in ("WEAK", "WRONG") and (h.get("movement") or 0) > 0),
            "capabilities": by,
            "what_moved": h.get("what_moved"),
        })

    # One line per capability, plus the overall — the shape a chart consumes.
    series = []
    for nm in names:
        vals = [p["capabilities"].get(nm) for p in points]
        real = [v for v in vals if v is not None]
        series.append({
            "name": nm, "professional": pro.get(nm),
            "objective": round((pro.get(nm) or 0) * 0.95, 1),
            "values": vals,
            "first": real[0] if real else None,
            "last": real[-1] if real else None,
            "delta": round(real[-1] - real[0], 1) if len(real) > 1 else 0,
            "moved": bool(len(set(real)) > 1),
        })
    overalls = [p["overall"] for p in points]
    return {
        "iterations": [p["iteration"] for p in points],
        "points": points,
        "series": series,
        "overall": {
            "values": overalls,
            "first": overalls[0] if overalls else None,
            "last": overalls[-1] if overalls else None,
            "delta": round((overalls[-1] or 0) - (overalls[0] or 0), 1) if len(overalls) > 1 else 0,
            "professional": round(sum(pro.values()) / len(pro), 1) if pro else None,
            "objective": round(sum(v * 0.95 for v in pro.values()) / len(pro), 1) if pro else None,
        },
        "note": "Capability scores are evidence judgements, not test results. "
                "Iterations 1-6 were scored by the orchestrator; 7 onward by Grok "
                "(scored_by per point). A green build never moves a capability.",
    }


def campaign_snapshot():
    """The active campaign and what is queued — so the Deck can show WHAT the loop
    is aiming at, not only how it scored. Without this the dashboard shows motion
    with no target, which is how eight iterations of drift went unnoticed."""
    f = os.path.join(STATE, "campaign.json")
    if not os.path.exists(f):
        return None
    try:
        d = json.load(open(f))
    except Exception:
        return None
    a = d.get("active") or {}
    return {
        "active": {k: a.get(k) for k in
                   ("id", "name", "capability", "from_iteration",
                    "budget_iterations", "goal", "exit_condition")},
        "queued": [{k: c.get(k) for k in ("id", "name", "capability", "target",
                                          "from_iteration", "budget_iterations")}
                   for c in (d.get("queued") or [])],
    }


def collect():
    stage, elapsed, basis, detail = detect_stage()
    # A process-derived elapsed time is the kernel's own and needs no help; a
    # file-derived one is staleness, not duration, so it is replaced by the
    # recorded stage start.
    if basis in ("transcript", "logfile", "none"):
        elapsed = stage_elapsed(stage, elapsed)
    else:
        stage_elapsed(stage, elapsed)  # keep the record current
    sc = scores()
    vd = verdicts()
    latest = sc[-1][2] if sc else {}
    latest_iter = sc[-1][0] if sc else None

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

    tl, newest = phase_timeline()
    cur_it = newest if newest is not None else in_flight
    phases = tl.get(cur_it, {})
    started = phases.get("_started")
    now = time.time()

    # Which phase is CURRENT: the live stage detector names the seat, and the
    # timeline says whether it has an unfinished phase. They are cross-checked
    # rather than trusted separately — a process without a log entry, or a log
    # entry without a process, both mean something is wrong and it should show.
    stage_to_phase = {"BUILDING": "Build", "CHECKS": "Checks", "MEASURING": "Measure",
                      "REVIEWING": "Review", "SCORING": "Score"}
    current = stage_to_phase.get(stage)

    # THE LOG WINS when it disagrees with the process list, provided the loop is
    # alive. The rails run several tools in sequence — tsc, npm run build, vitest —
    # and the process matcher only recognises two of them, so during `npm run build`
    # the detector said IDLE while the log plainly showed Checks open. That rendered
    # a running phase as "started, no completion recorded", in red: a working loop
    # displayed as a broken one, which is the failure this window exists to end.
    loop_alive = any("nexeo-loop.sh" in a and "bash" in a for _, a in procs())
    if current is None and loop_alive:
        for ph in reversed(PHASE_ORDER):
            p_ = phases.get(ph, {})
            if p_.get("start") and not p_.get("end"):
                current = ph
                break

    seat = {"Build": "Claude", "Checks": "orchestrator", "Measure": "benchmark",
            "Review": "Codex", "Score": "Grok"}
    models = seat_models()
    phase_rows = []
    for ph in PHASE_ORDER:
        p_ = phases.get(ph, {})
        s_, e_ = p_.get("start"), p_.get("end")
        running = bool(s_ and not e_ and loop_alive) or ph == current
        if running:
            # MORE THAN ONE PHASE CAN BE RUNNING. Measure and Review overlap by
            # design — the benchmark was moved to run alongside the review so the
            # two agents go back-to-back — and the first version of this display
            # marked only one as current, painting the other red as "no completion
            # recorded". A concurrent phase must not render as an abandoned one.
            state, dur = "running", now - (s_ or (now - elapsed))
        elif s_ and e_:
            state, dur = "done", e_ - s_
        elif s_:
            # Started, never finished, and the loop is NOT alive to be running it.
            # Never shown as done: an abandoned phase and a completed one must not
            # look alike.
            state, dur = "abandoned", now - s_
        else:
            state, dur = "pending", None
        mdl = models.get(ph, "")
        phase_rows.append({
            "name": ph, "seat": seat[ph], "state": state,
            "model": mdl if mdl and mdl != "?" else None,
            "start": s_, "end": e_, "duration": dur,
            "current": ph == current, "detail": p_.get("detail"),
        })

    caps, brain = [], None
    scp = os.path.join(STATE, "capability_scorecard.json")
    if os.path.exists(scp):
        try:
            d = json.load(open(scp))
        except Exception:
            d = None
        if d:
            caps = [{"name": c["name"], "nexeo": c["nexeo"],
                     "professional": c["professional"], "delta": c.get("delta", 0)}
                    for c in d["capabilities"]]
            nn = round(sum(c["nexeo"] for c in caps) / len(caps), 1)
            pro = round(sum(c["professional"] for c in caps) / len(caps), 1)
            brain = {
                "nexeo": nn, "professional": pro, "gap": round(pro - nn, 1),
                "move": round(sum(c["delta"] for c in caps) / len(caps), 1),
                "scored_by": (d.get("history") or [{}])[-1].get("scored_by",
                                                               "orchestrator"),
            }

    moved, flat, iters = capability_trend()
    trend = {"iterations": list(iters), "unmoved": flat, "rows": [
        {"name": nm, "series": series, "first": first, "last": last,
         "delta": round(last - first, 1), "overall": nm == "BRAIN overall"}
        for nm, series, first, last in moved]}

    bench = None
    if latest:
        ws = latest.get("weakestCriterionScore")
        tgt = latest.get("target", 95)
        bench = {
            "criterion": latest.get("weakestCriterion"), "score": ws, "target": tgt,
            "gap": None if ws is None else round(tgt - ws, 1),
            "verdict": vd.get(latest_iter, "—"), "iteration": latest_iter,
            "overall": latest.get("overall"),
            "cases_failed": latest.get("casesFailed") or 0,
            "mutated": bool(latest.get("mutated")),
        }

    return {
        "now": now, "pkt_offset": PKT_OFFSET,
        "stage": {"name": stage, "elapsed": elapsed, "basis": basis,
                  "detail": detail},
        "loop_alive": loop_alive,
        "iteration": cur_it, "iteration_started": started,
        "iterations_built": built, "iteration_in_flight": in_flight,
        "current_phase": current, "phases": phase_rows,
        "progress": last_stream_line(cur_it, current) if current else "",
        "capabilities": caps, "brain": brain, "trend": trend,
        "benchmark": bench,
        # The rich per-iteration record the Deck monitors. `history` below is kept
        # unchanged so the existing panel does not break — additive, not a rename.
        "iterations": iteration_records(),
        "campaign": campaign_snapshot(),
        "capability_series": capability_series(),
        "history": [{"iteration": it, "label": label, "overall": dd.get("overall"),
                     "weakest": dd.get("weakestCriterionScore"),
                     "criterion": dd.get("weakestCriterion"),
                     "verdict": vd.get(it, "—")} for it, label, dd in sc[-6:]],
    }


def render(d, full=False):
    """The terminal window, drawn from `collect()`. Formatting only — every
    number and every judgement about what is running was decided there."""
    now = d["now"]
    stage = d["stage"]["name"]
    cur_it, started = d["iteration"], d["iteration_started"]
    current = d["current_phase"]

    lines = []
    # The clock sits on the divider, not the header. With both on one line the
    # header ran past ~74 columns and WRAPPED in the owner's terminal, breaking the
    # timestamp across two lines ("11" / ":51:00"). A status line that wraps is a
    # status line that misreads.
    lines.append(f"{C['dim']}{'─' * 52} {pkt(now)} ──────{C['r']}")
    st = pkt(started, "%Y-%m-%d %H:%M:%S") if started else "unknown"
    lines.append(f"{C['b']}Iteration #{cur_it}{C['r']}   Iteration Started: {st}"
                 + (f"  {C['dim']}({fmt_dur(now - started)} ago){C['r']}" if started else ""))
    lines.append("")

    for p_ in d["phases"]:
        ph, state, dur = p_["name"], p_["state"], p_["duration"]
        if state == "running":
            word = "Building" if ph == "Build" else "Running"
            txt = f"{C['cyn']}{C['b']}{word}{C['r']} {C['b']}{fmt_dur(dur)}{C['r']}"
            if p_["current"]:
                txt += f"  {C['yel']}- Current{C['r']}"
        elif state == "done":
            txt = f"{C['grn']}done{C['r']} {fmt_dur(dur)}"
        elif state == "abandoned":
            txt = f"{C['red']}started {fmt_dur(dur)} ago, no completion recorded{C['r']}"
        else:
            txt = f"{C['dim']}—{C['r']}"
        who = p_["seat"] + (f" · {p_['model']}" if p_["model"] else "")
        lines.append(f"  {ph + ':':<9}{txt}   {C['dim']}{who}{C['r']}")

    prog = d["progress"]
    if current and prog:
        lines.append("")
        lines.append(f"  {C['b']}Progress {current}:{C['r']} {prog}")
    elif stage == "IDLE":
        lines.append("")
        lines.append(f"  {C['dim']}Progress: nobody working{C['r']}")

    caps, brain = d["capabilities"], d["brain"]
    if caps and brain:
        lines.append("")
        for c in caps:
            dd = c["delta"]
            dtxt = f"{C['grn']}+{dd}{C['r']}" if dd > 0 else (
                f"{C['red']}{dd}{C['r']}" if dd < 0 else f"{C['dim']}0{C['r']}")
            lines.append(f"  {c['name']:<23}{c['nexeo']:>3} "
                         f"{gauge(c['nexeo'], c['professional'])} "
                         f"{C['dim']}{c['professional']:>3}{C['r']} {dtxt}")
        # Trimmed to fit ~74 columns: at 83 chars this line wrapped in the owner's
        # terminal, putting "grok" alone on the next row.
        mv = brain["move"]
        lines.append(f"  {C['b']}{'BRAIN':<23}{brain['nexeo']:>5}{C['r']}  "
                     f"vs {brain['professional']}  "
                     f"gap {C['b']}{brain['gap']}{C['r']}  "
                     f"move {'+' if mv > 0 else ''}{mv}  "
                     f"{C['dim']}by {brain['scored_by']}{C['r']}")

    # ── capability trend, iteration-wise ──
    tr = d["trend"]
    if tr["rows"]:
        iters = tr["iterations"]
        lines.append("")
        lines.append(f"  {C['b']}TREND{C['r']} {C['dim']}capability by iteration "
                     f"{iters[0]}→{iters[-1]}  ({len(iters)} scored){C['r']}")
        for row in tr["rows"]:
            d_ = row["delta"]
            dtxt = f"{C['grn']}+{d_}{C['r']}" if d_ > 0 else (
                f"{C['red']}{d_}{C['r']}" if d_ < 0 else f"{C['dim']}0{C['r']}")
            bold = C['b'] if row["overall"] else ""
            lines.append(f"  {bold}{row['name']:<23}{C['r']}{row['first']:>5} "
                         f"{C['cyn']}{spark_ascii(row['series'])}{C['r']} "
                         f"{row['last']:>5}  {dtxt}")
        if tr["unmoved"]:
            # Named, not hidden: eight capabilities that have never moved is the
            # single most important fact about this loop's progress, and printing
            # eight flat rows would bury it instead of stating it.
            lines.append(f"  {C['dim']}unmoved since scoring began: "
                         f"{', '.join(tr['unmoved'])}{C['r']}")

    b = d["benchmark"]
    if b:
        gap = b["gap"]
        vc = {"SOUND": C["grn"], "WEAK": C["yel"],
              "WRONG": C["red"]}.get(b["verdict"], C["dim"])
        lines.append(f"  {C['dim']}{'benchmark':<23}{C['r']}"
                     f"{b['criterion']} {b['score']} → {b['target']}"
                     f"   {C['red'] if gap and gap > 0 else C['grn']}{gap} to go{C['r']}"
                     f"   codex {vc}{b['verdict']}{C['r']}"
                     f"   {C['dim']}(iter {b['iteration']}){C['r']}")
        if b["cases_failed"]:
            lines.append(f"  {C['red']}{b['cases_failed']} case(s) failed to score "
                         f"— incomplete, not low{C['r']}")
        if b["mutated"]:
            lines.append(f"  {C['yel']}last run wrote to live data{C['r']}")

    if full and d["history"]:
        lines.append("")
        for h in d["history"]:
            vc = {"SOUND": C["grn"], "WEAK": C["yel"],
                  "WRONG": C["red"]}.get(h["verdict"], C["dim"])
            lines.append(f"  {C['dim']}iter {h['iteration']} {h['label']:<12}{C['r']} "
                         f"{str(h['overall']):>5}  min {str(h['weakest']):>5} "
                         f"{str(h['criterion']):<3} {vc}{h['verdict']}{C['r']}")
    return "\n".join(lines)



# ── the per-iteration record, for the Deck ──────────────────────────────────
# Owner, 2026-08-13: *"i am building deck UI based… i want you to capture max
# information at each iteration level that can help me monitor at Deck / here i
# have given one graphical info where i want to see iteration wise improvement"*.
#
# Everything the four seats produce, joined on the iteration number. The pieces
# already existed and were scattered across eight files in three formats — two of
# them markdown, which a UI cannot consume — so the Deck could only show the six
# fields the old `history` list carried (iter, run, overall, weakest, crit, codex).
#
# This is deliberately assembled in the ONE collector both renderers already share.
# A TypeScript reimplementation in the route would be a second copy of parsing
# logic that has been got wrong twice in this file's history, and the route's own
# docblock says so.
def iteration_records(limit=25):
    recs = {}

    def rec(i):
        return recs.setdefault(int(i), {"iteration": int(i)})

    # 1. ledger — one row per iteration as the loop finished it
    lj = f"{ORCH}/ledger.jsonl"
    if os.path.exists(lj):
        for line in open(lj, errors="replace"):
            try:
                d = json.loads(line)
            except Exception:
                continue
            r = rec(d.get("iteration", -1))
            r.update({"head": d.get("head"), "finished_at": d.get("at"),
                      "tsc": d.get("tsc"), "tests": d.get("tests"),
                      "mode": d.get("mode"), "note": d.get("note"),
                      "gate": d.get("gate")})

    # 2. phase timings, from the loop's own timestamped log
    tl, _ = phase_timeline()
    for it, ph in tl.items():
        r = rec(it)
        r["started_at"] = ph.get("_started")
        phases = {}
        for name in PHASE_ORDER:
            p_ = ph.get(name) or {}
            st, en = p_.get("start"), p_.get("end")
            phases[name.lower()] = {
                "start": st, "end": en,
                "seconds": round(en - st) if st and en else None,
            }
        r["phases"] = phases
        ends = [v["end"] for v in phases.values() if v["end"]]
        if r.get("started_at") and ends:
            r["duration_seconds"] = round(max(ends) - r["started_at"])

    # 3. benchmark, full per-criterion — this is what "iteration wise improvement"
    #    needs: eight series, not one number
    for f in glob.glob(f"{ORCH}/scores/iter-*-post-build.json"):
        m = re.search(r"iter-(\d+)-post-build\.json$", os.path.basename(f))
        if not m:
            continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        r = rec(int(m.group(1)))
        r["benchmark"] = {
            "overall": d.get("overall"),
            "criteria": d.get("criteriaAvg", {}),
            "weakest": d.get("weakestCriterion"),
            "weakest_score": d.get("weakestCriterionScore"),
            "target": d.get("target", 95),
            "gate_passed": d.get("gatePassed"),
            "cases_scored": d.get("casesScored"),
            "cases_failed": d.get("casesFailed"),
            "mutated": d.get("mutated"),
            "mutation_evidence": (d.get("mutationEvidence") or [])[:3],
            "duration_ms": d.get("durationMs"),
            # The judge's own worst sentences: the most actionable thing in the
            # whole record, and the Deck can show them verbatim.
            "worst": [{"criterion": q.get("criterion"), "score": q.get("score"),
                       "case": q.get("caseId"), "reason": (q.get("reason") or "")[:220]}
                      for q in sorted(d.get("fixQueue") or [],
                                      key=lambda q: q.get("score", 100))[:3]],
        }

    # 4. the proactive surface — a second, separately-reported score (C-1)
    for f in glob.glob(f"{ORCH}/scores/proactive-iter-*.json"):
        m = re.search(r"proactive-iter-(\d+)\.json$", os.path.basename(f))
        if not m:
            continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        rec(int(m.group(1)))["proactive"] = {
            "overall": d.get("overall"), "surface": d.get("surface"),
            "weakest": d.get("weakestCriterion"),
            "weakest_score": d.get("weakestCriterionScore"),
            "cases_scored": d.get("casesScored"),
            "gate_passed": d.get("gatePassed"),
            "note": (d.get("note") or "")[:300],
        }

    # 5. the scorer's card — nine capabilities with evidence and basis
    for f in glob.glob(f"{ORCH}/scores/iter-*-capability.json"):
        m = re.search(r"iter-(\d+)-capability\.json$", os.path.basename(f))
        if not m:
            continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        r = rec(int(m.group(1)))
        if d.get("skipped"):
            r["scorer"] = {"skipped": True, "reason": d.get("reason")}
            continue
        caps = d.get("capabilities") or []
        r["scorer"] = {
            "verdict": d.get("overall_verdict"),
            "overall": (round(sum(c.get("score", 0) for c in caps) / len(caps), 1)
                        if caps else None),
            "what_moved": d.get("what_moved"),
            "what_did_not": d.get("what_did_not"),
            "unverifiable": d.get("unverifiable"),
            "notes_for_builder": d.get("notes_for_builder"),
            "claim_seen": d.get("capability_claim_seen"),
            "capabilities": [{"name": c.get("name"), "score": c.get("score"),
                              "basis": c.get("basis"), "confidence": c.get("confidence"),
                              "evidence": (c.get("evidence") or "")[:300],
                              "reconciliation": (c.get("claim_reconciliation") or "")[:300]}
                             for c in caps],
        }

    # 6. the reviewer — verdict AND the capability-attribution ruling, parsed out of
    #    markdown because that is the only place Codex writes
    rl = f"{ORCH}/review_log.md"
    if os.path.exists(rl):
        txt = open(rl, errors="replace").read()
        for m in re.finditer(r"^##\s+Iteration\s+(\d+)(.*?)(?=^##\s+Iteration|\Z)",
                             txt, re.S | re.M):
            it, body = int(m.group(1)), m.group(2)
            r = rec(it)
            v = re.search(r"\*\*(SOUND|WEAK|WRONG)\*\*", body)
            one = re.search(r"\*\*(?:SOUND|WEAK|WRONG)\*\*\s*—\s*(.+?)(?:\n\n|\Z)",
                            body, re.S)
            att = re.search(r"verdict:\s*(SUPPORTED|OVERSTATED|MISATTRIBUTED|"
                            r"RELIABILITY-ONLY[^\n]*)", body)
            risks = re.findall(r"\*\*(CRITICAL|HIGH|MEDIUM|LOW)\s*—", body)
            r["reviewer"] = {
                "verdict": v.group(1) if v else None,
                "summary": " ".join(one.group(1).split())[:400] if one else None,
                "attribution": att.group(1).strip() if att else None,
                "risk_counts": {lvl: risks.count(lvl)
                                for lvl in ("CRITICAL", "HIGH", "MEDIUM", "LOW")
                                if risks.count(lvl)},
            }

    # 7. the builder's declared claim, from its own log
    bl = f"{ORCH}/build_log.md"
    if os.path.exists(bl):
        txt = open(bl, errors="replace").read()
        for m in re.finditer(r"^##\s+Iteration\s+(\d+)(.*?)(?=^##\s+Iteration|\Z)",
                             txt, re.S | re.M):
            it, body = int(m.group(1)), m.group(2)
            r = rec(it)
            cap = re.search(r"CAPABILITY:\s*([^\n]+)", body)
            pred = re.search(r"PREDICTED:\s*([^\n]+)", body)
            fals = re.search(r"FALSIFIER:\s*([^\n]+)", body)
            if cap or pred:
                r["claim"] = {
                    "capability": cap.group(1).strip() if cap else None,
                    "predicted": pred.group(1).strip() if pred else None,
                    "falsifier": fals.group(1).strip()[:200] if fals else None,
                }
            else:
                r["claim"] = {"capability": None, "predicted": None,
                              "missing": "no capability block — the contract requires one"}

    # 8. deploy outcome
    for path_, key in ((f"{STATE}/deploy-holds", "hold"),
                       (f"{STATE}/deploy-history", "shipped")):
        if not os.path.exists(path_):
            continue
        for line in open(path_, errors="replace"):
            parts = line.split()
            if len(parts) < 2:
                continue
            try:
                r = rec(int(parts[1]))
            except ValueError:
                continue
            if key == "hold":
                r["deploy"] = {"shipped": False,
                               "reason": parts[2] if len(parts) > 2 else "hold"}
            else:
                r["deploy"] = {"shipped": True, "at": parts[0],
                               "head": parts[2] if len(parts) > 2 else None}

    # 9. defects and cost — what the turn produced and what it cost
    for it, r in recs.items():
        n = f"{it:02d}"
        raw = f"{LOGS}/iter-{n}-build.jsonl"
        if os.path.exists(raw):
            try:
                blob = open(raw, errors="replace").read()
                c = re.findall(r'"total_cost_usd":([0-9.]+)', blob)
                if c:
                    r["cost_usd"] = round(float(c[-1]), 4)
                t = re.findall(r'"num_turns":(\d+)', blob)
                if t:
                    r["agent_turns"] = int(t[-1])
            except Exception:
                pass
        rl_ = f"{LOGS}/iter-{n}-build.log"
        if os.path.exists(rl_):
            defs = sorted(set(re.findall(r"DEF-\d+",
                          open(rl_, errors="replace").read())))
            if defs:
                r["defects"] = defs[:8]

    # 10. do the reviewer and the scorer AGREE? A capability raised in an iteration
    #     the reviewer ruled WEAK/WRONG is disputed, and the Deck should show it as
    #     such rather than presenting a movement as settled.
    for r in recs.values():
        rv = (r.get("reviewer") or {}).get("verdict")
        sc = r.get("scorer") or {}
        moved = sc.get("verdict") in ("PROGRESSIVE",)
        r["disputed"] = bool(rv in ("WEAK", "WRONG") and moved)

    out = [recs[k] for k in sorted(recs) if k >= 0]
    return out[-limit:]


def snapshot(full=False):
    return render(collect(), full)


def main():
    args = sys.argv[1:]
    if "--json" in args:
        # What the web dashboard reads. Same collector as the window, so the two
        # can never disagree about the stage, the timers or the scores.
        json.dump(collect(), sys.stdout, allow_nan=False)
        sys.stdout.write("\n")
        return 0
    if "--plain" in args:
        plain()
    full = "--full" in args
    if "--loop" in args:
        i = args.index("--loop")
        every = 60
        if i + 1 < len(args) and args[i + 1].isdigit():
            every = int(args[i + 1])
        # Redraws IN PLACE by default — owner, 2026-08-12: "can't it keep updating
        # same window??". Appending a fresh block each tick pushed the live line
        # off the top of the screen, so the one number he is watching kept moving
        # away from him. `--scroll` keeps the old append-forever behaviour for
        # anyone who wants a log.
        scroll = "--scroll" in args
        try:
            while True:
                out = snapshot(full)
                if scroll:
                    print(out, flush=True)
                else:
                    # Home the cursor, then erase to end of EVERY line as it is
                    # written, then clear whatever is left below.
                    #
                    # `\033[J` alone only clears BELOW the cursor, so when a new
                    # frame's line was shorter than the old one the tail of the old
                    # line survived: the owner's screenshot showed "92 03 ======="
                    # and "6m48ss" — a real number with a dead number welded to it,
                    # which is worse than a misaligned column because it cannot be
                    # told apart from data. `\033[K` per line is the fix.
                    frame = "".join(f"{ln}\033[K\n" for ln in out.split("\n"))
                    sys.stdout.write("\033[H" + frame + "\033[J")
                    sys.stdout.flush()
                time.sleep(every)
        except KeyboardInterrupt:
            sys.stdout.write("\n")
            print("pulse stopped (the loop itself is unaffected)")
        return 0
    print(snapshot(full))
    return 0


if __name__ == "__main__":
    sys.exit(main())
