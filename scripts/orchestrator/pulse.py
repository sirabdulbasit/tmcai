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
        try:
            return time.mktime(time.strptime(s.rsplit(" ", 1)[0], "%Y-%m-%d %H:%M:%S"))
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


def snapshot(full=False):
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

    lines = []
    lines.append(f"{C['dim']}{'─' * 74}{C['r']}")
    st = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(started)) if started else "unknown"
    lines.append(f"{C['b']}Iteration #{cur_it}{C['r']}      Iteration Started: {st}"
                 + (f"   {C['dim']}({fmt_dur(now - started)} ago){C['r']}" if started else "")
                 + f"      {C['dim']}{time.strftime('%H:%M:%S')}{C['r']}")
    lines.append("")

    seat = {"Build": "Claude", "Checks": "orchestrator", "Measure": "benchmark",
            "Review": "Codex", "Score": "Grok"}
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
            base = s_ or (now - elapsed)
            word = "Building" if ph == "Build" else "Running"
            txt = f"{C['cyn']}{C['b']}{word}{C['r']} {C['b']}{fmt_dur(now - base)}{C['r']}"
            if ph == current:
                txt += f"  {C['yel']}- Current{C['r']}"
        elif s_ and e_:
            txt = f"{C['grn']}done{C['r']} {fmt_dur(e_ - s_)}"
        elif s_ and not e_:
            # Started, never finished, and the loop is NOT alive to be running it.
            # Never shown as done: an abandoned phase and a completed one must not
            # look alike.
            txt = f"{C['red']}started {fmt_dur(now - s_)} ago, no completion recorded{C['r']}"
        else:
            txt = f"{C['dim']}—{C['r']}"
        lines.append(f"  {ph + ':':<9}{txt}   {C['dim']}{seat[ph]}{C['r']}")

    prog = last_stream_line(cur_it, current) if current else ""
    if current and prog:
        lines.append("")
        lines.append(f"  {C['b']}Progress {current}:{C['r']} {prog}")
    elif stage == "IDLE":
        lines.append("")
        lines.append(f"  {C['dim']}Progress: nobody working{C['r']}")

    scp = os.path.join(STATE, "capability_scorecard.json")
    if os.path.exists(scp):
        d = json.load(open(scp))
        caps = d["capabilities"]
        nn = round(sum(c["nexeo"] for c in caps) / len(caps), 1)
        pro = round(sum(c["professional"] for c in caps) / len(caps), 1)
        mv = round(sum(c.get("delta", 0) for c in caps) / len(caps), 1)
        by = (d.get("history") or [{}])[-1].get("scored_by", "orchestrator")
        lines.append("")
        for c in caps:
            dd = c.get("delta", 0)
            dtxt = f"{C['grn']}+{dd}{C['r']}" if dd > 0 else (
                f"{C['red']}{dd}{C['r']}" if dd < 0 else f"{C['dim']}0{C['r']}")
            lines.append(f"  {c['name']:<23}{c['nexeo']:>3} "
                         f"{gauge(c['nexeo'], c['professional'])} "
                         f"{C['dim']}{c['professional']:>3}{C['r']} {dtxt}")
        lines.append(f"  {C['b']}{'BRAIN':<23}{nn:>5}{C['r']}   vs {pro} pro   "
                     f"gap {C['b']}{round(pro - nn, 1)}{C['r']}   "
                     f"move {'+' if mv > 0 else ''}{mv}   {C['dim']}scored by {by}{C['r']}")

    if latest:
        ws = latest.get("weakestCriterionScore")
        tgt = latest.get("target", 95)
        gap = None if ws is None else round(tgt - ws, 1)
        v = vd.get(latest_iter, "—")
        vc = {"SOUND": C["grn"], "WEAK": C["yel"], "WRONG": C["red"]}.get(v, C["dim"])
        lines.append(f"  {C['dim']}{'benchmark':<23}{C['r']}"
                     f"{latest.get('weakestCriterion')} {ws} → {tgt}"
                     f"   {C['red'] if gap and gap > 0 else C['grn']}{gap} to go{C['r']}"
                     f"   codex {vc}{v}{C['r']}   {C['dim']}(iter {latest_iter}){C['r']}")
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
