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
