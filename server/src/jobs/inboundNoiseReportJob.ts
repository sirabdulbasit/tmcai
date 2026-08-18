/**
 * DEF-217 — C-3 increment 1: the count reaches the owner.
 *
 * The campaign's increment 1 is *"a read-only classifier + counter over inbound:
 * for each sender/thread, how many pushes reached the owner and how many he ever
 * acted on. No suppression, no deletion, no behaviour change — it only produces
 * the number that proves the problem."* Its **Done when** is *"Deployed, and the
 * real count for the CL-033 unknown-number burst is quoted back to the owner from
 * production data."*
 *
 * The classifier already existed. `inboundNoiseLedger.summariseInboundNoise`
 * produces exactly those counts, and has since DEF-132's lineage — but its only
 * consumers were a hand-run script (`scripts/nexeoInboundNoiseReport.ts`) and a
 * prompt block. **Nothing ever said the number to him**, which is why five
 * campaign turns could pass with the increment "nearly done" and no owner-visible
 * result. I recorded that finding in iterations 8 and 9; this is the surface it
 * named.
 *
 * WHAT THIS DOES NOT DO, deliberately:
 *
 *   - it does not suppress, digest, delete, quarantine or reorder anything;
 *   - it does not recommend an action, because increment 2 is where suppression
 *     is designed and reviewed, and a report that proposed muting would be that
 *     increment arriving early and ungated;
 *   - it does not read or write an open item.
 *
 * It reads the ledger and enqueues at most ONE message per user per day.
 *
 * Tenant discipline follows the shape DEF-191/DEF-192 established for the
 * delegation chase: the ONLY cross-tenant read is the tenant REGISTRY, and every
 * data read carries a clientNumber.
 */

import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('inbound-noise-report');

export interface NoiseReportSummary {
  tenants: number;
  users: number;
  reported: number;
  quiet: number;
  errors: number;
}

/** The window the ledger summarises. 36h so a morning burst is still visible
 *  the following morning, matching the push-history block's own window. */
const WINDOW_HOURS = 36;

function emptySummary(): NoiseReportSummary {
  return { tenants: 0, users: 0, reported: 0, quiet: 0, errors: 0 };
}

/**
 * The ONE cross-tenant read, and it reads the tenant REGISTRY (distinct
 * clientNumber over active users), never tenant data. Deterministic order; one
 * tenant's failure never blocks the next.
 */
export async function runInboundNoiseReportForAllTenants(): Promise<NoiseReportSummary> {
  const total = emptySummary();
  const tenants = await prisma.user.findMany({
    where: { isActive: true },
    select: { clientNumber: true },
    distinct: ['clientNumber'],
    orderBy: { clientNumber: 'asc' },
  }).catch((e: any) => {
    total.errors += 1;
    log.warn('tenant registry read failed — no noise report this tick', { error: e?.message });
    return [] as Array<{ clientNumber: string }>;
  });

  for (const t of tenants) {
    total.tenants += 1;
    try {
      const s = await runInboundNoiseReportForTenant(t.clientNumber);
      total.users += s.users;
      total.reported += s.reported;
      total.quiet += s.quiet;
      total.errors += s.errors;
    } catch (e: any) {
      total.errors += 1;
      log.warn('tenant noise report failed', { clientNumber: t.clientNumber, error: e?.message });
    }
  }
  return total;
}

/** Report for ONE tenant. Every query below carries this tenant. */
export async function runInboundNoiseReportForTenant(clientNumber: string): Promise<NoiseReportSummary> {
  const summary = emptySummary();

  const { getBehaviorValue } = await import('../services/behaviorConfig');
  const enabled = await getBehaviorValue('selfpruning.noise_report_enabled', { clientNumber })
    .catch(() => 1);
  if (Number(enabled) !== 1) return summary;

  const minPushes = Number(
    await getBehaviorValue('selfpruning.noise_report_min_pushes', { clientNumber }).catch(() => 5),
  );

  const users = await prisma.user.findMany({
    where: { clientNumber, isActive: true },
    select: { id: true },
    orderBy: { id: 'asc' },
  }).catch((e: any) => {
    summary.errors += 1;
    log.warn('tenant user read failed', { clientNumber, error: e?.message });
    return [] as Array<{ id: number }>;
  });

  const { summariseInboundNoise } = await import('../services/selfpruning/inboundNoiseLedger');
  const { renderInboundNoiseNotice } = await import('../services/notifications/proactiveMessageText');
  const { enqueueBrainPrompt } = await import('../services/brainPrompts/brainPromptQueueService');

  for (const u of users) {
    summary.users += 1;
    try {
      const noise = await summariseInboundNoise({ clientNumber, userId: u.id, windowHours: WINDOW_HOURS });
      const worst = worstOffender(noise, minPushes);
      if (!worst) { summary.quiet += 1; continue; }

      // One per user per DAY. The date is part of the key, so a second tick in
      // the same day is refused by the queue's own dedup rather than by a timer
      // here — the same discipline the withdrawal notice uses.
      const day = new Date().toISOString().slice(0, 10);
      const res = await enqueueBrainPrompt({
        userId: u.id,
        clientNumber,
        question: renderInboundNoiseNotice(worst),
        criticality: 'routine',
        expectsReply: false,          // a count is not a question (DEF-063)
        provenance: 'system_marker',
        dedupKey: `selfpruning_noise:${u.id}:${day}`,
        metadata: { source: 'inbound_noise_report', window: WINDOW_HOURS, ...worst },
      });
      if (res.status === 'duplicate') { summary.quiet += 1; continue; }
      summary.reported += 1;
    } catch (e: any) {
      summary.errors += 1;
      log.warn('noise report failed for user', { clientNumber, userId: u.id, error: e?.message });
    }
  }
  return summary;
}

/**
 * The loudest sender worth a sentence, or null.
 *
 * FLOODS FIRST, and that ordering is the point: CL-033 — ten unactionable pushes
 * from one unknown number in a single morning — lands in `unattributed`/`floods`
 * precisely because those rows carry no item or thread identity. A report that
 * only looked at resolved subjects would have missed the case the campaign was
 * written about.
 *
 * `truncated` is NOT a reason to stay silent: the totals are then a floor, so the
 * real count is at least what we say. Saying "at least N" would be more precise
 * and is deliberately left to increment 2, which is where the wording is designed.
 */
export function worstOffender(
  noise: {
    windowHours: number;
    unattributed: ReadonlyArray<{ senderKey: string; reached: number; acted: number }>;
    subjects: ReadonlyArray<{ subjectKey: string; reached: number; acted: number }>;
  },
  minPushes: number,
): { sender: string; reached: number; acted: number; windowHours: number; unattributed: boolean } | null {
  const floor = Math.max(2, Math.floor(minPushes));

  const loudestUnattributed = [...(noise.unattributed ?? [])]
    .filter((g) => g.reached >= floor)
    .sort((a, b) => b.reached - a.reached)[0];
  if (loudestUnattributed) {
    return {
      sender: loudestUnattributed.senderKey,
      reached: loudestUnattributed.reached,
      acted: loudestUnattributed.acted,
      windowHours: noise.windowHours,
      unattributed: true,
    };
  }

  const loudestSubject = [...(noise.subjects ?? [])]
    .filter((g) => g.reached >= floor)
    .sort((a, b) => b.reached - a.reached)[0];
  if (loudestSubject) {
    return {
      sender: loudestSubject.subjectKey,
      reached: loudestSubject.reached,
      acted: loudestSubject.acted,
      windowHours: noise.windowHours,
      unattributed: false,
    };
  }
  return null;
}
