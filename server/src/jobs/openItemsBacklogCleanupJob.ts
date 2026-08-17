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
 *     DISABLE and passes through unchanged (DEF-187). The stale sweep runs
 *     only under CONFIRMED settings authority (DEF-190): a real user row's
 *     preference, or defaults for a real user row with no preference block.
 *     A pair with NO user row (orphaned/foreign item) HOLDS and increments
 *     the visible `heldNoAuthority` metric; an UNREADABLE setting (the read
 *     threw, DEF-189) holds the same way — under `undefined` the policy
 *     neither detects staleness nor releases an existing quarantine.
 *   - Exact duplicates of (sourceFeed, sourceRef) within the same tenant+user
 *     → kept the oldest, archive the rest as "duplicate_collapsed".
 *
 * Critical-priority items are NEVER touched by this job — even if the
 * gate would reject them today, they may have been rated critical for
 * a reason the gate doesn't see (e.g. a delegation was already assigned).
 *
 * ── TENANT BOUNDARY (DEF-188/DEF-189) ───────────────────────────────────────
 * The entry point takes the tenant: `runOpenItemsBacklogCleanup(clientNumber)`.
 * EVERY openItem query in this file carries that clientNumber in `where`.
 * Cross-tenant enumeration happens exactly once, in
 * `runOpenItemsBacklogCleanupForAllTenants`, and it reads the TENANT REGISTRY
 * (distinct clientNumber over active users — the same sanctioned enumeration
 * `runContactPruneForAllTenants` uses), never tenant data.
 *
 * ── COMPARE-AND-SET (DEF-189) ───────────────────────────────────────────────
 * Every item mutation goes through `guardedItemUpdate`, whose predicate
 * carries the EXPECTED state read by the planner — status plus the
 * `@updatedAt` version token. A row the user touched between read and write
 * matches nothing: count 0, no cancellation, no stat, no debt — `raced`
 * records that the guard fired.
 *
 * ── THE NOTICE IS AN OUTBOX BATCH (DEF-190, Codex iteration-3 directives 1-3)
 * The archiving write records `selfPruneNotice.owed = true` in the same
 * confirmed row write — the durable debt. Announcement then runs on a
 * NORMALIZED OUTBOX (`self_prune_notice_batches`), replacing iteration 3's
 * per-row best-effort stamping, which Codex showed could split one owed set
 * into two notices and could overwrite concurrent metadata from a stale
 * snapshot:
 *
 *   - ONE atomic INSERT creates a batch with its immutable member snapshot
 *     and unique dedup identity. A partially-created batch cannot exist, and
 *     a retry after any failure reuses the same identity.
 *   - Immediately before enqueue the batch is REVALIDATED with a fresh read:
 *     only members still CANCELLED are rendered; restored rows drop out; a
 *     batch with no live members is CANCELLED, not sent. A restored item is
 *     never announced as withdrawn.
 *   - The queue is asked for the batch identity IN ANY STATE before sending —
 *     if it already holds it (a prior tick's sent-mark failed), the batch is
 *     marked sent with no second owner-visible message.
 *   - Row `owed` flags are cleared AFTER acceptance via a fresh re-read and a
 *     status+updatedAt CAS that merges the FRESH metadata — a concurrent
 *     metadata write survives; a raced clear stays owed inside a SENT batch,
 *     which excludes it from ever joining a new batch, and is retried.
 *
 * Idempotent. Safe to run repeatedly.
 */
import { createHash, randomUUID } from 'crypto';
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { planZombieLifecycle } from '../services/openItems/zombieItemPolicy';

const log = createLogger('open-items-backlog-cleanup');

const HARD_LIMIT_PER_RUN = 500;          // per (tenant, user) partition
const OWED_ROWS_PER_NOTICE = 200;        // batch size cap; remainder rides the next tick

const CANDIDATE_WHERE = {
  status: { in: ['NEW', 'TRIAGED', 'open'] as any },
  priority: { not: 'critical' },
};

/**
 * Rows whose archive write recorded an owed, not-yet-announced notice.
 * `status: 'CANCELLED'` is part of the identity: a row someone restored
 * (CANCELLED -> TRIAGED) drops out of this set.
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
  /** Stale sweeps held because no authorized user row backs the pair (DEF-190). */
  heldNoAuthority: number;
  errors: number;
}

