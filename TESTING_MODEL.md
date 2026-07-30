# TESTING_MODEL.md

The testing standard for this project. Read by the builder when writing a harness, and by the
Test gate when judging one.

**Binding constraint:** no CI, no staging, no test runner, no browser tooling. See WORKFLOW.md
"Infrastructure reality". The accepted substitutes are `node --check` for build validation and
**one executable `server/scripts/verify-<crid>.mjs` harness** (node + pg + fetch, real HTTP and
real DB assertions) for tests. Never fail a CR for the absence of a framework.

---

## 1. Three actors, three jobs

| Actor | Job | Must NOT |
|---|---|---|
| **Builder (Claude, in-session)** | Write the code AND `verify-<crid>.mjs` | Shape assertions to fit what was built |
| **Orchestrator (machine)** | Run the harness on the host, stamp it `@ <commit>`, route FAIL back to BUILD | — |
| **Test gate (Codex)** | Judge whether *passing means anything* | Re-run the harness — its sandbox has no DB |

The Test gate's question is **not** "did it pass". The orchestrator already established that,
deterministically, before Codex was invoked. Codex's question is: *given that it passed, is the
CR actually proven?*

---

## 2. The three proof obligations

A harness that only checks ACs is checking the wrong thing at one level and nothing at another.
Every CR owes three distinct proofs:

| # | Obligation | Proves | Failure mode if skipped |
|---|---|---|---|
| **P1** | **Requirement fidelity** | The ACs faithfully encode what the owner asked for | Every AC passes green and the owner still doesn't get what he requested |
| **P2** | **Functional correctness** | The code satisfies the ACs | Ships broken |
| **P3** | **Security properties** | The applicable SECURITY_MODEL buckets hold | Ships a leak that no gate examined |

P2 is what the pipeline currently tests. P1 and P3 are the gaps.

### 2.1 P1 — Requirement fidelity (checked at CR authoring AND at Test)

The owner's words in CR §1 are verbatim and authoritative. The ACs are an *interpretation* of
them, written by an agent. Drift between the two is invisible to any test that starts from the
ACs.

**Requirement trace table — mandatory in every CR, immediately after §3:**

| Owner's phrase (verbatim) | Where satisfied | Deviation |
|---|---|---|
| "recruiter@domain" | AC-3 | none |
| "head_hr@domain" | AC-3 as `hr_head@` | **transposed — confirm intent** |
| "user@domain" | — | **DROPPED — needs owner ruling** |
| "should be unique" | AC-1 | none |

Rules:

- Every distinct phrase in the verbatim requirement gets a row. No phrase may be silently absent.
- A deviation is not automatically wrong — agents make defensible interpretation choices. It
  must be **named**, with a one-line rationale.
- A **dropped** requirement is never an interpretation choice. It is either scope the owner
  must rule on (escalate) or an omission (fix).
- **Renaming or reordering the owner's literal strings is a deviation**, not a detail. When the
  owner writes an identifier verbatim, that string is the requirement.

The Test gate reads this table against CR §1 and reports any phrase missing from it. That is a
pure text comparison — cheap, and it catches the whole drift class.

### 2.2 P3 — Security properties belong in the harness

SECURITY_MODEL.md marks each bucket **[H]** (harness-assertable) or **[R]** (review-only). The
security triage names which buckets APPLY to this CR. Every intersection — **APPLIES ∩ [H]** —
must be asserted in `verify-<crid>.mjs`, not left to review.

This is the point of the marking. Review catches what assertions cannot; assertions catch what
review forgets. A bucket that is both applicable and assertable and yet only reviewed is a
downgrade, and the security gate is instructed to call it one.

Minimum for any CR touching a data-returning route:

