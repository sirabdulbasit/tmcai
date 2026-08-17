/**
 * openItemsBacklogCleanupJob — autonomous backlog reducer.
 *
 * Runs the SAME quality gate that gates auto-creates against every
 * still-open item. If a row would be rejected at create time today,
 * it gets archived now. Plus the stale sweep:
 *   - Items past the user's stale window, never delegated, never replied,
 *     non-critical → QUARANTINED first (proactive messages suppressed), then
 *     soft-closed as "stale_no_engagement" after the grace period — the same
 *     reversible lifecycle as malformed residue, decided by the ONE policy in
 *     `zombieItemPolicy` (DEF-186). `staleThresholdDays = 0` is the owner's
 *     DISABLE and passes through unchanged (DEF-187); an UNREADABLE setting
 *     (the read threw — `getOpenItemsSettings` no longer converts errors to
 *     defaults, DEF-189) passes `undefined`, under which the policy neither
 *     detects staleness nor releases an existing quarantine.
 *   - Exact duplicates of (sourceFeed, sourceRef) within the same tenant+user
 *     → kept the oldest, archive the rest as "duplicate_collapsed".
 *
 * Critical-priority items are NEVER touched by this job — even if the
 * gate would reject them today, they may have been rated critical for
 * a reason the gate doesn't see (e.g. a delegation was already assigned).
 *
 * ── TENANT BOUNDARY (DEF-188/DEF-189) ───────────────────────────────────────
 * The entry point takes the tenant: `runOpenItemsBacklogCleanup(clientNumber)`.
 * EVERY openItem query in this file carries that clientNumber in `where` —
 * including both enumerations, which Codex's iteration-2 CRITICAL found
 * global. Cross-tenant enumeration happens exactly once, in
 * `runOpenItemsBacklogCleanupForAllTenants`, and it reads the TENANT REGISTRY
 * (distinct clientNumber over active users — the same sanctioned enumeration
 * `runContactPruneForAllTenants` uses), never tenant data.
 *
 * ── COMPARE-AND-SET (DEF-189, Codex iteration-2 HIGH) ───────────────────────
 * Every mutation goes through `guardedItemUpdate`, whose predicate carries
 * the EXPECTED state read by the planner — status plus the `@updatedAt`
 * version token for lifecycle writes, status for post-archive notice writes.
 * A row the user touched between read and write no longer matches: count 0,
 * no cancellation, no stat, no debt — the `raced` counter records that the
 * guard fired. id+tenant+user alone was a scope, not a compare-and-set.
 *
 * ── TRUTHFULNESS (DEF-187) ──────────────────────────────────────────────────
 * Nothing is counted, and nothing is announced, that the database did not
 * confirm. A failed or zero-row write is an error (or a raced guard), never
 * a withdrawal.
 *
 * ── THE NOTICE IS DURABLE AND ITS IDENTITY IS STABLE (DEF-187/DEF-189) ──────
 * The archiving write records `selfPruneNotice.owed = true` in the same row
 * write. The dispatcher then works in BATCHES with persistent identity:
 * unannounced rows are STAMPED with a `batchId` (a confirmed write) BEFORE
 * anything is enqueued; the dedupKey is derived from the batchId, so a retry
 * after ANY partial failure carries the same identity whatever subset of rows
 * still owes. Before enqueueing, the dispatcher asks the queue whether a
 * prompt with this batch identity already exists IN ANY STATE — if it does,
 * the notice was accepted once, and the debt is cleared without a second
 * owner-visible message. That is what closes Codex's duplicate-notice case:
 * A+B announced, B's mark fails, next tick retries {B} under the ORIGINAL
 * batch identity and finds the existing prompt instead of re-sending.
 * Announcement is only ever attempted for rows still CANCELLED — a restored
 * row keeps its inert flag but can never be announced as withdrawn.
 *
 * Idempotent. Safe to run repeatedly.
 */
import { createHash, randomUUID } from 'crypto';
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { planZombieLifecycle } from '../services/openItems/zombieItemPolicy';

const log = createLogger('open-items-backlog-cleanup');

