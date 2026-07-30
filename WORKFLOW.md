# Multi-Agent Development Workflow (v10 — synced to orchestrator v96, hybrid ledger)

> Designed by Claude (Anthropic), hardened by Codex (OpenAI). (Grok (xAI) reviewed early
> revisions and was retired from the pipeline on 2026-07-27 — see `GROK.md` for history.)
> Accepted trade-off: ~19% active-time overhead vs. a sole agent on a full-day
> feature (sub-10% with batched CRs), in exchange for uncompromised design,
> quality, and security. See Annex A.
>
> This document is the single source of truth for the workflow. The per-agent role
> docs — `CLAUDE.md` (builder; auto-loaded by Claude Code), `AGENTS.md` (Codex reviewer/tester;
> auto-loaded by the Codex CLI — **not** `CODEX.md`), — must stay in sync with it. (`WORKFLOW_PROMPT.md` is legacy from
> the pre-v48 auto-spawn model and no longer drives the agents.) Changes require evidence
> per the learning rule — not further review rounds.

A software-delivery pipeline coordinating three AI agents, deterministic CI/CD
infrastructure, and one human.

## Infrastructure reality (BINDING — reviewers read this FIRST)

This section states what **this** project actually has. Reviewers judge a CR against it,
so an inaccurate line here causes wrong verdicts — correct it before the first CR.

- **Runtime:** Node + TypeScript. `server/` is the backend (Express, entry
  `server/src/server.ts`, listens on **4002** — `server/src/config/env.ts:76`); `client/` is
  the React/Vite frontend. `server/package.json` scripts: `build` (= `prisma generate && tsc`),
  `start`, `dev`, `test` (vitest). There IS a `server/package.json` — the auto-draft's
  "no package.json found" was wrong (it looked only at the repo root).
