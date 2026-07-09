# Brain Capability Matrix (Spec F1)

**Generated:** 2026-07-08 · branch `feat/nexeo-one-brain`
**Principle:** the action registry (`src/services/actions/handlers/`) is the brain's capability ceiling — anything not registered is something the brain silently "can't do". Capability parity (Directive 4) means every verb the user has on a connected account should exist here as a registered, confirm()-backed action, gated only by autonomy level (D1) and safety.

**Cell legend**
- `REG` — registered ActionHandler, real execute(), real/receipt confirm()
- `DIRECT` — capability exists in a service/adapter but is NOT a registered action (the brain's menu can't reach it) → gap
- `STUB` — handler registered but execute() fabricates receipts; fails closed at confirm() since B2 → gap
- `—` — no code path

| Connector | Read/Ingest | Draft | Send/Write | Modify | Delete | Schedule |
|-----------|-------------|-------|-----------|--------|--------|----------|
| Gmail | REG | — | REG (send, reply², forward²) | — | — | — |
| Google Calendar | REG | — | REG (create, cancel¹, propose_times²) | REG² (reschedule, add_attendee) | REG¹ | — |
| Google Tasks | REG | — | REG (create³, subtask³) | REG³ (complete) | — | — |
| Google Chat | REG | — | REG | — | — | — |
| Slack | REG | — | REG | — | — | — |
| Microsoft Teams | REG | — | — | — | — | — |
| Outlook | REG | — | REG (via Gmail fallback) | — | — | — |
| IMAP/SMTP | REG | — | DIRECT (unregistered) | — | — | — |
| WhatsApp | REG | — | REG | — | — | — |
| Google Drive | DIRECT | — | DIRECT | — | DIRECT | — |
| OneDrive | REG | — | — | — | — | — |
| Notion | DIRECT | — | REG (thought sync) | DIRECT (upsert) | — | — |
| Odoo CRM | REG | — | REG (lead, opportunity) | REG | — | — |

³ Filled 2026-07-09 (backlog top item): `create_task` (real `googleTasksService.createTask` + `getTask` read-back confirm; default-list fallback when no `taskListId` supplied), `complete_task` (real `markTaskDone` + `findTaskById` cross-list lookup + idempotent on already-completed + `getTask` status-verifying confirm), `add_subtask` (real `createSubtask` with `parent` field + `findTaskById` for parent list + `getTask` parent-linkage-verifying confirm). `reassign_task` intentionally fails closed with an honest limitation message: Google Tasks API has no cross-user owner field, and cross-user delegation belongs to `delegate_open_item`. Coverage: `tests/taskHandlers.test.ts` (24 tests).
² Filled 2026-07-09 (F1 gap-fill): `send_email_reply` (RFC-threaded via feed_events + getEmailHeadersForReply), `forward_email` (full-original quote, per-recipient), `reschedule_event` (real updateEvent + previousStart capture for undo), `add_attendee` (read-modify-write, idempotent), `propose_times` (real free/busy from getEvents). All with provider read-back confirms.
¹ `cancel_event` was a stub in the original audit; its execute() was made real (calendarService.deleteEvent + absence-verifying confirm) on 2026-07-08 when B5 routed voice cancel_meeting through it.

## Ranked gaps (by EA-product centrality)

1. ~~Google Tasks closure~~ — **FILLED 2026-07-09** (see ³ above). `create_task`, `complete_task`, `add_subtask` are real; `reassign_task` fail-closes honestly.
2. ~~Email reply & forward~~ — **FILLED 2026-07-09** (see ² above).
3. ~~Calendar reschedule & add-attendee & propose-times~~ — **FILLED 2026-07-09** (see ² above).
4. **Teams outbound (MEDIUM)** — read-only channel; no `send_teams_message` handler.
5. **IMAP/SMTP send registration (MEDIUM)** — `imapSmtpService.sendEmail` real but unregistered; non-Gmail tenants can't send brain-composed mail via the registry.
6. **Drive/OneDrive file ops (MEDIUM)** — upload/delete exist as services, unreachable from the action menu.
7. **Gmail mark-as-read (LOW-MED)** — `gmailService.markAsRead` unregistered; blocks inbox-state automation.
8. **Cross-user task delegation via Google Tasks (INFO)** — genuinely unavailable at the provider level (no owner field on the Tasks API). `reassign_task` fail-closes with a pointer to `delegate_open_item`. If a real cross-user task ownership model becomes needed, the correct path is a local mirror table, NOT a fabricated Google Tasks receipt.

## Guard rails already locked

- `tests/registryCoreVerbs.test.ts` — the core verb set can't silently drop out of the registry.
- `tests/confirmInvariant.test.ts` — every registered handler owns a confirm(); no default-true confirmation (B2).
- All stubs fail closed at confirm() — they can never claim `done`. Filling a gap means: real execute() + real read-back confirm() + this doc updated.
