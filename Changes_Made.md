# Changes Made by Codex

**Repository:** `/Users/tmc_ai_node_02/TMCAI/tmcai`
**Branch observed:** `feat/nexeo-one-brain`
**Date:** 2026-07-16
**Purpose:** Technical handoff for review, commit preparation, staging validation, and deployment by the next coding agent.

## Scope and ownership

This document records the changes made directly by Codex during the latest debugging and implementation work. The working tree also contains a much larger Brain-hardening change set created by earlier coding passes. Those broader edits must be reviewed independently and must not be attributed to this document unless confirmed from Git history and the diff.

Codex did **not** commit, push, or deploy the changes recorded here.

At the time of this handoff, the repository had many pre-existing modified and untracked files. Do not reset or discard the working tree. In particular, preserve user-owned documents unless the user explicitly includes them in a commit.

## 1. Read-only status answer false-positive analysis

### Observed behavior

In WhatsApp, the user clarified that “exam solution” meant the canonical **EXIM Solution** open item. Brain correctly resolved the item as delegated to Muhammad Yousaf. On the next turn, the user asked:

> Tell me its status.

Brain incorrectly responded with an action-dispatch failure and requested an explicit recipient.

### Confirmed root cause

The reasoning answer interceptor in `brainComposer.ts` applied `claimsCompletion()` to every `decision='answer'`. A correct factual answer such as:

> The EXIM solution item is delegated to Muhammad Yousaf.

matched the completion regex through the phrase `is delegated`. The answer was replaced by the internal `[no action dispatched ...]` marker, and `answerSanitizer.ts` converted that marker into misleading dispatch/recipient language.

An aggravating condition was that legacy imperative classification considered leading `tell` an action verb, so “Tell me its status” could be treated as an action-like turn.

### Existing working-tree correction reviewed by Codex

The current working tree contains a Chat 9 correction that:

- classifies turns as `read_only`, `mutation`, or `ambiguous`;
- distinguishes current-turn completion claims from stative descriptions of existing state;
- gates completion interception on turn intent and dispatch evidence;
- permits grounded read-only status language such as `is delegated` and `was sent`;
- continues blocking answer-only success claims on mutation turns;
- replaces the misleading generic sanitizer wording;
- adds `tests/completionClaimGate.test.ts` and a Chat 9 regression scenario.

Codex independently verified this correction before implementing the preference work below. It is part of the current dirty working tree and must be preserved.

## 2. Immediate internal preference actions

### Observed behavior

The user said:

> Do not read emails older than two weeks. Only brief me on emails that are within two weeks.

Brain responded:

> Before I proceed, please confirm the details and reply “send”.

This was incorrect. Saving a user preference is an internal, reversible operation. It does not contact another person and should not use external-send confirmation semantics.

### Root cause

The action registry already declared `record_preference` as non-external and non-human-facing. However, `gateHumanFacingAction()` in `brainComposer.ts` did not consult that metadata. It used a hard-coded set of action-name exceptions. Since `record_preference` was missing from those exceptions, it fell through to the generic preview:

> Before I proceed, please confirm the details and reply “send”.

### Implementation

**File:** `server/src/services/knowledge/brainComposer.ts`

Added:

```ts
IMMEDIATE_INTERNAL_ACTION_TYPES
```

The set contains internal, reversible actions that should apply immediately:

- `add_open_item`
- `update_open_item`
- `mark_open_item_done`
- `update_contact`
- `set_brain_name`
- `record_preference`

`gateHumanFacingAction()` now checks this set before entering the preview/confirmation flow.

### Result

- `record_preference` executes immediately.
- No pending external action is created.
- Brain does not ask the user to reply `send`.
- External communication and destructive operations retain their existing confirmation policies.

## 3. Canonical email recency preference

### Implementation

**Files:**

- `server/src/services/knowledge/brainComposer.ts`
- `server/src/services/knowledge/userMemoryService.ts`

Added the canonical preference key:

```text
email_max_age_days
```

The Brain action prompt now maps requests such as:

- “Do not read emails older than two weeks.”
- “Only brief me on emails within two weeks.”

to:

```json
{
  "type": "record_preference",
  "key": "email_max_age_days",
  "value": 14,
  "description": "Limit normal email retrieval and briefing to the most recent 14 days"
}
```

The prompt explicitly states that:

- the preference is internal and reversible;
- the explicit user statement is itself sufficient confirmation;
- Brain must not ask the user to reply `send`;
- an explicit one-time request for older email may override the normal horizon without deleting the saved preference.

## 4. Preference validation and normalization

### Implementation

**File:** `server/src/services/knowledge/brainComposer.ts`

When normalizing `record_preference` for `email_max_age_days`:

- the value must be numeric;
- it is rounded to an integer;
- it is clamped to the range **1–365 days**;
- a non-numeric value is rejected.

This prevents malformed memory values from creating an invalid or unbounded email query horizon.

## 5. Email-recency memory resolver

### Implementation

**File:** `server/src/services/knowledge/userMemoryService.ts`

Added:

```ts
CANONICAL_KEYS.EMAIL_MAX_AGE_DAYS
```

and:

```ts
getEmailMaxAgeDays(userId)
```

The resolver:

- reads applicable explicit user memories;
- locates `email_max_age_days`;
- returns `null` when no preference exists;
- converts the stored value to a number;
- defensively clamps it to 1–365 days.

## 6. Email retrieval enforcement

### Implementation

**File:** `server/src/services/knowledge/brainTools.ts`

The `fetch_emails` tool now:

1. Computes its requested lookback, preserving the existing default and hard maximum.
2. Loads the user’s remembered email maximum through `getEmailMaxAgeDays(userId)`.
3. Uses the smaller of the requested window and the remembered maximum for normal queries.
4. Supports an explicit one-turn override only when the current user request clearly asks for older mail.

Added tool input:

```text
explicit_older_override
```

Its description instructs the reasoning model to set it to `true` only when the current user message explicitly asks to search beyond the remembered recency preference.

### Example

Saved preference:

```text
email_max_age_days = 14
```

Normal model request:

```text
last_n_days = 30
```

Effective query:

```text
14 days
```

Explicit historical request:

> Find the email from March.

The tool may use a one-time older override without modifying the stored 14-day policy.

### Day Brief note

The canonical Day Brief email view currently uses a 24-hour window. That window is already narrower than 14 days, so it satisfies the maximum-age policy. The implementation intentionally does **not** broaden the Day Brief to include all email from the previous 14 days.

The next coding agent should audit other email retrieval paths and route them through the same shared policy if they can bypass `fetch_emails`.

## 7. Natural user confirmation

### Implementation

**File:** `server/src/services/knowledge/brainComposer.ts`

After successfully recording `email_max_age_days`, Brain now returns a user-facing confirmation similar to:

> Got it — I’ll limit normal email retrieval and briefing to the most recent 14 days. If you explicitly ask for an older email, I’ll treat that as a one-time override.

The confirmation:

- does not expose the internal preference key;
- does not mention dispatch;
- does not ask for a recipient;
- does not ask the user to reply `send`.

## 8. Action seed import safety

### Problem found during full-suite verification

`tests/capabilityDiscovery.test.ts` imports the action inventory from `seedActionDefinitions.ts`. Importing that module executed `main()`, attempted database seeding, and called `process.exit(1)`. Vitest reported all assertions passing but also emitted an unhandled error.

### Implementation

**File:** `server/src/scripts/seedActionDefinitions.ts`

The seed CLI is now guarded by:

```ts
if (require.main === module) {
  // run CLI
}
```

On direct CLI failure, it sets:

```ts
process.exitCode = 1
```

instead of terminating an importing process.

### Result

- Importing the action inventory is side-effect free.
- Tests do not seed the database.
- Tests do not terminate unexpectedly.
- Direct CLI execution still reports failure through a non-zero exit status.

## 9. Regression tests added

### New test file

`server/tests/preferenceImmediateAction.test.ts`

Coverage includes:

- `record_preference` belongs to the immediate internal-action set;
- the canonical 14-day email policy normalizes correctly;
- the action shape preserves the intended key, value, and description.

Additional self-pruning coverage:

- `server/tests/zombieItemPolicy.test.ts` tests deterministic classification,
  safety vetoes, quarantine, grace-period holding, soft archive, and recovery;
- `server/tests/openItemDraftSelfPrune.test.ts` proves malformed drafts do not
  dispatch reminders and are later soft-closed rather than deleted.

### Related existing regression coverage preserved

`server/tests/completionClaimGate.test.ts` covers the earlier Chat 9 read-only status false-positive and must be included in the deployment candidate.

## 10. Verification performed

The following commands were run from `tmcai/server`:

```bash
npx tsc --noEmit
npx vitest run tests/zombieItemPolicy.test.ts tests/openItemDraftSelfPrune.test.ts
npx vitest run tests/preferenceImmediateAction.test.ts tests/completionClaimGate.test.ts
npx vitest run
npm run build
```

Results at handoff:

- TypeScript no-emit check: **passed**
- Focused self-pruning tests: **10 passed**
- Focused central-governor tests: **3 passed**
- Focused preference/completion tests: **33 passed**
- Full test suite:
  - **75 test files passed**
  - **1 test file skipped**
  - **926 tests passed**
  - **21 tests skipped**
  - **0 failed**
  - no unhandled errors
  - no unexpected `process.exit`
