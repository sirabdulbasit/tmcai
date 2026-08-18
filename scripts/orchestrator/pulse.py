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
        # THE THIRD OCCURRENCE OF THIS FILE'S OWN TRAP — owner, 2026-08-13, looking at
        # the Deck: *"how 2 are running at the same time"*, with Measure and Review both
        # showing Running. They were not: the log has MEASURE finishing and REVIEW
        # starting in the same second. The bare substring matched the CODEX process,
        # because `codex exec` carries its entire prompt on argv and the review prompt
        # NAMES this script in its benchmark-integrity check. Verified rather than
        # assumed: `tr '\0' ' ' < /proc/<codex-pid>/cmdline | grep nexeoCapabilityBenchmark`
        # hits. So the panel reported a phase that had already ended, for as long as the
        # review ran.
        #
        # The real benchmark is `node -r dotenv/config dist/scripts/nexeoCapabilityBenchmark.js`
        # (nexeo-loop.sh:180). Match THAT, and never an agent carrying it as prompt text.
        if not re.search(r"\bnode\b.*dist/scripts/nexeoCapabilityBenchmark\.js", arg):
            continue
        if re.search(r"codex(\.\w+)?\s+exec\b", arg) or "grok" in arg or "/claude" in arg:
            continue
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
    # WAITING, not IDLE — owner, 2026-08-18: "idle is nothing." Under cron there is no
    # such thing as idle: either a pulse is running or the next one is due at a time we
    # can state. Naming the wait is what turns "nothing is happening" into "nothing is
    # SUPPOSED to be happening yet", which are different facts about a system.
    _np = next_pulses(time.time())
    _bits = []
    if _np.get("conversational_in_s") is not None:
        _cin = _np["conversational_in_s"]
        _bits.append(f"conversational check in {_cin // 60}m{_cin % 60:02d}s "
                     "(runs only if you have messaged Brain since the last one)")
    if _np.get("night_in_s") is not None:
        _nin = _np["night_in_s"]
        _bits.append(f"night evaluation at {_np['night_at']}, in {_nin // 3600}h{(_nin % 3600) // 60:02d}m")
    if _bits:
        # The elapsed clock is the time until the SOONEST next pulse, counting down,
        # rather than time-since-something-stopped, which is what made a finished pulse
        # look like a stall.
        _soon = min(v for v in (_np.get("conversational_in_s"), _np.get("night_in_s"))
                    if v is not None)
        return "WAITING", _soon, "next cron", " · ".join(_bits)
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
ROOT_DOCS = "/var/www/tmcai/server/docs"
# Owner, 2026-08-17: "merge Building & Deploy". They are one act now that the ship no
# longer waits for a review — Claude builds and the result goes to production in the
# same stretch. The merged row spans from the build starting to the deploy finishing;
# Check & Measure runs inside that span and keeps its own row, because tsc and vitest
# are the only gate left between the diff and the owner's production WhatsApp and a
# gate that cannot be seen is not a gate.
# Two pulse kinds, two stage lists — owner, 2026-08-18. A conversational pulse reads the
# new turns and ships a fix; it does not score, measure or review, so showing those rows
# would draw three stages that can never fill and read as a stalled pulse.
# The kind is written by the loop into state/pulse-mode at the banner, so the deck follows
# what actually ran instead of guessing from which rows happen to be empty.
PHASE_ORDER_EVALUATION = ["Capability Evaluation", "Chat Analysis", "Build & Deploy",
                          "Check & Measure", "Review Capabilities"]
PHASE_ORDER_CONVERSATIONAL = ["Chat Analysis", "Build & Deploy"]


def pulse_mode():
    try:
        return (open(os.path.join(STATE, "pulse-mode")).read().strip()
                or "evaluation")
    except Exception:
        return "evaluation"


def _phase_order():
    return (PHASE_ORDER_CONVERSATIONAL if pulse_mode() == "conversational"
            else PHASE_ORDER_EVALUATION)


# Kept as a module-level name because several helpers close over it; it is refreshed on
# every collect() so a mode change is picked up without a restart.
PHASE_ORDER = PHASE_ORDER_EVALUATION


