# Operator directives — archive

Directives that ASSERT their own closure — "CLOSED <date>", "CLOSED by …", or
"(superseded" — moved out of `operator_directives.md` on 2026-08-20. The live file had
reached 67KB and the Builder read it IN FULL: 72k characters of prefix, re-read on every
following turn.

Nothing is deleted and nothing in force was moved. A first pass matched the bare word
CLOSED and pulled D-21 ("RANKS FIRST UNTIL CLOSED") in here — a directive archived while
still in force is a rule the builder stops seeing, which is far worse than a large file.
Closure now has to be stated, not mentioned.

---

## D-8 · CLOSED 2026-08-12 by DEF-153 — root cause was the office-hours gate, not pollution

**Resolved, and my guidance in this directive was misdirected.** I told the Builder
to hunt a `vi.mock` leak; the actual cause was `brainContactsUser` gating on office
hours (`brainOutboundService.ts:450`, DEF-120) with the test never bypassing the
gate — so it passed inside the working day and failed outside it. Codex blamed
Redis idempotency. Both of us reasoned from theory; the Builder printed the
program's own refusal (`NOT SENT reason={"sent":false,"reason":"outside_office_hours"}`)
and had the answer in one run. That is the chart's own lesson — *diagnosing from
theory instead of asking the system* — and this time the orchestrator and the
reviewer were the ones doing it.

**Standing rule that comes out of it:** any test touching behaviour that varies with
wall-clock time, office hours, quiet hours or timezone must INJECT the time, never
read it. A clock-dependent suite is not flaky in the retryable sense — it is red for
hours at a stretch, which no amount of resampling detects.

---

## D-8-OLD (superseded, kept for the record) · The verification rail is non-deterministic

**Observed 2026-08-12 13:00–13:11 UTC, on ONE unchanged commit (`e059486`):**

```
12:59:30  loop rails      npx vitest run  → GREEN  (172 files, 2053 passed)
~13:00    Codex re-ran    npx vitest run  → RED    (8 failed)
13:05     orchestrator    npx vitest run  → RED    (8 failed, 171 files)
13:11     isolation       npx vitest run tests/def140OwnerAddressBoundary.test.ts
                                          → GREEN  (19/19)
```

No commit between them. All 8 failures are in
`tests/def140OwnerAddressBoundary.test.ts`, which passes alone. Therefore
**cross-file pollution or ordering/parallelism dependence**, not a code
regression — and the loop's primary rail can report GREEN on a suite that is red.

Why this outranks feature work: every iteration's "verification matrix" claim, the
rails that decide whether a build turn's work is safe to stack on, and the new
deploy phase's gate all rest on `vitest run` meaning something. Right now a green
rail is a coin flip. Codex caught this only because it independently re-ran —
which is also the second time Codex has caught a false-green verification claim
(iteration 10's build log published green while the tree was red).

**Find the leak, don't retry-loop it.** Likely candidates: a `vi.mock` of
`../src/db/prisma` or `promptBlockService` in that file leaking into or being
clobbered by another file's mock of the same module; module-level state in
`brainOutboundService`; or a shared singleton captured at import time. Prove the
fix by running the full suite 5× consecutively green, and name the polluting pair
in the DEF row so the class is recorded, not just the instance.

---

