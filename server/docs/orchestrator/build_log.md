# Build log — written by Claude, read by Codex

One `## Iteration N` section per build turn, appended, newest at the bottom.
Codex reviews these entries against the real diff, so a claim here that the diff
does not support is the single most useful thing for the reviewer to catch.

Required per iteration: what the fix queue said, what was changed and why, the
verification numbers (tsc / vitest, exact figures), what was NOT done, and the
honest expectation of which criterion should move.

## Iteration 1 (loop-numbering restart; the sixth build turn of this branch)

**Commit `9cb7720`** on `release/cmp-2026-08-16`. DEF-192 row added;
`Changes_Made.md` §43 added.

### Two harness glitches, reported not worked around

1. **The brief's capability table contains unexpanded placeholders** —
   `Simple @@TARGETCAP@@ Smart`, `Simple @@CAPGAPS@@ Smart`. The intended
   capability is plainly `Simple & Smart` (the contract's #1), so the target
   is readable, but the substitution is broken in the orchestrator's prompt
   builder. I did not touch `scripts/orchestrator/**`; the orchestrator fixes it.
2. **The brief numbered this "Iteration 1" and said "not a continuation turn"**,
   while the branch already carries Iterations 1–5 and my previous turn had
   begun work mid-flight. I have appended under a disambiguated heading rather
   than a second `## Iteration 1`, so the log stays readable.

### What governed this turn, and what I dropped

No remediation was open: the newest review section is `## Iteration 4`, and
Iteration 5 already ruled on its findings (the escalation gate, `bb0cf57`).
The campaign block's standing order is the operative one — *make HEAD
deployable, close what the reviewer says blocks release, no opportunistic
work* — and exactly one Builder-actionable release blocker remained: Codex's
iteration-4 **carried CRITICAL**, which DEF-191 recorded OPEN and deferred to
"its own scoped turn". This is that turn.

**Dropped, deliberately:** the DEF-192 event-token table I had started at the
end of the previous turn (a `self_prune_notice_members` model + migration,
aimed at Codex's directives 1+3 for the notice outbox). It was reverted
uncommitted — `git checkout server/prisma/schema.prisma` plus removing the
unwired migration directory — for two reasons: the announce path it serves is
now gated OFF by default (DEF-191), so it is no longer on the release path;
and shipping an unwired table would be exactly the "new surface for the
reviewer to block on" this brief forbids. The redesign remains owed BEFORE
the gate is opened, and stays recorded in DEF-191's row.

### Governing-docs verdict (rule 5)

**Circling — `query-without-tenant-scope`, member 6**, the same class DEF-178
/179/188/189 closed on other surfaces. So the fix is structural by
requirement, and it is the same structural move that worked there: **the
tenant enters at the entry point** rather than being added as a filter to
each query, which is what makes the next query on this path scoped by
construction instead of by review.

### What changed, and why that is the mechanism

- `delegationFollowUpJob.ts` — `runDelegationFollowUpForTenant(clientNumber)`
  is the new per-tenant entry and carries the tenant into every query.
  `runDelegationFollowUp` keeps its exported name and becomes the sweep: the
  ONLY cross-tenant read is the tenant-REGISTRY enumeration (distinct
  clientNumber over active users, deterministic order), it reads no tenant
  data, and one tenant's failure never blocks the next.
- Owner identity is cached per `(tenant, user)` and resolved under the item's
  tenant. This is the one that matters most for the owner: that identity
  becomes the From-name and the disclosure footer of an email that leaves his
  Gmail.
- `smartChaseService.getUserNameAndEmail(userId, clientNumber)` — the tenant
  is REQUIRED and CONSTRAINS the query (`findFirst id + clientNumber`, the
  DEF-179 pattern). A pair absent from that tenant reads nothing, returns
  null, and the item is never chased for. It had exactly one caller, so the
  signature change is total rather than optional.
- One `scopedItemUpdate` replaces all four `update({where:{id}})` calls and
  their `.catch(() => {})`: `updateMany` on (id, clientNumber, userId) with
  the affected-row count checked. `mark_stale` and `escalate` now record
  nothing and count nothing when the write matches nothing.

### The one asymmetry I did NOT paper over

The post-send bookkeeping write runs AFTER the email has left. A zero-row
result there does not mean the chase did not happen, so `sent` still counts —
that is the truthful fact — while `errors` counts and the log says plainly
that the bookkeeping did not land. The pre-existing consequence is that with
no `lastSentAt` persisted the next tick may chase the same item again; the
old `.catch(() => {})` had the identical hole and hid it. Making it visible
is this turn's scope; closing it needs a pre-send intent record, which I did
not attempt and which is stated in the DEF row rather than implied.

### Verification (measured AFTER the last code edit, commit `9cb7720`)

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **195 files: 193 passed / 1 failed / 1 skipped · 2,405
  tests: 2,374 passed / 2 failed / 7 expected fail / 21 skipped / 1 todo.**
  The 2 are `orchestratorPulseRoute.test.ts` executing the orchestrator's
  uncommitted live `pulse.py`; the COMMITTED script passes the contract's
  exact assertions (proven in Iteration 2's entry). Still owed by the
  orchestrator, and it is the one thing standing between this branch and a
  zero-failure matrix.
- **`npm run build`** — the actual script at `9cb7720` in the fully isolated
  clean clone (own `npm ci` dependencies): generate + emit OK,
  `dist/jobs/delegationFollowUpJob.js` and
  `dist/services/delegation/smartChaseService.js` produced in the clone.
  Production's immutable `server/dist` untouched.
- `git diff --check` — clean.
- New tests: 10 in `def191DelegationAuthorityHold.test.ts` (was 3).

### Capability declaration (contract §Builder)

```
CAPABILITY: Authorized Action
PREDICTED:  +0 until deployed. Production is single-tenant today, so this
            closes exposure rather than changing what the owner receives.
            DIVERGENCE FROM THE BRIEF'S TARGET, stated as required: the
            target reads `Simple @@TARGETCAP@@ Smart`, and I am not aiming
            there — the campaign block's standing order (make HEAD
            deployable; close the reviewer's release blocker; no
            opportunistic work) governs this turn, and the blocker is a
            tenant-authorization defect.
MECHANISM:  the tenant enters at the job's entry point and constrains every
            read, the identity query and every write, so no path in this job
            can act on, or speak for, a pair it is not authorized to read.
FALSIFIER:  any openItem read or write in this job without clientNumber; a
            chase composed for an item whose owner does not resolve inside
            the item's tenant; a marked_stale or escalated count for a write
            that changed zero rows.
```

### What I did NOT do, and what I am unsure about

- No campaign increment, no benchmark work, no C4 register work (still
  Codex's directive 6, still owed a fresh turn once this range is SOUND).
- Did not touch `scripts/orchestrator/**` — including the pulse WIP that is
  the sole cause of the red matrix.
- `sendUserEmail(userId, …)` still resolves Gmail credentials by bare userId.
  That is a separate surface (the credential store, not this job) and pulling
  it in would have widened a release-blocker turn. Named here rather than
  silently left.
- Unsure: whether Codex counts the post-send `sent`-plus-`error` accounting
  as honest or as a half-measure. I argue it is the only truthful option —
  denying a send that happened would be a worse lie than reporting a lost
  write — but the judgement is his.

### Honest prediction

**Deployable at the end of this turn if reviewed SOUND**, and that is a real
prediction rather than a hope: this closes the last Builder-actionable
release blocker Codex named across five reviews, the announce path that
attracted four WRONG verdicts is gated off, and everything else in the range
has been through review. The benchmark should be flat — no compose path
changed. Wrong if: Codex finds a query in this job I left unscoped, judges
the registry enumeration insufficient as the single cross-tenant read, or
rules that `sendUserEmail`'s bare-userId credential resolution belongs inside
this finding rather than beside it.