def phase_timeline():
    """{iteration: {phase: {"start": ts, "end": ts}}}, plus the newest iteration."""
    lg = f"{ORCH}/loop.log"
    if not os.path.exists(lg):
        return {}, None
    it_re = re.compile(r"^(\S+ \S+ \S+)\s+─+ iteration (\d+) ─+")
    ev_re = re.compile(
        r"^(\S+ \S+ \S+)\s+(BUILD|RAILS|MEASURE|REVIEW|SCORE|CHAT|DEPLOY)\s+iter=(\d+)\s+(.*)$")
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
            d0 = out.setdefault(it, {})
            d0.setdefault("_started", ts(m.group(1)))
            # Bank every open span before the new attempt begins, so nothing is lost
            # and nothing double-counts the gap between attempts.
            for _k, _v in d0.items():
                if isinstance(_v, dict) and _v.get("start") and _v.get("end"):
                    _v["acc"] = _v.get("acc", 0) + (_v["end"] - _v["start"])
                    _v.pop("start", None); _v.pop("end", None)
            continue
        m = ev_re.match(line)
        if not m:
            continue
        t, kind, it, rest = ts(m.group(1)), m.group(2), int(m.group(3)), m.group(4)
        newest = it if newest is None or it > newest else newest
        d = out.setdefault(it, {})
        if kind == "BUILD":
            ph = d.setdefault("Build & Deploy", {})
            if "exit=" in rest:
                ph["end"] = t
                ph["detail"] = rest.split("(")[0].strip()
            else:
                ph.setdefault("start", t)
        elif kind == "RAILS":
            ph = d.setdefault("Check & Measure", {})
            ph.setdefault("start", t)
            ph["detail"] = rest
            # tests= is the last rail; measure starting is what actually ends it.
            if "tests=" in rest:
                ph["end"] = t
        elif kind == "MEASURE":
            ph = d.setdefault("Check & Measure", {})
            if "started" in rest:
                ph.setdefault("start", t)
            elif "overall=" in rest:
                ph["end"] = t
                ph["detail"] = rest
        elif kind == "REVIEW":
            ph = d.setdefault("Review Capabilities", {})
            if "exit=" in rest:
                ph["end"] = t
                ph["detail"] = rest.split("(")[0].strip()
            else:
                ph.setdefault("start", t)
        elif kind == "DEPLOY":
            # Shipping is a STAGE, not a side effect. Owner, 2026-08-17: "i don't want
            # to see 'not shipped' … at which stage? you tell me." It was running at
            # the end of every iteration and appearing nowhere on a five-row panel.
            ph = d.setdefault("Build & Deploy", {})
            ph.setdefault("start", t)
            if "restarted" in rest or "HOLD" in rest or "ABORT" in rest \
                    or "already deployed" in rest or "probe" in rest:
                ph["end"] = t
                ph["detail"] = rest.split("(")[0].strip()[:60]
        elif kind == "CHAT":
            # Codex reading the 18 owner conversations before the build. Cached on the
            # archive's hash, so most iterations log "reusing" and the phase is a
            # near-instant no-op — which is correct and should still be visible as a
            # completed stage rather than a blank row.
            ph = d.setdefault("Chat Analysis", {})
            # "exit=" is the dedicated analyst finishing; the others are the cache
            # hit and the failure paths. Any of them ENDS the phase — a stage left
            # open would render as running for as long as the loop lives, which is
            # the defect that made a killed build read "Running 7m52s".
            if "exit=" in rest or "written to" in rest or "reusing" in rest \
                    or "no output" in rest or "non-zero" in rest:
                ph.setdefault("start", t)
                ph["end"] = t
                ph["detail"] = rest.split("(")[0].strip()
            else:
                ph.setdefault("start", t)
        elif kind == "SCORE":
            # Owner, 2026-08-13, on a Score row reading "—" for a completed
            # iteration: *"why nothing from grok? where it has executed this
            # part"*. Grok had run every time; the PANEL could not see it.
            #
            # Scoring moved from the standalone daemon into the loop on
            # 2026-08-12 ("SCORE STOP-SCORING present — exiting cleanly"), and
            # the loop writes `SCORE iter=N ...` into loop.log while the reader
            # below still only understood the daemon's `SCORE iteration N scored
            # and card appended` in score.log. So the row went blank for every
            # scoring after the handover and stayed blank for a day, while the
            # cards were being written the whole time.
            #
            # Both are read now — the daemon's format is kept because its old
            # entries are still the history for iterations 7-8.
            ph = d.setdefault("Capability Evaluation", {})
            if "card appended" in rest or "FAILED" in rest:
                ph["end"] = t
                ph["detail"] = rest.split("(")[0].strip()
            else:
                ph.setdefault("start", t)
    # The scoring seat ALSO wrote its own log while the daemon ran; keep reading
    # it so the older iterations still show their timings.
    sl = f"{ORCH}/score.log"
    if os.path.exists(sl):
        for line in open(sl, errors="replace"):
            m = re.match(r"^(\S+ \S+ \S+)\s+SCORE\s+iteration (\d+) (.*)$", line)
            if not m:
                continue
            t, it, rest = ts(m.group(1)), int(m.group(2)), m.group(3)
            ph = out.setdefault(it, {}).setdefault("Capability Evaluation", {})
            if "scored and card appended" in rest:
                ph["end"] = t
            elif "unscored" in rest:
                ph.setdefault("start", t)
    return out, newest


def last_stream_line(iteration, phase):
    """The newest readable line from whichever seat is working — the 'Progress'
    line. Read from the formatted stream logs the agents write as they go."""
    n = f"{iteration:02d}"
    src = {"Build & Deploy": f"{LOGS}/iter-{n}-build.log",
           "Review Capabilities": f"{LOGS}/iter-{n}-review.log",
           "Capability Evaluation": f"{LOGS}/iter-{n}-score-read.log"}.get(phase)
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
    out = {"Build & Deploy": "?", "Review Capabilities": "default", "Capability Evaluation": "?"}
    for f in sorted(glob.glob(f"{LOGS}/iter-*-build.jsonl"), key=os.path.getmtime)[-1:]:
        m = re.search(r'"model":"([a-z0-9.\-]+)"', open(f, errors="replace").read(4_000_000))
        if m:
            out["Build & Deploy"] = m.group(1)
    for f in sorted(glob.glob(f"{LOGS}/iter-*-score.log"), key=os.path.getmtime)[-1:]:
        m = re.search(r'"modelUsage":\s*\{\s*"([^"]+)"', open(f, errors="replace").read(4_000_000))
        if m:
            out["Capability Evaluation"] = m.group(1)
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
    """[(label, series, first, last)] — EVERY capability, plus BRAIN overall.

    Previously only movers were listed and the rest were summarised in one line.
    That hid the answer to the question the panel exists to answer once movement
    stopped: with nothing moving the table collapsed to a single row. A flat row is
    itself the finding, so all nine are listed; `flat` is still returned for the
    summary line."""
    scp = os.path.join(STATE, "capability_scorecard.json")
    if not os.path.exists(scp):
        return [], [], []
    try:
        d = json.load(open(scp))
    except Exception:
        return [], [], []
    hist = d.get("history", [])
    # One point per iteration — the last entry for that iteration wins, because a
    # recalibration appends a second row for an iteration already recorded.
    per_iter = {}
    for h in hist:
        snap = h.get("snapshot")
        if snap:
            per_iter[h["iteration"]] = snap
    # Owner, 2026-08-18: "show last 10 iterations data in this graph". Thirteen
    # columns already overflowed the card, and the older ones are the ones a decision
    # can no longer affect.
    iters = sorted(per_iter)[-10:]
    if len(iters) < 2:
        return [], [], []
    names = [c["name"] for c in d["capabilities"]]
    moved, flat = [], []
    for nm in names:
        series = [next((c["nexeo"] for c in per_iter[i] if c["name"] == nm), None)
                  for i in iters]
        real = [v for v in series if v is not None]
        if not real:
            continue
        if real[0] == real[-1] and len(set(real)) == 1:
            flat.append(nm)          # still reported, for the one-line summary
        moved.append((nm, series, real[0], real[-1]))
    overall = [round(sum(c["nexeo"] for c in per_iter[i]) / len(per_iter[i]), 1)
               for i in iters]
    moved.append(("BRAIN overall", overall, overall[0], overall[-1]))
    return moved, flat, iters



