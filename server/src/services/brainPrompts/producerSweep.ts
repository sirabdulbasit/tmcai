/**
 * MyOS — Brain prompt producer sweep.
 *
 * Periodic worker that finds open items with conversational gaps and
 * enqueues the right kind of prompt. Three producer paths today:
 *
 *   1. DEADLINE_MISSING — auto-created item with no dueDate. Asks the
 *      user "by when?" so the followup worker has a real target instead
 *      of guessing.
 *   2. OWNER_MISSING — auto-created item where someone forwarded
 *      something to the user without a clear owner attribution. Asks
 *      "who owns this?" so it can be assigned and tracked.
 *   3. CRITICAL_DECISION — items that are critical priority AND have a
 *      deadline within 24h AND haven't been touched. Fires a top-priority
 *      prompt (voice call) so the user can decide / delegate now.
 *
 * "Auto-created" is detected via `source_feed IS NOT NULL` — items born
 * from connector signals (gmail / whatsapp / gcal / meeting) carry a
 * source feed; items the user typed by hand do not. This avoids
 * Brain pestering the user about a personal todo they intentionally
 * left undated.
 *
 * The sweep runs every 30 minutes and is idempotent: dedup_key on each
 * enqueue prevents re-asking the same question, and the sweep skips
 * items that already have a non-terminal queue row pointing at them.
 *
 * Configuration:
 *   PRODUCER_SWEEP_LOOKBACK_MIN — items must be created within this
 *     window (default 60 min). Items older than this are owned by the
 *     followup worker, not this producer.
 *   PRODUCER_SWEEP_MAX_PER_RUN — bound the number of prompts a single
 *     sweep can enqueue per user (default 3). Prevents a flood of
 *     bulk-imported items dumping 50 prompts at once.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { enqueueBrainPrompt, type Criticality } from './brainPromptQueueService';

const log = createLogger('producer-sweep');

const LOOKBACK_MIN = Number(process.env.PRODUCER_SWEEP_LOOKBACK_MIN ?? '60');
const MAX_PER_USER_PER_RUN = Number(process.env.PRODUCER_SWEEP_MAX_PER_RUN ?? '3');

export interface ProducerSweepResult {
  scanned: number;
  enqueued: number;
  byKind: Record<string, number>;
  errors: number;
}

export async function runProducerSweep(): Promise<ProducerSweepResult> {
  const out: ProducerSweepResult = { scanned: 0, enqueued: 0, byKind: {}, errors: 0 };

  const since = new Date(Date.now() - LOOKBACK_MIN * 60 * 1000);
  // ── 1. CRITICAL_DECISION (highest priority — runs first so top
  //      prompts beat routine ones in the case of ties on the same item) ──
  const criticalDeadlineCutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const criticalCandidates = await prisma.openItem.findMany({
    where: {
      status: 'NEW',
      priority: 'critical',
      dueDate: { lt: criticalDeadlineCutoff, gte: new Date(Date.now() - 60 * 60 * 1000) },
      // Explicit auto-created marker — see header comment
      sourceFeed: { not: null },
      createdAt: { gte: since },
    },
    select: { id: true, userId: true, clientNumber: true, title: true, dueDate: true },
    take: 500,
  }).catch((err) => { log.warn('critical query failed', { err: err.message }); return [] as any[]; });

  // ── 2. DEADLINE_MISSING ────────────────────────────────────────────
  const deadlineCandidates = await prisma.openItem.findMany({
    where: {
      status: 'NEW',
      dueDate: null,
      priority: { in: ['high', 'critical'] },  // ignore low/medium so Brain isn't noisy
      sourceFeed: { not: null },
      createdAt: { gte: since },
    },
    select: { id: true, userId: true, clientNumber: true, title: true, priority: true },
    take: 500,
  }).catch((err) => { log.warn('deadline query failed', { err: err.message }); return [] as any[]; });

  // ── 3. OWNER_MISSING — forwarded items without a delegatee ─────────
  // We can't filter on metadata.forwarded != null in Prisma easily;
  // pull forwarded candidates with raw SQL.
  const ownerCandidates = await prisma.$queryRawUnsafe<Array<{ id: string; user_id: number; client_number: string; title: string }>>(
    `SELECT id, user_id, client_number, title
       FROM open_items
      WHERE status = 'NEW'
        AND delegatee_name IS NULL
        AND delegatee_email IS NULL
        AND source_feed IS NOT NULL
        AND created_at >= $1
        AND metadata ? 'forwarded'`,
    since,
  ).catch((err) => { log.warn('owner query failed', { err: err.message }); return [] as any[]; });

  out.scanned = criticalCandidates.length + deadlineCandidates.length + ownerCandidates.length;

  // Per-user budget tracker so a flood of new items doesn't dump 50
  // prompts on one user in a single sweep.
  const perUserBudget = new Map<number, number>();
  function takeBudget(userId: number): boolean {
    const used = perUserBudget.get(userId) ?? 0;
    if (used >= MAX_PER_USER_PER_RUN) return false;
    perUserBudget.set(userId, used + 1);
    return true;
  }

  // Track which item ids already had a prompt enqueued this run, so the
  // OWNER and DEADLINE producers don't both enqueue for the same item.
  const seenItem = new Set<string>();

  const enqueueOne = async (
    kind: 'critical_decision' | 'deadline_missing' | 'owner_missing',
    userId: number, clientNumber: string, openItemId: string, title: string,
    question: string, criticality: Criticality, sideEffectKind: 'set_due_date' | 'assign_owner' | 'free_form_note',
  ) => {
    if (seenItem.has(openItemId)) return;
    if (!takeBudget(userId)) return;
    try {
      const r = await enqueueBrainPrompt({
        userId, clientNumber,
        question,
        openItemId,
        sideEffect: { kind: sideEffectKind, openItemId },
        criticality,
        // Stable dedup_key per (item, kind) — re-running the sweep within
        // the lookback window won't re-ask the same question.
        dedupKey: `producer:${kind}:${openItemId}`,
        metadata: { producer: kind, source: 'producer_sweep' },
      });
      if (r.status === 'duplicate') return;
      seenItem.add(openItemId);
      out.enqueued += 1;
      out.byKind[kind] = (out.byKind[kind] ?? 0) + 1;
    } catch (err: any) {
      out.errors += 1;
      log.warn('enqueue failed', { kind, openItemId, err: err.message });
    }
  };

  // Process in priority order: critical first, then deadline, then owner.
  for (const c of criticalCandidates) {
    const dueWhen = c.dueDate
      ? `due ${new Date(c.dueDate).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', hour12: true })}`
      : 'urgent';
    await enqueueOne(
      'critical_decision', c.userId, c.clientNumber, c.id, c.title,
      `🚨 Critical: "${c.title}" — ${dueWhen}. Decision needed. Reply with what to do, or send "delegate <name>" to hand off.`,
      'top',
      'free_form_note',
    );
  }
  for (const d of deadlineCandidates) {
    if (seenItem.has(d.id)) continue;
    const crit: Criticality = d.priority === 'critical' ? 'high' : 'routine';
    await enqueueOne(
      'deadline_missing', d.userId, d.clientNumber, d.id, d.title,
      `When do you want "${d.title}" done by? Reply with a date or phrase like "tomorrow" / "friday" / "in 5 days".`,
      crit,
      'set_due_date',
    );
  }
  for (const o of ownerCandidates) {
    if (seenItem.has(o.id)) continue;
    await enqueueOne(
      'owner_missing', o.user_id, o.client_number, o.id, o.title,
      `Who owns "${o.title}"? Reply with a name, or a name + email like "Asad Khan <asad@tmcltd.com>".`,
      'routine',
      'assign_owner',
    );
  }

  if (out.scanned > 0 || out.enqueued > 0) {
    log.info('producer sweep complete', out as unknown as Record<string, unknown>);
  }
  return out;
}
