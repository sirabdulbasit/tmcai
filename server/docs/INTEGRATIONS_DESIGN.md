# Integrations — design (Admin → Integrations)

**Status:** Stage 1 in build (DEF-354), 2026-10-26. Owner scope 2026-10-23: core wizard first; map
targets KPI numbers, people/contacts, feed events, Brain knowledge; sources Google Sheet first,
then REST, Odoo, Qlik; UI under Admin.
**Ported from:** vm `Documentations/06_INTEGRATION.md` (§7 screens, §8 failure rules, §9
invariants). Draft + adversarial critique against both codebases: 2026-10-26 workflow
`integration-port-understand`. Every critique correction is applied below.

## 1. What it does

An admin opens **Admin → Integrations** and connects an outside system in five steps —
**Basics · Connect · Review the mapping · Schedule · Test & turn on** — after which Nexeo keeps
Brain's data current from it. A run writes only what the admin approved, field by field, on one
mapping version; a blank never overwrites; identity fields are never written; what was written is
recorded in the same transaction as the write; nothing crosses a tenant.

The model works at **design time only** (proposing what each source field means). Every run is
deterministic code. `services/integrations/engine/**` imports no AI provider (test-pinned).

## 2. Stage 1 — Google Sheet → five steps → KPI numbers → Brain

Shippable on its own. Later stages add writers and readers to the same skeleton (§6).

### 2.1 Data model (migration `20261026_integrations_core`, hand-written, idempotent)

All tables: `client_number VARCHAR(20) NOT NULL`, every timestamp `TIMESTAMPTZ`, children
`ON DELETE CASCADE`, composite indexes lead with `client_number`, models added to
`TENANT_SCOPED_MODELS` (`src/db/prisma.ts`). Raw SQL always carries `client_number` explicitly.

| Table | Purpose |
|---|---|
| `integration_syncs` | One integration: name, purpose, admin brief, `source_kind` (`gsheet` in Stage 1), `source_config` (sheet id, gid, tab label), `status` DRAFT/ACTIVE/PAUSED, schedule (`frequency` daily/weekly/monthly/once, `run_time`, `day_of_week`, `day_of_month`, `timezone` taken from the creator via `resolveUserTimezone`, validated), `change_cap_pct`, `blank_policy`, `connection_tested_at` + `connection_fingerprint` (sha256 of the route config at the last OK test), `activated_at`, `approved_version_id`, `last_slot_at`, `next_run_at`, `last_run_at`, `last_run_status`. DB CHECK: ACTIVE ⇒ activated_at and approved_version_id set. |
| `integration_mapping_versions` | Numbered proposals; `spec` (filter, coverage, provider), `ai_summary`, admin prompt. Partial unique: one APPROVED per integration. |
| `integration_suggestions` | One row per FIELD decision (never per record): `target_kind`, `source_field`, `target_key`, `transform`, `coverage`, `samples`, `reason` (blast radius / set-aside arithmetic), status PENDING/APPROVED/REJECTED/SET_ASIDE/BLANK, `carried_from_id`. |
| `integration_runs` | One run: dry_run, trigger manual/scheduled, triggered_by, status RUNNING/SUCCESS/PARTIAL/FAILED/ABORTED, counts (read, filtered, subjects, writes, set aside, blanks, change %), `result` JSON, `connection_fingerprint` + `mapping_version_id` tested. Partial unique: one RUNNING per integration (the run mutex). |
| `integration_run_changes` | OUTCOME rows (`cuid` id — a BigInt id cannot be JSON-serialised): subject, target, before → after. Live runs: written in the same transaction as the data. Dry runs: preview rows. |
| `kpi_definitions` | Tenant KPI catalogue: `kpi_key` (unique per tenant), label, unit, direction, grain, `source_integration_id` (one owner), is_active. |
| `kpi_readings` | Dated measurements: unique `(client_number, kpi_key, period_start, dimension_key)`, `value NUMERIC`, `integration_id`, `run_id`. A missing reading is no row, never 0. |

`kpi_values` (Steering Wheel ops metrics, no unique key) is left untouched. Deleting an
integration removes its versions, suggestions and run history (cascade); KPI readings it wrote stay.

### 2.2 Source: Google Sheet

- Link parsing ported from vm `integrationSheetLink.ts`: the export URL is **rebuilt from the
  sheet id and gid alone** (`https://docs.google.com/spreadsheets/d/<id>/export?format=csv&gid=<gid>`),
  so a pasted link can never send the server anywhere else. A tab is never silently swapped.
