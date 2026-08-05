# Project agent instructions — tmcai (Nexeo)

**`AGENTS.md` is the canonical working contract** (roles, product invariants, conventions,
environment facts, release protocol). Read it first. `APP_MENTAL_MODEL.md` is the
architecture map. This file holds the short-form stack notes only.

> **Orch pipeline removed 2026-07-31 (owner decision).** This project builds directly, with
> no CR files, no classifier, and no independent review gates. Nothing here should be read
> as requiring a Change Request.

## Stack notes

- **Runtime:** Node + TypeScript. Backend `server/` (Express, entry `server/src/server.ts`,
  port **4002** per `server/src/config/env.ts:76`); frontend `client/` (React/Vite).
- **Scripts** (`server/package.json`): `npm run build` = `prisma generate && tsc`;
  `npm test` = `vitest run`; `npm start` = `node dist/server.js`.
- **Standing verification matrix, run from `server/` before any handoff** (AGENTS.md §5):
  `npx tsc --noEmit` (clean) · `npx vitest run` (0 failed — ~1185 tests) · `npm run build`
  (passes) · `git diff --check` (clean). Report the EXACT numbers, and re-run them AFTER
  the last edit — a figure measured before a later change is stale, not evidence.
- **Database:** PostgreSQL + Prisma. Hand-written idempotent migrations only
  (`server/prisma/migrations/<date>_<name>/migration.sql`); NEVER `prisma migrate dev`,
  never `npx prisma` on prod, never `CREATE TABLE` from runtime code.
- **Branch:** work lands on `feat/nexeo-one-brain`. Stage only intended paths — never
  `git add -A`.
- **Deploy: owner-executed by design.** Basit runs every production command himself. Every
  deploy block handed to him MUST end with a **"How to test"** section stating the exact
  checks and what success vs failure looks like.
- **Never touch/commit:** `.env`, tokens, `whatsapp-sessions/`,
  `server/docs/nexeo_self_learning&development.md`, `tenant-scope-audit-2026-05-22.md`.
- **Product name is "Nexeo"** — never MyOS / HaseebOS / "TMC AI" in new work (internal
  `brain_*` table and route names stay as-is for stability).

## Working protocol for Brain changes (owner ruling, 2026-08-05)

THREE documents govern every Brain change. All are updated in the SAME session as the work:

- `server/docs/brain_change_log.md` — errors recorded → root cause → solution → commit →
  DEPLOYED? → verification. Stable `DEF-NNN`. `DEPLOYED` is never the same as `VERIFIED`.
- `server/docs/brain_chat_log.md` — every chat log the owner sends, as `CL-NNN` with
  date-time and what was OBSERVED (their side, before diagnosis), plus what went RIGHT.
- `server/docs/brain_evaluation_chart.md` — are we moving ahead? A row PER DEPLOY with
  predicted impact and regression risk written BEFORE, observed result written AFTER, and a
  verdict (PROGRESS / NEUTRAL / REGRESSION / UNVERIFIED). Holds the capability state, the
  recurrence table and the trend.

**The three rules:**

1. **Log first.** A chat log gets its CL row, and each observation a DEF id, the same
   session it arrives. A defect that lives only in a chat message will be lost — that is
   exactly what made months of real progress look like circling.
2. **Every change moves a row.** No fix ships without its DEF row updated (resolved
   date-time, commit, verification). A defect reaches §3 only with root cause + fix commit
   + executable scenario + live acceptance for anything on a messaging path.
3. **Check all three docs BEFORE coding, and say the verdict out loud:** *progressing* (new root
   cause, first occurrence) or *circling* (symptom tag already in the chart §3 — the earlier fix
   failed to close the class, so a STRUCTURAL fix is required, never another patch on the
   reported instance).

## Regression discipline (survives the pipeline removal)

Every Brain bug reported from a real conversation gets BOTH:

1. a `## Chat N` entry in `server/docs/brain_chat_archive.md`, and
2. a paired executable `chatN` scenario in `server/tests/brainScenarios.ts`.

`tests/brainRegression.test.ts` enforces the pairing and goes red if one exists without the
other. This caught a real miss on 2026-07-31 — an archive entry was committed without its
scenario and the suite was left failing on `origin`.

## Reference standards kept from the pipeline

`SECURITY_MODEL.md` (ten-bucket security triage) and `TESTING_MODEL.md` (harness quality
standard: requirement fidelity, named assertions per criterion, mutation checks) are kept
as engineering standards. They mention review gates that no longer exist — ignore the gate
mechanics, apply the substance.
