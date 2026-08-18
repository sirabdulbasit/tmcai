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

## 2026-07-17 — Complete WhatsApp pipeline hardening (post-deploy audit)

The first voice-resilience deploy exposed that environment-variable presence
was being mistaken for provider health and that activity feedback could fail
silently. The complete tenant WhatsApp path was then audited from QR/Meta
ingress through identity, media, Brain, action dispatch, response modality,
wire receipt, health and recovery.

### Canonical inbound identity and activity

- Added `whatsapp/inboundIdentity.ts` as the single tenant-scoped phone matcher
  used by both pre-processing activity and `WhatsAppInbound`. E.164, digits,
  Pakistan-local and learned `@lid` aliases now produce one registration
  decision; activity can no longer miss a user whom Brain later recognizes.
- A preflight database error is represented as “unknown/retry”, not
  “unregistered”. Confirmed unregistered traffic remains silent and receives
  no voice-failure response.
- QR messages now emit observable native typing/recording state plus an
  hourglass reaction. WhatsApp API rejection is logged and recorded rather
  than swallowed. Meta webhook messages request the native read/typing state
  against the exact inbound message id.
- Admin WhatsApp Health now shows the latest activity result, including whether
  native state and reaction APIs were accepted.

### Voice input and output

- Audio container signatures (`OggS`, WebM/EBML, RIFF, FLAC, ID3 and MP4
  `ftyp`) override unreliable WhatsApp/browser MIME labels.
- The bounded transcription chain is now Gemini → OpenAI → Groq → Google.
  Groq uses a speech-specific Whisper model and has a separate translation
  model override. Every provider has a configurable timeout.
- Google Speech runs only when its credentials file actually exists; a path
  string alone no longer marks it configured.
- A privacy-safe in-memory attempt ledger records provider, success/no-speech/
  failure, latency, container and byte count. Errors are bounded and common
  API-key formats are redacted. Audio and transcript content are never stored
  in health telemetry.
- Google TTS is timeout-bounded so a voice response cannot hang the complete
  WhatsApp turn indefinitely.
- QR voice sends now use the same receipt classifier as text: a resolved send
  without an id is `transport_accepted`/`sent_unconfirmed`, never a false
  failure and never automatically retried.
- Meta voice fallback reports whether it delivered voice or text. The webhook
  adds a readable text copy only after a real voice bubble; it no longer sends
  the fallback text twice or ignores a failed send result.

### Brain handoff, delivery and recovery

- Inbound deduplication now keys on the immutable WhatsApp message id. Two
  legitimate repeated messages such as “yes” are no longer collapsed merely
  because their text and sender match within five seconds.
- Brain handoff records bounded stage timing for identity, reasoning and wire
  completion without logging message contents. An empty sanitized Brain answer
  becomes an honest bracketed retry marker instead of an empty WhatsApp send.
- Error replies use the originating message transport, preserving modern
  `@lid` routing.
- Switching the configured inbound provider disposes the cached live provider
  first, preventing an orphan QR client from continuing to process messages
  after a Meta/Web.js switch.
- Tenant Nexeo QR/Meta transport remains separate from personal-user WhatsApp
  ingestion by design. No QR session format, database schema, dependency or
  outbound TTS format was replaced.

### Observability and permanent regression coverage

- `/admin/whatsapp-health` now includes configured speech providers, recent
  voice attempts and recent activity signals, filtered to the authenticated
  tenant.
- `WhatsAppHealthPanel` renders provider readiness, credential-path problems,
  the last transcription attempt and the last native activity outcome.
- Added Chat 11 to the permanent Brain incident archive and regression corpus.
- Added/expanded tests for canonical identity, container sniffing, provider
  absence, activity API rejection, immutable-id dedup, Meta typing payload,
  voice fallback single-send semantics, and accepted/unconfirmed receipts.

No database migration or new package is required.

Final verification:

```text
Server: 989 passed, 21 skipped, 0 failed
TypeScript: clean
Server production build: passed (Prisma 6.19.2)
Client Vite production build: passed
git diff --check: passed
```

## 2026-07-17 — Live `@lid` activity and PTT media compatibility

The first live test after `db8e4c2` supplied decisive stage telemetry. Text
identity, Brain reasoning and reply delivery were healthy, but Web.js rejected
native typing/recording against the modern `@lid` chat with the opaque string
error `"r"`. Voice failed about 10 ms after receipt, before any Gemini,
OpenAI, Groq or Google attempt, proving the fault was inbound media acquisition
rather than speech-provider availability.

### Activity feedback

- Native typing/recording first uses the inbound chat as before.
- When that LID Wid is rejected, the provider calls Web.js's explicit
  `getContactLidAndPhone` resolver and retries state against the equivalent
  phone-number chat.
- If WhatsApp rejects both native routes, Nexeo sends exactly one visible
  `⏳ Thinking…` or `🎙️ Listening…` acknowledgment through the already-proven
  inbound reply route. Brain processing continues; activity API failure cannot
  suppress the answer.
- Activity errors now preserve Error type or safely serialize thrown strings,
  so future Web.js breakage is diagnosable without message content.

### Voice media readiness

- Added `whatsapp/inboundMedia.ts` as the bounded Web.js media-acquisition
  boundary.
- A newly emitted PTT is attempted immediately, then refreshed/retried after
  400 ms and 1.2 seconds because WhatsApp can emit `message` while media is
  still FETCHING/REUPLOADING.
- Attempt number, MIME label and base64 byte count are logged without audio or
  transcript content.
- Exhausted acquisition is classified as `invalid_media`; it is no longer
  incorrectly presented as an STT-provider outage.

### Production schema parity

- Added idempotent migration
  `20260717_whatsapp_agent_session_state` for `active_agent_id`,
  `active_agent_name` and `agent_session_started_at` on `whatsapp_sessions`,
  plus the active-session lookup index.
- Prisma schema now declares the same fields. This removes the live
  `column "active_agent_id" does not exist` degradation.

### Regression coverage

- Expanded `whatsappInboundActivity.test.ts` for LID→phone state retry and the
  visible text/voice fallbacks.
- Added `whatsappInboundMedia.test.ts` for immediate success, refresh/retry
  after the production-shaped thrown string, and bounded exhaustion.
- Added Chat 12 to the permanent incident archive and executable regression
  corpus.

Final verification:

```text
Server: 996 passed, 21 skipped, 0 failed (91 passing files)
Focused WhatsApp regressions: 30 passed, 0 failed
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

## 24. WhatsApp Web.js initialization contention and timeout health (2026-07-17)

### Evidence and root cause

Production PM2 evidence showed watchdog-triggered `initialize()` calls while a
prior initialization was still running, up to six Chromium processes sharing
one LocalAuth profile, and only a generic `Runtime.callFunctionOn timed out`
error. Code inspection confirmed that `WebjsProvider` had a boolean in-flight
set but no deadline/generation/backoff/repair state, while the watchdog trusted
the database's stale `connected` value and allowed overlapping async sweeps.

### Technical changes

- Replaced the boolean guard with a tokenized per-tenant init flight claimed
  before any await. Healthy in-flight calls are reused; an expired attempt is
  generation-fenced so its late events cannot affect the replacement.
- Added an explicit Puppeteer `protocolTimeout` (240s) and an enforced overall
  init deadline (270s). Bounded overrides are
  `WHATSAPP_WEBJS_PROTOCOL_TIMEOUT_MS` (60–600s),
  `WHATSAPP_WEBJS_INIT_DEADLINE_MS` (90–660s and at least protocol + 30s), and
  `WHATSAPP_WEBJS_TIMEOUT_ESCALATION_COUNT` (2–5, default 3).
- Bounded client destruction and browser-close fallback prevent timed-out
  attempts from leaving zombie Chromium processes. Superseded-client QR,
  ready, disconnect, auth, and error events are ignored.
- Classified the production error as `init_timeout`, persisted it in
  `whatsapp_config`, and exposed start/deadline/retry/count/repair state through
  provider status and Admin WhatsApp Health.
- Added 30s/2m/5m timeout backoff. Three consecutive timeouts open a repair
  gate, stop silent retries, write a durable `health_transition`, and send one
  admin escalation that QR re-pairing may be required.
- Added a whole-watchdog-sweep mutex. The watchdog now respects a connecting
  deadline, timeout backoff, and repair gate instead of starting another init.
- Admin UI recognizes `init_timeout`, shows its error and retry/repair state,
  and exposes the guarded Reset Pairing action. Alert branding now says Nexeo.

### Complete file list

- `server/src/services/whatsapp/webjsInitPolicy.ts` (new)
- `server/src/services/whatsapp/WebjsProvider.ts`
- `server/src/services/whatsapp/IWhatsAppProvider.ts`
- `server/src/services/whatsapp/connectionWatchdog.ts`
- `server/src/routes/admin/whatsappHealthRoutes.ts`
- `server/tests/webjsInitPolicy.test.ts` (new)
- `server/tests/webjsInitLifecycle.test.ts` (new)
- `client/src/pages/admin/WhatsAppHealthPanel.jsx`
- `client/src/pages/admin/WhatsAppTab.jsx`
- `Changes_Made.md`

No database migration or new dependency is included. The incident came from
production initialization logs, not a Brain conversation, so no chat-archive
scenario was added.

### Verification and remaining acceptance

The 11 new tests cover exact timeout classification, config bounds, backoff,
watchdog deferral, concurrent admission, persistence, disposal, escalation,
post-escalation suppression, and Puppeteer configuration.

```text
Server: 1007 passed, 21 skipped, 0 failed (93 files passed, 1 skipped)
TypeScript: clean
Server production build: passed (Prisma 6.19.2 generation + tsc)
Client Vite production build: passed
git diff --check: passed
```

Live acceptance remains: complete the fresh QR pairing, test one inbound text
and voice-note turn, confirm only one Chromium process tree owns
`session-TMC-0001`, and confirm no re-init occurs before the reported deadline.
Codex changed no production state. Work remains uncommitted for Claude review.

## Deployment Record — 2026-07-17 — 67801a58072edb3b0ddcf14808e53e29b38844e8 (REVIEWER)

**Four-SHA ledger:**
1. Application release SHA: `7ef719b0cd031db1ee8691512081e7adc2338157` (@lid activity fallback, PTT media acquisition, agent-session schema)
2. Reviewed remote HEAD: `67801a58072edb3b0ddcf14808e53e29b38844e8` (two docs-only commits above release: eb48e75, 67801a5 — AGENTS.md only, verified by file delta)
3. Production deployed SHA: `67801a58072edb3b0ddcf14808e53e29b38844e8` (`git rev-parse HEAD` on deepmarks after `git pull --ff-only`; ancestor check for 7ef719b passed)
4. Documentation/report SHA: this commit. NOT live-tested; production remains on 67801a5.

**Deployment evidence (deepmarks, 2026-07-17 ~11:25 UTC):**
- Migration `20260717_whatsapp_agent_session_state`: `Script executed successfully`; metadata query confirmed all three columns (`active_agent_id`, `active_agent_name`, `agent_session_started_at`). No `active_agent_id` errors after restart.
- Server build: Prisma 6.19.2 generate + tsc clean. Client build: not required (no client files in release).
- pm2: only `tmcai-server` restarted; online, stable memory; other apps untouched.
- Health: HTTP 200, `database: up (15ms)` at 11:26:06 UTC.

**Release status: PARTIAL** (per agreed semantics). Live acceptance could not run: the tenant WhatsApp session was already wedged in `connecting` before the deploy and never produced a fresh Connected event.

**Production incident found during acceptance (evidence: /root/.pm2 logs 11:17–11:46 UTC):**
- Watchdog re-triggered `initialize()` while a prior init was in flight; up to 6 Chromium processes contended for `session-TMC-0001`; only surfaced error: `whatsapp:manager Init failed — Runtime.callFunctionOn timed out (protocolTimeout)`.
- Operational remediation (no code change): stale Chromium processes killed; wedged profile MOVED (preserved) to `whatsapp-sessions/session-TMC-0001.bak-20260717`; fresh QR pairing initiated.
- Both defects handed to BUILDER; fixed in application release SHA `04e1e45a4ea5b61feeb8fb339a15341caf637edd` (Section 24), reviewed and published, **deployment pending Basit's authorization**.

**Reviewer verification of Section 24 release (pre-deploy):** 1007 passed / 0 failed / 21 skipped; focused init tests 11/11; tsc clean; server + client builds clean; `git diff --check` clean; staged only the 10 documented files; preserved documents untouched.

## 25. WhatsApp Web.js fresh-session bootstrap compatibility (2026-07-17)

### Production evidence and confirmed dependency defect

After Section 24 reached production, its new diagnostics proved that the
remaining clean-profile failure was inside the Web.js bootstrap rather than
networking or process contention: one Chromium tree loaded
`https://web.whatsapp.com`, no QR event was emitted, and
`Runtime.callFunctionOn` reached the bounded protocol timeout.

Repository verification corrected the installed-version detail in the incident
handoff: both the lockfile and local installation were `whatsapp-web.js 1.34.6`
(declared as `^1.34.6`), not 1.34.7. Upstream evidence directly matches the
production symptom:

- the official 1.34.7 release includes “Fix: Frozen WhatsApp Start or Auth
  Timeout”: https://github.com/wwebjs/whatsapp-web.js/releases/tag/v1.34.7
- the merged upstream fix removes the obsolete bootstrap patch that caused
  frozen starts/auth timeouts after WhatsApp's module changes, and was confirmed
  by maintainers/testers: https://github.com/wwebjs/whatsapp-web.js/pull/127048
- the 1.34.6 ready-state report reproduced the failure even with a remote
  `webVersionCache`, so cache pinning alone is not an evidence-backed repair:
  https://github.com/wwebjs/whatsapp-web.js/issues/127084

### Implemented repair

`whatsapp-web.js` is upgraded and exact-pinned to `1.34.7`. An exact package
pin makes production installs deterministic while taking the official bootstrap
fix and current LID handling. No `webVersion`/`webVersionCache` override was
added: it would preserve the broken 1.34.6 injection code and introduce another
remote runtime dependency without evidence that a particular cached WhatsApp
Web build fixes this defect.

The regenerated lockfile resolves the upstream package's declared dependency
set, including its exact Puppeteer 24.38.0 dependency and removal of the old
`@pedroslopez/moduleraid` bootstrap dependency. A new executable compatibility
test locks all three assumptions that matter to Nexeo:

- installed package version is exactly 1.34.7;
- `Client.getContactLidAndPhone()` remains available for the Chat 11/12 LID
  fallback;
- `Message.downloadMedia()` remains available for bounded PTT/audio retrieval.

### Complete file list

- `server/package.json`
- `server/package-lock.json`
- `server/tests/webjsDependencyCompatibility.test.ts` (new)
- `Changes_Made.md`

No application source, client file, database schema, migration, or new direct
dependency is included. The existing dependency is upgraded in place.

### Production package-file warning

Production is known to carry preserved local edits in both
`server/package.json` and `server/package-lock.json`, which are the two tracked
files changed by this release. The Reviewer must inspect and reconcile those
exact production diffs before pulling. If `git pull --ff-only` refuses, stop and
report the paths; do not reset, checkout over, silently stash, or discard the
production edits.

After the reviewed Git state is safely present, the production dependency
install must use the established network/browser safeguards:

```bash
NODE_OPTIONS=--dns-result-order=ipv4first \
PUPPETEER_SKIP_DOWNLOAD=true \
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
npm install --no-audit --no-fund
```

The Reviewer should verify `node_modules/whatsapp-web.js/package.json` reports
1.34.7 before building/restarting only `tmcai-server`.

### Verification and remaining acceptance

```text
Focused WhatsApp/dependency compatibility: 22 passed, 0 failed (5 files)
Server: 1009 passed, 21 skipped, 0 failed (94 files passed, 1 skipped)
TypeScript: clean
Server production build: passed (Prisma 6.19.2 generation + tsc)
Dependency tree: whatsapp-web.js 1.34.7 -> puppeteer 24.38.0
git diff --check: passed
```

Live acceptance remains the release gate: on a clean LocalAuth profile a QR
must be emitted within the initialization deadline, pairing must complete, one
inbound text and one voice-note turn must pass, only one Chromium tree may own
the tenant profile, and `init_timeout` must remain reserved for genuine stalls.
Codex did not change production, commit, push, or deploy.

The separately reported `obsidian_vault_export` 540-second job timeout was
deliberately not bundled and remains uninvestigated for a future standalone
Builder task.

## 26. WhatsApp Web.js bounded bootstrap-stage diagnostics (2026-07-17)

### Reopened defect and corrected causal boundary

Decisive production evidence superseded Section 25's causal explanation:
production was already running `whatsapp-web.js 1.34.7` when a clean LocalAuth
profile reached `Runtime.callFunctionOn timed out` without emitting QR. The
exact 1.34.7 dependency pin from Section 25 remains valid repository/install
hygiene, but upgrading 1.34.6 to 1.34.7 cannot explain or repair this specific
production incident.

Current upstream evidence confirms that this remains an active 1.34.7 failure
class rather than a Nexeo-only networking problem:

- upstream issue 201818 reports 1.34.7 on Ubuntu/LocalAuth/Chrome frequently
  hanging at WhatsApp Web loading 99% while standalone Puppeteer succeeds:
  https://github.com/wwebjs/whatsapp-web.js/issues/201818
- upstream issue 201821 reports intermittent 1.34.7 readiness and a stall in
  `attachEventListeners()` around frame refresh/removal:
  https://github.com/wwebjs/whatsapp-web.js/issues/201821
- the official release feed still identifies 1.34.7 as the latest stable
  release; there is no stable 1.34.8/1.35 repair available to adopt:
  https://github.com/wwebjs/whatsapp-web.js/releases/tag/v1.34.7

### Web-version-cache decision

No `webVersion` or `webVersionCache` override was added. The actively updated
`wppconnect-team/wa-version` archive proves that historical HTML snapshots
exist, but it does not certify a compatibility matrix for whatsapp-web.js
1.34.7. Builds nearest the two current upstream reports are themselves
implicated in hangs, while older/alpha snapshots have not passed Nexeo's clean
QR/pairing acceptance. Calling one of them “known compatible” would therefore
be an unverified production claim. An executable regression test now locks the
fail-closed decision: Nexeo must not silently acquire a guessed cache pin.

A future cache pin is appropriate only after a specific version and immutable
HTML source pass a clean-profile production-equivalent pairing test. The
absence of such evidence does not block the diagnostic repair below.

### Implemented bounded stage telemetry

Added a per-initialization telemetry recorder and integrated it with the
existing tokenized init flight. It records only bounded operational facts:

- last successfully observed stage: flight claimed, client created, browser
  started, page created/reached, provider QR listener registered, loading
  screen, QR emitted, authenticated, or ready;
- safe page origin/path with query strings, fragments, credentials, and
  non-HTTP URLs removed;
- strictly validated WhatsApp Web version when obtainable by observing the
  library's own version lookup, without issuing a competing DevTools call;
- QR-listener/QR/authentication facts and bounded loading percentage;
- at most eight browser console/page-error fingerprints by default, with a
  clamped 1–20 operational override
  (`WHATSAPP_WEBJS_INIT_CONSOLE_ERROR_CAP`).

Raw browser console text is never stored or logged. It is immediately reduced
to one of nine fixed categories (protocol timeout, passkey, missing module,
lost execution context, closed browser target, network, CSP, JavaScript type,
or unknown). Browser error locations receive the same URL sanitization.
Telemetry listeners and polling are detached when initialization settles, and
all diagnostic operations are best-effort so they cannot block WhatsApp.

On failure, the existing `init_timeout`/`error` health state remains the failure
classification while telemetry preserves the last successful stage instead of
overwriting it with a generic “failed” stage. The safe snapshot is exposed by
the existing Admin WhatsApp Health response, included in bounded PM2 metadata,
and the persisted `last_error` now carries the stalled stage (for example
`init_timeout[page_reached]`). This makes the next incident distinguish a
Chromium launch, navigation, loading, QR, authentication, or ready-stage stall.

### Complete file list

- `server/src/services/whatsapp/webjsInitTelemetry.ts` (new)
- `server/src/services/whatsapp/WebjsProvider.ts`
- `server/tests/webjsInitTelemetry.test.ts` (new)
- `server/tests/webjsInitLifecycle.test.ts`
- `Changes_Made.md`

No package file, client file, database schema, or migration is changed by
Section 26. This incident is production runtime evidence rather than a Brain
conversation, so the chat-archive/scenario exemption applies.

The combined future deployment still includes Section 25's already-published
package-file changes. Production's preserved local edits to `server/package.json`
and `server/package-lock.json` must therefore still be inspected/reconciled by
the Reviewer, followed by the documented IPv4-first, skip-Chromium dependency
install. Section 26 itself adds no further dependency delta.

### Tests and verification

Six new pure telemetry tests cover URL secret removal, strict version
validation, fixed error classification, capped/no-raw-text retention,
lifecycle facts/defensive snapshots, and environment bounds. Lifecycle tests
now also prove safe stage/version/error capture on the exact production timeout
and absence of an unverified Web cache pin.

```text
Focused Web.js init policy/lifecycle/telemetry: 18 passed, 0 failed (3 files)
Server: 1016 passed, 21 skipped, 0 failed (95 files passed, 1 skipped)
TypeScript: clean
Server production build: passed (Prisma 6.19.2 generation + tsc)
git diff --check: passed
```

Client build was not required because no client file changed. Live acceptance
remains pending: a clean profile must emit QR within the deadline, pairing must
complete, inbound text and voice turns must pass, and one Chromium tree must
remain. If another timeout occurs, Admin/PM2 must show its safe stalled stage,
page path, obtainable Web version, and bounded fingerprints. Codex did not
commit, push, deploy, or change production.

The separately reported `obsidian_vault_export` timeout remains explicitly out
of scope and was not bundled.

## Deployment Record — 2026-07-17 — 170854fcccc728e5da6175045640aa8dacde35c5 (REVIEWER)

**Four-SHA ledger:**
1. Application release SHAs: `d9ee60a` (exact 1.34.7 pin + dependency matrix), `170854f` (init-stage telemetry)
2. Reviewed remote HEAD: `170854fcccc728e5da6175045640aa8dacde35c5`
3. Production deployed SHA: `170854fcccc728e5da6175045640aa8dacde35c5` (verified on deepmarks; ancestor check for d9ee60a passed)
4. Documentation/report SHA: this commit (not live-tested; prod runs 170854f)

**Deployment evidence (deepmarks, 2026-07-17 ~14:05–14:14 UTC):**
- Package reconciliation per disclosed procedure: prod's hand-edited package files backed up to `*.prod-backup-20260717`, tracked versions restored, `git pull --ff-only` clean.
- `npm install` (IPv4-first, skip-Chromium): up to date in 2s; installed whatsapp-web.js verified `1.34.7`.
- Server build clean (Prisma 6.19.2 + tsc). No migration, no client changes. Only tmcai-server restarted; health HTTP 200, database up (10ms).

**Release status: PARTIAL** — infrastructure verified; WhatsApp live acceptance blocked by the (pre-existing) init failure, which the new telemetry has now attributed:
`init_timeout[page_reached]` — page loads, QR listener registered, `qrEmitted=false`, `wwebVersion=2.3000.1043359815`, one browser-error fingerprint (`unknown_browser_error`) originating from WhatsApp's own bundle `static.whatsapp.net/rsrc.php/v4/yS/r/0gPJ7eUi6im.js`. Network/Chromium/profile exonerated (clean profile; page reached; version readable). Conclusion: whatsapp-web.js 1.34.7 bootstrap is incompatible with WhatsApp Web build 2.3000.1043359815. Defect handed to BUILDER with the exact build number.

## 27. Integrity-pinned WhatsApp Web compatibility cache (2026-07-17)

### Decisive production evidence and upstream resolution audit

Section 26 produced the same bounded result on two independent production
initializations: `init_timeout[page_reached]`, Web build
`2.3000.1043359815`, QR listener registered but no QR emitted, and an opaque
exception from WhatsApp's own `static.whatsapp.net/rsrc.php` boot bundle. The
page and its JavaScript were running, so network, Chromium launch, LocalAuth
profile state, and Nexeo's listener registration were eliminated. The failure
boundary is the current WhatsApp Web bundle against whatsapp-web.js 1.34.7.

The requested upstream audit found no released library repair:

- issue 201818 was closed with only a maintainer screenshot and no linked
  commit, PR, cache version, or reproducible remedy:
  https://github.com/wwebjs/whatsapp-web.js/issues/201818
- issue 201821 contains a reporter workaround that waits for an input selector
  before `attachEventListeners()`. That failure occurs after an existing
  session advances toward ready; it does not repair Nexeo's clean-profile,
  pre-QR `page_reached` failure:
  https://github.com/wwebjs/whatsapp-web.js/issues/201821#issuecomment-4914820711
- 1.34.7 remains the latest stable release. No merged July bootstrap PR or
  stable 1.34.8/1.35 artifact exists to regression-test or adopt:
  https://github.com/wwebjs/whatsapp-web.js/releases/tag/v1.34.7

### Verified compatibility artifact

The `wppconnect-team/wa-version` archive contains WhatsApp Web build
`2.3000.1043346688-alpha`, captured immediately before the incompatible
production build. Its immutable evidence chain is:

- archive commit: `d71af1f1094ace8354e0a0f0f5e9c32b67988f96`;
- Git blob: `dfcc393253ee3f4824baf0599a7687370e8a1bf7` (568,383 bytes);
- SHA-256:
  `80a55358cdd081b3e58eb4bf62434b9f8bd9802f569e10c53e48823cd8528fcf`;
- archive expiry: `2026-09-17T07:27:10.198Z`;
- immutable source:
  `https://raw.githubusercontent.com/wppconnect-team/wa-version/d71af1f1094ace8354e0a0f0f5e9c32b67988f96/html/2.3000.1043346688-alpha.html`.

This artifact emitted a fresh QR with whatsapp-web.js 1.34.7 in two
independent immutable-remote clean-profile probes (2.61s and 3.78s). The
compiled Nexeo preparer then downloaded it, verified the exact SHA-256, wrote
the strict local cache, and a third clean profile emitted QR from that local
cache in 3.36s. These tests require no account pairing and establish the exact
acceptance boundary that production currently fails: bootstrap reaches QR.

### Implemented fail-closed local cache preparation

Added `webjsVersionCache.ts`. Before constructing a Web.js client, Nexeo now:

1. resolves the default pin or one atomic environment rotation;
2. validates version syntax, credential-free HTTPS source, SHA-256, and expiry;
3. reuses a local artifact only after recalculating its digest;
4. otherwise downloads with a 20-second abort deadline and 2 MiB size cap;
5. verifies SHA-256 before any write;
6. atomically installs the file with directory mode 0700 and file mode 0600;
7. passes whatsapp-web.js an explicit version and strict `LocalWebCache`;
8. fails visibly as `web_cache_unavailable` rather than falling back to the
   incompatible live build.

Concurrent preparations for the same cache/version/digest share one in-process
flight. A corrupt local artifact is replaced only by a verified download.
Download, integrity, expiry, or configuration failure releases the init lock,
persists an error, and prevents an unsafe live-version fallback.

Rotation requires all four values together, preventing a new version from
silently retaining an old digest or expiry:

- `WHATSAPP_WEBJS_WEB_VERSION`
- `WHATSAPP_WEBJS_WEB_CACHE_URL`
- `WHATSAPP_WEBJS_WEB_CACHE_SHA256`
- `WHATSAPP_WEBJS_WEB_CACHE_EXPIRES_AT`

The default artifact fails closed after its recorded September expiry. A
replacement can therefore be tested and rotated through environment settings
without an application release, but cannot be introduced without its integrity
and lifetime metadata.

### WA bundle fingerprint

The telemetry taxonomy now classifies an otherwise opaque error originating
from sanitized `https://static.whatsapp.net/rsrc.php...` as
`wa_bundle_boot_exception`. Raw minified error text remains discarded. This
distinguishes the exact current incompatibility from an arbitrary unknown page
error without exposing browser or message content.

### Complete file list

- `server/src/services/whatsapp/webjsVersionCache.ts` (new)
- `server/src/services/whatsapp/WebjsProvider.ts`
- `server/src/services/whatsapp/webjsInitTelemetry.ts`
- `server/tests/webjsVersionCache.test.ts` (new)
- `server/tests/webjsInitLifecycle.test.ts`
- `server/tests/webjsInitTelemetry.test.ts`
- `Changes_Made.md`

No package file, client file, database schema, or migration changed. Production
package reconciliation for the 1.34.7 pin was already completed in the prior
deployment; Section 27 requires no dependency installation. This is a
production connector incident rather than a Brain conversation, so no chat
archive/scenario pair was added.

### Tests and verification

Six new cache tests cover the immutable default, atomic rotations, expiry,
download/digest/atomic reuse, mismatch rejection, and corrupted-cache repair.
The lifecycle suite proves that only the prepared explicit version and strict
local cache reach the Client. Telemetry tests cover the new WA-bundle category.
The focused matrix also includes dependency-surface, inbound activity/media/
reply, and complete Chat 11/12 Brain regression coverage.

```text
Focused compatibility/init/LID/media/Brain matrix: 55 passed, 0 failed (9 files)
Server: 1022 passed, 21 skipped, 0 failed (96 files passed, 1 skipped)
TypeScript: clean
Server production build: passed (Prisma 6.19.2 generation + tsc)
Compiled integrity preparation: exact SHA-256 verified; strict local cache created
Clean-profile QR probes: 3/3 passed against immutable/verified-local artifact
git diff --check: passed
```

Client build was not required because no client file changed. Production live
acceptance remains mandatory: clean profile emits QR within the deadline,
pairing completes, text + voice + repeat-voice turns pass, one Chromium tree
remains, and Admin health exposes the selected version/stage. Codex did not
commit, push, deploy, or change production.

## 28. Environment-classified WhatsApp bootstrap diagnostics (2026-07-17)

### Confirmed boundary after Chrome parity test

Production repeated the same `page_reached` / `qrEmitted=false` /
`wa_bundle_boot_exception` failure with both WhatsApp Web builds (live
`2.3000.1043359815` and pinned `2.3000.1043346688-alpha`) and both Chrome
builds (bundled 146.0.7680.153 and system 150.0.7871.114). IPv4 access to
`web.whatsapp.com` and the exact `static.whatsapp.net` resource, UTC clock,
clean profile, whatsapp-web.js 1.34.7, and Nexeo's init lifecycle were also
verified. The same pinned library/Web/Chrome stack reaches QR on the Mac's
residential network.

This confirms the failure boundary is environment-sensitive execution of
WhatsApp's boot bundle on the production server. Datacenter egress or another
server classification signal is the leading hypothesis, but the bundle's
specific thrown exception was not retained by the privacy-safe runtime
telemetry, so anti-bot behavior is not yet claimed as fact.

### Exception-name-only runtime telemetry

Runtime browser telemetry now extracts only a bounded exception class/name
such as `SecurityError`, `TypeError`, `DOMException`, or a minified identifier
such as `r`. The value must be a single 1–48 character JavaScript identifier.
Exception messages and stacks remain discarded. The safe name is carried with
the existing fixed fingerprint, sanitized resource path, and bounded ring in
Admin health/PM2 metadata.

This distinguishes security/permission classes from ordinary JavaScript
incompatibility without weakening the operational-evidence privacy boundary.
Tests prove `SecurityError: private detail` retains `SecurityError` only and
that free-form/oversized text is rejected.

### Manual stdout-only diagnostic

Added `scripts/diagnoseWebjsBootstrap.ts`, a standalone operator tool. It is
never imported by runtime startup, never scheduled, and imports neither Prisma
nor the application logger. It:

- creates one temporary LocalAuth profile and one Chromium Client;
- uses the same integrity-verified pinned cache and configured Chrome path;
- attaches to the page before WhatsApp bootstrap settles;
- prints full browser console/page errors only to the invoking terminal;
- never prints QR content;
- bounds the attempt, error count, and each text/stack field;
- destroys Chromium and removes the temporary profile on every exit;
- emits machine-readable JSON lines and a deterministic exit code.

Manual production invocation from `server/` after a build:

```bash
node -r dotenv/config dist/scripts/diagnoseWebjsBootstrap.js
```

Bounded overrides are protocol/diagnostic constants:

- `WHATSAPP_WEBJS_DIAGNOSTIC_TIMEOUT_MS`: default 120s, clamp 30–300s;
- `WHATSAPP_WEBJS_DIAGNOSTIC_ERROR_CAP`: default 50, clamp 1–100;
- `WHATSAPP_WEBJS_DIAGNOSTIC_TEXT_CAP`: default 8,000, clamp 500–20,000.

The operator terminal is the sole destination for raw diagnostic output; the
script performs no log or database persistence. It should be invoked once by
an authorized operator when no other manual diagnostic is running.

The compiled script was exercised locally against the pin. It captured a
WhatsApp bundle console error stating storage-bucket persistence was denied,
then emitted QR and exited 0 in approximately four seconds. That error is
therefore nonfatal on the Mac and provides a precise comparison for the
production run. Deliberate browser teardown is suppressed from results so a
post-outcome `TargetCloseError` cannot be mistaken for the cause.

### Remediation map — options only, not implemented

The production stdout result should select the next course:

1. **`SecurityError`, `NotAllowedError`, or environment/anti-bot indication.**
   First validate with a controlled alternate egress. Prefer a dedicated
   company/office connector host or controlled residential business circuit
   over an opaque consumer proxy. The entire WhatsApp Web session—including
   page, static resources, WebSocket, LocalAuth ownership, inbound, and
   outbound—must use one stable egress. A partial resource proxy is invalid.
   Any proxy/alternate-host design requires security, credential, WhatsApp
   terms, and data-residency review before implementation.

2. **`TypeError`, `ReferenceError`, `SyntaxError`, or named module failure.**
   Treat it as a bundle/injection compatibility defect. Use the stdout stack
   and resource location to identify the failing module, then evaluate a
   specific upstream commit/fork or another integrity-pinned Web artifact.
   Do not add blind delays, cache guesses, or weakened initialization gates.

3. **Only the same storage-persistence denial followed by no QR.** Compare the
   subsequent console/page events with the Mac run, because that denial alone
   is demonstrably nonfatal. The first divergent event—not the shared storage
   warning—becomes the repair target.

4. **No browser exception before timeout.** The next bounded manual diagnostic
   may capture page state/network lifecycle or a one-time screenshot, but raw
   persistence must remain outside runtime. Do not infer anti-bot without a
   thrown class or controlled-egress A/B result.

5. **Strategic supported channel: Meta Cloud API.** Nexeo already has a
   `MetaProvider`, signed inbound webhook, registered-user resolution, inbound
   audio download/transcription, typing indicator, and text/voice reply path.
   Meta's Cloud API supports audio messaging, but switching requires verified
   business/number enrollment, webhook credentials, template/conversation
   rules, pricing, current Graph API/version review, and confirmation that
   Nexeo's use is eligible under current WhatsApp Business Platform terms.
   Treat this as a deliberate provider migration with text/voice/action parity
   acceptance, not an emergency flag flip.

The lowest-risk tactical experiment is controlled alternate egress; the more
stable strategic path is completing and validating the existing Meta channel
if policy and business enrollment permit it. Neither option was built in this
section.

### Company-number observation correction

The Admin screenshot's `+923001234567` was not a configured value. Code review
confirmed it is the empty input's literal placeholder. Actual configuration is
`whatsapp_config.connected_number` for the tenant `client_number`; the Admin
GET route also aliases that column as `company_number`. No database value was
observed or changed by Codex.

### Complete file list

- `server/src/services/whatsapp/webjsInitTelemetry.ts`
- `server/src/scripts/diagnoseWebjsBootstrap.ts` (new)
- `server/tests/webjsInitTelemetry.test.ts`
- `server/tests/webjsBootstrapDiagnostic.test.ts` (new)
- `Changes_Made.md`

No client file, package file, database schema, migration, provider routing, or
production configuration changed. The incident is connector/runtime evidence,
not a Brain conversation, so no chat archive/scenario pair was added.

### Tests and verification

```text
Focused init telemetry/diagnostic/cache/lifecycle: 29 passed, 0 failed (5 files)
Server: 1027 passed, 21 skipped, 0 failed (97 files passed, 1 skipped)
TypeScript: clean
Server production build: passed (Prisma 6.19.2 generation + tsc)
Compiled standalone diagnostic: QR outcome, exit 0, bounded stdout, clean teardown
git diff --check: passed
```

Client build was not required because no client file changed. The production
diagnostic remains a manual Reviewer operation; Codex did not run it on
production, commit, push, deploy, change egress, or switch providers.

## 29. Bootstrap diagnostic: CDP WebSocket/network observer (2026-07-21, BUILDER: Claude)

### Evidence and question
Production: page boots, one nonfatal storage warning, silence to timeout — no
exception, no QR (Section 28 diagnostic). Raw curl WS upgrade to
web.whatsapp.com/ws/chat over HTTP/1.1 returns **101 Switching Protocols**
from the box → network-level socket blocking eliminated. Remaining question:
does the PAGE open its WebSocket, and does the server answer on it?

### Change (Codex-approved proposal, all mandatory acceptance details honored)
- `server/src/scripts/diagnoseWebjsBootstrap.ts`: CDP session per observed
  page. All listeners registered BEFORE `Network.enable`; main-frame id via
  supported `Page.getFrameTree` (no Puppeteer privates); document events
  buffered until the frame id resolves so none are lost in the gap.
  Coverage state machine: 'pending' → 'full' only when the enabled observer
  itself sees the main-frame Document request to https://web.whatsapp.com
  (evidence retained: sanitized origin/path + timestamp) → 'late' when the
  page is found already navigated. Zero-socket classification is coverage-
  gated: full→no_socket_attempted; late→observer_late_or_inconclusive;
  pending→navigation_not_observed. Emitted events (each line-capped with
  complete tallies): ws_created(10), ws_handshake_response(10),
  ws_frame_sent(5), ws_frame_received(5), ws_frame_error(10), ws_closed(10),
  request_failed(errorCap). Frame payloads NEVER printed — byte length only
  (opcode 1 = UTF-8 bytes; others = decoded base64 bytes). All URLs through
  new `safeSocketUrl` (http/https/ws/wss, origin+path, 160 cap). Exactly ONE
  `network_summary` per execution (idempotent, emitted in finally before
  client destruction, defined zero-state on fatal paths): reason, observer
  status, coverage + evidence, zeroSocketClass, totals/emitted/suppressed.
  Attribution language bounded: sent-without-received proves downstream
  silence only; host attribution requires the matched Mac control.
- `server/tests/webjsBootstrapDiagnostic.test.ts`: +9 tests — wss/ws
  sanitization incl. query/fragment stripping and scheme rejection; unicode
  UTF-8 byte length; base64 binary length; per-class emit/suppress caps with
  tally reconciliation; coverage-gated zero-socket classification.

No schema, package, client, runtime-app, provider-routing, or invariant
changes. Manual-only; stdout-only; no server restart required to use.

### Verification (exact, self-run)
- Full server suite: 1039 passed / 21 skipped / 0 failed (97 files + 1 skipped)
- Focused diagnostic tests: 15 passed / 0 failed
- TypeScript: clean; server build: clean (Prisma 6.19.2); git diff --check: clean
- No client build required (no client files changed)

### Section 29 production result — RECORDED CLASSIFICATION (correction, 2026-07-21)
Production run (12:52–12:54 UTC): observer attached ~110ms after page
creation → coverage='late'; 120s attached window; totals all zero
(ws_created 0, request_failed 0). **Recorded classification:
observer_late_or_inconclusive** — per the agreed coverage model, this does
NOT prove the page never attempted a socket (inline/cached/service-worker
execution in the pre-attach window is not excluded), and downstream/egress
hypotheses are NOT declared moot. Accepted interpretation: no WebSocket
activity and no tracked request failures were OBSERVED during the attached
window; document navigation preceded coverage; early application/storage
initialization is a reasonable next suspect, not a confirmed root cause.
The builder's earlier "stalls before attempting its socket" claim in the
relay was an overreach and is withdrawn. Reruns must include
requestWillBeSent tallies by type; conclusive no_socket_attempted requires
observer enablement BEFORE navigation (full coverage).

## 29b. Diagnostic: headful toggle + version evidence for the matched Xvfb experiment (2026-07-21, BUILDER: Claude)

Scope: Codex-approved one-off matched headless-vs-headful experiment
(mechanism only — no provider/pm2/display change). Host resource check
came back pristine (12Gi available RAM, /dev/shm 7.8G at 0%, load 0.07,
ZERO Chrome processes) — resource starvation eliminated as a cause.

- `diagnoseWebjsBootstrap.ts`: `WHATSAPP_WEBJS_DIAGNOSTIC_HEADFUL=1`
  launches Chrome headful (requires DISPLAY, e.g. xvfb-run); everything
  else identical (same build/Chrome/webjs/verified cache/args/timeout).
  Mode echoed in diagnostic_start. New `wweb_version_evidence` line per
  run: pinned cache version vs page-reported live version (bounded 3s
  in-page probe, 40-char cap) — recorded per Codex's condition that a
  page-reported version alone doesn't prove pin consumption.
- Tests: headful default-off, exact-'1' opt-in, existing policy
  assertions extended.

### Verification (exact, self-run)
Full suite 1041 passed / 21 skipped / 0 failed (97 files + 1 skipped);
focused 17/17; tsc clean; build clean; git diff --check clean.

## 29c. Corrections to 5fe4c41 (2026-07-21, BUILDER: Claude — per Codex review)

**Ledger correction (append-only, supersedes the starvation conclusion in
§29b):** Resource starvation was not supported by post-failure idle-host
measurements; transient runtime starvation was not reproduced or
conclusively eliminated. (Idle readings were taken after the repair gate
had stopped Chrome retries.)

Code corrections in `diagnoseWebjsBootstrap.ts` + tests:
- `wweb_version_evidence` is now UNCONDITIONAL and idempotent — exactly
  one line per execution on every path incl. page-unavailable and
  early-fatal (nulls + classified probeStatus: ok | invalid_value |
  page_unavailable | probe_timeout | probe_error | not_attempted).
- Page-reported version goes through the strict `safeWwebVersion`
  validator — arbitrary page-controlled Debug.VERSION text is never
  printed; invalid → null + invalid_value.
- +6 tests: valid pin/live evidence, hostile page-controlled values,
  page-unavailable, timeout/error classification (error precedence),
  single unconditional finalization, zero-state fatal line.

Operational note (finding 5): the external experiment bound must exceed
internal timeout + probe (3s) + teardown (≤8s) — deploy commands use
`timeout 180s` for the default 120s diagnostic.

apt simulation evidence (recorded per approval): 8 NEW packages only —
libfontenc1, libxfont2, x11-xkb-utils, xfonts-{base,encodings,utils},
xserver-common, xvfb (2:21.1.12-1ubuntu1.6) — 0 upgraded, 0 removed, no
display manager. journalctl kernel log since 2026-07-14: no OOM events.

Process acknowledgment: 5fe4c41 published a code mechanism without a
pre-implementation proposal; the Codex review supplied the missing gate.
Future non-documentation code mechanisms get proposal approval BEFORE
implementation, per AGENTS.md.

### Verification (exact, self-run)
Full suite 1047 passed / 21 skipped / 0 failed (97 files + 1 skipped);
focused 23/23; tsc clean; build clean; git diff --check clean.

## 29d. Diagnostic lifecycle fix (2026-07-21, BUILDER: Claude — Codex blocking finding on a7b2ef2)

- `mkdtempSync` + `diagnostic_start` moved INSIDE the protected
  lifecycle; `sessionRoot` nullable until created; cleanup only when
  creation succeeded; both idempotent finalizers stay in the outer
  finally. A temp-dir failure now still emits one zero-state
  `wweb_version_evidence` + one `network_summary`
  (reason `fatal_before_bootstrap`). Guarantee scoped honestly: every
  operational path while stdout remains writable.
- Hardening: the 3s version-probe timer is cleared when page evaluation
  settles first (no lingering timer prolonging process lifetime).
- Regression test: forced mkdtempSync failure → run rejects, exactly one
  zero-state evidence line + one summary, zero diagnostic_start lines.

Timing disclosure: the matched Xvfb experiment was executed by Basit
with a7b2ef2 already pulled, crossing the reviewer's hold in flight.
Results (recorded in the Section 31 proposal): headless timeout/0
sockets vs headful-under-Xvfb QR at T+13s with sockets+frames both
directions and pin consumed (pageReportedVersion 2.3000.1043346688).
Root cause established as headless-mode environment interaction.

### Verification (exact, self-run)
Full suite 1048 passed / 21 skipped / 0 failed (97 files + 1 skipped);
focused 24/24; tsc clean; build clean; git diff --check clean.

## 31. Permanent fix: Web.js Chrome headful under Xvfb (2026-07-21, BUILDER: Claude — Codex-approved proposal)

**Pin-wording correction (append-only, per reviewer):** the §29/§31
experiment showed an *exact pin/page version match observed*
(2.3000.1043346688); consumption of the configured cache is strongly
supported but not independently proven. Supersedes my "pin consumed"
phrasing.

**Root cause (matched experiment, 2026-07-21):** WhatsApp Web bootstrap
stalls indefinitely in headless Chrome on the production host (timeout,
zero WebSockets); identical launch headful under Xvfb emits QR at T+13s
with bidirectional socket frames.

**Code (covers the failure class — BOTH QR providers):**
- NEW `server/src/services/whatsapp/webjsRuntimeMode.ts`:
  `resolveWebjsHeadlessMode` (headful ONLY on exact
  WHATSAPP_WEBJS_HEADFUL==='1'; default and all other values headless)
  + `assertHeadfulDisplayAvailable` (typed `WebjsDisplayError`:
  `headful_display_missing` when DISPLAY is absent/empty;
  `headful_display_unavailable` when a local ":N" DISPLAY has no
  /tmp/.X11-unix/XN socket; non-local forms accepted; no-op when
  headless). Env-driven bounded ops constant per AGENTS §2.8 — not
  behaviorConfig.
- `WebjsProvider.ts`: guard runs BEFORE client construction through the
  same flight-cleanup path as cache preparation (statusMap/initHealth
  'error', bounded last_error, flight token released → watchdog retry
  recovery preserved); `headless:` from the helper; display mode logged
  (boolean only).
- `UserWebjsProvider.ts`: same guard before client construction
  (writeMeta 'error' + typed bounded error in the status return);
  `headless:` from the helper. No hardcoded headless flags remain at
  any launch site (source-level test enforces).
- MetaProvider untouched by the flag (test-enforced).

**Tests (`tests/webjsRuntimeMode.test.ts`, 10):** default headless;
exact-'1' opt-in; 'true'/'yes'/'0'/''/' 1'/'TRUE' stay headless;
headless no-op without DISPLAY; missing/blank DISPLAY →
headful_display_missing (message names nexeo-xvfb.service); local
socketless DISPLAY → headful_display_unavailable; live socket + screen
suffix passes; non-local DISPLAY skips socket check; both providers
consume helper + no hardcoded headless (source-level); MetaProvider
free of the flag.

