#!/usr/bin/env python3
"""
format-stream.py — turn Claude's `--output-format stream-json` into a live,
human-readable build log.

Owner, 2026-08-11: *"i am unable to see it running in session"*.

The cause was not headlessness alone. `claude -p` with the default output format
buffers the WHOLE turn and flushes at the end, so `iter-01-build.log` sat at 0
bytes for twelve minutes while real work was happening. There was nothing to
tail, so a working loop was indistinguishable from a hung one — the same
false-silence problem the evaluation chart records for the health probes.

This reads the JSON event stream on stdin and writes one readable line per event
as it arrives, so `tail -f` shows the Builder thinking, calling tools and editing
files in real time. The RAW stream is preserved separately by the caller (tee),
because a formatter is a lossy view and the raw events are the evidence.

Flushing is per line and unconditional: a formatter that buffers reintroduces
exactly the bug it exists to fix.

Usage:
    ... | format-stream.py            # readable lines on stdout
    ... | format-stream.py --prefix   # with an elapsed-seconds prefix
"""
import json
import sys
import time

MAX = 220  # keep one event to one terminal line; the raw jsonl holds everything


def clip(s, n=MAX):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


def tool_summary(name, inp):
    """Name the tool AND its target. 'Edit' alone tells you nothing about what
    the Builder is doing; 'Edit brainComposer.ts' tells you everything."""
    if not isinstance(inp, dict):
        return name
    for key in ("file_path", "path", "notebook_path"):
        if key in inp:
            return f"{name} {str(inp[key]).split('/')[-1]}"
    if "command" in inp:
        return f"{name} $ {clip(inp['command'], 120)}"
    if "pattern" in inp:
        return f"{name} /{clip(inp['pattern'], 60)}/"
    if "prompt" in inp:
        return f"{name} {clip(inp['prompt'], 100)}"
    return name


def codex_event(ev, emit):
    """Codex speaks a different dialect from Claude, and the owner asked to watch
    BOTH seats. Handled here rather than in a second script so the two live views
    read identically — a reviewer's tool call should look like a builder's tool
    call when you are watching the loop work.

    Shapes (codex-cli 0.147.0): thread.started · turn.started ·
    item.started/item.completed carrying item.type in
    {agent_message, reasoning, command_execution, file_change, …} · turn.completed.
    Returns True if the event was recognised as Codex's.
    """
    kind = ev.get("type", "")
    if not (kind.startswith("thread.") or kind.startswith("turn.")
            or kind.startswith("item.")):
        return False

    if kind == "thread.started":
        emit(f"── codex thread {ev.get('thread_id', '?')}")
    elif kind == "turn.started":
        emit("── turn started")
    elif kind == "turn.completed":
        u = ev.get("usage", {}) or {}
        emit(f"── turn completed  in={u.get('input_tokens', '?')} "
             f"cached={u.get('cached_input_tokens', '?')} "
             f"out={u.get('output_tokens', '?')} "
             f"reasoning={u.get('reasoning_output_tokens', '?')}")
    elif kind == "turn.failed":
        # Must be visible: a failed review turn means the loop got no directive.
        emit(f"── TURN FAILED {clip(ev.get('error', ev), 300)}")
    elif kind in ("item.started", "item.completed"):
        item = ev.get("item", {}) or {}
        itype = item.get("type", "?")
        done = kind == "item.completed"
        if itype == "agent_message":
            if done and item.get("text", "").strip():
                emit(f"  {clip(item['text'])}")
        elif itype == "reasoning":
            if done and (item.get("text") or item.get("summary")):
                emit(f"  ~ {clip(item.get('text') or item.get('summary'))}")
        elif itype == "command_execution":
            if done:
                # Exit status included: a review that ran a failing command and
                # carried on regardless is something the log must show.
                emit(f"  ← exit={item.get('exit_code', '?')} "
                     f"{clip(item.get('aggregated_output') or '', 140)}")
            else:
                emit(f"  → $ {clip(item.get('command', '?'), 140)}")
        elif itype == "file_change":
            # Codex is write-restricted to the review log; anything else it edits
            # is a boundary violation and needs to be loud, not buried.
            emit(f"  {'←' if done else '→'} FILE CHANGE {clip(item.get('changes') or item, 160)}")
        elif done:
            emit(f"  · {itype} {clip(item.get('text') or '', 120)}")
    return True


def main():
    prefix = "--prefix" in sys.argv
    t0 = time.time()

    def emit(line):
        stamp = f"[{int(time.time() - t0):>5}s] " if prefix else ""
        sys.stdout.write(stamp + line + "\n")
        sys.stdout.flush()  # never buffer — see the docstring

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            ev = json.loads(raw)
        except Exception:
            # Not JSON: pass it through rather than swallow it. A crash message
            # on stderr merged into this stream is exactly what must not be lost.
            emit(f"· {clip(raw)}")
            continue

        kind = ev.get("type")

        # Codex's dialect first — its `item.*` / `turn.*` names do not collide
        # with Claude's, so the two are distinguishable without a mode flag.
        if codex_event(ev, emit):
            continue

        if kind == "system" and ev.get("subtype") == "init":
            emit(f"── session {ev.get('session_id', '?')}  model={ev.get('model', '?')}  "
                 f"perms={ev.get('permissionMode', '?')}")
        elif kind == "assistant":
            for block in ev.get("message", {}).get("content", []) or []:
                btype = block.get("type")
                if btype == "text" and block.get("text", "").strip():
                    emit(f"  {clip(block['text'])}")
                elif btype == "thinking" and block.get("thinking", "").strip():
                    emit(f"  ~ {clip(block['thinking'])}")
                elif btype == "tool_use":
                    emit(f"  → {tool_summary(block.get('name', '?'), block.get('input'))}")
        elif kind == "user":
            for block in ev.get("message", {}).get("content", []) or []:
                if block.get("type") == "tool_result":
                    body = block.get("content")
                    if isinstance(body, list):
                        body = " ".join(
                            b.get("text", "") for b in body if isinstance(b, dict))
                    flag = "ERR" if block.get("is_error") else "ok"
                    emit(f"  ← {flag} {clip(body, 160)}")
        elif kind == "result":
            # The turn's own verdict. Reported whether or not it succeeded —
            # a formatter that prints only successes is a false-green machine.
            emit(f"── result {ev.get('subtype', '?')}  error={ev.get('is_error')}  "
                 f"turns={ev.get('num_turns', '?')}  {ev.get('duration_ms', '?')}ms  "
                 f"cost=${ev.get('total_cost_usd', 0):.4f}")
            if ev.get("permission_denials"):
                # A denied tool call means the turn silently did less than it
                # thinks it did — the loop must be able to see that.
                emit(f"── PERMISSION DENIALS: {clip(ev['permission_denials'], 300)}")
        elif kind == "rate_limit_event":
            info = ev.get("rate_limit_info", {}) or {}
            if info.get("status") != "allowed":
                emit(f"── RATE LIMIT {info.get('status')} type={info.get('rateLimitType')} "
                     f"resetsAt={info.get('resetsAt')}")
        elif kind == "error":
            emit(f"── ERROR {clip(ev)}")


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pass
    except KeyboardInterrupt:
        pass