- **Private sheets read through the tenant's designated Google account** —
  `system_config.google_drive_org_user_id`, the same admin-chosen account the org Drive scribe uses
  (`folderScribeService.pickTenantScribeUser`). No new consent, no new GCP redirect URI, no
  per-integration token. Public "anyone with the link" sheets need no account.
- **CSV, not xlsx.** Nexeo's `xlsx@0.18.5` has published CVEs and must not parse untrusted
  workbooks; the CSV export is parsed by a small RFC 4180 parser. Excel upload is deferred until a
  safe parser is pinned.
- Caps (behaviorConfig): 10 MB, 60 s, 50k rows. An HTML answer = "not shared / sign-in needed".
- **Test before anything else:** Connect reads the sheet for real; a 200 with 0 rows is not OK.
  "Suggest the mapping" stays disabled until the test passed, and editing the link clears it.

### 2.3 Mapping (design time)

- **Field inventory** from ALL rows: fill rate, inferred type, 2–3 real values, distinct values
  when few (ported vm `discoverSourceFields`/`buildFieldCoverage`).
- **KPI target shapes** (both are common in sheets of monthly numbers):
  - *long*: one value column + a period column (+ optional dimension column, e.g. Region);
  - *wide*: one column per period — transform `{unpivot: {columns, periodFrom: 'header'}}`.
- **Proposer** (`callLLM` via `llmRouter`, `purpose: 'integration_mapping'`) gets the brief, the
  admin's prompt, the inventory with samples, the active KPI catalogue, approved rows (kept) and
  rejected pairs (settled). It may propose **new KPI definitions** (key, label, unit); approving
  the row creates the definition. It returns field-wise rows plus "could not be done" notices.
  Output keys outside the catalogue are dropped; arithmetic risk checks (never populated, value
  not numeric) turn a row into SET_ASIDE with the numbers in `reason`.
- A new proposal is a new version that **carries every approved row** and proposes only the rest.
  The approved version keeps running until the new one is approved.

### 2.4 Run engine (execution time)

`runIntegration(cn, id, {dryRun, trigger, triggeredBy, versionId?})`:
1. Load `{id, clientNumber}`; live runs need `approved_version_id`; dry runs use the on-screen version.
2. Insert the run row — the partial unique index is the mutex (`RunBusyError` → 409 / skip).
3. Read the sheet; header check — a column the approved mapping reads is missing ⇒ FAILED.
4. Plan per record from the APPROVED rows of that version only (computed now, never stored).
   Blank ⇒ skip + count (never overwrite). Non-numeric ⇒ skip + count.
   An approved row whose KPI definition is inactive/deleted ⇒ **the run FAILS** (vm §9).
5. Change cap: a **scheduled** run changing more than `change_cap_pct` of the readings this
   integration already owns ⇒ ABORTED, nothing written. Manual runs are never capped; a first load
   (owns 0) never trips. **Dry runs report the cap verdict as a scheduled run would.**
6. Dry run: store preview change rows, SUCCESS, write nothing else.
7. Live: ONE transaction — all KPI upserts (`ON CONFLICT … DO UPDATE … WHERE value IS DISTINCT
   FROM EXCLUDED.value`) + their change rows. Any failure ⇒ nothing written, FAILED.
   (vm §9 "a failed run records no measurement"; AGENTS §2.6 "no mutation without its ledger".)
8. Counts are distinct subjects; "Updated" only when something was written, else "No changes".

### 2.5 Schedule and turn-on

- `integration_sync_dispatcher`: `protectedJob(..., 'maintenance')` every 60 s in `server.ts`, plus
  the missed-run list and `docs/background_jobs_inventory.md`. Reads ACTIVE integrations (the only
  cross-tenant read, explicit `runWithoutTenant`), claims each due slot atomically
  (`UPDATE … SET last_slot_at = $slot WHERE … AND activated_at <= $slot AND (last_slot_at IS NULL
  OR last_slot_at < $slot)`), then starts the run. Max 2 concurrent (behaviorConfig).
- **Boot sweep:** every RUNNING row at startup becomes FAILED "interrupted by server restart".
- **Turn on** = one transaction: the version has ≥1 approved row, **a SUCCESS dry run exists for
  that same version with the current connection fingerprint**, schedule valid; approve the version,
  set `ACTIVE`, set `activated_at = now()` only if not already active, compute `next_run_at`.
  **Turning on never runs anything**, and no slot before `activated_at` is ever owed.