- **Deploy:** **owner-executed, never automated.** Basit runs every production command
  himself on the Ubuntu host (AGENTS.md §1: "Never run anything against production
  directly"). `deploy.command` is therefore intentionally EMPTY; deploy evidence reaches
  the ledger as owner-pasted terminal output. This is a deliberate policy, not a missing
  config — do not fail a CR for it.
- **Host / process manager:** Ubuntu box "deepmarks", repo at `/var/www/tmcai`, pm2 app
  `tmcai-server` (pm2 **must** start with `cwd=/var/www/tmcai/server` or `.env` — and thus
  `DATABASE_URL` — is silently absent). Three unrelated apps share the box
  (`tmcai-agents`, `tokr-server`, `vm-server`): never touch them.
- **Database:** PostgreSQL via Prisma. Migrations are hand-written idempotent SQL under
  `server/prisma/migrations/<date>_<name>/migration.sql` — **never** `prisma migrate dev`
  (ledger drift), and runtime code must never `CREATE TABLE`. Never `npx prisma` on prod
  (wrong major); use `node_modules/.bin/prisma` or `npm run build`.
- **Test runner:** **vitest, and it is substantial** — `server/tests/*.test.ts`, ~90 files
  / ~984 tests, run with `npx vitest run` from `server/`. Reviewers SHOULD expect real
  vitest coverage for server changes; the per-CR executable harness is an ADDITION to it,
  not a substitute. (The auto-draft said "none" — wrong.)
- **Typecheck:** `npx tsc --noEmit` from `server/` must be clean. This plus full vitest
  plus `npm run build` plus `git diff --check` is the standing pre-handoff matrix
  (AGENTS.md §5).
- **CI / staging / artifact pipeline:** NONE. No GitHub Actions, no staging environment,
  no artifact/SBOM gate. Local verification + review is the whole safety net.
- **Live acceptance is mandatory for messaging changes:** a WhatsApp/email/calendar-path
  release is **PARTIAL** until real inbound traffic passes on production, however green
  the local suite is (AGENTS.md §5). Never treat unit tests as live proof.

The rest of this document describes the *target* pipeline; where a step names
infrastructure that does not exist here, the **manual/executable substitute below is the
standard a CR must meet**, and reviewers evaluate against the substitute — never against
tooling this project does not have.

| Target step names… | …but does not exist yet. Substitute a CR MUST meet: |
|---|---|
| CI SAST / dependency / secret scan, "source green" | `node --check` on changed server files; secrets never in code (reviewed by Codex) |
| Immutable artifact + SBOM + hash gate | the app is rebuilt by the deploy command; no hash gate |
| Staging environment + staging verify | verification runs against the **local** stack via the CR's executable harness |
| ~~Automated tests / test runner~~ **EXISTS — vitest** | NOT deferred here. `npx vitest run` from `server/` (~984 tests) plus `npx tsc --noEmit` are REQUIRED for any server change. The per-CR **executable `verify-<crid>.mjs` harness** in `server/scripts/` is an ADDITIONAL commit-stamped proof that drives real surfaces and must fail if the change is reverted — it does not replace the suite. A CR touching `server/` with no vitest coverage is a legitimate FAIL. |
| **Automated visual-regression vs staging screenshots** | **human attaches before/after screenshots to the CR** for the named UI states; Codex reviews those, including the UX critique (manual visual verification) |
| DAST / ZAP against staging | Codex's separate security session (adversarial reasoning) + Codex code-level review + the executable harness's authz/tenant assertions |
| Soak / live-traffic monitoring | CR closes on verified deploy output (shipped commit == tested commit) |

**Binding rule on reviewers:** do **NOT** reject or fail a CR *solely*
because a deferred capability above is absent, and do **NOT** demand the automated form
of it. Require the **substitute**, and reject only if the substitute itself is missing,
wrong, or insufficient. Re-add the automated form (and delete its row here) when that
infrastructure actually exists. This section **overrides** any absolute wording later in
this document.

## Who does what (hybrid ledger — orchestrator v53)

The orchestrator spawns no one by judgment. It is a **ledger**: tracks status, renders the
9-step board, keeps the audit trail + consumption report, and — when `codex.auto` is on —
runs Codex itself and records the verdict. Claude works **in-session**.

- **Claude — IN-SESSION** — writes the CR, builds, revises, prepares deploy, and (since
  2026-07-27) records the final **Sign-off**. Records each step
  (`node orchestrator.cjs record …` / `revise …`), self-reporting its token usage.
  Never tests, reviews or approves its own work; the close it *does* own is permitted only
  because the orchestrator machine-checks the deploy evidence (step 9).
- **Codex — Technical Clearance + Test + Security Clearance + Security Review (code)**, the
  security gates in a SEPARATE per-CR session. Auto-run by the orchestrator when
  `codex.auto` is on, otherwise relayed in-session by the human. Codex has the last
  human-judged word on every CR.
- **Orchestrator (ledger)** — status machine + board + audit trail + consumption report;
  runs the deterministic classifier and the host-side verification harness; prints the
  deploy command at DEPLOY_WAIT; **refuses a Sign-off CLOSE without deploy
  evidence** (shipped commit == tested commit + deploy success + migration evidence).
- **Human (you)** — runs the deploy command on the host, and decides genuine
  business/policy/scope questions (and any exceeded WORKFLOW limit).

_Rationale for the switch (v48): Claude + Codex in-session reuse conversation context
(far cheaper than headless full-CR re-sends), give live per-agent token visibility, and
let the human stop revision churn early — directly cutting the Codex-quota cost while
preserving independent review (Codex is still a different model reviewing Claude's work)._

## Risk classes

- **Low** — cosmetic or internal, no sensitive data or external action.
- **Moderate** — normal, reversible product change with tested data paths.
  Follows the Low path but is flagged in the final report.
- **Material** — sensitive data, auth, schema changes, payments, external actions.
- **Critical** — irreversible, destructive migration, or wide blast radius.

**Claude proposes the class in the CR. Codex's Security Clearance must confirm or escalate
it. Disagreement → the higher class wins.**

## The pipeline (9 steps, hybrid ledger)

Each step notes the failure it exists to catch. Orchestrator statuses in parentheses.
`[in-session]` = you run the agent yourself and record the result; `[auto]` = the
orchestrator runs it. In-session results are recorded with
`node orchestrator.cjs record <CR> "<gate>" <agent[:model]> <VERDICT> <secs> <tokens>
--remarks-file <review.md>`; Codex review/test records and every failed in-session gate
include the full remarks file so the next agent receives the exact findings;
a FAIL pauses for an in-session `revise`; the orchestrator advances on the recorded verdict.

1. **CR** (DRAFT + auto-classification) — Claude (in-session) turns the requirement into
   a CR: scope, ACs, recovery strategy, proposed risk class, declared file list.
   `classify.cjs` (auto, deterministic, 0 tokens) routes it: cosmetic-only → FAST lane;
   anything touching code → this TEAM lane. *(Catches: building the wrong thing.)*
2. **Technical Clearance** (DRAFT, **Codex [in-session]**) — feasibility, approach,
   code-level soundness; verdict PASS/FAIL. *(Catches: unbuildable or unsound designs.)*
3. **Security Clearance + risk class** (DRAFT, **Codex [separate security session]**) — authz/IDOR, cross-tenant
   isolation, injection, abuse paths, secrets; rules the risk class (higher wins).
   *(Catches: adversarial failures; under-rated risk.)*
   → On any clearance FAIL: **Revise [in-session]** — Claude fixes the CR, runs `revise`
   (bumps the counter, resets scope, re-runs review). Max 3 revisions, then → human.
4. **Building** (BUILD, **Claude [in-session]**) — implement strictly to the ACs, commit,
   record COMPLETED. *(Catches: nothing built / wrong build.)*
5. **Test** (TESTING) — the orchestrator first runs the CR's **verification harness on the
   host [auto]** (machine validation), then **Codex [in-session]** reviews the harness
   output + diff against the ACs; PASS/FAIL. A FAIL loops back to Building once (cycle 1/2);
   a second FAIL → human. *(Catches: code that doesn't do what the CR says.)*
6. **Prepare deploy** (BUILD_DEPLOY, **Claude [in-session]**) → **Human deploy**
   (DEPLOY_WAIT) — Claude pushes + writes the exact deploy command(s) into the CR
   under `### Deploy commands` (never deploys); the orchestrator prints them; YOU run them
   on the host and paste the output. Healthy → SIGNOFF; failed → ESCALATED.
   *(Catches: builder self-deploying; changes shipping with nobody aware.)*
7. **Sign-off** (SIGNOFF, **Claude [in-session]** → CLOSED) — Claude closes the CR, but the
   orchestrator REFUSES the close unless the ledger proves shipped-commit == tested-commit,
   a successful deploy output, and migration evidence. Independence is mechanical here;
   CLOSE or REOPEN. On CLOSED the orchestrator writes the consumption report
   (time + tokens per agent, from recorded self-reports; figures the pre-v95 parser may have
   misattributed are flagged in the report rather than presented as fact).
   *(Catches: "done" declared before it's true.)*

**Deferred until real CI/staging/traffic exist:** immutable artifacts + SBOM,
source validation in CI, staging verification, live checks, soak. The server
rebuilds on deploy (accepted deviation). Re-add when the infra exists.

## Safety rules (never break)

1. **Claude never tests, reviews, or approves its own work.**
2. **Machine validation before AI tests.** Source green, artifact validated, always.
3. **One artifact.** What was validated is exactly what ships. Hash mismatch = hard stop.
4. **Hard limits.** Max **2** failed build→test cycles. Max **3** total CR
   revisions (requirement and risk-class revisions included). A hard cost and
   wall-clock budget applies across the entire CR and **never resets**.
   Exceeding any limit → escalate to the human.
5. **Incident action, not reflex.** On production failure, CI/CD executes the
   predefined incident action for that service: pause rollout, isolate unhealthy
   instances, disable the feature, degrade safely, or stop traffic. Never assume
   stopping traffic or rolling back is universally safe. No validated action
   applies → freeze all changes and escalate immediately.

## Budgets (concrete — tune to your reality)

- Max cost per CR: $25 (Low/Moderate) / $75 (Material) / $150 (Critical)
- Max wall-clock per CR: 4 h (Low/Moderate) / 12 h (Material) / 24 h (Critical)

## When something fails

- Review rejected → revise the plan (counts toward the 3-revision cap).
- Test failed → classify first:
  - **Code bug** → fix (step 4); counts toward the 2-cycle cap.
  - **Bad requirement** → revise the CR; counts toward the 3-revision cap.
    Budgets never reset.
  - **Transient error** → retry **only if positively identified as transient**,
    exponential backoff with jitter, max 3 attempts. Unknown errors are never
    assumed transient.
- Staging failed → do not promote.
- Production failed → safety rule 5: predefined incident action, or freeze and escalate.

## Learning rule

Every report logs which gate caught which defect. Judge gates by **cost vs. the
severity of what they protect against, not how often they fire**. Remove a gate
only when it is expensive AND covers no unique failure class. Add or strengthen
gates based on incidents, credible threats, threat modeling, compliance
obligations, architectural changes, or recurring near misses — evidence of need,
not incidents alone.

## UI & design (CRs that touch the user interface)

Claude selects the visual direction per product (dark/command-first for AI power
tools, warm/tactile for self-service, editorial for executive surfaces) and states
it — with its 2–3 signature "wow" moments — in the first UI CR, where the human
may veto before screens multiply. The direction then becomes the binding design
system. Per UI CR: the plan names which design-system patterns apply; the security session adds a
UX critique (friction, confusion, delight, consistency); **Codex reviews the
human-attached before/after screenshots** of the named UI states (manual visual
verification — automated visual-regression is deferred, see Infrastructure reality).
Changing the design system is itself a Material-class CR.

## Security ownership (APIs, endpoints, cyber attacks)

Scanners catch the known, Codex's technical review catches the sloppy, its separate
security session catches the clever,
monitoring catches whoever gets through.

- **CI (deterministic) — DEFERRED (see Infrastructure reality):** SAST, dependency
  scan, secret scan, **targeted/full DAST** are the *target*; until CI/staging exist,
  the substitute is Codex code-level review + its adversarial security session + the CR's
  executable harness (authz/tenant/abuse assertions), and `node --check`. Do not
  reject for the absence of these scanners; reject only if the substitute is missing.
  When CI exists, restore the automated form. Adversarial prompt corpus if the product
  has an AI layer — every new finding joins the corpus. **Blocking policy:** block when
  Critical; when High and
  reachable/exploitable; or when involving secrets, auth bypass, cross-tenant
  access, remote-code execution, destructive actions, or sensitive-data exposure.
  All other findings meeting the organization's reporting threshold require a
  documented owner and remediation deadline; informational findings may be
  recorded without assignment.
- **Codex (code level):** parameterized queries only, strict input validation at
  every endpoint, explicit response DTOs, correct token lifetime/rotation.
- **Codex security session (adversarial logic):** cross-tenant isolation above all — can tenant A
  reach tenant B's data or actions? Tested on every CR touching a data or action
  path. Plus privilege escalation, abuse paths, prompt-injection into AI actions.
- **CI/CD (runtime):** rate limiting at proxy and app layer; automated abuse
  detection and blocking at layers appropriate to the actual architecture (the
  tool is chosen per stack, not mandated); alerts on auth-failure spikes and
  per-tenant anomalies (extends step 12).
- **Human (scheduled, outside the pipeline):** infra hardening review
  (monthly/quarterly); independent penetration test before major launches.

## Annex A — Execution optimization (parallelism, not gate removal)

Target: ≤10–20% active-time overhead vs. a sole agent. Every gate above remains;
this annex removes serialization, never checks.

1. **Incremental CI** — Claude commits continuously during Build; CI validates
   each commit in the background. Source validation is green by build-end;
   serial CI cost ≈ 0.
2. **Parallel gates** — the pre-build reviews (technical + security) run simultaneously, as
   do the code-stage Test and Security Review (code). Cost is the
   max of the pair, not the sum.
3. **Diff-scoped depth** — full-depth AI testing on paths the CR touched;
   deterministic regression suite on everything else. The security session's cross-tenant probing
   remains mandatory on every data-path change.
4. **Automated smoke suites** — staging and live checks execute scripted
   acceptance-criteria suites; Codex reviews the results rather than explores
   manually. Suites are versioned and extended by the learning rule.
5. **Non-blocking soak** — the deploy lock releases when the live check (step 11)
   passes; soak proceeds in parallel and delays only CR closure, never the next
   deployment. On a breach with multiple CRs in soak, recover the most recent
   first.
6. **CR sizing** — overhead is per-CR; batch small related changes into one CR.
   Well-sized CRs amortize overhead below 10%.

Steady-state expectation: ~80 min serial overhead on a full-day feature (+19%),
sub-10% with batching. The irreducible floor (~45–60 min) is the security and
quality testing itself and must not be optimized away.


## Fast lane (cosmetic-only CRs)

A CR that the deterministic classifier (`classify.cjs`) proves touches ONLY cosmetic
files (css/scss, md, images — no .js/.ts/.sql/route/auth/config/migration) skips the
full team review and runs a short lane owned by Claude:

1. **classify** — `classify.cjs` confirms cosmetic-only. This is a FLOOR: it cannot
   be overridden downward. If a CR touches any substantive file, it is TEAM, period,
   regardless of how small it looks or what Claude proposes.
2. **build + self-test** (Claude) — implement + quick build/smoke check.
3. **deploy** (human) — run the deploy command, paste the output into the CR.
4. **close** (Claude) — short closure note.

The fast lane trades the heavy gates (dual review, security/adversarial, staging,
soak, dual sign-off) for speed on changes that provably cannot affect logic, data,
auth, or contracts. Claude's judgment may ESCALATE a FAST CR up to TEAM if it senses
hidden risk, but may NEVER pull a TEAM CR down to FAST. The floor is one-way.
