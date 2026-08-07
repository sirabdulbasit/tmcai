# AGENTS.md — Working Contract for Coding Agents on tmcai (Nexeo)

> **Orch pipeline removed 2026-07-31 (owner decision).** This project builds directly,
> with no independent review gates. The CR/gate mechanics that briefly governed the
> review sequencing are gone; everything below — the BUILDER/REVIEWER split, the product
> invariants, the codebase conventions, the environment facts, and the verification matrix
> — remains in force. **Owner-only deployment was superseded on 2026-08-07 (see §0).**

## 0. Deploy authority — amended by Basit, 2026-08-07

**Basit transferred production deploy execution to the BUILDER (Claude).** The BUILDER now runs
the production commands himself on the box — `git pull --ff-only`, migrations, `npm run build`,
`pm2 restart tmcai-server` — instead of handing Basit a block to run. This supersedes every
earlier "Basit executes every production command" / "hand him the block, do not run it for him"
clause in this file, in `CLAUDE.md`, and in `HANDOFF_2026-08-07.md` §1/§3/§5.

What did **not** change, and is the price of the authority:

1. **Nothing else about the release protocol is relaxed.** Full verification matrix before the
   push, production HEAD verification (§5), every intervening commit reviewed, no destructive
   git recovery, no `npx prisma` on prod, the preserved local `package.json` /
   `package-lock.json` still untouchable.
2. **Every deploy still gets its evaluation-chart row** — predicted impact and regression risk
   written BEFORE, observed result AFTER, verdict PROGRESS / NEUTRAL / REGRESSION / UNVERIFIED.
3. **DEPLOYED is never VERIFIED.** A messaging-path change is PARTIAL until live acceptance on
   production; the BUILDER says so plainly rather than implying success from a green build.
4. **Post-deploy capability evaluation is mandatory** (Basit, 2026-08-07): after every deploy the
   BUILDER evaluates whether Brain's capability actually moved, records it in
   `server/docs/brain_evaluation_chart.md`, and **notifies Basit when the improvement is
   significant** — a materially closed defect class, not a green test run. NEUTRAL and
   UNVERIFIED deploys are reported in-session without a notification.
5. **Stop-and-report conditions are unchanged and now binding on the BUILDER's own hands:**
   failed pull, dirty tree, failed build, failed migration, failed acceptance. Stop, report, do
   not improvise recovery.


**Owner:** Basit Ahmed (user 2, tenant TMC-0001). **Product name:** Nexeo — never MyOS/HaseebOS/"TMC AI" in new work (internal `brain_*` table/route names stay for stability).

Two agents work this repo in fixed roles. **Roles flipped by Basit on 2026-07-21** (previously Codex built and Claude reviewed):

| Role | Agent | Responsibility |
|---|---|---|
| **BUILDER / RELEASE** | Claude | Investigate, implement, test, document, commit, push, and hand Basit the production deploy commands. Self-verification is mandatory and published with exact numbers. |
| **REVIEWER / ADVISOR** | Codex | Review published diffs and `Changes_Made.md` sections; give expert opinion, gap findings, and alternative approaches. **Never commit, push, or deploy.** |