- Production server build: **passed**
  - Prisma Client generation passed
  - TypeScript compilation passed

No live provider sends were performed by Codex.

## 11. Files directly changed or added by Codex

The direct implementation touched:

- `server/src/services/knowledge/brainComposer.ts`
- `server/src/services/knowledge/userMemoryService.ts`
- `server/src/services/knowledge/brainTools.ts`
- `server/src/scripts/seedActionDefinitions.ts`
- `server/tests/preferenceImmediateAction.test.ts` (new)
- `server/src/services/openItems/zombieItemPolicy.ts` (new)
- `server/src/jobs/openItemDraftAskJob.ts`
- `server/src/jobs/openItemsBacklogCleanupJob.ts`
- `server/src/jobs/openItemFollowUpJob.ts`
- `server/src/jobs/centralCleanupGovernor.ts` (new)
- `server/src/jobs/brainResetArchiveCleanup.ts`
- `server/src/server.ts`
- `server/tests/zombieItemPolicy.test.ts` (new)
- `server/tests/openItemDraftSelfPrune.test.ts` (new)
- `server/tests/centralCleanupGovernor.test.ts` (new)
- `server/docs/background_jobs_inventory.md`
- `server/src/scripts/feedEventsPruner.ts`
- `Changes_Made.md` (this document)

These source files already contained changes from earlier coding passes. Review the complete per-file diff carefully; do not assume every changed line in those files belongs to this task.

## 12. Self-pruning for zombie open items

### Problem

Malformed DRAFT residue such as an incomplete title ending in a connector was
eligible for the daily priority/deadline prompt. The existing cleanup jobs
already handle duplicates, stale untouched items, smoke rows, rejected feed
noise, junk contacts, and low-value memory, but they did not protect the DRAFT
prompt path from malformed records.

### Shared deterministic policy

**New file:** `server/src/services/openItems/zombieItemPolicy.ts`

The policy is deliberately rule-based and does not ask an LLM to remove data.
It recognises only high-confidence residue:

- empty or punctuation-only titles;
- a small exact set of placeholder titles;
- incomplete title fragments ending in a connector such as `of`, `to`, or
  `with`, when no useful description is present.

Safety vetoes preserve any item that is critical, active, delegated, noted,
due-dated, user-confirmed, user-edited, or otherwise contains engagement
evidence. Complete conditional work is preserved; there is no person-,
project-, EXIM-, or screenshot-specific hard-coding.

### Recoverable lifecycle

The lifecycle is:

```text
candidate -> quarantined -> held for 7 days -> status=CLOSED
                 |
                 +-> corrected -> recovered automatically
```

Quarantine immediately sets `metadata.selfPrune.suppressProactive=true`, so the
item stops nagging the user. An unchanged item is soft-closed after seven days
with `archivedReason=zombie:<reason>`. Nothing is hard-deleted. The metadata
stores the policy version, reason, detection time, evaluation time, archive or
recovery time, and state for auditability and restoration.

### DRAFT job integration and observability

**Files:**

- `server/src/jobs/openItemDraftAskJob.ts`
- `server/src/jobs/openItemsBacklogCleanupJob.ts`
- `server/src/jobs/openItemFollowUpJob.ts`
- `server/src/server.ts`

The hourly DRAFT job evaluates self-pruning before it constructs or sends a
reminder. It now reports `quarantined`, `selfPruned`, and `recovered` counters.
The hourly backlog reducer applies the same lifecycle to passive `NEW`,
`TRIAGED`, and legacy `open` items, and reports separate zombie quarantine,
archive, and recovery counters. The daily smart follow-up job skips every item
whose self-pruning metadata suppresses proactive contact, avoiding both an LLM
call and an owner notification.

While integrating the shared policy, the backlog query was corrected to select
the real `notes`, `delegateeId`, `delegateeName`, and `delegateeEmail` fields.
Its stale-item safety check now uses those selected fields rather than missing
properties, preventing engaged or delegated items from being mistaken for
untouched backlog.

Quarantine and archive events log only the item ID and deterministic reason;
message content is not logged.

## 13. Central cleanup governor

### Architecture

**New file:** `server/src/jobs/centralCleanupGovernor.ts`

Autonomous cleanup now has one scheduler and one reliability boundary. The
server runs `central_cleanup_governor` every five minutes through the existing
protected job runner. That provides the cross-replica durable database lease,
persisted run ledger, bounded retry policy, and escalation behavior once for
the entire cleanup system.

The governor centrally declares and schedules eleven domain workers:

1. context-memory expiry — hourly;
2. open-item backlog and zombie pruning — hourly;
3. system-log retention — hourly;
4. expired action-idempotency key cleanup — daily;
5. expired approval-token cleanup — daily;
6. conservative contact duplicate pruning — daily;
7. evidence-based smart contact cleanup — daily;
8. inferred user-memory decay — daily;
9. reversible reset-archive TTL cleanup — daily;
10. wiki-memory consolidation — daily;
11. feed-event pruning after durable scribe verification — daily.