**Ops (executed by Basit; commands in Deployment Record):**
`nexeo-xvfb.service` (Xvfb :99, -nolisten tcp, no -ac, 0600 Xauthority
under 0700 /var/lib/nexeo-xvfb, ExecStartPost bounded socket-readiness
check, Restart=always, journal-bounded logs, enabled at boot);
pm2-root.service drop-in `Wants=nexeo-xvfb.service` +
`After=nexeo-xvfb.service` (weak dep — four co-hosted apps must not
fall with Xvfb; tmcai's guard is the fail-closed typed error); prod
server/.env += DISPLAY=:99, XAUTHORITY=/var/lib/nexeo-xvfb/Xauthority,
WHATSAPP_WEBJS_HEADFUL=1. No cookie or env values in Git.

**Rollback:** remove the three .env lines → pm2 restart tmcai-server
only → systemctl disable --now nexeo-xvfb → rm drop-in → daemon-reload
→ verify app online + WhatsApp status honestly reported (expected back
to init_timeout) → sessions untouched.

**Status: PARTIAL** until the reviewer's acceptance gates pass on
production (QR appears uncaptured → pairing ready → real inbound text
AND voice each answered by the actual Brain → controlled restart
reconnects without re-pair → runtime telemetry shows configured pin and
page-reported version separately → co-hosted apps untouched).

### Verification (exact, self-run)
Full suite 1058 passed / 21 skipped / 0 failed (98 files + 1 skipped);
focused 10/10; tsc clean; build clean; git diff --check clean.

## 31b. Fix: SSH X11-forwarding poisons ambient DISPLAY (2026-07-22, BUILDER: Claude)

**Production evidence:** first headful flight failed fast with
puppeteer's "Missing X server" while the guard had passed. dumpio probe
showed the truth: `node sees DISPLAY=localhost:11.0` + "MoTTY X11
proxy: Unsupported authorisation protocol" — the operator's SSH client
(MobaXterm) X11-forwards, `pm2 restart --update-env` injected that
ambient DISPLAY, and dotenv (by design) does not override existing
vars, so `.env DISPLAY=:99` silently lost; Chrome dialed the operator's
laptop instead of the host Xvfb. Manual `DISPLAY=:99 chrome` on the
service display succeeded, isolating the poisoning.

**Fix (covers the class):** dedicated `WHATSAPP_WEBJS_DISPLAY` /
`WHATSAPP_WEBJS_XAUTHORITY` env vars that no SSH session sets:
- `webjsRuntimeMode.resolveWebjsDisplayEnv()` — effective display env
  (dedicated vars win over ambient; null when headless or unset).
- `assertHeadfulDisplayAvailable` validates the EFFECTIVE display
  (socket check applies even when ambient DISPLAY is non-local).
- Both providers + the diagnostic pass `env: {...process.env,
  ...displayEnv}` to the Chrome child; display echoed (origin-free
  string) in the display-mode log line.
- Prod .env switches to the dedicated vars; ambient DISPLAY may be
  anything an SSH session says — WhatsApp Chrome no longer cares.
- Tests +6: headless→null, MobaXterm precedence scenario, ambient
  fallback, null when unset, effective-display socket validation,
  source-level both-providers-pass-env.

### Verification (exact, self-run)
Full suite 1064 passed / 21 skipped / 0 failed (98 files + 1 skipped);
focused 16/16; tsc clean; build clean; git diff --check clean.

## Deployment Record — 2026-07-22 — f04869b (WhatsApp restored)

1. Application release SHA: f04869b7cbcc6179a1833236421909dee2cc54fe
2. Reviewed remote HEAD: f04869b (same)
3. Production deployed SHA: f04869b (verified on box)
4. Documentation SHA: this commit

Ops applied by Basit: nexeo-xvfb.service (Xvfb :99, auth cookie 0600
under 0700 dir, socket-readiness ExecStartPost, enabled at boot);
pm2-root.service.d/nexeo-xvfb-order.conf (Wants/After weak dep); prod
.env → WHATSAPP_WEBJS_HEADFUL=1 + WHATSAPP_WEBJS_DISPLAY=:99 +
WHATSAPP_WEBJS_XAUTHORITY (ambient DISPLAY/XAUTHORITY lines removed,
.env.bak-20260722 kept). Stale restored session quarantined as
session-TMC-0001.stale-restore-20260722.

**Outcome: WhatsApp QR pairing restored 2026-07-22 ~09:14Z** after a
6-day outage. Full cause chain (each proven by experiment):
(1) WhatsApp Web bootstrap stalls in headless Chrome on this host →
Xvfb headful; (2) SSH X11 forwarding poisoned ambient DISPLAY via
pm2 --update-env → dedicated WHATSAPP_WEBJS_DISPLAY; (3) the 07-21
restore experiment's stale session blocked fresh QR → quarantined;
(4) watchdog recycles init flights silently (no init_timeout log,
no repair-gate escalation) — OPEN BUG, hardening pass; (5) status
field reads 'connecting' while a QR is live in qr_code — operator
surface gap, hardening pass.

Acceptance: inbound text → real Brain reply VERIFIED live ("Hi" →
"Hi Sir. How can I help you?"). Voice-inbound gate and controlled-
restart gate pending → release status **PARTIAL** until both pass.
Known follow-ups (queued): "Whatsup?" greeting misrouted into blocker/
intervention flow with voice reply; ⏳ Thinking… should be reaction +
native typing, not a separate message; Reset-Pairing UI hangs when no
client exists; watchdog silent recycle; status/qr surface parity.

## 32. WhatsApp UX fixes A+B (2026-07-22, BUILDER: Claude — Codex-approved with conditions)

**Evidence-first (per reviewer conditions):**
- A: production activity logs show `Activity state send failed`/
  `LID-mapped activity state failed` (minified webjs error "r: r") with
  NO reaction failure — the reaction succeeded, yet the code fell back
  to the ⏳ text on state failure alone.
- B: greeting "Whatsup?" consumed by an awaiting action-status prompt —
  `looksLikeAnswer`'s regex lists hi/hello/hey but not whatsup; the
  blocker/intervention side-effect answered a greeting.

**A — either-limb visible activity** (`inboundActivity.ts`): text
fallback only when BOTH reaction and native presence failed, still
at-most-once; voice reacts 🎙️. Presence refresh (15s), @lid retry,
non-blocking failures, idempotent stop, reaction removal unchanged.
Tests: 8 (reaction-ok+state-fail → no fallback across pulses; both-fail
→ exactly one; state-ok+reaction-fail → none; voice glyph; @lid).

**B — LLM relevance gate** (`promptReplyRelevance.ts` + handler):
regex demoted to prefilter; consumption requires confident
`answers_pending_prompt` (threshold 0.7, bounded protocol constant);
new_conversation_turn / ambiguous / low-confidence / malformed output /
classifier failure ALL fall through to chat with the prompt left
awaiting. Voice and text share the decision (transcripts enter the same
handler). Archive `## Chat 13` + `chat13` scenario paired (fix commit
741d907). Tests: 11 (verdict parsing incl. hostile shapes, decision
rule, transport, handler integration: greeting declined / blocker
answer consumed / classifier failure → no mutation / roman-Urdu
ambiguous → chat).

**Pin-wording correction (per reviewer):** §31's experiment showed an
exact pin/page version match observed; cache consumption is strongly
supported, not independently proven.

**Deployment note:** messaging-path change — deploy held until the two
§31 acceptance gates (voice inbound, controlled restart) pass or Basit
waives them, per reviewer sequencing.

### Verification (exact, self-run)
Full suite 1079 passed / 21 skipped / 0 failed (99 files + 1 skipped);
promptReplyRelevance 11/11; whatsappInboundActivity 8/8; tsc clean;
build clean; git diff --check clean.

## 33a. Delegation lifecycle spine — capture/evidence/classification/owner-notify (2026-07-22, BUILDER: Claude — REQ-003 APPROVED)

**Scope fence honored:** capture + evidence + classification + owner
notification ONLY. Zero counterpart sends from any 33a code
(source-level test); grants schema exists with ZERO create/read/consume
(source-level test); autonomous outbound flag default OFF with no
consumer; capture flag DEFAULT OFF (env kill switches
DELEGATION_CAPTURE_ENABLED=0 / DELEGATION_AUTONOMOUS_OUTBOUND_ENABLED=0
override everything).

**Migration `20260722_delegation_threads`** (additive-only, idempotent —
verified by double-apply locally): delegation_threads (NOT NULL
counterpart_key 'wa:+E164'/'em:addr', channel-shape CHECK, state CHECK,
active-state partial uniques + correlation/recovery indexes, scope
unique for composite FKs), delegation_thread_events (append-only;
inbound dedup partial unique; classification idempotency unique;
outbound provider unique scoped to tenant+channel+sender_identity),
delegation_authorization_grants (schema only), correlation_incidents
(owner-in-dedup unique) + correlation_incident_candidates (composite
scope FKs make cross-owner disclosure structurally impossible).

**Code:**
- `delegationThreadService.ts`: state machine (12 states, CAS-only
  transitions transactional with their event; THREAD_TRANSITIONS is the
  single legal table, test-locked to the migration's active set);
  intent/receipt binding (activeIntentEventId — stale receipts are
  audit-only; failed receipt: newly-created→cancelled judged from the
  ledger, pre-existing→restore recorded prior state; late accepted on
  receipt_unknown→awaiting_reply; late failed after inbound evidence
  never rolls back); canonical keys; flags.
- `delegationCaptureService.ts`: correlation = quoted provider id /
  In-Reply-To first, else exactly-one-active-thread; dispatch_pending
  eligible only with transport-attempt evidence; zero matches →
  pre-existing silent drop (no notice, no storage); >1 → per-owner
  correlation incidents (row-locked candidate cap + overflow, owner-tz
  incident date w/ UTC fallback) with owner-scoped notices; consume =
  inbound event + CAS → evaluating; classification persisted FIRST
  (idempotent key) then thread transition (completed→
  resolved_pending_owner, blocked/low-conf→awaiting_owner,
  in_progress/unrelated→awaiting_reply; unrelated is silent);
  classifier failure → processing_error + owner notice, state
  unchanged; evidence via typed source refs; owner notices deduped per
  (thread, class, day).
- `actionLifecycleService.ts`: `interpretActionReplyStrict` (LLM-only,
  null on failure — no regex fallback) + `mode:'thread_capture'` in
  recordActionLifecycleReply (no transitionStatus close, no dueDate
  mutation, interpretation required).
- `WhatsAppInbound.ts`: unregistered branch now routes through
  captureDelegationReply (flag-gated; OFF ⇒ silent drop);
  quotedProviderId plumbed from WebjsProvider.
- `WebjsProvider.ts`: 🎙️ "Heard:" transcription echo now gated on
  registered identity — unregistered senders receive NOTHING.
- `actionLifecycleWorker.ts`: WhatsApp counterpart sends register
  intent-before-transport/receipt-after (correlation evidence only —
  no grant, no 33b eligibility); counterpart sendUserEmail branch
  DISABLED FAIL-CLOSED (user-identity email forbidden for
  counterparts; owner-escalation path takes over).
- RETIRED: expectedExternalReplyService (deprecated, zero callers —
  test-pinned), delegateeFollowupWorker (was already unwired;
  stays-retired test).
- `delegationTrackerService.ts`: 33a adapter — email replies route
  through thread correlation when capture is on; legacy behavior
  intact when off. DISCLOSED: the delegatee-mirror update is deferred
  to 33b when capture is enabled.
- NEW `delegationRecoveryJob.ts` under centralActionGovernor
  (protectedTick, hourly): dispatch_pending past recovery window →
  receipt_unknown (never resends; deduped owner notice); active
  threads past TTL → expired (marked, kept).
- behaviorConfig: 5 new specs (2 flags def=0; recovery window 30min
  [5-240]; thread TTL 30d [3-120]; ambiguity cap 10 [3-25]).

**Tests:** `delegationThreads33a.test.ts` (27) — canonicalization incl.
variants + fail-closed; transition-table integrity + migration
lockstep + additive-only proof; flag defaults + env kills; illegal/
CAS-conflict/duplicate-event semantics; stale-receipt audit-only; late
receipt after inbound; newly-created-cancel vs prior-state-restore;
upsert race re-select; strict classifier null-on-failure; thread_capture
refuses without interpretation + never closes/mutates dueDate;
source-level: zero counterpart sends, zero grant consumers, email
branch fail-closed, voice echo gated, retired services stay retired,
no regex injection gate. Plus governor manifest updated.

### Verification (exact, self-run)
Full suite 1106 passed / 21 skipped / 0 failed (100 files + 1 skipped);
33a matrix 27/27; tsc clean; build clean; git diff --check clean;
migration double-apply idempotent on local PG17 with all 5 tables
verified.

**DEPLOYMENT: HELD** per reviewer sequencing until §31 voice/reaction +
formal restart gates close or Basit waives. Deploy order (prepared):
pull SHA → verify HEAD → project-local `prisma db execute` migration →
schema verification → build → restart tmcai-server only → enable
capture for TMC-0001 (behaviorConfig) → live acceptance incl. the
single authorized baseline dispatch.

## 34. WhatsApp liveness self-verification (2026-07-23, BUILDER: Claude — REQ-007 build clearance with locks)

**Claim boundary (documented + telemetry-labeled):** a passed probe
verifies OUTBOUND TRANSPORT + LOCAL MESSAGE-EVENT ECHO liveness only —
no remote-inbound claim; external canary out of scope unless the owner
authorizes one. Probe = operational self-chat traffic (visible on the
tenant phone/linked devices), opaque marker `[nexeo-liveness <nonce>]`,
content never persisted.

**Status truth:** ready → `connected_unverified` (send-blocked — the
existing gates require exactly 'connected', verified unchanged); probe
pass is the ONLY promotion to `connected` (single such write on the
webjs path, test-pinned); 1st fail → `liveness_failed` + one bounded
re-init (watchdog-owned, flight-fenced); 2nd consecutive → `degraded` +
repair flag + one primary alert per episode via the independent path
(system_logs + admin surface). Backoff/reconnect reset MOVED from ready
to probe pass (lock 5). Counter is TENANT-scoped, survives generations,
resets only on pass (lock 1). Degraded reprobes: 30-min spacing + a
TOTAL episode cap of 6; exhausted ⇒ probes stop, sends stay blocked,
manual repair required; pass opens a fresh episode (lock 4).

**Probe engine** (`webjsLiveness.ts` pure core + provider
orchestration): observer registered before send; strict identity —
tenant + generation + fromMe + self-chat + exact nonce + provider-id
reconciliation; early echo buffered until sendMessage() returns its id,
mismatch fails (locks 2-3); single in-flight probe per tenant; all
listeners/timers removed on every settle path; bypasses Brain routing,
delegation capture, persistence, quotas, reactions/dedup (fromMe never
enters the normal pipeline + probe path touches none of them,
test-pinned).

**Silent-recycle root fix:** the expired-flight replacement branch now
classifies init_timeout, persists the failure + timestamp, increments
consecutiveTimeouts, advances the repair gate at the policy cap, and
emits the standard "initialization failed" telemetry BEFORE disposing
the wedged client; the superseded flight's late rejection stays ignored
(exactly-once accounting).

**Watchdog/consumers:** DB scan extended to the three new states with
the explicit decision table (wait_for_probe / capped_reprobe /
bounded_reinit / withhold_for_repair); no consumer equates ready or
client-existence with send-capable. whatsapp_config.status is
VARCHAR(20) with no CHECK — 'connected_unverified' fits at exactly 20
chars (flagged: widen to VARCHAR(32) in a future housekeeping
migration).

**Telemetry:** initHealth gains readyAt, probePassedAt/FailedAt,
probeLatencyMs, probeGeneration; classified failures + liveness
transitions logged; admin /whatsapp-health surfaces via existing init
field.

**Tests** (`webjsLiveness.test.ts`, 25): full Codex matrix + all 9
locks — identity rejections (no-fromMe, non-self chat, stale gen, wrong
tenant/nonce), duplicate-echo idempotence, early-echo buffering +
id-mismatch failure, tenant counter across generations, pass-only
reset, episode cap + once-per-episode alert, send-capability table,
watchdog decisions, and source-level wiring proofs (ready≠connected,
backoff-reset location, single connected-write, observer-before-send,
expired-flight accounting, probe-bypass, gate integrity).

### Verification (exact, self-run)
Full suite 1131 passed / 21 skipped / 0 failed (101 files + 1 skipped);
focused 25/25; tsc clean; build clean; git diff --check clean. No
migration (status column verified unconstrained).

## 35. MEM-005 — one pgvector embedding provider; the open-item embedding path retired (2026-08-11, BUILDER: Claude — REVIEWER-approved Option 3 with amendments)

**Observed behaviour.** Two of three embedding implementations were still POSTing to
`text-embedding-004`, an endpoint Google retired on 2026-07-14. MEM-001 (2026-08-10)
migrated the wiki path to `gemini-embedding-001` and could not reach the other two, because
each owned a private copy of the provider call, the model constant, the normalisation and
the stub. Twenty-eight further days passed with the copies broken.

**Confirmed root cause (from code and the live database, not hypothesis).**

1. *Duplication.* Three private provider implementations. A fix to one is structurally
   incapable of reaching the others. This is the fifth recorded recurrence of
   `protection-with-two-implementations`.

2. *The open-item path had no storage at all.* `open_item_embeddings` was DROPPED on
   2026-05-18 (`schema.prisma:1211`, "orphan, never referenced"). Verified against
   production: `SELECT to_regclass('public.open_item_embeddings') IS NOT NULL` → `f`, and
   `typeof prisma.openItemEmbedding` → `undefined`. Every call therefore threw a TypeError
   on the undefined model property — which `.catch(() => null)` could never intercept,
   because the throw happens before a promise exists. The outer `try/catch` turned it into
   a `console.warn`. Every open-item creation since May did this work, failed, and said
   nothing. Its only reader, `GET /open-items/:id/similar`, returned 500 for its entire
   lifetime; no client code called it.

3. *The chunk repair sweep could not see what it existed to repair.* It selected
   `embedding_model IS NULL OR embedding_model = 'legacy-unknown'` — the two stale models
   known when it was written. `text-embedding-004` rows were excluded from the sweep AND
   from search (which filters on the current model). Stranded in both directions.

**What changed.**

- **New** `server/src/services/knowledge/pgVectorEmbeddingProvider.ts` — sole owner of the
  model, the 768-dim contract, `outputDimensionality`, bounded input, unit normalisation,
  key selection, stub policy, response-shape validation, and embeddingGuard
  degradation/recovery. Reuses `MODEL_EMBEDDING` from `config/models.ts`; no second model
  constant was introduced. It declares its own `PGVECTOR_EMBEDDING_DIM = 768` and does NOT
  reuse `EMBEDDING_DIMS` (3072), because `pipeline/embedder.ts` is a separate live pipeline
  at the model's native width — the dimension is a property of the destination column, not
  of the model. That pipeline is untouched.
- `wikiEmbeddingService.ts`, `chunkVectorService.ts` — migrated; private provider,
  normalisation, stub and vector-literal helpers deleted. Storage and retrieval semantics
  unchanged.
- `chunkVectorService.ts` — stale selection is now `embedding_model IS DISTINCT FROM
  <current>`, covering NULL, `legacy-unknown`, `stub-768`, `text-embedding-004` and
  whatever supersedes the current model next. The sweep now **stops** on provider failure
  instead of continuing: the old loop would file one degradation per row (up to 100
  identical findings) against a provider already known to be down.
- `schedulerService.ts` — tenant discovery uses the same predicate. Previously a tenant
  whose chunks were *all* on a retired model was never selected, so its sweep never ran.
- **Deleted** `server/src/services/triage/openItemEmbeddingService.ts`; removed its call in
  `openItemsService.ts` and the `GET /:id/similar` route in `openItemsRoutes.ts`.
- `db/prisma.ts` — removed three phantom entries from the tenant-guard registries:
  `OpenItemEmbedding`, `ItemStatusHistory` and `BrainPersona`. None is a real Prisma model,
  so each guarded nothing while reading as coverage. `BrainPersona` was found by the new
  test, not by reading; it has no runtime usage anywhere.
- `embeddingGuard.ts` — comments corrected; `open_items` dropped from the default health
  set, since nothing can report it now.

**Files changed (complete).** `server/src/services/knowledge/pgVectorEmbeddingProvider.ts`
(new) · `server/src/services/knowledge/wikiEmbeddingService.ts` ·
`server/src/services/knowledge/chunkVectorService.ts` ·
`server/src/services/knowledge/embeddingGuard.ts` · `server/src/services/schedulerService.ts` ·
`server/src/services/openItemsService.ts` · `server/src/routes/openItemsRoutes.ts` ·
`server/src/db/prisma.ts` · `server/src/services/triage/openItemEmbeddingService.ts` (deleted) ·
`server/tests/mem005EmbeddingProvider.test.ts` (new) · `server/tests/embeddingGuard.test.ts`.

**Test changed, and why it is not a weakening.** `embeddingGuard.test.ts`'s recovery test
used `open_items` as its sample service. That service no longer exists, so the sample was
changed to `chunks`. The assertion — degrade, recover, expect `ok` — is unchanged.

**Verification (exact, re-run after the last edit).**
- `npx tsc --noEmit` — clean.
- `npx vitest run` — **159 passed | 1 skipped (160 files)**; **1788 passed | 7 expected fail
  | 21 skipped | 1 todo (1817)**; 0 failed.
- Focused embedding suites (`def118StaleModelReembedded`, `embeddingGuard`,
  `mem005EmbeddingProvider`) — **3 files, 40 tests, all passed**. MEM-005 alone: 21.
- `npm run build` — passes. `git diff --check` — clean.

**Migration status: NONE.** No schema change, no dependency change, no new timer, no
`prisma migrate` of any kind. `chunks.embedding_model` is `VarChar(50)`; the current model
id is 20 characters.

**Local verification does not prove production memory recovery.** The suite proves the
provider requests the right model at the right width and that the sweep selects every stale
model. It cannot prove that production rows are being rewritten. That requires the
post-deploy counts below.

**Pre-deploy production baseline (2026-08-11 13:08 UTC).**
`wiki_pages`: `gemini-embedding-001` 10,476 · `stub-768` 2,039.
`chunks`: 0 rows total, 0 with vectors — so the chunk fix is correct but **has no data to
act on and cannot be evidenced in production**. Stated plainly rather than claimed.
`open_item_embeddings`: absent.

**Known issues deliberately NOT fixed here.**
- `ItemStatusHistory` — same removal drift, but with LIVE writes inside the accepted-
  transition transaction (`lifecycleService.ts:104,154`) and two reads in
  `openItemsRoutes.ts`. Logged as its own defect with its own proposal; removing the dead
  registry entry neither fixes nor conceals it.
- `memoryDecayJob.ts` unscoped hard delete — separate proposal, explicitly out of scope.

## Deployment Record — 2026-08-11 — `ccbdfda`

Four SHAs, named explicitly per AGENTS.md §5:

1. **application release SHA** — `ccbdfda` (the reviewed code commit)
2. **reviewed remote HEAD** — `ccbdfda` (what `origin/feat/nexeo-one-brain` pointed to at review time)
3. **production deployed SHA** — `ccbdfda` (`git rev-parse HEAD` on the box after build + restart)
4. **documentation/report SHA** — `662ae57` (docs-only; it records the outcome and was
   **never live-tested** — production was not pulled to it, and the two commits differ only in
   `Changes_Made.md` and `brain_evaluation_chart.md`)

This repo IS the production checkout, so no pull was required; the build was made in place and
`pm2 restart tmcai-server` was run without `--update-env`, which poisons `DISPLAY` for Chromium.

**Wiki path VERIFIED LIVE.** `sweepWikiEmbeddings(25)` through the new shared provider returned
`attempted 25, embedded 25, degraded false`. Persisted rows inspected in the database:
`embedding_model = gemini-embedding-001`, `vector_dims = 768`, `L2 norm = 1.0000`. Stale
`stub-768` fell 2,039 → 2,014; current rows rose 10,476 → 10,501. Health endpoint `healthy`,
database up, clean boot.

**Chunk path NOT VERIFIED and cannot be**: `chunks` has 0 rows. Reported as unfalsifiable rather
than counted as a success.

**Convergence estimate (evidence-based, not a promise):** the scheduled sweep is 200 rows per
hourly run, so ~11 cycles for the remaining 2,014 if the provider stays healthy and no new stale
rows appear. One measured data point (25/25) so far.

### MEM-005 follow-up — REVIEWER post-deploy findings closed (2026-08-11)

Three findings from the post-deploy review, all accepted.

**MEDIUM — chunk staleness had two implementations again.** `STALE_CHUNK_MODEL_SQL` was
exported and used by nothing, while the predicate was written out a second time in the sweep
and a third time in `schedulerService`. That is the exact disagreement class MEM-005 exists to
remove, rebuilt inside the fix for it. Replaced with `staleChunkModelPredicate(paramIndex)`,
now called by BOTH sites. A supplementary test asserts the literal appears exactly once in
non-comment source, so a fourth copy cannot be added quietly.

**LOW — the non-finite-vector test was tautological.** `!finite || finite` is always true; it
asserted nothing. Worse, the finding was correct about the provider too: `typeof n === 'number'`
accepts `NaN` and `Infinity`, and pgvector accepts them as well — after which every distance
against that row is `NaN` and the row is unmatchable forever while reading as embedded.

The provider now requires every component to be `Number.isFinite`, and additionally rejects a
zero-magnitude vector: right width, all finite, and still meaningless, because it has no
direction and cosine against it is undefined. Both cases return null, record degradation, and
**stamp no recovery** — recovery must mean the provider is usable, not merely reachable. Six
real assertions replace the tautology, including that a rejected vector cannot clear an existing
degradation.

**LOW — deployment documentation did not follow the four-SHA protocol.** Retitled to
`## Deployment Record — 2026-08-11 — ccbdfda` and all four SHAs named, including the
documentation/report SHA `662ae57`, which is stated as never live-tested.

**Files changed.** `server/src/services/knowledge/pgVectorEmbeddingProvider.ts` ·
`server/src/services/knowledge/chunkVectorService.ts` · `server/src/services/schedulerService.ts` ·
`server/tests/mem005EmbeddingProvider.test.ts` · `Changes_Made.md`.

**Verification (re-run after the last edit).** `npx tsc --noEmit` clean · `npx vitest run`
**1795 passed | 7 expected fail | 21 skipped | 1 todo (1824 across 160 files), 0 failed** ·
focused embedding suites **3 files / 47 tests / all passed** (MEM-005 alone 28, up from 21) ·
`npm run build` passes · `git diff --check` clean. No migration, no dependency change.

## 36. DEF-127 + DEF-128 — status ledger restored; refused transitions no longer reported as done (2026-08-11, BUILDER: Claude — REVIEWER-approved with amendments)

**DEF-127 root cause.** `item_status_history` was dropped 2026-05-18 as an "orphan".
`transitionStatus` writes it inside the SAME transaction as the status update, so with the
table and model gone, `(tx as any).itemStatusHistory.create` threw and the transaction
REVERTED the status change. Proven on production by a read-only aborted probe:
`typeof tx.itemStatusHistory === 'undefined'`. Two live paths were broken: the Open Items
page status control and Brain's `mark_open_item_done` / `delegate_open_item`.

The drop note claimed `open_items.notes` replaced it. Measured: 24 note entries across 7 of
277 items, **none** recording a status change.

**Amendments applied as directed.** `user_id` NOT NULL with grounded recovery (joined on
tenant AND item, `RAISE EXCEPTION` if any row cannot be grounded); `userId` passed explicitly
into **every** `recordHistory` call including all four rejected branches; global `created_at`
index dropped; new migration folder; no historical backfill.

**DEF-128, found BY the restored ledger during this build's acceptance.** A real Brain turn
answered `Marked "…" done.` while the audit row written in the same second said
`NEW->CLOSED rejected — approval required, none provided` and the item was still NEW.
`transitionStatus` returns `{ok:false}` for a refusal rather than throwing; both Brain call
sites discarded the result. `delegate_open_item` also queued a delegatee email for a
delegation that never happened. Both now read the result and emit a bracketed marker.

**Files changed.** `server/prisma/migrations/20260811_item_status_history_restore/migration.sql`
(new) · `server/prisma/schema.prisma` · `server/src/services/itemLifecycle/lifecycleService.ts` ·
`server/src/routes/openItemsRoutes.ts` · `server/src/services/knowledge/brainComposer.ts` ·
`server/src/db/prisma.ts` · `server/tests/def127StatusLedger.test.ts` (new).

**Verification.** `tsc` clean · `vitest` **1818 passed | 7 expected fail | 21 skipped | 1 todo
(1847 across 161 files), 0 failed** — 23 new · `npm run build` passes · `git diff --check` clean.

**Migration verified on production** (applied by `psql` before restart; never `npx prisma` on
prod): `user_id` NOT NULL, three indexes present, `count(*) = 0`, and a **second run of the
same file produced 0 errors** — idempotency demonstrated on production, not merely asserted.
Recorded in `_prisma_migrations`.

**Live acceptance — dedicated test items only, never a real business item.**

| # | Path | Transition | Ledger row |
|---|---|---|---|
| 1 | UI `POST /open-items/:id/status` (real HTTP, real auth) | NEW→TRIAGED | accepted, user 2, `user:2` |
| 2 | Brain `mark_open_item_done` (real LLM turn) | NEW→CLOSED | **rejected** — exposed DEF-128 |
| 3 | Brain, after the DEF-128 fix | NEW→CLOSED | rejected, and Brain said so honestly |
| 4 | Brain `mark_open_item_done` | TRIAGED→CLOSED | accepted, user 2, `user:2` |

Exactly one accepted row per verified path, correct tenant, user and actor. Both test items
were closed afterwards so nothing fake remains in the Action Center.

**Bypass classification (next proposal, investigated — not implemented).** 24 direct
status-write sites bypass `transitionStatus`:

| Family | Sites | Where |
|---|---|---|
| **A — active user/Brain** | 12 | `openItemsRoutes` ×4, `promptReplyHandler` ×4, `briefRoutes` ×2, `brainComposer` ×1, `openItemsService` ×1 |
| **B — delegation lifecycle** | 3 | `delegationTrackerService` ×2, `handlers/lifecycle/archive` ×1 |
| **C — background/cleanup** | 8 | `openItemsBacklogCleanupJob` ×6, `openItemDraftAskJob` ×2 |
| **D — dead** | 1 | `actionExecutionService` (test-only module) |

**Two vocabulary gaps block a naive migration of Family A**, and are why some bypasses exist:
- `brainComposer:3497` writes `CANCELLED`, which is **not in `ALL_STATUSES`** — `remove_open_item`
  has no legal transition to express itself.
- **6 production items sit in `DONE`**, also outside the v15 set. `transitionStatus` refuses them
  (*"current status DONE is not in the v15 lifecycle"*), so those items are currently unmovable.

Family C should NOT use the same semantics: cleanup closes items in bulk on policy, not on a
user's intent, and needs a governed audit-writing path with its own actor and reason.

## 37. DEF-129 — Family A: CANCELLED as a real reversible outcome, atomic transitions, legacy DONE normalised (2026-08-11, BUILDER: Claude — REVIEWER-approved with amendments)

**Why the bypasses existed.** `remove_open_item` wrote `status: 'CANCELLED'` directly and
mark-wrong wrote the legacy lowercase `'closed'`. Neither was carelessness: the matrix had no
CANCELLED, so there was no legal transition to request, and CLOSED was the only terminal
state. Closing an item the owner asked to REMOVE records work as completed that never
happened.

**All amendments applied.** CANCELLED added as canonical and reversible (7 ways in, plus
`CANCELLED → TRIAGED`); `DONE` normalised by migration rather than added as a status;
delegatee fields, status and ledger made one atomic transaction via `TransitionContext.itemData`;
policy-based triage-cleanup writes left in Family C; CANCELLED used for removal, mark-wrong and
undo-created-item; `/metrics` moved above `/:id`; behavioural tests added.

**Two consequences found while building, both closed here.** Adding a second terminal state
would have left cancelled work in the active list and still being chased — fixed with one
shared `INACTIVE_STATUS_VALUES` plus explicit CANCELLED in the raw-SQL chasing paths. And the
"user marked wrong 3×" learning gate queried `status: 'closed'`, so it would have silently
stopped matching the day mark-wrong began writing CANCELLED.

**The 21-transition boot guard fired on the first test run** and was raised to 29 with the
arithmetic stated (7 in, 1 out) — updated with reasoning, not loosened.

**Verification.** `tsc` clean · `vitest` **1837 passed | 7 expected fail | 21 skipped | 1 todo
(1866 across 162 files), 0 failed** — 19 new · build clean · `git diff --check` clean.

**Live acceptance, dedicated test items only, every result read back from the database:**

| Test | Result |
|---|---|
| Brain delegation | TRIAGED→DELEGATED accepted, delegatee set, 1 ledger row |
| **Refused delegation** | NEW→DELEGATED rejected — `delegatee_name`, `delegatee_email`, `delegatee_id` **all NULL** |
| Cancellation | TRIAGED→CANCELLED accepted |
| Restoration | CANCELLED→TRIAGED accepted — the item came back |
| DONE normalisation | 6 rows moved, 6 audit rows, re-run changed nothing |

**NOT verified, and logged rather than glossed: DEF-130.** Asked to delete an item, Brain
replied *"I don't have the capability to delete open items directly"* and offered to mark it
done instead — denying a capability it has, and offering the one alternative that would record
work that never happened. Removal is proven at the service layer, not through conversation.
Same class as DEF-106/DEF-113; the fix belongs in the capability description, not in new code.

---

## 38. DEF-130 — the action registry is seeded at boot; two working capabilities Brain denied having (2026-08-11, BUILDER: Claude — orchestrator iteration 2)

**Observed.** Asked to *"delete the open item called …"*, Brain replied *"I don't have the
capability to delete open items directly, Sir. I can mark them as done…"* — denying a real
capability, and offering the one alternative that records work which never happened.

**Root cause — not the one the handoff predicted.** The prior note said `remove_open_item` was
"registered, seeded, dispatchable" and that only Brain's *description* of it was wrong. Seeded
in the **file**; never in the **database**. `brainCapabilityLive.renderCapabilityBlockLive()`
builds the CAN side of the capability truth-table from `action_definitions` rows via
`listActiveActions`. Production held **16 of the 18 types** declared in
`seedActionDefinitions.ts`:

```
seed file:   18 types        production: 16 rows
missing:     remove_open_item   (added to the seed by DEF-106, ed3f8ee)
             create_contact     (added to the seed by DEF-058, b284ecf)
```

The seeder was a hand-run CLI (`npx ts-node src/scripts/seedActionDefinitions.ts`) that
**nothing in the application ever invoked** — the only other occurrence of its name anywhere in
`src/` is a log string suggesting an operator re-run it. So both DEF-058 and DEF-106 shipped a
complete capability — parser, dispatch branch, confirmation policy, and for removal a live
`→ CANCELLED` transition — that never appeared in a single prompt.

Brain's denial was therefore **honest**. The block it was handed is headed "never fabricate
capabilities" and genuinely did not list removal; `mark_open_item_done` *was* on it, which is
exactly why that was the alternative it offered. No amount of prompt rewording would have
fixed this, and the fix the handoff proposed would have been aimed at the wrong layer.

**Why the guard could not catch it.** `tests/capabilityDiscovery.test.ts` compares the seed
file against `COMPOSER_DISPATCHED_TYPES` — file against file. Nothing compared the file against
the database. The suite was green the entire time both capabilities were invisible.

**Commit `19eab06`. Fix — structural, and it closes the class rather than the two instances.** The registry is
reconciled on every boot, the same idempotent pattern `seedSystemRules`, `bootstrapAllTenants`
and `seedSystemRiskRules` already use in `server.ts`. The seed file becomes the source of truth
and applies itself, so a future action is live the moment it deploys instead of waiting on
someone remembering a script. No new mechanism, no wrapper, and the deploy that ships this also
performs the data repair — there is no manual row insert to forget.

**Files changed (complete):**

| File | Change |
|---|---|
| `server/src/scripts/seedActionDefinitions.ts` | Loop extracted to exported `seedActionDefinitions()` returning the count; `main()` calls it; CLI entry point unchanged |
| `server/src/server.ts` | Boot call added beside the existing idempotent seeders, non-fatal `.catch` like its neighbours |
| `server/src/services/knowledge/brainCapabilityRegistry.ts` | Contact-add re-pointed from the stale `POST /entities` handle onto the real `create_contact` action type |
| `server/tests/capabilityDiscovery.test.ts` | The `POST /entities` guard relocated, not dropped — see below |
| `server/tests/def130ActionRegistrySeededAtBoot.test.ts` | **New**, 9 tests |

**Why `create_contact` had to be handled in the same change.** Seeding the file seeds it too —
that is not optional once the boot hook exists. It had no `CAPABILITY_HINTS` entry, because its
capability row still carried the pre-DEF-058 handle `POST /entities`. Left alone it would have
rendered **twice**: once from the registry as a bare undescribed `create contact`, and once as
the curated REST line. Re-pointing the handle onto the action type collapses both into one
described entry generated from the thing that actually dispatches.

**Guard updated with reasoning, not weakened.** `capabilityDiscovery.test.ts` asserted
`NON_ACTION_CAPABILITIES` contains `POST /entities`. Contact creation is no longer a REST-only
path, so that assertion's *purpose* — an undeclared capability is precisely what DEF-058 and
DEF-113 were — was moved onto the registry mechanism: `create_contact` must have a hint, with a
label naming contacts and a description long enough not to render as a bare label.

**Mutation results — run, not asserted. 5 of 5 mutants killed:**

| Mutant | Outcome |
|---|---|
| `preApproved: true` → `false` | **killed** (3 tests) — an unapproved row is `approval_required`, still invisible |
| Seeder skips the last action | **killed** — count reconciliation |
| Boot wiring removed from `server.ts` | **killed** — by the source-text supplement only |
| Contact handle reverted to `POST /entities` | **killed** |
| Contact description stubbed to "Adds a contact." | **killed** |

**The honest weakness.** Every behaviour test passes whether or not anything calls the seeder —
which is the exact shape of the original defect: a correct function nobody invoked. `server.ts`
calls `app.listen`, so boot cannot be exercised in a unit test. The wiring is covered by a
source-text assertion, which per the working rules is a supplement and not proof. It is the
only evidence the wiring exists, and it is labelled as weak in the test itself.

**Verification, re-run from `server/` after the last edit:**

```
npx tsc --noEmit    exit 0, no output
npx vitest run      Test Files  163 passed | 1 skipped (164)
                    Tests  1888 passed | 7 expected fail | 21 skipped | 1 todo (1917)
npm run build       exit 0
git diff --check    exit 0
```

Baseline immediately before this change was 162 files / 1878 passed / 1907 total. Delta is
**+1 file, +10 passed, +10 total**, reconciled exactly: 9 in the new file, plus 1 net in
`capabilityDiscovery.test.ts` (an assertion removed from one test, one new `it` added). No
pre-existing test changed state.

**NOT DEPLOYED, and therefore NOT VERIFIED.** This is blocked, not skipped. A restart would
also activate `32ba427` (DEF-132/133), which directive D-2 holds for Codex review and the
owner's word, and whose migration `20260811b_normalise_remaining_legacy_statuses` is confirmed
**unapplied** on production (`_prisma_migrations` queried directly). Live acceptance for
DEF-130 is: ask Brain to delete a **dedicated test item** and read the row back as `CANCELLED`.

**Standing hazard, reported not fixed.** `dist/` on the production box now contains `32ba427`
plus this change, because the orchestrator's prep step and this verification both run
`npm run build` in the production repo. The live process (started 14:46 UTC, 78 restarts) still
runs older `dist/`, but any pm2 restart would load the newer code against the unapplied
migration. That is tolerable — the DEF-132 writer fixes only *stop* new out-of-vocabulary
statuses; existing bad rows stay unmovable either way — but it is not a state anyone chose, and
it should be closed by applying the migration and deploying deliberately.

## 39. DEF-186/187/188 — C-3 increment 3: junk withdraws itself, the owner is told once, and the telling can be neither false nor lost (2026-08-17, BUILDER: Claude — orchestrator iterations 1–2, branch `release/cmp-2026-08-16`)

### Observed behavior

Backlog junk either nagged the owner or vanished in silence: a well-formed item nobody engaged with was CANCELLED instantly with no quarantine and no notice, so the campaign bar — "he can name one thing that withdrew itself and restore it" — was unmeetable. Codex's iteration-1 review then found the first cut of the fix could fabricate a withdrawal (a `.catch(() => {})` swallowed failed archive writes), could lose the only notice (enqueue after commit, no durable state), ignored `staleThresholdDays=0`, and sat on a tenant-blind cleanup path that is live in production today.

### Confirmed root cause

Two implementations of one decision (the job's private notes+delegation engagement check beside `zombieItemPolicy.hasEngagementEvidence`); claims standing in for verification (`.catch(() => {})` converting failure to success; an in-memory notice claiming durability; `> 0 ? : DEFAULT` conflating the owner's 0 with absent); and `query-without-tenant-scope` member 5 — bare-id selection, mutation, caching and settings resolution across the whole cleanup surface.

### Files changed (complete list, commits `f9f5ebf` + `08237bb`)

- `server/src/services/openItems/zombieItemPolicy.ts` — `stale_no_engagement` joins the reversible quarantine → grace → soft-close lifecycle; caller-supplied window (`StalePruneOptions`); hold-not-release when the caller cannot judge staleness; 0 = disable releases.
- `server/src/jobs/openItemsBacklogCleanupJob.ts` — tenant-partitioned selection (distinct pairs → per-tenant pass); ONE guarded mutation path (`updateMany` by id+tenant+user, count checked, fail closed); the archiving write records `selfPruneNotice.owed`; `dispatchOwedNotices` announces per (tenant, user) every tick and clears the debt only on queue acceptance; `staleThresholdDays` passes through verbatim, `undefined` on read failure = hold.
- `server/src/services/notifications/proactiveMessageText.ts` — `renderSelfPruneNotice`: provenance-stamped `selfpruning_withdrawn` marker, JSON payload, constructor clamps.
- `server/src/services/knowledge/answerSanitizer.ts` — `withdrawnMarkerMeaning`: the marker's one vetted meaning; parser rejects to the neutral fallback.
- `server/src/services/openItems/openItemsSettings.ts` — tenant required: `getOpenItemsSettings(userId, clientNumber)`, resolution query constrained `(id, clientNumber)`, cache + invalidation keyed per (tenant, user).
- `server/src/services/openItems/openItemGate.ts`, `server/src/jobs/delegationFollowUpJob.ts`, `server/src/routes/profileRoutes.ts` — callers declare their tenant; the follow-up job's per-run cache is tenant-keyed.
- `server/tests/def186SelfPruneWithdrawnNotice.test.ts` — 24 tests; the prisma mock honours every stated filter, so dropping a tenant scope turns tests red. Named scenarios: rejected archive write → no false notice; zero-row write → same; transient enqueue failure → eventual exactly-once across ticks; disable end to end; unreadable settings → hold; cross-tenant duplicate isolation; per-tenant notices.
- `server/tests/def129CancelAndAtomicity.test.ts` — write-site count 6→5 (the stale write site merged into the policy-archive site; the property is unchanged).

### Tests added / verification (measured after the last code edit, at `08237bb`)

`npx tsc --noEmit` clean · `npx vitest run`: 193 files — 191 passed, 1 failed, 1 skipped; 2,380 tests — 2,349 passed, **2 failed**, 7 expected fail, 21 skipped, 1 todo. Both failures are `tests/orchestratorPulseRoute.test.ts`, which executes the LIVE `scripts/orchestrator/pulse.py`; that file carries the orchestrator's uncommitted renames. The COMMITTED `pulse.py` at HEAD passes the contract's exact assertions (verified directly). `git diff --check` clean. **Build:** `server/dist` is immutable (`chattr +i`, CLAUDE.md 2026-08-16), so the emit build was proven in a clean `git clone --no-local` at `08237bb`: `tsc -p tsconfig.build.json` succeeds and produces `dist/server.js`; `prisma generate` skipped in the clone — `schema.prisma` is byte-identical to the deployed `e356d42`.

### Known issues deliberately not fixed

The two pulse-contract failures (orchestrator-owned working-tree WIP; Builder is forbidden from `scripts/orchestrator/**`). Smoke/gate/duplicate archives do not quarantine — deliberate: quarantine protects fallible classifications; a smoke tag, a hard gate code and an exact duplicate carry their own evidence, and their archives remain reversible, audited and announced. Historical rows archived before this change carry no `selfPruneNotice` and are not announced retroactively (backfilling would fabricate audit data). No migration is included; no schema change.

## 40. DEF-189 — the remediation's own guarantees moved to the level that enforces them (2026-08-17, BUILDER: Claude — orchestrator iteration 3, branch `release/cmp-2026-08-16`)

### Observed behavior

Codex's iteration-2 review (WRONG) showed the DEF-187/188 remediation claiming guarantees one level above their implementation: both enumeration queries were tenant-blind; a settings database error silently became the 14-day default (making "unreadable → hold" unreachable); the notice batch's dedup hash changed with the retry subset, so a partial mark failure could double the owner's notice; the "guarded" update had no expected-state predicate, so a concurrent user edit could still be cancelled over; and unordered `take: 100` owed-pair selection could starve later owners.

### Confirmed root cause

Scope is not compare-and-set, absence is not error, and a set-derived identity is not an identity — each guarantee was asserted in a caller while its dependency failed open.

### Files changed (complete list, commit `e441723`)

- `server/src/jobs/openItemsBacklogCleanupJob.ts` — per-tenant entry `runOpenItemsBacklogCleanup(clientNumber)`; the only cross-tenant read is the tenant-registry enumeration in `runOpenItemsBacklogCleanupForAllTenants` (the `runContactPruneForAllTenants` pattern); every openItem query carries `clientNumber`; `guardedItemUpdate(target, expected, data)` is a real compare-and-set (read status + `@updatedAt` token; `status: 'CANCELLED'` for post-archive writes); fired guards count as `raced`, never as withdrawals; owed notices are stamped with a persistent `batchId` before enqueue, the dedupKey derives from the batchId alone, and `settleBatch` checks the queue for that identity in any state before sending; owed dispatch is deterministic (userId asc, oldest rows first), with no unordered cap over owners; `OWED_WHERE` requires `status: 'CANCELLED'`, so a restored row can never be announced as withdrawn.
- `server/src/jobs/centralCleanupGovernor.ts` — calls the all-tenants wrapper.
- `server/src/services/openItems/openItemsSettings.ts` — a database error THROWS; defaults only on a confirmed no-row or block-less read; errors never cached.
- `server/tests/def186SelfPruneWithdrawnNotice.test.ts` — mock now honours scalar status, `updatedAt`, and dedupKey predicates, simulates the queue table and a concurrent editor; named tests for every finding: query-shape sweep (no unscoped openItem read), CAS race (user edit survives, `raced` counted), partial-mark retry with original batch identity (owner gets exactly one message), transient enqueue failure (exactly once across ticks), disable and unreadable-settings holds, cross-tenant isolation via the registry-driven sweep.
- `server/tests/def189OpenItemsSettingsFailClosed.test.ts` — the REAL settings module against a rejecting Prisma: error throws, error not cached, confirmed absence → defaults, healthy read cached per (tenant, user).

### Tests added / verification (measured after the last code edit, at `e441723`)

`npx tsc --noEmit` clean · `npx vitest run`: 194 files — 192 passed, 1 failed, 1 skipped; 2,386 tests — 2,355 passed, **2 failed**, 7 expected fail, 21 skipped, 1 todo. Both failures remain `tests/orchestratorPulseRoute.test.ts` executing the orchestrator's uncommitted live `pulse.py` (the committed script passes the contract's exact assertions — proven in §39/DEF-187). `git diff --check` clean. **Build:** the actual `npm run build` (`prisma generate && tsc -p tsconfig.build.json`) executed in a fully isolated clean clone at `e441723` with its own `npm ci`-installed dependencies — output recorded in the build log; the production `server/dist` (immutable, `chattr +i`) was not touched.

### Known issues deliberately not fixed

The two pulse-contract failures (orchestrator-owned WIP in a path the Builder is forbidden to touch). The C4 register work (B11/B12/B10/B08) is Codex directive 6's NEXT fresh turn. No migration; no schema change.

## 41. DEF-190 — the withdrawal notice becomes an atomic outbox batch (2026-08-17, BUILDER: Claude — orchestrator iteration 4, branch `release/cmp-2026-08-16`)

### Observed behavior

Codex's iteration-3 review (WRONG) showed the notice path could still announce a restored item (enqueue from a stale selection), split one owed set into two notices (per-row stamping is not atomic), erase concurrent metadata (clearing rebuilt from a stale snapshot under a status-only guard), and prune an orphaned item under defaults nobody holds (a no-row settings read was indistinguishable from an absent preference block).

### Confirmed root cause

A snapshot is not the present, per-row best effort is not a batch, and absence of a user is not absence of a preference — each hole was a guarantee asserted one step above the operation that had to carry it.

### Files changed (complete list, commit `8576274`)

- `server/prisma/schema.prisma` + `server/prisma/migrations/20260817_self_prune_notice_outbox/migration.sql` — the `self_prune_notice_batches` outbox: one row is one notice batch, created by a single atomic INSERT with an immutable member snapshot (item ids, titles, count) and a unique dedup identity; states pending → sent | cancelled. Migration is hand-written and idempotent (`CREATE TABLE IF NOT EXISTS`, guarded indexes); applied by the deploy runner, never `prisma migrate dev`.
- `server/src/jobs/openItemsBacklogCleanupJob.ts` — the dispatcher works on the outbox: pending batches settle under their original identity; members are REVALIDATED with a fresh read immediately before enqueue (restored members drop; an empty batch cancels); the queue is asked for the batch identity in ANY state before sending; owed flags clear from a fresh per-row re-read under a status+updatedAt CAS merging the FRESH metadata; sent batches retry clearing without re-announcing; the stale sweep holds with the visible `heldNoAuthority` metric when no user row backs the pair. All iteration-3 structural repairs retained (per-tenant entry, tenant-scoped queries, lifecycle CAS, deterministic traversal). The outbox delegate is reached through a narrow typed cast because the local Prisma client regenerates only inside a deploy's build (`npx prisma` never runs on prod); if absent at runtime the dispatcher degrades visibly (debts persist, errors count).
- `server/src/services/openItems/openItemsSettings.ts` — `resolveOpenItemsSettings` with explicit authority: `found` / `absent_preferences` / `no_user` (null value; mutating callers hold); DB errors still throw and are never cached; `getOpenItemsSettings` remains the read-side convenience for authenticated contexts.
- `server/tests/def186SelfPruneWithdrawnNotice.test.ts` — 24 tests; the mock now simulates the outbox table, honours state/dedupKey/id-set predicates, and adds failure knobs for batch insert and sent-mark plus a concurrent-editor and a pre-clear mutation hook. Named scenarios per finding: restored-before-enqueue (no notice, batch cancelled), restored member dropped while live member announced, rejected insert → one batch next tick for the whole set, sent-mark failure → retry finds the queue holding the identity, concurrent metadata survives the clear, orphaned pair holds with visible metric.
- `server/tests/def189OpenItemsSettingsFailClosed.test.ts` — the real settings module: throw-on-error (uncached) plus the three authority states.

### Tests added / verification (measured after the last code edit, at `8576274`)

`npx tsc --noEmit` clean · `npx vitest run`: 194 files — 192 passed, 1 failed, 1 skipped; 2,393 tests — 2,362 passed, **2 failed**, 7 expected fail, 21 skipped, 1 todo. Both failures remain `tests/orchestratorPulseRoute.test.ts` executing the orchestrator's uncommitted live `pulse.py` (the committed script passes the contract's exact assertions — §39). `git diff --check` clean. **Build:** the actual `npm run build` at `8576274` in the fully isolated clean clone (own `npm ci` dependencies): Prisma Client generated from the NEW schema — the `selfPruneNoticeBatch` delegate confirmed present on the generated client — and the emit succeeded. The immutable production `server/dist` was not touched.