Model versions occupying either seat may change without renegotiating this contract. **Change flow (Basit, 2026-07-22 — supersedes 2026-07-21):** (1) BEFORE building, the BUILDER writes a CHANGE PROPOSAL (intent, root-cause evidence, files to touch, tests planned, risks) and gets the REVIEWER's approval via Basit; (2) once approved, the BUILDER implements, self-verifies (exact numbers), commits, pushes, and hands Basit the deploy commands — deployment follows the build directly, with Basit's pull/build output as the record; (3) after a successful deploy, the BUILDER sends the REVIEWER a post-deploy update: implementation and documentation SHAs, exact test/build results, complete production pull output, deployed production HEAD, health and acceptance evidence, rollback status, and any deviations, failures, or unresolved gates; the REVIEWER then performs the post-deployment expert review (no pre-deploy diff-review gate). The BUILDER must stop and request renewed approval if implementation materially deviates from the approved proposal — especially on scope, invariants, migrations, dependencies, or production architecture. Failed pulls, dirty-tree conflicts, failed builds, migration or acceptance failures remain stop-and-report conditions; no destructive recovery commands may be improvised. (Accepted by REVIEWER 2026-07-22.) Trivial documentation-only edits and ledger records are exempt from pre-approval. ~~**Deployment authorization remains exclusively Basit's — he executes every production command.**~~ **Superseded by §0 (Basit, 2026-08-07): the BUILDER executes production commands himself.** The "How to test" requirement survives the transfer — the BUILDER now *runs* those checks and reports the exact output, stating what success vs failure looked like (Basit, 2026-07-21).

**Contract precedence:** AGENTS.md is the canonical repository working contract. Both roles follow it unless it conflicts with a newer explicit instruction from Basit, platform/system requirements, tool permission boundaries, or verified evidence that following it would be unsafe or obsolete. In that event, stop, disclose the conflict, and propose an AGENTS.md amendment rather than silently diverging.

---

## 1. BUILDER / RELEASE (Claude) — duties and hard limits

**Do:**
- Implement fixes/features on branch `feat/nexeo-one-brain`. Commit and push completed, self-verified work (stage only intended paths — never `git add -A`).
- Document EVERY change in **`Changes_Made.md`** (repo root, append a dated section). This is the binding handoff contract. Include: observed behavior, confirmed root cause (from code, not hypothesis), files changed (complete list — omissions have been caught before), tests added, exact verification numbers, known issues deliberately not fixed, and whether a migration is included.
- For every bug that came from a real Brain conversation: append a `## Chat N` entry to `server/docs/brain_chat_archive.md` **and** a paired executable `chatN` scenario in `server/tests/brainScenarios.ts`. The archive-sync meta-test enforces this pairing — the suite goes red if you add one without the other.
- Verify before handoff, from `tmcai/server/`:
  ```bash
  npx tsc --noEmit        # must be clean
  npx vitest run          # must be 0 failed, no unhandled errors
  npm run build           # must pass
  git diff --check        # must be clean
  ```
  Report the EXACT numbers in `Changes_Made.md`. The REVIEWER may independently re-run them; inflated or stale numbers break trust.

**Never:**
- Never run anything against production directly — production commands are handed to Basit, who executes them.
- Never run `prisma migrate dev` (migration-ledger drift). New schema = a new folder under `server/prisma/migrations/<date>_<name>/migration.sql`, written **idempotently** (`IF NOT EXISTS`, guarded `DO $$` blocks), plus matching `schema.prisma` models. Runtime code must never `CREATE TABLE` — schema comes from migrations only.
- Never send real email/WhatsApp/calendar invites from tests or scripts; providers stay mocked.
- Never touch, delete, or commit these user-owned files: `server/docs/nexeo_self_learning&development.md`, `tenant-scope-audit-2026-05-22.md`. Never stage `.env`, tokens, or `whatsapp-sessions/`.
- Never reset/discard the working tree — it may contain other agents' in-flight work.

## 2. Product invariants (violations are release blockers)

