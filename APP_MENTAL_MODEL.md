# tmcai — application mental model

> Read ON DEMAND by reviewers (Codex) when a review needs codebase context.
> Structural, not a changelog. Completed 2026-07-28; correct it when a layer moves.
> Deeper canonical docs: `server/docs/brain_architecture.md` (single source of truth for
> the Brain), `server/docs/security_isolation_model.md`, `server/docs/capability_matrix.md`,
> `server/docs/background_jobs_inventory.md`, `server/docs/brain_chat_archive.md`
> (incident/regression log — read before re-fixing any Brain or WhatsApp bug).

## What this application does

**Nexeo** is a private AI chief-of-staff for a small leadership team at TMC. It ingests a
user's real work channels (WhatsApp, Gmail, Google Calendar/Drive, and other connectors),
reasons over them with an LLM, and surfaces what actually needs the user's attention —
then acts: drafting and dispatching messages, creating and delegating open items, chasing
delegatees until a task resolves, and scheduling meetings. The primary user is **Basit
Ahmed** (user 2, tenant `TMC-0001`, also the product owner); Haseeb is a second user in
the same tenant. It is multi-tenant by construction even though one tenant is live today.

Product name in all new work is **Nexeo**. `MyOS` / `HaseebOS` / "TMC AI Intelligence" are
dead names; internal `brain_*` table and route names are kept deliberately for stability.

## Architecture at a glance

- **Backend:** Node + TypeScript, Express. Entry `server/src/server.ts` → `app.ts`.
  Listens on **4002** (`server/src/config/env.ts:76`). Loads `.env` from its **cwd**, so
  pm2 must start from `server/`.
- **Frontend:** React + Vite in `client/`.
- **Database:** PostgreSQL via Prisma (`server/prisma/`). Migrations are hand-written
  idempotent SQL; see Conventions.
- **Background work:** jobs in `server/src/jobs/`, run through `jobRunner.protectedTick`
  (lease + ledger) or `centralCleanupGovernor`. No bare `setInterval` for important jobs.
- **LLM layer:** provider services under `server/src/services/` (`claudeService.ts` and
  siblings), with prompts assembled in `server/src/services/knowledge/brainComposer.ts` —
  the central reasoning/compose path.
- **Channels:** WhatsApp is the most complex and most fragile — see its own section.

### Tenancy / auth model (reviewers should attack this first)

- Every row and every query is scoped by **`client_number`** (the tenant, e.g. `TMC-0001`),
  plus **`user_id`** where the entity is user-owned. `users.user_type` carries the role
  (`SA`, `AD`, …).
- **No default-tenant fallback is permitted in any runtime path.** The `|| 'TMC-0001'`
  pattern is a release blocker, as are non-tenant-keyed caches.
- Auto-discovered entities (contacts/people) are created **user-scoped**; tenant-wide
  visibility is an explicit owner-only opt-in. A feeder must attribute rows to the actual
  feeding user — never to a "pick a tenant user" helper. A real cross-user contact leak
  (2026-05-25) came from exactly that mistake.
- OAuth: one platform OAuth client serves all tenants; tokens are per-user; the tenant row
  only holds the enable gate.

## Key directories & files

| Path | What lives there |
|---|---|
| `server/src/services/knowledge/brainComposer.ts` | The reasoning/compose core: prompt assembly, action schema, dispatch of Brain actions. Very large; the centre of gravity. |
| `server/src/services/whatsapp/` | The whole WhatsApp stack — providers, inbound pipeline, identity, liveness, activity, media. |
| `server/src/services/notifications/tenantWhatsappSender.ts` | The ONLY sanctioned tenant WhatsApp send primitive (Meta notifier → legacy webjs fallback). |
| `server/src/services/openItems/`, `server/src/services/delegation/` | Open items and the §33a delegation-thread spine (capture → classify → notify). |
| `server/src/services/views/` | Canonical read views (e.g. `getTodayCalendar`) so every surface renders byte-identical data. No prisma calls outside this layer for user-facing entities. |
| `server/src/services/userTimezoneService.ts` | All timezone logic. Hardcoded zones / manual UTC math are forbidden. |
| `server/src/services/behaviorConfig.ts` | Tunable business thresholds (user → tenant → env → default, clamped). |
| `server/src/routes/` | HTTP surface, incl. `brainAskRoutes.ts`, `briefRoutes.ts`, `chatRoutes.ts`. |
| `server/src/scripts/seedActionDefinitions.ts`, `seedPromptBlocks.ts` | Registries — action metadata and prompt blocks are SEEDED, and capability prompts are GENERATED from them. |
| `server/tests/*.test.ts` | vitest suite (~90 files / ~984 tests), pure-logic-first with prisma/providers mocked. |
| `Changes_Made.md` | The binding build handoff ledger (repo root). |

## Domain model / core state

- **`users`**, keyed by `client_number` + `user_type`.
- **Open items** — the unit of tracked work; has an owner, optional delegatee, and a
  lifecycle status driven by `actionLifecycleService`.
- **Delegation threads** (§33a, 5 tables, migration `20260722_delegation_threads`) — bind
  an open item to a counterpart and a channel, capture the counterpart's reply, classify it
  strictly, and notify the owner. Flag-gated per tenant.
- **`feed_events`** — normalized inbound from every connector (`source_type` = `gmail`,
  `gcal`, `whatsapp`, …); the substrate all reasoning reads.
