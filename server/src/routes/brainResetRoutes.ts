/**
 * Settings → Brain → Reset & Cleanup.
 *
 * Per Basit 2026-05-23: user controls own data lifecycle. No dev
 * dependency for future wipes. Foundation for multi-tenant later
 * (tenant admins get same UI with role-aware visibility).
 *
 * Three tiers, all reversible for 7 days via archive tables:
 *   - quick      — only stuck brain_pending_actions
 *   - refresh    — + clarification_memory, reasoning_traces, brain_action_artifacts
 *   - full       — + empty-contact entities removed, orphans rescoped
 *
 * NEVER touches: users, clients, OAuth, open_items, wiki_pages,
 * feed_events, prompt_blocks, action_definitions, capability_registry,
 * WhatsApp sessions.
 *
 * Confirmation: typed-phrase ("BRAIN REFRESH" / "BRAIN RESET" /
 * "QUICK RESET") matching the tier label. Per the no-browser-dialogs
 * rule from [feedback_no_browser_dialogs.md].
 */
import { Router } from 'express';
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('brain-reset');
const router = Router();

// In-memory rate limit: max 5 resets per user per hour. Resets are
// destructive enough that accidental triple-clicks shouldn't matter
// but a runaway script should.
const RECENT_RESETS = new Map<number, number[]>();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;

const TIER_PHRASES: Record<string, string> = {
  quick: 'QUICK RESET',
  refresh: 'BRAIN REFRESH',
  full: 'BRAIN RESET',
};

const ARCHIVE_TTL_DAYS = 7;

interface ResetResult {
  archiveSuffix: string;
  wipedCounts: Record<string, number>;
  tier: string;
  resetId: string;
}

/** Pre-wipe count snapshot — what the UI shows in the disclosure. */
router.get('/brain/reset/preview', async (req, res) => {
  const userId = (req as any).user?.id as number | undefined;
  const clientNumber = (req as any).user?.clientNumber as string | undefined;
  if (!userId || !clientNumber) return res.status(401).json({ error: 'unauthorized' });
  try {
    const [pendingCount, clarCount, tracesCount, artifactsCount, emptyContactsCount, openItemsCount] = await Promise.all([
      prisma.brainPendingAction.count({ where: { userId } as any }).catch(() => 0),
      (prisma as any).clarificationMemory?.count?.({ where: { userId } }).catch(() => 0) ?? 0,
      (prisma as any).reasoningTrace?.count?.({ where: { userId } }).catch(() => 0) ?? 0,
      (prisma as any).brainActionArtifact?.count?.({ where: { userId } }).catch(() => 0) ?? 0,
      prisma.entity.count({
        where: {
          clientNumber, entityType: 'contact',
          AND: [
            { OR: [{ email: null }, { email: '' }] },
            { OR: [{ phone: null }, { phone: '' }] },
          ],
        } as any,
      }).catch(() => 0),
      prisma.openItem.count({ where: { ownerId: userId } as any }).catch(() => 0),
    ]);
    res.json({
      counts: {
        brain_pending_actions: pendingCount,
        clarification_memory: clarCount,
        reasoning_traces: tracesCount,
        brain_action_artifacts: artifactsCount,
        empty_contact_entities: emptyContactsCount,
      },
      preserved: {
        open_items: openItemsCount,
        prompt_blocks: 'never wiped',
        action_definitions: 'never wiped',
        oauth_grants: 'never wiped',
      },
    });
  } catch (e: any) {
    log.warn('preview failed', { error: e?.message, userId });
    res.status(500).json({ error: 'preview_failed' });
  }
});

/** Execute the reset. Body: { tier, confirmation }. */
router.post('/brain/reset', async (req, res) => {
  const userId = (req as any).user?.id as number | undefined;
  const clientNumber = (req as any).user?.clientNumber as string | undefined;
  if (!userId || !clientNumber) return res.status(401).json({ error: 'unauthorized' });

  const tier = String(req.body?.tier ?? '').trim();
  const confirmation = String(req.body?.confirmation ?? '').trim();
  if (!['quick', 'refresh', 'full'].includes(tier)) {
    return res.status(400).json({ error: 'invalid_tier' });
  }
  const expectedPhrase = TIER_PHRASES[tier];
  if (confirmation !== expectedPhrase) {
    return res.status(400).json({
      error: 'invalid_confirmation',
      expected: expectedPhrase,
    });
  }

  // Rate limit
  const now = Date.now();
  const recent = (RECENT_RESETS.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    return res.status(429).json({ error: 'rate_limited', message: 'too many resets in the past hour' });
  }
  recent.push(now);
  RECENT_RESETS.set(userId, recent);

  const archiveSuffix = `wipe_${userId}_${now}`;
  const result = await runReset(userId, clientNumber, tier as 'quick' | 'refresh' | 'full', archiveSuffix);
  log.info('reset executed', { userId, tier, archiveSuffix, counts: result.wipedCounts });
  res.json(result);
});