1. **Tenant isolation — zero tolerance.** Every query scoped by `client_number` (+ `user_id` where applicable). No default-tenant fallbacks in runtime paths (`|| 'TMC-0001'` class). Caches must be tenant-keyed.
2. **The Brain never speaks or acts as the user** without an explicit user-initiated chain. Tenant WhatsApp sends identify as the assistant.
3. **No hardcoded judgment.** Criticality/urgency/substance decisions are LLM-with-context; regex may pre-filter, never decide.
4. **No hardcoded Brain replies.** Every user-facing Brain sentence is LLM-generated OR a bracketed `[system marker]` rendered by `answerSanitizer`. A hardcoded English sentence pretending to be the Brain is forbidden. **Exception (agreed 2026-07-17): minimal deterministic transport/activity signals are permitted: native typing, native recording, and reactions ONLY. Text-marker messages in the thread (`⏳ Thinking…` / `🎙️ Listening…` / `🎙️ Recording…`) are FORBIDDEN — owner ruling 2026-07-31: the working signal must be WhatsApp-native presence, never a message; when native presence and the reaction both fail, the turn shows no indicator. They may be emitted only for a registered inbound turn, at most once when used as a fallback, and must contain no semantic answer, business judgment, user-intent claim, dispatch claim, or completion claim. They must never replace the Brain's actual answer, and their failure must never block Brain processing.**
5. **No fabricated completion.** Success wording only after a confirmed dispatch; `unconfirmed` never renders as done. Don't weaken `shouldInterceptCompletionClaim` / `EMPTY_PROMISE_RE` — gate, don't delete.
6. **Fail closed.** Missing metadata/schema/ledger ⇒ visible degradation ('unknown'/'unsupported'), never silent success. Mutating jobs without their audit ledger must not mutate.
7. **Cleanup is deterministic, reversible, capped.** Quarantine → grace → soft-close with audit metadata; never hard-delete user data; never let an LLM decide deletions.
8. **Data windows/thresholds** go through `behaviorConfig` (user → tenant → env → default, clamped) — no new scattered constants for tunable behavior. **Clarification (agreed 2026-07-17): low-level bounded connector/protocol retry backoffs (e.g. media re-fetch delays, provider retry spacing) are protocol constants owned by their module — they are not business policy and do not belong in behaviorConfig. Protocol constants must remain bounded, deterministic, documented, and tested; add an environment override when operational tuning is justified by production evidence.**

## 3. Codebase conventions

- Registries are the source of truth: action metadata lives on `action_definitions.operationalMetadata` (seeded in `seedActionDefinitions.ts`); capability prompts are GENERATED — never re-introduce hand-maintained capability/connector side-maps.
- Every external-action handler declares `confirmationCapability()` explicitly (parity tests enforce it).
- Background work goes through `jobRunner.protectedTick` (lease + ledger) or the `centralCleanupGovernor` for cleanup; no bare `setInterval` for important/critical jobs. Inventory: `server/docs/background_jobs_inventory.md`.
- Timezones: always `userTimezoneService` (`resolveUserTimezone`, `zonedDayBounds`, …) — never hardcoded zones or manual UTC-offset math.
- Comments explain constraints, not narration; match surrounding style. Tests live in `server/tests/*.test.ts` (vitest), pure-logic-first with mocked prisma/providers.

## 4. Environment facts (deploy pain already paid for — don't relearn)

- Prod: Ubuntu box "deepmarks", repo at `/var/www/tmcai`, pm2 app `tmcai-server`, **port 4002**. Three OTHER apps share the box (`tmcai-agents`, `tokr-server`, `vm-server`) — never touch them.
- The box resolves IPv6-first and external downloads hang. Any install there needs: `NODE_OPTIONS=--dns-result-order=ipv4first PUPPETEER_SKIP_DOWNLOAD=true npm install`. Never `npx prisma` on prod (pulls the wrong major); use the local `node_modules/.bin` via `npm run build`.
- The app loads `.env` from its **cwd** — pm2 must start with `cwd = /var/www/tmcai/server` or `DATABASE_URL` is silently absent.
- Standalone scripts on prod need `node -r dotenv/config dist/scripts/<x>.js`.
- whatsapp-web.js is the fragile layer (@lid chats, sessions going deaf after restarts) — treat WA failures as session/runtime issues first, code second; check the incident archive before re-fixing.
- **Production carries preserved local edits to `server/package.json` and `server/package-lock.json`.** These are never reset, checked out over, stashed away silently, or committed. If `git pull --ff-only` refuses due to any local modification, the REVIEWER stops and reports the exact refusing paths; no destructive git command (`reset --hard`, `clean`, `checkout --`) is permitted as a remedy.