Workers execute sequentially to bound database pressure. Failure of one worker
does not prevent later workers from running. Only successful workers advance
their individual cadence; failed workers remain due for the next protected
tick or retry. Logs contain task IDs, status, duration, and bounded errors—not
user data or message content.

### Removed duplicate scheduling

Independent timers were removed from `server.ts` for context-memory cleanup,
smart contact cleanup, memory consolidation, contact pruning, memory decay,
open-item backlog cleanup, and feed-event pruning. Log retention was removed
from the mixed system-log health timer and placed under the governor; log
escalation and repair remain in the health timer because they are self-healing,
not retention. The reset-archive worker's module-level scheduling function was
removed, leaving an implementation-only worker.

The separate `node-cron` schedules for action-idempotency cleanup and
approval-token cleanup were also removed from `schedulerService.ts`; both are
now daily governor tasks.

Scribe backfill retains its operational schedule because it creates the durable
archive prerequisite; only the destructive feed-prune phase is a cleanup task.
DRAFT prompting also retains its workflow schedule, while consulting the shared
self-pruning policy before any outbound message.

### Tests and operational documentation

`server/tests/centralCleanupGovernor.test.ts` verifies:

- one unique central manifest;
- all eleven governed domains and their bounded cadence;
- sequential failure isolation;
- continuation after a worker failure;
- successful-task cadence advancement;
- failed-task retry eligibility.

`server/docs/background_jobs_inventory.md` and the manual feed-pruner script
documentation now identify the central governor as the scheduling authority.

No schema migration is required for this consolidation.

## 14. Known separate issues not fixed by this change

The screenshot also showed separate data-quality and proactive-notification issues. They were analyzed but intentionally not mixed into the preference fix:

1. A complete conditional WhatsApp task may be legitimate even if its contact
   is unresolved. The self-pruner intentionally preserves it; action-state
   reconciliation should decide whether it is a real commitment.
2. The Day Brief can say there are four open items while narrating only two and summarizing the rest as “two others.”
3. Three calendar entries named `Office` may be legitimate distinct provider events or duplicate ingestion; provider event IDs must be inspected before changing data.
4. Email retrieval paths outside `brainTools.fetch_emails` should be audited for consistent maximum-age enforcement.

Do not silently mutate existing user records to correct these. Diagnose each issue, add tests, and use a reviewed cleanup or user-confirmed correction path.

## 15. Deployment instructions for the next coding agent

Before staging or committing:

1. Run:

   ```bash
   git status --short
   git diff --check
   git diff --stat
   git diff
   git log -3 --oneline --decorate
   ```

2. Separate:

   - runtime source changes;
   - required migrations;
   - regression tests;
   - operational documentation;
   - unrelated user-owned files.

3. Review the broader uncommitted hardening work, including the operational migration under:

   ```text
   server/prisma/migrations/20260714_ops_hardening/
   ```

4. Verify no secrets, `.env`, tokens, WhatsApp sessions, provider credentials, or local runtime data are staged.

5. Re-run:

   ```bash
   cd server
   npx tsc --noEmit
   npx vitest run tests/centralCleanupGovernor.test.ts
   npx vitest run tests/zombieItemPolicy.test.ts tests/openItemDraftSelfPrune.test.ts
   npx vitest run tests/preferenceImmediateAction.test.ts tests/completionClaimGate.test.ts
   npx vitest run
   npm run build
   ```

6. Apply migrations in staging before starting the new server build.

7. Use test accounts for staging validation. Do not send real user email, WhatsApp messages, or calendar invitations.

8. Validate this exact preference flow in staging:

   > Do not read emails older than two weeks. Only brief me on emails that are within two weeks.

   Expected:

   - immediate preference save;
   - no preview;
   - no pending send action;
   - no “reply send” instruction;
   - natural 14-day confirmation.

9. Validate email boundary behavior with test messages at 7, 13, and 15 days old.

10. Validate explicit historical override without changing the stored preference.

11. Validate the Chat 9 sequence:

    - “Tell me about the exam solution.”
    - “I am talking about EXIM Solution.”
    - “Tell me its status.”

    Expected: canonical status response with no dispatch/recipient failure.

12. Confirm external sends still preview and destructive actions still require explicit confirmation.

13. In staging, insert a non-critical DRAFT fixture with an incomplete title,
    confirm it is quarantined without outbound contact, correct the title and
    confirm automatic recovery. Separately backdate a quarantined fixture by
    more than seven days and confirm it is soft-closed with audit metadata.

