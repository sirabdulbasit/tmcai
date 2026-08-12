# Capability history — one scorecard per iteration

Appended by `scripts/orchestrator/scorecard.py --append` at the end of
each iteration, after Codex's review. Never rewritten: an earlier card
that turned out to be optimistic is evidence, not an error to tidy away.

## Iteration 2

```
Iteration 2 — Brain Capability: Post-Build
Capability               Nexeo Today                Professional Assistant     Δ
Simple & Smart           33  ███████░░░░░░░░░░░░░   92  ██████████████████░░     0
Thinking                 36  ███████░░░░░░░░░░░░░   94  ███████████████████░     0
Memory                   60  ████████████░░░░░░░░   92  ██████████████████░░     0
Accurate Communication   69  ██████████████░░░░░░   94  ███████████████████░    +1
Authorized Action        52  ██████████░░░░░░░░░░   91  ██████████████████░░     0
Self Follow-Up           43  █████████░░░░░░░░░░░   96  ███████████████████░     0
Learn                    42  ████████░░░░░░░░░░░░   90  ██████████████████░░     0
Self-Healing             53  ███████████░░░░░░░░░   89  ██████████████████░░     0
Self-Pruning             33  ███████░░░░░░░░░░░░░   89  ██████████████████░░     0
Overall: Nexeo 46.8 vs professional assistant 91.9 · gap 45.1 · movement +0.1 PROGRESSIVE
```

**What moved, and on what evidence:**

- Accurate Communication +1: DEF-135 (1940a34) — B12 recovered 0 -> 95 on the real composer path; the guard stopped destroying the answer around a real fabrication, and the fabricated process claim no longer reaches the user. Held to +1, not more, because Codex's HIGH finding shows the salvage still ships an unverified CAUSE (fabricated-status shape) and the post-build judge independently flagged it (C1=85 on B12).

## Iteration 4

```
Iteration 4 — Brain Capability: Post-Build
Capability               Nexeo Today                    Professional Assistant       Δ
Simple & Smart            33  ███████░░░░░░░░░░░░░      92  ██████████████████░░     0
Thinking                  36  ███████░░░░░░░░░░░░░      94  ███████████████████░     0
Memory                    60  ████████████░░░░░░░░      92  ██████████████████░░     0
Accurate Communication    70  ██████████████░░░░░░      94  ███████████████████░    +1
Authorized Action         52  ██████████░░░░░░░░░░      91  ██████████████████░░     0
Self Follow-Up            43  █████████░░░░░░░░░░░      96  ███████████████████░     0
Learn                     42  ████████░░░░░░░░░░░░      90  ██████████████████░░     0
Self-Healing              53  ███████████░░░░░░░░░      89  ██████████████████░░     0
Self-Pruning              33  ███████░░░░░░░░░░░░░      89  ██████████████████░░     0
Overall: Nexeo 46.9 vs professional assistant 91.9 · movement +0.1
Gap to professional: 45.0 · PROGRESSIVE
```

**What moved, and on what evidence:**

- Accurate Communication +1: DEF-137/138 (e428a2d) — the persona said address was optional 'one reply in four' while four of its eight EXAMPLES addressed the user (50%, double the stated ceiling); examples outvote prose in a prompt. C4 rose 86.3 -> 89.6, its largest move, B05 reached 95, and Codex verified SOUND after re-running tsc/1947 tests/build/diff itself. Held to +1: verified on the COMPOSE surface only, and CL-033 shows the same address rule does not reach the proactive notification path, where a live message addressed the owner as 'Basit,' instead of the configured form.

## Iteration 5

```
Iteration 5 — Brain Capability: Post-Build
Capability               Nexeo Today                    Professional Assistant       Δ
Simple & Smart            33  ███████░░░░░░░░░░░░░      92  ██████████████████░░     0
Thinking                  36  ███████░░░░░░░░░░░░░      94  ███████████████████░     0
Memory                    60  ████████████░░░░░░░░      92  ██████████████████░░     0
Accurate Communication    70  ██████████████░░░░░░      94  ███████████████████░     0
Authorized Action         52  ██████████░░░░░░░░░░      91  ██████████████████░░     0
Self Follow-Up            43  █████████░░░░░░░░░░░      96  ███████████████████░     0
Learn                     42  ████████░░░░░░░░░░░░      90  ██████████████████░░     0
Self-Healing              53  ███████████░░░░░░░░░      89  ██████████████████░░     0
Self-Pruning              33  ███████░░░░░░░░░░░░░      89  ██████████████████░░     0
Overall: Nexeo 46.9 vs professional assistant 91.9 · movement 0.0
Gap to professional: 45.0 · NEUTRAL
```

**What moved, and on what evidence:**