```js
// B3 tenancy: authenticated as client A
assert(rows.every(r => r.client_id === A), "B3: every returned row is client A's");
// B2 field projection
assert(!Object.keys(rows[0]).some(k => FORBIDDEN.includes(k)), "B2: no unpermitted fields");
// B3 cross-tenant refusal
assert([403,404].includes(res_B.status) || res_B.rows.length === 0, "B3: client B refused");
// B10 export subset
assert(csvRows.length <= permittedRows.length, "B10: export is a subset of a permitted response");
```

For CRs touching HTTP responses, add B9: security headers, cookie attributes, and error bodies
free of stack traces, SQL fragments, or file paths.

---

## 3. What a harness must be

| Property | Meaning |
|---|---|
| **Executable** | `node verify-crXXXX.mjs` — no framework, no flags, exit 0 = pass, non-zero = fail |
| **Real** | Real HTTP against a spawned app instance, real DB. No mocks of the thing under test |
| **Idempotent** | Runs cleanly twice in a row. Second run must not fail on leftovers from the first |
| **Self-cleaning** | Creates its own fixtures with recognisable prefixes; removes them in a `finally` |
| **Deterministic** | No dependence on wall-clock, ordering, existing data, or network |
| **Loud** | On failure, print the assertion, the expected value, and the actual value. A bare "FAILED" wastes a whole build→test cycle |
| **Bounded** | Completes well under the 5-minute orchestrator timeout |
| **Port-clean** | Kills the app instance it spawned. Orphans wedge the next run |
| **Sectioned** | Output grouped `[P1] [P2] [P3]` so the Test gate can see at a glance which obligations were exercised |

---

## 4. Assertion requirements

### 4.1 AC traceability

Every AC maps to at least one named assertion, and every assertion names its AC:

```js
assert(rows.length === 0, "AC-3: re-running seedRosterTx created no new users");
```

An AC with no assertion is an untested claim. If an AC genuinely cannot be asserted, the CR must
say so explicitly and name what covers it instead — as CR-0018's AC-5 does with "proven by code
review". **That is a declared gap, not a satisfied AC**, and the Test gate judges the substitute
on its merits.

### 4.2 Four assertion classes — a harness with only the first is weak

| Class | Asks | Example (CR-0018) |
|---|---|---|
| **Happy path** | Does the new thing work? | Domain-bearing client seeds `hr_head@d`, `hrbp@d`, … |
| **Negative** | Does it refuse what it must refuse? | Second client with same domain (any case) → 409 |
| **Regression** | Is unchanged behaviour still unchanged? | Domain-less client still seeds synthetic addresses |
| **Boundary** | What about the edges? | Trailing dot, unicode homograph, NULL domain, empty string |

Most harnesses written by an agent are 90% happy path. A Test gate seeing only happy-path
assertions should say so.

---

## 5. The self-verification problem

The same agent writes the code and the test. Left unchecked it produces assertions shaped to
pass — tests that describe what was built rather than what was required. Three rules counter
this.

### 5.1 Assertions come from the CR, not the code

Write assertions by reading the acceptance criteria and the verbatim requirement, before or
independently of reading your own implementation. If an assertion had to be adjusted after
running it, say why in the record — "the AC was ambiguous" is legitimate; "the code did
something else" means the code is wrong.

### 5.2 The mutation check (highest-value rule here)

For each **critical** assertion — the one to three that prove the CR's core claim — verify it
**fails when the change is reverted**. Comment out the fix, run the harness, confirm red,
restore, confirm green.

An assertion that passes both with and without the fix proves nothing. This is the single most
common defect in agent-written tests and it is invisible from a green run.

Record the result:

```
mutation check: AC-3 assertion fails when ensureUserTx domain branch is reverted ✓
                AC-1 assertion fails when the partial unique index is dropped ✓
```

Scope it to critical assertions only — full mutation testing is not affordable here.

### 5.3 Never assert against a value the code computed

Compare against the value the **CR specifies**, hard-coded. Deriving the expected set by calling
the same function under test is a tautology.