14. Deploy production only after staging migrations, tests, health checks, restart checks, tenant-isolation checks, and controlled provider validation pass.

## 16. Git and deployment state at handoff

- Latest direct changes: **uncommitted**
- Pushed by Codex: **no**
- Deployed by Codex: **no**
- Server build artifact verification: **passed locally**
- Live provider verification: **not performed**

The next agent must report actual commit hashes, push state, migration state, staging result, and deployed revision based on Git and deployment tools rather than assumptions.

## 17. WhatsApp QR inbound provider isolation (2026-07-16)

### Production symptom

Outbound WhatsApp test messages reached the user, but user messages sent back
to Nexeo received no Brain response even though the tenant had previously paired
WhatsApp through QR/Web.js.

### Confirmed code defect

`PUT /api/v1/admin/whatsapp-notifier` configured the Meta Cloud API **outbound**
notifier and also forcibly changed `whatsapp_config.provider` to `meta`, set its
inbound status to `connected`, and replaced `connected_number`. Generating a
Meta webhook secret could also create a row already marked `meta/connected`.

That coupled two independent transport choices. A tenant could still have a
valid QR session on disk, but `WhatsAppManager` would read `provider='meta'` and
wait for Meta webhooks instead of starting/listening through Web.js. Successful
admin outbound tests did not expose this because outbound notifier delivery is
a separate path.

### Implementation

Added:

```text
server/src/services/whatsapp/whatsappNotifierConfigMirror.ts
```

It provides two narrowly scoped operations:

- `mirrorNotifierCredentials()` updates only `meta_phone_number_id`,
  `meta_access_token`, and `meta_business_id`;
- `storeMetaWebhookSecret()` updates only `meta_webhook_secret`.

On conflict, neither operation changes:

- `provider`;
- `status`;
- `connected_number`;
- QR/session fields.

If no shared configuration row exists, the row is created in the schema's safe
default state: `provider='webjs'`, `status='disconnected'`. Choosing Meta for
inbound remains an explicit operation through `/admin/whatsapp/config` and
`WhatsAppManager.saveWhatsAppConfig()`.

`whatsappNotifierRoutes.ts` now calls these isolated operations and returns
`inboundProviderPreserved: true`. Comments and webhook instructions were
corrected so outbound credential setup no longer promises or implies inbound
activation.

### Required one-time production recovery for this QR-connected tenant

The code prevents future provider corruption, but it cannot safely guess
whether an already stored `provider='meta'` was intentional. During deployment,
the operator must explicitly restore this tenant to QR/Web.js inbound using the
existing admin WhatsApp configuration UI/API. If direct database recovery is
necessary, first identify the exact tenant row and inspect it; then, for the
user-confirmed QR tenant only, perform the equivalent of:

```sql
UPDATE whatsapp_config
SET provider = 'webjs',
    status = 'connected',
    last_error = NULL,
    updated_at = NOW()
WHERE client_number = '<CONFIRMED_CLIENT_NUMBER>';
```

`connected` here is a boot-resume request for the already paired LocalAuth
session: `initializeAllTenants()` intentionally skips rows marked
`disconnected`. Restart only `tmcai-server` with the correct environment. If
the preserved session is no longer valid, use Admin → WhatsApp → Reset Pairing
and scan a new QR code. Do not hard-code `TMC-0001` or change other tenants
without confirming the production row.

Verify logs show Web.js initialization and an inbound `Raw message event` /
`Message received`. Send `hi` from the registered user number and confirm a
Brain reply. A one-way admin test is not sufficient validation.

## 18. Google Drive stale-alert loop and duplicate incident ownership

### Production symptom

Nexeo sent the same "Google Drive not syncing" warning every five minutes,
including duplicate-looking incidents around scheduler boundaries.

### Confirmed code defect

The health service assigned Drive a four-hour time-based stale threshold even
though this installation has no automatic Drive poller. Drive's `lastSyncAt`
therefore could not advance unless a manual Drive API probe ran. Separately, two
workers could read the same connected row and both execute an unconditional
status update, so both believed they owned the new incident and both alerted.

### Implementation

`connectorHealthService.ts` now:

- excludes `ct_google_drive_personal` from timer-based stale detection;
- continues to report real Drive OAuth/API failures through
  `markTokenExpired()` and failed probe paths;
- claims an incident with atomic `updateMany({ id, status: 'connected' })`;
- sends an alert only when exactly one row transitioned;
- awaits alert completion so the protected job lifecycle does not abandon a
  claimed incident during shutdown.

This is transition-based suppression rather than a weaker message-text regex or
an in-memory flag. It works across multiple processes sharing the database.

Before/after behavior:

| Condition | Before | After |
|---|---|---|
| Old Drive timestamp, no Drive poller | Repeated false stale incident | No timer-based incident |
| Actual Drive token/API failure | Alert path remains | Alert path remains |
| Two workers observe stale Gmail | Both could alert | One atomic transition owner alerts |

No schema migration is required for sections 17–18.

## 19. Regression tests and final local verification (2026-07-16)

Added:

```text
server/tests/whatsappNotifierProviderIsolation.test.ts
server/tests/connectorStaleIncident.test.ts
```

Coverage includes:

- Meta outbound credential save preserves an existing Web.js inbound provider;
- a missing row is created as `webjs/disconnected`;
- webhook-secret rotation cannot activate Meta inbound;
- unpolled Drive is not marked stale from wall-clock age;
- the connected-to-stale update includes the status precondition;
- a losing concurrent worker emits no alert.

Local verification after these changes:

```text
npx tsc --noEmit
  PASS (no diagnostics)

npm test
  Test Files: 77 passed, 1 skipped
  Tests:      932 passed, 21 skipped, 0 failed

npm run build
  Prisma Client 6.19.2 generated
  TypeScript build passed

git diff --check
  PASS
```

These latest changes are local and uncommitted at the time of writing. They
have not been pushed or deployed by Codex.

## 20. Web.js id-less send receipt false failures (2026-07-16)

### Production evidence and root cause

The Admin message log marked five test messages `failed` with:

```text
sendMessage returned no message id — send likely failed silently
```

The destination WhatsApp chat showed that all five messages were actually
delivered. The same screenshots proved inbound processing was live: `hi` and
`?` were recorded as received, and Brain replies were generated. In production
with whatsapp-web.js 1.34.6, `Client.sendMessage()` can resolve after accepting
the send while returning an object with no usable `id`. The prior binary
contract incorrectly converted “receipt unavailable” into “send failed”. That
invited manual retries and created duplicate messages.

### Implementation

Added `server/src/services/whatsapp/sendReceipt.ts` with an explicit three-state
classification:

- provider returned an ID → `provider_receipt`, log `sent`;
- send resolved without an ID → `transport_accepted`, log
  `sent_unconfirmed` and do not retry;
- provider threw/rejected → `failed` and refund the claimed message quota.

`SendResult` now carries `confirmation` and an optional bounded `warning`.
`WebjsProvider`, normal sends, and approved queued sends use the shared status
classifier. No-ID transport acceptance is not promoted to provider-confirmed
delivery, so action confirmation continues to fail closed when it requires a
real receipt.

The Admin test UI now says:

```text
Test accepted by WhatsApp Web; receipt ID unavailable. It will not be retried—check the destination chat.
```

instead of falsely reporting failure. This prevents operators from repeating a
send that may already be visible to the recipient.

Added `server/tests/whatsappSendReceipt.test.ts` covering confirmed,
transport-accepted/unconfirmed, and actual failure states.

Final verification for this follow-up:

```text
Server: 935 passed, 21 skipped, 0 failed
TypeScript: clean
Server production build: passed (Prisma 6.19.2)
Client Vite production build: passed
git diff --check: passed
```

## 2026-07-17 — WhatsApp voice transcription resilience

The WhatsApp text path was verified healthy in production, while a voice note
reached Nexeo but failed before Brain reasoning. The transcription layer has
been hardened without changing text-message behavior:

- Gemini remains the primary speech provider, with its model configurable via
  `VOICE_TRANSCRIPTION_GEMINI_MODEL` (default `gemini-2.5-flash`).
- OpenAI audio transcription is now an independent second provider when
  `OPENAI_API_KEY` is configured; its model can be overridden with
  `VOICE_TRANSCRIPTION_OPENAI_MODEL` (default `whisper-1`). Google Speech
  remains the final fallback. Both optional overrides are documented in
  `server/.env.example`.
- Google Speech no longer labels every upload `OGG_OPUS` at 16 kHz. Its
  encoding is derived from the real WhatsApp MIME type, and MP4/M4A/AAC are
  passed without a fabricated OGG encoding hint.
- Transcription results now include the provider and a typed failure category:
  invalid media, no clear speech, unavailable providers, or provider failure.
- Web.js QR and Meta webhook ingress use the same honest failure markers. A
  quiet/too-short note asks for a slightly longer retry; an outage says the
  service is temporarily unavailable rather than pretending Brain understood.
- Logs identify provider, outcome, byte count, MIME type, language, and output
  length. Audio and transcript content are not logged.
- Added `server/tests/voiceTranscriptionResilience.test.ts` for MIME mapping,
  invalid-media short-circuiting, and safe user-facing failure wording.

Verification after this change:

```text
Server: 973 passed, 21 skipped, 0 failed
TypeScript: clean
Server production build: passed (Prisma 6.19.2)
Client Vite production build: passed
git diff --check: passed
```

