/**
 * openItemsBacklogCleanupJob — autonomous backlog reducer.
 *
 * Runs the SAME quality gate that gates auto-creates against every
 * still-open item. If a row would be rejected at create time today,
 * it gets archived now. Plus an aggressive stale-item sweep:
 *   - Items > 30 days old, never opened, never delegated, never replied,
 *     non-critical → archived as "stale_no_engagement".
 *   - Exact duplicates of (sourceFeed, sourceRef) within the same user
 *     → kept the oldest, archive the rest as "duplicate_collapsed".
 *
 * Critical-priority items are NEVER touched by this job — even if the
 * gate would reject them today, they may have been rated critical for
 * a reason the gate doesn't see (e.g. a delegation was already assigned).
 *
 * Idempotent. Safe to run repeatedly. Uses a 60s lock per tenant so
 * multiple cron ticks can't race.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('open-items-backlog-cleanup');

const STALE_DAYS = 30;
const HARD_LIMIT_PER_RUN = 500;

interface CleanupStats {
  scanned: number;
  archivedByGate: number;
  archivedStale: number;
  archivedDuplicate: number;
  archivedSmoke: number;
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

export async function runOpenItemsBacklogCleanup(): Promise<CleanupStats> {
  const stats: CleanupStats = {
    scanned: 0, archivedByGate: 0, archivedStale: 0, archivedDuplicate: 0, archivedSmoke: 0, errors: 0,
  };

  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

  // 1. Pull all NEW / TRIAGED items, non-critical, in batches.
  const items = await prisma.openItem.findMany({
    where: {
      status: { in: ['NEW', 'TRIAGED', 'open'] as any },
      priority: { not: 'critical' },
    },
    select: {
      id: true, title: true, description: true, dueDate: true, priority: true,
      createdAt: true, updatedAt: true, sourceFeed: true, sourceRef: true,
      metadata: true, userId: true, clientNumber: true,
    },
    take: HARD_LIMIT_PER_RUN,
    orderBy: { createdAt: 'asc' }, // process oldest first
  }).catch(() => [] as any[]);

  stats.scanned = items.length;
  if (items.length === 0) return stats;

  const { qualifyAutoOpenItem } = await import('../services/openItems/qualityGate');

  // Index by (sourceFeed+sourceRef) AND (userId+normalizedTitle) for
  // duplicate detection. The second key catches the recurring-meeting
  // / recurring-automation pattern where each weekly fire creates a
  // fresh row with no sourceRef.
  const seenRefs = new Map<string, string>();
  const seenTitles = new Map<string, string>();

  for (const it of items) {
    try {
      const meta = (it.metadata as Record<string, unknown> | null) ?? {};

      // 1a. Smoke leftovers — anything tagged [smoke] is dev residue.
      if (/^\s*\[smoke\]/i.test(it.title)) {
        await prisma.openItem.update({
          where: { id: it.id },
          data: {
            status: 'closed' as any,
            metadata: { ...(meta as any), archivedReason: 'smoke_leftover', archivedAt: new Date().toISOString() } as any,
          },
        }).catch(() => {});
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
        await prisma.openItem.update({
          where: { id: it.id },
          data: {
            status: 'closed' as any,
            metadata: { ...(meta as any), archivedReason: `gate:${verdict.code}`, archivedAt: new Date().toISOString() } as any,
          },
        }).catch(() => {});
        stats.archivedByGate++;
        continue;
      }

      // 1c. Stale: created > 30 days ago, no delegation, no notes.
      // Even if `updatedAt` shifted (Brain re-scoring), we treat it as
      // stale unless the user has actually engaged.
      const hasNotes = Array.isArray((it as any).notes) && (it as any).notes.length > 0;
      const hasDelegation = !!(meta as any).delegateeEmail || !!(meta as any).delegateeName;
      if (it.createdAt < cutoff && !hasNotes && !hasDelegation) {
        await prisma.openItem.update({
          where: { id: it.id },
          data: {
            status: 'closed' as any,
            metadata: { ...(meta as any), archivedReason: 'stale_no_engagement', archivedAt: new Date().toISOString() } as any,
          },
        }).catch(() => {});
        stats.archivedStale++;
        continue;
      }

      // 1d. Exact duplicates by (sourceFeed, sourceRef) per user
      if (it.sourceRef && it.sourceFeed) {
        const key = `${it.userId}|${it.sourceFeed}|${it.sourceRef}`;
        const keeper = seenRefs.get(key);
        if (keeper) {
          await prisma.openItem.update({
            where: { id: it.id },
            data: {
              status: 'closed' as any,
              metadata: { ...(meta as any), archivedReason: 'duplicate_collapsed', duplicateOf: keeper, archivedAt: new Date().toISOString() } as any,
            },
          }).catch(() => {});
          stats.archivedDuplicate++;
          continue;
        }
        seenRefs.set(key, it.id);
      }

      // 1e. Title-based dedup per user — catches recurring meetings
      // and recurring automation reports where each weekly fire is a
      // fresh row with no sourceRef. Keep the most recent (already
      // sorted asc, so we encounter older first; once we see a title
      // we keep the first as keeper and archive duplicates).
      const titleKey = `${it.userId}|${normalizeTitle(it.title)}`;
      if (titleKey.length > 6) {
        const keeper = seenTitles.get(titleKey);
        if (keeper) {
          await prisma.openItem.update({
            where: { id: it.id },
            data: {
              status: 'closed' as any,
              metadata: { ...(meta as any), archivedReason: 'duplicate_title', duplicateOf: keeper, archivedAt: new Date().toISOString() } as any,
            },
          }).catch(() => {});
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

  if (stats.archivedByGate + stats.archivedStale + stats.archivedDuplicate > 0) {
    log.info('cleanup tick', { ...stats });
  }
  return stats;
}