const HARD_LIMIT_PER_RUN = 500;          // per (tenant, user) partition
const OWED_ROWS_PER_NOTICE = 200;        // dispatcher depth per batch per tick

const CANDIDATE_WHERE = {
  status: { in: ['NEW', 'TRIAGED', 'open'] as any },
  priority: { not: 'critical' },
};

/**
 * Rows whose archive write recorded an owed, not-yet-announced notice.
 * `status: 'CANCELLED'` is part of the identity: a row someone restored
 * (CANCELLED -> TRIAGED) drops out of this set, so a restored item can never
 * be announced as withdrawn — its leftover flag is inert.
 */
const OWED_WHERE = {
  status: 'CANCELLED',
  metadata: { path: ['selfPruneNotice', 'owed'], equals: true },
} as const;

interface CleanupStats {
  scanned: number;
  archivedByGate: number;
  archivedStale: number;
  archivedDuplicate: number;
  archivedSmoke: number;
  quarantinedZombie: number;
  quarantinedStale: number;
  archivedZombie: number;
  recoveredZombie: number;
  noticesEnqueued: number;
  /** Compare-and-set guards that fired: the row changed between read and write. */
  raced: number;
  errors: number;
}

function emptyStats(): CleanupStats {
  return {
    scanned: 0, archivedByGate: 0, archivedStale: 0, archivedDuplicate: 0, archivedSmoke: 0,
    quarantinedZombie: 0, quarantinedStale: 0, archivedZombie: 0, recoveredZombie: 0,
    noticesEnqueued: 0, raced: 0, errors: 0,
  };
}