def iteration_timings(limit=10):
    """[{iteration, total, stages:{name: seconds}}] for the last `limit` iterations.

    Owner, 2026-08-17: "total time of iteration and also time of each stage."
    Built from the SAME phase_timeline the phase rows use, so the trend and the bars
    can never disagree — one derivation, two renderings.

    `total` is wall-clock from the earliest stage start to the latest stage end, NOT
    the sum of the stages. Stages can overlap (the display supports it deliberately)
    and summing overlapping spans would report more time than actually elapsed.
    """
    tl, _ = phase_timeline()
    out = []
    for it in sorted(tl)[-limit:]:
        d = tl[it]
        stages, starts, ends = {}, [], []
        for name in PHASE_ORDER:
            ph = d.get(name) or {}
            st, en = ph.get("start"), ph.get("end")
            if st is not None:
                starts.append(st)
            if en is not None:
                ends.append(en)
            stages[name] = round(en - st) if (st is not None and en is not None) else None
        total = round(max(ends) - min(starts)) if starts and ends else None
        out.append({"iteration": it, "total": total, "stages": stages})
    return out



def observed_gaps(top=6):
    """{capability:[...], chat:[...]} — the two evidence sources, side by side.

    Owner, 2026-08-17: replace the BRAIN overall graph with "capability gap observed
    and chat log gaps/bugs/issue observed, in bullet form, very least text."

    They are deliberately kept apart. The capability list is Grok READING CODE; the
    chat list is what actually happened to the owner. They disagree — the code-read
    gaps are Simple & Smart and Self-Healing, while the chats are dominated by
    fabrication and the WhatsApp path — and showing them in one merged ranking would
    hide exactly that disagreement.
    """
    out = {"capability": [], "chat": []}
    scp = os.path.join(STATE, "capability_scorecard.json")
    if os.path.exists(scp):
        try:
            caps = json.load(open(scp))["capabilities"]
            rows = sorted(caps, key=lambda c: (c.get("professional") or 0) - (c.get("nexeo") or 0),
                          reverse=True)[:top]
            out["capability"] = [
                {"name": c["name"], "nexeo": c.get("nexeo"),
                 "gap": (c.get("professional") or 0) - (c.get("nexeo") or 0),
                 "basis": c.get("basis")} for c in rows]
        except Exception:
            pass
    # Symptom tags the OWNER reported, counted from the archive itself. Not a summary
    # anybody wrote — the tags are the unit of recurrence this project already uses.
    arc = os.path.join(ROOT_DOCS, "brain_chat_archive.md")
    if os.path.exists(arc):
        try:
            txt = open(arc, errors="replace").read()
            # COUNT DISTINCT CHATS, not raw mentions. Counting every backticked
            # occurrence double-counted tags that appear in the file's own summary
            # tables as well as in the chat entry — capability-fabrication read 5 when
            # the owner had reported it in 3 conversations. "How many times did this
            # happen to me" is the question; mentions in a summary are not occurrences.
            sections = re.split(r"^## Chat ", txt, flags=re.M)[1:]
            counts = {}
            for sec in sections:
                for t in set(re.findall(r"`([a-z][a-z0-9-]{6,})`", sec)):
                    counts[t] = counts.get(t, 0) + 1
            # SHIPPED STATE PER TAG. Owner, 2026-08-17: "strike out the item in chat
            # log reported which is built and shipped."
            #
            # The link has to be made somewhere, and today it does not exist: the
            # archive is keyed by symptom tag, the change log by DEF id, and only one
            # of six tags appears in the change log at all. So this matches the tag
            # against COMMIT MESSAGES, and requires the builder to name the tag it
            # closed (build.md now demands it). Until a fix names its tag, the item
            # stays on the list — an unmatched tag is never struck, because telling
            # the owner something is fixed when it is not is the worse error.
            import subprocess
            try:
                log = subprocess.run(["git", "-C", "/var/www/tmcai", "log",
                                      "--format=%ct|%s%n%b", "-200"],
                                     capture_output=True, text=True, timeout=8).stdout
            except Exception:
                log = ""
            try:
                deployed_at = os.path.getmtime("/var/www/tmcai/server/dist/server.js")
            except Exception:
                deployed_at = 0
            # TWO VOCABULARIES, ONE CONCEPT. The archive says `capability-fabrication`;
            # the recurrence table and every commit say `fabricated-status`. Same
            # defect, different string — so the deck showed all six as open while the
            # builder had shipped 16 fixes naming `fabricated-status`, 14 naming
            # `protection-with-two-implementations` and 13 naming
            # `guard-destroys-the-answer`. The chat log was never ignored; the match
            # was.
            #
            # The alias map is not hand-written. Codex's analysis lists BOTH names
            # inside the same root-cause item — "`stale-contact-data` lineage … related
            # to `protection-with-two-implementations`" — so every tag mentioned in one
            # item is treated as an alias of the others. Using the analyst's own output
            # means the map updates itself when it re-analyses, rather than rotting in
            # a constant here.
            # ONE SEED PAIR, and only one, because it is the only equivalence the
            # ARCHIVE itself evidences: the chats tagged `capability-fabrication` are
            # the same events the recurrence table tracks as `fabricated-status`, and
            # the archive lists `send-fabrication:email` inside those very chats. The
            # builder has shipped 16 fixes naming `fabricated-status`.
            # Everything else is left to the analyst. Inventing equivalences here would
            # strike defects off the owner's list on my guess about what two words mean,
            # which is exactly the kind of quiet false "fixed" this deck must not print.
            aliases = {
                "capability-fabrication": {"capability-fabrication", "fabricated-status",
                                           "send-fabrication"},
                "fabricated-status": {"fabricated-status", "capability-fabrication"},
            }
            try:
                roots = open(os.path.join(STATE, "chat-root-causes.md"),
                             errors="replace").read()
                # Split on the numbered root causes, then group tags within each item.
                for item in re.split(r"\n(?=\d+\.\s+\*\*)", roots):
                    group = set(re.findall(r"`([a-z][a-z0-9:-]{6,})`", item))
                    for t in group:
                        aliases.setdefault(t, set()).update(group)
                        aliases[t].add(t)
            except Exception:
                pass
            shipped_tags = set()
            built_tags = set()
            for chunk in log.split("\n"):
                if "|" not in chunk:
                    continue
                ts, _, msg = chunk.partition("|")
                if not ts.strip().isdigit():
                    continue
                for t in counts:
                    # The tag itself OR any alias the analyst grouped with it.
                    names = aliases.get(t, {t}) | {t}
                    if any(a in msg for a in names):
                        built_tags.add(t)
                        if deployed_at and int(ts) <= deployed_at:
                            shipped_tags.add(t)
            out["chat"] = [{"tag": k, "times": v,
                            "state": ("shipped" if k in shipped_tags
                                      else "built" if k in built_tags else "open")}
                           for k, v in sorted(counts.items(), key=lambda kv: -kv[1])[:top]]
        except Exception:
            pass
    return out