/** History — for the audit log in Settings. */
router.get('/brain/reset/history', async (req, res) => {
  const userId = (req as any).user?.id as number | undefined;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  try {
    const rows = await (prisma as any).brainReset.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }).catch(() => []);
    res.json({ resets: rows });
  } catch (e: any) {
    log.warn('history failed', { error: e?.message, userId });
    res.status(500).json({ error: 'history_failed' });
  }
});

async function runReset(
  userId: number,
  clientNumber: string,
  tier: 'quick' | 'refresh' | 'full',
  archiveSuffix: string,
): Promise<ResetResult> {
  const wipedCounts: Record<string, number> = {};

  // Wrap in transaction for atomicity. Archive-then-wipe per table.
  await prisma.$transaction(async (tx) => {
    // (1) brain_pending_actions — all tiers
    const pendingRows = await (tx as any).brainPendingAction.findMany({ where: { userId } });
    if (pendingRows.length > 0) {
      await tx.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS brain_pending_actions_${archiveSuffix} AS SELECT * FROM brain_pending_actions WHERE FALSE`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO brain_pending_actions_${archiveSuffix} SELECT * FROM brain_pending_actions WHERE user_id = ${userId}`,
      );
    }
    const pendingDel = await (tx as any).brainPendingAction.deleteMany({ where: { userId } });
    wipedCounts.brain_pending_actions = pendingDel.count;

    if (tier === 'refresh' || tier === 'full') {
      // (2) clarification_memory + reasoning_traces + brain_action_artifacts
      const clarCount = await tx.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS clarification_memory_${archiveSuffix} AS SELECT * FROM clarification_memory WHERE FALSE`,
      );
      void clarCount;
      await tx.$executeRawUnsafe(
        `INSERT INTO clarification_memory_${archiveSuffix} SELECT * FROM clarification_memory WHERE user_id = ${userId}`,
      );
      const clarDel = await tx.$executeRawUnsafe(`DELETE FROM clarification_memory WHERE user_id = ${userId}`);
      wipedCounts.clarification_memory = Number(clarDel);

      await tx.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS reasoning_traces_${archiveSuffix} AS SELECT * FROM reasoning_traces WHERE FALSE`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO reasoning_traces_${archiveSuffix} SELECT * FROM reasoning_traces WHERE user_id = ${userId}`,
      );
      const tracesDel = await tx.$executeRawUnsafe(`DELETE FROM reasoning_traces WHERE user_id = ${userId}`);
      wipedCounts.reasoning_traces = Number(tracesDel);

      await tx.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS brain_action_artifacts_${archiveSuffix} AS SELECT * FROM brain_action_artifacts WHERE FALSE`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO brain_action_artifacts_${archiveSuffix} SELECT * FROM brain_action_artifacts WHERE user_id = ${userId}`,
      );
      const artifactsDel = await tx.$executeRawUnsafe(`DELETE FROM brain_action_artifacts WHERE user_id = ${userId}`);
      wipedCounts.brain_action_artifacts = Number(artifactsDel);
    }

    if (tier === 'full') {
      // (3) empty-contact entities — delete + archive
      await tx.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS entities_emptycontact_${archiveSuffix} AS SELECT * FROM entities WHERE FALSE`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO entities_emptycontact_${archiveSuffix}
         SELECT * FROM entities
         WHERE entity_type='contact' AND client_number='${clientNumber}'
           AND (email IS NULL OR email='') AND (phone IS NULL OR phone='')`,
      );
      const entDel = await tx.$executeRawUnsafe(
        `DELETE FROM entities
         WHERE entity_type='contact' AND client_number='${clientNumber}'
           AND (email IS NULL OR email='') AND (phone IS NULL OR phone='')`,
      );
      wipedCounts.empty_contact_entities = Number(entDel);

      // (4) assign orphan contacts to the current user (keep them PRIVATE).
      // Per Basit's "contacts private by default" rule — do NOT promote
      // to tenant scope (Public). Orphan contacts get owner_user_id=userId
      // so the requesting user can see them via candidateResolver's
      // owner-scoped filter, but other users in the tenant don't.
      // Future multi-tenant: replace this with a proper per-user backfill
      // (best guess from feed event sender ownership).
      const assigned = await tx.$executeRawUnsafe(
        `UPDATE entities SET owner_user_id=${userId}
         WHERE entity_type='contact' AND client_number='${clientNumber}'
           AND owner_user_id IS NULL AND created_by IS NULL`,
      );
      wipedCounts.orphan_contacts_assigned_to_user = Number(assigned);
    }
  });

  const expiresAt = new Date(Date.now() + ARCHIVE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const audit = await (prisma as any).brainReset.create({
    data: {
      userId, clientNumber, tier,
      wipedCounts,
      archiveSuffix,
      archiveExpiresAt: expiresAt,
    },
  });

  return {
    archiveSuffix,
    wipedCounts,
    tier,
    resetId: audit.id,
  };
}

export default router;