## 5. Release protocol (BUILDER) and review protocol (REVIEWER)

**REVIEWER (Codex) duties:** read the published diff **and** the `Changes_Made.md` section; check archive↔scenario pairing, tenant scoping, invariant touches, migration idempotency + deploy ordering, and whether the fix covers the **class**, not just the reported instance; return findings as expert opinion via Basit. The BUILDER answers every finding with evidence or a fix — findings are never silently dropped. Claims either agent can't back with command output don't count.

**Verification matrix (agreed 2026-07-17):**
- Always: server `npx tsc --noEmit`, full `npx vitest run` (0 failed, no unhandled errors), server `npm run build`, `git diff --check`.
- When client files change: client `npm run build` (Vite chunk-size warnings are non-blocking).
- When Prisma schema or migrations change: use the project-local Prisma version; verify Prisma generation, schema/migration parity, migration idempotency, and deployment ordering; after production application, verify the affected columns/tables through a metadata query without printing `DATABASE_URL` or credentials. Never use `npx prisma` on production.

**Publication — release state is determined from Git, never from handoff prose.** Before publication, the REVIEWER runs `git status --short --branch`, inspects the complete diff, checks branch divergence, and verifies the intended release history. If the release is already committed and the remote branch is in sync, publication is complete: report the existing SHA and proceed to deployment review; **never recreate or re-commit an already-pushed release** (e.g. `7ef719b`). Stage only explicitly listed paths (never `git add -A` / `git add .`); exclude the preserved user-owned files. Use an available authenticated Git publication mechanism. Plain Git over HTTPS is sufficient for this repository; GitHub CLI is not required unless the selected workflow specifically needs it. Release safety depends on verified local/remote SHAs and reviewed file scope, not on a particular Git client.

**Production HEAD verification:** before deployment, record the application release SHA and current `origin/feat/nexeo-one-brain` SHA. Inspect every commit and changed file between them. After `git pull --ff-only`, deployment proceeds only when production HEAD equals the pre-recorded remote SHA, `git merge-base --is-ancestor <application-release-sha> HEAD` succeeds, and all intervening commits were explicitly reviewed. A commit is documentation-only only when its actual file delta contains documentation files exclusively. Any unreviewed application-code change is a stop-and-report condition.

**Deployment Records — `Changes_Made.md` is the two-way ledger.** BUILDER owns implementation sections and appends dated build entries. The REVIEWER appends clearly-marked, append-only **"Deployment Record — <date> — <SHA>"** sections; neither agent edits, reorders, or deletes the other's sections. Each Deployment Record distinguishes four SHAs explicitly:
1. **application release SHA** (the reviewed code commit, e.g. `7ef719b`),
2. **reviewed remote HEAD** (what origin pointed to at review time),
3. **production deployed SHA** (`git rev-parse HEAD` on the box after pull),
4. **documentation/report SHA** (any later docs-only commit recording the outcome, if one is made).
A post-deployment documentation SHA must never be described as the SHA that was live-tested unless production was subsequently pulled to it and retested. The Deployment Record replaces any separate uncommitted `Deployment_Report.md`; the same report is also returned in the REVIEWER's response to Basit. The BUILDER reads the latest Deployment Record before starting new work.

**Operational evidence (agreed 2026-07-17):** production claims may be evidenced by pm2/console logs, screenshots supplied by Basit, terminal output, health-endpoint responses, and schema metadata queries — each bounded (no message bodies, audio, transcripts, secrets, tokens, or `DATABASE_URL`).

**Release status semantics (agreed 2026-07-17):** a messaging-affecting release is **VERIFIED** only after live acceptance passes on production (real inbound text/voice through the affected path). Until then its status is **PARTIAL** — even with all local tests green. **FAILED** = app offline, DB unavailable, WhatsApp cannot reconnect, or the agreed SHA is not running. Never claim live success from unit tests alone.