def upgrade_feed(limit=8):
    """[{def_id, title, at, iteration, verdict, shipped}] — newest first.

    Owner, 2026-08-17: "in replace of Brain Overall we need to build Upgrade News Feed
    iteration wise."

    Built from DURABLE sources — git commits, review_log.md, and the deployed SHA —
    not from loop.log, which is archived on every reset and would empty the feed
    exactly when the history matters most.

    `shipped` is the field that carries the meaning. Five DEF fixes sat on the branch
    for a day scoring zero capability, because Grok credits only what reaches the
    owner. A feed that listed them as upgrades without saying whether they SHIPPED
    would repeat that error in a nicer format.
    """
    import subprocess
    try:
        raw = subprocess.run(
            ["git", "-C", "/var/www/tmcai", "log", "--format=%h|%ct|%s", "-40"],
            capture_output=True, text=True, timeout=8).stdout
    except Exception:
        return []
    # Which commit is actually deployed: the last line of deploy-history, else the
    # running dist. Anything newer than it is built-but-not-shipped.
    shipped_sha = ""
    try:
        dh = os.path.join(STATE, "deploy-history")
        if os.path.exists(dh):
            lines = [l for l in open(dh).read().splitlines() if l.strip()]
            if lines:
                shipped_sha = lines[-1].split()[-1]
    except Exception:
        pass
    verdicts = {}
    rl = f"{ORCH}/review_log.md"
    if os.path.exists(rl):
        cur = None
        for line in open(rl, errors="replace"):
            m = re.match(r"^## Iteration (\d+)", line)
            if m:
                cur = int(m.group(1)); continue
            v = re.search(r"\*\*(SOUND|WEAK|WRONG)\*\*", line)
            if v and cur is not None and cur not in verdicts:
                verdicts[cur] = v.group(1)
    # SHIPPED is decided by the ARTIFACT'S OWN TIMESTAMP, not by deploy-history.
    # The 2026-08-17 12:41 deploy was run by hand — unlock, build, manifest, relock,
    # pm2 restart — so deploy-history never recorded it and every commit since would
    # have been reported as unshipped. What is running is the only authority on what
    # shipped, and dist/server.js is written by the build that produced it.
    deployed_at = 0
    try:
        deployed_at = os.path.getmtime("/var/www/tmcai/server/dist/server.js")
    except Exception:
        pass
    out, seen_def = [], set()
    for line in raw.splitlines():
        parts = line.split("|", 2)
        if len(parts) != 3:
            continue
        sha, ct, subj = parts
        m = re.match(r"(DEF-\d+)(?: docs)?[:\s]", subj)
        if not m:
            continue
        it = re.search(r"Iteration (\d+)", subj)
        # One row per DEF. Each fix lands as a code commit and a docs commit; two
        # rows for one upgrade reads as twice the progress.
        if m.group(1) in seen_def:
            continue
        seen_def.add(m.group(1))
        out.append({
            "sha": sha, "def_id": m.group(1),
            "title": subj.split(":", 1)[-1].strip()[:90],
            "at": int(ct),
            "iteration": int(it.group(1)) if it else None,
            "verdict": verdicts.get(int(it.group(1))) if it else None,
            "shipped": bool(deployed_at and int(ct) <= deployed_at),
        })
        if len(out) >= limit:
            break
    return out