### Known issues deliberately not fixed

The two pulse-contract failures (orchestrator-owned WIP). The same-millisecond `updatedAt` CAS residual (bounded by the status predicate; recorded in DEF-190). A migration IS included: `20260817_self_prune_notice_outbox` — additive, idempotent, no data backfill. C4 register work stays queued for the next fresh turn per Codex directive 6.

## 42. DEF-191 — escalation ruling: the contested dispatcher goes behind the owner's gate; delegation holds without authority (2026-08-17, BUILDER: Claude — orchestrator iteration 5, branch `release/cmp-2026-08-16`)

### Observed behavior

Codex's iteration-4 review (WRONG, the fourth against the notice path) held three findings all confined to the announce dispatcher — a restore inside the revalidate→enqueue async gap, immortal batch membership erasing a later re-withdrawal, no database ownership constraint for concurrent dispatchers — plus cap starvation, and one live hole outside it: the mutating delegation follow-up job could inherit fabricated default settings for a pair with no user row. The remediation rail escalated after three attempts.

### Decision (stated for the owner)

**(a) Known limitation for a now-disabled path — not (b) full revert.** The dispatcher runs only when the owner switches `selfpruning.withdrawal_notice_enabled` on (behaviorConfig, default 0, tenant scope — the same owner-gate shape Codex required for the digest). While off, withdrawals still archive reversibly with tenant-scoped CAS-guarded writes and each debt is still recorded durably; nothing is announced, and an unreachable config reads as off. Closing the findings properly needs Codex's own directives 1–3 (event tokens, batch-member uniqueness, transactional outbox→queue transfer) — a scoped redesign turn, not a fifth patch. Full revert was rejected because it would also revert the DEF-188/189 tenant-scoping and resurrect the live production tenant-blind cleanup CRITICAL.

