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
 *     DISABLE and passes through unchanged (DEF-187, Codex iteration-1 HIGH:
 *     the old mapping of 0 → 30 quarantined items against his explicit
 *     preference); a settings read failure passes `undefined`, under which the
 *     policy neither detects staleness nor releases an existing quarantine.
 *   - Exact duplicates of (sourceFeed, sourceRef) within the same tenant+user
 *     → kept the oldest, archive the rest as "duplicate_collapsed".
 *
 * Critical-priority items are NEVER touched by this job — even if the
 * gate would reject them today, they may have been rated critical for
 * a reason the gate doesn't see (e.g. a delegation was already assigned).
 *
 * ── TENANT BOUNDARY (DEF-188, Codex iteration-1 carried CRITICAL) ───────────
 * Selection is PARTITIONED: distinct (clientNumber, userId) pairs first, then
 * each pair processed under its own tenant — settings, dedup maps and the
 * quality gate can never mix tenants because they exist per partition. Every
 * mutation goes through `guardedItemUpdate`: an `updateMany` constrained by
 * (id, clientNumber, userId) whose affected-row count IS the result — the
 * DEF-178 compare-and-set shape.
 *
 * ── TRUTHFULNESS (DEF-187, Codex iteration-1 CRITICAL) ──────────────────────
 * Nothing is counted, and nothing is announced, that the database did not
 * confirm. The former `.catch(() => {})` on archive writes converted failure
 * into success and could tell the owner an item "withdrew" while it stayed
 * active — the fabricated-status shape. A failed or zero-row write now counts
 * as an error and nothing else.
 *
 * ── THE NOTICE IS DURABLE (DEF-187, Codex iteration-1 HIGH) ─────────────────
 * The same confirmed write that archives a row records `selfPruneNotice.owed
 * = true` in its metadata — one atomic row write, so an archived item either
 * carries its debt or was never archived. A dispatcher pass then announces
 * owed rows per (tenant, user) and marks them `owed = false` only after the
 * queue accepted the notice. A transient enqueue failure leaves `owed = true`
 * discoverable on the next tick — the notice can arrive late, but it can no
 * longer be lost. If the mark write fails AFTER a successful enqueue the row
 * is re-announced next tick with the same id-hash dedupKey, which the queue
 * collapses while the prior prompt is live ('duplicate' → mark retried);
 * at-least-once is the honest floor, and the directive's transient-failure
 * case is exactly-once.
 *
 * Idempotent. Safe to run repeatedly.
 */
import { createHash } from 'crypto';
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { planZombieLifecycle } from '../services/openItems/zombieItemPolicy';

const log = createLogger('open-items-backlog-cleanup');

const HARD_LIMIT_PER_RUN = 500;          // per (tenant, user) partition
const OWED_PAIRS_PER_RUN = 100;          // dispatcher breadth per tick
const OWED_ROWS_PER_NOTICE = 200;        // dispatcher depth per pair per tick

const CANDIDATE_WHERE = {
  status: { in: ['NEW', 'TRIAGED', 'open'] as any },
  priority: { not: 'critical' },
};