def _iteration_banner_times(it):
    """Every start time recorded for `it` — one per attempt."""
    lg = f"{ORCH}/loop.log"
    if not os.path.exists(lg):
        return []
    out = []
    rx = re.compile(r"^(\S+ \S+ \S+)\s+─+ iteration (\d+) ─+")
    for line in open(lg, errors="replace"):
        m = rx.match(line)
        if m and int(m.group(2)) == it:
            try:
                out.append(calendar.timegm(
                    time.strptime(m.group(1).rsplit(" ", 1)[0], "%Y-%m-%d %H:%M:%S")))
            except Exception:
                pass
    return out


def attempts_this_iteration(it):
    return len(_iteration_banner_times(it)) or 1


def first_attempt_start(it):
    ts = _iteration_banner_times(it)
    return ts[0] if ts else None



# Which raw event stream belongs to which phase row. The scorer writes a .log rather
# than a .jsonl, so both extensions are tried.
_STAGE_STREAMS = {
    "Capability Evaluation": ["iter-{n}-score.log", "iter-{n}-score-read.log"],
    "Chat Analysis":         ["iter-{n}-chat.jsonl"],
    "Build & Deploy":        ["iter-{n}-build.jsonl"],
    "Review Capabilities":   ["iter-{n}-review.jsonl"],
}


def _usage_from(path):
    """Tokens for one stage, from the LAST usage object in its stream.

    Owner, 2026-08-18: "record input and output tokens of each stage and total tokens
    of each iteration."

    The LAST object, not a sum of all of them: each assistant message reports the
    running total for the turn, so adding them counts the same prompt once per message
    and inflates a 25k-output turn into millions. Verified against iter-20-build.jsonl,
    where the final object reads input 49 / cache_read 18,828,571 / output 25,085.

    cache_read is reported separately and deliberately kept separate — it is the cheap
    part, and folding it into `input` would hide the fact that nearly all input on this
    loop is cache hits rather than fresh prompt.
    """
    out = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    if not os.path.exists(path):
        return None
    # THE `result` EVENT, not the last usage object. Each assistant message reports its
    # own usage, and the final message is often tiny — reading "the last one" gave
    # input 2 / output 1 for a turn that actually cost 25,085 output tokens and $17.54.
    # The result event is the turn's own total and carries total_cost_usd with it.
    last, cost = None, None
    try:
        for line in reversed(open(path, errors="replace").read().splitlines()):
            if '"type":"result"' in line:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                u = d.get("usage") or {}
                if u:
                    last = u
                    cost = d.get("total_cost_usd")
                    break
    except Exception:
        return None
    if not last:
        return None
    def g(key):
        v = last.get(key)
        return int(v) if isinstance(v, (int, float)) else 0
    out["input"] = g("input_tokens")
    out["output"] = g("output_tokens")
    out["cache_read"] = g("cache_read_input_tokens")
    out["cache_write"] = g("cache_creation_input_tokens")
    out["cost_usd"] = round(cost, 2) if isinstance(cost, (int, float)) else None
    return out


def stage_tokens(it):
    """{phase: {input, output, cache_read, cache_write}} plus a `_total` row."""
    n = f"{it:02d}"
    rows, total = {}, {"input": 0, "output": 0, "cache_read": 0,
                      "cache_write": 0, "cost_usd": 0.0}
    for phase, names in _STAGE_STREAMS.items():
        for nm in names:
            u = _usage_from(os.path.join(LOGS, nm.format(n=n)))
            if u:
                rows[phase] = u
                for k in total:
                    v = u.get(k) or 0
                    total[k] = round(total[k] + v, 2) if k == "cost_usd" else total[k] + v
                break
    rows["_total"] = total
    return rows



