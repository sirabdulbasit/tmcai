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