function normalizeTitle(s: string): string {
  return s.toLowerCase()
    .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/g, '')
    .replace(/\(#\d+\)/g, '')
    .replace(/[\d/.\-]+/g, ' ')      // numbers, dates, ticket refs
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * DEF-187/188/189 — the ONE mutation path this job has. Tenant + user + id
 * SCOPE the write; `expected` is the COMPARE-AND-SET: the status (and, for
 * lifecycle writes, the `@updatedAt` version token) the planner read. A row
 * that changed since the read matches nothing — count 0 — and the caller
 * must treat the action as not having happened.
 */
async function guardedItemUpdate(
  target: { id: string; userId: number; clientNumber: string },
  expected: { status: string; updatedAt?: Date | string },
  data: Record<string, unknown>,
): Promise<boolean> {
  const res = await prisma.openItem.updateMany({
    where: {
      id: target.id,
      clientNumber: target.clientNumber,
      userId: target.userId,
      status: expected.status as any,
      ...(expected.updatedAt !== undefined ? { updatedAt: expected.updatedAt as any } : {}),
    },
    data: data as any,
  });
  return res.count === 1;
}

/**
 * The ONLY cross-tenant read, and it reads the tenant REGISTRY (distinct
 * clientNumber over active users — the enumeration `runContactPruneForAllTenants`
 * already uses), never tenant data. Deterministic order.
 */
export async function runOpenItemsBacklogCleanupForAllTenants(): Promise<CleanupStats> {
  const total = emptyStats();
  const tenants = await prisma.user.findMany({
    where: { isActive: true },
    select: { clientNumber: true },
    distinct: ['clientNumber'],
    orderBy: { clientNumber: 'asc' },
  }).catch((err: any) => {
    total.errors++;
    log.warn('tenant registry read failed — nothing cleaned this tick', { err: err?.message });
    return [] as Array<{ clientNumber: string }>;
  });

  for (const t of tenants) {
    try {
      const s = await runOpenItemsBacklogCleanup(t.clientNumber);
      for (const k of Object.keys(total) as Array<keyof CleanupStats>) total[k] += s[k];
    } catch (err: any) {
      total.errors++;
      log.warn('tenant cleanup failed', { clientNumber: t.clientNumber, err: err?.message });
    }
  }
  return total;
}

/** Clean ONE tenant's backlog. Every query below carries this clientNumber. */
export async function runOpenItemsBacklogCleanup(clientNumber: string): Promise<CleanupStats> {
  const stats = emptyStats();

  const users = await prisma.openItem.findMany({
    where: { clientNumber, ...(CANDIDATE_WHERE as any) },
    select: { userId: true },
    distinct: ['userId'],
    orderBy: { userId: 'asc' },
  }).catch((err: any) => {
    stats.errors++;
    log.warn('candidate enumeration failed — nothing cleaned this tick', { clientNumber, err: err?.message });
    return [] as Array<{ userId: number }>;
  });

  for (const u of users) {
    try {
      await cleanupUserBacklog(clientNumber, u.userId, stats);
    } catch (err: any) {
      stats.errors++;
      log.warn('user cleanup pass failed', { clientNumber, userId: u.userId, err: err?.message });
    }
  }

  // The dispatcher runs every tick regardless of what this tick archived, so
  // a notice owed by a PREVIOUS failed tick is found and delivered.
  await dispatchOwedNotices(clientNumber, stats);

  if (stats.archivedByGate + stats.archivedStale + stats.archivedDuplicate + stats.archivedSmoke
      + stats.quarantinedZombie + stats.quarantinedStale + stats.archivedZombie
      + stats.recoveredZombie + stats.noticesEnqueued + stats.raced + stats.errors > 0) {
    log.info('cleanup tick', { clientNumber, ...stats });
  }
  return stats;
}

async function cleanupUserBacklog(
  clientNumber: string,
  userId: number,
  stats: CleanupStats,
): Promise<void> {
  const items = await prisma.openItem.findMany({
    where: { clientNumber, userId, ...(CANDIDATE_WHERE as any) },
    select: {
      id: true, title: true, description: true, status: true, dueDate: true, priority: true,
      delegateeId: true, delegateeName: true, delegateeEmail: true, notes: true,
      createdAt: true, updatedAt: true, sourceFeed: true, sourceRef: true,
      metadata: true, userId: true, clientNumber: true,
    },
    take: HARD_LIMIT_PER_RUN,
    orderBy: { createdAt: 'asc' }, // process oldest first
  });

  stats.scanned += items.length;
  if (items.length === 0) return;

  const { qualifyAutoOpenItem } = await import('../services/openItems/qualityGate');

  // The user's stale window, resolved ONCE for this partition, under this
  // tenant's authority. Zero passes through — it is the owner's disable
  // (DEF-187). An UNREADABLE setting throws out of `getOpenItemsSettings`
  // (DEF-189 — errors are no longer converted to defaults there) and becomes
  // `undefined` here, under which the policy holds: no new stale quarantine,
  // no release of an existing one, because this pass cannot judge either.
  let staleAfterDays: number | undefined;
  try {
    const { getOpenItemsSettings } = await import('../services/openItems/openItemsSettings');
    staleAfterDays = (await getOpenItemsSettings(userId, clientNumber)).staleThresholdDays;
  } catch {
    staleAfterDays = undefined;
  }

  // Duplicate-detection maps live INSIDE the partition, so a cross-tenant
  // collision is structurally impossible rather than filtered (DEF-188).
  const seenRefs = new Map<string, string>();
  const seenTitles = new Map<string, string>();

  for (const it of items) {
    try {
      const meta = (it.metadata as Record<string, unknown> | null) ?? {};
      // Every write below carries the state this loop READ (status +
      // updatedAt) as its compare-and-set predicate — a row the user touched
      // after the read matches nothing and is left alone (DEF-189).
      const expected = { status: it.status as string, updatedAt: it.updatedAt as Date };

      // Quarantine junk (malformed OR stale-with-no-engagement) before any
      // cleanup or follow-up path can act on it. Soft, auditable, no delete.
      const prunePlan = planZombieLifecycle(it, new Date(), undefined, { staleAfterDays });
      if (prunePlan.action === 'quarantine') {
        if (!(await guardedItemUpdate(it, expected, {
          metadata: { ...meta, selfPrune: prunePlan.selfPrune } as any,
        }))) { stats.raced++; continue; }
        if (prunePlan.reason === 'stale_no_engagement') stats.quarantinedStale++;
        else stats.quarantinedZombie++;
        continue;
      }
      if (prunePlan.action === 'hold') continue;
      if (prunePlan.action === 'archive') {
        const archivedAt = new Date().toISOString();
        const stale = prunePlan.reason === 'stale_no_engagement';
        const archivedReason = stale ? 'stale_no_engagement' : `zombie:${prunePlan.reason}`;
        const ok = await guardedItemUpdate(it, expected, {
          // DEF-129 — every prune in this job records CANCELLED: a zombie, a
          // smoke leftover, a gate rejection and a collapsed duplicate were
          // never work that got completed, and CANCELLED is in the matrix so
          // the row stays movable (CANCELLED -> TRIAGED is the restore).
          status: 'CANCELLED' as any,
          metadata: {
            ...meta,
            selfPrune: prunePlan.selfPrune,
            archivedReason,
            archivedAt,
            inactivationReason: `Self-pruned after quarantine (${prunePlan.reason})`,
            // The owed notice is written IN the archiving write (DEF-187):
            // the row either carries its announcement debt or was not archived.
            selfPruneNotice: { owed: true, reason: archivedReason, recordedAt: archivedAt },
          } as any,
        });
        if (!ok) { stats.raced++; continue; }
        if (stale) stats.archivedStale++;
        else stats.archivedZombie++;
        continue;
      }
      if (prunePlan.action === 'recover') {
        if (!(await guardedItemUpdate(it, expected, {
          metadata: { ...meta, selfPrune: prunePlan.selfPrune } as any,
        }))) { stats.raced++; continue; }
        stats.recoveredZombie++;
      }

      // 1a. Smoke leftovers — anything tagged [smoke] is dev residue. No
      // quarantine: the tag is its own evidence, and the archive is still
      // reversible + announced. (Same rationale for 1b and the duplicate
      // collapses: quarantine exists for FALLIBLE classifications; a smoke
      // tag, a hard gate code and an exact duplicate carry their evidence.)
      if (/^\s*\[smoke\]/i.test(it.title)) {
        const archivedAt = new Date().toISOString();
        if (!(await guardedItemUpdate(it, expected, {
          status: 'CANCELLED' as any,
          metadata: {
            ...(meta as any), archivedReason: 'smoke_leftover', archivedAt,
            selfPruneNotice: { owed: true, reason: 'smoke_leftover', recordedAt: archivedAt },
          } as any,
        }))) { stats.raced++; continue; }
        stats.archivedSmoke++;
        continue;
      }

      // 1b. Quality gate retroactively. Run the gate using ONLY signals
      // we have on the row (title, body, due date, sender). Don't gate
      // on metadata.classificationPass — legacy rows lack it. The gate's
      // keyword/pattern checks (vendor bulletin, password notification,
      // dashboard nag, automated sender) work on title alone.
      const verdict = qualifyAutoOpenItem({
        title: it.title,
        body: it.description ?? '',
        dueDate: it.dueDate ?? null,
        archetype: typeof meta.archetype === 'string' ? (meta.archetype as string) : null,
        intent: typeof meta.pass2Intent === 'string' ? (meta.pass2Intent as string) : null,
        // Don't pass confidence — legacy rows lack it; using a default
        // would falsely fail the low-confidence check.
        senderEmail: typeof meta.senderEmail === 'string' ? (meta.senderEmail as string) : null,
      });
      // Only the patterns where we're CONFIDENT the row is junk:
      // vendor bulletins, notifications, dashboard nags, automated
      // senders, newsletters, smoke. We do NOT archive on `no_signal`
      // because legacy rows often have no archetype/verbs in title
      // even when they're real.
      const HARD_GATE_CODES = new Set(['vendor_bulletin', 'notification_only', 'dashboard_nag', 'automated_sender', 'newsletter']);
      if (verdict.verdict === 'reject' && HARD_GATE_CODES.has(verdict.code)) {
        const archivedAt = new Date().toISOString();
        if (!(await guardedItemUpdate(it, expected, {
          status: 'CANCELLED' as any,
          metadata: {
            ...(meta as any), archivedReason: `gate:${verdict.code}`, archivedAt,
            selfPruneNotice: { owed: true, reason: `gate:${verdict.code}`, recordedAt: archivedAt },
          } as any,
        }))) { stats.raced++; continue; }
        stats.archivedByGate++;
        continue;
      }

      // 1d. Exact duplicates by (sourceFeed, sourceRef) — per partition, so
      // per tenant+user by construction.
      if (it.sourceRef && it.sourceFeed) {
        const key = `${it.sourceFeed}|${it.sourceRef}`;
        const keeper = seenRefs.get(key);
        if (keeper) {
          const archivedAt = new Date().toISOString();
          if (!(await guardedItemUpdate(it, expected, {
            status: 'CANCELLED' as any,
            metadata: {
              ...(meta as any), archivedReason: 'duplicate_collapsed', duplicateOf: keeper, archivedAt,
              selfPruneNotice: { owed: true, reason: 'duplicate_collapsed', recordedAt: archivedAt },
            } as any,
          }))) { stats.raced++; continue; }
          stats.archivedDuplicate++;
          continue;
        }
        seenRefs.set(key, it.id);
      }

      // 1e. Title-based dedup — catches recurring meetings and recurring
      // automation reports where each weekly fire is a fresh row with no
      // sourceRef. Keep the first (oldest) as keeper, archive duplicates.
      const titleKey = normalizeTitle(it.title);
      if (titleKey.length > 4) {
        const keeper = seenTitles.get(titleKey);
        if (keeper) {
          const archivedAt = new Date().toISOString();
          if (!(await guardedItemUpdate(it, expected, {
            status: 'CANCELLED' as any,
            metadata: {
              ...(meta as any), archivedReason: 'duplicate_title', duplicateOf: keeper, archivedAt,
              selfPruneNotice: { owed: true, reason: 'duplicate_title', recordedAt: archivedAt },
            } as any,
          }))) { stats.raced++; continue; }
          stats.archivedDuplicate++;
          continue;
        }
        seenTitles.set(titleKey, it.id);
      }
    } catch (err: any) {
      stats.errors++;
      log.warn('item cleanup error', { itemId: it.id, err: err.message });
    }
  }
}

/**
 * DEF-187/189 — announce every owed withdrawal, one notice per batch per
 * (tenant, user), and clear the debt only when the queue is KNOWN to hold the
 * batch's identity. Deterministic order (userId asc, oldest rows first), no
 * unordered cap over owners — within a tenant every owed user is attempted
 * every tick, and one owner's failure never blocks the next (Codex
 * iteration-2 MEDIUM 5).
 */
async function dispatchOwedNotices(clientNumber: string, stats: CleanupStats): Promise<void> {
  const owedUsers = await prisma.openItem.findMany({
    where: { clientNumber, ...(OWED_WHERE as any) },
    select: { userId: true },
    distinct: ['userId'],
    orderBy: { userId: 'asc' },
  }).catch((err: any) => {
    stats.errors++;
    log.warn('owed-notice enumeration failed — owed state keeps until the next tick', { clientNumber, err: err?.message });
    return [] as Array<{ userId: number }>;
  });

  for (const u of owedUsers) {
    try {
      await announceOwedForUser(clientNumber, u.userId, stats);
    } catch (err: any) {
      stats.errors++;
      log.warn('withdrawal notice pass failed — owed state kept for retry', {
        clientNumber, userId: u.userId, err: err?.message,
      });
    }
  }
}

async function announceOwedForUser(
  clientNumber: string,
  userId: number,
  stats: CleanupStats,
): Promise<void> {
  const rows = await prisma.openItem.findMany({
    where: { clientNumber, userId, ...(OWED_WHERE as any) },
    select: { id: true, title: true, metadata: true, updatedAt: true },
    orderBy: { createdAt: 'asc' },
    take: OWED_ROWS_PER_NOTICE,
  });
  if (rows.length === 0) return;
  if (rows.length === OWED_ROWS_PER_NOTICE) {
    log.warn('owed-notice batch at cap — remainder rides the next tick', {
      clientNumber, userId, cap: OWED_ROWS_PER_NOTICE,
    });
  }

  // Group by persistent batch identity. Rows stamped by an earlier tick keep
  // their batch — a retry after ANY partial failure reuses the original
  // identity, whatever subset still owes (Codex iteration-2 HIGH 3). Rows
  // never stamped form one new batch.
  const byBatch = new Map<string, typeof rows>();
  const unstamped: typeof rows = [];
  for (const row of rows) {
    const batchId = (row.metadata as any)?.selfPruneNotice?.batchId;
    if (typeof batchId === 'string' && batchId.length > 0) {
      const g = byBatch.get(batchId) ?? [];
      g.push(row);
      byBatch.set(batchId, g);
    } else {
      unstamped.push(row);
    }
  }

  for (const [batchId, batchRows] of byBatch) {
    await settleBatch(clientNumber, userId, batchId, batchRows, stats);
  }

  if (unstamped.length > 0) {
    // Persist the identity BEFORE anything is enqueued. A row whose stamp
    // write fails (or races a restore) simply stays owed-unstamped and forms
    // a batch on a later tick — nothing is announced without a durable
    // identity behind it.
    const batchId = randomUUID();
    const stamped: typeof rows = [];
    for (const row of unstamped) {
      const meta = (row.metadata as Record<string, unknown> | null) ?? {};
      const notice = (meta.selfPruneNotice as Record<string, unknown> | null) ?? {};
      const newMeta = { ...meta, selfPruneNotice: { ...notice, batchId } };
      const ok = await guardedItemUpdate(
        { id: row.id, userId, clientNumber },
        { status: 'CANCELLED', updatedAt: row.updatedAt as Date },
        { metadata: newMeta as any },
      ).catch(() => false);
      if (ok) stamped.push({ ...row, metadata: newMeta as any });
      else stats.raced++;
    }
    if (stamped.length > 0) {
      await settleBatch(clientNumber, userId, batchId, stamped, stats);
    }
  }
}

/**
 * Deliver one batch: enqueue unless the queue already holds this batch's
 * identity in ANY state (then the notice was accepted once — clear the debt
 * with no second owner-visible message), and mark each row's debt cleared.
 * Marks are guarded on `status: 'CANCELLED'`: a concurrently restored row is
 * neither markable nor announceable.
 */
async function settleBatch(
  clientNumber: string,
  userId: number,
  batchId: string,
  rows: Array<{ id: string; title: string; metadata: unknown; updatedAt: Date | unknown }>,
  stats: CleanupStats,
): Promise<void> {
  const dedupKey = `selfpruning_withdrawn:${createHash('sha256').update(batchId).digest('hex').slice(0, 16)}`;

  const existing = await prisma.brainPromptQueue.findFirst({
    where: { clientNumber, userId, dedupKey },
    select: { id: true },
  });

  if (!existing) {
    const { enqueueBrainPrompt } = await import('../services/brainPrompts/brainPromptQueueService');
    const { renderSelfPruneNotice } = await import('../services/notifications/proactiveMessageText');
    await enqueueBrainPrompt({
      userId,
      clientNumber,
      question: renderSelfPruneNotice({
        count: rows.length,
        titles: rows.slice(0, 3).map((r) => r.title),
      }),
      criticality: 'routine',
      expectsReply: false,          // a notice never holds the conversation lock (DEF-063)
      provenance: 'system_marker',
      dedupKey,
      metadata: {
        source: 'open_items_backlog_cleanup',
        selfPruneNotice: { batchId, itemIds: rows.map((r) => r.id).sort(), count: rows.length },
      },
    });
    stats.noticesEnqueued++;
  }

  const enqueuedAt = new Date().toISOString();
  for (const row of rows) {
    const meta = (row.metadata as Record<string, unknown> | null) ?? {};
    const notice = (meta.selfPruneNotice as Record<string, unknown> | null) ?? {};
    const ok = await guardedItemUpdate(
      { id: row.id, userId, clientNumber },
      { status: 'CANCELLED' },
      {
        metadata: {
          ...meta,
          selfPruneNotice: { ...notice, batchId, owed: false, enqueuedAt },
        } as any,
      },
    ).catch(() => false);
    if (!ok) {
      stats.errors++;
      log.warn('owed-notice mark failed — the batch identity persists, the retry cannot re-send', {
        itemId: row.id, clientNumber, userId, batchId,
      });
    }
  }
}
