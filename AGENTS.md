# AGENTS.md — Working Contract for Coding Agents on tmcai (Nexeo)

**Owner:** Basit Ahmed (user 2, tenant TMC-0001). **Product name:** Nexeo — never MyOS/HaseebOS/"TMC AI" in new work (internal `brain_*` table/route names stay for stability).

Two agents work this repo in fixed roles. **Roles flipped by Basit on 2026-07-21** (previously Codex built and Claude reviewed):

| Role | Agent | Responsibility |
|---|---|---|
| **BUILDER / RELEASE** | Claude | Investigate, implement, test, document, commit, push, and hand Basit the production deploy commands. Self-verification is mandatory and published with exact numbers. |
| **REVIEWER / ADVISOR** | Codex | Review published diffs and `Changes_Made.md` sections; give expert opinion, gap findings, and alternative approaches. **Never commit, push, or deploy.** |

Model versions occupying either seat may change without renegotiating this contract. **Change flow (Basit, 2026-07-21):** (1) the BUILDER writes a CHANGE PROPOSAL (intent, root-cause evidence, files to touch, tests planned, risks) and relays it via Basit; (2) the REVIEWER approves or returns objections; (3) on approval the BUILDER implements, self-verifies (exact numbers), commits, pushes; (4) deploy commands go to Basit. Trivial documentation-only edits and ledger records are exempt from pre-approval. **Deployment authorization remains exclusively Basit's — he executes every production command.**

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
4. **No hardcoded Brain replies.** Every user-facing Brain sentence is LLM-generated OR a bracketed `[system marker]` rendered by `answerSanitizer`. A hardcoded English sentence pretending to be the Brain is forbidden. **Exception (agreed 2026-07-17): minimal deterministic transport/activity signals are permitted, including native typing, native recording, reactions, `⏳ Thinking…`, and `🎙️ Listening…`. They may be emitted only for a registered inbound turn, at most once when used as a fallback, and must contain no semantic answer, business judgment, user-intent claim, dispatch claim, or completion claim. They must never replace the Brain's actual answer, and their failure must never block Brain processing.**
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