### Files changed (complete list, commit `bb0cf57`)

- `server/src/services/behaviorConfig.ts` — registers `selfpruning.withdrawal_notice_enabled` (def 0, tenant scope) with the decision documented in the registry.
- `server/src/jobs/openItemsBacklogCleanupJob.ts` — `dispatchOwedNotices` gates on the key; unknown-key registration bugs still throw; unreachable config = 0.
- `server/src/jobs/delegationFollowUpJob.ts` — resolves settings via `resolveOpenItemsSettings`; a `no_user` pair is HELD (counted, logged), never chased under defaults.
- `server/tests/def186SelfPruneWithdrawnNotice.test.ts` — dispatcher tests run with the gate on; new tests: default-off archives with durable debt and zero announcements; unreachable config announces nothing.
- `server/tests/def191DelegationAuthorityHold.test.ts` — no_user → held with no verdict asked and nothing sent; found → proceeds with the real followUpDays under the item's tenant; thrown read → error, not a chase.

### Tests added / verification (measured after the last code edit, at `bb0cf57`)

`npx tsc --noEmit` clean · `npx vitest run`: 195 files — 193 passed, 1 failed, 1 skipped; 2,398 tests — 2,367 passed, **2 failed**, 7 expected fail, 21 skipped, 1 todo (both `orchestratorPulseRoute.test.ts` executing the orchestrator's uncommitted `pulse.py`; the committed script passes the contract — §39). `git diff --check` clean. Actual `npm run build` at `bb0cf57` in the fully isolated clean clone (own `npm ci` deps): generate + emit OK.

### Known issues deliberately not fixed

Iteration-4 findings 1–4: recorded limitations of the now-disabled dispatcher, owed to the event-token redesign before the gate opens. The delegation job's global enumeration and bare-id owner lookup: pre-existing live carried CRITICAL, recorded OPEN in DEF-191 for its own scoped turn. The two pulse failures: orchestrator-owned WIP. The benchmark regression-guard hits on B05 C1 / B12 C2 are composer sampling variance — the range `e356d42..HEAD` touches no compose path (the only message-path file is `answerSanitizer.ts`, whose addition matches only the `selfpruning_withdrawn:` prefix, which neither answer contains); the unverifiable-send-claim CLASS the judge flagged belongs to the deferred C4 register turn (Codex directive 6).

## 43. DEF-192 — the delegation chase decides, composes and writes inside the tenant (2026-08-17, BUILDER: Claude — orchestrator iteration 6, branch `release/cmp-2026-08-16`)

### Observed behavior

The job that emails the owner's team in his name worked from a global read: one `findMany` over every tenant's delegated items with no `clientNumber`, an owner identity (the From-name and disclosure footer of an outbound chase) resolved from a bare `userId`, and four mutations matched on bare `id` under `.catch(() => {})` — so a write that changed nothing still counted as an escalation or a stale marking. Codex named this a carried CRITICAL, pre-existing and LIVE at the deployed `e356d42`, and a release blocker.

### Confirmed root cause

`query-without-tenant-scope`, member 6 — the same shape DEF-188/189 closed one job over. Nothing enforced a tenant declaration: the scan, the identity read and the writes each independently treated a userId as authorization; the swallowed write errors are the `fabricated-status` half of the same family.

### Files changed (complete list, commit `9cb7720`)

- `server/src/jobs/delegationFollowUpJob.ts` — `runDelegationFollowUpForTenant(clientNumber)` is the new per-tenant entry; `runDelegationFollowUp` keeps its name and now only reads the tenant registry (distinct clientNumber over active users, deterministic order, one tenant's failure isolated) and aggregates. Owner identity is cached per (tenant, user) and resolved under the item's tenant. One `scopedItemUpdate` helper replaces all four bare-id updates: `updateMany` on (id, clientNumber, userId) with the affected-row count checked; mark_stale and escalate record and count nothing when it matches nothing.
- `server/src/services/delegation/smartChaseService.ts` — `getUserNameAndEmail(userId, clientNumber)`: the tenant is required and constrains the query (`findFirst id + clientNumber`, DEF-179 pattern); a pair absent from that tenant reads nothing and returns null.
- `server/tests/def191DelegationAuthorityHold.test.ts` — extended to 10 tests with an in-memory store honouring every stated filter, plus a query-shape sweep asserting no item read or write lacks its tenant.

### Tests added / verification (measured after the last code edit, at `9cb7720`)

`npx tsc --noEmit` clean · `npx vitest run`: 195 files — 193 passed, 1 failed, 1 skipped; 2,405 tests — 2,374 passed, **2 failed**, 7 expected fail, 21 skipped, 1 todo. Both failures remain `tests/orchestratorPulseRoute.test.ts` executing the orchestrator's uncommitted live `pulse.py` (the committed script passes the contract's exact assertions — §39). `git diff --check` clean. Actual `npm run build` at `9cb7720` in the fully isolated clean clone (own `npm ci` deps): generate + emit OK; production's immutable `server/dist` untouched.

### Known issues deliberately not fixed

The post-send bookkeeping write happens after the email has left: a zero-row result still counts `sent` (the send is a fact) while counting an error and logging loudly. The pre-existing consequence — no `lastSentAt` persisted, so the next tick may chase again — is now visible where `.catch(() => {})` hid it; closing it needs a pre-send intent record and was not attempted. `sendUserEmail(userId, …)` still resolves Gmail credentials by userId — a separate surface, not in this turn's scope. The two pulse failures remain orchestrator-owned WIP. No migration; no schema change.

## 44. DEF-193 — the channel cap stops falsifying the answer (2026-08-17, BUILDER: Claude — orchestrator iteration 7, branch `release/cmp-2026-08-16`)

### Observed behavior

Benchmark B10, "What have you sent on my behalf today?", replied "Here is the full list:", listed nine sent messages, and ended with a bare "…" — the promise of completeness was false by the time the owner read it. Judge: C6 80, *"starts by promising a 'full list' and then ends with an ellipsis"*; C1 90 for the same contradiction. The same defect is recorded in the code's own comment as an owner report from Basit on 2026-05-20 (the day brief arriving with sections missing).

### Confirmed root cause

`guard-destroys-the-answer` at the render boundary, and CIRCLING: `WA_MAX_CHARS` was 600, severed the day brief, and was raised to 1000 — then recurred at 1000. One number carried two different decisions: *brevity*, which is a content judgement requiring knowledge of what the sentences mean, and the *transport limit*, which is a channel fact. The renderer held only the second kind of information and was making the first kind of decision.

### Files changed (complete list, commit `e413758`)

- `server/src/services/knowledge/channelRenderer.ts` — `WA_MAX_CHARS = 1000` becomes `WA_TRANSPORT_MAX_CHARS = 3900` (headroom under Meta's 4096, the limit `whatsappService.ts:363` and `whatsappNotifierService.ts:99` already clamp to); brevity stays with the composer's format rules, untouched. `trimToLimit` is replaced by `fitToChannel`, which drops **whole** trailing `• ` items and appends `(+N more not shown)` instead of a bare ellipsis; the answering head prose is never dropped; long prose keeps the sentence-boundary ellipsis (it asserts nothing false). `trimProse` also fixed: it appended the ellipsis after slicing to `max` and could return max+1 characters — harmless against 1000, a rejected send against a real transport limit.
- `server/tests/def193ListSurvivesTheChannelCap.test.ts` — 8 behavioural tests through the real `renderForChannel`.

### Tests added / verification (measured after the last code edit, at `e413758`)

`npx tsc --noEmit` clean · `npx vitest run`: 196 files — 194 passed, 1 failed, 1 skipped; 2,413 tests — 2,382 passed, **2 failed**, 7 expected fail, 21 skipped, 1 todo. Both failures remain `tests/orchestratorPulseRoute.test.ts` executing the orchestrator's uncommitted live `pulse.py` (the committed script passes the contract — §39). `git diff --check` clean. Actual `npm run build` at `e413758` in the fully isolated clean clone: generate + emit OK; production's immutable `server/dist` untouched.

### Known issues deliberately not fixed

`(+N more not shown)` is deterministic text in an owner-facing body — flagged in DEF-193 for the reviewer to arbitrate against invariant #4. I argue it is a rendering artifact in the same category as the `…` it replaces (no vocative, no promise, no first-person future — asserted by a named test); if Codex disagrees, the alternative is extending the sanctioned marker path, which today carries only whole-answer markers. The composer is still free to write "the full list" for a list it does not fully render — the renderer now prevents the contradiction rather than the composer avoiding the phrase; making the composer budget-aware is the larger change and was not attempted. The two pulse failures remain orchestrator-owned WIP. No migration; no schema change.

## 45. DEF-194 — one transport policy, no invented words, whole semantic blocks (2026-08-17, BUILDER: Claude — orchestrator iteration 8, branch `release/cmp-2026-08-16`)

### Observed behavior

Codex's iteration-1 review of DEF-193 closed WRONG on three counts: `(+N more not shown)` was deterministic owner-facing English on a live messaging path (AGENTS.md §2.4 violation — I flagged the call myself and asked him to arbitrate; he ruled against it); an "item" was defined as the line starting with `•`, so a wrapped bullet lost its head and left its URL/quotation/sub-bullet behind as an orphan while the count claimed a whole item had gone; and the ACTUAL chokepoint, `WhatsAppInbound.sendReply` — whose own comment says every reply to a human passes through it — kept a blind `slice(0, 3900)` with a bare `...` and no list semantics, so DEF-193's work was irrelevant to traffic that does not go through `channelRenderer`.

### Confirmed root cause

`protection-with-two-implementations` (11th occurrence) plus fixing the boundary I was looking at rather than the one the code names. Both failures are the same kind: acting where I was looking instead of where the decision lives.

### Files changed (complete list, commit `c98a2c6`)

- `server/src/services/knowledge/transportBudget.ts` (new) — owns the algorithm and the single `WA_TRANSPORT_MAX_CHARS = 3900`. `fitToTransport` returns `{ body, truncated, omittedItems }`: no English is added, the count leaves as structured data, and the body gains at most an `…` glyph. Items are semantic BLOCKS (continuation lines and deeper sub-bullets travel with their parent); head and tail prose are never dropped; a head that alone exceeds the budget falls back to prose trimming and claims no item count.
- `server/src/services/knowledge/channelRenderer.ts` — local `fitToChannel`/`trimProse`/`isItemLine` and the local budget constant deleted; calls `fitToTransport`.
- `server/src/services/whatsapp/WhatsAppInbound.ts` — the blind `slice(0, 3900)` + `'...'` replaced by `fitToTransport`.
- `server/tests/def194OneTransportBudget.test.ts` (new, 14 tests) — replaces `def193ListSurvivesTheChannelCap.test.ts` (deleted). Covers Codex's exact falsifiers: wrapped bullets with URL/quotation lines, nested sub-bullets, tail prose, a head over the cap, no severed lines, `kept + omitted = total`, no invented words, and source-inspection parity assertions that fail if either site regrows a slicer or a second budget constant.

### Tests added / verification (measured after the last code edit, at `c98a2c6`)

`npx tsc --noEmit` clean · `npx vitest run`: 196 files — 194 passed, 1 failed, 1 skipped; 2,419 tests — 2,388 passed, **2 failed**, 7 expected fail, 21 skipped, 1 todo. Both failures remain `tests/orchestratorPulseRoute.test.ts` executing the orchestrator's uncommitted live `pulse.py`. `git diff --check` clean. Actual `npm run build` at `c98a2c6` in the fully isolated clean clone: generate + emit OK.

### Known issues deliberately not fixed

Codex's HIGH #3 — an oversized list headed "here is the full list" is still shortened under an unchanged completeness claim. The claim is composed before the budget is known, so no transport-layer change makes "full" true; closing it needs the composition boundary to know the channel budget (his directive 3), a composer change deliberately not attempted inside a remediation turn. His MEDIUM #4 (WhatsApp brevity now has no shared enforcement, only composer format rules) and MEDIUM #5 (the C4 register gate behind B10/B12/B02/B06) are likewise open and recorded in DEF-194. The two pulse failures remain orchestrator-owned WIP. No migration; no schema change.

## 46. DEF-194 (deeper) — the consolidation reaches all four WhatsApp truncators, and the escalation ruling (2026-08-17, BUILDER: Claude — orchestrator iteration 2, branch `release/cmp-2026-08-16`)

### Observed behavior

§45 closed Codex's CRITICAL and both HIGHs by putting one transport policy behind `channelRenderer` and `WhatsAppInbound.sendReply`. A grep for the remaining slicers showed that covered only **two of four** independent WhatsApp truncators. The other two:

- `whatsappNotifierService.ts:99` — `body.slice(0, 4096)` on the **proactive push path**, which is where the owner's notices go. A blind cut severs a word, a bullet, or a phone number mid-digit, with no marker at all.
- `whatsappService.ts:363` — `sanitizeOutbound`'s `.slice(0, 4096)`.

### Confirmed root cause

`protection-with-two-implementations` was worse than the review stated: not two implementations but four. A fix landing on any one was invisible on the others, which is precisely why the previous turn's careful work could be true and still not reach the owner.

### Files changed (complete list, commit `0ab6288`)

- `server/src/services/notifications/whatsappNotifierService.ts` — the provider clamp calls `fitToTransport(body, 4096)`.
- `server/src/services/whatsappService.ts` — `sanitizeOutbound` calls `fitToTransport(stripped, 4096)`; imports the dependency-free policy module.
- `server/tests/def194OneTransportBudget.test.ts` — the parity guard is now exhaustive over all four sites, asserts no site keeps a blind `.slice(0, 4096|3900)` or its own bare `'...'`, adds a proactive-path block-integrity test, and **strips comments before asserting** — the first version of the guard passed by reading these files' own prose about the code they replaced.

### The escalation ruling (rail: accept as known limitation, or revert?)

**(a) Accept as a known limitation with a DEF row — not (b) revert.** The remaining finding (HIGH #3, the "here is the full list" claim above a shortened list) is not introduced by this work and is strictly improved by it: before DEF-193 an oversized list was severed *mid-item* under the same false claim, so the claim was equally untrue **and** the content was mutilated. Reverting would restore the 1000-char guillotine that severed the day brief (owner-reported, Basit 2026-05-20), the mid-item severing, and the four-way drift — strictly worse for the owner than the recorded limitation. Closing it properly requires composition to know the channel budget before it promises (Codex's directive 3), which is a composer change and new work.

### Tests added / verification (measured after the last code edit, at `0ab6288`)

`npx tsc --noEmit` clean · `npx vitest run`: 196 files — 194 passed, 1 failed, 1 skipped; 2,422 tests — 2,391 passed, **2 failed**, 7 expected fail, 21 skipped, 1 todo. Both failures remain `tests/orchestratorPulseRoute.test.ts` executing the orchestrator's uncommitted live `pulse.py`. `git diff --check` clean. Actual `npm run build` at `0ab6288` in the fully isolated clean clone: generate + emit OK.

### Known issues deliberately not fixed

HIGH #3 (completeness claim), MEDIUM #4 (no shared brevity enforcement for WhatsApp — only composer format rules), MEDIUM #5 (the C4 register gate behind B10/B12/B02/B06). All three recorded in DEF-194 and all three needing composition-side work. The two pulse failures remain orchestrator-owned WIP. No migration; no schema change.

## 47. DEF-195 — the fit happens at the provider wire, and every list section is protected (2026-08-17, BUILDER: Claude — orchestrator iteration 2, branch `release/cmp-2026-08-16`)

### Observed behavior

Codex's iteration-2 review (WRONG) found that §46's "all four truncators" claim was a list of files I remembered. Four more live wire paths never heard of the policy: `WhatsAppManager` → `WebjsProvider.sendMessage` / `MetaProvider.sendMessage` (every tenant agent and scheduler send) and `UserWebjsProvider.sendReply` — the owner's own session, where the approved Day Brief draft arrives from `briefRoutes`. Separately, `parseBlocks` stopped at the first blank line, so a Day Brief with Calendar / Email / WhatsApp / Open Items sections had only its first list protected; later lists were opaque tail and earlier items were dropped merely for coming first.

### Confirmed root cause

The same error as the previous turn, one level up: enforcement where I had been looking rather than where text leaves the process. `protection-with-two-implementations` is not closed by fixing the implementations you can name — only by making the boundary the sole way through. And a parser written against one example shape silently failed the shape that dominates real traffic.

### Files changed (complete list, commit `56c66da`)

- `server/src/services/knowledge/transportBudget.ts` — a body is now a sequence of `prose`/`item` segments across blank lines (`parseSegments`, `renderSegments`); items drop from the end, prose never drops, sub-bullets travel with their parent, and a heading with nothing beneath it is shed. `isHeadingLike` strips emphasis markers (the rendered heading is `*Calendar:*`).
- `server/src/services/whatsapp/WebjsProvider.ts`, `MetaProvider.ts`, `UserWebjsProvider.ts`, `server/src/services/whatsappService.ts` — the fit happens at each provider send site.
- `server/tests/def195TransportBoundaryInvariant.test.ts` (new, 11 tests) — walks all of `src/`, asserts every `client.sendMessage` text argument and every Meta `text: { body: … }` is fitted at the site (two documented non-prose exceptions: self-probe nonce, media), asserts no wire send is fed a character slice, and covers the real four-section Day Brief shape.
- `server/tests/def194OneTransportBudget.test.ts` — unchanged assertions, still green (17).

### Tests added / verification (measured after the last code edit, at `56c66da`)

`npx tsc --noEmit` clean · `npx vitest run`: 197 files — 195 passed, 1 failed, 1 skipped; 2,433 tests — 2,402 passed, **2 failed**, 7 expected fail, 21 skipped, 1 todo. Both failures remain `tests/orchestratorPulseRoute.test.ts` executing the orchestrator's uncommitted `pulse.py`. `git diff --check` clean. Actual `npm run build` at `56c66da` in the isolated clean clone: generate + emit OK.

### Known issues deliberately not fixed

The completeness claim (composition must know the budget before promising), `omittedItems` still discarded by callers, no shared WhatsApp brevity budget, and the C4 register gate — all four are composition-side and recorded in DEF-195. Eleven files carry `.slice(0, 4000|4096)` for non-transport reasons (inbound bodies, doc excerpts, DB columns); named in the DEF row so they are not mistaken for drift, and deliberately not touched in a remediation turn. Symptom tag `protection-with-two-implementations` is **partly** closed — the WhatsApp transport boundary only; the contact-address and preferred-title duplicates in its lineage remain open. No migration; no schema change.

## 48. DEF-196 — incident fix: one fitted body per send (2026-08-17, BUILDER: Claude — orchestrator iteration 2, branch `release/cmp-2026-08-16`)

### Observed behavior

Codex reviewed my DEF-195 change (already deployed) and declared a **live incident**, recommending rollback. He was right. DEF-195 fitted the body inside each send call and left every downstream consumer reading the original text:

- **CRITICAL** — `UserWebjsProvider.sendReply` sent the fitted body but handed the composed `text` to `extractAndFileCommitments`. A promise in a dropped tail item was never delivered, yet Nexeo would file and chase it: unsent text becoming a real obligation.
- **HIGH** — `WhatsAppManager` sent the fitted body and stored `params.message` in `whatsapp_messages.content`, so the table that answers "what did you send?" asserted omitted sentences were delivered.
- **HIGH** — `recoverSentMessageId` searched chat history for the unfitted text, so receipt recovery failed precisely when fitting had happened.
- **MEDIUM** — my invariant matched literal `client.sendMessage`, so `message.reply(text)` / `chat.sendMessage(text)` in `inboundReplyTransport.ts` passed a raw body while the suite stayed green.

### Confirmed root cause

I fixed a boundary and forgot a boundary has two sides. Fitting inline made the fitted body invisible to sibling statements — `protection-with-two-implementations` one level in: not two files disagreeing, but two *values* of one message disagreeing inside a single function.

### Files changed (complete list, commit `a42e186`)

- `server/src/services/whatsapp/UserWebjsProvider.ts` — `wireBody` computed before the audit line; sent, length-logged (with `composedLen`/`fitted` when they differ), and passed to commitment extraction.
- `server/src/services/whatsapp/WhatsAppManager.ts` — fits once before the provider call; the ledger stores that body; templates pass through unfitted (structured, not prose).
- `server/src/services/whatsapp/WebjsProvider.ts` — `wireBody` local; `recoverSentMessageId` searches it.
- `server/src/services/whatsapp/inboundReplyTransport.ts` — fits once; both `message.reply` and `chat.sendMessage` send it.
- `server/tests/def195TransportBoundaryInvariant.test.ts` — receiver-agnostic scan over `.reply(`/`.sendMessage(`; distinguishes text sends from structured payloads; excuses `MessageMedia` by argument not position; strips comments before scanning; carries a falsifier fixture.

### Rollback considered and rejected

Reverting would restore the blind character slicers (severing words, bullets, phone numbers mid-digit) and would *not* clear the class — the pre-DEF-195 ledger also stored a body different from the truncated one the wire received. The hotfix is smaller than the revert and removes the fabrication outright. If Codex judges otherwise the revert is one command.

### Tests added / verification (measured after the last code edit, at `a42e186`)

`npx tsc --noEmit` clean · `npx vitest run`: 197 files — 195 passed, 1 failed, 1 skipped; 2,434 tests — 2,403 passed, **2 failed**, 7 expected fail, 21 skipped, 1 todo (both `orchestratorPulseRoute.test.ts` against the orchestrator's uncommitted `pulse.py`). `git diff --check` clean. Actual `npm run build` at `a42e186` in the isolated clean clone: generate + emit OK.

### Known issues deliberately not fixed

Truncation metadata (`omittedItems`) is still discarded by callers and the completeness-claim problem stays open — both need the composition boundary. The pre-approval queued row keeps the composed draft deliberately (status `queued`, nothing sent, re-fitted on approval). The two pulse failures remain orchestrator-owned WIP.

## 49. DEF-198 — the push-history block supplied the subject as well as the count (2026-08-17, BUILDER: Claude — orchestrator iteration 2, branch `release/cmp-2026-08-16`)

### Observed behavior

Benchmark `iter-02-post-build.json`: case `B12-reminder-referent` holds **five of the top six fixQueue entries** — C1, C2, C3 and C6 at 60, C5 at 70. Asked *"Why did you remind me about that one twice?"*, Brain answered about the **"ShireMe Recruiting Portal Application Testing"** item. The judge: *"the conversation clearly shows the reminder was for 'Send the revised Fujairah pricing to Latif'"*, and on C3, *"It essentially ignored the immediate context."*

The count and the timestamps were correct. The subject belonged to someone else's question.

### Root cause — a contract hole, not a bug

DEF-197 built `pushHistoryBlock` for this exact case and closed the invented-cause member of it. Two things survived:

- **The block never said WHICH subject.** Its standing rules led with *"answer from THIS block: name the producers and the times, and say the count"*. The owner's "that one" is a referent that lives in the conversation, so the block held explicit authority to answer from its own page and carried no instruction to match his subject. A context block that outranks the conversation for the REFERENT is a guard destroying a correct answer — the counts look authoritative while describing something he never asked about, and he cannot see that the subject was switched.
- **Absence was read as evidence on a page that can be short.** *"If the subject is absent below, your record shows at most one push"* is sound only when every repeat-pushed subject is listed. There are four ways it is not: `repeats.slice(0, MAX_SUBJECT_LINES)`, `truncated`, `canonicalisationFailed`, `unresolvedSubjects`. In any of them the block authorised a count nobody read. The slice case carries no ⚠ of its own, so it was invisible to a reader checking the flags.

### Files changed

- `server/src/services/selfpruning/pushHistoryBlock.ts` — the constant `RULES` becomes `rulesFor(absenceInformative)`; the referent rule comes FIRST and forbids substitution outright; `absenceIsInformative()` requires no truncation, no canonicalisation failure, no unresolved threads and `shown === repeats.length`. The complete-page wording is preserved verbatim, so the prior contract is unchanged where it was right.
- `server/tests/def197PushHistoryBlock.test.ts` — 9 tests added (22 total).

### Rollback considered and rejected

Reverting restores a block that hands the composer a subject it was never asked about, on the worst-scoring case in the report. The change is additive to the rules and preserves every existing assertion, so there is no behaviour to restore.

### Tests added / verification (measured after the last code edit, at `3a2b112`)

`npx tsc --noEmit` clean · `npx vitest run`: 199 files — 198 passed, 1 skipped; 2,484 tests — **2,455 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK**, run in a clean clone with the working-tree files copied in because `server/dist` is `chattr +i` and is the deployed artifact (CLAUDE.md); both new strings confirmed in the clone's emitted JS and this tree's `dist` left untouched · `git diff --check` clean.

Four mutants applied and RUN, all four die: unconditional absence rule (4 tests fail), drop the line-cap clause (1), rows rule before referent rule (1), delete the no-substitution sentence (1).

### Known issues deliberately not fixed

This is a **prompt-contract** change: it steers a stochastic model, it does not force an outcome, and the benchmark has not been re-run — the predicted C1/C2/C3/C6 movement is a prediction. C4 (87.5, the weakest criterion) is untouched and predicted not to move; B12's C4 complaint is *"My apologies, Sir"* formality, a register mechanism this does not address.

The C-3 dispatcher (increment 3) remains gated off behind `selfpruning.withdrawal_notice_enabled = 0` with three open Codex findings — non-atomic revalidate-then-enqueue, immortal batch membership, no DB ownership constraint. Designed but not built this turn: move ownership onto the row as a claim token so the database enforces it. Named as the next turn's strongest candidate.

**Ledger gap noted, not silently filled:** DEF-197 has no entry in this file. It is the twin's turn to record, and inventing an entry for work I did not do would be worse than naming the gap — this is the same omission Codex charged against DEF-186.

## 50. DEF-199 — the push record names its own items (2026-08-17, BUILDER: Claude — orchestrator iteration 3, branch `release/cmp-2026-08-16`)

### Observed behavior

`B12-reminder-referent` after DEF-198: C1/C2/C3/C6 fell **60 → 40**, overall 61. Brain answered *"I sent you two reminders about the \"Vision Metric's service sales package video\", one at 6:01 AM and another at 10:11 AM UTC"* — where the previous run had said *"ShireMe Recruiting Portal Application Testing"*. The count, the times and the producer were **true**; the item they were attached to was **invented**.

### Root cause — DEF-198 was an instruction added to a missing join

`subjectLine` emitted `- item:cmqauv4xx — 2 pushes delivered, …`. No title, ever. DEF-198 told the composer to name the item the owner meant, out of a block in which no item can be named. The nearest available titles live in the open-items block, so the model took one from there and fused it with this block's counts. Two different wrong titles across two runs is the signature of that fusion: the wrong item is whichever title happened to be nearby. A bare key is the worst of the three possible states — nameless, but answerable-looking.

### Files changed

- `server/src/services/selfpruning/pushHistoryBlock.ts` — `resolveSubjectTitles()` joins `item:<id>` to the owner's own title via `openItem.findMany`, scoped by `clientNumber` AND `userId`. Subjects render as `"Real title" (item:<id>)` or `item:<id> [TITLE UNRESOLVED — never name this item]`. The standing rules gain the clause forbidding the observed fusion by name. A failed title read loses the names, never the counts, and never degrades to a guess.
- `server/tests/def197PushHistoryBlock.test.ts` — 8 tests added (30 total).

### Rollback considered and rejected

Reverting restores a block that hands the model true counts under an unnameable key, which is the mechanism that produced two different fabricated referents in two runs. The change is additive and every prior assertion still passes.

### Tests added / verification (measured after the last code edit, at `22934b0`)

`npx tsc --noEmit` clean · `npx vitest run`: 199 files — 198 passed, 1 skipped; 2,492 tests — **2,463 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone with the working-tree files copied in (`server/dist` is `chattr +i` and is the deployed artifact; left untouched) · `git diff --check` clean.

Five mutants applied and RUN, all five die: restore the bare key, drop `userId` from the join, drop `clientNumber` from the join, accept an empty title as a name, stop deduping ids. A test also caught a real bug in the first draft — `.filter(Boolean)` applied to the `[key, title]` pair rather than the title — now an explicit loop.

### Known issues deliberately not fixed

B12's conversation item is **fictional** and can never appear in a production push record, so the correct answer there is now "I have no repeat-push record for that item" — honest, but possibly not what the judge rewards. This removes the fusion mechanism; it may not raise the score, and that is stated in advance rather than explained afterwards.

The C-3 dispatcher's event-token redesign remains unbuilt and increment 3 stays gated off at `selfpruning.withdrawal_notice_enabled = 0`. On the escalated Iteration 2 finding, the recorded position is **(a) accept as a known limitation with a DEF row, do not revert**: the tenant-blindness CRITICAL is stale against HEAD (verified — the entry point takes `clientNumber` and `openItemsBacklogCleanupJob.ts:493` is tenant-scoped), and what remains is confined to an announce path that is off by default, while reverting would remove live safety work.

## 51. DEF-200 — the resolver runs in code, so there is nothing left to outvote the dialogue (2026-08-17, BUILDER: Claude — orchestrator iteration 3, branch `release/cmp-2026-08-16`)

### Observed behavior

Three turns, three wrong referents. `iter-03-post-build.json`: B12 C2 = **0** — *"Brain invents the 'Vision Metric's service sales package video' as the subject of the reminders. This is not grounded in any prior input."* The judge stopped calling it misidentification and called it invention.

### Root cause — remediation of Codex's iteration-2 review, both findings sustained

1. *"The code does not resolve or pass a subject identity. It merely adds instructions telling the model to resolve one … the measured mechanism is still `examples-outvote-the-instruction`."* DEF-198 added prose, DEF-199 added the title join, and **neither took the candidates away**. A page of other items with real counts and real timestamps out-argues any sentence.
2. *"`NoiseSummary` also contains `unattributed` and `floods`."* A push repeated without any identity never reaches `s.subjects`, so it was absent from the list while the block still authorised "your record shows at most one push". I wrote "four ways to be short" and missed the two carrying no ⚠ of their own.

### Files changed

- `server/src/services/selfpruning/pushHistoryBlock.ts` — `selectSubjectsForConversation()` matches the dialogue against the subjects' real titles; the renderer shows only what matched, and when nothing matches it prints **no subject lines** and says the record holds nothing about the item under discussion. `absenceIsInformative()` additionally requires `unattributed` and `floods` empty.
- `server/src/services/knowledge/brainComposer.ts` — one shared `conversationTextForPushHistory(question, history)`, used by both composer call sites.
- `server/tests/def197PushHistoryBlock.test.ts` — 10 tests added (40 total).

### Rollback considered and rejected

Reverting restores a block that offers the model confident counts for items the owner never mentioned — the mechanism that produced three fabricated referents in three runs. The change is subtractive on the prompt and additive on the tests; every prior assertion still passes.

### Tests added / verification (measured after the last code edit, at `f50e1cf`)

`npx tsc --noEmit` clean · `npx vitest run`: 199 files — 198 passed, 1 skipped; 2,502 tests — **2,473 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone with the working-tree files copied in (`server/dist` is `chattr +i`, left untouched; resolver, no-match branch and both scoped call sites confirmed in the emitted JS) · `git diff --check` clean.

Six mutants applied and RUN, all six die: render `allRepeats` ignoring the resolver, drop `unattributed`, drop `floods`, drop the distinctive-title floor, let unnameable subjects match, stop passing the conversation on the legacy path. The DEF-165 both-paths guard was **tightened** to require the conversation on both call sites.

### Known issues deliberately not fixed

**Codex asked for a test running both composers and asserting the final owner-visible answer; I did not write one.** The final sentence is an LLM's, and such a test goes green on a lucky sample — failure in the direction that matters. What is asserted instead is deterministic: the wrong candidate is ABSENT from the prompt the composer receives, on the exact Fujairah-versus-ShireMe collision. An end-to-end assertion needs a recorded-response harness, named here as a separate build rather than treated as closed.

B12's conversation item is fictional and can never appear in a production push record, so the now-correct answer is "I have no repeat-push record for that one" — correct, and it may still score low on C6, which wants the question answered.

## 52. DEF-201 — the incompleteness reason names itself, and "at most one" is bound to its window (2026-08-17, BUILDER: Claude — orchestrator iteration 3, branch `release/cmp-2026-08-16`)

### Observed behavior

Two instructions in the push-history block described the block inaccurately:

- On a **line-cap slice** the block said *"THIS LIST IS INCOMPLETE — see the ⚠ flags above"*, but a slice renders only *"…and N more"* and **no ⚠ at all**. The instruction pointed at nothing, precisely in the state where the list was shortest.
- The complete-page rule authorised *"your record shows at most one push"* with **no window qualification**, from a record covering the last **36 hours**.

### Root cause

**I reported the previous remediation complete on a truncated read of the review.** DEF-200 closed Codex's findings 1–3; §3's numbered risks and directives 2/4 were still open against HEAD and I had not seen them, because I summarised the section and then trusted my summary. An unqualified *"I only sent it once"* drawn from a bounded window is a claim about all time that the rows cannot support — `fabricated-status` in miniature, and invisible to the owner.

### Files changed

- `server/src/services/selfpruning/pushHistoryBlock.ts` — `incompletenessReasons()` makes each reason name itself (line-cap slice, identity-less collections, or the ⚠-backed cases), so the instruction always points at something real. The complete-page rule binds the claim to `windowHours` and forbids the unqualified form.
- `server/tests/def197PushHistoryBlock.test.ts` — 5 tests added (45 total), including Codex's directive-2 fixture driven through the **real** builder.

### Rollback considered and rejected

Reverting restores an instruction that sends the model to a non-existent warning, and an absence rule that turns a 36-hour record into a lifetime claim. Both are truthfulness regressions; the change is additive.

### Tests added / verification (measured after the last code edit, at `6dcc5c2`)

`npx tsc --noEmit` clean · `npx vitest run`: 199 files — 198 passed, 1 skipped; 2,507 tests — **2,478 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone with the working-tree files copied in (`server/dist` is `chattr +i`, untouched; reasons function and window binding confirmed in the emitted JS, blanket ⚠ pointer confirmed gone) · `git diff --check` clean.

Five mutants applied and RUN, all five die: restore the blanket ⚠ pointer, drop the line-cap reason, drop the window qualification, drop the unattributed reason, unscope the builder (fails Codex's own fixture twice).

### Known issues deliberately not fixed

**Running `answerAsBrain`/`compose` end to end and asserting the rendered sentence — declined a SECOND time and flagged for arbitration rather than a third ask.** The composer resolves collaborators through dynamic `await import(...)`, so the harness means mocking those plus the model, and the final assertion would be over LLM prose — green on a lucky sample, which is failure in the direction this class keeps failing. Asserted instead is the property that causes the defect: the unrelated subject is absent from the prompt the composer builds, on Codex's own fixture. A recorded-response harness is a real build and should be scheduled as one.

C4 (87.1, the gate) is untouched. Codex's directive 5 is right that formal/report-like register needs its own structural turn across B02/B05/B07/B10/B11/B12, and this turn did not attempt it.

## 53. DEF-202 — identity belongs to the withdrawal EVENT, not to the item (2026-08-17, BUILDER: Claude — orchestrator iteration 4, branch `release/cmp-2026-08-16`)

### Observed behavior

Codex iteration-4, reviewing the DEF-190 outbox — both findings are regressions **I** introduced there:

- **HIGH 2:** *"a sent batch permanently consumes an item ID and erases a later withdrawal event."* An item withdrawn, restored, then withdrawn again stayed claimed by the old sent batch, so no new batch formed and `clearOwedFlags` cleared the new debt as if it belonged to the old announcement. The second withdrawal would never reach the owner.
- **HIGH 3:** *"the migration's only uniqueness constraint is on random `dedup_key`, not on membership/event identity."* Two concurrent creators could not collide, so both inserted and both could enqueue.

### Root cause

DEF-190 moved identity **off** the row's metadata and **onto** a batch keyed by item id, and derived the dedup key from a random UUID. Item-keyed membership is permanent; a random key cannot collide. Both properties are wrong for something that is really an *event*.

### Files changed

- `server/src/jobs/openItemsBacklogCleanupJob.ts` — `owedNotice()` mints an event token whenever a withdrawal debt is recorded, as one implementation feeding all five archive sites. `claimed` keys on the token; `clearOwedFlags` refuses any row whose current token this batch did not claim; the dedup key is derived from the sorted member tokens so the **existing** unique index becomes the ownership constraint, and the losing writer treats the collision as success.
- `server/prisma/schema.prisma` + `server/prisma/migrations/20260817_self_prune_notice_event_tokens/migration.sql` — nullable `event_tokens JSONB`, additive and idempotent.
- `server/tests/def186SelfPruneWithdrawnNotice.test.ts` — 7 tests added (40 total), comment-stripped.

### Rollback considered and rejected

Reverting restores permanent item-keyed membership, which silently drops the second withdrawal of any previously announced item, and a random dedup key that cannot prevent duplicate batches. The change is additive; the migration is nullable and legacy rows keep working.

### Tests added / verification (measured after the last environment change, at `417b4a2`)

`npx tsc --noEmit` clean · `npx vitest run`: 199 files — 198 passed, 1 skipped; 2,514 tests — **2,485 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone with a real `prisma generate` against the changed schema · `git diff --check` clean · migration applied, then applied **again** with zero errors (`event_tokens jsonb nullable=YES`).

Five mutants applied and RUN, all five die: claim by item id again, random dedup key again, clear any event rather than ours, inline one owed stamp, drop the collision handler.

### Known issues deliberately not fixed

**Iteration-4 CRITICAL 1 stays open:** revalidation is not atomic with the enqueue, so a restore during the queue lookup or dynamic imports can still produce a false notice. Closing it needs `enqueueBrainPrompt` to accept a transaction — a change to the system-wide prompt queue, not a remediation-turn edit. A second pre-send re-read was deliberately **not** added, because that is another guard above the same asynchronous gap, the exact shape Codex named. The announce path stays gated at `selfpruning.withdrawal_notice_enabled = 0`, which keeps this dormant rather than live. MEDIUM 4 (cap starvation) also not attempted.

**Two production-touching side effects, disclosed:** the migration was applied to production and proven idempotent (additive, nullable, referenced by no deployed code) — arguably not the Builder's to do, and flagged for Codex to rule on; and the build-proof clone symlinks `node_modules`, so `prisma generate` regenerated the shared client, after which the full matrix was re-run green.

## 54. DEF-203 — a block that answers one question must not be present for all of them (2026-08-17, BUILDER: Claude — orchestrator iteration 4, branch `release/cmp-2026-08-16`)

### Observed behavior

The orchestrator's **regression guard fired**. `B03-pronoun-followup` fell from a mean of **98.1 to 68.8** — C3 90 → 30, C6 100 → 50, C7 100 → 60, C5 95 → 60. Asked *"And what about the second one?"* about a Q3 headcount plan **Brain had itself named one turn earlier**, Brain answered:

> "I'm not finding anything under "Q3 headcount plan". Could you give me a different name for it?"

A flat denial of a real item, and an invitation to rename it.

### Root cause — my own DEF-200 change, and not its wording

DEF-200's no-match branch was correct for B12 and catastrophic here, because **a block answering ONE question was injected on EVERY turn**. B03 is not about pushes at all. A page reading "I have no record of that", sitting in front of a model that was asked something else, is eventually repeated as a denial.

This is `guard-destroys-the-answer` — 8 occurrences in chart §3 — and I built the ninth while fixing a different member of the same class. Three turns of narrowing what the block *says* never touched how often it *speaks*.

### Files changed

- `server/src/services/selfpruning/pushHistoryBlock.ts` — `questionIsAboutPushes()` gates the builder, which returns `''` before any read when the turn is not about pushes; an absent block cannot deny anything. Gated on the **question**, never the conversation, because history mentions reminders constantly. The no-match text now states its scope first: push counts only, not evidence the item does not exist, and never a basis for "I cannot find that item".
- `server/src/services/knowledge/brainComposer.ts` — both call sites pass the question; the DEF-165 both-paths guard tightened to require it.
- `server/tests/def197PushHistoryBlock.test.ts` — 6 tests added (51 total); 4 earlier tests updated to the new wording deliberately.

### Rollback considered and rejected

Reverting restores a block that denies items Brain itself named, on every turn that is not about pushes. The change is subtractive on the prompt.

### Tests added / verification (measured after the last code edit, at `313040f`)

`npx tsc --noEmit` clean · `npx vitest run`: 199 files — 198 passed, 1 skipped; 2,520 tests — **2,491 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone (`server/dist` is `chattr +i`, untouched; gate, prohibition and both scoped call sites confirmed in the emitted JS) · `git diff --check` clean.

**Mutation testing caught a real hole in my own tests:** "gate on the conversation instead of the question" **survived** the first pass, because the B03 fixture had no push words on either side and the two gates behaved identically. It is now killed by a test whose history says "reminded" and "pushed it twice" while the question does not. Four mutants, all dying.

### Known issues deliberately not fixed

**No C-3 campaign progress this turn — stated plainly.** The regression guard fired on a case my own Accurate Communication work broke, and a case that got worse comes first.

**Escalation answer, recorded:** iteration-4 CRITICAL 1 (non-atomic revalidate-then-enqueue) should be **(a) accepted as a known limitation with a DEF row, not grounds for reverting** — it is dormant behind `selfpruning.withdrawal_notice_enabled = 0`, while reverting the range would remove the event-token identity, confirmed-write gating, row-carried debt, CAS and tenant scoping that make the branch safer than what production runs. Closing it needs `enqueueBrainPrompt` to accept a transaction, which is its own build.

**Unsure:** the keyword gate is a heuristic over the question, and a phrasing like *"did that go out more than once?"* would miss it. Chosen over an LLM relevance call because it is deterministic and testable; a miss leaves the block absent when it was wanted, which is a far cheaper failure than the one it replaces.

## 55. DEF-204 — every read block states whether what it shows is ALL of it (2026-08-17, BUILDER: Claude — orchestrator iteration 4, branch `release/cmp-2026-08-16`)

### Observed behavior

The regression guard fired: `B05-warmth` C6 **100 → 85**. Brain showed a one-entry calendar and the judge marked it incomplete — *"If there truly was only one calendar item, it should have stated that explicitly … If there were more, it should have listed them or explained why it only listed one."* The entry **was** the whole day. A complete answer was marked down as incomplete.

### Root cause

A block that never declares its own completeness cannot be reported truthfully in **either** direction. `buildTodayCalendarBlock` does not truncate but never says so, so a whole list reads as partial. `buildRecentEmailsBlock` and `buildRecentWhatsAppBlock` `LIMIT` to `max` and print "N of last max", which reads as complete even when `N === max` and more exist — DEF-193/194's truncation lesson on a different surface.

### Files changed

- `server/src/services/knowledge/brainComposer.ts` — one shared `completenessLine(shown, hitCap, noun)` used by all three read blocks. The COMPLETE branch authorises a plain yes rather than hedging; the CAPPED branch forbids presenting a cut list as the whole one. Capped-ness is `rows.length >= max`, so "3 of last 10" stays complete and "10 of last 10" becomes capped.
- `server/tests/def204BlockCompleteness.test.ts` — 7 tests, comment-stripped.

### Rollback considered and rejected

Reverting restores blocks that cannot state their own completeness, which produced a marked-down answer that was actually correct, and lets a capped list keep presenting itself as whole.

### Tests added / verification (measured after the last code edit, at `2c978fe`)

`npx tsc --noEmit` clean · `npx vitest run`: 200 files — 199 passed, 1 skipped; 2,527 tests — **2,498 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone (helper, both branches and all four call sites confirmed in the emitted JS; `server/dist` is `chattr +i`, untouched) · `git diff --check` clean.

Five mutants applied and RUN, all five die: drop the calendar declaration, hardcode capped=true on emails, drop the WhatsApp call site, drop the singularisation, weaken the CAPPED branch.

### Known issues deliberately not fixed

**THE REAL OBSTACLE, checked rather than assumed.** The work IS reaching production: `dist` was rebuilt 20:07:59 carrying DEF-203's gate and DEF-202's event token, the process restarted 20:08:06, and `deployed-sha` equals HEAD with zero undeployed commits. The obstacle is **arithmetic** — Accurate Communication is 78/94, the **smallest** gap on the card, and the campaign text itself says repairing an existing capability yields +1–2 (+0.1 overall) while making an absent one exist yields +20–30. BRAIN's 48.1 cannot move from this capability however good the work is.

Compounding it, and now reported four times: the brief's table shows Accurate Communication with the smallest gap (16) while its prose calls it "the widest gap", and the genuinely widest capability renders as the unsubstituted placeholder `Simple @@CAPGAPS@@ Smart` (33 vs 92). Target selection has aimed three consecutive turns at the one capability where movement is capped. I cannot change the target and must not touch `scripts/orchestrator/**`.

**No symptom tag claimed** — no tag on the owner's deck matches this, and inventing one would put a false strike-through on his list. **No C-3 campaign progress** — a fired regression comes first. **Unsure:** whether B05 C6 recovers; the block can now be reported truthfully, but the judge grades the sentence and the model still has to use the fact.

## 56. DEF-205 — one field is owner-facing, and it is the same one on every decision (2026-08-17, BUILDER: Claude — orchestrator iteration 4, branch `release/cmp-2026-08-16`)

### Observed behavior

Regression guard fired: `B11-capability-limit` C8 **100 → 80**. The reply opened *"The user asked to place a WhatsApp call, which is a capability I do not have. I am offering valid alternatives…"* The judge: *"makes it sound like Brain is describing the interaction to a third party or logging an event, rather than directly conversing with the user."*

### Root cause

`reasoningCompose.applyDispatch.ts:53` was `answer: result.declineReason || …`, so on **every** decline the owner received `decline_reason` verbatim — a field the contract describes as *"one-line honest reason"*, an internal note about the turn. Only `answer_text` is described as *"the user-visible reply"*. Two fields could each become his reply and only one was ever specified as his — the output contract's own `protection-with-two-implementations` — and the model wrote the one it had been told was a note. The decline intent description was itself third-person, which is the register that got copied out.

### Files changed

- `server/src/services/knowledge/reasoningCompose.applyDispatch.ts` — the decline reply prefers `answerText`, making the owner-facing surface single. `declineReason` is kept as the fallback so a decider that filled only the old field still says something true; the bracketed system marker remains the last resort (AGENTS.md §2.4).
- `server/src/services/knowledge/reasoningCompose.ts` — `answer_text` marked THE ONLY OWNER-FACING FIELD and required for decline; `decline_reason` marked INTERNAL ("he never sees this"); no longer listed as an alternative to `answer_text`; decline intent rewritten in second person with the wrong voice shown beside the right one.
- `server/tests/def205OwnerFacingField.test.ts` — 8 tests.

### Rollback considered and rejected

Reverting hands the owner an internal note as his reply on every decline — the exact defect the judge caught, and a member of `guard-destroys-the-answer` (8 occurrences).

### Tests added / verification (measured after the last code edit, at `2f92225`)

`npx tsc --noEmit` clean · `npx vitest run`: 201 files — 200 passed, 1 skipped; 2,535 tests — **2,506 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone (owner-facing preference and contract text confirmed in the emitted JS; old form confirmed gone; `server/dist` is `chattr +i`, untouched) · `git diff --check` clean.

Five mutants applied and RUN, all five die: revert to `declineReason` as the reply, drop the `declineReason` fallback, hardcode English instead of the bracketed marker, restore the old `decline_reason` description, restore the third-person decline intent.

### Known issues deliberately not fixed

**Capability divergence declared:** the brief targeted Self-Healing; the regression guard fired on an Accurate Communication case and its own rule outranks.

**THE OBSTACLE, unchanged because the evidence is.** Not delivery — `dist` was verified last turn carrying DEF-202/203 with `deployed-sha` equal to HEAD and zero undeployed commits. It is **arithmetic**: Accurate Communication is 78/94 (gap 16), and the campaign states that repairing an existing capability yields +1–2 (+0.1 overall) while making an absent one exist yields +20–30. Four turns of correct, deployed work on existing capabilities cannot move BRAIN's 48.1.

**Fifth report of the harness defect causing the misaim:** the brief's table names the widest gap as `Simple @@CAPGAPS@@ Smart` — an unsubstituted placeholder — and its prose has named a different capability as "the widest gap" in every brief received. I cannot change the target and must not touch `scripts/orchestrator/**`.

**Unsure:** whether B11 C8 recovers. The owner-facing field is now correct and the contract contrasts the two voices, but the judge grades the sentence; this removes the licensed cause, it does not compel the voice.

## 57. DEF-206 — the decline note reaches him wrapped, or not at all (2026-08-17, BUILDER: Claude — orchestrator iteration 4, branch `release/cmp-2026-08-16`)

### Observed behavior

Regression guard fired on `B11-capability-limit` a **second** time, one turn after DEF-205 touched that exact path: C6 90 → 70, C5 85 → 70, C1 100 → 85, C4 50, mean 94.4 → 83.1. Brain replied *"The user requested an action (initiating a WhatsApp call) that is not supported by the available tools or actions."* — still `decline_reason` verbatim.

### Root cause — my own DEF-205 assumption

DEF-205 preferred `answerText` and told the contract it was **required** on decline. The decider ignored it, so the fallback landed on the raw note. **Asking a model to fill a field is not a guarantee.** This is the fifth prompt-contract change this session that failed to produce the behaviour it described (DEF-198 rules, DEF-201 window wording, DEF-205 required field): the fix has to be in code, or it is a wish.

### Files changed

- `server/src/services/knowledge/reasoningCompose.applyDispatch.ts` — the reason is no longer eligible to be the reply. `declineMarker()` wraps it as `[declined: <reason>]`, cleaned of `[`/`]` (an inner bracket terminates the curated regex early and leaks the tail) and of newlines (the whole-marker shape test would otherwise never render it). The framing is then chosen in ONE place: `answerSanitizer`'s curated rule renders it as *"I can't do that: <reason>"* on the owner-facing route, and `sanitizeAnswerInBrainVoice` rewrites the whole marker in Brain's voice on WhatsApp.
- `server/tests/def206DeclineNeverRawNote.test.ts` — 9 tests, including end-to-end rendering through the **real** sanitizer.
- `server/tests/def205OwnerFacingField.test.ts` — two assertions updated (not silenced): DEF-206 supersedes the expression they pinned; the property is unchanged and stronger.

### Rollback considered and rejected

Reverting hands the owner an internal third-person note as his reply on every decline — the defect the guard has now caught twice.

### Tests added / verification (measured after the last code edit, at `d1314a5`)

`npx tsc --noEmit` clean · `npx vitest run`: 202 files — 201 passed, 1 skipped; 2,544 tests — **2,515 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone (`declineMarker` confirmed in the emitted JS, raw-reason form confirmed gone; `server/dist` is `chattr +i`, untouched) · `git diff --check` clean.

Four mutants applied and RUN, all four die. **Mutation testing caught a real hole in my own tests again:** *"prefer the raw reason over the marker"* survived the first pass because every assertion exercised `declineMarker` directly and nothing pinned the dispatch site — a guard on the expression now kills it.

### Known issues deliberately not fixed

**The residual is the reason TEXT.** The frame is fixed in code; the wording inside it is still the decider's, so "The user requested…" survives inside the sentence on the synchronous path. C1 should recover; C4/C5 may only partly. **C6's "offers no alternative" is not addressed** — supplying one requires knowing what Brain *can* do for that request, a capability-registry question and a separate build.

**THE OBSTACLE, attempt 5, unchanged because the evidence is.** Not delivery: `deployed-sha` equals HEAD with zero undeployed commits. It is **arithmetic** — Accurate Communication is 78/94 (gap 16), and the campaign states repairing an existing capability yields +1–2 (+0.1 overall) while making an absent one exist yields +20–30. Five turns of correct, deployed work on existing capabilities cannot move BRAIN's 48.1. **Sixth report** of the harness defect driving the misaim: the brief's table names the widest gap as `Simple @@CAPGAPS@@ Smart`, an unsubstituted placeholder.

## 58. DEF-207 — the SYSTEM findings bucket had a writer and no reader (2026-08-17, BUILDER: Claude — orchestrator iteration 4, branch `release/cmp-2026-08-16`)

### Observed behavior

Not an owner-visible reply defect. Codex's iteration-2 review of DEF-085, never closed: *"tenant-less raw-query findings remain operationally orphaned under GLOBAL and null user … it prevents the claimed detection from feeding the next decision/notification path."* The regression guard was **CLEAN** this turn; this is a detection that nothing consumed.

### Root cause

`runFindingNotifyPass` enumerates `prisma.tenant.findMany({ where: { isActive: true } })`; `GLOBAL` is not a tenant row; `openFindings` and `unnotifiedFindings` both **require** a `clientNumber`. A background timer has no tenant context, so DEF-085 filed its raw-query failures into a bucket no reader, notifier or health decision ever opened. **Rung 1 of the Self-Healing ladder (`capability_contract.md:214`) stopped one step short of its own definition** — "a health finding written without a human asking" is only a capability if something then READS it. The scope was also a magic string invented at the writer, which is how a bucket ends up with nobody looking in it.

### Files changed

- `server/src/services/selfheal/healthFindingService.ts` — `SYSTEM_SCOPE` exported as a constant; `systemFindings(limit)` added as the reader, **deliberately not folded into `openFindings(clientNumber)`** so a tenant read never silently includes another party's infrastructure faults.
- `server/src/services/selfheal/rawQueryFindingReporter.ts` — writer imports the constant instead of re-typing the literal, so writer and reader cannot drift apart silently.
- `server/src/services/selfheal/findingNotifier.ts` — the pass reads the bucket, sums occurrences per kind, logs one operator line and returns `systemOpen`. The read sits **outside the tenant loop and outside the digest window** (a quiet box is exactly when an unread bucket stays unread) and is wrapped in try/catch, because a monitor that breaks the pass it monitors is worse than no monitor.
- `server/src/server.ts` — `systemOpen` is **in the condition**, not only in the message. Gated behind `alerts || digests` the count would be invisible on a quiet box — the same unread bucket one layer up.
- `server/tests/def207SystemFindingsConsumed.test.ts` — 11 tests; the structural assertions strip comments before matching (DEF-195: a guard must read code, not prose about it).

**Nobody is notified, on purpose.** There is no owner for a system fault, and inventing one would be the fabricated attribution the reporter refuses to make.

### Rollback considered and rejected

Reverting restores a detection path that writes into a bucket nothing reads — DEF-085's claim without DEF-085's consequence.

### Tests added / verification (measured after the last code edit)

`npx tsc --noEmit` clean · `npx vitest run`: 203 files — 202 passed, 1 skipped; 2,555 tests — **2,526 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone (`server/dist` is `chattr +i`, untouched) · `git diff --check` clean.

Five mutants applied and RUN, all five die: drop `status:'open'` · read only when the digest is due · count rows instead of summing occurrences · gate the operator line behind `alerts/digests` · re-type the magic string at the writer.

### Known issues deliberately not fixed

**The consumer is an operator log line, not a repair.** Rungs 2 (recover) and 3 (repair) for tenant-less faults are **not built**; nothing here decides or acts on the finding. Rung 1 is complete end to end — that is the whole claim.

**Escalation answered: (a) accept iteration-4 CRITICAL 1 as a known limitation with a DEF row — NOT grounds for reverting.** The non-atomic revalidate-then-enqueue is dormant behind `selfpruning.withdrawal_notice_enabled = 0`; reverting would strip event-token identity, confirmed-write gating, row-carried debt, the CAS and tenant scoping — all live and verified — to remove a race in a path that cannot execute.

**THE OBSTACLE, attempt 6, unchanged because the evidence is.** Not delivery: `deployed-sha` equals HEAD with zero undeployed commits. **Arithmetic** — the campaign states repairing an existing capability yields +1–2 (+0.1 overall) while making an absent one exist yields +20–30. This turn attacked the widest gap (Self-Healing, 57) rather than another Accurate Communication repair, but rung 1 already existed: I completed an existing rung, not created an absent capability. **The move that would matter is rungs 2 and 3** — a tenant-less fault Brain recovers from and repairs unasked. **Seventh report** of the harness defect driving the misaim: the brief's table still names the widest gap as `Simple @@CAPGAPS@@ Smart`, an unsubstituted placeholder.

## 59. DEF-208 — the announcement and the fact it asserts commit together (2026-08-17, BUILDER: Claude — orchestrator iteration 4, remediation 1/3, branch `release/cmp-2026-08-16`)

### Observed behavior

Not owner-observed — the path is gated off. Codex raised it as iteration-3 CRITICAL 1 and again as iteration-4 CRITICAL 1, after two of my fixes: *"the pre-send check is another guard above an asynchronous gap … item A is CANCELLED at the fresh read, the owner restores A while `brainPromptQueue.findFirst` or the imports are pending, then enqueue runs; result = Brain tells the owner A withdrew although it is active."*

### Root cause — my own two non-answers

Iteration 3 revalidated; iteration 4 revalidated harder and moved the read closer to the send. **The flaw was never the freshness of the read.** Reading and announcing were two commits with an unbounded await between them (a queue lookup and two dynamic imports). A guard above an asynchronous gap is a guess about what will still be true; only the database can make it a fact. Last turn I proposed accepting this as a known limitation — that was wrong on the merits and this entry withdraws it.

### Files changed

- `server/src/services/brainPrompts/brainPromptQueueService.ts` — `EnqueueInput.tx`: the dedup probe and the insert run on the caller's transaction. Two behaviours are withheld on that path by design — **immediate dispatch** (a WhatsApp message cannot be rolled back; a send inside a transaction that aborts is a message the database says was never queued) and **digesting** (it writes on the ambient client and would escape the boundary). `top` criticality is rejected, not downgraded.
- `server/src/jobs/openItemsBacklogCleanupJob.ts` — `settleBatch` is one `prisma.$transaction` holding: the final revalidation filtered to the batch's own events; the **claim**, a per-row CAS on (tenant, user, id, status, `updatedAt`) stamping `announcedAt`, so a restore committing first matches nothing and the row is dropped from the notice while a later restore serialises behind it; the queue insert on the same `tx`; and the batch sent-mark, whose failure throws and rolls back all three. Both dynamic imports hoisted out of the boundary. This is the first interactive transaction in `src/`.
- `server/tests/def186SelfPruneWithdrawnNotice.test.ts` — 48 tests (6 new), including the barrier Codex specified: a restore fired **inside** the transaction, after the final revalidation and before the queue insertion, must yield no queued withdrawal fact. The prisma mock's `$transaction` **models rollback**, because rollback is the property under test.
- `server/tests/def208TransactionalEnqueue.test.ts` — 7 tests on the queue service: insert and probe on `tx`, no dispatch, no digest policy, `top` rejected, and the ordinary path still dispatching.

### Rollback considered and rejected

Reverting restores a guard above an asynchronous gap that Codex has now named twice.

### Tests added / verification (measured after the last code edit)

`npx tsc --noEmit` clean, exit 0 · `npx vitest run`: 204 files — 203 passed, 1 skipped; 2,570 tests — **2,541 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone (`$transaction` and the top-criticality rejection confirmed in the emitted JS; `server/dist` is `chattr +i`, untouched) · `git diff --check` clean.

**Eight mutants applied and RUN, seven die:** announce from the read instead of the claim · claim without the status predicate · claim without the version token · sent-mark count-0 not thrown · enqueue on the ambient client · tx caller dispatches anyway · dedup probe escapes the transaction. **The eighth (cancel-mark count-0 not thrown) SURVIVES and is reported rather than hidden — it is an equivalent mutant:** `claimed` is empty on that branch, nothing has been written, so rollback and early return are observationally identical.

**Mutation testing caught a real hole again:** the sent-mark mutant first survived because the mock's only failure mode threw, and a throw rolls back by itself — the count-mismatch branch was untested. **Two DEF-190 assertions were updated, not silenced:** "the retry finds the queue holding the identity" is superseded by "there is nothing to find", the same owner guarantee reached by making the bad state unrepresentable.

### Known issues deliberately not fixed

**No symptom tag closed, and none invented.** The nearest is `fabricated-status`; claiming it would strike an item off the owner's deck while the members he actually reported (email "sent", timezone "updated") stay broken.

**This produces no owner-visible change even if deployed.** `selfpruning.withdrawal_notice_enabled` defaults to **0**, so the live check cannot be performed on this turn. What ships is the removal of the reason not to turn that gate on.

**Unsure: transaction duration under load.** The boundary holds up to `OWED_ROWS_PER_NOTICE` (200) per-row updates plus one insert, against Prisma's 5s default interactive-transaction timeout. Not measured against production row counts.

**Still open from Codex's iteration-4 list:** HIGH 4 (the 200-row cap starving unclaimed debt behind claimed rows) and directive 5 (`delegationFollowUpJob` settings authority and tenant scope). Named, not dropped.

## 60. DEF-209 — the receipt was the reply, and the question was only half answered (2026-08-17, BUILDER: Claude — orchestrator iteration 5, remediation 2/3, branch `release/cmp-2026-08-16`)

### Observed behavior

Regression guard fired on `B04-outstanding-question-ignored`: C6 85→40, C5 90→50, C3 90→60, C4 90→60, C1 100→80, mean **94.4 → 73.8**. The entire reply was *"Proceeding with update open item."* Judge: *"Brain only handled the 'priority' part of its original question, completely ignoring the 'deadline'"*, *"sounds robotic and templated"*, *"unclear if this action has actually been initiated"*.

### Root cause — two defects in one three-word string, at two sites

**(a) `guard-destroys-the-answer`.** `reasoningCompose.applyDispatch.ts:155` fell back to `` `Proceeding with ${type}.` ``, and `brainComposer.ts:3357` overwrote the model's prose unconditionally — its own comment: *"replace whatever confused prose the main compose produced with a neutral descriptive line"*. That is the member Codex named (*"DEF-144 showed the equivalent success-renderer failure, where a deterministic receipt replaced useful model prose"*), and it is hardcoded English pretending to be Brain, which the standing memory rule forbids.

**(b) The outstanding question.** Brain asked for a priority AND a deadline, got the priority, and never mentioned the deadline again. Neither site *could* have chased it: neither was ever told what the previous turn asked for. The information existed — Brain's last message in `history`, the filled slots in the action payload — and nothing compared them.

**What was wrong with my last attempts:** DEF-205 and DEF-206 fixed the *decline* branch of the same function, twice, and I never looked one case down at the *act* branch, which had the identical defect in a worse form. DEF-206 even established the pattern that fixes this — wrap the internal value as a marker, let the one curated renderer speak it — and it sat unused three lines away.

### Files changed

- `server/src/services/knowledge/actionReceipt.ts` (new) — `requestedSlots` (gated on the turn being a question), `filledSlots` (blank/null/empty-array is NOT filled), `outstandingSlots`, `lastBrainQuestion`, and `actionReceiptMarker`, a **provenance-stamped** `systemMarker('proceeding: {JSON}')`. Provenance matters concretely: `isWholeMarker`'s regex is `[^\]]{2,200}`, so the `]` closing a JSON array makes the shape test false and a bare bracketed payload would reach the owner as raw internal text.
- `server/src/services/knowledge/answerSanitizer.ts` — `proceedingMarkerMeaning`, computed and validated (an unknown slot key rejects to null), stating two facts: the action is under way and **not yet confirmed**, and which part of the earlier question is still unanswered. The vocabulary is imported from the constructor, so parser and builder cannot drift.
- `server/src/services/knowledge/reasoningCompose.applyDispatch.ts` — prose wins; the marker is the fallback; the history is threaded in.
- `server/src/services/knowledge/brainComposer.ts` — the decider commits to the action but no longer deletes the reply; only an empty answer falls back.
- `server/src/jobs/openItemsBacklogCleanupJob.ts` — **Codex iteration-4 MEDIUM 4 closed**: the owed-row query pages past claimed rows, bounded at 10 pages, and logs when the bound is hit, so a permanently failing clear in the first 200 cannot starve row 201.
- `server/tests/def209ActionReceipt.test.ts` (21 tests) and `server/tests/def186SelfPruneWithdrawnNotice.test.ts` (+1 starvation test at real size: 200 stuck rows and one newer).

### Rollback considered and rejected

Reverting restores a template as the owner's reply and re-drops the unanswered half of Brain's own question.

### Tests added / verification (measured after the last code edit)

`npx tsc --noEmit` clean, exit 0 · `npx vitest run`: 205 files — 204 passed, 1 skipped; 2,592 tests — **2,563 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone (the template confirmed gone from the emitted JS with comments stripped; the marker builder confirmed present; `server/dist` is `chattr +i`, untouched) · `git diff --check` clean.

**Ten mutants applied and RUN, all ten die:** treat any prose as an open question · a blank value counts as filled · read the last turn whoever said it · drop marker provenance · accept an unknown slot key · the fact claims completion · the reasoning path prefers the template · the legacy decider overwrites prose again · read one page only · never advance the page offset.

### Known issues deliberately not fixed

**When the decider produces prose, the outstanding slot is not appended.** Prose wins and the marker never runs; appending hardcoded English to LLM prose is the rule this fix obeys. Closing that half needs the reasoning contract to carry outstanding slots as input — a separate turn. B04's `answerText` was empty, so the measured case is covered.

**The vocabulary is four slots** (priority, due date, owner, title). A question outside it leaves nothing outstanding — deliberate, because a false open question is its own fabrication.

**Unsure whether C5 fully recovers:** the judge wanted Brain to ask *before* proceeding; this proceeds *and* asks. If the case demands withholding the dispatch, that is a decider change.

**Unlike DEF-208, this is owner-visible if deployed** — no feature gate stands between it and a live reply.

## 61. DEF-210 — the concurrency guarantee turned into evidence (2026-08-17, BUILDER: Claude — orchestrator iteration 6, branch `release/cmp-2026-08-16`)

### Observed behavior

Reviewer finding, not owner-visible. Codex iteration-4 HIGH 3, open across three remediations: *"overlapping cleanup invocations select the same unclaimed owed row before either insert commits; result = two batches with different UUID-derived dedup keys both satisfy the database constraints and both enqueue."*

### Root cause

His finding was true of the FIRST outbox, whose dedup key was a fresh `randomUUID()` — two creators, two keys, no collision, two notices. DEF-202 replaced it with a key derived from the sorted member event tokens, which turns the existing unique index into the ownership constraint he asked for. **That was asserted in a change-log row and never tested, and an untested guarantee is a claim.**

### Files changed

- `server/tests/def186SelfPruneWithdrawnNotice.test.ts` — the prisma mock now enforces the real unique index (`self_prune_notice_batches_dedup_uq`, `20260817_self_prune_notice_outbox/migration.sql:24-25`), and four tests: two genuinely overlapping dispatchers over one owed event produce exactly one batch and one queue row; the same membership recomputes the same identity; a different withdrawal event still gets its own identity so the constraint cannot block real work; and the key is computed from SORTED tokens so member ordering cannot split one event in two.

**No production code changed.**

### Tests added / verification

Three mutants applied and RUN, all three die: restore the random dedup identity · leave the tokens unsorted · swallow the unique-index collision as a generic error.

### Known issues deliberately not fixed

**CAPABILITY: RELIABILITY-ONLY · PREDICTED: +0** — the guarantee already existed; this demonstrates it.

## 62. DEF-211 — asking is not a reason to delete (2026-08-17, BUILDER: Claude — orchestrator iteration 6, branch `release/cmp-2026-08-16`)

### Observed behavior

Regression guard fired on `B03-pronoun-followup` C5 **95 → 75**. The whole reply was *"When you say 'what about it', are you asking for more details, or do you want me to take an action regarding the Q3 headcount plan?"* Judge: *"it could have made an intelligent guess and offered information first."* It could have — the subject was resolved well enough to be named in the question.

### Root cause — three defects, and the middle one is why a renderer-only fix would have been a no-op

1. `applyReasoningDecision`'s **`ask`** case returned `question.text` and ignored `answerText` completely — the third branch of that one function to destroy prose, after decline (DEF-205/206) and act (DEF-209).
2. **The reasoning contract said *"Exactly ONE of {action, action_plan, question, answer_text} is non-null"***. With the owner-facing field inside that exclusion, answering-and-then-asking was **unrepresentable**: a decider obeying the contract could never fill both, so repairing the renderer alone could not fire once.
3. The legacy decider's **`missingSlot`** arm — three lines below the arm DEF-209 repaired — overwrote the composed prose with a slot prompt. **I fixed one arm of an if/else last turn and left its sibling.**

### Files changed

- `server/src/services/knowledge/actionReceipt.ts` — `answerThenAsk()`: known first, open question after; the identity when only one side exists; never the question twice. One implementation, imported by both sites.
- `server/src/services/knowledge/reasoningCompose.ts` — `answer_text` removed from the mutual-exclusion set; `ask` guidance tells the decider to say what it already knows; the field description marks it optional and encouraged on `ask`.
- `server/src/services/knowledge/reasoningCompose.applyDispatch.ts` — the `ask` branch composes both; its hardcoded English fallback becomes `[clarification needed: …]`.
- `server/src/services/knowledge/answerSanitizer.ts` — a curated meaning for that marker, so it is never published raw.
- `server/src/services/knowledge/brainComposer.ts` — the `missingSlot` arm appends instead of overwriting.
- `server/tests/def211AnswerThenAsk.test.ts` — 11 tests; `server/tests/def205OwnerFacingField.test.ts` — one assertion updated, not silenced.

### Rollback considered and rejected

Reverting restores a reply that is a question and nothing else, on a path where Brain already knew enough to name the subject.

### Tests added / verification (measured after the last code edit)

`npx tsc --noEmit` clean, exit 0 · `npx vitest run`: 206 files — 205 passed, 1 skipped; 2,607 tests — **2,578 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone (both `answerThenAsk` call sites confirmed in the emitted JS, old fallback confirmed gone; `server/dist` is `chattr +i`, untouched) · `git diff --check` clean.

**Six mutants applied and RUN, all six die:** question first · answer dropped · ask returns the question alone · missingSlot overwrites again · contract re-adds `answer_text` to the exclusion · the marker loses its curated meaning.

### Known issues deliberately not fixed

**`B08-bad-news` C3 100 → 85 is not fixed.** The judge's note is that the reply "reframes it slightly as 'things that might need attention'" against an otherwise detailed and correct answer. No mechanism to change was found, and inventing one would be worse than saying so.

**The contract half is a request to a model**, and DEF-206's lesson is that a request is not a guarantee. The code preserves whatever arrives; if the decider still fills only `question`, B03 will not move.

**CAPABILITY: Accurate Communication · PREDICTED: +1 to +2 · MECHANISM:** asking is no longer a reason to delete, and the output contract can now express both. **FALSIFIER:** a clarifying turn still reaching him as a bare question when `answer_text` was filled.

**DEF-209 landed:** B04's reply in `iter-05-post-build.json` is now *"Got it. I've set the priority to high. Does it need a due date?"*

## 63. DEF-212 — the receipt stays the fact, stops being the sentence (2026-08-17, BUILDER: Claude — orchestrator iteration 6, branch `release/cmp-2026-08-16`)

### Observed behavior

`B04-outstanding-question-ignored` in `iter-06-post-build.json`: *`Updated "Define rules for Brain's responsiveness to new vs. existing contacts": priority=high.`* — field names and an equals sign, byte-for-byte the string DEF-144 and DEF-145 were written about.

The regression guard fired on `B07-compound-ask` instead, and that one is a **judge artifact, not a defect**: Brain said the item "was due on August 5th, 2026" and today is 2026-08-17, so "overdue" is correct. The judge called Aug 5 2026 "in the future" because `brainResponseEvaluator.ts` never puts today's date in its prompt (`grep -c "todayDate|Asia/Karachi|toISOString"` → 0). Reported and left alone — the benchmark and judge are not the Builder's to edit.

### Root cause

`brainComposer`'s `update_open_item` success branch did `answer = actionResult.message` whenever `verifyUpdateProse` could not positively justify the composed prose. That fail-closed judgement is **right** — the receipt is true by construction, it lists what the database actually received — and it is untouched. What it also did was hand the owner a log line and discard the still-unanswered half of Brain's own question (DEF-209). `update_open_item` was the only SUCCESS branch doing this; every other branch already emits a bracketed marker.

### Files changed

- `server/src/services/knowledge/actionReceipt.ts` — `actionAppliedMarker({receipt, outstanding})`: the receipt travels verbatim as a JSON payload inside a provenance-stamped marker.
- `server/src/services/knowledge/answerSanitizer.ts` — `appliedMarkerMeaning` quotes the receipt **without rewording** (this parser must not restate a fact it did not establish), then names what is still outstanding; rejects any payload the constructor could not have produced.
- `server/src/services/knowledge/brainComposer.ts` — outstanding is computed from `data`, the Prisma payload actually written, never from `act`, what the model asked for.
- `server/src/services/knowledge/answerReceiptPolicy.ts` — `verifyAppliedMarker` mints the `VerifiedProse` token from the receipt and artifact in the process that did the write, so `channelRenderer.receiptWins` — the line DEF-145 identified as "the line that actually decides what the owner reads" — does not put the raw receipt back one layer down. **Fail-closed is unchanged: no token, receipt wins.**
- `server/tests/def212AppliedReceipt.test.ts` (15 tests); `server/tests/def144ReceiptDoesNotReplaceAnswer.test.ts` — two assertions updated, not silenced.

### Rollback considered and rejected

Reverting restores a reply written in field names that also drops the owner's open question.

### Tests added / verification (measured after the last code edit)

`npx tsc --noEmit` clean, exit 0 · `npx vitest run`: 207 files — 206 passed, 1 skipped; 2,622 tests — **2,593 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone · `git diff --check` clean.

**Eight mutants applied and RUN, all eight die.** Mutation caught two real holes, both mine: an `isUsableBrainProse` widening I wrote **changed nothing** (a stamped marker starts with the sentinel, not `[`, so it already passed) and was deleted rather than left as decoration; and a hand-built parser payload contained an escaped quote, making it invalid JSON so the test passed for the wrong reason — it now asserts the payload parses first.

### Known issues deliberately not fixed

**B07 is not fixed because nothing is wrong with the reply** — the judge is not told the date.

**The two composer paths still disagree.** B04 was prose in iteration 5 and the receipt in iteration 6 from the same code; this repairs the branch that produced the bad one but does not converge the reasoning and legacy paths. That is a bigger build.

**Iteration 4's remediation is complete**, with commits: CRITICAL 1 → DEF-208 `2acb272`, HIGH 2 → DEF-202, HIGH 3 → DEF-210 `b095875`, MEDIUM 4 → DEF-209 `41358ab`, MEDIUM 5 → matrix green, MEDIUM 6 → DEF-209/211/212, and CARRIED 1 (`delegationFollowUpJob`) → **DEF-191 `bb0cf57` / DEF-192 `9cb7720`**, which already tenant-scoped the enumeration, the identity lookup and the settings authority.

## 64. DEF-213 — state the fact, not the bookkeeping (2026-08-18, BUILDER: Claude — orchestrator iteration 7, branch `release/cmp-2026-08-16`)

### Observed behavior

Worst pair in the `iter-06-post-build.json` fixQueue, both halves on one sentence of B12's reply — *"…my own dispatch log doesn't have a record of why that happened."*

- **C4 80** — "feels a little too mechanical and like it's explaining its internal workings rather than just stating a simple 'I don't know why it happened'."
- **C1 85** — "it implies a dispatch log exists and was checked, which isn't explicitly confirmed as an actual action."

The regression guard fired on `B06-just-do-it` (mean 98.1 → 92.5) instead, and that one is **measurement noise**: every criterion reason is praise — "appears truthful", "no indication of fabricated facts", "reads as natural and human-like. No machine markers or canned phrases", "doesn't hide information" — on a clean grouped summary. A 5.6 move on a mean of nines with no named fault is the judge landing on 90 rather than 100.

### Root cause

**Brain was echoing the block.** `pushHistoryBlock` supplied the vocabulary in the one place the model is told how to talk about this subject: "your record shows", "this record covers", "say your own record is unavailable", "the other subjects in your record". Second person in the prompt, first person in the reply. The C1 half is the serious one — the sentence asserts a lookup the owner cannot verify and Brain may not have performed.

### Files changed

- `server/src/services/selfpruning/pushHistoryBlock.ts` — every instruction is now fact-shaped ("it was pushed at most once", "what is visible here covers the last 36h only", "say you cannot tell for this window"), plus one rule, **SAY WHAT IS TRUE, NOT HOW YOU KNOW IT**, which names the first-person forms it forbids and gives both reasons, the verifiability one explicitly.
- `server/tests/def213StateTheFact.test.ts` — 10 tests, asserting the **absence** of the supplied vocabulary from every rendered surface (complete page, degraded page, unavailable block).
- `server/tests/def197PushHistoryBlock.test.ts` — seven assertions rephrased, not silenced.

**Why this is not a sixth prompt wish:** DEF-206's lesson was that *asking* a model to fill a field is not a guarantee, because that is behaviour it must choose to perform. This is the opposite direction — removing the source string it was copying — and the tests assert absence, which is the half that cannot be ignored.

### Rollback considered and rejected

Reverting puts back the phrases the reply was quoting.

### Tests added / verification (measured after the last code edit)

`npx tsc --noEmit` clean, exit 0 · `npx vitest run`: 208 files — 207 passed, 1 skipped; 2,632 tests — **2,603 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone (all four phrases confirmed gone from the emitted code with comments stripped; the rule confirmed present) · `git diff --check` clean.

**Six mutants applied and RUN, all six die.** Mutation caught a real hole in my own guard: the forbidden-phrase list matched the NEW RULE — which must name `"my dispatch log"` in order to forbid it — so a mutant deleting the prohibition would have been rewarded. The list now covers only the second-person forms the block supplied, with a separate assertion that the rule names the first-person ones.

### Known issues deliberately not fixed

**No symptom tag closed, and none invented.** The nearest is `fabricated-status` for the C1 half; claiming it would strike an item off the owner's deck while the members he reported stay broken.

**The wording inside the reply is still the model's.** By my own DEF-206 rule this is prompt-side and weaker evidence than a code guarantee, and it is labelled that way rather than presented as structural closure.

**No C-3 campaign progress.** Increment 1 is still the first undone item; three consecutive turns have gone to Accurate Communication regressions instead.

**CAPABILITY: Accurate Communication · PREDICTED: +0 to +1 · MECHANISM:** the block no longer supplies the machine vocabulary the reply was copying, and forbids the first-person form. **FALSIFIER:** a reply still says "my dispatch log"/"my records show", or B12 C1/C4 do not move — which would mean the vocabulary came from elsewhere and I diagnosed the wrong source.

## 65. DEF-214 — a local clock wearing a UTC label (2026-08-18, BUILDER: Claude — orchestrator iteration 8, branch `release/cmp-2026-08-16`)

### Observed behavior

Owner-derived, not a benchmark case. `time-of-day-drift`, **5 occurrences** (DEF-026 ×4, DEF-148, both OPEN), recorded in Codex's analysis as *"Not diagnosed from code this turn."*

> Brain: "My current time is 12:07 PM in your timezone (Asia/Karachi)."
> Owner: "Are u traveling back to time?"      (his local time was 17:07)

### Root cause — the arithmetic is the diagnosis

**12:07 and 17:07 differ by exactly five hours, which is Asia/Karachi's offset from UTC.** He was handed a UTC clock wearing a PKT label. Two defects, in two prompt builders:

1. `brainComposer.ts:1570` said `` `Today is ${todayDate} (UTC)` `` — but `getUserLocalDate` has returned the user's **LOCAL** date since Sprint 4A. The value was right and the label was a lie, so the anchor the model reasons from was declared to be in a zone it was not in; a model told "this is UTC" converts it when asked the time.
2. **No HOUR was supplied at all**, so "what time is it" could only be answered by inventing one and labelling it with his zone — `fabricated-status` wearing a clock face.
3. `brainComposer.ts:6215`, the `decideAction` prompt, carried the identical line — `protection-with-two-implementations` on the date label itself.

### Files changed

- `server/src/services/userTimezoneService.ts` — `OwnerClock {timezone, date, time, offset}`, `formatLocalTime`, `ownerClockFor`, `getOwnerClock`, and `renderOwnerClockLine` as the **single** builder. All four parts are returned together because they are one fact, and splitting them is how the label came adrift from the value.
- `server/src/services/knowledge/brainComposer.ts` — both prompts now state the local date, the local HH:MM, the zone NAME and the offset; forbid stating a clock not given; forbid attaching his timezone to an inferred hour. A failed resolution yields `null` and the prompt **says** the clock is unknown rather than falling back to a mislabelled date.
- `server/tests/def214OwnerClock.test.ts` — 13 tests, including the reported instant as a fixture.

### Rollback considered and rejected

Reverting restores an anchor labelled with a zone it is not in, on a class with five owner occurrences.

### Tests added / verification (measured after the last code edit)

`npx tsc --noEmit` clean, exit 0 · `npx vitest run`: 209 files — 208 passed, 1 skipped; 2,645 tests — **2,616 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone (the UTC mislabel confirmed gone from the emitted code with comments stripped; two reachable renderer sites) · `git diff --check` clean.

**Nine mutants applied and RUN, all nine die.** Mutation caught two real holes, both mine and both the shape DEF-213 hit: `toContain('17:07')` passed with the clock removed, because the rule's own lesson quotes "12:07 when it was 17:07" — the guard matched its own prose; and `/say so plainly rather/` already existed elsewhere in the file, making the fallback assertion vacuous. A third: presence is not reachability — `${false ? renderOwnerClockLine(...)}` keeps the call text, so both sites are now pinned as gated.

### Known issues deliberately not fixed

**DEF-213 partly worked and is honestly scored:** B12 C1 85→90 and C4 80→85, but the reply still says "my internal dispatch record" — a synonym my falsifier did not name. That is the failure mode of a prompt-side fix.

**I did not chase the fix queue.** All five top entries are C4 at 85 register complaints, and the standing instruction is not to chase C4 to 95.

**No C-3 campaign progress** — four consecutive turns on Accurate Communication.

**This is prompt-side.** It removes a false premise and supplies a true fact; nothing in code forbids the model from inventing an hour anyway. **No benchmark case asks the time**, so the score may not move — the evidence here is the owner's chat and the arithmetic, not the harness.

**CAPABILITY: Accurate Communication · PREDICTED: +1 to +2 · MECHANISM:** the anchor is no longer labelled with a zone it is not in, and the hour is supplied as a fact instead of inferred. **FALSIFIER:** Brain states a clock time differing from his real local time, or labels an hour with his timezone when `getOwnerClock` returned null.

## 66. DEF-215 — "should be asked for" was a licence to defer (2026-08-18, BUILDER: Claude — orchestrator iteration 8, branch `release/cmp-2026-08-16`)

### Observed behavior

`iter-08-post-build.json`, B04 — **C6 75, C5 80**. The guard did not fire; I found it by reading the report.

> "Got it. I've set the priority to high. **I'll ask for a due date if one becomes necessary.**"

Judge C6: *"Brain had previously asked for both 'priority and deadline'. The response only addresses the priority."*

### Root cause — mine, two iterations old

DEF-209 and DEF-212 both ended the outstanding-slot fact with *"and should be asked for"*. That is a **standing intention**, not an instruction about this reply, and the model satisfied it in the future tense and made it conditional. The run before, the same case read *"OK, I've set the priority to high. When is it due?"* — so this is not the old drop-it-silently defect returning; it is a new hedge created by the wording I introduced. A fact that DESCRIBES asking is not a fact that REQUIRES the question now.

### Files changed

- `server/src/services/knowledge/answerSanitizer.ts` — both curated meanings now end: *"ASK FOR IT IN THIS REPLY — do not promise to ask later and do not make it conditional. He answered part of what you asked; the rest is still open now."* The last clause credits what he did answer, so the chase cannot read as a repeat of the whole question. Changed at **both** sites in one edit.
- `server/tests/def215AskNowNotLater.test.ts` — 11 tests, both markers driven through the real parser.
- `server/tests/def209ActionReceipt.test.ts` — one assertion updated, not silenced.

### Rollback considered and rejected

Reverting restores the phrase that produced the hedge.

### Tests added / verification (measured after the last code edit)

`npx tsc --noEmit` clean, exit 0 · `npx vitest run`: 210 files — 209 passed, 1 skipped; 2,656 tests — **2,627 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone (the deferral licence confirmed gone from the emitted code; the new instruction present at both sites) · `git diff --check` clean.

**Two mutants applied and RUN, both die:** restore the deferral licence · keep "ask now" but stop forbidding the two hedges.

### Known issues deliberately not fixed

**The escalation is answered (a): accept as a known limitation with a DEF row, do NOT revert.** Every numbered risk from iteration 4 is closed with commits (DEF-208 `2acb272`, DEF-202, DEF-210 `b095875`, DEF-209 `41358ab`, DEF-191 `bb0cf57` / DEF-192 `9cb7720` for the carried item), and `review_log.md` has not grown since — the reviewer has not re-read the change three remediations later. Reverting would strip the transaction boundary, event-token identity, membership-derived ownership and the paging fix to remove findings that are no longer there.

**C-3 increment 1 is BUILT but has no live surface.** `inboundNoiseLedger.ts` already exports `summariseInboundNoise` and `renderNoiseReport` — the read-only classifier and counter. Its only consumers are a hand-run script (`src/scripts/nexeoInboundNoiseReport.ts`) and the push-history prompt block. Nothing scheduled produces that number for the owner, and the increment's *Done when* requires exactly that. The remaining work is one scheduled surface, not the classifier — recorded so the next turn can take it directly.

**No C-3 progress this turn**, five consecutive turns now. I took B04 because it is a live owner-visible regression that I caused.

**B04 has flapped across three consecutive runs** (asked → deferred → asked), so one good measurement will not prove this fix.

**CAPABILITY: Accurate Communication · PREDICTED: +0 to +1 · MECHANISM:** the outstanding-slot fact no longer describes a future intention the model can satisfy by promising. **FALSIFIER:** a reply still defers or conditionalises a slot Brain itself asked for, or B04 C5/C6 do not recover.

## 67. DEF-216 — the same question, twice, in one reply (2026-08-18, BUILDER: Claude — orchestrator iteration 9, branch `release/cmp-2026-08-16`)

### Observed behavior

Regression guard fired on `B02-unknown-fact`: C5 **95 → 60**, C3 95 → 75, C4 90 → 70, mean 95.6 → 83.1. Judge C5: *"it repeats a question it just asked ('Shall I create a new contact for her?')"*. What he read ended with the same ask twice, the second copy preceded by a restatement of the reply's own opening.

### Root cause — mine, from DEF-211 two iterations ago

`answerThenAsk` deduped with `if (a.includes(q)) return a` — **byte-identical only**. The prose already ended *"Shall I create a new contact for her?"*; the decider's question was a longer string whose tail duplicated that sentence and whose head restated paragraph one. Neither was a substring, so `includes` said "append" and both shipped.

### Files changed

- `server/src/services/knowledge/actionReceipt.ts` — the comparison is now sentence by sentence on a normalised key (case, punctuation and spacing flattened), so an exact repeat is caught wherever it sits. Three properties pinned: nothing fresh → the answer alone; a partial repeat → only the new sentences; nothing repeated → the question passes through **verbatim** rather than re-joined, so a mis-cut sentence cannot reach him reworded.
- `server/tests/def216NoRepeatedAsk.test.ts` — 9 tests driving the exact B02 strings.

### Rollback considered and rejected

Reverting restores a dedup that only fires on a byte-identical repeat.

### Tests added / verification (measured after the last code edit)

`npx tsc --noEmit` clean, exit 0 · `npx vitest run`: 211 files — 210 passed, 1 skipped; 2,665 tests — **2,636 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone (the byte-identical dedup confirmed gone from the emitted code) · `git diff --check` clean.

**Five mutants applied and RUN, all five die.** Mutation caught a real hole: the pass-through mutant survived the first pass because my fixture re-joined to the identical string, so the test could not tell the two paths apart; the fixture now contains formatting the re-join would flatten and asserts that first.

**I corrected my own expectation rather than the code.** I predicted the whole appended question would vanish; the head sentence is a paraphrase of paragraph one, not a repeat, and deleting sentences that merely resemble the prose is `guard-destroys-the-answer` itself.

### Known issues deliberately not fixed

**The paraphrased restatement survives** — B02's reply still carries one redundant sentence. Removing it needs semantic judgement, and shipping a redundant sentence is better than a renderer that deletes prose it merely thinks it has seen.

**No C-3 progress**, six consecutive turns. Increment 1's classifier already exists (`inboundNoiseLedger.summariseInboundNoise`) and needs only a scheduled surface to quote the count to the owner — recorded last turn, still the smallest real capability move available.

**A pattern the orchestrator should weigh:** three of my last four turns fixed defects introduced by my own turns two before. The changes are small and tested and they still generate work at about the rate they close it, which is the argument for spending the next turn on the campaign rather than the queue.

**CAPABILITY: Accurate Communication · PREDICTED: +1 to +2 · MECHANISM:** a repeat is detected at the sentence, where it occurs, instead of only when the whole appended string is a substring. **FALSIFIER:** a reply still contains the same question twice, or B02 C5/C3/C4 do not recover.

## 68. DEF-217 — C-3 increment 1 finally has a surface (2026-08-18, BUILDER: Claude — orchestrator iteration 9, branch `release/cmp-2026-08-16`)

### Observed behavior

Campaign work, not a reported reply defect — **no symptom tag closed, and none invented**. The owner's words behind it are CL-033: *ten unactionable pushes from one unknown number in a single morning, all of which he had to read.*

The regression guard was CLEAN (B02 recovered after DEF-216), remediation had nothing left to close, and the fix queue offered only C4 register nits the brief forbids chasing. Accurate Communication is now the **narrowest** gap on the card at 11; Self-Pruning is 49. **Divergence from the stated target is declared:** the campaign names this work.

### Root cause — the classifier was never the missing piece

`inboundNoiseLedger.summariseInboundNoise` has produced per-sender and per-subject reached-and-acted counts for some time. Its only consumers were a hand-run script (`scripts/nexeoInboundNoiseReport.ts`) and a prompt block. **Nothing ever said the number to the owner** — and increment 1's *Done when* is exactly that: *"Deployed, and the real count for the CL-033 unknown-number burst is quoted back to the owner from production data."* Five campaign turns could therefore pass with the increment "nearly done" and nothing owner-visible. I recorded this in iterations 8 and 9 and took benchmark regressions instead; this builds it.

### Files changed

- `server/src/jobs/inboundNoiseReportJob.ts` (new) — tenant REGISTRY read only (the DEF-191/192 shape), then per-tenant, per-user; reads the ledger; picks the loudest sender clearing a configurable floor; enqueues **at most one message per user per day**, with the date in the dedup key so the queue refuses the second rather than a timer. **Floods are chosen before resolved subjects**, because CL-033 lands in `unattributed` precisely for having no item or thread identity — a report reading only `subjects` would have missed the founding case.
- `server/src/services/notifications/proactiveMessageText.ts` — `renderInboundNoiseNotice`, a provenance-stamped marker with a JSON body; `acted` clamped to `reached` at the constructor so it can never mint what the parser rejects.
- `server/src/services/knowledge/answerSanitizer.ts` — `noiseMarkerMeaning`, stating **counts only**: no recommendation, no offer to mute, no judgement about the sender. Increment 1 is "the number that proves the problem"; proposing an action would be increment 2 arriving early and ungated.
- `server/src/services/behaviorConfig.ts` — `selfpruning.noise_report_enabled` (**default 1**) and `selfpruning.noise_report_min_pushes` (default 5).
- `server/src/server.ts` — scheduled hourly.
- `server/tests/def217InboundNoiseReport.test.ts` — 12 tests.

**On default 1**, the one judgement call: the neighbouring self-pruning flags default 0 because they SUPPRESS or ANNOUNCE state changes. This one only reads and reports — nothing is withheld and no item is touched — and its Done-when requires the number to reach him, so a gate defaulting off would leave the increment as unbuilt as it has been for six turns.

### Rollback considered and rejected

Reverting returns the count to a script nobody runs.

### Tests added / verification (measured after the last code edit)

`npx tsc --noEmit` clean, exit 0 · `npx vitest run`: 212 files — 211 passed, 1 skipped; 2,677 tests — **2,648 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone (job emitted, schedule confirmed in `server.js`, curated meaning present) · `git diff --check` clean.

**Seven mutants applied and RUN, all seven die:** subjects before floods (CL-033 missed) · first instead of loudest · floor ignored · identity sentence dropped · parser accepts acted > reached · constructor stops clamping · the count is not stated.

**A vacuous assertion was caught before it could pass for the wrong reason:** `not.toContain('could not be tied')` against a sentence whose real wording is "None of them could be tied…" — that phrase never exists, so it could never fail. The same trap mutation caught in DEF-213 and DEF-214.

### Known issues deliberately not fixed

**It is not observed live.** The increment's Done-when is not met until deployed and a real count is quoted back. I can build it; I cannot deploy it, and an unshipped increment is not delivered.

**No suppression, digest or quarantine** — increments 2 and 3, and shipping any of them inside a report would be ungated behaviour change.

**Unsure whether Grok scores it.** The card gives Self-Pruning *basis: absent*; this makes one third of the increment list exist and reach the owner, hence a deliberately wide prediction band.

**CAPABILITY: Self-Pruning · PREDICTED: +5 to +15 · MECHANISM:** the count that proves the problem now reaches the owner on a schedule instead of living in a script nobody runs. **FALSIFIER:** a morning burst passes with no message; a message names a sender or count production data does not support; or Grok leaves Self-Pruning at *basis: absent* after this ships.

## 69. DEF-218 — the increment-1 job, tested where it actually risks something (2026-08-18, BUILDER: Claude — orchestrator iteration 10, branch `release/cmp-2026-08-16`)

### Observed behavior

Not a reply defect — a gap in my own DEF-217, found by asking what a deploy of it actually depends on. DEF-217 shipped C-3 increment 1 with 12 tests, **all of them on `worstOffender` and the marker**. The job itself had none: nothing exercised tenant scoping, the master switch, the once-per-day guarantee, or a user whose read throws.

**Self-Pruning moved 40 → 48 (+8)** on Grok's card this turn — the first capability movement across thirty iterations, arriving the turn after increment 1 existed as code. Two qualifications kept on the record: Grok scores by reading the codebase, so it plausibly scored the code rather than an owner-visible effect; and **increment 1's Done-when is still not met**, because it requires the count quoted back from production data and nothing is deployed. It does clear the campaign's abort condition (+5 required).

### Root cause

The wrong gap to leave open on this file specifically, and the reason is this session's record rather than general caution: **every review finding Codex has raised against a background job here landed in exactly four places** — tenant boundary (iteration-3 CRITICAL, iteration-4 CARRIED), gating (DEF-191), idempotency (iteration-3 HIGH 2, iteration-4 HIGH 3), and failure isolation. A new job with well-covered selection logic and uncovered orchestration is the finding waiting to happen.

### Files changed

- `server/tests/def218NoiseReportJob.test.ts` — 13 tests on the four properties a deploy depends on: every user and ledger read carries the tenant and the registry read is asserted to be the only one that does not; the flag at 0 reports nothing *and costs no query*; an unreadable flag fails open because the increment exists to be seen; the floor comes from the flag; the dedup key carries user AND date; a `duplicate` verdict from the queue counts as quiet, never reported; a user failure is counted and the next user still reports; a tenant failure does not stop the next; a failed registry read reports nothing rather than throwing.

**No production code changed.**

### Tests added / verification (measured after the last code edit)

`npx tsc --noEmit` clean, exit 0 · `npx vitest run`: 213 files — 212 passed, 1 skipped; 2,690 tests — **2,661 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone · `git diff --check` clean.

**Seven mutants applied and RUN, all seven die:** user read loses the tenant · ledger read loses the tenant · master switch ignored · dedup key drops the date · a queue duplicate counted as reported · a user failure aborts the pass · the floor ignores the flag.

### Known issues deliberately not fixed

**Increments 2 and 3 were not built, because they largely exist.** `decideDigest` is wired into `enqueueBrainPrompt` — the one chokepoint — gated by `selfpruning.digest_enabled`=0; the quarantine → grace → soft-close lifecycle and the withdrawal outbox are DEF-186..209, gated by `selfpruning.withdrawal_notice_enabled`=0. **The campaign's blocker is uniformly deployment and live observation, not missing code.**

**A defect I suspected in DEF-217 does not exist.** I thought the noise report could itself be digested by increment 2's policy; `decideDigest` requires an exact item identity and the report has none, so it returns "no exact item identity — uncertain subjects are never digested". Reported rather than "fixed" — a phantom fix is worse than none.

**The fix queue was not taken**, and the reason is on the record: its three worst entries are all B12, one is C4 register (forbidden to chase) and one asks for *"what steps it will take"* — the sentence `FABRICATED_PROCESS_RE` exists to block (DEF-163). B12's answer no longer contains the invented cause the fixQueue text quotes.

**CAPABILITY: RELIABILITY-ONLY · PREDICTED: +0 · MECHANISM:** none; the guarantees already held and are now demonstrated. **FALSIFIER:** a deploy of DEF-217 spams a user, crosses a tenant, or silently never runs.

## 70. DEF-219 — one field name killed three consecutive fixes (2026-08-18, BUILDER: Claude — orchestrator iteration 11, branch `release/cmp-2026-08-16`)

### Observed behavior

Worst fixQueue entry in `iter-10-post-build.json`: **B04-outstanding-question-ignored C6 70**, C3 85. The reply is the exact string DEF-212 was written to eliminate:

    Updated "Define rules for Brain's responsiveness to new vs. existing contacts": priority=high.

> "The response only addresses the 'priority' part of Brain's previous question, leaving the 'deadline' outstanding without mentioning that it's still needed."

### Root cause

The composer's history turn is `ComposerHistoryTurn = { role: 'user' | 'brain' | 'artifact'; text: string }`. `lastBrainQuestion` read `t.content` — **undefined on every real call**. `String(undefined)` became the string `"undefined"`, `isQuestionTurn` said no, and the function returned **null in production, always**.

Downstream, mechanically: `requestedSlots(null)` → `[]` → `outstandingSlots` → `[]`; DEF-209's proceeding marker names no slot; **DEF-212's applied marker takes its no-slots branch, which returns the receipt verbatim**; DEF-215's "ASK FOR IT IN THIS REPLY" can never fire. **Three consecutive DEFs were dead on arrival on one key**, and I spent those turns rewording a fact that was never computed.

**Why the tests missed it, which matters more than the typo:** every fixture in def209, def211 and def215 was a hand-built `{ role, content }` object. A fixture I invent cannot disagree with me.

### Files changed

- `server/src/services/knowledge/actionReceipt.ts` — `lastBrainQuestion` reads `text ?? content` and is typed (`HistoryTurnLike`), so a reader that understands only one shape cannot be written silently. Both keys are accepted because other producers hold either, and a reader that knew only one is how this happened.
- `server/tests/def219HistoryFieldName.test.ts` — 7 tests that import the composer's **real exported `ComposerHistoryTurn`**, so a future rename breaks the build rather than the behaviour. One test pins the old behaviour explicitly: with `content` undefined, every downstream value is empty and the applied marker returns the receipt verbatim — the regression captured as a fact.

### Rollback considered and rejected

Reverting restores a reader that returns null on every real call.

### Tests added / verification (measured after the last code edit)

`npx tsc --noEmit` clean, exit 0 · `npx vitest run`: 214 files — 213 passed, 1 skipped; 2,697 tests — **2,668 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo · `npm run build` **OK** in a clean clone (the `content`-only read confirmed gone from the emitted code) · `git diff --check` clean.

**Four mutants applied and RUN, all four die:** back to `content`-only (the shipped defect) · `text`-only, dropping other producers · an absent field becomes `'undefined'` again · stops walking back past the user turn.

### Known issues deliberately not fixed

**DEF-212's no-slots branch still renders the bare receipt** when nothing genuinely is outstanding — that path goes from universal to rare, but it is the same field-name English. Fixing it needs the marker to carry applied fields as data rather than as a rendered string; named rather than half-done here.

**The escalation is answered (a): accept as a known limitation with a DEF row, do NOT revert.** Every numbered risk from iteration 4 is closed with commits and `review_log.md` is unchanged at 692 lines — the standing verdict predates all seven of them.

**No C-3 progress** (the continuation forbade it), and the other fixQueue entries are C4 register, which the brief forbids chasing.

**CAPABILITY: Accurate Communication · PREDICTED: +2 to +4 · MECHANISM:** the outstanding-slot computation now receives Brain's actual last question instead of `null` on every turn — three existing mechanisms becoming reachable, not a new one. **FALSIFIER:** B04 C6/C3 do not recover, or a dispatch reply still arrives as `Updated "…": field=value.` — either would mean the causal chain above is wrong.