### 2.6 API

`server/src/routes/admin/integrationAdminRoutes.ts`, mounted at `/api/v1/admin/integrations`
**before** the generic `/admin` router (`app.ts:186`), whose 30 req/min `adminLimiter` would 429
the wizard's polling. Own limiter (behaviorConfig, default 240/min). `requireAuth` + admin role;
tenant = `req.user.clientNumber` (SuperAdmin may name another tenant explicitly).

`GET /` · `POST /` · `GET/PUT/DELETE /:id` (PUT is a closed whitelist — never status, approval,
activation) · `GET /:id/connection-check` · `POST /:id/propose/start` + `GET /:id/propose/status`
· `GET /:id/suggestions` · `POST /:id/suggestions/approve|reject` · `POST /:id/run/start` +
`GET /:id/run/status` · `GET /:id/runs` · `GET /:id/runs/:runId/changes` · `POST /:id/activate` ·
`POST /:id/pause` · `GET/POST /kpi-definitions`.

### 2.7 Client

`client/src/pages/admin/integrations/` — `IntegrationsTab` (list grouped **Working · Paused · Being
set up**, each headed with its count, empty groups hidden, stage derived from facts, never a stored
pointer), `IntegrationWizard` + one component per step, `RunHistory`, `WorkingOverlay` (elapsed
time while the AI proposes or a run executes). Added as a client sub-tab of `AdminPage.jsx`, using
its `msg/setMsg` props and the ConnectorsPage visual tokens.

### 2.8 Brain sees the numbers

New read-only Brain tool **`fetch_kpis`** in `services/knowledge/brainTools.ts` (tenant-scoped;
optional KPI key / period range; latest readings by default). The model decides when to call it
— no keyword regex. Reaches the reasoning compose path; the legacy composer is not extended (one
implementation, not two).

## 3. Rules carried from vm §8/§9 (each pinned by a test that fails when weakened)

Blank never overwrites · identity/account fields unwritable · proposable ≠ writable (approval is
the only write permission, version-scoped) · permissions never accepted from the client (closed
PUT) · a new proposal keeps what is approved · one field, one owner (`kpi_definitions.source_integration_id`)
· field-wise approval, never per record · distinct-subject counts · change cap on scheduled runs
only · dry run and aborted run write nothing · audit = outcome, same transaction · unconfigured
target fails the run · failed run records no measurement · enabling never triggers a run · test
before turn-on, bound to version + connection fingerprint · the tested connection is the one runs
use · timestamptz everywhere · no model on the execution path · tenant scoping on every query.

## 4. Pre-existing defects found while designing (logged, not fixed in Stage 1)

DEF-355 global `WEBHOOK_SECRET` with tenant from URL (`webhookRoutes.ts`) · DEF-356 `configService`
key `slice(0,32)` truncation · DEF-357 `entitySweepService` tenant-less `person:*` primary key
(blocks the contacts writer) · DEF-358 `connectorService` plaintext fallback + unsigned OAuth state ·
DEF-359 `clientConnectorRoutes.pickTenant` cross-tenant override.

## 5. Owner questions — answered by default (say if you want otherwise)

1. Private sheets are read through the tenant's designated Google account (the one Admin → Client
   Connectors already uses). No new consent.
2. KPI numbers are tenant-wide business data (an admin set them up). Contacts, in Stage 2, follow
   the existing ruling: only the user decides a contact becomes tenant-wide.
3. Deleting an integration removes its history; the KPI readings it wrote stay.

## 6. Later stages

2a people/contacts (after DEF-357) · 2b feed events (needs recipient users — `FeedEvent` reads are
user-scoped — and an `ingest()` guard for publish/scribe/sentiment/propagation) · 2c knowledge
pages (through the existing `org_doc` upsert, not a second wiki writer) · 3 generic REST
(SSRF guard with pinned DNS, same-origin paging, declared-total completeness, test-before-store
credentials, DEF-356 fix first) · 4 Qlik (loopback only for `source_kind='qlik'` behind a
SuperAdmin-set per-tenant flag — the bridge has no tenant concept) and Odoo (reuse the per-tenant
`odoo_*` config). Excel upload once a safe parser is pinned.
