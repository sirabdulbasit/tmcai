# SECURITY_MODEL.md

The security standard for this product. Read by the security gates and by the CR author when
deciding which security acceptance criteria a change owes.

**Binding constraint:** this project has no CI, no staging, no scanner infrastructure. See
WORKFLOW.md "Infrastructure reality". Nothing here may be interpreted as requiring ZAP, SAST,
DAST, or any scanner to be *run*. The ZAP-derived checks below are reproduced as
**assertions in the `verify-*.mjs` harness**, which this project accepts as the substitute.
Never fail a CR for the absence of a scanner.

---

## 1. What we protect

| Property | Question |
|---|---|
| Confidentiality | Can only the right people see this data? |
| Integrity | Can only the right people change it, and is it still correct? |
| Availability | Is the service there when needed? |
| Authenticity | Is this actor who they claim to be? |
| Accountability | Can we prove afterwards who did what? |

## 2. Severity ranking (product-specific — this is NOT the OWASP ordering)

EDIT THIS SECTION FOR YOUR PRODUCT — the ranking below is for a multi-tenant HR/recruiting product holding candidate PII; reorder it to match what is business-ending HERE.

| Rank | Class | Why |
|---|---|---|
| 1 | **Cross-tenant exposure** | One client seeing another's data is business-ending, not a bug |
| 2 | **Intra-tenant authorization** | An interviewer reading others' scorecards, a recruiter seeing compensation — a real breach with no tenant boundary crossed |
| 3 | **PII / candidate data protection** | Regulatory weight |
| 4 | **Identity & session integrity** | Account takeover |
| 5 | **Everything else** | Real, but recoverable |

Weight findings by this table, not by scanner severity labels.

---

## 3. The ten buckets

Marked **[H]** = assertable in the `verify-*.mjs` harness (prefer this — mechanical beats
vigilant). **[R]** = requires human/agent code review; no assertion can replace judgement.
**[Z]** = derived from ZAP's rule catalogue.

### B1 — Identity & authentication [R]
Session lifetime and invalidation, token handling, password storage and reset flows, MFA
paths, account lockout. Predictable or enumerable identities.

### B2 — Authorization [H][R]
Object-level (IDOR), function-level, and **field-level** access. The endpoint must refuse what
the UI hides. A client-supplied id is a *filter within* the caller's permitted scope, never the
definition of that scope.

### B3 — Tenancy isolation [H]
The highest-severity special case of B2. Every query touching tenant data must be scoped
server-side from the session. Assert cross-tenant refusal explicitly — never infer it.

### B4 — Input handling [H][R]
SQLi, XSS, command injection, mass assignment, file upload, deserialization, path traversal.
Also: normalization bypass — unicode homographs, trailing dots, case folding, IDN. Any
uniqueness constraint must survive near-collisions.

### B5 — Data protection [R]
Secrets in code/config/logs, PII in logs and error paths, encryption in transit and at rest,
retention.

### B6 — Business-logic abuse [R][H]
Workflow bypass, race conditions, quota and rate abuse, **enumeration via response
differentials** (404 vs 403, 409 vs 200, timing). A conflict response that confirms another
tenant's data exists is a disclosure even when it leaks nothing else.
**Check-then-act / preview→confirm→act binding [H] (CR-0020):** any flow where the user (or
caller) reviews state X and then confirms an action is vulnerable to a concurrent writer
changing X→X′ between the two steps — the action then hits X′, which was never reviewed.
This defeats the whole point of a preview/confirmation safeguard, and for an irreversible
action (delete, payout, publish) it is a real harm, not a nicety. BIND the two steps: the
preview issues a token/version/hash over the reviewed snapshot; the act re-validates it
under the row lock and refuses with no side effects (no audit, no mutation) on any drift.
Harness-assert the drift-refusal (insert a row between preview and act → the act must refuse
and change nothing) AND the fresh-token success. Put the binding in the CR's §5 triage at
authoring — the lean lane reviews security AFTER the build, so an unnamed TOCTOU here costs
a full post-build lap.

### B7 — Supply chain & configuration [R]
Dependencies, CORS policy, default configs, exposed admin or debug surfaces, source maps
served in production.

### B8 — Observability & accountability [R]
Is the action audit-logged? Could we answer "who exported the candidate list" six months from
now? Exports, permission changes, and bulk reads must leave a trail.

### B9 — Transport & response hygiene [H][Z]
The ZAP-shaped bucket. Assertable in the harness against a running local instance:

- Security headers: CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`
- Cookie attributes: `HttpOnly`, `Secure`, `SameSite`, correct path scoping
- CSRF protection on state-changing routes
- `Cache-Control: no-store` on responses carrying PII
- Error bodies free of stack traces, SQL fragments, ORM internals, file paths
- No server/framework version banners

### B10 — Client-side trust [H][R]
**The client is not a trust boundary.** Anything the browser receives, a person with DevTools
has — in plain JSON, with a Copy button. Six exposures:

| # | Exposure | Mistake |
|---|---|---|
| 1 | Over-fetched **fields** | Endpoint returns the whole row; UI renders three columns |
| 2 | Over-fetched **rows** | Client-side filtering, search, or pagination over a full result set |
| 3 | Hidden UI controls | Button hidden by role; endpoint behind it is not |
| 4 | Bundle contents | Routes, flags, role names, keys, source maps |
| 5 | Error bodies | See B9 |
| 6 | Response differentials | See B6 |

**Rule:** every endpoint returns exactly what this caller may see, computed server-side from
the session — never from a client-supplied parameter, never trimmed afterward by the UI.

---

## 4. Applicability routing

A CR does not owe all ten buckets. Route by what the declared file list touches:

| Surface touched | Buckets that MUST be examined |
|---|---|
| `server/routes/*` | B2, B3, B4, B6, B10 |
| migration / schema | B3, B5, B6 |
| auth / middleware / session | B1, B2, B3, B9 |
| any export, report, or download | B2, B3, B5, B8, B10 |
| user / identity creation | B1, B2, B6 |
| config, `.env`, `package.json` | B5, B7 |
| response shape or error handling | B6, B9 |
| UI-only (`.jsx` with no route change) | B10 |

---

## 5. The honesty contract

This section is binding on any agent applying this model.

**Triage every bucket explicitly.** For each of the ten, state one of:
`APPLIES` · `N/A — <one-line reason>` · `COVERED — <where>`.
A bucket omitted from the list counts as an unexamined APPLIES.

**Never mark N/A because the CR says so.** "Tenancy unchanged" in a CR is a claim under
review, not evidence. Verify against the diff or mark it APPLIES.

**Never mark a [H] bucket COVERED by review alone.** If it is harness-assertable and the
harness does not assert it, it is not covered. Say so.

**Never pass a bucket by restating the CR's own reasoning back at it.** Cite the code.

**Under-declared risk is itself a finding.** If the change touches rank 1-3 in §2 but declares
Low/Moderate, say so on the RISK line — higher class wins.

**The reframing test.** If you find yourself constructing an argument for why something does
not need checking, that construction is the signal that it does. Report the tension rather
than resolving it in favour of passing.

**Absence of evidence is a FAIL, not a PASS.** "I could not determine whether the endpoint is
scoped" is a finding. Say what you could not verify and what would settle it.

**Materiality.** FAIL for real, exploitable, or damaging defects — and for missing assertions
on [H] buckets that apply. Do not FAIL for absent scanner automation (see the binding
constraint at the top), style, or hypotheticals with no path to impact.

---

## 6. Standing acceptance-criteria template

Every CR touching a data-returning route owes this AC. The CR author adds it at authoring
time; the security gate verifies it exists and is genuinely asserted.

> **AC-N (scoping):** the endpoint returns only the rows and fields this caller may see,
> proven by authenticated harness calls asserting (a) row scope, (b) field projection,
> (c) cross-tenant refusal, and (d) that any client-side filter or export is a subset of an
> already-permitted response.

Every CR touching HTTP responses owes:

> **AC-M (response hygiene — BRANCH-COMPLETE):** FIRST enumerate EVERY response branch the
> changed route can emit — the success status AND every error/refusal status, **including
> those produced by middleware that runs before the handler** (auth 401/403, body/upload
> rejection 400, validation 400, conflict 409, server 500). THEN the harness asserts, for
> each enumerated branch by INDUCING it: `Cache-Control: no-store` where the branch carries
> identity/record data, a leak-free body (no stack trace, SQL fragment, file path, or raw
> `err.message`), and any applicable cookie attributes. A response-hygiene control set on
> only some branches, or asserted on only one, is a FINDING.

**Why branch-complete (CR-0021 retro):** response-hygiene proven one branch at a time costs
one review lap PER branch. CR-0021 took ~4 Security-Review/Test laps because no-store and
leak-free bodies surfaced branch-by-branch (500 leak → 403 → upload-type → upload-size →
validation-400). Set the control ONCE before the auth/upload middleware (so every branch
inherits it) and enumerate + induce ALL branches in the FIRST harness — the whole B9 class
clears in a single pass. A raw `err.message` reaching any response body (route-local OR the
global error handler) is the recurring leak; handle rejections locally so nothing falls
through to a shared handler that echoes `err.message`.

---

## 7. Output contract for the security gates

```
FIRST line:  PASS or FAIL
SECOND line: RISK=<Low|Moderate|Material|Critical>
THEN:        the ten-bucket triage list, one line each
THEN:        findings — each with bucket, file:line, impact, and the fix
```

Terse. No restating the CR. No praise. Maximum ~350 words after the triage list.