- **`entity_person`** and the entity catalog — discovered contacts/companies.
- **Connector state** — `user_connectors` / tenant rows; **`status` is the single truth for
  health**, and `metadata.lastRefreshError` and friends are historical breadcrumbs only.
- **WhatsApp** — `whatsapp_config` (per-tenant channel + `status`),
  `whatsapp_connections` (which phone maps to which user, including `@lid` aliases),
  `whatsapp_messages` (audit).

## Conventions & invariants

Violations are release blockers. Full list in `AGENTS.md` §2; the ones reviewers most need:

1. **Tenant isolation — zero tolerance** (see tenancy model above).
2. **The Brain never speaks or acts as the user.** It must not send from the user's own
   identity (their paired WhatsApp/Gmail) without an explicit user-initiated chain; tenant
   WhatsApp sends identify as the assistant. Structurally guarded by a provenance enum.
3. **No hardcoded judgment.** Criticality / urgency / substance decisions are
   LLM-with-context. A regex may pre-filter; it may never be the decision boundary.
4. **No hardcoded Brain replies.** Every user-facing Brain sentence is LLM-generated or a
   bracketed `[system marker]`. Narrow exception: minimal deterministic transport signals
   (native typing/recording and reactions ONLY — text markers like `⏳ Thinking…` are forbidden, owner ruling 2026-07-31) carrying no
   semantic content, at most once, never blocking Brain processing.
5. **No fabricated completion.** Success wording only after confirmed dispatch;
   `unconfirmed` never renders as done. The Brain also never invents message content,
   senders, timestamps or contact-origin stories — cite only from supplied data blocks.
6. **Fail closed.** Missing metadata/schema/ledger ⇒ visible degradation, never silent
   success. A mutating job without its audit ledger must not mutate.
7. **Surface data parity.** The Day Brief page, Brain Chat UI, and WhatsApp must answer the
   same question identically — every reply routes through the shared compose path.
   Surface-specific shortcuts always resurface as "hallucination" bugs.
8. **Channel tone separation.** Tone samples come from the SAME channel as the
   destination; never pool WhatsApp samples into email drafts.
9. **Cleanup is deterministic, reversible, capped.** Quarantine → grace → soft-close with
   audit metadata. Never hard-delete user data; never let an LLM decide deletions.

## WhatsApp: the fragile layer (read before reviewing anything that touches it)

Treat WhatsApp failures as session/runtime issues first, code second — and check
`server/docs/brain_chat_archive.md` before "fixing" anything, because this subsystem has a
history of the same class recurring.

- Two distinct clients exist: the **tenant** channel (`WebjsProvider` / `MetaProvider`,
  Brain ↔ user and Brain → counterparts) and the **user's own** paired WhatsApp
  (`UserWebjsProvider`, read-only context). Don't conflate them.
- `whatsapp-web.js` is pinned at **1.34.7** and is the fragile dependency. Modern WhatsApp
  addresses the same human under **two interchangeable identities** — a phone Wid
  (`<digits>@c.us`) and a LID Wid (`<digits>@lid`). Comparing raw id strings across those
  namespaces has caused three separate production incidents.
  **`server/src/services/whatsapp/waIdentity.ts` is the single shared resolver — use it;
  a test fails CI if any other module calls the mapping API directly.**
- Channel health is `whatsapp_config.status`, and **only `'connected'` is send-capable**.
  A liveness probe (self-chat + local echo) is the sole promoter to `connected`; `ready`
  alone yields `connected_unverified`. Inbound *replies* go out via `message.reply()` and
  bypass that gate, so the reply path can look healthy while all outbound-to-counterparts
  is withheld — that asymmetry caused a 4-day silent outage (archive Chat 14).
- Prod needs headful Chromium under Xvfb (`nexeo-xvfb.service`, `DISPLAY=:99`); headless
  bootstrap dies on this host. Never restart pm2 with `--update-env` (it poisons `DISPLAY`).
- Incoming WhatsApp **calls are auto-rejected**; there is no outbound calling, no call
  recording, and no call transcription.

## Deploy & environments

- **Local dev:** Postgres + Redis running locally; `npm run dev` in `server/`.
- **Production:** Ubuntu host "deepmarks", repo `/var/www/tmcai`, pm2 app `tmcai-server`
  with `cwd=/var/www/tmcai/server`. Three unrelated apps share the box
  (`tmcai-agents`, `tokr-server`, `vm-server`) — never touch them.
- **Source parity:** the code is identical local and prod; only `.env` differs. Never edit
  code directly on the production host.
- **Who deploys:** **only the owner.** Basit executes every production command himself;
  agents hand him a command block that must end with a "How to test" section. Deploy
  evidence enters the orch ledger as his pasted output.
- The box resolves IPv6-first and external downloads hang: installs there need
  `NODE_OPTIONS=--dns-result-order=ipv4first PUPPETEER_SKIP_DOWNLOAD=true npm install`.
- Production carries **preserved local edits** to `server/package.json` and
  `server/package-lock.json`. If `git pull --ff-only` refuses, stop and report the refusing
  paths — no `reset --hard` / `clean` / `checkout --` as a remedy, ever.
- **Release status semantics:** a messaging-affecting release is **VERIFIED** only after
  live acceptance on production (real inbound text/voice). Until then it is **PARTIAL**,
  even with a fully green local suite.