## 21. Inbound `@lid` reply routing (2026-07-16)

### Production evidence

The Admin log proved that inbound `Hi` and `Brief my dya` messages were received
from a WhatsApp `@lid` identity and that Brain generated responses, while the
responses did not appear in the originating WhatsApp chat. The sender surfaced
as a synthetic `+1735…` LID alias rather than the user's canonical phone.

### Root cause and correction

The tenant Web.js inbound handler replied through:

```text
message.getChat().sendMessage(...)
```

For an `@lid` sender, `getChat()` can resolve a virtual/LID chat object that
accepts the call without reliably routing the reply into the visible originating
conversation. The handler also called `getChat()` before deciding whether it
even needed a chat object, so a bad LID chat resolution could block ordinary
text replies before the send.

Added `server/src/services/whatsapp/inboundReplyTransport.ts`. Text replies now
prefer:

```text
message.reply(...)
```

which preserves the exact inbound message and WhatsApp routing context. The
chat-based path remains only as compatibility fallback for older objects. This
shared transport is used by both Web.js inbound event handlers, voice
transcription echoes, and the text copy accompanying a voice reply. Voice media
continues to use the chat media API because `message.reply()` does not provide
the required voice-note send options.

Added `server/tests/whatsappInboundReplyTransport.test.ts` to lock exact-context
routing and the compatibility fallback.

## 22. Complete WhatsApp reply, voice-note, and activity repair (2026-07-17)

### Production evidence and final root causes

The destination screenshot proved that Nexeo's status request reached Muhammad
Yousaf and that he replied. Nexeo nevertheless reported a failed send and later
said there were no new WhatsApp messages. Voice notes could also disappear
without a reply, and long-running text/voice turns did not consistently show
that Nexeo was working.

The remaining causes crossed several boundaries:

- Brain Composer still required a provider message ID even after Web.js had
  accepted a send, so the lower-level three-state receipt fix was not fully
  propagated to user-facing action results.
- the outbound action could add its canonical Nexeo introduction on top of a
  model-authored recipient greeting/introduction, producing the duplicated
  Yousaf message;
- replies from a legitimate external delegatee were rejected by the registered
  user gate, so they never became feed evidence or updated the related open
  item;
- the reduced `message_create` listener did not share the main listener's audio
  handling, while Web.js versions can emit either `message`, `message_create`,
  or both;
- outbound audit rows were written as `sent` before the transport attempt.

### Send semantics and honest confirmation

`tenantWhatsappSender`, `WhatsAppManager`, Brain Composer, and the generic
action dispatcher now preserve the provider's three-state result end to end:

- a provider receipt ID is confirmed `sent`;
- a resolved send without an ID is `sent_unconfirmed` / transport accepted and
  is not retried automatically;
- only a thrown or rejected send is `failed`.

Brain now reports the accepted-without-receipt state honestly instead of
claiming that the notifier was disconnected. `whatsappOutboundPolicy.ts`
removes a model-authored assistant introduction or duplicate recipient greeting
before the single canonical Nexeo on-behalf-of prefix is added.

### Safe delegatee-reply ingestion

Added `expectedExternalReplyService.ts`. The registered-user privacy boundary
remains the default: unknown senders are neither stored nor answered. A narrow
exception admits an external number only when it exactly matches the recipient
of a successful tenant WhatsApp send from the previous 14 days.

For a matched delegatee reply, the service:

- treats the human reply as delivery evidence and promotes the outbound row to
  `delivered`;
- resolves the owner and contact within the tenant;
- attaches the reply as evidence to the best matching active delegated open
  item (title match first; a sole candidate is the safe fallback);
- creates a canonical WhatsApp feed event and queues a routine Brain prompt for
  the owner;
- never enters the delegatee into the chatbot path and never auto-replies to
  them.

Webhook and Web.js inbound paths now carry the real WhatsApp message ID and
normalized timestamp into this correlation flow.

### Voice-note parity and visible processing state

`WebjsProvider` now routes both `message` and `message_create` through one
deduplicated handler. Therefore text and voice notes receive identical identity,
transcription, Brain, reply, error, and audit behavior regardless of which
event the installed Web.js version emits.

For a registered user, every accepted inbound message now immediately reacts
with an hourglass and shows WhatsApp typing state. Voice notes show recording
state when supported. The state is refreshed every 15 seconds during long
transcription/reasoning, and the timer, chat state, and reaction are cleared on
both success and failure. Unknown senders and captured delegatees do not receive
this feedback. A failed transcription returns an explicit bracketed failure
marker instead of silently disappearing; a successful transcription is echoed
before Brain acts on it.

Outbound reply audit rows are now inserted after the wire attempt with
`sent`, `sent_unconfirmed`, or `failed`, including the bounded transport error
when relevant. They no longer claim success before attempting delivery.

