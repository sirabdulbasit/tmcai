# AGENTS.md — Working Contract for Coding Agents on tmcai (Nexeo)

**Owner:** Basit Ahmed (user 2, tenant TMC-0001). **Product name:** Nexeo — never MyOS/HaseebOS/"TMC AI" in new work (internal `brain_*` table/route names stay for stability).

Two agents work this repo in fixed roles:

| Role | Agent | Responsibility |
|---|---|---|
| **BUILDER** | Codex | Implement, test, document. **Never commit, push, or deploy.** |
| **REVIEWER / RELEASE GATE** | Claude | Independently re-verify every claim, gap-analyze, enforce conventions, then commit → push → guide Basit's production deploy. |

Basit triggers the gate by telling Claude **"review and deploy"**. If Claude finds gaps, it raises them and holds; otherwise it ships and appends its verification + deploy record to `Changes_Made.md`.

---

## 1. BUILDER (Codex) — duties and hard limits

**Do:**
- Implement fixes/features on branch `feat/nexeo-one-brain`. Leave all work **uncommitted in the working tree**.
- Document EVERY change in **`Changes_Made.md`** (repo root, append a dated section). This is the binding handoff contract. Include: observed behavior, confirmed root cause (from code, not hypothesis), files changed (complete list — omissions have been caught before), tests added, exact verification numbers, known issues deliberately not fixed, and whether a migration is included.
- For every bug that came from a real Brain conversation: append a `## Chat N` entry to `server/docs/brain_chat_archive.md` **and** a paired executable `chatN` scenario in `server/tests/brainScenarios.ts`. The archive-sync meta-test enforces this pairing — the suite goes red if you add one without the other.
- Verify before handoff, from `tmcai/server/`:
  ```bash
  npx tsc --noEmit        # must be clean
  npx vitest run          # must be 0 failed, no unhandled errors
  npm run build           # must pass
  git diff --check        # must be clean
  ```
  Report the EXACT numbers in `Changes_Made.md`. They will be independently re-run; inflated or stale numbers break trust.

**Never:**
- Never commit, push, deploy, or run anything against production.
- Never run `prisma migrate dev` (migration-ledger drift). New schema = a new folder under `server/prisma/migrations/<date>_<name>/migration.sql`, written **idempotently** (`IF NOT EXISTS`, guarded `DO $$` blocks), plus matching `schema.prisma` models. Runtime code must never `CREATE TABLE` — schema comes from migrations only.
- Never send real email/WhatsApp/calendar invites from tests or scripts; providers stay mocked.
- Never touch, delete, or commit these user-owned files: `server/docs/nexeo_self_learning&development.md`, `tenant-scope-audit-2026-05-22.md`. Never stage `.env`, tokens, or `whatsapp-sessions/`.
- Never reset/discard the working tree — it may contain other agents' in-flight work.

## 2. Product invariants (violations are release blockers)

1. **Tenant isolation — zero tolerance.** Every query scoped by `client_number` (+ `user_id` where applicable). No default-tenant fallbacks in runtime paths (`|| 'TMC-0001'` class). Caches must be tenant-keyed.
2. **The Brain never speaks or acts as the user** without an explicit user-initiated chain. Tenant WhatsApp sends identify as the assistant.
3. **No hardcoded judgment.** Criticality/urgency/substance decisions are LLM-with-context; regex may pre-filter, never decide.
4. **No hardcoded Brain replies.** Every user-facing Brain sentence is LLM-generated OR a bracketed `[system marker]` rendered by `answerSanitizer`. A hardcoded English sentence pretending to be the Brain is forbidden.
5. **No fabricated completion.** Success wording only after a confirmed dispatch; `unconfirmed` never renders as done. Don't weaken `shouldInterceptCompletionClaim` / `EMPTY_PROMISE_RE` — gate, don't delete.
6. **Fail closed.** Missing metadata/schema/ledger ⇒ visible degradation ('unknown'/'unsupported'), never silent success. Mutating jobs without their audit ledger must not mutate.
7. **Cleanup is deterministic, reversible, capped.** Quarantine → grace → soft-close with audit metadata; never hard-delete user data; never let an LLM decide deletions.
8. **Data windows/thresholds** go through `behaviorConfig` (user → tenant → env → default, clamped) — no new scattered constants for tunable behavior.

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

## 5. REVIEWER (Claude) — what the builder's work will be judged against

On "review and deploy", Claude will: reread `Changes_Made.md` **and** the raw diff; re-run tsc/vitest/build and compare against the documented numbers; check archive↔scenario pairing, tenant scoping, invariant touches, migration idempotency + deploy ordering, and whether the fix covers the **class**, not just the reported instance; then either raise gaps (hold) or commit/push/deploy-guide and append the outcome to `Changes_Made.md`.

Write for that audience: claims you can't back with a command output will stall the release.
