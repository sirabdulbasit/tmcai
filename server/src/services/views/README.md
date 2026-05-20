# Canonical Views Layer

**One function per entity. One source of truth. Three surfaces.**

This directory holds the **canonical view functions** that every reader of
user-facing data MUST go through. Web UI API routes, Brain Chat composer,
WhatsApp inbound handler, Day Brief cron, jobs, scripts — all read the same
entities through the same functions.

The goal is structural: make it impossible for the web UI Action Center to
show one count, Brain Chat to show another, and WhatsApp to show a third for
the same user at the same moment. Without this layer, "one brain" is a
policy that breaks every time a developer writes a fresh `prisma.openItem.
findMany({...})` inline. With this layer, divergence requires explicit
deviation from the canonical function — which code review and tests can catch.

## The contract

| What the layer provides | What callers must do |
| --- | --- |
| One typed function per entity (`getOpenItems`, `getAttentionSurface`, `getTodayCalendar`, etc.) | Call the function. Pass user context. Receive typed rows. |
| Tight, predictable defaults (active items only, smoke-excluded, user-tz, etc.) | Override defaults only via explicit options |
| Stable return shapes — additions are non-breaking | Read the typed fields, not raw Prisma model fields |
| Multi-tenancy enforcement baked in (every function takes `{ clientNumber, userId }`) | Always pass both; never query cross-user |

## Files

- `openItems.ts` — `getOpenItems({ clientNumber, userId, opts })`. The
  Action Center, Brain composer snapshot, Day Brief Open Items section all
  call this. Wraps the lower-level `openItemsService.listItems`.

- `calendar.ts` — `getTodayCalendar({ clientNumber, userId, timezone })`.
  Returns today's events in the user's local timezone (Asia/Karachi default).
  Replaces the calendar block builder that previously rendered UTC, surfacing
  3 PM PKT meetings as "10:00".

- `attention.ts` — `getAttentionSurface({ clientNumber, userId, limit })`.
  Returns the same My Attention list the UI's `GET /api/brief/attention`
  returns. Routed through `briefPartitionService.computeBriefPartition` so
  the partition-vs-Brief race can't desync the two surfaces.

- `index.ts` — re-exports everything. Callers should import from
  `'services/views'`, never from individual files inside this directory.

## What's not here yet (planned)

- `connectors.ts` — `getConnectorHealth({ clientNumber, userId })`.
- `recentEmails.ts` — `getRecentEmails({ clientNumber, userId, limit, channel })`.
- `entityProfile.ts` — `getEntityProfile({ entityId })`.

Each is a similar one-function-one-entity wrapper. Add them as their
respective UI/Brain divergences come up.

## Rule of thumb (post-migration)

**The only place `prisma.*.findMany({...})` for a user-scoped entity is
allowed is inside this directory.** Everywhere else — routes, jobs,
composer, scripts — imports from `services/views` and works with the
typed rows. A future ESLint rule will enforce this.