### Regression coverage and release verification

Added:

- `server/tests/whatsappOutboundPolicy.test.ts`;
- `server/tests/expectedExternalWhatsappReply.test.ts`;
- `server/tests/whatsappInboundActivity.test.ts`.

Final verification:

```text
Server: 944 passed, 21 skipped, 0 failed
TypeScript: clean
Server production build: passed (Prisma 6.19.2)
git diff --check: passed
```

## 23. Living Action Center lifecycle and central action governor (2026-07-17)

### Problem found

Actionable work was split across four overlapping follow-up engines with
conflicting behavior: one only reminded the owner, one contacted delegatees,
one sent email chases, and another could mark work stale. DRAFT items also
closed automatically after silence. This did not provide one accountable
assistant that owns a task until completion.

### Canonical lifecycle

Added `services/openItems/actionLifecycleService.ts`. Every active actionable
item now carries a versioned `metadata.actionLifecycle` state with:

- lifecycle phase and next follow-up time;
- last concerned-party contact and response;
- unanswered-attempt and missed-commitment counters;
- current delay reason and intervention flag;
- bounded commitment, follow-up, evidence, and escalation history.

The deterministic lifecycle policy cannot silently abandon work:

- no deadline → ask the responsible person daily for a committed date;
- deadline in the future → monitor until that commitment;
- deadline reached → ask whether it is complete; if not, require the delay
  reason and a new committed deadline;
- new deadline → record it and schedule the next check at that date;
- no usable new deadline → continue daily;
- explicit completion evidence → close through the canonical item lifecycle;
- three unanswered attempts, two missed commitments, a blocker, or an
  authority/approval dependency → involve the owner with a decision-ready
  intervention summary;
- terminal, cancelled, or self-pruned items → no proactive contact.

First-run adoption is bounded to three contacts per owner and 100 globally per
governor run (environment-overridable), so a legacy backlog cannot create a
notification burst after deployment.

Silence no longer expires a DRAFT item. The existing daily slot question keeps
running until priority/deadline are supplied or the user explicitly skips or
cancels the item. The old “last call / I’ll drop it” behavior was removed.

### Concerned-party communication and reply understanding

Added `jobs/actionLifecycleWorker.ts`. It routes follow-up through the best
auditable path:

- internal Nexeo delegatee → sequential Brain Prompt Queue, so the reply is
  correlated to the owner's exact open item;
- external contact with a phone → tenant Nexeo WhatsApp;
- external contact with email → disclosed Nexeo-on-behalf-of email;
- owner/self-owned work → Brain Prompt Queue.

External WhatsApp replies and delegation-tracker email replies now enter the
same lifecycle reply interpreter. The interpreter extracts completion,
progress, blockers, a delay reason, a new deadline, completion evidence, and
whether user authority is required. LLM interpretation has a deterministic
fallback, and a future promise is never treated as completion. Authority or
approval blockers create an immediate high-criticality owner prompt rather
than waiting for the next daily sweep.

Added the `action_status_update` Brain Prompt side effect so owner/internal
delegatee replies update the item, commitment history, next follow-up, and
closure state instead of becoming unlinked chat text.

### One governed job

Added `jobs/centralActionGovernor.ts`. Production now has one protected
`central_action_governor` timer and durable job lease. It centrally sequences:

1. prompt expiry;
2. new-item gap prompts;
3. indefinite DRAFT slot completion;
4. the living action lifecycle sweep.

The old `followup_sweep`, `delegation_follow_up`, `delegatee_email_sweep`,
`open_item_draft_ask`, and `open_item_follow_up` production timers were removed,
eliminating duplicate or contradictory chases. Their domain modules remain
available for historical tests/migration tooling but do not schedule
themselves. The background-job inventory and missed-run policy now name the
central governor.

### Action Center visibility

The Open Items page now shows a `Nexeo: <phase>` badge and a Living Follow-up
panel containing the next follow-up, unanswered attempts, missed commitments,
latest delay reason, and intervention status. The How Brain Works page now
explains that sender-star notifications hand off to the living lifecycle when
work becomes active/delegated; only closure or explicit cancellation stops it.

No database migration is required; lifecycle state uses the existing JSON
metadata, notes, action audit, prompt queue, and item status history.

### Regression coverage and verification

Added:

- `server/tests/actionLifecyclePolicy.test.ts`;
- `server/tests/actionLifecycleReply.test.ts`;
- `server/tests/centralActionGovernor.test.ts`.

Final verification:

```text
Server: 959 passed, 21 skipped, 0 failed
TypeScript: clean
Server production build: passed (Prisma 6.19.2)
Client Vite production build: passed
git diff --check: passed
```