function emptyStats(): CleanupStats {
  return {
    scanned: 0, archivedByGate: 0, archivedStale: 0, archivedDuplicate: 0, archivedSmoke: 0,
    quarantinedZombie: 0, quarantinedStale: 0, archivedZombie: 0, recoveredZombie: 0,
    noticesEnqueued: 0, raced: 0, heldNoAuthority: 0, errors: 0,
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

/** The outbox row shape this job reads and writes (see schema + migration). */
interface NoticeBatchRow {
  id: string;
  clientNumber: string;
  userId: number;
  batchId: string;
  dedupKey: string;
  itemIds: unknown;
  titles: unknown;
  count: number;
  state: string;
  createdAt: Date;
}

interface NoticeBatchDelegate {
  findMany(args: unknown): Promise<NoticeBatchRow[]>;
  create(args: unknown): Promise<NoticeBatchRow>;
  updateMany(args: unknown): Promise<{ count: number }>;
}

/**
 * The Prisma client on THIS box is regenerated only inside a deploy's
 * `npm run build` (`npx prisma` never runs on prod, CLAUDE.md), so the
 * `SelfPruneNoticeBatch` model exists in schema.prisma and the migration but
 * not yet in the locally generated client's types. This narrow cast lets the
 * working tree typecheck before that generate; the clean-clone build proof
 * runs the real generate against the same schema. If the delegate is absent
 * at runtime (client older than code), dispatch degrades VISIBLY: debts stay
 * owed, `errors` counts, nothing is announced.
 */
function noticeBatchDelegate(): NoticeBatchDelegate | null {
  const d = (prisma as any).selfPruneNoticeBatch;
  return d && typeof d.findMany === 'function' ? (d as NoticeBatchDelegate) : null;
}

function itemIdsOf(batch: NoticeBatchRow): string[] {
  return Array.isArray(batch.itemIds) ? (batch.itemIds as unknown[]).map(String) : [];
}

/**
 * DEF-187/188/189 — the ONE item-mutation path this job has. Tenant + user +
 * id SCOPE the write; `expected` is the COMPARE-AND-SET: the status (and,
 * where the caller read one, the `@updatedAt` version token). A row that
 * changed since the read matches nothing — count 0 — and the caller must
 * treat the action as not having happened.
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
      + stats.recoveredZombie + stats.noticesEnqueued + stats.raced
      + stats.heldNoAuthority + stats.errors > 0) {
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
  // tenant's authority (DEF-190): 'found' applies his real preference (zero
  // included — the disable, DEF-187); 'absent_preferences' applies defaults —
  // a CONFIRMED user row that never set them; 'no_user' means the pair has NO
  // authority behind it (orphaned/foreign item) and the sweep HOLDS, counted
  // visibly. A thrown read (DEF-189) holds the same way.
  let staleAfterDays: number | undefined;
  try {
    const { resolveOpenItemsSettings } = await import('../services/openItems/openItemsSettings');
    const resolved = await resolveOpenItemsSettings(userId, clientNumber);
    if (resolved.authority === 'no_user') {
      staleAfterDays = undefined;
      stats.heldNoAuthority++;
      log.warn('no authorized user row behind this pair — stale sweep held', { clientNumber, userId });
    } else {
      staleAfterDays = resolved.value!.staleThresholdDays;
    }
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
 * DEF-190 — the outbox dispatcher. Deterministic order (userId asc, batches
 * oldest-first); one owner's failure never blocks the next.
 */
async function dispatchOwedNotices(clientNumber: string, stats: CleanupStats): Promise<void> {
  if (!noticeBatchDelegate()) {
    stats.errors++;
    log.warn('notice outbox unavailable in this client — debts persist, nothing announced', { clientNumber });
    return;
  }

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

  // A batch can outlive its rows' owed flags only until clearing succeeds, so
  // also visit users who have open batches but no longer enumerable owed rows.
  const nb = noticeBatchDelegate()!;
  const batchUsers = await nb.findMany({
    where: { clientNumber, state: 'pending' },
    orderBy: { createdAt: 'asc' },
  } as any).catch(() => [] as NoticeBatchRow[]);

  const userIds = [...new Set([
    ...owedUsers.map((u) => u.userId),
    ...batchUsers.map((b) => b.userId),
  ])].sort((a, b) => a - b);

  for (const userId of userIds) {
    try {
      await processUserNotices(clientNumber, userId, stats);
    } catch (err: any) {
      stats.errors++;
      log.warn('withdrawal notice pass failed — outbox state kept for retry', {
        clientNumber, userId, err: err?.message,
      });
    }
  }
}

async function processUserNotices(
  clientNumber: string,
  userId: number,
  stats: CleanupStats,
): Promise<void> {
  const nb = noticeBatchDelegate()!;

  const batches = await nb.findMany({
    where: { clientNumber, userId, state: { in: ['pending', 'sent'] } },
    orderBy: { createdAt: 'asc' },
  } as any);
  const claimed = new Set(batches.flatMap((b) => itemIdsOf(b)));

  // 1. Settle pending batches under their ORIGINAL identity.
  for (const batch of batches.filter((b) => b.state === 'pending')) {
    await settleBatch(clientNumber, userId, batch, stats);
  }

  // 2. Sent batches whose members still carry the owed flag: a prior clear
  //    raced or failed. Retry clearing — never re-announce.
  for (const batch of batches.filter((b) => b.state === 'sent')) {
    await clearOwedFlags(clientNumber, userId, itemIdsOf(batch), batch.batchId, stats);
  }

  // 3. Owed rows claimed by NO batch form one new batch — a single atomic
  //    INSERT with the immutable member snapshot and dedup identity, so a
  //    partial claim cannot exist (Codex iteration-3 HIGH 2).
  const candidates = await prisma.openItem.findMany({
    where: { clientNumber, userId, ...(OWED_WHERE as any) },
    select: { id: true, title: true },
    orderBy: { createdAt: 'asc' },
    take: OWED_ROWS_PER_NOTICE,
  });
  const fresh = candidates.filter((c) => !claimed.has(c.id));
  if (fresh.length === 0) return;
  if (candidates.length === OWED_ROWS_PER_NOTICE) {
    log.warn('owed-notice batch at cap — remainder rides the next tick', {
      clientNumber, userId, cap: OWED_ROWS_PER_NOTICE,
    });
  }

  const batchId = randomUUID();
  const created = await nb.create({
    data: {
      clientNumber,
      userId,
      batchId,
      dedupKey: `selfpruning_withdrawn:${createHash('sha256').update(batchId).digest('hex').slice(0, 16)}`,
      itemIds: fresh.map((f) => f.id),
      titles: fresh.slice(0, 3).map((f) => f.title),
      count: fresh.length,
      state: 'pending',
    },
  } as any);

  await settleBatch(clientNumber, userId, created, stats);
}

/**
 * Deliver one batch. Revalidation is a FRESH read immediately before enqueue
 * (Codex iteration-3 CRITICAL): only members still CANCELLED are rendered; a
 * batch with no live members is cancelled, never sent. The queue is asked
 * for the batch identity in ANY state first, so a retry after a sent-mark
 * failure clears the debt without a second owner-visible message.
 */
async function settleBatch(
  clientNumber: string,
  userId: number,
  batch: NoticeBatchRow,
  stats: CleanupStats,
): Promise<void> {
  const nb = noticeBatchDelegate()!;
  const ids = itemIdsOf(batch);

  const live = await prisma.openItem.findMany({
    where: { id: { in: ids }, clientNumber, userId, status: 'CANCELLED' as any },
    select: { id: true, title: true },
    orderBy: { createdAt: 'asc' },
  });

  if (live.length === 0) {
    const cancelled = await nb.updateMany({
      where: { id: batch.id, clientNumber, userId, state: 'pending' },
      data: { state: 'cancelled', cancelledReason: 'every member was restored before send' },
    } as any);
    if (cancelled.count !== 1) { stats.errors++; }
    return;
  }
  if (live.length < ids.length) {
    log.info('restored members dropped from withdrawal notice', {
      clientNumber, userId, batchId: batch.batchId, dropped: ids.length - live.length,
    });
  }

  const existing = await prisma.brainPromptQueue.findFirst({
    where: { clientNumber, userId, dedupKey: batch.dedupKey },
    select: { id: true },
  });

  let promptId: string | null = null;
  if (!existing) {
    const { enqueueBrainPrompt } = await import('../services/brainPrompts/brainPromptQueueService');
    const { renderSelfPruneNotice } = await import('../services/notifications/proactiveMessageText');
    const res = await enqueueBrainPrompt({
      userId,
      clientNumber,
      question: renderSelfPruneNotice({
        count: live.length,
        titles: live.slice(0, 3).map((r) => r.title),
      }),
      criticality: 'routine',
      expectsReply: false,          // a notice never holds the conversation lock (DEF-063)
      provenance: 'system_marker',
      dedupKey: batch.dedupKey,
      metadata: {
        source: 'open_items_backlog_cleanup',
        selfPruneNotice: { batchId: batch.batchId, itemIds: live.map((r) => r.id).sort(), count: live.length },
      },
    });
    promptId = res.promptId ?? null;
    stats.noticesEnqueued++;
  }

  const marked = await nb.updateMany({
    where: { id: batch.id, clientNumber, userId, state: 'pending' },
    data: { state: 'sent', sentAt: new Date(), promptId },
  } as any);
  if (marked.count !== 1) {
    stats.errors++;
    log.warn('batch sent-mark failed — identity persists, the retry cannot re-send', {
      clientNumber, userId, batchId: batch.batchId,
    });
  }

  await clearOwedFlags(clientNumber, userId, live.map((r) => r.id), batch.batchId, stats);
}

/**
 * Clear each row's owed flag AFTER acceptance: a FRESH per-row read, then a
 * status+updatedAt compare-and-set that merges the FRESH metadata — never a
 * stale snapshot, so a concurrent metadata write survives (Codex iteration-3
 * HIGH 3). A raced clear stays owed inside its SENT batch — excluded from
 * ever joining a new batch — and is retried next tick.
 */
async function clearOwedFlags(
  clientNumber: string,
  userId: number,
  ids: string[],
  batchId: string,
  stats: CleanupStats,
): Promise<void> {
  for (const id of ids) {
    try {
      const fresh = await prisma.openItem.findFirst({
        where: { id, clientNumber, userId, ...(OWED_WHERE as any) },
        select: { metadata: true, updatedAt: true },
      });
      if (!fresh) continue; // already cleared, or restored — either way not ours to touch
      const meta = (fresh.metadata as Record<string, unknown> | null) ?? {};
      const notice = (meta.selfPruneNotice as Record<string, unknown> | null) ?? {};
      const ok = await guardedItemUpdate(
        { id, userId, clientNumber },
        { status: 'CANCELLED', updatedAt: fresh.updatedAt as Date },
        {
          metadata: {
            ...meta,
            selfPruneNotice: { ...notice, owed: false, batchId, clearedAt: new Date().toISOString() },
          } as any,
        },
      );
      if (!ok) stats.raced++;
    } catch (err: any) {
      stats.errors++;
      log.warn('owed-flag clear failed — retried from the sent batch next tick', {
        itemId: id, clientNumber, userId, err: err?.message,
      });
    }
  }
}