def pulse_labels():
    """{iteration: "C3"|"N2"} from the pulse ledger.

    Owner, 2026-08-18: "trend conversational healing 1, 2, 3 and night build heal 1, 2,
    3." C = conversational (a new conversation arrived), N = night (the full evaluation).

    Only pulses that actually ran appear. A conversational pulse skips Capability
    Evaluation, so it produces no card and no trend column — and its numbers are NOT
    carried forward to fake one, because a column of last-night's scores under a C label
    would say a conversational pulse measured something it never measured.
    """
    out = {}
    path = os.path.join(STATE, "pulse-ledger.jsonl")
    if not os.path.exists(path):
        return out
    try:
        for line in open(path, errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            it = d.get("iteration")
            if it is None:
                continue
            prefix = "C" if d.get("kind") == "conversational" else "N"
            # Last writer wins: a repeated iteration means a later pulse reused the
            # number, and the newest label is the one that describes the card on disk.
            out[int(it)] = f"{prefix}{d.get('kind_n') or '?'}"
    except Exception:
        pass
    return out



def next_pulses(now_ts):
    """When the next pulse of each kind is due, from the crontab that actually runs them.

    Owner, 2026-08-18: "idle is nothing … mean waiting for next Cron etc." Between pulses
    nothing is broken and nothing is stalled — the system is waiting for a known event at
    a knowable time, and "IDLE" said none of that.

    Read from `crontab -l` rather than hard-coded here: a schedule in two places drifts,
    and the deck would then confidently announce a time nothing was going to happen at.
    """
    import subprocess
    out = {"conversational_in_s": None, "night_in_s": None, "night_at": None}
    try:
        tab = subprocess.run(["crontab", "-l"], capture_output=True, text=True,
                             timeout=5).stdout
    except Exception:
        return out
    for line in tab.splitlines():
        line = line.strip()
        if line.startswith("#") or not line:
            continue
        if "watch-conversations.sh" in line:
            m = re.match(r"\*/(\d+)\s", line)
            if m:
                every = int(m.group(1)) * 60
                out["conversational_in_s"] = every - (int(now_ts) % every)
        elif "nightly-iteration.sh" in line:
            f = line.split()
            if len(f) >= 2 and f[0].isdigit() and f[1].isdigit():
                minute, hour = int(f[0]), int(f[1])
                t = time.gmtime(now_ts)
                due = calendar.timegm((t.tm_year, t.tm_mon, t.tm_mday, hour, minute, 0,
                                       0, 0, 0))
                if due <= now_ts:
                    due += 86400
                out["night_in_s"] = int(due - now_ts)
                out["night_at"] = f"{hour:02d}:{minute:02d} UTC"
    return out


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
        # WHAT THE NUMBERS MEAN, stated rather than left to a chart's shape.
        #
        # Owner, 2026-08-13, on the Deck's BRAIN OVERALL panel: *"I couldnt
        # understand this make it meaningfull for me"*. The panel auto-scaled its
        # y-axis to the data range (46.7-47.3), so a 0.6-point gain filled the
        # whole height and read as a steep climb. It was showing 1.5% of the
        # journey as if it were most of it.
        #
        # `axis` therefore recommends 0-100 with the objective and professional
        # lines included: on that scale the same series is visibly near-flat and
        # forty points short, which is the truth. A dashboard that flatters the
        # work is worse than no dashboard, because it removes the reason to change
        # approach — and this loop has already spent fourteen iterations inside the
        # benchmark's own noise.
        "interpretation": (lambda first, last, objective: {
            "movement": round(last - first, 1),
            "remaining": round(objective - last, 1),
            "journey_complete_pct": (round((last - first) / (objective - first) * 100, 1)
                                     if objective > first else None),
            "rate_per_iteration": (round((last - first) / max(1, len(points) - 1), 3)),
            "iterations_at_this_rate": (
                int((objective - last) / ((last - first) / max(1, len(points) - 1)))
                if last > first else None),
            "capabilities_moved": sum(1 for x in series if x["moved"]),
            "capabilities_flat": sum(1 for x in series if not x["moved"]),
            "headline": (
                f"{round(last - first, 1):+} across {len(points)} scored iterations, "
                f"{round(objective - last, 1)} still to cover — "
                f"{round((last - first) / (objective - first) * 100, 1)}% of the way. "
                f"{sum(1 for x in series if x['moved'])} of {len(series)} capabilities "
                f"have ever moved."),
        })(overalls[0] if overalls else 0, overalls[-1] if overalls else 0,
           round(sum(v * 0.95 for v in pro.values()) / len(pro), 1) if pro else 0),
        "axis": {
            "recommended_min": 0, "recommended_max": 100,
            "objective_line": round(sum(v * 0.95 for v in pro.values()) / len(pro), 1) if pro else None,
            "professional_line": round(sum(pro.values()) / len(pro), 1) if pro else None,
            "why": "Auto-scaling to the data range (46.7-47.3) renders a 0.6-point "
                   "gain as a full-height climb. Draw 0-100 with the objective line "
                   "so the 40-point gap is visible; the shape should look flat, "
                   "because it is.",
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
    # Refreshed here, before anything reads it: a conversational pulse draws two
    # stage rows and an evaluation pulse draws five, and the mode can change between
    # two frames of the same live deck.
    global PHASE_ORDER
    PHASE_ORDER = _phase_order()
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
    stage_to_phase = {"BUILDING": "Build & Deploy", "CHECKS": "Check & Measure",
                      "MEASURING": "Check & Measure",
                      "REVIEWING": "Review Capabilities",
                      "SCORING": "Capability Evaluation"}
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

    seat = {"Build & Deploy": "Claude -> production", "Checks": "orchestrator",
            "Check & Measure": "orchestrator", "Chat Analysis": "Claude",
            "Review Capabilities": "Claude",
            "Capability Evaluation": "Grok"}
    models = seat_models()
    phase_rows = []
    for ph in PHASE_ORDER:
        p_ = phases.get(ph, {})
        s_, e_ = p_.get("start"), p_.get("end")
        _acc = p_.get("acc", 0)
        running = bool(s_ and not e_ and loop_alive and cur_it == newest) \
            or ph == current
        if running:
            # MORE THAN ONE PHASE CAN BE RUNNING. Measure and Review overlap by
            # design — the benchmark was moved to run alongside the review so the
            # two agents go back-to-back — and the first version of this display
            # marked only one as current, painting the other red as "no completion
            # recorded". A concurrent phase must not render as an abandoned one.
            state, dur = "running", _acc + (now - (s_ or (now - elapsed)))
        elif s_ and e_:
            state, dur = "done", _acc + (e_ - s_)
        elif _acc and not s_:
            # Banked time with no open span: the stage ran in an earlier attempt of
            # this same iteration and has not been re-entered yet. It is DONE for the
            # iteration, and its time stands — that is the owner's rule, that time is
            # never reset within an iteration.
            state, dur = "done", _acc
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

    # ── WHAT GROK ACTUALLY SAID, not just the number it landed on ──────────────
    # Owner, 2026-08-14, of the Brain Evolution dashboard: *"dashboard will remain
    # same where information should be provided by the grok by either means"*.
    #
    # The deck was showing Grok's NUMBERS and none of Grok's FINDINGS — and its
    # largest figure (the 94.9 benchmark) is not Grok's at all, which is how a
    # page can read 94.9 while capability sits at 50.3. So the scorer's own words
    # travel with its numbers now: what moved, what did not, and what it says it
    # could not verify. `basis` comes from the evidence line Grok writes for each
    # capability ("[code-read/high]"), because a figure derived from reading source
    # and a figure derived from production evidence must not look identical on a
    # dashboard.
    grok = None
    if os.path.exists(scp):
        try:
            gd = json.load(open(scp))
        except Exception:
            gd = None
        hist = (gd or {}).get("history") or []
        if hist:
            last = hist[-1]
            ev = last.get("evidence") or []
            # NOT `basis` — that name is already taken in this scope for the
            # STAGE's timer source ("process"/"log"), which the Deck renders as
            # text. Shadowing it replaced that string with this dict and the panel
            # died on React error #31, "objects are not valid as a React child",
            # taking the whole page down with it. Verified with a headless load
            # against the real payload, not reasoned about.
            cap_basis = {}
            for line in ev:
                m = re.match(r"\s*(.+?)\s*[+-]\d+.*?\[([a-z-]+)/([a-z]+)\]", str(line))
                if m:
                    cap_basis[m.group(1).strip()] = {"basis": m.group(2), "confidence": m.group(3)}
            for c in caps:
                b = cap_basis.get(c["name"])
                if b:
                    c["basis"] = b["basis"]
                    c["confidence"] = b["confidence"]
            grok = {
                "iteration": last.get("iteration"),
                "verdict": last.get("verdict"),
                "movement": last.get("movement"),
                "scored_by": last.get("scored_by"),
                "attribution": last.get("movement_attribution"),
                "what_moved": last.get("what_moved"),
                "what_did_not": last.get("what_did_not"),
                "unverifiable": last.get("unverifiable"),
                # How many of the nine rest on reading code rather than evidence
                # from production. This is the number that says how much of the
                # capability picture is inference.
                "code_read": sum(1 for c in caps if c.get("basis") == "code-read"),
                "total": len(caps),
            }

    moved, flat, iters = capability_trend()
    _lbl = pulse_labels()
    trend = {"iterations": list(iters),
             "labels": [_lbl.get(i, f"#{i}") for i in iters],
             "unmoved": flat, "rows": [
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
            # `iteration` is where the number was MEASURED, which is not where the
            # loop is. The panel headed "BENCHMARK · ITERATION 18" while iteration
            # 20 was building, which reads as a stalled loop rather than as a
            # figure that is simply older than the current turn.
            "measured_at_iteration": latest_iter,
            "stale": bool(cur_it and latest_iter and cur_it != latest_iter),
            "stale_by": (cur_it - latest_iter) if (cur_it and latest_iter) else 0,
        }

    return {
        "now": now, "pkt_offset": PKT_OFFSET,
        "stage": {"name": stage, "elapsed": elapsed, "basis": basis,
                  "detail": detail},
        "loop_alive": loop_alive,
        "iteration": cur_it, "iteration_started": started,
        # TOTAL FOR THIS ATTEMPT. Falls back to `now` whenever ANY stage is still
        # open, not only when none has ended — the first version took the last END,
        # so a turn six minutes in showed 3m07s because the running Build had no end
        # yet and Capability Evaluation's end was the newest timestamp available.
        # THE ITERATION'S OWN CLOCK, from its FIRST attempt to now. Never reset by a
        # re-run — owner's rule. An iteration that has been attempted five times has
        # cost all five, and that is the number that says what the hold is spending.
        "iteration_total": ((now - first_attempt_start(cur_it))
                            if first_attempt_start(cur_it) else
                            ((now - started) if started else None)),
        # AND THE ATTEMPTS BEFORE IT. Owner, 2026-08-17: "where the previous has gone?"
        # The counter now holds until BRAIN overall rises, so one iteration can be
        # attempted many times — iteration 2 has begun five. Resetting the phase rows
        # per attempt made each turn readable but hid the cost of the whole iteration,
        # which is the number that says what the hold is actually spending.
        "iteration_attempts": attempts_this_iteration(cur_it),
        "pulse_elapsed": (
            None if not started or not loop_alive else
            ((now if any(isinstance(p, dict) and p.get("start") and not p.get("end")
                         for p in phases.values())
              else max([p["end"] for p in phases.values()
                        if isinstance(p, dict) and p.get("end")] or [now])) - started)),
        # Owner, 2026-08-17: "the ideal time of an iteration should be 30min-40min to
        # complete end to end with improvement … no iteration should stuck in any loop
        # or move around the circle." The budget is shown so circling is VISIBLE rather
        # than inferred from a total nobody is comparing against anything.
        "iteration_budget_s": 2400,
        "pulse_mode": pulse_mode(),
        "stage_tokens": stage_tokens(cur_it),
        "iteration_elapsed_all": (first_attempt_start(cur_it) and
                                  now - first_attempt_start(cur_it)) or None,
        "iterations_built": built, "iteration_in_flight": in_flight,
        "current_phase": current, "phases": phase_rows,
        "progress": last_stream_line(cur_it, current) if current else "",
        "capabilities": caps, "brain": brain, "trend": trend, "grok": grok,
        "benchmark": bench,
        # The rich per-iteration record the Deck monitors. `history` below is kept
        # unchanged so the existing panel does not break — additive, not a rename.
        "iterations": iteration_records(),
        "campaign": campaign_snapshot(),
        "capability_series": capability_series(),
        "iteration_timings": iteration_timings(),
        "observed": observed_gaps(),
        "upgrade_feed": upgrade_feed(),
        "history": history_rows(sc, vd, cur_it),
    }


def history_rows(sc, vd, cur_it, want=6):
    """The last `want` ITERATIONS, not the last `want` MEASUREMENTS.

    The owner, 2026-08-13, looking at a panel showing #13-#18 while the loop was
    on #20: *"this should show me last 6 iterations data"*.

    It was keyed to score files. Iterations 19 and 20 produced none — MEASURE is
    skipped when no `server/src` or `server/prisma` change has landed since the
    last measurement, which is correct behaviour and saves six minutes a turn —
    so those iterations were not shown as unmeasured, they were simply absent.
    A panel that omits what it cannot measure reads as a panel that has frozen,
    and the owner cannot tell those two apart from the outside.

    So every iteration up to the current one gets a row, and a row with no
    measurement of its own says WHY in `label` and carries `measured: False`.
    Numbers from an earlier iteration are never restated as if they were fresh.
    """
    by_iter = {it: (label, dd) for it, label, dd in sc}
    # The ledger knows which iterations died rather than merely going unmeasured.
    # Iteration 19 was killed mid-build to install the G26 fix; calling that
    # "reused earlier score" would be wrong in a way the owner cannot check.
    notes = {}
    try:
        for r in iteration_records():
            n = r.get("note") or ""
            if r.get("iteration") is not None:
                notes[r["iteration"]] = n
    except Exception:
        notes = {}
    if not sc and not cur_it:
        return []
    top = cur_it or max(by_iter)
    rows = []
    for it in range(max(1, top - want + 1), top + 1):
        if it in by_iter:
            label, dd = by_iter[it]
            rows.append({"iteration": it, "label": label, "measured": True,
                         "overall": dd.get("overall"),
                         "weakest": dd.get("weakestCriterionScore"),
                         "criterion": dd.get("weakestCriterion"),
                         "verdict": vd.get(it, "—")})
            continue
        # No measurement for this iteration. Say which case it is rather than
        # leaving a blank the reader has to guess at.
        if cur_it and it == cur_it:
            label = "in flight"
        elif (notes.get(it) or "").startswith("RESTART"):
            label = "aborted — loop restarted"
        elif it in vd:
            label = "no measurement — reviewed only"
        else:
            label = "no measurement — reused earlier score"
        rows.append({"iteration": it, "label": label, "measured": False,
                     "overall": None, "weakest": None, "criterion": None,
                     "verdict": vd.get(it, "—")})
    return rows


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
            word = "Building" if ph == "Build & Deploy" else "Running"
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

    # 10. PROGRESS — the delta against the previous MEASURED iteration.
    #
    # Owner, 2026-08-13, on the Deck's benchmark panel: *"i want to see iteration
    # wise progress here"*. The table showed six absolute values per row and no
    # movement, so nine rows of 95.5 / 96.2 / 95.5 read as noise with no direction.
    #
    # Deltas are computed against the previous iteration THAT HAS A BENCHMARK, not
    # against iteration n-1: iterations 9-11 have no capability card and one
    # iteration measured nothing at all, and differencing against a missing row
    # would invent movement. `since` names which iteration each delta is measured
    # from, so the Deck can say "vs #12" rather than implying "vs previous".
    measured = sorted(k for k, v in recs.items()
                      if (v.get("benchmark") or {}).get("overall") is not None)
    for idx, it in enumerate(measured):
        r = recs[it]
        b = r["benchmark"]
        prog = {"since": None, "overall_delta": None, "weakest_delta": None,
                "criteria_delta": {}, "direction": "unknown"}
        if idx > 0:
            prev_it = measured[idx - 1]
            pb = recs[prev_it]["benchmark"]
            prog["since"] = prev_it
            if b.get("overall") is not None and pb.get("overall") is not None:
                prog["overall_delta"] = round(b["overall"] - pb["overall"], 1)
            # The gating criterion is what the gate reads, so its delta is the one
            # that matters — compared on the SAME criterion, since the weakest can
            # change identity between runs and comparing C6 to C4 is meaningless.
            if b.get("weakest") and b["weakest"] == pb.get("weakest") \
                    and b.get("weakest_score") is not None \
                    and pb.get("weakest_score") is not None:
                prog["weakest_delta"] = round(b["weakest_score"] - pb["weakest_score"], 1)
                prog["weakest_comparable"] = True
            else:
                prog["weakest_comparable"] = False
            for c, v in (b.get("criteria") or {}).items():
                pv = (pb.get("criteria") or {}).get(c)
                if pv is not None and v is not None:
                    prog["criteria_delta"][c] = round(v - pv, 1)
            d_ = prog["overall_delta"]
            # A move inside the instrument's own spread is NOT progress. C4 has read
            # 90.0, 87.9, 88.3, 87.3 on barely-changed code, so ±2 is noise and
            # labelling it "up" would manufacture a trend (D-4, still open).
            if d_ is None:
                prog["direction"] = "unknown"
            elif d_ > 2:
                prog["direction"] = "up"
            elif d_ < -2:
                prog["direction"] = "down"
            else:
                prog["direction"] = "flat (within noise ±2)"
        # Capability movement for the same iteration, from the scorer — the only
        # progress figure that is not benchmark noise.
        sc = r.get("scorer") or {}
        prog["capability_overall"] = sc.get("overall")
        prog["capability_verdict"] = sc.get("verdict")
        r["progress"] = prog

    # 11. do the reviewer and the scorer AGREE? A capability raised in an iteration
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
    if "--open-symptoms" in args:
        # The owner's still-unfixed chat-log symptoms, worst first.
        #
        # Owner, 2026-08-18: "Conversational Cron (10m) should clear Chat Log gaps."
        # That makes the conversational run's job finite — work the list until it is
        # empty — and this is the SAME observed_gaps() the deck renders, exposed rather
        # than reimplemented. A second copy of the open/shipped/alias logic would be an
        # 11th `protection-with-two-implementations`, and the two would disagree the
        # first time either changed.
        for c in (observed_gaps().get("chat") or []):
            if c.get("state") != "shipped":
                print(f"{c['tag']}\t{c['times']}\t{c.get('state')}")
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
