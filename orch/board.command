#!/bin/bash
# orch/board.command — open the live orchestrator board for THIS project.
# Double-click it in Finder, or `open orch/board.command`, to get a visible Terminal
# window running the watch in --until-idle mode: it shows the pipeline while any CR is
# open, prints the consumption report(s) when every CR closes, then stops on its own.
#
# One board per project (single-instance lock). If a watch is already running, this exits
# cleanly with a note rather than opening a duplicate.
cd "$(dirname "$0")/.." || exit 1
echo "▶ Orchestrator board (auto-stops with a report when all CRs close). Ctrl-C to stop early."
exec node orchestrator.cjs --until-idle