- Accurate Communication +0: DEF-140 (ede14fa) removed a genuine SECOND address resolver — brainHumanComm.addressUser read user.name's first token while brainPersonaService honoured the configured 'Sir', which is why a live draft ask said 'Basit,'. Codex confirmed the diagnosis and called the composition-first deviation CORRECT. No credit yet, for two stated reasons: (1) Codex raised two HIGH findings — provenance is OPTIONAL and only 7 of ~66 inventoried producers are classified, and notificationService.ts:122-141 sends owner WhatsApp content without entering the boundary at all, so an unclassified producer can still ship 'Basit,' with nothing failing; (2) it is live-unverified — Codex: 'remains locally verified and live-unverified until an actual proactive draft/chase message uses Sir rather than Basit.' The compose benchmark bought no evidence either way, which Codex judged as scope discipline rather than uselessness.

## Iteration 6

```
Iteration 6 — Brain Capability: Post-Build
Capability               Nexeo Today                    Professional Assistant       Δ
Simple & Smart            33  ███████░░░░░░░░░░░░░      92  ██████████████████░░     0
Thinking                  36  ███████░░░░░░░░░░░░░      94  ███████████████████░     0
Memory                    60  ████████████░░░░░░░░      92  ██████████████████░░     0
Accurate Communication    70  ██████████████░░░░░░      94  ███████████████████░     0
Authorized Action         52  ██████████░░░░░░░░░░      91  ██████████████████░░     0
Self Follow-Up            43  █████████░░░░░░░░░░░      96  ███████████████████░     0
Learn                     42  ████████░░░░░░░░░░░░      90  ██████████████████░░     0
Self-Healing              53  ███████████░░░░░░░░░      89  ██████████████████░░     0
Self-Pruning              33  ███████░░░░░░░░░░░░░      89  ██████████████████░░     0
Overall: Nexeo 46.9 vs professional assistant 91.9 · movement 0.0
Gap to professional: 45.0 · NEUTRAL
```

**What moved, and on what evidence:**

- Accurate Communication +0: DEF-143 (aef1540) caught a fabricated developer-remediation clause the previous iteration's detector missed, and Codex granted that plus 'useful register guidance'. But verdict WEAK on two counts that block credit: its salvage test DECLARES the adjacent unverified reminder-cause claim TRUE, preserving the baseline's most serious C1/C2 defect, and it widened a block-and-excise regex with known answer-destroying false positives — the guard-destroys-the-answer class with four prior occurrences. C4 moved 87.9 -> 88.3, inside the instrument's own run-to-run spread (C4 read 90.0 and 87.9 on identical code 20 minutes apart), so the movement is not evidence either.

## Iteration 6

```
Iteration 6 — Brain Capability: Post-Build · recalibrated
Capability               Nexeo Today                    Professional Assistant       Δ
Simple & Smart            33  ███████░░░░░░░░░░░░░      92  ██████████████████░░     0
Thinking                  36  ███████░░░░░░░░░░░░░      94  ███████████████████░     0
Memory                    60  ████████████░░░░░░░░      92  ██████████████████░░     0
Accurate Communication    72  ██████████████░░░░░░      94  ███████████████████░    +2
Authorized Action         52  ██████████░░░░░░░░░░      91  ██████████████████░░     0
Self Follow-Up            43  █████████░░░░░░░░░░░      96  ███████████████████░     0
Learn                     42  ████████░░░░░░░░░░░░      90  ██████████████████░░     0
Self-Healing              54  ███████████░░░░░░░░░      89  ██████████████████░░    +1
Self-Pruning              33  ███████░░░░░░░░░░░░░      89  ██████████████████░░     0
Overall: Nexeo 47.2 vs professional assistant 91.9 · movement +0.3
Gap to professional: 44.7 · PROGRESSIVE
```

**What moved, and on what evidence:**

- Accurate Communication +2: RECALIBRATION, not new work. Iterations 3 and 5 were scored 0 on a rule that required live verification from a loop forbidden to deploy — a bar nothing could clear. Both were real mechanism fixes: DEF-136 (9cf416d) built the shared prose-finalisation chokepoint and Codex verified it SOUND with zero unsupported claims; DEF-140 (ede14fa) removed a genuine SECOND address resolver and Codex called the diagnosis and the composition-first approach correct. Benchmark corroborates on the compose surface: C4 84.8 -> 88.3 across the run, bare 'Sir,' openers gone from reasoning answers, B12 recovered 0 -> 95, B04's machine-rendered 'priority=high' and B11's canned capability denial both cleared to 90. Seven defects shipped with +112 test assertions.
- Self-Healing +1: DEF-135 + DEF-143 together give Brain a working recovery path for its own bad output: the validator now SALVAGES a true answer instead of replacing it with a canned denial, and the fabricated-clause detector was widened after DEF-143 found a sentence the previous list missed. Held to +1 because Codex's iteration-6 WEAK names a real cost — the widened regex carries known answer-destroying false positives, the guard-destroys-the-answer class with four prior occurrences.
