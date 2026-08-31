#!/usr/bin/env python3
"""
Pull the assistant's ANSWER out of a `--output-format stream-json` run log.

Both analyst seats — the ten-minute cron (run-chat-analysis.sh) and the loop's own chat stage
(nexeo-loop.sh) — moved from `--output-format text` to stream-json so their token usage and
cost become recordable at all. Under `text` there was no usage anywhere in the output, which
is why the `heal` seat has read "never measured" on the spend deck since it was built.

That trade has to be paid for here: the answer those seats depend on is now one field inside
an event stream rather than the whole file. This is the single place that unwraps it, shared
by both callers so the two can never drift apart.

THE LAST `result` EVENT WINS, matching orchestratorSpendService.parseRunLog: a stream can
carry more than one result when a turn is retried, and the final one is the run's own summary.

FAILS QUIET AND EMPTY, NEVER PARTIAL. On a truncated, absent or unparseable stream this writes
nothing and exits 0. Both callers already treat an empty answer as failure — the cron's
SIGNATURES gate rejects it and keeps the previous ranking — so emitting nothing routes into an
existing failure path. Emitting a half-parsed fragment would not: it could carry a SIGNATURES
header with a truncated table and overwrite a good ranking, which is the exact failure the
gate in run-chat-analysis.sh was written to stop.
"""
import json
import sys


def extract(path: str) -> str:
    answer = ""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    # Non-JSON lines are expected: a wrapper may interleave plain text. Skipping
                    # them is what lets this read a stream that is not purely machine output.
                    continue
                if isinstance(ev, dict) and ev.get("type") == "result" and isinstance(ev.get("result"), str):
                    answer = ev["result"]
    except OSError:
        return ""
    return answer


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(0)
    sys.stdout.write(extract(sys.argv[1]))