```js
// WRONG — tautology
const expected = buildSeedEmails(client);
// RIGHT — from the CR
const expected = ["admin@d","hr_head@d","hrbp@d","recruiter@d",
                  "interviewer1@d","interviewer2@d","interviewer3@d"];
```

---

## 6. What the Test gate judges

Given a passing harness and the diff, answer eight questions:

**Requirement fidelity (P1)**
1. Does the CR carry a requirement trace table, and does every phrase in the verbatim §1
   requirement appear in it?
2. Is any owner-specified literal string renamed, reordered, or dropped without a named
   deviation and rationale?

**Functional correctness (P2)**
3. **Coverage** — does every AC have an assertion? Name any that does not.
4. **Strength** — are assertions specific, or would they pass on wrong behaviour? Asserting a
   list is non-empty, when the AC specifies exact membership, is weak.
5. **Class balance** — is anything present beyond happy path?
6. **Tautology** — does any assertion compare the code against itself?
7. **Mutation evidence** — was it recorded?

**Security (P3)**
8. For every bucket the security triage marked APPLIES ∩ [H], is there an assertion? A bucket
   that is applicable and assertable but only reviewed is a downgrade — report it.

Also: does the diff do anything the ACs did not ask for? Unasserted behaviour is unreviewed
behaviour.

A green harness with weak assertions is a **FAIL with reasons**, not a PASS. The orchestrator
already proved the code runs; Codex exists to prove the proof is worth something.

---

## 7. Post-deploy smoke test

The sign-off evidence gate accepts `pm2 reload OK` as proof of a successful deploy. **That
proves a process restarted, not that the app works.** A missing migration, a bad env var, or a
route that 500s on first request all produce a clean reload. This exact shape already caused one
incident — CR-0012 shipped code without its schema and every gate still passed.

One standing `server/scripts/smoke.mjs`, not per-CR, run against the deployed host after the
human pastes deploy output (via `node orchestrator.cjs smoke <CR>`):

- health: the site returns 200 and serves the app shell
- the API is alive and auth is enforced (an unauthenticated read is refused, not 500)
- error bodies free of stack traces / SQL fragments (B9)
- security headers observed (reported; missing headers are WARNED as an owed CR, not a
  close-blocker — blocking every close on a pre-existing gap would ratchet the wrong way)

The sign-off evidence gate requires a commit-stamped `### Smoke test — @ <sha> — OK` entry
alongside the deploy output, using the same mechanical pattern as the migration evidence gate.

---

## 8. The honesty contract

Binding on any agent writing or judging a harness.

- **A green run is a starting point, not a verdict.** Report what passing does *not* prove.
- **Declare gaps explicitly.** "AC-5 is covered by code review, not assertion" is honest.
  Silently counting it as tested is not.
- **Never weaken an assertion to make it pass.** If an assertion fails, the code is wrong until
  proven otherwise. If the assertion was genuinely wrong, say so and why.
- **Never delete a failing assertion.** Fix the code or escalate the ambiguity.
- **Never quietly reinterpret the owner's words.** Name the deviation in the trace table.
- **The reframing test.** If you are constructing an argument for why something needn't be
  asserted, that construction is the signal that it should be.
- **Absence of evidence is a finding.** "I could not verify the export is server-scoped" is a
  reportable outcome, not a pass.
- **Flakiness is a defect.** A harness that passes intermittently is worse than none — it
  launders uncertainty into green.

---

## 9. Output contract for the Test gate

```
FIRST line:  PASS or FAIL
THEN:        P1 — requirement trace: complete / phrases missing: <list>
THEN:        P2 — AC coverage, one line per AC: asserted / declared gap / UNCOVERED
THEN:        P3 — security buckets: asserted / APPLIES but only reviewed / not triaged
THEN:        findings — assertion strength, tautologies, missing classes, unasserted diff
```

Terse. No restating the CR. No re-running the harness. Maximum ~350 words after the three lists.
