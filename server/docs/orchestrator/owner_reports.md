# Owner reports — live issues from the owner, into the loop

**This file is the intake point.** The owner talks to the live Brain all day; when
he sees something wrong, it lands here and the loop picks it up at the **next
build turn** (directives are read as step 0 of every iteration, and D-6 makes
unprocessed reports outrank everything else in the queue).

## How to file (owner)

Append a block at the bottom — any of these work:

- **Paste the WhatsApp thread** (or the fragment) and one line on what was wrong.
- Or just describe it: what you asked, what Brain said, what you expected.
- Timestamps help; screenshots' text pasted is fine; Roman Urdu is fine.

You can also simply tell the orchestrator in conversation, and it will file the
block here for you, quoted verbatim.

Format (loose — the Builder normalises it into the governing docs):

```
## R-<next number> · <date time> · UNPROCESSED
<what happened, pasted thread, expectation — anything>
```

## What the Builder must do with a report (per CLAUDE.md rules 1–2)

1. **Log first, same turn**: a `CL-NNN` row in `brain_chat_log.md` (what was
   OBSERVED, owner's side, before diagnosis — and what went RIGHT), and a
   `DEF-NNN` per distinct observation in `brain_change_log.md`.
2. Check chart §3 **before coding**: recurring symptom tag ⇒ structural fix
   required, never another patch on the instance.
3. Fix it in that turn if it fits the one-coherent-change rule; otherwise leave
   the DEF row OPEN with a written reason — never silently defer.
4. Mark the report `PROCESSED → CL-NNN / DEF-NNN` here, in place. Never delete a
   report; this file is part of the audit trail.

## Latency, stated honestly

Reports merge at **iteration boundaries** — worst case ~30 minutes while a build
turn is mid-flight. Injecting mid-turn would corrupt the iteration's attribution,
which is what the whole loop protects. If something is urgent (Brain actively
misbehaving with a counterpart), tell the orchestrator directly: it can stop the
loop after the current phase and put the report first.

---

<!-- reports append below this line -->