/** Rows whose archive write recorded an owed, not-yet-announced notice. */
const OWED_WHERE = {
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
  errors: number;
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
 * DEF-187/DEF-188 — the ONE mutation path this job has. Tenant + user + id
 * constrained, and the affected-row count IS the verdict: `false` means the
 * row was not ours to change (moved, deleted, foreign) and the caller must
 * treat the action as NOT having happened — no stat, no withdrawal record,
 * no owner fact.
 */
async function guardedItemUpdate(
  target: { id: string; userId: number; clientNumber: string },
  data: Record<string, unknown>,
): Promise<boolean> {
  const res = await prisma.openItem.updateMany({
    where: { id: target.id, clientNumber: target.clientNumber, userId: target.userId },
    data: data as any,
  });
  return res.count === 1;
}

export async function runOpenItemsBacklogCleanup(): Promise<CleanupStats> {
  const stats: CleanupStats = {
    scanned: 0, archivedByGate: 0, archivedStale: 0, archivedDuplicate: 0, archivedSmoke: 0,
    quarantinedZombie: 0, quarantinedStale: 0, archivedZombie: 0, recoveredZombie: 0,
    noticesEnqueued: 0, errors: 0,
  };

  // DEF-188 — enumerate tenants, then work strictly inside each one.
  const pairs = await prisma.openItem.findMany({
    where: CANDIDATE_WHERE as any,
    select: { clientNumber: true, userId: true },
    distinct: ['clientNumber', 'userId'],
  }).catch((err: any) => {
    stats.errors++;
    log.warn('candidate enumeration failed — nothing cleaned this tick', { err: err?.message });
    return [] as Array<{ clientNumber: string; userId: number }>;
  });

  for (const pair of pairs) {
    try {
      await cleanupTenantBacklog(pair.clientNumber, pair.userId, stats);
    } catch (err: any) {
      stats.errors++;
      log.warn('tenant cleanup pass failed', {
        clientNumber: pair.clientNumber, userId: pair.userId, err: err?.message,
      });
    }
  }

  // The dispatcher runs every tick regardless of what this tick archived, so
  // a notice owed by a PREVIOUS failed tick is found and delivered.
  await dispatchOwedNotices(stats);

  if (stats.archivedByGate + stats.archivedStale + stats.archivedDuplicate + stats.archivedSmoke
      + stats.quarantinedZombie + stats.quarantinedStale + stats.archivedZombie
      + stats.recoveredZombie + stats.noticesEnqueued + stats.errors > 0) {
    log.info('cleanup tick', { ...stats });
  }
  return stats;
}

async function cleanupTenantBacklog(
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
  // (DEF-187). If the setting cannot be read, `undefined` makes the policy
  // hold: no new stale quarantine, and no release of an existing one, because
  // this pass cannot judge either.
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

      // Quarantine junk (malformed OR stale-with-no-engagement) before any
      // cleanup or follow-up path can act on it. Soft, auditable, no delete.
      const prunePlan = planZombieLifecycle(it, new Date(), undefined, { staleAfterDays });
      if (prunePlan.action === 'quarantine') {
        if (!(await guardedItemUpdate(it, {
          metadata: { ...meta, selfPrune: prunePlan.selfPrune } as any,
        }))) { stats.errors++; continue; }
        if (prunePlan.reason === 'stale_no_engagement') stats.quarantinedStale++;
        else stats.quarantinedZombie++;
        continue;
      }
      if (prunePlan.action === 'hold') continue;
      if (prunePlan.action === 'archive') {
        const archivedAt = new Date().toISOString();
        const stale = prunePlan.reason === 'stale_no_engagement';
        const archivedReason = stale ? 'stale_no_engagement' : `zombie:${prunePlan.reason}`;
        const ok = await guardedItemUpdate(it, {
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
        if (!ok) { stats.errors++; continue; }
        if (stale) stats.archivedStale++;
        else stats.archivedZombie++;
        continue;
      }
      if (prunePlan.action === 'recover') {
        if (!(await guardedItemUpdate(it, {
          metadata: { ...meta, selfPrune: prunePlan.selfPrune } as any,
        }))) { stats.errors++; continue; }
        stats.recoveredZombie++;
      }

      // 1a. Smoke leftovers — anything tagged [smoke] is dev residue. No
      // quarantine: the tag is its own evidence, and the archive is still
      // reversible + announced. (Same rationale for 1b and the duplicate
      // collapses: quarantine exists for FALLIBLE classifications; a smoke
      // tag, a hard gate code and an exact duplicate carry their evidence.)
      if (/^\s*\[smoke\]/i.test(it.title)) {
        const archivedAt = new Date().toISOString();
        if (!(await guardedItemUpdate(it, {
          status: 'CANCELLED' as any,
          metadata: {
            ...(meta as any), archivedReason: 'smoke_leftover', archivedAt,
            selfPruneNotice: { owed: true, reason: 'smoke_leftover', recordedAt: archivedAt },
          } as any,
        }))) { stats.errors++; continue; }
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
        if (!(await guardedItemUpdate(it, {
          status: 'CANCELLED' as any,
          metadata: {
            ...(meta as any), archivedReason: `gate:${verdict.code}`, archivedAt,
            selfPruneNotice: { owed: true, reason: `gate:${verdict.code}`, recordedAt: archivedAt },
          } as any,
        }))) { stats.errors++; continue; }
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
          if (!(await guardedItemUpdate(it, {
            status: 'CANCELLED' as any,
            metadata: {
              ...(meta as any), archivedReason: 'duplicate_collapsed', duplicateOf: keeper, archivedAt,
              selfPruneNotice: { owed: true, reason: 'duplicate_collapsed', recordedAt: archivedAt },
            } as any,
          }))) { stats.errors++; continue; }
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
          if (!(await guardedItemUpdate(it, {
            status: 'CANCELLED' as any,
            metadata: {
              ...(meta as any), archivedReason: 'duplicate_title', duplicateOf: keeper, archivedAt,
              selfPruneNotice: { owed: true, reason: 'duplicate_title', recordedAt: archivedAt },
            } as any,
          }))) { stats.errors++; continue; }
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
 * DEF-187 — announce every owed withdrawal, one notice per (tenant, user),
 * and clear the debt only on queue acceptance. Runs every tick, so notices
 * owed by earlier failed ticks are found here even though their rows are
 * CANCELLED and gone from the cleanup candidate set.
 */
async function dispatchOwedNotices(stats: CleanupStats): Promise<void> {
  const owedPairs = await prisma.openItem.findMany({
    where: OWED_WHERE as any,
    select: { clientNumber: true, userId: true },
    distinct: ['clientNumber', 'userId'],
    take: OWED_PAIRS_PER_RUN,
  }).catch((err: any) => {
    stats.errors++;
    log.warn('owed-notice enumeration failed — owed state keeps until the next tick', { err: err?.message });
    return [] as Array<{ clientNumber: string; userId: number }>;
  });

  for (const pair of owedPairs) {
    try {
      const rows = await prisma.openItem.findMany({
        where: { clientNumber: pair.clientNumber, userId: pair.userId, ...(OWED_WHERE as any) },
        select: { id: true, title: true, metadata: true },
        orderBy: { createdAt: 'asc' },
        take: OWED_ROWS_PER_NOTICE,
      });
      if (rows.length === 0) continue;
      if (rows.length === OWED_ROWS_PER_NOTICE) {
        log.warn('owed-notice batch at cap — remainder rides the next tick', {
          clientNumber: pair.clientNumber, userId: pair.userId, cap: OWED_ROWS_PER_NOTICE,
        });
      }

      const { enqueueBrainPrompt } = await import('../services/brainPrompts/brainPromptQueueService');
      const { renderSelfPruneNotice } = await import('../services/notifications/proactiveMessageText');
      const ids = rows.map((r) => r.id).sort();
      const idHash = createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 16);
      const res = await enqueueBrainPrompt({
        userId: pair.userId,
        clientNumber: pair.clientNumber,
        question: renderSelfPruneNotice({
          count: rows.length,
          titles: rows.slice(0, 3).map((r) => r.title),
        }),
        criticality: 'routine',
        expectsReply: false,          // a notice never holds the conversation lock (DEF-063)
        provenance: 'system_marker',
        dedupKey: `selfpruning_withdrawn:${idHash}`,
        metadata: {
          source: 'open_items_backlog_cleanup',
          selfPruneNotice: { itemIds: ids, count: rows.length },
        },
      });
      // Any resolved result — including 'duplicate', which means the SAME
      // batch is already live in the queue from a tick whose mark failed —
      // is the queue holding the notice; the debt is cleared.
      stats.noticesEnqueued++;

      const enqueuedAt = new Date().toISOString();
      for (const row of rows) {
        const meta = (row.metadata as Record<string, unknown> | null) ?? {};
        const notice = (meta.selfPruneNotice as Record<string, unknown> | null) ?? {};
        const ok = await guardedItemUpdate(
          { id: row.id, userId: pair.userId, clientNumber: pair.clientNumber },
          {
            metadata: {
              ...meta,
              selfPruneNotice: {
                ...notice, owed: false, enqueuedAt,
                promptId: res.promptId ?? null, enqueueStatus: res.status,
              },
            } as any,
          },
        ).catch(() => false);
        if (!ok) {
          stats.errors++;
          log.warn('owed-notice mark failed — row will be re-announced (queue dedup absorbs the repeat)', {
            itemId: row.id, clientNumber: pair.clientNumber, userId: pair.userId,
          });
        }
      }
    } catch (err: any) {
      stats.errors++;
      log.warn('withdrawal notice enqueue failed — owed state kept for retry', {
        clientNumber: pair.clientNumber, userId: pair.userId, err: err?.message,
      });
    }
  }
}
